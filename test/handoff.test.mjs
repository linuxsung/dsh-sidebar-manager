import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import zlib from 'node:zlib'
import {
  applyHandoff,
  buildHandoffSeed,
  finalizeHandoff,
  latestCompletedPrefixBoundary,
  previewHandoff,
} from '../lib/handoff.mjs'
import { expectedLogPath, projcachePath } from '../lib/session-log.mjs'

const CHECKSUM = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }
const SOURCE_CWD = 'C:\\handoff-test\\source'

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-handoff-test-'))
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

function writeSessionLog(home, id, events) {
  const file = expectedLogPath(home, SOURCE_CWD, id)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const header = { type: 'session', version: 4, id, createdAt: 1, cwd: SOURCE_CWD, isSeeded: false, agentPreset: 'standard' }
  const frames = [zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'), CHECKSUM)]
  if (events.length > 0) {
    frames.push(zlib.zstdCompressSync(Buffer.from(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8'), CHECKSUM))
  }
  fs.writeFileSync(file, Buffer.concat(frames))
  writeJson(projcachePath(home, id), {
    version: 7,
    record: { identity: { formatVersion: 4, createdAt: 1, cwd: SOURCE_CWD, isSeeded: false, inheritedEventCount: 0 } },
  })
}

function fakeRegistry(initial = {}) {
  const registry = {
    workspaces: new Map(),
    order: [],
    createCount: 0,
    add(id, workspacePath, title, sessionIds = []) {
      const record = { path: workspacePath, title, sessionIds: [...sessionIds] }
      const entity = {
        id,
        get path() {
          return record.path
        },
        get title() {
          return record.title
        },
        get record() {
          return { ...record, sessionIds: [...record.sessionIds] }
        },
        async attachSession(sessionId) {
          if (!record.sessionIds.includes(sessionId)) record.sessionIds = [sessionId, ...record.sessionIds]
        },
        async detachSession(sessionId) {
          record.sessionIds = record.sessionIds.filter((entry) => entry !== sessionId)
        },
      }
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
      return registry.add(`created-${++registry.createCount}`, workspacePath, title)
    },
    async delete(id) {
      registry.workspaces.delete(String(id))
      registry.order = registry.order.filter((entry) => entry !== String(id))
      return true
    },
  }
  for (const [id, value] of Object.entries(initial)) registry.add(id, value.path, value.title, value.sessionIds)
  return registry
}

function fakeAgents() {
  const created = []
  return {
    created,
    async create(options) {
      created.push(options)
      return { agent: { id: options.sessionId, session: { header: { id: options.sessionId } } }, dispose: async () => {} }
    },
  }
}

function ctxWith(registry, agents, headers) {
  const presets = {
    async resolve(id) {
      return { id: id ?? 'standard' }
    },
    async mount() {},
  }
  return {
    get(name) {
      if (name === 'workspaceRegistry') return registry
      if (name === 'agents') return agents
      if (name === 'agentPresets') return presets
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) }
      if (name === 'sessionPersistence') return { list: async () => headers.map((header) => ({ header })) }
      return undefined
    },
    logger: { warn() {} },
  }
}

function completedTurnEvents(extra = []) {
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'title/change', seq: 2, time: 3, data: { title: 'Source' } },
    ...extra,
  ]
}

function journalPath(options) {
  return path.join(options.stateDir, 'promotion', 'pending.json')
}

test('latestCompletedPrefixBoundary stops before the next live turn', () => {
  const events = completedTurnEvents([
    { type: 'turn/start', seq: 3, time: 4, data: { turn: 2 } },
    { type: 'user/message', seq: 4, time: 5, surfaceOp: 'append', data: {} },
  ])
  assert.equal(latestCompletedPrefixBoundary(events), 2)
  assert.equal(buildHandoffSeed(events, 2).length, 4)
  assert.deepEqual(buildHandoffSeed(events, 2)[3], {
    type: 'session/end-seed',
    seq: 3,
    time: 3,
    data: { inherited: true },
  })
})

test('handoff preview and apply create a new session without moving the source', async (t) => {
  const root = tempRoot(t)
  const options = optionsFor(root)
  const target = path.join(options.projectsRoot, 'handoff-target')
  const sessionId = 'session-handoff-source'
  writeSessionLog(root, sessionId, completedTurnEvents())
  const registry = fakeRegistry({ 'ws-source': { path: SOURCE_CWD, title: 'Source', sessionIds: [sessionId] } })
  const agents = fakeAgents()
  const header = { id: sessionId, cwd: SOURCE_CWD, createdAt: 1, agentPreset: 'standard' }
  const ctx = ctxWith(registry, agents, [header])

  const preview = await previewHandoff(ctx, options, { sessionId, path: target, title: 'Handoff Target' })
  assert.equal(preview.ok, true, JSON.stringify(preview.blockers))
  assert.equal(preview.boundarySeq, 2)
  assert.equal(preview.inheritedEventCount, 3)
  assert.equal(preview.effects.restartRequired, false)

  const applied = await applyHandoff(ctx, options, { sessionId, path: target, title: 'Handoff Target' })
  assert.equal(applied.ok, true, JSON.stringify(applied))
  assert.equal(applied.sourceSessionId, sessionId)
  assert.notEqual(applied.sessionId, sessionId)
  assert.equal(applied.restartRequired, false)
  assert.equal(agents.created.length, 1)
  assert.equal(agents.created[0].meta.cwd, target)
  assert.equal(agents.created[0].meta.parentSession, sessionId)
  assert.equal(agents.created[0].inheritedEventCount, 3)
  assert.equal(agents.created[0].seed.at(-1).type, 'session/end-seed')
  assert.equal(registry.get('ws-source').record.sessionIds.includes(sessionId), true)
  const targetWorkspace = registry.list().find((workspace) => workspace.path === target)
  assert.deepEqual(targetWorkspace.record.sessionIds, [applied.sessionId])
  assert.equal(JSON.parse(fs.readFileSync(journalPath(options), 'utf8')).state, 'committed')
})

test('handoff blocks a source with no completed turn', async (t) => {
  const root = tempRoot(t)
  const options = optionsFor(root)
  const target = path.join(options.projectsRoot, 'handoff-target')
  const sessionId = 'session-no-turn'
  writeSessionLog(root, sessionId, [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }])
  const registry = fakeRegistry({ 'ws-source': { path: SOURCE_CWD, title: 'Source', sessionIds: [sessionId] } })
  const ctx = ctxWith(registry, fakeAgents(), [{ id: sessionId, cwd: SOURCE_CWD, createdAt: 1 }])

  const preview = await previewHandoff(ctx, options, { sessionId, path: target, title: 'Handoff Target' })
  assert.equal(preview.ok, false)
  assert.ok(preview.blockerCodes.includes('NO_COMPLETED_TURN'))
})

test('handoff finalizer attaches a child created before a crash', async (t) => {
  const root = tempRoot(t)
  const options = optionsFor(root)
  const target = path.join(options.projectsRoot, 'handoff-finalize')
  const sessionId = 'session-child'
  const registry = fakeRegistry({
    'ws-source': { path: SOURCE_CWD, title: 'Source', sessionIds: ['session-source'] },
    'ws-target': { path: target, title: 'Target', sessionIds: [] },
  })
  const journal = {
    txid: 'handoff-finalize',
    kind: 'promotion',
    mode: 'scratch-handoff',
    state: 'child-created',
    target: { path: target, title: 'Target' },
    source: { sessionId: 'session-source', cwd: SOURCE_CWD },
    sourceSessionId: 'session-source',
    sourceBoundarySeq: 1,
    childSessionId: sessionId,
    workspaceId: 'ws-target',
    createdWorkspace: true,
    createdDir: false,
  }
  writeJson(journalPath(options), journal)

  const result = await finalizeHandoff(ctxWith(registry, fakeAgents(), []), options, journal)
  assert.equal(result.state, 'committed')
  assert.deepEqual(registry.get('ws-target').record.sessionIds, [sessionId])
  assert.equal(JSON.parse(fs.readFileSync(journalPath(options), 'utf8')).state, 'committed')
})
