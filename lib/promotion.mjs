/**
 * Type A promotion engine.
 *
 * A promotion here means: register an existing directory as a DSH workspace
 * and attach same-cwd sessions that are not yet accounted. The registry owns
 * the durable mutation; this module only serializes it with a lock and leaves a
 * journal so a crash between create and attach is retryable on the next boot.
 */
import path from 'node:path'
import crypto from 'node:crypto'

import { resolveOptions } from './transaction.mjs'
import {
  DEFAULT_LOCK_TTL_MS,
  PromotionError,
  acquirePromotionLock,
  readJson,
  readPromotionJournal,
  releasePromotionLock,
  writePromotionJournal,
} from './promotion-store.mjs'
import {
  PathPolicyError,
  canonicalDirectory,
  canonicalRoot,
  defaultTitle,
  isUnderRoot,
  normalizeTitle,
  samePath,
} from './path-policy.mjs'
import {
  applyHandoff,
  finalizeHandoff,
  previewHandoff,
} from './handoff.mjs'
import {
  applyScratchCold,
  finalizeScratchCold,
  previewScratchCold,
} from './scratch-promotion.mjs'

const TERMINAL_STATES = new Set(['committed', 'rolledback'])

export { PromotionError, acquirePromotionLock, readPromotionJournal, releasePromotionLock } from './promotion-store.mjs'

export function resolvePromotionOptions(config = {}) {
  const base = resolveOptions(config)
  return {
    ...base,
    lockTtlMs:
      Number.isFinite(config.lockTtlMs) && config.lockTtlMs > 0 ? Math.trunc(config.lockTtlMs) : DEFAULT_LOCK_TTL_MS,
  }
}

function readDefaultWorkspaceId(options) {
  const registry = readJson(path.join(options.dshHome, 'storages', 'workspace.json'))
  return registry?.global?.defaultWorkspaceId
}

function blocker(code, extra = {}) {
  return { code, ...extra }
}

function blockedResult(blockers, extra = {}) {
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

function accountedMap(registry) {
  const accounted = new Map()
  for (const workspace of registry.list()) {
    for (const sessionId of workspace.record.sessionIds) accounted.set(sessionId, String(workspace.id))
  }
  return accounted
}

function sortCandidates(headers) {
  return [...headers].sort((left, right) => {
    const byTime = Number(left.createdAt ?? 0) - Number(right.createdAt ?? 0)
    return byTime === 0 ? String(left.id).localeCompare(String(right.id)) : byTime
  })
}

export async function previewPromotion(ctx, options, body = {}) {
  const mode = String(body.mode ?? 'existing')
  if (mode === 'scratch-cold') return previewScratchCold(ctx, options, body)
  if (mode === 'scratch-handoff') return previewHandoff(ctx, options, body)
  const blockers = []
  if (mode !== 'existing') {
    blockers.push(blocker('UNSUPPORTED_MODE', { mode, supported: ['existing', 'scratch-cold', 'scratch-handoff'] }))
  }

  const requestedPath = typeof body.path === 'string' ? body.path.trim() : ''
  let canonicalPath
  if (requestedPath === '') {
    blockers.push(blocker('PATH_REQUIRED'))
  } else {
    try {
      canonicalPath = await canonicalDirectory(requestedPath)
    } catch (error) {
      if (error instanceof PathPolicyError) blockers.push(blocker(error.code, { path: requestedPath }))
      else throw error
    }
  }

  let root
  try {
    root = await canonicalRoot(options.projectsRoot)
  } catch (error) {
    if (error instanceof PathPolicyError) blockers.push(blocker(error.code, { path: options.projectsRoot }))
    else throw error
  }
  if (canonicalPath !== undefined && root !== undefined && options.allowExternalPaths !== true && !isUnderRoot(root, canonicalPath)) {
    blockers.push(blocker('PATH_OUTSIDE_ROOT', { path: canonicalPath, root }))
  }

  const registry = registryOf(ctx)
  const workspaces = registry.list()
  const existing = canonicalPath === undefined ? undefined : workspaces.find((workspace) => samePath(workspace.path, canonicalPath))
  const defaultWorkspaceId = readDefaultWorkspaceId(options)
  const defaultWorkspace = defaultWorkspaceId === undefined ? undefined : registry.get(defaultWorkspaceId)
  if (canonicalPath !== undefined && defaultWorkspace !== undefined && samePath(defaultWorkspace.path, canonicalPath)) {
    blockers.push(blocker('DEFAULT_WORKSPACE', { workspaceId: String(defaultWorkspace.id) }))
  }

  let title
  if (existing !== undefined) {
    title = existing.title
  } else if (canonicalPath !== undefined) {
    try {
      title = normalizeTitle(body.title ?? defaultTitle(canonicalPath))
    } catch (error) {
      if (error instanceof PathPolicyError) blockers.push(blocker(error.code))
      else throw error
    }
    if (title !== undefined && workspaces.some((workspace) => workspace.title.toLowerCase() === title.toLowerCase())) {
      blockers.push(blocker('TITLE_CONFLICT', { title }))
    }
  }

  const headers = await listHeaders(ctx)
  const accounted = accountedMap(registry)
  const sameCwd = canonicalPath === undefined
    ? []
    : headers.filter((header) => typeof header.cwd === 'string' && samePath(header.cwd, canonicalPath))
  const candidates = []
  const alreadyAttached = []
  for (const header of sameCwd) {
    const owner = accounted.get(header.id)
    if (owner === undefined) candidates.push(header)
    else if (existing !== undefined && owner === String(existing.id)) alreadyAttached.push(header.id)
    else blockers.push(blocker('SESSION_ALREADY_ACCOUNTED', { sessionId: header.id, workspaceId: owner }))
  }
  const ordered = sortCandidates(candidates)

  return {
    ok: blockers.length === 0,
    mode,
    path: requestedPath,
    canonicalPath,
    title,
    workspaceId: existing === undefined ? undefined : String(existing.id),
    alreadyRegistered: existing !== undefined,
    candidateSessionIds: ordered.map((header) => header.id),
    alreadyAttachedSessionIds: sortCandidates(sameCwd.filter((header) => alreadyAttached.includes(header.id))).map((header) => header.id),
    blockerCodes: blockers.map((entry) => entry.code),
    blockers,
    effects: {
      restartRequired: false,
      ui: existing === undefined ? 'immediate' : 'none',
      sessionIdPreserved: true,
    },
  }
}

function buildJournal({ txid, target, candidateSessionIds }) {
  return {
    txid,
    kind: 'promotion',
    mode: 'existing',
    state: 'prepared',
    target: { path: target.path, title: target.title },
    candidateSessionIds: [...candidateSessionIds],
    workspaceId: null,
    createdWorkspace: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

export async function applyPromotion(ctx, options, body = {}) {
  const mode = String(body.mode ?? 'existing')
  if (mode === 'scratch-cold') return applyScratchCold(ctx, options, body)
  if (mode === 'scratch-handoff') return applyHandoff(ctx, options, body)
  const txid = `promotion-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  try {
    await acquirePromotionLock(options, txid)
  } catch (error) {
    if (error instanceof PromotionError && error.code === 'LOCK_HELD') return blockedResult([blocker('LOCK_HELD')])
    throw error
  }

  try {
    const preview = await previewPromotion(ctx, options, body)
    if (!preview.ok) return blockedResult(preview.blockers, { preview })

    const registry = registryOf(ctx)
    let workspace = preview.alreadyRegistered ? registry.get(preview.workspaceId) : undefined
    const journal = buildJournal({
      txid,
      target: { path: preview.canonicalPath, title: preview.title },
      candidateSessionIds: preview.candidateSessionIds,
    })
    writePromotionJournal(options, journal)

    const beforeIds = new Set(registry.list().map((entry) => String(entry.id)))
    if (workspace === undefined) {
      workspace = await registry.create(preview.canonicalPath, preview.title)
    }
    journal.workspaceId = String(workspace.id)
    journal.createdWorkspace = !beforeIds.has(String(workspace.id))
    journal.state = 'workspace-ready'
    writePromotionJournal(options, journal)

    const attached = []
    for (const sessionId of preview.candidateSessionIds) {
      if (workspace.record.sessionIds.includes(sessionId)) continue
      const owner = registry.list().find(
        (entry) => String(entry.id) !== String(workspace.id) && entry.record.sessionIds.includes(sessionId),
      )
      if (owner !== undefined) {
        throw new PromotionError(
          'SESSION_ALREADY_ACCOUNTED',
          `session ${sessionId} is already accounted by workspace ${owner.id}`,
        )
      }
      await workspace.attachSession(sessionId)
      attached.push(sessionId)
    }

    journal.state = 'committed'
    journal.attachedSessionIds = attached
    writePromotionJournal(options, journal)
    return {
      ok: true,
      mode: 'existing',
      txid,
      workspaceId: String(workspace.id),
      title: workspace.title,
      canonicalPath: preview.canonicalPath,
      created: journal.createdWorkspace,
      alreadyRegistered: preview.alreadyRegistered,
      attachedSessionIds: attached,
      alreadyAttachedSessionIds: preview.alreadyAttachedSessionIds,
      restartRequired: false,
    }
  } finally {
    await releasePromotionLock(options, txid)
  }
}

export async function finalizePendingPromotion(ctx, options) {
  const journal = readPromotionJournal(options)
  if (journal === undefined) return { state: 'none' }
  if (TERMINAL_STATES.has(journal.state)) return { state: journal.state }
  if (journal.mode === 'scratch-cold') return finalizeScratchCold(ctx, options, journal)
  if (journal.mode === 'scratch-handoff') return finalizeHandoff(ctx, options, journal)
  if (journal.state !== 'prepared' && journal.state !== 'workspace-ready') return { state: journal.state }

  try {
    await acquirePromotionLock(options, journal.txid)
  } catch (error) {
    if (error instanceof PromotionError && error.code === 'LOCK_HELD') {
      ctx.logger?.warn?.('promotion finalizer skipped: lock held')
      return { state: 'locked' }
    }
    throw error
  }

  try {
    const registry = registryOf(ctx)
    let workspace = journal.workspaceId === null ? undefined : registry.get(journal.workspaceId)
    if (workspace === undefined) {
      workspace = registry.list().find((entry) => samePath(entry.path, journal.target.path))
    }
    if (workspace === undefined) {
      workspace = await registry.create(journal.target.path, journal.target.title)
    }
    journal.workspaceId = String(workspace.id)
    journal.state = 'workspace-ready'
    writePromotionJournal(options, journal)

    const attached = []
    for (const sessionId of journal.candidateSessionIds ?? []) {
      if (workspace.record.sessionIds.includes(sessionId)) continue
      const owner = registry.list().find(
        (entry) => String(entry.id) !== String(workspace.id) && entry.record.sessionIds.includes(sessionId),
      )
      if (owner !== undefined) {
        throw new PromotionError(
          'SESSION_ALREADY_ACCOUNTED',
          `session ${sessionId} is already accounted by workspace ${owner.id}`,
        )
      }
      await workspace.attachSession(sessionId)
      attached.push(sessionId)
    }
    journal.state = 'committed'
    journal.attachedSessionIds = attached
    writePromotionJournal(options, journal)
    return { state: 'committed', workspaceId: String(workspace.id), attachedSessionIds: attached }
  } catch (error) {
    ctx.logger?.warn?.('promotion finalizer failed; journal retained', error)
    return { state: 'failed', error: error instanceof Error ? error.message : String(error) }
  } finally {
    await releasePromotionLock(options, journal.txid)
  }
}

function json(body, status = 200) {
  return Response.json(body, { status })
}

async function readBody(request) {
  try {
    return await request.json()
  } catch {
    return {}
  }
}

export function createPromotionRoutes(ctx, options) {
  const safe = (handler) => async (request) => {
    try {
      return await handler(request)
    } catch (error) {
      ctx.logger?.warn?.('promotion route failed', error)
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  }

  return {
    'promotion/preview': safe(async (request) => json(await previewPromotion(ctx, options, await readBody(request)))),
    'promotion/apply': safe(async (request) => {
      const result = await applyPromotion(ctx, options, await readBody(request))
      return json(result, result.ok ? 200 : 409)
    }),
    'promotion/status': safe(async () => json({ ok: true, journal: readPromotionJournal(options) ?? null })),
  }
}
