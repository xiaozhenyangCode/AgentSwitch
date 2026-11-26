import { lstatSync } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { deflateRawSync, inflateRawSync } from 'node:zlib'

const LOCAL_HEADER = 0x04034b50
const CENTRAL_HEADER = 0x02014b50
const DIRECTORY_END = 0x06054b50
const DATA_DESCRIPTOR = 0x08074b50
const UTF8 = 0x0800
const HAS_DESCRIPTOR = 0x0008
const MAX_UINT16 = 0xffff
const MAX_UINT32 = 0xffffffff
const LOCAL_BYTES = 30
const CENTRAL_BYTES = 46
const END_BYTES = 22

export interface ZipLimits {
  maxFileBytes: number
  maxTotalBytes: number
  maxEntries: number
}

export const DEFAULT_ZIP_LIMITS: Readonly<ZipLimits> = Object.freeze({
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxEntries: 10_000
})

type ZipMethod = 0 | 8

export interface ZipInputEntry {
  name: string
  data: Buffer
  method?: ZipMethod
}

export interface ZipEntry {
  name: string
  method: ZipMethod
  compressedSize: number
  size: number
  crc32: number
  dataOffset: number
  isDirectory: boolean
}

const STORE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.heic', '.zip', '.gz', '.bz2', '.xz',
  '.7z', '.rar', '.pdf', '.docx', '.xlsx', '.pptx', '.mp3', '.mp4', '.mov', '.webm'
])
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) {
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  }
  return value
})

function crc32(data: Buffer): number {
  let crc = MAX_UINT32
  for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]
  return (crc ^ MAX_UINT32) >>> 0
}

function zipLimits(overrides?: Partial<ZipLimits>): ZipLimits {
  const limits = { ...DEFAULT_ZIP_LIMITS, ...overrides }
  if (Object.values(limits).some((limit) => !Number.isSafeInteger(limit) || limit < 0)) {
    throw new Error('Invalid ZIP limits')
  }
  return limits
}

export function assertSafeZipEntryPath(name: string): void {
  const parts = name.replace(/\/$/, '').split('/')
  if (parts.some((part) => !part || /[\\:\x00-\x1f<>|"*?]|[. ]$/.test(part) ||
      /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part))) {
    throw new Error('Unsafe ZIP entry path')
  }
}

/** Checks lexical containment and rejects symlinks already present under the destination. */
export function safeJoinInside(destRoot: string, relPath: string): string {
  assertSafeZipEntryPath(relPath)
  const root = resolve(destRoot)
  const target = resolve(root, relPath)
  const rel = relative(root, target)
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw new Error('ZIP destination is outside its root')
  }

  const parts = rel.split(sep)
  let current = root
  for (let i = 0; i <= parts.length; i++) {
    const entry = lstatSync(current, { throwIfNoEntry: false })
    if (!entry) break
    if (entry.isSymbolicLink() || (i < parts.length && !entry.isDirectory()) ||
        (i === parts.length && !(relPath.endsWith('/') ? entry.isDirectory() : entry.isFile()))) {
      throw new Error('Unsafe existing ZIP destination')
    }
    if (i < parts.length) current = join(current, parts[i])
  }
  return target
}

function checkSize(size: number, total: number, limits: ZipLimits): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > limits.maxFileBytes) {
    throw new Error('ZIP entry exceeds file size limit')
  }
  if (total > limits.maxTotalBytes) throw new Error('ZIP archive exceeds total size limit')
}

function checkName(name: string, names: Set<string>): void {
  assertSafeZipEntryPath(name)
  const key = name.replace(/\/$/, '')
  if (names.has(key)) throw new Error('Duplicate ZIP entry path')
  names.add(key)
}

export function createZipBuffer(entries: readonly ZipInputEntry[]): Buffer {
  if (entries.length > DEFAULT_ZIP_LIMITS.maxEntries) throw new Error('ZIP archive exceeds entry limit')
  const locals: Buffer[] = []
  const central: Buffer[] = []
  const names = new Set<string>()
  let offset = 0
  let total = 0
  for (const entry of entries) {
    checkName(entry.name, names)
    const name = Buffer.from(entry.name, 'utf8')
    if (name.length > MAX_UINT16 || decoder.decode(name) !== entry.name) throw new Error('Invalid ZIP entry name')
    const directory = entry.name.endsWith('/')
    const size = entry.data.length
    if (directory && size) throw new Error('ZIP directory contains data')
    total += size
    checkSize(size, total, DEFAULT_ZIP_LIMITS)
    const method = entry.method ?? (directory || STORE_EXTENSIONS.has(extname(entry.name).toLowerCase()) ? 0 : 8)
    if (method !== 0 && method !== 8) throw new Error('Unsupported ZIP compression method')
    const data = method === 8 ? deflateRawSync(entry.data) : entry.data
    const checksum = crc32(entry.data)

    const local = Buffer.alloc(LOCAL_BYTES)
    local.writeUInt32LE(LOCAL_HEADER, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(UTF8, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0x21, 12) // 1980-01-01 in DOS date encoding.
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, data)

    const header = Buffer.alloc(CENTRAL_BYTES)
    header.writeUInt32LE(CENTRAL_HEADER, 0)
    header.writeUInt16LE(0x0314, 4) // ZIP 2.0, Unix mode in the external attributes.
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(UTF8, 8)
    header.writeUInt16LE(method, 10)
    header.writeUInt16LE(0x21, 14)
    header.writeUInt32LE(checksum, 16)
    header.writeUInt32LE(data.length, 20)
    header.writeUInt32LE(size, 24)
    header.writeUInt16LE(name.length, 28)
    header.writeUInt32LE(directory ? ((0o40755 << 16) | 0x10) >>> 0 : (0o100644 << 16) >>> 0, 38)
    header.writeUInt32LE(offset, 42)
    central.push(header, name)
    offset += local.length + name.length + data.length
  }

  const directorySize = central.reduce((size, buffer) => size + buffer.length, 0)
  const end = Buffer.alloc(END_BYTES)
  end.writeUInt32LE(DIRECTORY_END, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directorySize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...central, end])
}

function findDirectoryEnd(buf: Buffer): number {
  const min = Math.max(0, buf.length - END_BYTES - MAX_UINT16)
  for (let offset = buf.length - END_BYTES; offset >= min; offset--) {
    if (buf.readUInt32LE(offset) === DIRECTORY_END && offset + END_BYTES + buf.readUInt16LE(offset + 20) === buf.length &&
        buf.readUInt32LE(offset + 12) + buf.readUInt32LE(offset + 16) === offset) return offset
  }
  throw new Error('Missing ZIP central directory')
}

function descriptorEnd(buf: Buffer, dataEnd: number, centralStart: number, entry: ZipEntry): number {
  const matches = (pos: number) => pos + 12 <= centralStart && buf.readUInt32LE(pos) === entry.crc32 &&
    buf.readUInt32LE(pos + 4) === entry.compressedSize && buf.readUInt32LE(pos + 8) === entry.size
  if (dataEnd + 16 <= centralStart && buf.readUInt32LE(dataEnd) === DATA_DESCRIPTOR && matches(dataEnd + 4)) return dataEnd + 16
  if (matches(dataEnd)) return dataEnd + 12
  throw new Error('Invalid ZIP data descriptor')
}

/** Validates archive structure, entry paths, and declared sizes without decompressing files. */
export function readZipEntries(buf: Buffer, overrides?: Partial<ZipLimits>): ZipEntry[] {
  const limits = zipLimits(overrides)
  const end = findDirectoryEnd(buf)
  const count = buf.readUInt16LE(end + 10)
  const start = buf.readUInt32LE(end + 16)
  if (buf.readUInt16LE(end + 4) || buf.readUInt16LE(end + 6) ||
      buf.readUInt16LE(end + 8) !== count || count === MAX_UINT16 || start === MAX_UINT32) {
    throw new Error('Multi-disk and ZIP64 archives are unsupported')
  }
  if (count > limits.maxEntries) throw new Error('ZIP archive exceeds entry limit')

  const entries: ZipEntry[] = []
  const ranges: { start: number; end: number }[] = []
  const names = new Set<string>()
  let pos = start
  let total = 0
  for (let i = 0; i < count; i++) {
    if (pos + CENTRAL_BYTES > end || buf.readUInt32LE(pos) !== CENTRAL_HEADER) throw new Error('Invalid ZIP central header')
    const flags = buf.readUInt16LE(pos + 8)
    const method = buf.readUInt16LE(pos + 10)
    if (method !== 0 && method !== 8) throw new Error('Unsupported ZIP compression method')
    if (flags & ~(UTF8 | HAS_DESCRIPTOR | (method === 8 ? 0x0006 : 0))) throw new Error('Unsupported ZIP entry flags')
    const checksum = buf.readUInt32LE(pos + 16)
    const compressedSize = buf.readUInt32LE(pos + 20)
    const size = buf.readUInt32LE(pos + 24)
    const nameSize = buf.readUInt16LE(pos + 28)
    const attributes = buf.readUInt32LE(pos + 38)
    const local = buf.readUInt32LE(pos + 42)
    if (buf.readUInt16LE(pos + 34) || [local, size, compressedSize].includes(MAX_UINT32)) {
      throw new Error('Multi-disk and ZIP64 archives are unsupported')
    }
    const mode = (attributes >>> 16) & 0o170000
    if (mode && mode !== 0o100000 && mode !== 0o040000) throw new Error('Unsupported ZIP entry type (symlink or special file)')
    const nameStart = pos + CENTRAL_BYTES
    const nameEnd = nameStart + nameSize
    pos = nameEnd + buf.readUInt16LE(pos + 30) + buf.readUInt16LE(pos + 32)
    if (pos > end) throw new Error('Truncated ZIP central entry')
    const nameBytes = buf.subarray(nameStart, nameEnd)
    const name = decoder.decode(nameBytes)
    checkName(name, names)
    const isDirectory = name.endsWith('/') || mode === 0o040000 || !!(attributes & 0x10)
    if ((isDirectory && size) || (method === 0 && compressedSize !== size)) throw new Error('Invalid ZIP entry size')
    total += size
    checkSize(size, total, limits)

    if (local + LOCAL_BYTES > start || buf.readUInt32LE(local) !== LOCAL_HEADER ||
        buf.readUInt16LE(local + 6) !== flags || buf.readUInt16LE(local + 8) !== method ||
        buf.readUInt16LE(local + 26) !== nameSize) throw new Error('Invalid ZIP local header')
    const localName = local + LOCAL_BYTES
    const dataOffset = localName + nameSize + buf.readUInt16LE(local + 28)
    const dataEnd = dataOffset + compressedSize
    if (dataEnd > start || !buf.subarray(localName, localName + nameSize).equals(nameBytes)) {
      throw new Error('Invalid ZIP entry data offset or local name')
    }
    const entry: ZipEntry = { name, method, compressedSize, size, crc32: checksum, dataOffset, isDirectory }
    if (flags & HAS_DESCRIPTOR) {
      ranges.push({ start: local, end: descriptorEnd(buf, dataEnd, start, entry) })
    } else {
      if (buf.readUInt32LE(local + 14) !== checksum || buf.readUInt32LE(local + 18) !== compressedSize ||
          buf.readUInt32LE(local + 22) !== size) throw new Error('ZIP local and central sizes or CRC disagree')
      ranges.push({ start: local, end: dataEnd })
    }
    entries.push(entry)
  }
  if (pos !== end) throw new Error('Invalid ZIP directory size')
  ranges.sort((a, b) => a.start - b.start)
  if (ranges.some((range, i) => i > 0 && range.start < ranges[i - 1].end)) throw new Error('Overlapping ZIP entries')
  return entries
}

export function extractZipEntry(buf: Buffer, entry: ZipEntry, overrides?: Partial<ZipLimits>): Buffer {
  const limits = zipLimits(overrides)
  checkSize(entry.size, entry.size, limits)
  if (!Number.isSafeInteger(entry.dataOffset) || entry.dataOffset < 0 ||
      !Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0 ||
      entry.dataOffset + entry.compressedSize > buf.length) throw new Error('Invalid ZIP entry data range')
  if (entry.method !== 0 && entry.method !== 8) throw new Error('Unsupported ZIP compression method')
  if (entry.method === 0 && entry.compressedSize !== entry.size) throw new Error('Invalid ZIP entry size')
  const data = buf.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize)
  const decoded = entry.method === 8
    ? inflateRawSync(data, { maxOutputLength: Math.max(1, entry.size) })
    : Buffer.from(data)
  if (decoded.length !== entry.size || crc32(decoded) !== entry.crc32) throw new Error('ZIP entry size or CRC-32 mismatch')
  return decoded
}
