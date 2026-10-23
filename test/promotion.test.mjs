/**
 * Type A promotion engine tests.
 *
 * The engine is host-only: it resolves an existing directory, registers one
 * workspace through the public registry API, and attaches same-cwd sessions
 * that are not already accounted. The promotion journal makes that multi-step
 * operation retryable after a boot.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  acquirePromotionLock,
  applyPromotion,
  finalizePendingPromotion,
  previewPromotion,
  releasePromotionLock,
} from '../lib/promotion.mjs'

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-promotion-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function optionsFor(root) {
  const projectsRoot = path.join(root, 'projects')
  fs.mkdirSync(projectsRoot, { recursive: true })
  return {
    dshHome: root,
    backupDir: path.join(root, 'backup'),
    stateDir: path.join(root, 'state'),
    projectsRoot,
    allowExternalPaths: false,
    trashRetentionDays: 30,
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function writeRegistry(root, workspaces, defaultWorkspaceId = 'ws-default') {
  writeJson(path.join(root, 'storages', 'workspace.json'), {
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      defaultWorkspaceId,
      workspaceIds: Object.keys(workspaces),
      archivedSessionIds: [],
      pinnedSessionIds: [],
    },
    tables: { workspaces },
  })
}

function record(workspacePath, title, sessionIds = []) {
  return {
    path: workspacePath,
    title,
    sessionIds: [...sessionIds],
    createdAt: '2026-10-23T00:00:00.000Z',
    updatedAt: '2026-10-23T00:00:00.000Z',
  }
}

function fakeRegistry(initial = {}) {
  const registry = {
    workspaces: new Map(),
    order: [],
    createCount: 0,
    add(id, workspacePath, title, sessionIds = []) {
      const entity = entityFor(registry, id, record(workspacePath, title, sessionIds))
      registry.workspaces.set(id, entity)
      registry.order.push(id)
      return entity
    },
    get(id) {
      return registry.workspaces.get(String(id))
    },
    list() {
      return registry.order.map((id) => registry.workspaces.get(id)).filter(Boolean)
    },
    async create(workspacePath, title) {
      const existing = registry.list().find((workspace) => workspace.path === workspacePath)
      if (existing !== undefined) return existing
      return registry.add(`created-${++registry.createCount}`, workspacePath, title, [])
    },
    async delete(id) {
      registry.workspaces.delete(String(id))
      registry.order = registry.order.filter((entry) => entry !== String(id))
      return true
    },
    async insertBefore(id, beforeId) {
      const without = registry.order.filter((entry) => entry !== id)
      const at = beforeId === undefined ? without.length : without.indexOf(beforeId)
      registry.order = [...without.slice(0, at), id, ...without.slice(at)]
      return registry.order
    },
  }
  for (const [id, value] of Object.entries(initial)) {
    registry.add(id, value.path, value.title, value.sessionIds)
  }
  return registry
}

function entityFor(registry, id, workspaceRecord) {
  const entity = {
    id,
    get path() {
      return workspaceRecord.path
    },
    get title() {
      return workspaceRecord.title
    },
    get record() {
      return { ...workspaceRecord, sessionIds: [...workspaceRecord.sessionIds] }
    },
    get sessionIds() {
      return [...workspaceRecord.sessionIds]
    },
    async attachSession(sessionId) {
      if (!workspaceRecord.sessionIds.includes(sessionId)) {
        workspaceRecord.sessionIds = [sessionId, ...workspaceRecord.sessionIds]
      }
    },
    async detachSession(sessionId) {
      workspaceRecord.sessionIds = workspaceRecord.sessionIds.filter((entry) => entry !== sessionId)
    },
    async setTitle(title) {
      workspaceRecord.title = title
    },
  }
  registry.workspaces.set(id, entity)
  return entity
}

function ctxWith(registry, headers = []) {
  return {
    get(name) {
      if (name === 'workspaceRegistry') return registry
      if (name === 'sessionPersistence') {
        return { list: async () => headers.map((header) => ({ header })) }
      }
      return undefined
    },
    logger: { warn() {} },
  }
}

function header(id, cwd, createdAt) {
  return { id, cwd, createdAt }
}

function journalFile(options) {
  return path.join(options.stateDir, 'promotion', 'pending.json')
}

function writeJournal(options, value) {
  writeJson(journalFile(options), value)
}

test('preview resolves the canonical path and lists same-cwd sessions oldest first', async (t) => {
  const root = tempRoot(t)
  const options = optionsFor(root)
  const target = path.join(options.projectsRoot, 'release-harness')
  const outside = path.join(root, 'outside')
  fs.mkdirSync(target)
  fs.mkdirSync(outside)
  writeRegistry(root, { 'ws-default': record(path.join(root, 'default'), 'Default') })
  const registry = fakeRegistry({ 'ws-default': { path: path.join(root, 'default'), title: 'Default' } })
  const ctx = ctxWith(registry, [
    header('session-new', target, 200),
    header('session-old', target, 100),
    header('session-other', outside, 300),
  ])

  const result = await previewPromotion(ctx, options, { path: target, title: 'Release Harness' })

  assert.equal(result.ok, true)
  assert.equal(result.canonicalPath, fs.realpathSync(target))
  assert.equal(result.title, 'Release Harness')
  assert.deepEqual(result.candidateSessionIds, ['session-old', 'session-new'])
  assert.equal(result.alreadyRegistered, false)
  assert.equal(result.effects.restartRequired, false)
})

test('apply registers one workspace and attaches same-cwd sessions without duplicates', async (t) => {
  const root = tempRoot(t)
  const options = optionsFor(root)
  const target = path.join(options.projectsRoot, 'release-harness')
  fs.mkdirSync(target)
  writeRegistry(root, { 'ws-default': record(path.join(root, 'default'), 'Default') })
  const registry = fakeRegistry({ 'ws-default': { path: path.join(root, 'default'), title: 'Default' } })
  const ctx = ctxWith(registry, [
    header('session-old', target, 100),
    header('session-new', target, 200),
  ])

  const result = await applyPromotion(ctx, options, { path: target, title: 'Release Harness' })

  assert.equal(result.ok, true)
  assert.equal(result.created, true)
  const workspace = registry.list().find((entry) => entry.path === fs.realpathSync(target))
  assert.ok(workspace)
  assert.deepEqual(workspace.record.sessionIds, ['session-new', 'session-old'])
  assert.equal(registry.list().filter((entry) => entry.path === fs.realpathSync(target)).length, 1)

  const journal = JSON.parse(fs.readFileSync(journalFile(options), 'utf8'))
  assert.equal(journal.state, 'committed')
  assert.equal(journal.workspaceId, workspace.id)
})

test('apply is idempotent for an already registered path and does not duplicate sessions', async (t) => {
  const root = tempRoot(t)
  const options = optionsFor(root)
  const target = path.join(options.projectsRoot, 'release-harness')
  fs.mkdirSync(target)
  writeRegistry(root, { 'ws-default': record(path.join(root, 'default'), 'Default') })
  const registry = fakeRegistry({ 'ws-default': { path: path.join(root, 'default'), title: 'Default' } })
  const ctx = ctxWith(registry, [header('session-1', target, 1)])

  await applyPromotion(ctx, options, { path: target, title: 'Release Harness' })
  const second = await applyPromotion(ctx, options, { path: target, title: 'Other Title' })

  assert.equal(second.ok, true)
  assert.equal(second.alreadyRegistered, true)
  assert.equal(second.created, false)
  const workspace = registry.list().find((entry) => entry.path === fs.realpathSync(target))
  assert.deepEqual(workspace.record.sessionIds, ['session-1'])
  assert.equal(workspace.title, 'Release Harness')
})

test('preview blocks outside-root paths, the default workspace, and title conflicts', async (t) => {
  const root = tempRoot(t)
  const options = optionsFor(root)
  const outside = path.join(root, 'outside')
  const inside = path.join(options.projectsRoot, 'inside')
  fs.mkdirSync(outside)
  fs.mkdirSync(inside)
  fs.mkdirSync(path.join(root, 'default'))
  writeRegistry(root, {
    'ws-default': record(path.join(root, 'default'), 'Default'),
    'ws-taken': record(path.join(root, 'taken'), 'Taken'),
  })
  const registry = fakeRegistry({
    'ws-default': { path: path.join(root, 'default'), title: 'Default' },
    'ws-taken': { path: path.join(root, 'taken'), title: 'Taken' },
  })
  const ctx = ctxWith(registry)

  const external = await previewPromotion(ctx, options, { path: outside, title: 'Outside' })
  assert.equal(external.ok, false)
  assert.ok(external.blockerCodes.includes('PATH_OUTSIDE_ROOT'))

  const defaultPath = await previewPromotion(ctx, options, { path: path.join(root, 'default'), title: 'Default Again' })
  assert.equal(defaultPath.ok, false)
  assert.ok(defaultPath.blockerCodes.includes('DEFAULT_WORKSPACE'))

  const title = await previewPromotion(ctx, options, { path: inside, title: 'Taken' })
  assert.equal(title.ok, false)
  assert.ok(title.blockerCodes.includes('TITLE_CONFLICT'))
})

test('preview blocks a same-cwd session already owned by another workspace', async (t) => {
  const root = tempRoot(t)
  const options = optionsFor(root)
  const target = path.join(options.projectsRoot, 'release-harness')
  fs.mkdirSync(target)
  writeRegistry(root, {
    'ws-default': record(path.join(root, 'default'), 'Default'),
    'ws-other': record(path.join(root, 'other'), 'Other', ['session-1']),
  })
  const registry = fakeRegistry({
    'ws-default': { path: path.join(root, 'default'), title: 'Default' },
    'ws-other': { path: path.join(root, 'other'), title: 'Other', sessionIds: ['session-1'] },
  })
  const ctx = ctxWith(registry, [header('session-1', target, 1)])

  const preview = await previewPromotion(ctx, options, { path: target, title: 'Release Harness' })
  assert.equal(preview.ok, false)
  assert.ok(preview.blockerCodes.includes('SESSION_ALREADY_ACCOUNTED'))

  const applied = await applyPromotion(ctx, options, { path: target, title: 'Release Harness' })
  assert.equal(applied.ok, false)
  assert.ok(applied.blockerCodes.includes('SESSION_ALREADY_ACCOUNTED'))
  assert.equal(registry.get('ws-other').record.sessionIds.includes('session-1'), true)
})

test('boot finalizer resumes a prepared journal by creating the workspace and attaching sessions', async (t) => {
  const root = tempRoot(t)
  const options = optionsFor(root)
  const target = path.join(options.projectsRoot, 'release-harness')
  fs.mkdirSync(target)
  writeRegistry(root, { 'ws-default': record(path.join(root, 'default'), 'Default') })
  const registry = fakeRegistry({ 'ws-default': { path: path.join(root, 'default'), title: 'Default' } })
  const ctx = ctxWith(registry, [header('session-1', target, 1)])
  writeJournal(options, {
    txid: 'promotion-1',
    kind: 'promotion',
    mode: 'existing',
    state: 'prepared',
    target: { path: fs.realpathSync(target), title: 'Release Harness' },
    candidateSessionIds: ['session-1'],
    createdWorkspace: false,
  })

  const result = await finalizePendingPromotion(ctx, options)

  assert.equal(result.state, 'committed')
  const workspace = registry.list().find((entry) => entry.path === fs.realpathSync(target))
  assert.ok(workspace)
  assert.deepEqual(workspace.record.sessionIds, ['session-1'])
  assert.equal(JSON.parse(fs.readFileSync(journalFile(options), 'utf8')).state, 'committed')
})

test('boot finalizer attaches only missing sessions from a partially applied journal', async (t) => {
  const root = tempRoot(t)
  const options = optionsFor(root)
  const target = path.join(options.projectsRoot, 'release-harness')
  fs.mkdirSync(target)
  writeRegistry(root, {
    'ws-default': record(path.join(root, 'default'), 'Default'),
    'ws-promoted': record(target, 'Release Harness', ['session-1']),
  })
  const registry = fakeRegistry({
    'ws-default': { path: path.join(root, 'default'), title: 'Default' },
    'ws-promoted': { path: target, title: 'Release Harness', sessionIds: ['session-1'] },
  })
  const ctx = ctxWith(registry, [header('session-1', target, 1), header('session-2', target, 2)])
  writeJournal(options, {
    txid: 'promotion-2',
    kind: 'promotion',
    mode: 'existing',
    state: 'workspace-ready',
    target: { path: fs.realpathSync(target), title: 'Release Harness' },
    workspaceId: 'ws-promoted',
    candidateSessionIds: ['session-1', 'session-2'],
    createdWorkspace: true,
  })

  const result = await finalizePendingPromotion(ctx, options)

  assert.equal(result.state, 'committed')
  assert.deepEqual(registry.get('ws-promoted').record.sessionIds, ['session-2', 'session-1'])
})

test('promotion lock blocks a second writer and can reclaim a stale lock', async (t) => {
  const root = tempRoot(t)
  const options = optionsFor(root)
  const target = path.join(options.projectsRoot, 'release-harness')
  fs.mkdirSync(target)
  writeRegistry(root, { 'ws-default': record(path.join(root, 'default'), 'Default') })
  const registry = fakeRegistry({ 'ws-default': { path: path.join(root, 'default'), title: 'Default' } })
  const ctx = ctxWith(registry)

  const first = await acquirePromotionLock(options, 'tx-first')
  try {
    const blocked = await applyPromotion(ctx, options, { path: target, title: 'Release Harness' })
    assert.equal(blocked.ok, false)
    assert.ok(blocked.blockerCodes.includes('LOCK_HELD'))
  } finally {
    await releasePromotionLock(options, 'tx-first')
  }

  const lockFile = path.join(options.stateDir, 'promotion', 'lock.json')
  writeJson(lockFile, { txid: 'tx-stale', pid: 999999, createdAt: Date.now() - 60_000 })
  const stale = await acquirePromotionLock(options, 'tx-after-stale', { ttlMs: 1000 })
  try {
    assert.equal(stale.txid, 'tx-after-stale')
  } finally {
    await releasePromotionLock(options, 'tx-after-stale')
  }
})
