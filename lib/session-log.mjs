/**
 * Session-log primitives shared by the Sidebar Manager Host transaction.
 *
 * Decodes/encodes the v4 JSONL+zstd frame layout used by
 * `@deepseek-ai/dsh-session-persistence-jsonl`: the first frame is exactly one
 * header line; every later frame is an untouched event-frame byte slice.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528
const CHECKSUM = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }

export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid zstd magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`)
      offset += blockType === 1 ? 1 : blockSize
      if (offset > buffer.length) return { frames, tornStart: start }
      if (lastBlock) break
    }
    if (checksum) offset += 4
    if (offset > buffer.length) return { frames, tornStart: start }
    frames.push({ start, end: offset })
  }
  return { frames }
}

export function readLogFile(file) {
  const buffer = fs.readFileSync(file)
  const { frames, tornStart } = scanZstdFrames(buffer)
  if (frames.length === 0) throw new Error(`no complete zstd frame in ${file}`)
  const texts = frames.map((frame) => zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end)))
  const headerText = texts[0].toString('utf8')
  if (!headerText.endsWith('\n') || headerText.indexOf('\n') !== headerText.length - 1) {
    throw new Error(`header frame is not exactly one JSONL line in ${file}`)
  }
  return {
    file,
    tornStart,
    header: JSON.parse(headerText.slice(0, -1)),
    events: Buffer.concat(texts.slice(1)).toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)),
    eventFrameBytes: frames.slice(1).map((frame) => buffer.subarray(frame.start, frame.end)),
  }
}

export function buildRelocated(log, targetCwd) {
  const headerLine = `${JSON.stringify({ ...log.header, cwd: targetCwd })}\n`
  const headerFrame = zlib.zstdCompressSync(Buffer.from(headerLine, 'utf8'), CHECKSUM)
  return Buffer.concat([headerFrame, ...log.eventFrameBytes])
}

export function buildCloned(log, { id, cwd, createdAt }) {
  const headerLine = `${JSON.stringify({ ...log.header, id, cwd, createdAt })}\n`
  const headerFrame = zlib.zstdCompressSync(Buffer.from(headerLine, 'utf8'), CHECKSUM)
  return Buffer.concat([headerFrame, ...log.eventFrameBytes])
}

function verifyDecoded(log, decoded, expected) {
  if (decoded.header.id !== expected.id) throw new Error('session id mismatch')
  if (decoded.header.version !== 4) throw new Error('session version changed')
  if (decoded.header.cwd !== expected.cwd) throw new Error('header cwd mismatch')
  const before = Buffer.concat(log.eventFrameBytes)
  const after = Buffer.concat(decoded.eventFrameBytes)
  if (!before.equals(after)) throw new Error('event frames changed')
  return { events: decoded.events.length, headerFrameSingleLine: true, eventFramesIdentical: true }
}

export function verifyRelocated(log, buffer, targetCwd, id) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-p2-verify-'))
  const temp = path.join(tempDir, 'session.v4.jsonl.zstd')
  fs.writeFileSync(temp, buffer)
  try {
    return verifyDecoded(log, readLogFile(temp), { id, cwd: targetCwd })
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

export function verifyCloned(log, buffer, id, cwd) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-p2-verify-'))
  const temp = path.join(tempDir, 'session.v4.jsonl.zstd')
  fs.writeFileSync(temp, buffer)
  try {
    return verifyDecoded(log, readLogFile(temp), { id, cwd })
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

export function encodeSegment(raw) {
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    out += ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch) ? ch : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

export function projectKey(cwd) {
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

export function expectedLogPath(dshHome, cwd, id) {
  return path.join(dshHome, 'sessions', projectKey(cwd), encodeSegment(id), 'session.v4.jsonl.zstd')
}

export function projcachePath(dshHome, id) {
  return path.join(dshHome, 'storages', 'session_projcache', 'sessions', `${id}.json`)
}

export function findLogFile(dshHome, id) {
  const root = path.join(dshHome, 'sessions')
  if (!fs.existsSync(root)) return undefined
  for (const project of fs.readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const candidate = path.join(root, project.name, encodeSegment(id), 'session.v4.jsonl.zstd')
    if (fs.existsSync(candidate)) return candidate
  }
  return undefined
}

export function readProjcache(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined
}

export function patchProjcache(file, targetCwd) {
  if (!fs.existsSync(file)) return false
  const document = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (document.record?.identity) document.record.identity.cwd = targetCwd
  if (document.record?.rows?.workingDirectory) document.record.rows.workingDirectory.val = targetCwd
  const temp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`)
  fs.renameSync(temp, file)
  return true
}
