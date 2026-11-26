import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertSafeZipEntryPath, createZipBuffer, extractZipEntry, readZipEntries, safeJoinInside } from './zipArchive'

function single(name = 'data.json', data = Buffer.from('123456789')) {
  const buf = createZipBuffer([{ name, data }])
  const end = buf.length - 22
  return { buf, end, central: buf.readUInt32LE(end + 16) }
}

describe('ZIP archive codec', () => {
  it('round-trips UTF-8 names, empty entries, Store and Deflate with standard CRC-32', () => {
    const originals = [
      { name: 'manifest.json', data: Buffer.from('{}') },
      { name: 'attachments/', data: Buffer.alloc(0) },
      { name: 'attachments/截图.PNG', data: Buffer.from('123456789') },
      { name: 'attachments/插图.svg', data: Buffer.from('<svg/>') },
      { name: 'empty.txt', data: Buffer.alloc(0) }
    ]
    const buf = createZipBuffer(originals)
    const entries = readZipEntries(buf)
    expect(buf.readUInt32LE(0)).toBe(0x04034b50)
    expect(buf.readUInt16LE(6)).toBe(0x0800)
    expect(entries.map((entry) => entry.name)).toEqual(originals.map((file) => file.name))
    expect(entries.map((entry) => entry.method)).toEqual([8, 0, 0, 8, 8])
    expect(entries[1].isDirectory).toBe(true)
    expect(entries[2].crc32).toBe(0xcbf43926)
    expect(entries.map((entry) => extractZipEntry(buf, entry))).toEqual(originals.map((file) => file.data))
    expect(readZipEntries(createZipBuffer([]))).toEqual([])
  })

  it('supports data descriptors and EOCD comments in streaming ZIPs', () => {
    const { buf, end, central } = single()
    const [entry] = readZipEntries(buf)
    buf.writeUInt16LE(0x0808, 6)
    buf.fill(0, 14, 26)
    buf.writeUInt16LE(0x0808, central + 8)
    const comment = Buffer.from('archive comment')
    buf.writeUInt16LE(comment.length, end + 20)
    const descriptor = Buffer.alloc(16)
    descriptor.writeUInt32LE(0x08074b50, 0)
    descriptor.writeUInt32LE(entry.crc32, 4)
    descriptor.writeUInt32LE(entry.compressedSize, 8)
    descriptor.writeUInt32LE(entry.size, 12)

    for (const bytes of [descriptor, descriptor.subarray(4)]) {
      const zip = Buffer.concat([buf.subarray(0, central), bytes, buf.subarray(central), comment])
      zip.writeUInt32LE(central + bytes.length, end + bytes.length + 16)
      expect(extractZipEntry(zip, readZipEntries(zip)[0]).toString()).toBe('123456789')
    }
  })

  it('rejects corrupt payloads and metadata before returning file data', () => {
    const stored = single('data.png')
    const [entry] = readZipEntries(stored.buf)
    stored.buf[entry.dataOffset] ^= 1
    expect(() => extractZipEntry(stored.buf, entry)).toThrow(/CRC-32/)
    const wrongName = single()
    wrongName.buf[30] = 0x78
    expect(() => readZipEntries(wrongName.buf)).toThrow(/local name/)
    const unsupported = single()
    unsupported.buf.writeUInt16LE(1, unsupported.central + 8)
    expect(() => readZipEntries(unsupported.buf)).toThrow(/flags/)
    const truncated = single().buf.subarray(0, -4)
    expect(() => readZipEntries(truncated)).toThrow(/directory/)
    expect(() => readZipEntries(Buffer.alloc(0))).toThrow(/directory/)
  })

  it('enforces per-file, aggregate and count limits before extraction and bounds inflated output', () => {
    const { buf, central } = single('large.json', Buffer.alloc(8192, 0x41))
    expect(() => readZipEntries(buf, { maxFileBytes: 8191 })).toThrow(/file size limit/)
    expect(() => readZipEntries(buf, { maxEntries: 0 })).toThrow(/entry limit/)
    expect(() => extractZipEntry(buf, readZipEntries(buf)[0], { maxTotalBytes: 4 })).toThrow(/total size limit/)
    const twoFiles = createZipBuffer(['a', 'b'].map((name) => ({ name, data: Buffer.alloc(10) })))
    expect(() => readZipEntries(twoFiles, { maxTotalBytes: 15 })).toThrow(/total size limit/)
    expect(readZipEntries(twoFiles, { maxFileBytes: 10, maxTotalBytes: 20, maxEntries: 2 })).toHaveLength(2)

    buf.writeUInt32LE(64 * 1024 * 1024 + 1, central + 24)
    expect(() => readZipEntries(buf)).toThrow(/file size limit/)
    buf.writeUInt32LE(1, central + 24)
    buf.writeUInt32LE(1, 22)
    expect(() => extractZipEntry(buf, readZipEntries(buf)[0])).toThrow()
  })
})

describe('safe ZIP paths', () => {
  it('rejects traversal, absolute paths, Windows aliases, and malformed path segments', () => {
    for (const path of ['../file', 'attachments/../data', '/absolute', 'C:relative', 'C:/absolute',
      '\\\\server\\share\\file', 'safe\\..\\file', 'safe/file\0', 'safe//file', 'safe/./file', 'safe/.. /file',
      'safe/a:stream', 'safe/NUL.txt', '', '/']) {
      expect(() => assertSafeZipEntryPath(path)).toThrow(/Unsafe ZIP entry path/)
    }
    expect(() => assertSafeZipEntryPath('attachments/图.svg')).not.toThrow()
  })

  it('rejects traversal or symlink metadata during directory inspection', () => {
    const { buf, central } = single('aa/file')
    buf.write('..', 30, 'ascii')
    buf.write('..', central + 46, 'ascii')
    expect(() => readZipEntries(buf)).toThrow(/Unsafe ZIP entry path/)

    const link = single('link')
    link.buf.writeUInt32LE((0o120777 << 16) >>> 0, link.central + 38)
    expect(() => readZipEntries(link.buf)).toThrow(/symlink/)
    expect(() => createZipBuffer(['a', 'a'].map((name) => ({ name, data: Buffer.alloc(0) })))).toThrow(/Duplicate/)
  })

  it('keeps destinations inside the root and rejects existing symlink components', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agentswitch-zip-'))
    try {
      const root = join(tmp, 'destination')
      const outside = join(tmp, 'outside')
      mkdirSync(root)
      mkdirSync(outside)
      symlinkSync(outside, join(root, 'link'), 'dir')
      expect(safeJoinInside(root, 'new/file.txt')).toBe(join(root, 'new', 'file.txt'))
      expect(() => safeJoinInside(root, '../outside/file.txt')).toThrow()
      expect(() => safeJoinInside(root, 'link/file.txt')).toThrow(/Unsafe existing/)
      expect(() => safeJoinInside(root, 'link')).toThrow(/Unsafe existing/)
      expect(() => safeJoinInside(join(root, 'link'), 'file.txt')).toThrow(/Unsafe existing/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
