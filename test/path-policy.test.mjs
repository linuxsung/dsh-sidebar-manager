/**
 * Path policy tests for the Type A promotion engine.
 *
 * The policy is deliberately small: canonical existing directory, explicit
 * projects-root containment, a non-blank title, and Windows-safe scratch names
 * for the later Type B path.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  canonicalDirectory,
  canonicalRoot,
  defaultTitle,
  isUnderRoot,
  normalizeTitle,
  samePath,
  slugify,
  validateProjectName,
} from '../lib/path-policy.mjs'

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-path-policy-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

test('canonicalDirectory resolves an existing directory and rejects files or missing paths', async (t) => {
  const root = tempRoot(t)
  const directory = path.join(root, 'project')
  const file = path.join(root, 'file.txt')
  fs.mkdirSync(directory)
  fs.writeFileSync(file, 'x')

  assert.equal(await canonicalDirectory(directory), fs.realpathSync(directory))
  await assert.rejects(canonicalDirectory('relative/path'), { code: 'PATH_ABSOLUTE' })
  await assert.rejects(canonicalDirectory(file), { code: 'PATH_NOT_DIR' })
  await assert.rejects(canonicalDirectory(path.join(root, 'missing')), { code: 'PATH_MISSING' })
})

test('containment compares path segments, not string prefixes', () => {
  const root = 'C:\\Users\\nolit\\Workspace\\projects'
  assert.equal(isUnderRoot(root, path.join(root, 'release-harness')), true)
  assert.equal(isUnderRoot(root, root), true)
  assert.equal(isUnderRoot(root, path.join(root, 'release-harness-other')), true)
  assert.equal(isUnderRoot(root, 'C:\\Users\\nolit\\Workspace\\projects-other\\x'), false)
  assert.equal(isUnderRoot(root, 'C:\\Users\\nolit\\Workspace\\projects2'), false)
})

test('samePath is case-insensitive on Windows path spellings', () => {
  assert.equal(samePath('C:\\Users\\Nolit\\Workspace\\projects\\A', 'c:/users/nolit/workspace/projects/a'), true)
  assert.equal(samePath('C:\\Users\\Nolit\\Workspace\\projects\\A', 'C:\\Users\\Nolit\\Workspace\\projects\\B'), false)
})

test('normalizeTitle trims and rejects blank or oversized titles', () => {
  assert.equal(normalizeTitle('  Release Harness  '), 'Release Harness')
  assert.throws(() => normalizeTitle('   '), { code: 'TITLE_BLANK' })
  assert.throws(() => normalizeTitle('bad\nname'), { code: 'TITLE_INVALID' })
  assert.throws(() => normalizeTitle('x'.repeat(121)), { code: 'TITLE_TOO_LONG' })
})

test('validateProjectName rejects traversal, separators, reserved names, and invalid endings', () => {
  for (const value of ['..', '.', 'a/b', 'a\\b', 'CON', 'nul', 'COM1', 'name ', 'name.', '']) {
    assert.throws(() => validateProjectName(value), (error) => error.code === 'PATH_RESERVED', value)
  }
  assert.equal(validateProjectName('release-harness'), 'release-harness')
  assert.equal(validateProjectName('my.project_2'), 'my.project_2')
})

test('defaultTitle uses the final path segment', () => {
  assert.equal(defaultTitle('C:\\Users\\nolit\\Workspace\\projects\\release-harness'), 'release-harness')
})

test('slugify creates a deterministic project directory name and falls back safely', () => {
  assert.equal(slugify('Universal Release Ops Harness'), 'universal-release-ops-harness')
  assert.equal(slugify('  My Project!!  '), 'my-project')
  assert.equal(slugify('한글 프로젝트'), 'project')
  assert.equal(slugify('x'.repeat(100)).length, 80)
})

test('canonicalRoot resolves the configured projects root', async (t) => {
  const root = tempRoot(t)
  fs.mkdirSync(path.join(root, 'projects'))
  assert.equal(await canonicalRoot(path.join(root, 'projects')), fs.realpathSync(path.join(root, 'projects')))
  await assert.rejects(canonicalRoot(path.join(root, 'missing')), { code: 'PROJECTS_ROOT_MISSING' })
})
