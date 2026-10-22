/**
 * Sidebar Manager — Host transaction core.
 *
 * Two-phase design across a DSH restart:
 *   Phase A (online): validate guards, snapshot backups, write a journal,
 *     rewrite session logs to the new cwd/projectKey, then return
 *     `restartRequired: true`. Registry membership is NOT mutated because the
 *     workspace service caches session headers until the next process start.
 *   Phase B (next boot, plugin apply): after the registry re-indexed headers
 *     from disk, attach/detach sessions, create/remove workspaces, and mark the
 *     journal committed.
 *
 * Public services only: connection, workspaceRegistry, sessionPersistence,
 * agents, sessions. Filesystem work is limited to the DSH home (sessions,
 * projcache, backup, sidebar-manager state).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  buildCloned,
  buildRelocated,
  expectedLogPath,
  findLogFile,
  patchProjcache,
  projcachePath,
  projectKey,
  readLogFile,
  verifyCloned,
  verifyRelocated,
} from './session-log.mjs'

const DEFAULT_PROJECTS_ROOT = path.join(os.homedir(), 'Workspace', 'projects')
const JOURNAL_DIR = 'journal'

function dshHome() {
  const configured = process.env.DSH_HOME
  return configured && configured.trim() !== '' ? configured : path.join(os.homedir(), '.dsh')
}

export function resolveOptions(config = {}) {
  const home = dshHome()
  return {
    dshHome: home,
    backupDir: config.backupDir || path.join(home, 'backup'),
    stateDir: config.stateDir || path.join(home, 'sidebar-manager'),
    projectsRoot: config.projectsRoot || DEFAULT_PROJECTS_ROOT,
    allowExternalPaths: config.allowExternalPaths === true,
    trashRetentionDays:
      Number.isInteger(config.trashRetentionDays) && config.trashRetentionDays >= 0
        ? config.trashRetentionDays
        : 30,
  }
}

function json(body, status = 200) {
  return Response.json(body, { status })
}

function blocker(code, extra = {}) {
  return { code, ...extra }
}

function blocked(blockerCodes, extra = {}) {
  return json({ ok: false, blockerCodes, blockers: blockerCodes.map((entry) => entry.code), ...extra }, 409)
}

function newTxid(kind) {
  return `${kind}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
}

function normalize(value) {
  return path.resolve(value).replace(/\\/g, '/').toLowerCase()
}

function samePath(left, right) {
  return normalize(left) === normalize(right)
}

function isAbsolutePath(value) {
  return typeof value === 'string' && (path.isAbsolute(value) || path.win32.isAbsolute(value))
}

function isUnder(root, target) {
  const base = normalize(root).replace(/\/+$/, '')
  const candidate = normalize(target)
  return candidate === base || candidate.startsWith(`${base}/`)
}

function slug(value) {
  const text = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return text === '' ? 'new-project' : text
}

function liveSessionIds(ctx, ids) {
  const agents = ctx.get('agents')
  const sessions = ctx.get('sessions')
  return ids.filter((id) => Boolean(agents?.get(id) ?? sessions?.get(id)))
}

async function listHeaders(ctx) {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) throw new Error('sessionPersistence is unavailable')
  return (await persistence.list()).map((snapshot) => snapshot.header)
}

function isArchived(ctx, sessionId) {
  return ctx.get('workspaceRegistry')?.archivedSessionIds?.includes(sessionId) === true
}

function readWorkspaceFile(options) {
  const file = path.join(options.dshHome, 'storages', 'workspace.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function defaultWorkspaceId(options) {
  return readWorkspaceFile(options)?.global?.defaultWorkspaceId
}

function journalFile(options) {
  return path.join(options.stateDir, JOURNAL_DIR, 'pending.json')
}

function readJournal(options) {
  const file = journalFile(options)
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined
}

function writeJournal(options, journal) {
  const file = journalFile(options)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(temp, `${JSON.stringify(journal, null, 2)}\n`)
  fs.renameSync(temp, file)
}

function stateFile(options) {
  return path.join(options.stateDir, 'state.json')
}

function readState(options) {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile(options), 'utf8'))
    return { archivedWorkspaces: {}, ...state }
  } catch {
    return { archivedWorkspaces: {} }
  }
}

function writeState(options, state) {
  fs.mkdirSync(options.stateDir, { recursive: true })
  const file = stateFile(options)
  const temp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`)
  fs.renameSync(temp, file)
}

function backupSession(options, backupDir, id, header) {
  const log = findLogFile(options.dshHome, id) ?? expectedLogPath(options.dshHome, header?.cwd ?? '', id)
  if (fs.existsSync(log)) {
    const target = path.join(backupDir, 'sessions', projectKey(header?.cwd ?? ''), id, 'session.v4.jsonl.zstd')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(log, target)
  }
  const cache = projcachePath(options.dshHome, id)
  if (fs.existsSync(cache)) {
    const target = path.join(backupDir, 'projcache', `${id}.json`)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(cache, target)
  }
}

function backupWorkspace(options, backupDir) {
  const file = path.join(options.dshHome, 'storages', 'workspace.json')
  if (fs.existsSync(file)) {
    fs.mkdirSync(backupDir, { recursive: true })
    fs.copyFileSync(file, path.join(backupDir, 'workspace.json'))
  }
}

function restoreWorkspaceFile(options, backupDir) {
  const source = path.join(backupDir, 'workspace.json')
  if (!fs.existsSync(source)) return
  fs.mkdirSync(path.join(options.dshHome, 'storages'), { recursive: true })
  fs.copyFileSync(source, path.join(options.dshHome, 'storages', 'workspace.json'))
}

function restoreSession(options, backupDir, id, cwd) {
  const source = path.join(backupDir, 'sessions', projectKey(cwd), id, 'session.v4.jsonl.zstd')
  if (!fs.existsSync(source)) return
  const target = expectedLogPath(options.dshHome, cwd, id)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(source, target)
  const cache = path.join(backupDir, 'projcache', `${id}.json`)
  if (fs.existsSync(cache)) {
    const targetCache = projcachePath(options.dshHome, id)
    fs.mkdirSync(path.dirname(targetCache), { recursive: true })
    fs.copyFileSync(cache, targetCache)
  }
}

function relocateSession(options, id, oldCwd, newCwd, txid) {
  const source = findLogFile(options.dshHome, id) ?? expectedLogPath(options.dshHome, oldCwd, id)
  if (!fs.existsSync(source)) throw new Error(`session log not found for ${id}`)
  const target = expectedLogPath(options.dshHome, newCwd, id)
  if (fs.existsSync(target)) throw new Error(`target log already exists for ${id}`)
  const log = readLogFile(source)
  if (log.tornStart !== undefined) throw new Error(`session log has a torn tail: ${id}`)
  const out = buildRelocated(log, newCwd)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const staging = `${target}.tmp-${txid}`
  fs.writeFileSync(staging, out)
  verifyRelocated(log, out, newCwd, id)
  fs.renameSync(staging, target)
  const committed = readLogFile(target)
  if (committed.header.cwd !== newCwd) throw new Error(`relocated header cwd mismatch for ${id}`)
  patchProjcache(projcachePath(options.dshHome, id), newCwd)
  return { source, target }
}

function removeFileBestEffort(file) {
  try {
    fs.rmSync(file, { force: true })
  } catch {
    /* best effort */
  }
}

function removeEmptyProjectDir(options, cwd) {
  try {
    const dir = path.join(options.dshHome, 'sessions', projectKey(cwd))
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
  } catch {
    /* best effort */
  }
}

async function rollbackJournal(options, journal) {
  restoreWorkspaceFile(options, journal.backupDir)
  if (journal.dirRenamed === true && fs.existsSync(journal.newPath) && !fs.existsSync(journal.oldPath)) {
    fs.renameSync(journal.newPath, journal.oldPath)
  }
  const newProjectDir = path.join(options.dshHome, 'sessions', projectKey(journal.newPath))
  fs.rmSync(newProjectDir, { recursive: true, force: true })
  for (const id of journal.allSessions ?? [journal.sessionId].filter(Boolean)) {
    restoreSession(options, journal.backupDir, id, journal.oldPath)
  }
  removeEmptyProjectDir(options, journal.newPath)
  journal.state = 'rolledback'
  writeJournal(options, journal)
}

async function finalizeMove(ctx, options, journal) {
  const registry = ctx.get('workspaceRegistry')
  const target = registry.get(journal.targetWorkspaceId)
  if (target === undefined) throw new Error(`target workspace missing: ${journal.targetWorkspaceId}`)
  if (!target.record.sessionIds.includes(journal.sessionId)) await target.attachSession(journal.sessionId)
  for (const workspace of registry.list()) {
    if (String(workspace.id) === String(target.id)) continue
    if (workspace.record.sessionIds.includes(journal.sessionId)) await workspace.detachSession(journal.sessionId)
  }
  journal.state = 'committed'
  writeJournal(options, journal)
  return { state: 'committed' }
}

async function finalizeFork(ctx, options, journal) {
  const registry = ctx.get('workspaceRegistry')
  const target = registry.get(journal.targetWorkspaceId)
  if (target === undefined) throw new Error(`fork workspace missing: ${journal.targetWorkspaceId}`)
  if (!target.record.sessionIds.includes(journal.sessionId)) await target.attachSession(journal.sessionId)
  for (const workspace of registry.list()) {
    if (String(workspace.id) === String(target.id)) continue
    if (workspace.record.sessionIds.includes(journal.sessionId)) await workspace.detachSession(journal.sessionId)
  }
  journal.state = 'committed'
  writeJournal(options, journal)
  return { state: 'committed' }
}

async function finalizeRename(ctx, options, journal) {
  const registry = ctx.get('workspaceRegistry')
  let target = registry.list().find((workspace) => samePath(workspace.path, journal.newPath))
  if (target === undefined) target = await registry.create(journal.newPath, journal.title)
  if (journal.accounted.length > 0) {
    for (const id of journal.accounted) {
      if (!target.record.sessionIds.includes(id)) await target.attachSession(id)
    }
  }
  await target.setTitle(journal.title)
  if (journal.beforeWorkspaceId !== undefined && registry.get(journal.beforeWorkspaceId) !== undefined) {
    await registry.insertBefore(target.id, journal.beforeWorkspaceId)
  } else if (journal.orderIndex !== undefined) {
    await registry.insertBefore(target.id, undefined)
  }
  const old = registry.get(journal.oldWorkspaceId)
  if (old !== undefined) {
    for (const id of journal.accounted) {
      if (old.record.sessionIds.includes(id)) await old.detachSession(id)
    }
    await registry.delete(journal.oldWorkspaceId)
  }
  fs.rmSync(path.join(options.dshHome, 'sessions', projectKey(journal.oldPath)), { recursive: true, force: true })
  journal.state = 'committed'
  writeJournal(options, journal)
  return { state: 'committed', newWorkspaceId: String(target.id) }
}

export async function finalizePending(ctx, options = resolveOptions()) {
  const journal = readJournal(options)
  if (journal === undefined) return { state: 'none' }
  if (journal.state === 'committed' || journal.state === 'rolledback') return { state: journal.state }
  if (journal.state === 'prepared' || journal.state === 'dir-renamed') {
    await rollbackJournal(options, journal)
    if (journal.kind === 'fork' && journal.createdWorkspaceId !== undefined) {
      const registry = ctx.get('workspaceRegistry')
      const created = registry.get(journal.createdWorkspaceId)
      if (created !== undefined) await registry.delete(created.id)
    }
    return { state: 'rolledback' }
  }
  if (journal.state !== 'files-ready') return { state: journal.state }
  if (journal.kind === 'move') return finalizeMove(ctx, options, journal)
  if (journal.kind === 'fork') return finalizeFork(ctx, options, journal)
  if (journal.kind === 'rename') return finalizeRename(ctx, options, journal)
  throw new Error(`unknown journal kind: ${journal.kind}`)
}

async function previewMove(ctx, body) {
  const registry = ctx.get('workspaceRegistry')
  const headers = await listHeaders(ctx)
  const header = headers.find((entry) => entry.id === body.sessionId)
  const target = typeof body.targetWorkspaceId === 'string' ? registry.get(body.targetWorkspaceId) : undefined
  const current = header === undefined ? undefined : await registry.resolveByPath(header.cwd)
  const liveCount = header === undefined ? 0 : liveSessionIds(ctx, [header.id]).length
  const blockerCodes = []
  if (header === undefined) blockerCodes.push(blocker('SESSION_MISSING'))
  if (target === undefined) blockerCodes.push(blocker('WORKSPACE_MISSING'))
  if (current !== undefined && target !== undefined && String(current.id) === String(target.id)) blockerCodes.push(blocker('SAME_WORKSPACE'))
  if (liveCount > 0) blockerCodes.push(blocker('SESSION_LIVE', { count: liveCount }))
  if (target !== undefined && !fs.existsSync(target.path)) blockerCodes.push(blocker('WORKSPACE_DIR_MISSING', { path: target.path }))
  return {
    ok: blockerCodes.length === 0,
    affectedSessionCount: header === undefined ? 0 : 1,
    liveSessionCount: liveCount,
    oldPath: header?.cwd,
    newPath: target?.path,
    workspaceTitle: target?.title,
    targetWorkspaceId: target === undefined ? undefined : String(target.id),
    blockerCodes,
  }
}

async function previewRename(ctx, options, body) {
  const registry = ctx.get('workspaceRegistry')
  const workspace = registry.get(body.workspaceId)
  if (workspace === undefined) return { ok: false, affectedSessionCount: 0, blockerCodes: [blocker('WORKSPACE_MISSING')] }
  const headers = await listHeaders(ctx)
  const affected = headers.filter((header) => samePath(header.cwd, workspace.path))
  const liveCount = liveSessionIds(ctx, affected.map((header) => header.id)).length
  const folderRename = body.folderRename === true
  const folderName = String(body.folderName ?? '').trim()
  const newPath = path.join(path.dirname(workspace.path), folderName)
  const blockerCodes = []
  if (String(body.title ?? '').trim() === '') blockerCodes.push(blocker('TITLE_BLANK'))
  if (folderRename && folderName === '') blockerCodes.push(blocker('FOLDER_BLANK'))
  if (folderRename && (folderName.includes('/') || folderName.includes('\\') || folderName === '.' || folderName === '..')) {
    blockerCodes.push(blocker('FOLDER_INVALID'))
  }
  if (folderRename && defaultWorkspaceId(options) === String(workspace.id)) blockerCodes.push(blocker('DEFAULT_WORKSPACE'))
  if (folderRename && samePath(workspace.path, newPath)) blockerCodes.push(blocker('SAME_PATH'))
  if (folderRename && fs.existsSync(newPath)) blockerCodes.push(blocker('TARGET_EXISTS', { path: newPath }))
  if (folderRename && liveCount > 0) blockerCodes.push(blocker('SESSION_LIVE', { count: liveCount }))
  return {
    ok: blockerCodes.length === 0,
    affectedSessionCount: affected.length,
    liveSessionCount: liveCount,
    oldPath: workspace.path,
    newPath: folderRename ? newPath : workspace.path,
    workspaceTitle: String(body.title ?? workspace.title),
    workspaceId: String(workspace.id),
    blockerCodes,
  }
}

async function previewFork(ctx, options, body) {
  const headers = await listHeaders(ctx)
  const header = headers.find((entry) => entry.id === body.sessionId)
  const title = String(body.title ?? '').trim()
  const requested = typeof body.path === 'string' ? body.path.trim() : ''
  const suggested = path.join(options.projectsRoot, slug(title || body.sessionId || 'fork'))
  const targetPath = requested === '' ? suggested : requested
  const liveCount = header === undefined ? 0 : liveSessionIds(ctx, [header.id]).length
  const blockerCodes = []
  if (header === undefined) blockerCodes.push(blocker('SESSION_MISSING'))
  if (title === '') blockerCodes.push(blocker('TITLE_BLANK'))
  if (!isAbsolutePath(targetPath)) blockerCodes.push(blocker('PATH_ABSOLUTE'))
  if (isAbsolutePath(targetPath) && !options.allowExternalPaths && !isUnder(options.projectsRoot, targetPath)) {
    blockerCodes.push(blocker('EXTERNAL_PATH'))
  }
  if (isAbsolutePath(targetPath) && fs.existsSync(targetPath)) {
    const stats = fs.statSync(targetPath)
    if (!stats.isDirectory() || fs.readdirSync(targetPath).length > 0) {
      blockerCodes.push(blocker('TARGET_EXISTS', { path: targetPath }))
    }
  }
  if (liveCount > 0) blockerCodes.push(blocker('SESSION_LIVE', { count: liveCount }))
  return {
    ok: blockerCodes.length === 0,
    affectedSessionCount: header === undefined ? 0 : 1,
    liveSessionCount: liveCount,
    oldPath: header?.cwd,
    newPath: targetPath,
    workspaceTitle: title,
    suggestedPath: suggested,
    blockerCodes,
  }
}

async function handlePurge(ctx, options, body) {
  const registry = ctx.get('workspaceRegistry')
  const id = String(body.sessionId ?? '')
  if (id === '') return blocked([blocker('SESSION_MISSING')])
  const headers = await listHeaders(ctx)
  const header = headers.find((entry) => entry.id === id)
  if (header === undefined) return blocked([blocker('SESSION_MISSING')])
  if (!isArchived(ctx, id)) return blocked([blocker('NOT_ARCHIVED')])
  const live = liveSessionIds(ctx, [id])
  if (live.length > 0) return blocked([blocker('SESSION_LIVE', { count: live.length })])

  const txid = newTxid('purge')
  const backupDir = path.join(options.backupDir, txid)
  fs.mkdirSync(backupDir, { recursive: true })
  backupWorkspace(options, backupDir)
  backupSession(options, backupDir, id, header)

  await registry.unarchiveSession(id)
  await registry.unpinSession(id)
  for (const workspace of registry.list()) {
    if (workspace.record.sessionIds.includes(id)) await workspace.detachSession(id)
  }
  const log = findLogFile(options.dshHome, id)
  if (log !== undefined) fs.rmSync(path.dirname(log), { recursive: true, force: true })
  removeFileBestEffort(projcachePath(options.dshHome, id))
  removeEmptyProjectDir(options, header.cwd)
  return json({ ok: true, deleted: true, backupDir })
}

async function handleArchiveWorkspace(ctx, options, body) {
  const registry = ctx.get('workspaceRegistry')
  const id = String(body.workspaceId ?? '')
  const workspace = registry.get(id)
  if (workspace === undefined) return blocked([blocker('WORKSPACE_MISSING')])
  if (defaultWorkspaceId(options) === id) return blocked([blocker('DEFAULT_WORKSPACE')])
  const headers = await listHeaders(ctx)
  const affected = headers.filter((header) => samePath(header.cwd, workspace.path))
  const live = liveSessionIds(ctx, affected.map((header) => header.id))
  if (live.length > 0) return blocked([blocker('SESSION_LIVE', { count: live.length })])

  const order = registry.list()
  const orderIndex = order.findIndex((entry) => String(entry.id) === id)
  const beforeWorkspaceId = orderIndex >= 0 ? order[orderIndex + 1]?.id : undefined
  const state = readState(options)
  state.archivedWorkspaces[id] = {
    workspaceId: id,
    path: workspace.path,
    title: workspace.title,
    sessionIds: [...workspace.record.sessionIds],
    allSessionIds: affected.map((header) => header.id),
    orderIndex,
    beforeWorkspaceId: beforeWorkspaceId === undefined ? undefined : String(beforeWorkspaceId),
    archivedAt: new Date().toISOString(),
  }
  writeState(options, state)
  const archived = []
  try {
    for (const header of affected) {
      if (!isArchived(ctx, header.id)) {
        await registry.archiveSession(header.id)
        archived.push(header.id)
      }
    }
    await registry.delete(id)
  } catch (error) {
    for (const sessionId of archived) {
      try {
        await registry.unarchiveSession(sessionId)
      } catch {
        /* best effort */
      }
    }
    delete state.archivedWorkspaces[id]
    writeState(options, state)
    throw error
  }
  return json({ ok: true, archived: true, workspaceId: id })
}

async function handleArchivedList(ctx, options) {
  const state = readState(options)
  const items = Object.values(state.archivedWorkspaces).sort(
    (left, right) => (left.orderIndex ?? 0) - (right.orderIndex ?? 0),
  )
  return json({ ok: true, items })
}

async function handleRestoreWorkspace(ctx, options, body) {
  const registry = ctx.get('workspaceRegistry')
  const id = String(body.workspaceId ?? '')
  const state = readState(options)
  const entry = state.archivedWorkspaces[id]
  if (entry === undefined) return blocked([blocker('ARCHIVE_MISSING')])
  if (!fs.existsSync(entry.path)) {
    try {
      fs.mkdirSync(entry.path, { recursive: true })
    } catch {
      return blocked([blocker('WORKSPACE_DIR_MISSING', { path: entry.path })])
    }
  }
  let workspace = registry.list().find((item) => samePath(item.path, entry.path))
  if (workspace === undefined) workspace = await registry.create(entry.path, entry.title)
  await workspace.setTitle(entry.title)
  for (const sessionId of entry.allSessionIds ?? entry.sessionIds) {
    if (isArchived(ctx, sessionId)) {
      try {
        await registry.unarchiveSession(sessionId)
      } catch {
        /* the session may already be gone */
      }
    }
  }
  for (const sessionId of entry.sessionIds) {
    if (!workspace.record.sessionIds.includes(sessionId)) await workspace.attachSession(sessionId)
  }
  if (entry.beforeWorkspaceId !== undefined && registry.get(entry.beforeWorkspaceId) !== undefined) {
    await registry.insertBefore(workspace.id, entry.beforeWorkspaceId)
  } else if (entry.orderIndex !== undefined) {
    await registry.insertBefore(workspace.id, undefined)
  }
  delete state.archivedWorkspaces[id]
  writeState(options, state)
  return json({ ok: true, restored: true, workspaceId: String(workspace.id) })
}

function sessionHeaderFor(headers, id) {
  return headers.find((header) => header.id === id)
}

function previewBlocked(result) {
  return blocked(result.blockerCodes ?? [], {
    affectedSessionCount: result.affectedSessionCount,
    liveSessionCount: result.liveSessionCount,
    oldPath: result.oldPath,
    newPath: result.newPath,
    workspaceTitle: result.workspaceTitle,
  })
}

async function handleMove(ctx, options, body) {
  const result = await previewMove(ctx, body)
  if (!result.ok) return previewBlocked(result)
  const headers = await listHeaders(ctx)
  const header = sessionHeaderFor(headers, body.sessionId)
  const txid = newTxid('move')
  const backupDir = path.join(options.backupDir, txid)
  fs.mkdirSync(backupDir, { recursive: true })
  backupWorkspace(options, backupDir)
  backupSession(options, backupDir, header.id, header)
  const journal = {
    txid,
    kind: 'move',
    state: 'prepared',
    sessionId: header.id,
    oldPath: header.cwd,
    newPath: result.newPath,
    targetWorkspaceId: result.targetWorkspaceId,
    backupDir,
  }
  writeJournal(options, journal)
  try {
    const moved = relocateSession(options, header.id, header.cwd, result.newPath, txid)
    journal.oldLog = path.dirname(moved.source)
    fs.rmSync(path.dirname(moved.source), { recursive: true, force: true })
    removeEmptyProjectDir(options, header.cwd)
    journal.state = 'files-ready'
    writeJournal(options, journal)
    return json({ ok: true, restartRequired: true, txid })
  } catch (error) {
    await rollbackJournal(options, journal)
    throw error
  }
}

async function handleRenameFolder(ctx, options, body) {
  const result = await previewRename(ctx, options, body)
  if (!result.ok) return previewBlocked(result)
  const registry = ctx.get('workspaceRegistry')
  const workspace = registry.get(body.workspaceId)
  if (body.folderRename !== true) {
    await workspace.setTitle(String(body.title))
    return json({ ok: true, restartRequired: false })
  }
  const headers = await listHeaders(ctx)
  const affected = headers.filter((header) => samePath(header.cwd, workspace.path))
  const order = registry.list()
  const orderIndex = order.findIndex((entry) => String(entry.id) === String(workspace.id))
  const beforeWorkspaceId = orderIndex >= 0 ? order[orderIndex + 1]?.id : undefined
  const txid = newTxid('rename')
  const backupDir = path.join(options.backupDir, txid)
  fs.mkdirSync(backupDir, { recursive: true })
  backupWorkspace(options, backupDir)
  for (const header of affected) backupSession(options, backupDir, header.id, header)
  const journal = {
    txid,
    kind: 'rename',
    state: 'prepared',
    workspaceId: String(workspace.id),
    oldPath: workspace.path,
    newPath: result.newPath,
    title: String(body.title),
    accounted: [...workspace.record.sessionIds],
    allSessions: affected.map((header) => header.id),
    oldWorkspaceId: String(workspace.id),
    beforeWorkspaceId: beforeWorkspaceId === undefined ? undefined : String(beforeWorkspaceId),
    orderIndex,
    backupDir,
  }
  writeJournal(options, journal)
  try {
    fs.renameSync(workspace.path, result.newPath)
    journal.dirRenamed = true
    journal.state = 'dir-renamed'
    writeJournal(options, journal)
    for (const header of affected) relocateSession(options, header.id, workspace.path, result.newPath, txid)
    fs.rmSync(path.join(options.dshHome, 'sessions', projectKey(workspace.path)), { recursive: true, force: true })
    journal.state = 'files-ready'
    writeJournal(options, journal)
    return json({ ok: true, restartRequired: true, txid })
  } catch (error) {
    await rollbackJournal(options, journal)
    throw error
  }
}

function cloneProjcache(options, sourceId, childId, targetCwd) {
  const source = projcachePath(options.dshHome, sourceId)
  if (!fs.existsSync(source)) return false
  const target = projcachePath(options.dshHome, childId)
  const document = JSON.parse(fs.readFileSync(source, 'utf8'))
  if (document.record?.identity) document.record.identity.cwd = targetCwd
  if (document.record?.rows?.workingDirectory) document.record.rows.workingDirectory.val = targetCwd
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`)
  return true
}

async function handleFork(ctx, options, body) {
  const result = await previewFork(ctx, options, body)
  if (!result.ok) return previewBlocked(result)
  const registry = ctx.get('workspaceRegistry')
  const headers = await listHeaders(ctx)
  const sourceHeader = sessionHeaderFor(headers, body.sessionId)
  const sourceLog = findLogFile(options.dshHome, body.sessionId)
  if (sourceHeader === undefined || sourceLog === undefined) return blocked([blocker('SESSION_MISSING')])
  const targetPath = result.newPath
  fs.mkdirSync(targetPath, { recursive: true })

  const txid = newTxid('fork')
  const backupDir = path.join(options.backupDir, txid)
  let workspace
  let journal
  try {
    const log = readLogFile(sourceLog)
    if (log.tornStart !== undefined) throw new Error(`source session log has a torn tail: ${body.sessionId}`)
    const childId = `session-${crypto.randomUUID()}`
    const childTarget = expectedLogPath(options.dshHome, targetPath, childId)
    if (fs.existsSync(childTarget)) throw new Error(`fork target log already exists: ${childId}`)
    workspace = await registry.create(targetPath, String(body.title))
    fs.mkdirSync(backupDir, { recursive: true })
    backupWorkspace(options, backupDir)
    journal = {
      txid,
      kind: 'fork',
      state: 'prepared',
      sessionId: childId,
      parentSessionId: body.sessionId,
      oldPath: sourceHeader.cwd,
      newPath: targetPath,
      targetWorkspaceId: String(workspace.id),
      createdWorkspaceId: String(workspace.id),
      backupDir,
    }
    writeJournal(options, journal)

    const out = buildCloned(log, { id: childId, cwd: targetPath, createdAt: Date.now() })
    verifyCloned(log, out, childId, targetPath)
    fs.mkdirSync(path.dirname(childTarget), { recursive: true })
    const staging = `${childTarget}.tmp-${txid}`
    fs.writeFileSync(staging, out)
    fs.renameSync(staging, childTarget)
    cloneProjcache(options, body.sessionId, childId, targetPath)

    journal.state = 'files-ready'
    writeJournal(options, journal)
    return json({ ok: true, restartRequired: true, txid, sessionId: childId, workspaceId: String(workspace.id) })
  } catch (error) {
    if (journal !== undefined) await rollbackJournal(options, journal)
    if (workspace !== undefined) {
      try {
        await registry.delete(workspace.id)
      } catch {
        /* best effort */
      }
    }
    throw error
  }
}

async function readBody(request) {
  try {
    return await request.json()
  } catch {
    return {}
  }
}

export function createTransactionRoutes(ctx, options) {
  const safe = (handler) => async (request) => {
    try {
      return await handler(request)
    } catch (error) {
      ctx.logger?.warn?.('sidebar-manager route failed', error)
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  }
  return {
    'session/move/preview': safe(async (request) => json(await previewMove(ctx, await readBody(request)))),
    'workspace/rename-folder/preview': safe(async (request) =>
      json(await previewRename(ctx, options, await readBody(request))),
    ),
    'session/fork-to-workspace/preview': safe(async (request) =>
      json(await previewFork(ctx, options, await readBody(request))),
    ),

    'session/purge': safe(async (request) => handlePurge(ctx, options, await readBody(request))),
    'session/move': safe(async (request) => handleMove(ctx, options, await readBody(request))),
    'workspace/archived': safe(async () => handleArchivedList(ctx, options)),
    'workspace/archive': safe(async (request) => handleArchiveWorkspace(ctx, options, await readBody(request))),
    'workspace/restore': safe(async (request) => handleRestoreWorkspace(ctx, options, await readBody(request))),
    'workspace/rename-folder': safe(async (request) => handleRenameFolder(ctx, options, await readBody(request))),
    'session/fork-to-workspace': safe(async (request) => handleFork(ctx, options, await readBody(request))),
  }
}
