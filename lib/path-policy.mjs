/**
 * Promotion path policy.
 *
 * Pure, host-side path decisions: canonicalize an existing directory,
 * enforce projects-root containment, validate a display title, and validate a
 * single Windows-safe project directory name for the later scratch promotion.
 * No registry or DSH service is touched here.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

const WINDOWS_RESERVED = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
])

export class PathPolicyError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'PathPolicyError'
    this.code = code
  }
}

export function isAbsolutePath(value) {
  return typeof value === 'string' && (path.isAbsolute(value) || path.win32.isAbsolute(value))
}

function comparable(value) {
  const resolved = path.resolve(value).replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function samePath(left, right) {
  return comparable(left) === comparable(right)
}

export function isUnderRoot(root, target) {
  const base = comparable(root)
  const candidate = comparable(target)
  return candidate === base || candidate.startsWith(`${base}/`)
}

export async function canonicalDirectory(input) {
  if (!isAbsolutePath(input)) throw new PathPolicyError('PATH_ABSOLUTE', `path is not absolute: ${input}`)
  let resolved
  try {
    resolved = await fs.realpath(input)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new PathPolicyError('PATH_MISSING', `path does not exist: ${input}`)
    throw new PathPolicyError('PATH_UNREADABLE', `cannot resolve path: ${input}`)
  }
  let info
  try {
    info = await fs.stat(resolved)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new PathPolicyError('PATH_MISSING', `path does not exist: ${input}`)
    throw new PathPolicyError('PATH_UNREADABLE', `cannot inspect path: ${input}`)
  }
  if (!info.isDirectory()) throw new PathPolicyError('PATH_NOT_DIR', `path is not a directory: ${input}`)
  return resolved
}

export async function canonicalRoot(root) {
  if (!isAbsolutePath(root)) throw new PathPolicyError('PATH_ABSOLUTE', `projectsRoot is not absolute: ${root}`)
  let resolved
  try {
    resolved = await fs.realpath(root)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new PathPolicyError('PROJECTS_ROOT_MISSING', `projectsRoot does not exist: ${root}`)
    throw new PathPolicyError('PROJECTS_ROOT_UNREADABLE', `cannot resolve projectsRoot: ${root}`)
  }
  const info = await fs.stat(resolved)
  if (!info.isDirectory()) throw new PathPolicyError('PROJECTS_ROOT_NOT_DIR', `projectsRoot is not a directory: ${root}`)
  return resolved
}

export function normalizeTitle(value) {
  const title = String(value ?? '').trim()
  if (title === '') throw new PathPolicyError('TITLE_BLANK', 'workspace title must not be blank')
  if (/[\u0000-\u001f\u007f]/.test(title)) throw new PathPolicyError('TITLE_INVALID', 'workspace title contains a control character')
  if (title.length > 120) throw new PathPolicyError('TITLE_TOO_LONG', 'workspace title must be 120 characters or fewer')
  return title
}

export function validateProjectName(value) {
  const name = String(value ?? '')
  if (name === '' || name === '.' || name === '..') {
    throw new PathPolicyError('PATH_RESERVED', `invalid project directory name: ${JSON.stringify(name)}`)
  }
  if (name.length > 120) throw new PathPolicyError('PATH_RESERVED', 'project directory name is too long')
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(name)) {
    throw new PathPolicyError('PATH_RESERVED', `project directory name contains a forbidden character: ${name}`)
  }
  if (/[. ]$/.test(name)) {
    throw new PathPolicyError('PATH_RESERVED', `project directory name must not end with a dot or space: ${name}`)
  }
  const stem = name.split('.')[0].toUpperCase()
  if (WINDOWS_RESERVED.has(stem)) {
    throw new PathPolicyError('PATH_RESERVED', `project directory name is reserved on Windows: ${name}`)
  }
  return name
}

export function defaultTitle(target) {
  const base = path.basename(target)
  return base === '' ? target : base
}

export function slugify(value) {
  const slug = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return slug === '' ? 'project' : slug
}
