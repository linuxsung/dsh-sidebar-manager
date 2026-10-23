import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import zlib from 'node:zlib'
import {
  applyScratchCold,
  finalizeScratchCold,
  previewScratchCold,
} from '../lib/scratch-promotion.mjs'
import {
  expectedLogPath,
  projcachePath,
  projectKey,
  readLogFile,
} from '../lib/session-log.mjs'

const CHECKSUM = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }
const OLD_CWD = 'C:\\promotion-test\\source'
const TARGET_TITLE = 'Provisioned Target'

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-scratch-promotion-test-'))
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

function writeSessionLog(home, cwd, id) {
  const file = expectedLogPath(home, cwd, id)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const header = { type: 'session', version: 4, id, createdAt: 1, cwd, isSeeded: false }
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const frames = [
    zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'), CHECKSUM),
    zlib.zstdCompressSync(Buffer.from(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8'), CHECKSUM),
  ]
  fs.writeFileSync(file, Buffer.concat(frames))
  writeJson(projcachePath(home, id), {
    version: 7,
    record: {
      identity: { formatVersion: 4, createdAt: 1, cwd, isSeeded: false, inheritedEventCount: 0 },
      rows: { workingDirectory: { ver: 1, seq: 1, val: cwd } },
    },
  })
  return { file, events }
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
  }
  for (const [id, value] of Object.entries(initial)) registry.add(id, value.path, value.title, value.sessionIds)
  return registry
}

function ctxWith(registry, headers, live = false) {
  return {
    get(name) {
      if (name === 'workspaceRegistry') return registry
      if (name === 'sessionPersistence') return { list: async () => headers.map((header) => ({ header })) }
      if (name === 'agents' && live) return { get: () => ({}) }
      if (name === 'sessions' && live) return { get: () => ({}) }
      return undefined
    },
    logger: { warn() {} },
  }
}

function journalPath(options) {
  return path.join(options.stateDir, 'promotion', 'pending.json')
}

test('scratch-cold provisions a Git target and relocates one cold session', async (t) => {
  const root = tempRoot(t)
  const options = optionsFor(root)
  const target = path.join(options.projectsRoot, 'provisioned-target')
  const sessionId = 'session-scratch-1'
  const { file: oldLog, events } = writeSessionLog(root, OLD_CWD, sessionId)
  const registry = fakeRegistry({ 'ws-source': { path: OLD_CWD, title: 'Source', sessionIds: [sessionId] } })
  const header = { id: sessionId, cwd: OLD_CWD, createdAt: 1, agentPreset: 'standard' }
  const ctx = ctxWith(registry, [header])

  const preview = await previewScratchCold(ctx, options, { sessionId, path: target, title: TARGET_TITLE })
  assert.equal(preview.ok, true, JSON.stringify(preview.blockers))
  assert.equal(preview.effects.restartRequired, true)

  const applied = await applyScratchCold(ctx, options, { sessionId, path: target, title: TARGET_TITLE })
  assert.equal(applied.ok, true, JSON.stringify(applied))
  assert.equal(applied.restartRequired, true)
  assert.equal(applied.workspaceId, null)
  assert.equal(fs.existsSync(path.join(target, '.git')), true)
  assert.equal(fs.existsSync(path.join(target, 'release.manifest.json')), true)
  assert.equal(registry.list().some((workspace) => workspace.path === target), false)
  assert.equal(fs.existsSync(oldLog), false)
  const relocated = readLogFile(expectedLogPath(root, target, sessionId))
  assert.equal(relocated.header.cwd, target)
  assert.deepEqual(relocated.events, events)
  assert.equal(JSON.parse(fs.readFileSync(projcachePath(root, sessionId), 'utf8')).record.identity.cwd, target)
  assert.equal(JSON.parse(fs.readFileSync(journalPath(options), 'utf8')).state, 'files-ready')
})

test('scratch-cold finalizer creates the target workspace and preserves single ownership', async (t) => {
  const root = tempRoot(t)
  const options = optionsFor(root)
  const target = path.join(options.projectsRoot, 'provisioned-target')
  const sessionId = 'session-scratch-2'
  writeSessionLog(root, OLD_CWD, sessionId)
  const registry = fakeRegistry({ 'ws-source': { path: OLD_CWD, title: 'Source', sessionIds: [sessionId] } })
  const ctx = ctxWith(registry, [{ id: sessionId, cwd: OLD_CWD, createdAt: 1 }])
  await applyScratchCold(ctx, options, { sessionId, path: target, title: TARGET_TITLE })

  const result = await finalizeScratchCold(ctx, options, JSON.parse(fs.readFileSync(journalPath(options), 'utf8')))

  assert.equal(result.state, 'committed')
  assert.equal(registry.get('ws-source').record.sessionIds.includes(sessionId), false)
  const targetWorkspace = registry.list().find((workspace) => workspace.path === target)
  assert.ok(targetWorkspace)
  assert.deepEqual(targetWorkspace.record.sessionIds, [sessionId])
  assert.equal(JSON.parse(fs.readFileSync(journalPath(options), 'utf8')).state, 'committed')
})

test('scratch-cold blocks live sessions and non-empty targets', async (t) => {
  const root = tempRoot(t)
  const options = optionsFor(root)
  const target = path.join(options.projectsRoot, 'occupied')
  fs.mkdirSync(target)
  fs.writeFileSync(path.join(target, 'keep.txt'), 'x')
  const sessionId = 'session-scratch-live'
  writeSessionLog(root, OLD_CWD, sessionId)
  const registry = fakeRegistry({ 'ws-source': { path: OLD_CWD, title: 'Source', sessionIds: [sessionId] } })
  const ctx = ctxWith(registry, [{ id: sessionId, cwd: OLD_CWD, createdAt: 1 }], true)

  const live = await previewScratchCold(ctx, options, { sessionId, path: target, title: TARGET_TITLE })
  assert.equal(live.ok, false)
  assert.ok(live.blockerCodes.includes('SESSION_LIVE'))
  assert.ok(live.blockerCodes.includes('TARGET_EXISTS_NONEMPTY'))
})

test('scratch-cold rollback restores the old log after a log-ready crash', async (t) => {
  const root = tempRoot(t)
  const options = optionsFor(root)
  const target = path.join(options.projectsRoot, 'rollback-target')
  const sessionId = 'session-scratch-rollback'
  const { file: oldLog } = writeSessionLog(root, OLD_CWD, sessionId)
  const backupDir = path.join(options.backupDir, 'tx-rollback')
  const backupLog = path.join(backupDir, 'sessions', projectKey(OLD_CWD), sessionId, 'session.v4.jsonl.zstd')
  fs.mkdirSync(path.dirname(backupLog), { recursive: true })
  fs.copyFileSync(oldLog, backupLog)
  const backupCache = path.join(backupDir, 'projcache', `${sessionId}.json`)
  fs.mkdirSync(path.dirname(backupCache), { recursive: true })
  fs.copyFileSync(projcachePath(root, sessionId), backupCache)
  const targetLog = expectedLogPath(root, target, sessionId)
  fs.mkdirSync(path.dirname(targetLog), { recursive: true })
  fs.copyFileSync(oldLog, targetLog)
  const journal = {
    txid: 'tx-rollback',
    kind: 'promotion',
    mode: 'scratch-cold',
    state: 'log-ready',
    target: { path: target, title: TARGET_TITLE },
    source: { sessionId, cwd: OLD_CWD, workspaceId: 'ws-source' },
    sessionId,
    sourceCwd: OLD_CWD,
    oldLogPath: oldLog,
    newLogPath: targetLog,
    backupDir,
    createdDir: true,
  }
  writeJson(journalPath(options), journal)

  const registry = fakeRegistry({ 'ws-source': { path: OLD_CWD, title: 'Source', sessionIds: [sessionId] } })
  const result = await finalizeScratchCold(ctxWith(registry, [{ id: sessionId, cwd: OLD_CWD, createdAt: 1 }]), options, journal)

  assert.equal(result.state, 'rolledback')
  assert.equal(fs.existsSync(oldLog), true)
  assert.equal(fs.existsSync(targetLog), false)
  assert.equal(JSON.parse(fs.readFileSync(journalPath(options), 'utf8')).state, 'rolledback')
})
