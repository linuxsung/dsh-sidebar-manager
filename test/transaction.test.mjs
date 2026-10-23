/**
 * Regression tests for the sidebar-manager transaction core.
 *
 * These tests exercise the boot finalizer directly with small in-memory
 * workspace registries. They intentionally do not need a running DSH server:
 * the failure modes are ordering (F1) and rollback scope (F2), both decided by
 * `finalizePending` and the journal.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { finalizePending } from '../lib/transaction.mjs'
import { projectKey } from '../lib/session-log.mjs'

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sidebar-manager-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function optionsFor(root) {
  return {
    dshHome: root,
    backupDir: path.join(root, 'backup'),
    stateDir: path.join(root, 'state'),
    projectsRoot: path.join(root, 'projects'),
    allowExternalPaths: false,
    trashRetentionDays: 30,
  }
}

function journalPath(options) {
  return path.join(options.stateDir, 'journal', 'pending.json')
}

function writeJournal(options, journal) {
  const file = journalPath(options)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(journal, null, 2)}\n`)
}

function readJournal(options) {
  return JSON.parse(fs.readFileSync(journalPath(options), 'utf8'))
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function workspaceEntity(registry, id, workspacePath, sessionIds = []) {
  let record = {
    path: workspacePath,
    title: id,
    sessionIds: [...sessionIds],
    createdAt: '2026-10-23T00:00:00.000Z',
    updatedAt: '2026-10-23T00:00:00.000Z',
  }
  let failAttachOnce = false
  return {
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
    get sessionIds() {
      return [...record.sessionIds]
    },
    failNextAttach() {
      failAttachOnce = true
    },
    async attachSession(sessionId) {
      if (failAttachOnce) {
        failAttachOnce = false
        throw new Error(`injected attach failure for ${sessionId}`)
      }
      for (const other of registry.workspaces.values()) {
        if (other.id !== id && other.record.sessionIds.includes(sessionId)) {
          throw new Error(`duplicate ownership for ${sessionId}: ${other.id} and ${id}`)
        }
      }
      if (!record.sessionIds.includes(sessionId)) record.sessionIds = [sessionId, ...record.sessionIds]
    },
    async detachSession(sessionId) {
      record.sessionIds = record.sessionIds.filter((entry) => entry !== sessionId)
    },
    async setTitle(title) {
      record.title = title
    },
  }
}

function fakeRegistry() {
  const registry = {
    workspaces: new Map(),
    order: [],
    createCount: 0,
    add(id, workspacePath, sessionIds = []) {
      const entity = workspaceEntity(registry, id, workspacePath, sessionIds)
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
      const id = `created-${++registry.createCount}`
      const entity = registry.add(id, workspacePath)
      if (title !== undefined) await entity.setTitle(title)
      return entity
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
  return registry
}

function ctxWith(registry) {
  return {
    get(name) {
      return name === 'workspaceRegistry' ? registry : undefined
    },
    logger: { warn() {} },
  }
}

function assertSingleOwner(registry, sessionId) {
  const owners = registry.list().filter((workspace) => workspace.record.sessionIds.includes(sessionId))
  assert.equal(owners.length, 1, `session ${sessionId} must have exactly one owner`)
  return owners[0]
}

test('move finalizer detaches the source before attaching the target', async (t) => {
  const root = tempRoot(t)
  const options = optionsFor(root)
  const registry = fakeRegistry()
  registry.add('ws-source', path.join(root, 'source'), ['session-1'])
  registry.add('ws-target', path.join(root, 'target'))
  writeJournal(options, {
    txid: 'move-1',
    kind: 'move',
    state: 'files-ready',
    sessionId: 'session-1',
    oldPath: path.join(root, 'source'),
    newPath: path.join(root, 'target'),
    targetWorkspaceId: 'ws-target',
  })

  const result = await finalizePending(ctxWith(registry), options)

  assert.equal(result.state, 'committed')
  assert.equal(registry.get('ws-source').record.sessionIds.includes('session-1'), false)
  assert.equal(registry.get('ws-target').record.sessionIds.includes('session-1'), true)
  assert.equal(assertSingleOwner(registry, 'session-1').id, 'ws-target')
})

test('attach failure after detach leaves a retryable journal without duplicate ownership', async (t) => {
  const root = tempRoot(t)
  const options = optionsFor(root)
  const registry = fakeRegistry()
  registry.add('ws-source', path.join(root, 'source'), ['session-1'])
  const target = registry.add('ws-target', path.join(root, 'target'))
  target.failNextAttach()
  writeJournal(options, {
    txid: 'move-2',
    kind: 'move',
    state: 'files-ready',
    sessionId: 'session-1',
    oldPath: path.join(root, 'source'),
    newPath: path.join(root, 'target'),
    targetWorkspaceId: 'ws-target',
  })

  await assert.rejects(finalizePending(ctxWith(registry), options), /injected attach failure/)

  assert.equal(registry.get('ws-source').record.sessionIds.includes('session-1'), false)
  assert.equal(registry.get('ws-target').record.sessionIds.includes('session-1'), false)
  assert.equal(readJournal(options).state, 'files-ready')
  assert.equal(registry.list().filter((workspace) => workspace.record.sessionIds.includes('session-1')).length, 0)

  const retry = await finalizePending(ctxWith(registry), options)
  assert.equal(retry.state, 'committed')
  assert.equal(assertSingleOwner(registry, 'session-1').id, 'ws-target')
})

test('rename finalizer detaches the old workspace before attaching accounted sessions', async (t) => {
  const root = tempRoot(t)
  const options = optionsFor(root)
  const registry = fakeRegistry()
  registry.add('ws-old', path.join(root, 'old'), ['session-1'])
  writeJournal(options, {
    txid: 'rename-1',
    kind: 'rename',
    state: 'files-ready',
    oldPath: path.join(root, 'old'),
    newPath: path.join(root, 'new'),
    oldWorkspaceId: 'ws-old',
    title: 'Renamed',
    accounted: ['session-1'],
    beforeWorkspaceId: undefined,
    orderIndex: 0,
  })

  const result = await finalizePending(ctxWith(registry), options)

  assert.equal(result.state, 'committed')
  assert.equal(registry.get('ws-old'), undefined)
  const target = registry.list().find((workspace) => workspace.path === path.join(root, 'new'))
  assert.ok(target)
  assert.equal(target.record.sessionIds.includes('session-1'), true)
  assert.equal(assertSingleOwner(registry, 'session-1').id, target.id)
})

test('prepared rollback does not restore the whole workspace registry', async (t) => {
  const root = tempRoot(t)
  const options = optionsFor(root)
  const currentRegistry = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['keep', 'concurrent'] },
    tables: {
      workspaces: {
        keep: {
          path: path.join(root, 'keep'),
          title: 'Keep',
          sessionIds: ['session-1'],
          createdAt: '2026-10-23T00:00:00.000Z',
          updatedAt: '2026-10-23T00:00:00.000Z',
        },
        concurrent: {
          path: path.join(root, 'concurrent'),
          title: 'Concurrent addition',
          sessionIds: [],
          createdAt: '2026-10-23T00:00:01.000Z',
          updatedAt: '2026-10-23T00:00:01.000Z',
        },
      },
    },
  }
  const backupRegistry = {
    ...currentRegistry,
    global: { initialized: true, workspaceIds: ['keep'] },
    tables: { workspaces: { keep: currentRegistry.tables.workspaces.keep } },
  }
  writeJson(path.join(root, 'storages', 'workspace.json'), currentRegistry)
  writeJson(path.join(options.backupDir, 'workspace.json'), backupRegistry)
  writeJournal(options, {
    txid: 'move-3',
    kind: 'move',
    state: 'prepared',
    sessionId: 'session-1',
    oldPath: path.join(root, 'old'),
    newPath: path.join(root, 'new'),
    targetWorkspaceId: 'ws-target',
    backupDir: options.backupDir,
  })

  const result = await finalizePending(ctxWith(fakeRegistry()), options)

  assert.equal(result.state, 'rolledback')
  const after = JSON.parse(fs.readFileSync(path.join(root, 'storages', 'workspace.json'), 'utf8'))
  assert.ok(after.tables.workspaces.concurrent, 'concurrent registry addition must survive rollback')
  assert.deepEqual(after.global.workspaceIds, ['keep', 'concurrent'])
  assert.equal(readJournal(options).state, 'rolledback')
})

test('rollback removes only the transaction session project directory', async (t) => {
  const root = tempRoot(t)
  const options = optionsFor(root)
  const newPath = path.join(root, 'new')
  const unrelated = path.join(root, 'sessions', '--unrelated--', 'session-9')
  const transactionSession = path.join(root, 'sessions', projectKey(newPath), 'session-1')
  fs.mkdirSync(unrelated, { recursive: true })
  fs.mkdirSync(transactionSession, { recursive: true })
  writeJournal(options, {
    txid: 'move-4',
    kind: 'move',
    state: 'prepared',
    sessionId: 'session-1',
    oldPath: path.join(root, 'old'),
    newPath,
    targetWorkspaceId: 'ws-target',
    backupDir: options.backupDir,
  })

  const result = await finalizePending(ctxWith(fakeRegistry()), options)

  assert.equal(result.state, 'rolledback')
  assert.equal(fs.existsSync(transactionSession), false)
  assert.equal(fs.existsSync(unrelated), true)
})
