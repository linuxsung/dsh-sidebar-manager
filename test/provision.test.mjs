import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  provisionScratchTarget,
  releaseManifestTemplate,
  resolveScratchTarget,
} from '../lib/provision.mjs'

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-provision-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function optionsFor(root) {
  const projectsRoot = path.join(root, 'projects')
  fs.mkdirSync(projectsRoot, { recursive: true })
  return { projectsRoot, allowExternalPaths: false }
}

test('resolveScratchTarget derives a safe target under projectsRoot', async (t) => {
  const root = tempRoot(t)
  const options = optionsFor(root)
  const result = await resolveScratchTarget(options, { title: 'My New Project' })

  assert.equal(result.ok, true)
  assert.equal(result.title, 'My New Project')
  assert.equal(result.slug, 'my-new-project')
  assert.equal(result.targetPath, path.join(fs.realpathSync(options.projectsRoot), 'my-new-project'))
  assert.equal(result.createdDir, true)
})

test('resolveScratchTarget blocks outside paths and non-empty targets', async (t) => {
  const root = tempRoot(t)
  const options = optionsFor(root)
  const outside = path.join(root, 'outside')
  const nonEmpty = path.join(options.projectsRoot, 'existing')
  fs.mkdirSync(outside)
  fs.mkdirSync(nonEmpty)
  fs.writeFileSync(path.join(nonEmpty, 'keep.txt'), 'x')

  const external = await resolveScratchTarget(options, { title: 'Outside', path: outside })
  assert.equal(external.ok, false)
  assert.ok(external.blockerCodes.includes('PATH_OUTSIDE_ROOT'))

  const occupied = await resolveScratchTarget(options, { title: 'Existing', path: nonEmpty })
  assert.equal(occupied.ok, false)
  assert.ok(occupied.blockerCodes.includes('TARGET_EXISTS_NONEMPTY'))
})

test('provisionScratchTarget creates a Git repository and a release manifest', async (t) => {
  const root = tempRoot(t)
  const options = optionsFor(root)
  const plan = await resolveScratchTarget(options, { title: 'Provisioned App' })
  assert.equal(plan.ok, true)

  const provisioned = await provisionScratchTarget(plan)

  assert.equal(provisioned.createdDir, true)
  assert.equal(fs.existsSync(path.join(plan.targetPath, '.git')), true)
  const manifest = JSON.parse(fs.readFileSync(path.join(plan.targetPath, 'release.manifest.json'), 'utf8'))
  assert.equal(manifest.project.id, 'provisioned-app')
  assert.equal(manifest.project.displayName, 'Provisioned App')
  assert.equal(manifest.artifacts[0].name, 'provisioned-app-{{version}}.zip')
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: plan.targetPath, encoding: 'utf8' }).trim()
  assert.equal(head, provisioned.commit)
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: plan.targetPath, encoding: 'utf8' }).trim()
  assert.equal(status, '')
})

test('releaseManifestTemplate is deterministic and scoped to the requested project', () => {
  const first = releaseManifestTemplate('My App', 'my-app')
  const second = releaseManifestTemplate('My App', 'my-app')
  assert.deepEqual(first, second)
  assert.equal(first.project.id, 'my-app')
  assert.equal(first.publish.github.repo, 'my-app')
})
