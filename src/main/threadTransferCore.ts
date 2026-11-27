import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, constants, fstatSync, openSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync
} from 'node:fs'
import { open, rename, rm, type FileHandle } from 'node:fs/promises'
import { setImmediate as yieldTurn } from 'node:timers/promises'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join } from 'node:path'
import type { AssistantMessage, Attachment, Message, OutputFileRef } from '@shared/chat'
import {
  deriveRelativePath, extractMarkdownImageTargets, findMatchingOutputFile, isPreviewableImagePath,
  joinPosixRelative, mimeTypeForPath, resolveMarkdownImagePath, toPosixPath
} from '@shared/fileResolve'
import {
  EXPORT_MAX_FILE_BYTES, LEGACY_BUNDLE_FORMAT, parseThreadBundle, TRANSFER_ARCHIVE_FORMAT, TRANSFER_SCHEMA_VERSION,
  type CommitImportRequest, type CommitImportResult, type ExportedThread, type ImportPreviewResult,
  type ThreadBundle, type TransferManifest, type TransferProgressEvent, type TransferProjectMeta, type TransferSkippedEntry
} from '@shared/transfer'
import { parseThread } from './chatStore'
import { attachmentStoragePath, ensureAttachmentStorage } from './attachmentStorage'
import { createOutputFilter } from './outputFilter'
import { assertSafeZipEntryPath, createZipBuffer, DEFAULT_ZIP_LIMITS, extractZipEntry, readZipEntries, safeJoinInside, zipArchiveChunks } from './zipArchive'

const PACKED_PATH = /^attachments\/([a-f0-9]{64})(?:\.[a-z0-9]{1,16})?$/
const MAX_ARCHIVE_BYTES = DEFAULT_ZIP_LIMITS.maxTotalBytes + 16 * 1024 * 1024
const hash = (data: Buffer): string => createHash('sha256').update(data).digest('hex')
const fileName = (path: string): string => toPosixPath(path).split('/').filter(Boolean).pop() || 'file'
const isDiskPath = (p: unknown): p is string => typeof p === 'string' && isAbsolute(p) && !p.includes('\0')
const isMissing = (error: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')

export interface ExportOptions {
  userData: string
  appVersion: string
  maxFileBytes?: number
  canReadFile?: (absolutePath: string) => boolean
}

export type TransferUpdate = Pick<TransferProgressEvent, 'phase' | 'current' | 'total' | 'percent' | 'message'>

export interface BatchOptions {
  batchSize?: number
  onProgress?: (progress: TransferUpdate) => void
}

export function reportProgress(opts: BatchOptions, phase: TransferUpdate['phase'], current: number, total: number): void {
  opts.onProgress?.({ phase, current, total, percent: total ? Math.floor(current * 100 / total) : 0 })
}

function batchSize(opts: BatchOptions): number {
  const size = opts.batchSize ?? 15
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('Invalid transfer batch size')
  return size
}

async function transformInBatches<T, R>(
  items: readonly T[], transform: (item: T) => R, opts: BatchOptions, phase: TransferUpdate['phase']
): Promise<R[]> {
  const size = batchSize(opts)
  const result: R[] = []
  reportProgress(opts, phase, 0, items.length)
  for (let start = 0; start < items.length; start += size) {
    await yieldTurn()
    for (const item of items.slice(start, start + size)) result.push(transform(item))
    reportProgress(opts, phase, result.length, items.length)
  }
  return result
}

type FileRead = { data: Buffer; path: string } | { reason: 'missing' | 'unreadable' | 'too-large'; size?: number }
type FileRef = Attachment | OutputFileRef

function writeAtomic(path: string, data: Buffer): void {
  const temp = path + '.' + randomUUID() + '.tmp'
  try {
    writeFileSync(temp, data, { flag: 'wx', mode: 0o600, flush: true })
    renameSync(temp, path)
  } catch (error) {
    try { rmSync(temp, { force: true }) } catch { /* Preserve the write error. */ }
    throw error
  }
}

function readAt(fd: number, size: number, position = 0): Buffer {
  const buf = Buffer.allocUnsafe(size)
  let offset = 0
  while (offset < size) {
    const count = readSync(fd, buf, offset, size - offset, position + offset)
    if (!count) break
    offset += count
  }
  return buf.subarray(0, offset)
}

function readAsset(path: string, max: number, canReadFile?: ExportOptions['canReadFile']): FileRead {
  try {
    const real = realpathSync(path)
    if (canReadFile && !canReadFile(real)) return { reason: 'unreadable' }
    const fd = openSync(real, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile()) return { reason: 'unreadable' }
      if (stat.size > max) return { reason: 'too-large', size: stat.size }
      const data = readAt(fd, stat.size + 1)
      if (data.length > max) return { reason: 'too-large', size: data.length }
      if (data.length !== stat.size) return { reason: 'unreadable' }
      return { data, path }
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    return { reason: isMissing(error) ? 'missing' : 'unreadable' }
  }
}

function firstAsset(paths: (string | null | undefined)[], max: number, canReadFile?: ExportOptions['canReadFile']): FileRead {
  let reason: 'missing' | 'unreadable' = 'missing'
  for (const path of new Set(paths)) {
    if (!isDiskPath(path)) continue
    const file = readAsset(path, max, canReadFile)
    if ('data' in file || file.reason === 'too-large') return file
    if (file.reason === 'unreadable') reason = file.reason
  }
  return { reason }
}

function validRelative(path: unknown): string | undefined {
  return typeof path === 'string' ? joinPosixRelative('/', path)?.slice(1) : undefined
}

function isInPaths(path: string, dirs: readonly (string | null)[]): boolean {
  return dirs.some((dir) => deriveRelativePath(path, dir) !== null)
}

function outputRefs(
  msg: AssistantMessage, project: string | null, origin: string | null, workdir: string | null,
  privateDirs: string[], withMarkdown: boolean
): OutputFileRef[] {
  const refs = new Map<string, OutputFileRef>()
  const add = (path: string, ref?: OutputFileRef, inlineOnly?: boolean) => {
    const projectPath = deriveRelativePath(path, project) ?? deriveRelativePath(path, origin)
    const appOutput = projectPath?.startsWith('.agentswitch/outputs/') ||
      deriveRelativePath(path, workdir)?.startsWith('.agentswitch/outputs/')
    const source = appOutput || isInPaths(path, privateDirs) ? 'chat-attachment'
      : ref?.source ?? (projectPath ? 'workspace-file' : 'chat-attachment')
    const relativePath = validRelative(ref?.relativePath) ?? projectPath ?? deriveRelativePath(path, workdir) ?? undefined
    refs.set(toPosixPath(path), {
      ...ref, path, source, relativePath, name: ref?.name || fileName(path), mimeType: ref?.mimeType || mimeTypeForPath(path),
      inlineOnly: inlineOnly || undefined
    })
  }
  const prior = new Map((msg.outputFiles ?? []).map((ref) => [toPosixPath(ref.path), ref]))
  for (const path of msg.outputs) {
    if (typeof path === 'string' && path) add(path, prior.get(toPosixPath(path)))
  }
  for (const [key, ref] of prior) {
    if (!refs.has(key)) add(ref.path, ref, ref.inlineOnly)
  }
  if (withMarkdown) {
    for (const target of extractMarkdownImageTargets(msg.content)) {
      const path = resolveMarkdownImagePath(target, workdir ?? project, homedir())
      if (path && isPreviewableImagePath(path) && !findMatchingOutputFile(target, workdir ?? project, homedir(), [...refs.values()], origin)) {
        add(path, undefined, true)
      }
    }
  }
  return [...refs.values()]
}

function originalProject(item: ExportedThread): TransferProjectMeta {
  return {
    name: item.thread.sourceProjectName ?? item.projectName,
    sourceProjectDir: item.thread.sourceProjectDir ?? item.sourceProjectDir
  }
}

function validAttachment(value: Attachment | null): value is Attachment {
  return typeof value?.name === 'string'
}

function runAttachmentPath(workdir: string | null, msg: Message, attachment: Attachment): string | null {
  if (!workdir) return null
  const turnId = typeof msg.turnId === 'string' ? msg.turnId.replace(/[^\w-]/g, '') : ''
  const name = fileName(attachment.name)
  if (!turnId || name === '.' || name === '..' || name.includes('\0')) return null
  return join(workdir, '.agentswitch', 'runs', turnId, 'attachments', name)
}

function withoutAssetPaths<T extends FileRef>(ref: T): T {
  return { ...ref, bundlePath: undefined, fallbackPath: undefined }
}

function prepareExport(bundle: ThreadBundle, opts: ExportOptions) {
  if (bundle?.format !== LEGACY_BUNDLE_FORMAT || ![1, TRANSFER_SCHEMA_VERSION].includes(bundle.version) ||
      !Array.isArray(bundle.threads)) throw new Error('Invalid thread bundle')
  const max = opts.maxFileBytes ?? EXPORT_MAX_FILE_BYTES
  if (!Number.isSafeInteger(max) || max < 0 || max > DEFAULT_ZIP_LIMITS.maxFileBytes) throw new Error('Invalid attachment size limit')
  const packed = new Map<string, { data: Buffer; extension: string; refs: FileRef[] }>()
  const skipped: TransferSkippedEntry[] = []
  const projects = new Map<string, TransferProjectMeta>()
  let total = 0
  const pack = (ref: FileRef, paths: (string | null | undefined)[], threadId: string, messageId: string): void => {
    const file = firstAsset(paths, max, opts.canReadFile)
    if (!('data' in file)) {
      ref.skippedReason = file.reason
      if (file.size !== undefined) ref.size = file.size
      skipped.push({ threadId, messageId, name: ref.name, path: ref.path, reason: file.reason })
      return
    }
    ref.size = file.data.length
    ref.skippedReason = undefined
    const digest = hash(file.data)
    const ext = extname(file.path).toLowerCase()
    const nameExt = extname(ref.name).toLowerCase()
    const suffixes = [ext, nameExt].filter((value) => /^\.[a-z0-9]{1,16}$/.test(value))
    const extension = suffixes.find((suffix) => isPreviewableImagePath('file' + suffix)) ?? suffixes[0] ?? ''
    if (!ref.mimeType || ref.mimeType === 'application/octet-stream') ref.mimeType = mimeTypeForPath('file' + extension)
    const existing = packed.get(digest)
    if (existing) {
      // One byte-identical entry serves all references. Keep a previewable suffix when one is known.
      if (isPreviewableImagePath('file' + extension) && !isPreviewableImagePath('file' + existing.extension)) existing.extension = extension
      existing.refs.push(ref)
      return
    }
    total += file.data.length
    if (packed.size + 2 >= DEFAULT_ZIP_LIMITS.maxEntries || total > DEFAULT_ZIP_LIMITS.maxTotalBytes) {
      throw new Error('Thread archive exceeds attachment limits')
    }
    packed.set(digest, { data: file.data, extension, refs: [ref] })
  }

  const privateDir = join(opts.userData, 'workspaces')
  const privateDirs = [privateDir, attachmentStoragePath(opts.userData)]
  const prepareThread = (item: ExportedThread): ExportedThread => {
    const thread = parseThread(item.thread)
    const meta = originalProject({ ...item, thread })
    projects.set(JSON.stringify([meta.name, meta.sourceProjectDir]), meta)
    const project = thread.projectDir
    const privateWorkdir = join(privateDir, thread.id.replace(/[^\w-]/g, ''))
    const workdir = item.sourceWorkdir ?? thread.workdir ?? project ?? privateWorkdir
    const filterRoot = project ?? workdir
    const filter = createOutputFilter(filterRoot, { allowDirs: [join(filterRoot, '.agentswitch', 'outputs')] })
    const messages = thread.messages.map((msg): Message => {
      if (msg.role === 'user') {
        const attachments = msg.attachments.filter(validAttachment).map((a): Attachment => {
          const path = typeof a.path === 'string' ? a.path : null
          const ref = withoutAssetPaths({
            ...a, path, source: a.source === 'workspace-file' ? 'workspace-file' : 'chat-attachment',
            relativePath: validRelative(a.relativePath) ?? deriveRelativePath(path ?? '', project) ?? undefined,
            mimeType: typeof a.mimeType === 'string' ? a.mimeType : mimeTypeForPath(a.name)
          } satisfies Attachment)
          pack(ref, [a.path, a.fallbackPath, runAttachmentPath(workdir, msg, a)], thread.id, msg.id)
          return ref
        })
        return { ...msg, attachments }
      }
      if (msg.role !== 'assistant') return msg
      const refs = outputRefs(msg, project, meta.sourceProjectDir, workdir, privateDirs, true)
      const outputFiles = refs.flatMap((ref) => {
        const mapped = ref.source === 'workspace-file' && project && ref.relativePath
          ? joinPosixRelative(project, ref.relativePath) : null
        const filterPath = mapped ?? ref.path
        if (isInPaths(filterPath, [filterRoot]) && filter.shouldIgnoreFile(filterPath)) return []
        const clean = withoutAssetPaths(ref)
        if (ref.source === 'chat-attachment' || isPreviewableImagePath(ref.name) || isPreviewableImagePath(ref.path)) {
          pack(clean, [mapped ?? ref.path, ref.fallbackPath], thread.id, msg.id)
        }
        return [clean]
      })
      return { ...msg, outputs: outputFiles.filter((file) => !file.inlineOnly).map((file) => file.path), outputFiles }
    })
    return { ...item, thread: { ...thread, messages }, projectName: meta.name, sourceProjectDir: meta.sourceProjectDir, sourceWorkdir: workdir }
  }

  function finalize(threads: ExportedThread[]) {
    const files = [...packed].map(([digest, file]) => {
      const name = 'attachments/' + digest + file.extension
      for (const ref of file.refs) ref.bundlePath = name
      return { name, data: file.data }
    })
    const manifest: TransferManifest = {
      format: TRANSFER_ARCHIVE_FORMAT, schemaVersion: TRANSFER_SCHEMA_VERSION,
      exportedAt: bundle.exportedAt, appVersion: opts.appVersion, projects: [...projects.values()],
      attachments: { packedCount: files.length, skippedCount: skipped.length, skipped }
    }
    const data: ThreadBundle = { ...bundle, version: TRANSFER_SCHEMA_VERSION, threads }
    return {
      manifest,
      entries: [
        { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
        { name: 'data.json', data: Buffer.from(JSON.stringify(data)) },
        ...files
      ]
    }
  }

  return { prepareThread, finalize }
}

export function exportThreadsArchive(bundle: ThreadBundle, destPath: string, opts: ExportOptions): TransferManifest {
  const { prepareThread, finalize } = prepareExport(bundle, opts)
  const { manifest, entries } = finalize(bundle.threads.map(prepareThread))
  writeAtomic(destPath, createZipBuffer(entries))
  return manifest
}

export async function exportThreadsArchiveAsync(
  bundle: ThreadBundle, destPath: string, opts: ExportOptions & BatchOptions & { tempSuffix?: string }
): Promise<TransferManifest> {
  reportProgress(opts, 'preparing', 0, bundle?.threads?.length ?? 0)
  await yieldTurn()
  const { prepareThread, finalize } = prepareExport(bundle, opts)
  const threads = await transformInBatches(bundle.threads, prepareThread, opts, 'processing')
  reportProgress(opts, 'finalizing', threads.length, threads.length)
  await yieldTurn()
  const { manifest, entries } = finalize(threads)
  const temp = destPath + '.' + (opts.tempSuffix ?? randomUUID()) + '.tmp'
  const file = await open(temp, 'wx', 0o600)
  try {
    try {
      for (const chunk of zipArchiveChunks(entries)) {
        let offset = 0
        while (offset < chunk.length) {
          const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset)
          if (!bytesWritten) throw new Error('Could not write thread archive')
          offset += bytesWritten
        }
      }
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temp, destPath)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
  return manifest
}

function parseManifest(raw: Buffer): TransferManifest {
  const manifest = JSON.parse(raw.toString('utf8')) as Partial<TransferManifest> | null
  const stats = manifest?.attachments
  if (manifest?.format !== TRANSFER_ARCHIVE_FORMAT || manifest.schemaVersion !== TRANSFER_SCHEMA_VERSION ||
      !Number.isFinite(manifest.exportedAt) || typeof manifest.appVersion !== 'string' ||
      !Array.isArray(manifest.projects) || !stats || !Number.isSafeInteger(stats.packedCount) || stats.packedCount < 0 ||
      !Array.isArray(stats.skipped) || stats.skipped.length !== stats.skippedCount) throw new Error('Invalid thread archive manifest')
  return manifest as TransferManifest
}

const parseImportBundle = (raw: Buffer): ThreadBundle =>
  parseThreadBundle(raw.toString('utf8').replace(/^\uFEFF/, ''))

const parseImportedThread = (item: ExportedThread): ExportedThread => ({ ...item, thread: parseThread(item.thread) })

function isZip(filePath: string, header: Buffer): boolean {
  return extname(filePath).toLowerCase() === '.zip' ||
    (header.length === 4 && [0x04034b50, 0x06054b50, 0x08074b50].includes(header.readUInt32LE(0)))
}

function validateImportSize(stat: { size: number; isFile(): boolean }, zip: boolean): void {
  if (!stat.isFile()) throw new Error('Invalid import file')
  if (stat.size > (zip ? MAX_ARCHIVE_BYTES : DEFAULT_ZIP_LIMITS.maxFileBytes)) throw new Error('Import file exceeds size limit')
}

function readImport(filePath: string) {
  const fd = openSync(filePath, constants.O_RDONLY | constants.O_NONBLOCK)
  let bytes: Buffer
  let zip: boolean
  try {
    const stat = fstatSync(fd)
    validateImportSize(stat, true)
    zip = isZip(filePath, readAt(fd, 4))
    validateImportSize(stat, zip)
    bytes = readAt(fd, stat.size + 1)
    if (bytes.length !== stat.size) throw new Error('Import file changed while reading')
  } finally {
    closeSync(fd)
  }

  const result = decodeImport(filePath, bytes, zip)
  result.preview.bundle.threads = result.preview.bundle.threads.map(parseImportedThread)
  return result
}

async function readAtAsync(file: FileHandle, size: number): Promise<Buffer> {
  const buf = Buffer.allocUnsafe(size)
  let offset = 0
  while (offset < size) {
    const { bytesRead } = await file.read(buf, offset, size - offset, offset)
    if (!bytesRead) break
    offset += bytesRead
  }
  return buf.subarray(0, offset)
}

async function readImportAsync(filePath: string, opts: BatchOptions) {
  reportProgress(opts, 'validating', 0, 0)
  await yieldTurn()
  const file = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK)
  let bytes: Buffer
  let zip: boolean
  try {
    const stat = await file.stat()
    validateImportSize(stat, true)
    zip = isZip(filePath, await readAtAsync(file, 4))
    validateImportSize(stat, zip)
    bytes = await readAtAsync(file, stat.size + 1)
    if (bytes.length !== stat.size) throw new Error('Import file changed while reading')
  } finally {
    await file.close()
  }
  const result = decodeImport(filePath, bytes, zip)
  result.preview.bundle.threads = await transformInBatches(result.preview.bundle.threads, parseImportedThread, opts, 'validating')
  return result
}

function decodeImport(filePath: string, bytes: Buffer, zip: boolean) {
  if (!zip) {
    const bundle = parseImportBundle(bytes)
    return { preview: { filePath, kind: 'json', manifest: null, bundle } satisfies ImportPreviewResult, archive: null }
  }
  const entries = new Map(readZipEntries(bytes).map((entry) => [entry.name, entry]))
  const extract = (name: string): Buffer => {
    const entry = entries.get(name)
    if (!entry || entry.isDirectory) throw new Error('Missing archive file: ' + name)
    return extractZipEntry(bytes, entry)
  }
  const manifest = parseManifest(extract('manifest.json'))
  const bundle = parseImportBundle(extract('data.json'))
  if (bundle.version !== TRANSFER_SCHEMA_VERSION) throw new Error('Invalid thread archive data version')
  return { preview: { filePath, kind: 'zip', manifest, bundle } satisfies ImportPreviewResult, archive: { extract } }
}

export function inspectThreadsImport(filePath: string): ImportPreviewResult {
  return readImport(filePath).preview
}

export async function inspectThreadsImportAsync(filePath: string, opts: BatchOptions = {}): Promise<ImportPreviewResult> {
  return (await readImportAsync(filePath, opts)).preview
}

function validProjects(projectMap: CommitImportRequest['projectMap']): Map<string, string> {
  const projects = new Map<string, string>()
  for (const [name, path] of Object.entries(projectMap)) {
    if (!isDiskPath(path)) continue
    try {
      if (statSync(path).isDirectory()) projects.set(name, path)
    } catch { /* A mapping may have gone offline since preview. */ }
  }
  return projects
}

interface ImportOptions {
  userData: string
  allowRoot?: (path: string) => void
}

function prepareImport(req: CommitImportRequest, opts: ImportOptions, { preview, archive }: ReturnType<typeof decodeImport>) {
  const selected = new Set(req.selectedThreadIds)
  const projects = validProjects(req.projectMap)
  const dest = ensureAttachmentStorage(opts.userData)
  const written = new Map<string, string>()
  const unpack = (bundlePath: string | undefined): string | undefined => {
    if (!archive || bundlePath === undefined) return undefined
    if (typeof bundlePath !== 'string') throw new Error('Invalid bundled attachment path')
    assertSafeZipEntryPath(bundlePath)
    const match = PACKED_PATH.exec(bundlePath)
    if (!match) throw new Error('Invalid bundled attachment path')
    const prior = written.get(bundlePath)
    if (prior) return prior
    const target = safeJoinInside(dest, basename(bundlePath))
    const data = archive.extract(bundlePath)
    if (hash(data) !== match[1]) throw new Error('Bundled attachment SHA-256 does not match its name')
    const existing = readAsset(target, data.length)
    if (!('data' in existing) || hash(existing.data) !== match[1]) writeAtomic(target, data)
    written.set(bundlePath, target)
    return target
  }

  const unpackThread = (item: ExportedThread): ExportedThread => {
    const thread = item.thread
    const meta = originalProject(item)
    const mapped = item.projectName ? projects.get(item.projectName) ?? null : null
    const workdir = item.sourceWorkdir ?? thread.workdir ?? meta.sourceProjectDir
    const messages = thread.messages.map((msg): Message => {
      if (msg.role === 'user') {
        return { ...msg, attachments: msg.attachments.filter(validAttachment).map((attachment): Attachment => {
          const ref = withoutAssetPaths(attachment)
          const asset = unpack(attachment.bundlePath)
          const source = ref.source === 'workspace-file' ? ref.source : 'chat-attachment'
          const original = typeof ref.path === 'string' ? ref.path : null
          const relativePath = validRelative(ref.relativePath) ?? deriveRelativePath(original ?? '', meta.sourceProjectDir) ?? undefined
          const local = mapped && relativePath ? joinPosixRelative(mapped, relativePath) : null
          if (source === 'workspace-file') return { ...ref, source, relativePath, path: local ?? original, fallbackPath: asset }
          return { ...ref, source, relativePath, path: asset ?? original }
        }) }
      }
      if (msg.role !== 'assistant') return msg
      const outputFiles = outputRefs(msg, thread.projectDir, meta.sourceProjectDir, workdir, [], msg.outputFiles === undefined).map((file): OutputFileRef => {
        const ref = withoutAssetPaths(file)
        const asset = unpack(file.bundlePath)
        const local = mapped && ref.relativePath ? joinPosixRelative(mapped, ref.relativePath) : null
        const path = (ref.source === 'workspace-file' ? local : asset) ?? ref.path
        return {
          ...ref, path, sourcePath: ref.sourcePath ?? (path === ref.path ? undefined : ref.path),
          fallbackPath: ref.source === 'workspace-file' ? asset : undefined
        }
      })
      return { ...msg, outputs: outputFiles.filter((file) => !file.inlineOnly).map((file) => file.path), outputFiles }
    })
    return {
      ...item,
      thread: { ...thread, projectDir: mapped, workdir: null, sourceProjectDir: meta.sourceProjectDir, sourceProjectName: meta.name, messages }
    }
  }
  const items = preview.bundle.threads.filter((item) => selected.has(item.thread.id))
  const roots = [dest, ...new Set(projects.values())]
  return { items, unpackThread, roots }
}

export function commitThreadsImport(req: CommitImportRequest, opts: ImportOptions): CommitImportResult {
  const { items, unpackThread, roots } = prepareImport(req, opts, readImport(req.filePath))
  const threads = items.map(unpackThread)
  for (const path of roots) opts.allowRoot?.(path)
  return { threads }
}

export async function commitThreadsImportAsync(
  req: CommitImportRequest, opts: ImportOptions & BatchOptions
): Promise<CommitImportResult> {
  const { items, unpackThread, roots } = prepareImport(req, opts, await readImportAsync(req.filePath, opts))
  const threads = await transformInBatches(items, unpackThread, opts, 'importing')
  reportProgress(opts, 'refreshing', threads.length, threads.length)
  await yieldTurn()
  for (const path of roots) opts.allowRoot?.(path)
  return { threads }
}
