/**
 * Type B-live handoff: create a new session in a target workspace from the
 * source session's latest completed-turn prefix, then attach it immediately.
 *
 * The source identity is never mutated. The new session is a normal session
 * with an explicit parent link, so the source can remain live and the new one
 * can be opened without a DSH restart.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import {
  findLogFile,
  readLogFile,
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

export function latestCompletedPrefixBoundary(events) {
  const lastTurnEnd = events.findLast((event) => event.type === 'turn/end')
  if (lastTurnEnd === undefined) return undefined
  let boundary = lastTurnEnd.seq
  for (const next of events.slice(boundary + 1)) {
    if (
      next.type === 'turn/start' ||
      (next.type === 'user/message' && next.surfaceOp === 'append') ||
      next.type === 'agent/inbox/spliced'
    ) {
      break
    }
    boundary = next.seq
  }
  return boundary
}

export function buildHandoffSeed(events, boundary) {
  if (!Number.isSafeInteger(boundary) || boundary < 0 || events[boundary] === undefined) {
    throw new PromotionError('HANDOFF_BOUNDARY_INVALID', 'handoff boundary is outside the source event log')
  }
  const last = events[boundary]
  return [
    ...events.slice(0, boundary + 1),
    {
      type: 'session/end-seed',
      seq: boundary + 1,
      time: last.time,
      data: { inherited: true },
    },
  ]
}

async function sourceSnapshot(ctx, options, sessionId) {
  const live = ctx.get('agents')?.get?.(sessionId)?.session ?? ctx.get('sessions')?.get?.(sessionId)
  if (live !== undefined) {
    return { header: live.header, events: live.snapshotEvents(), live: true }
  }
  const headers = await listHeaders(ctx)
  const header = headers.find((entry) => entry.id === sessionId)
  if (header === undefined) throw new PromotionError('SESSION_MISSING', `session not found: ${sessionId}`)
  const logPath = findLogFile(options.dshHome, sessionId)
  if (logPath === undefined) throw new PromotionError('SESSION_LOG_MISSING', `session log not found: ${sessionId}`)
  const log = readLogFile(logPath)
  if (log.tornStart !== undefined) throw new PromotionError('LOG_TORN', `session log has a torn tail: ${sessionId}`)
  return { header, events: log.events, live: false }
}

async function resolveTarget(ctx, options, body, blockers) {
  const targetWorkspaceId = typeof body.targetWorkspaceId === 'string' ? body.targetWorkspaceId.trim() : ''
  if (targetWorkspaceId !== '') {
    const workspace = registryOf(ctx).get(targetWorkspaceId)
    if (workspace === undefined) {
      blockers.push(blocker('WORKSPACE_MISSING', { workspaceId: targetWorkspaceId }))
      return undefined
    }
    return {
      mode: 'existing',
      workspaceId: String(workspace.id),
      targetPath: workspace.path,
      title: workspace.title,
      slug: undefined,
      exists: true,
      createdDir: false,
    }
  }

  const plan = await resolveScratchTarget(options, body)
  blockers.push(...plan.blockers)
  if (!plan.ok) return undefined
  return {
    mode: 'scratch',
    workspaceId: undefined,
    targetPath: plan.targetPath,
    title: plan.title,
    slug: plan.slug,
    exists: plan.exists,
    createdDir: plan.createdDir,
  }
}

async function composePreset(ctx, presetId) {
  const presets = ctx.get('agentPresets')
  if (presets === undefined) throw new PromotionError('PRESET_UNAVAILABLE', 'agentPresets service is unavailable')
  const preset = await presets.resolve(presetId)
  return {
    presetId: preset.id,
    setup: async (agentCtx) => {
      await presets.mount(agentCtx, preset.id)
    },
  }
}

function agentOptions(ctx) {
  const defaultModel = ctx.get('agentDefaultModel')
  if (defaultModel === undefined) return undefined
  const selection = defaultModel.currentSelection()
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
  }
}

async function createChild(ctx, source, target, boundary) {
  const agents = ctx.get('agents')
  if (agents === undefined) throw new PromotionError('AGENTS_UNAVAILABLE', 'agents service is unavailable')
  const preset = await composePreset(ctx, source.header.agentPreset)
  const childId = `session-${crypto.randomUUID()}`
  const seed = buildHandoffSeed(source.events, boundary)
  const options = agentOptions(ctx)
  const handle = await agents.create({
    sessionId: childId,
    seed,
    inheritedEventCount: boundary + 1,
    meta: {
      cwd: target.targetPath,
      parentSession: source.header.id,
      isSeeded: true,
      agentPreset: preset.presetId,
    },
    ...(options === undefined ? {} : { agentOptions: options }),
    setup: preset.setup,
  })
  return handle.agent.id
}

export async function previewHandoff(ctx, options, body = {}) {
  const blockers = []
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
  if (sessionId === '') blockers.push(blocker('SESSION_REQUIRED'))

  let source
  if (sessionId !== '') {
    try {
      source = await sourceSnapshot(ctx, options, sessionId)
    } catch (error) {
      if (error instanceof PromotionError) blockers.push(blocker(error.code, { sessionId }))
      else throw error
    }
  }
  const boundary = source === undefined ? undefined : latestCompletedPrefixBoundary(source.events)
  if (source !== undefined && boundary === undefined) blockers.push(blocker('NO_COMPLETED_TURN', { sessionId }))

  const target = await resolveTarget(ctx, options, body, blockers)
  if (source !== undefined && target !== undefined && samePath(source.header.cwd ?? '', target.targetPath)) {
    blockers.push(blocker('SAME_WORKSPACE', { path: target.targetPath }))
  }
  if (target?.mode === 'scratch') {
    if (target.title !== undefined && registryOf(ctx).list().some((workspace) => workspace.title.toLowerCase() === target.title.toLowerCase())) {
      blockers.push(blocker('TITLE_CONFLICT', { title: target.title }))
    }
    if (registryOf(ctx).list().some((workspace) => samePath(workspace.path, target.targetPath))) {
      blockers.push(blocker('WORKSPACE_PATH_CONFLICT', { path: target.targetPath }))
    }
    try {
      assertGitAvailable()
    } catch (error) {
      if (error instanceof PathPolicyError) blockers.push(blocker(error.code))
      else throw error
    }
  }
  if (ctx.get('agentPresets') === undefined) blockers.push(blocker('PRESET_UNAVAILABLE'))
  if (ctx.get('agents') === undefined) blockers.push(blocker('AGENTS_UNAVAILABLE'))

  return {
    ok: blockers.length === 0,
    mode: 'scratch-handoff',
    sessionId,
    sourceCwd: source?.header.cwd,
    sourceWorkspaceId: undefined,
    boundarySeq: boundary,
    inheritedEventCount: boundary === undefined ? undefined : boundary + 1,
    targetWorkspaceId: target?.workspaceId,
    targetPath: target?.targetPath,
    title: target?.title,
    slug: target?.slug,
    targetMode: target?.mode,
    targetExists: target?.exists === true,
    blockerCodes: blockers.map((entry) => entry.code),
    blockers,
    effects: {
      restartRequired: false,
      ui: 'immediate',
      sessionIdPreserved: false,
      newSessionId: true,
    },
  }
}

export async function applyHandoff(ctx, options, body = {}) {
  const txid = `scratch-handoff-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  try {
    await acquirePromotionLock(options, txid)
  } catch (error) {
    if (error instanceof PromotionError && error.code === 'LOCK_HELD') return blocked([blocker('LOCK_HELD')])
    throw error
  }

  let journal
  let provisioned
  try {
    const preview = await previewHandoff(ctx, options, body)
    if (!preview.ok) return blocked(preview.blockers, { preview })

    const source = await sourceSnapshot(ctx, options, preview.sessionId)
    const registry = registryOf(ctx)
    journal = {
      txid,
      kind: 'promotion',
      mode: 'scratch-handoff',
      state: 'prepared',
      target: { path: preview.targetPath, title: preview.title },
      source: { sessionId: preview.sessionId, cwd: source.header.cwd },
      sourceSessionId: preview.sessionId,
      sourceBoundarySeq: preview.boundarySeq,
      childSessionId: null,
      workspaceId: preview.targetWorkspaceId ?? null,
      createdWorkspace: false,
      createdDir: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    writePromotionJournal(options, journal)

    if (preview.targetMode === 'scratch') {
      provisioned = await provisionScratchTarget({
        targetPath: preview.targetPath,
        title: preview.title,
        slug: preview.slug,
        exists: preview.targetExists === true,
      })
      journal.createdDir = provisioned.createdDir
      journal.gitCommit = provisioned.commit
    }

    let workspace = preview.targetWorkspaceId === undefined
      ? undefined
      : registry.get(preview.targetWorkspaceId)
    if (workspace === undefined) {
      const before = new Set(registry.list().map((entry) => String(entry.id)))
      workspace = await registry.create(preview.targetPath, preview.title)
      journal.createdWorkspace = !before.has(String(workspace.id))
    }
    journal.workspaceId = String(workspace.id)
    journal.state = 'workspace-ready'
    writePromotionJournal(options, journal)

    const childSessionId = await createChild(ctx, source, preview, preview.boundarySeq)
    journal.childSessionId = childSessionId
    journal.state = 'child-created'
    writePromotionJournal(options, journal)
    await workspace.attachSession(childSessionId)
    journal.state = 'committed'
    writePromotionJournal(options, journal)
    return {
      ok: true,
      mode: 'scratch-handoff',
      txid,
      sessionId: childSessionId,
      sourceSessionId: preview.sessionId,
      workspaceId: String(workspace.id),
      targetPath: preview.targetPath,
      title: preview.title,
      restartRequired: false,
      inheritedEventCount: preview.inheritedEventCount,
    }
  } catch (error) {
    if (journal !== undefined && journal.childSessionId === null) {
      try {
        if (journal.createdWorkspace === true) await registryOf(ctx).delete(journal.workspaceId)
        if (provisioned !== undefined) removeProvisionedTarget({ targetPath: journal.target.path }, provisioned)
        journal.state = 'rolledback'
        writePromotionJournal(options, journal)
      } catch {
        /* retain journal for the boot finalizer */
      }
    }
    throw error
  } finally {
    await releasePromotionLock(options, txid)
  }
}

export async function finalizeHandoff(ctx, options, journal) {
  let lock
  try {
    lock = await acquirePromotionLock(options, journal.txid)
  } catch (error) {
    if (error instanceof PromotionError && error.code === 'LOCK_HELD') return { state: 'locked' }
    throw error
  }

  try {
    if (journal.childSessionId === null || journal.childSessionId === undefined) {
      const registry = registryOf(ctx)
      if (journal.createdWorkspace === true && journal.workspaceId !== null && journal.workspaceId !== undefined) {
        const created = registry.get(journal.workspaceId)
        if (created !== undefined && created.record.sessionIds.length === 0) await registry.delete(created.id)
      }
      if (journal.createdDir === true) removeProvisionedTarget({ targetPath: journal.target.path }, { createdDir: true })
      journal.state = 'rolledback'
      writePromotionJournal(options, journal)
      return { state: 'rolledback' }
    }

    const registry = registryOf(ctx)
    let workspace = registry.list().find((entry) => samePath(entry.path, journal.target.path))
    if (workspace === undefined) {
      workspace = journal.workspaceId === null || journal.workspaceId === undefined
        ? await registry.create(journal.target.path, journal.target.title)
        : registry.get(journal.workspaceId)
    }
    if (workspace === undefined) throw new PromotionError('WORKSPACE_MISSING', 'handoff target workspace is missing')
    for (const other of registry.list()) {
      if (String(other.id) !== String(workspace.id) && other.record.sessionIds.includes(journal.childSessionId)) {
        await other.detachSession(journal.childSessionId)
      }
    }
    if (!workspace.record.sessionIds.includes(journal.childSessionId)) {
      await workspace.attachSession(journal.childSessionId)
    }
    journal.workspaceId = String(workspace.id)
    journal.state = 'committed'
    writePromotionJournal(options, journal)
    return { state: 'committed', workspaceId: String(workspace.id), sessionId: journal.childSessionId }
  } catch (error) {
    ctx.logger?.warn?.('handoff finalizer failed; journal retained', error)
    return { state: 'failed', error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (lock !== undefined) await releasePromotionLock(options, journal.txid)
  }
}
