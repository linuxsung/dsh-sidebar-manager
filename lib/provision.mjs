/**
 * Scratch target planning and provisioning for Type B promotion.
 *
 * Planning is read-only. Provisioning creates a new directory, initializes a
 * local Git repository, and writes a release.manifest.json template so the new
 * workspace is immediately usable by release-harness.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import {
  PathPolicyError,
  canonicalDirectory,
  canonicalRoot,
  defaultTitle,
  isUnderRoot,
  normalizeTitle,
  slugify,
  validateProjectName,
} from './path-policy.mjs'

function blocker(code, extra = {}) {
  return { code, ...extra }
}

export function releaseManifestTemplate(title, slug) {
  return {
    $schema: 'https://raw.githubusercontent.com/linuxsung/release-harness/main/schema/release.manifest.schema.json',
    specVersion: '1.0',
    project: {
      id: slug,
      displayName: title,
      version: '0.1.0',
      license: 'MIT',
      repository: `https://github.com/linuxsung/${slug}`,
      description: {
        en: `${title} release workspace.`,
        ko: `${title} 릴리스 워크스페이스.`,
      },
    },
    source: { root: '.' },
    artifacts: [
      {
        name: `${slug}-{{version}}.zip`,
        format: 'zip',
        from: 'dist',
      },
    ],
    docs: { enabled: false },
    publish: {
      github: {
        owner: 'linuxsung',
        repo: slug,
        visibility: 'public',
        topics: ['deepseek-harness', 'release'],
      },
    },
  }
}

export async function resolveScratchTarget(options, body = {}) {
  const blockers = []
  const requestedPath = typeof body.path === 'string' ? body.path.trim() : ''
  let root
  try {
    root = await canonicalRoot(options.projectsRoot)
  } catch (error) {
    if (error instanceof PathPolicyError) blockers.push(blocker(error.code, { path: options.projectsRoot }))
    else throw error
  }

  let title
  try {
    title = normalizeTitle(
      typeof body.title === 'string' && body.title.trim() !== ''
        ? body.title
        : requestedPath === ''
          ? 'Promoted Project'
          : defaultTitle(requestedPath),
    )
  } catch (error) {
    if (error instanceof PathPolicyError) blockers.push(blocker(error.code))
    else throw error
  }

  const slug = slugify(title ?? body.sessionId ?? 'project')
  let targetPath = requestedPath === ''
    ? path.join(root ?? options.projectsRoot, slug)
    : path.resolve(requestedPath)

  if (requestedPath !== '' && !path.isAbsolute(requestedPath)) {
    blockers.push(blocker('PATH_ABSOLUTE', { path: requestedPath }))
  }

  let exists = false
  let empty = false
  let createdDir = false
  let canonicalTarget = targetPath
  try {
    const info = fs.statSync(targetPath)
    if (!info.isDirectory()) {
      blockers.push(blocker('TARGET_NOT_DIR', { path: targetPath }))
    } else {
      exists = true
      canonicalTarget = fs.realpathSync(targetPath)
      empty = fs.readdirSync(canonicalTarget).length === 0
      if (!empty) blockers.push(blocker('TARGET_EXISTS_NONEMPTY', { path: canonicalTarget }))
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    const parent = path.dirname(targetPath)
    try {
      const parentReal = fs.realpathSync(parent)
      canonicalTarget = path.join(parentReal, path.basename(targetPath))
      createdDir = true
    } catch (parentError) {
      if (parentError?.code === 'ENOENT') blockers.push(blocker('TARGET_PARENT_MISSING', { path: parent }))
      else throw parentError
    }
  }

  if (targetPath !== '' && root !== undefined && options.allowExternalPaths !== true && !isUnderRoot(root, canonicalTarget)) {
    blockers.push(blocker('PATH_OUTSIDE_ROOT', { path: canonicalTarget, root }))
  }
  try {
    validateProjectName(path.basename(canonicalTarget))
  } catch (error) {
    if (error instanceof PathPolicyError) blockers.push(blocker(error.code, { path: canonicalTarget }))
    else throw error
  }

  return {
    ok: blockers.length === 0,
    blockers,
    blockerCodes: blockers.map((entry) => entry.code),
    root,
    title: title ?? '',
    slug,
    targetPath: canonicalTarget,
    exists,
    empty,
    createdDir,
  }
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

export function assertGitAvailable() {
  try {
    git(['--version'], process.cwd())
  } catch {
    throw new PathPolicyError('GIT_MISSING', 'git executable is unavailable')
  }
}

export async function provisionScratchTarget(plan) {
  assertGitAvailable()
  let createdDir = false
  if (!plan.exists) {
    fs.mkdirSync(plan.targetPath, { recursive: false })
    createdDir = true
  } else {
    fs.mkdirSync(plan.targetPath, { recursive: true })
  }

  let commit
  try {
    git(['init', '-b', 'main'], plan.targetPath)
    const manifest = releaseManifestTemplate(plan.title, plan.slug)
    fs.writeFileSync(
      path.join(plan.targetPath, 'release.manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    )
    git(['add', 'release.manifest.json'], plan.targetPath)
    git(
      [
        '-c',
        'user.name=DSH Promotion',
        '-c',
        'user.email=dsh-promotion@localhost',
        'commit',
        '-m',
        'chore: initialize release workspace',
      ],
      plan.targetPath,
    )
    commit = git(['rev-parse', 'HEAD'], plan.targetPath).trim()
  } catch (error) {
    if (createdDir) fs.rmSync(plan.targetPath, { recursive: true, force: true })
    throw error
  }

  return {
    createdDir,
    gitCreated: true,
    manifestCreated: true,
    commit,
  }
}

export function removeProvisionedTarget(plan, provisioned) {
  if (provisioned?.createdDir === true && plan?.targetPath !== undefined) {
    fs.rmSync(plan.targetPath, { recursive: true, force: true })
  }
}
