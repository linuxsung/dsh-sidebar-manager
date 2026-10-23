/**
 * Type B-cold promotion: provision a new project directory, relocate one cold
 * session into it, and finalize workspace membership on the next boot.
 *
 * Phase A moves files only. The target workspace is created by the boot
 * finalizer after the registry has re-indexed the relocated header.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  buildRelocated,
  expectedLogPath,
  findLogFile,
  patchProjcache,
  projcachePath,
  projectKey,
  readLogFile,
  verifyRelocated,
} from './session-log.mjs'
import {
  PromotionError,
  acquirePromotionLock,
  releasePromotionLock,
  writePromotionJournal,
} from './promotion-store.mjs'
import {
  PathPolicyError,
  samePath,
} from './path-policy.mjs'
import {
  assertGitAvailable,
  provisionScratchTarget,
  removeProvisionedTarget,
  resolveScratchTarget,
} from './provision.mjs'

function blocker(code, extra = {}) {
  return { code, ...extra }
}

function blocked(blockers, extra = {}) {
  return {
    ok: false,
    status: 409,
    blockerCodes: blockers.map((entry) => entry.code),
    blockers,
    ...extra,
  }
}

function registryOf(ctx) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) throw new PromotionError('REGISTRY_UNAVAILABLE', 'workspaceRegistry is unavailable')
  return registry
}

async function listHeaders(ctx) {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) throw new PromotionError('PERSISTENCE_UNAVAILABLE', 'sessionPersistence is unavailable')
  return (await persistence.list()).map((snapshot) => snapshot.header)
}

function isLive(ctx, sessionId) {
  return Boolean(ctx.get('agents')?.get(sessionId) ?? ctx.get('sessions')?.get(sessionId))
}

function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(source, target)
}

function backupSession(options, backupDir, id, header) {
  const sourceLog = findLogFile(options.dshHome, id) ?? expectedLogPath(options.dshHome, header.cwd, id)
  if (fs.existsSync(sourceLog)) {
    copyFile(sourceLog, path.join(backupDir, 'sessions', projectKey(header.cwd), id, 'session.v4.jsonl.zstd'))
  }
  const cache = projcachePath(options.dshHome, id)
  if (fs.existsSync(cache)) copyFile(cache, path.join(backupDir, 'projcache', `${id}.json`))
  return sourceLog
}

function restoreSession(options, backupDir, id, cwd) {
  const source = path.join(backupDir, 'sessions', projectKey(cwd), id, 'session.v4.jsonl.zstd')
  if (fs.existsSync(source)) {
    copyFile(source, expectedLogPath(options.dshHome, cwd, id))
  }
  const cache = path.join(backupDir, 'projcache', `${id}.json`)
  if (fs.existsSync(cache)) copyFile(cache, projcachePath(options.dshHome, id))
}

function removeEmptyProjectDir(options, cwd) {
  try {
    const directory = path.join(options.dshHome, 'sessions', projectKey(cwd))
    if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory)
  } catch {
    /* best effort */
  }
}

async function detachFromOthers(registry, sessionId, targetId) {
  for (const workspace of registry.list()) {
    if (String(workspace.id) === String(targetId)) continue
    if (workspace.record.sessionIds.includes(sessionId)) await workspace.detachSession(sessionId)
  }
}
export async function previewScratchCold(ctx, options, body = {}) {
  const plan = await resolveScratchTarget(options, { ...body, title: body.title ?? 'Promoted Project' })
  const blockers = [...plan.blockers]
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
  const registry = registryOf(ctx)
  const headers = await listHeaders(ctx)
  const header = headers.find((entry) => entry.id === sessionId)

  if (sessionId === '') blockers.push(blocker('SESSION_REQUIRED'))
  else if (header === undefined) blockers.push(blocker('SESSION_MISSING', { sessionId }))
  if (header !== undefined) {
    if (isLive(ctx, sessionId)) blockers.push(blocker('SESSION_LIVE', { sessionId }))
    if (typeof header.cwd !== 'string') blockers.push(blocker('SESSION_NO_CWD', { sessionId }))
    if (header.cwd !== undefined && samePath(header.cwd, plan.targetPath)) blockers.push(blocker('SAME_PATH', { path: plan.targetPath }))
  }
  const sourceWorkspace = header === undefined
    ? undefined
    : registry.list().find((workspace) => workspace.record.sessionIds.includes(sessionId))
  if (header !== undefined && sourceWorkspace === undefined) {
    blockers.push(blocker('SOURCE_WORKSPACE_MISSING', { sessionId }))
  }
  if (registry.list().some((workspace) => samePath(workspace.path, plan.targetPath))) {
    blockers.push(blocker('WORKSPACE_PATH_CONFLICT', { path: plan.targetPath }))
  }
  if (
    plan.title !== undefined &&
    plan.title !== '' &&
    registry.list().some((workspace) => workspace.title.toLowerCase() === plan.title.toLowerCase())
  ) {
    blockers.push(blocker('TITLE_CONFLICT', { title: plan.title }))
  }
  try {
    assertGitAvailable()
  } catch (error) {
    if (error instanceof PathPolicyError) blockers.push(blocker(error.code))
    else throw error
  }

  return {
    ok: blockers.length === 0,
    mode: 'scratch-cold',
    path: plan.targetPath,
    canonicalPath: plan.targetPath,
    title: plan.title,
    slug: plan.slug,
    sessionId,
    sourceCwd: header?.cwd,
    sourceWorkspaceId: sourceWorkspace === undefined ? undefined : String(sourceWorkspace.id),
    targetExists: plan.exists,
    targetEmpty: plan.empty,
    blockerCodes: blockers.map((entry) => entry.code),
    blockers,
    effects: {
      restartRequired: true,
      ui: 'after-restart',
      sessionIdPreserved: true,
    },
  }
}

async function rollbackScratch(options, journal, provisioned) {
  if (journal.oldLogPath !== undefined) restoreSession(options, journal.backupDir, journal.sessionId, journal.sourceCwd)
  if (journal.newLogPath !== undefined) fs.rmSync(path.dirname(journal.newLogPath), { recursive: true, force: true })
  if (provisioned?.createdDir === true) removeProvisionedTarget({ targetPath: journal.target.path }, provisioned)
  else {
    fs.rmSync(path.join(journal.target.path, '.git'), { recursive: true, force: true })
    fs.rmSync(path.join(journal.target.path, 'release.manifest.json'), { force: true })
  }
  removeEmptyProjectDir(options, journal.sourceCwd)
  journal.state = 'rolledback'
  writePromotionJournal(options, journal)
}

export async function applyScratchCold(ctx, options, body = {}) {
  const txid = `scratch-cold-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  try {
    await acquirePromotionLock(options, txid)
  } catch (error) {
    if (error instanceof PromotionError && error.code === 'LOCK_HELD') return blocked([blocker('LOCK_HELD')])
    throw error
  }

  let journal
  let provisioned
  let filesReady = false
  try {
    const preview = await previewScratchCold(ctx, options, body)
    if (!preview.ok) return blocked(preview.blockers, { preview })

    const registry = registryOf(ctx)
    const headers = await listHeaders(ctx)
    const header = headers.find((entry) => entry.id === preview.sessionId)
    const sourceLog = findLogFile(options.dshHome, preview.sessionId)
    if (sourceLog === undefined) throw new PromotionError('SESSION_LOG_MISSING', `session log not found: ${preview.sessionId}`)

    journal = {
      txid,
      kind: 'promotion',
      mode: 'scratch-cold',
      state: 'prepared',
      target: { path: preview.canonicalPath, title: preview.title },
      source: {
        sessionId: preview.sessionId,
        cwd: header.cwd,
        workspaceId: preview.sourceWorkspaceId,
      },
      candidateSessionIds: [preview.sessionId],
      sessionId: preview.sessionId,
      sourceCwd: header.cwd,
      oldLogPath: sourceLog,
      newLogPath: null,
      backupDir: path.join(options.backupDir, txid),
      createdWorkspace: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    writePromotionJournal(options, journal)

    fs.mkdirSync(journal.backupDir, { recursive: true })
    backupSession(options, journal.backupDir, preview.sessionId, header)
    const workspaceFile = path.join(options.dshHome, 'storages', 'workspace.json')
    if (fs.existsSync(workspaceFile)) copyFile(workspaceFile, path.join(journal.backupDir, 'workspace.json'))

    provisioned = await provisionScratchTarget({
      targetPath: preview.canonicalPath,
      title: preview.title,
      slug: preview.slug,
      exists: preview.targetExists,
    })
    journal.createdDir = provisioned.createdDir
    journal.gitCommit = provisioned.commit
    journal.state = 'provisioned'
    writePromotionJournal(options, journal)

    const log = readLogFile(sourceLog)
    if (log.tornStart !== undefined) throw new PromotionError('LOG_TORN', `session log has a torn tail: ${preview.sessionId}`)
    const relocated = buildRelocated(log, preview.canonicalPath)
    verifyRelocated(log, relocated, preview.canonicalPath, preview.sessionId)
    const targetLog = expectedLogPath(options.dshHome, preview.canonicalPath, preview.sessionId)
    fs.mkdirSync(path.dirname(targetLog), { recursive: true })
    const staging = `${targetLog}.tmp-${txid}`
    fs.writeFileSync(staging, relocated)
    fs.renameSync(staging, targetLog)
    journal.newLogPath = targetLog
    patchProjcache(projcachePath(options.dshHome, preview.sessionId), preview.canonicalPath)
    journal.state = 'log-ready'
    writePromotionJournal(options, journal)

    fs.rmSync(path.dirname(sourceLog), { recursive: true, force: true })
    removeEmptyProjectDir(options, preview.sourceCwd)
    journal.state = 'files-ready'
    writePromotionJournal(options, journal)
    filesReady = true
    return {
      ok: true,
      mode: 'scratch-cold',
      txid,
      restartRequired: true,
      sessionId: preview.sessionId,
      sourceCwd: preview.sourceCwd,
      targetPath: preview.canonicalPath,
      title: preview.title,
      workspaceId: null,
      gitCommit: provisioned.commit,
    }
  } catch (error) {
    if (journal !== undefined && filesReady !== true) {
      try {
        await rollbackScratch(options, journal, provisioned)
      } catch {
        /* retain the journal for the boot finalizer */
      }
    }
    throw error
  } finally {
    await releasePromotionLock(options, txid)
  }
}

export async function finalizeScratchCold(ctx, options, journal) {
  let lock
  try {
    lock = await acquirePromotionLock(options, journal.txid)
  } catch (error) {
    if (error instanceof PromotionError && error.code === 'LOCK_HELD') return { state: 'locked' }
    throw error
  }

  try {
    if (journal.state !== 'files-ready') {
      await rollbackScratch(options, journal, { createdDir: journal.createdDir === true })
      return { state: 'rolledback' }
    }
    const registry = registryOf(ctx)
    let workspace = registry.list().find((entry) => samePath(entry.path, journal.target.path))
    if (workspace === undefined) workspace = await registry.create(journal.target.path, journal.target.title)
    await detachFromOthers(registry, journal.sessionId, workspace.id)
    if (!workspace.record.sessionIds.includes(journal.sessionId)) {
      await workspace.attachSession(journal.sessionId)
    }
    journal.workspaceId = String(workspace.id)
    journal.state = 'committed'
    writePromotionJournal(options, journal)
    return { state: 'committed', workspaceId: String(workspace.id) }
  } catch (error) {
    ctx.logger?.warn?.('scratch promotion finalizer failed; journal retained', error)
    return { state: 'failed', error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (lock !== undefined) await releasePromotionLock(options, journal.txid)
  }
}
