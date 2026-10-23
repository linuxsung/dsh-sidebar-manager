/**
 * Durable promotion journal and single-writer lock.
 *
 * Kept separate from the mode-specific engines so Type A, Type B-cold, and
 * Type B-live share one crash-recovery record and one writer fence.
 */
import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_LOCK_TTL_MS = 10 * 60 * 1000

export class PromotionError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'PromotionError'
    this.code = code
  }
}

export function promotionDir(options) {
  return path.join(options.stateDir, 'promotion')
}

export function journalFile(options) {
  return path.join(promotionDir(options), 'pending.json')
}

export function lockFile(options) {
  return path.join(promotionDir(options), 'lock.json')
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`
  const fd = fs.openSync(temp, 'w')
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(temp, file)
}

export function readPromotionJournal(options) {
  return readJson(journalFile(options))
}

export function writePromotionJournal(options, journal) {
  journal.updatedAt = new Date().toISOString()
  writeJsonAtomic(journalFile(options), journal)
}

function lockIsStale(lock, ttlMs) {
  if (lock === undefined || typeof lock !== 'object') return true
  const createdAt = Number(lock.createdAt)
  if (!Number.isFinite(createdAt) || Date.now() - createdAt > ttlMs) return true
  const pid = Number(lock.pid)
  if (!Number.isInteger(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error?.code !== 'EPERM'
  }
}

export async function acquirePromotionLock(options, txid, config = {}) {
  const file = lockFile(options)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const ttlMs = Number.isFinite(config.ttlMs) && config.ttlMs > 0 ? config.ttlMs : options.lockTtlMs ?? DEFAULT_LOCK_TTL_MS
  const payload = {
    txid: String(txid),
    pid: process.pid,
    createdAt: Date.now(),
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx')
      try {
        fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`)
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      return payload
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const current = readJson(file)
      if (!lockIsStale(current, ttlMs)) {
        throw new PromotionError('LOCK_HELD', `promotion lock is held by ${current?.txid ?? 'unknown'}`)
      }
      try {
        fs.unlinkSync(file)
      } catch (unlinkError) {
        if (unlinkError?.code !== 'ENOENT') throw unlinkError
      }
    }
  }
  throw new PromotionError('LOCK_HELD', 'promotion lock could not be acquired')
}

export async function releasePromotionLock(options, txid) {
  const file = lockFile(options)
  const current = readJson(file)
  if (current === undefined || String(current.txid) !== String(txid)) return false
  try {
    fs.unlinkSync(file)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}
