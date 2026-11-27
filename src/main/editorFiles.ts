import { randomBytes } from 'node:crypto'
import { constants, lstatSync, watch, type FSWatcher, type Stats } from 'node:fs'
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import {
  EDITOR_MAX_BYTES,
  detectEditorLanguage,
  isKnownBinaryPath,
  type EditorActionResult,
  type EditorEol,
  type EditorErrorCode,
  type EditorFileChangedEvent,
  type EditorReadRequest,
  type EditorReadResult,
  type EditorSaveRequest,
  type EditorSaveResult
} from '@shared/editor'
import { isAllowedPath } from './fileProtocol'

type PathCheck = (realPath: string) => boolean
type EditorFailure = Extract<EditorActionResult, { ok: false }> & { size?: number }
type AuthorizedPath = { ok: true; realPath: string } | EditorFailure
type EditorFileOptions = {
  isExtraAllowed?: PathCheck
  isWorkspaceAllowed?: PathCheck
  watcher?: EditorFileWatcher
}

const failure = (code: EditorErrorCode, message: string): EditorFailure => ({ ok: false, code, message })
const outside = (): EditorFailure => failure('OUT_OF_BOUNDS', 'File is outside the authorized workspace')
const notFile = (): EditorFailure => failure('NOT_A_FILE', 'Path is not a regular file')
const tooLarge = (): EditorFailure => failure('FILE_TOO_LARGE', 'File exceeds the editor size limit')
const binary = (): EditorFailure => failure('BINARY_FILE', 'File is binary')

class EditorFileError extends Error {
  constructor(readonly result: EditorFailure) {
    super(result.message)
  }
}

function fileError(error: unknown): EditorFailure {
  if (error instanceof EditorFileError) return error.result
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') return failure('NOT_FOUND', 'File does not exist')
  if (code === 'ELOOP') return outside()
  return failure('IO_ERROR', 'File operation failed')
}

function absolutePath(value: unknown): value is string {
  return typeof value === 'string' && isAbsolute(value) && !value.includes('\0')
}

export async function resolveAuthorizedEditorPath(
  targetPath: string,
  workspaceDir?: string | null,
  isExtraAllowed: PathCheck = isAllowedPath,
  isWorkspaceAllowed?: PathCheck
): Promise<AuthorizedPath> {
  if (!absolutePath(targetPath)) return outside()
  try {
    const realPath = await realpath(targetPath)
    if (absolutePath(workspaceDir)) {
      const root = await realpath(workspaceDir).catch(() => null)
      if (root && (!isWorkspaceAllowed || isWorkspaceAllowed(root))) {
        const rel = relative(root, realPath)
        if (rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)) {
          return { ok: true, realPath }
        }
      }
    }
    return isExtraAllowed(realPath) ? { ok: true, realPath } : outside()
  } catch (error) {
    return fileError(error)
  }
}

async function statCanonicalFile(realPath: string): Promise<Stats> {
  const st = await lstat(realPath)
  if (st.isSymbolicLink() || await realpath(realPath) !== realPath) throw new EditorFileError(outside())
  if (!st.isFile()) throw new EditorFileError(notFile())
  return st
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

function sameVersion(a: Stats, b: Stats): boolean {
  return sameFile(a, b) && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.size === b.size
}

const BINARY_PROBE_BYTES = 8 * 1024
const eolOf = (text: string): EditorEol => text.includes('\r\n') ? 'CRLF' : 'LF'

async function readTextFile(realPath: string): Promise<{ text: string; st: Stats }> {
  const original = await statCanonicalFile(realPath)
  if (original.size > EDITOR_MAX_BYTES) throw new EditorFileError({ ...tooLarge(), size: original.size })
  if (isKnownBinaryPath(realPath)) throw new EditorFileError(binary())

  const file = await open(realPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const st = await file.stat()
    if (!sameFile(st, original) || await realpath(realPath) !== realPath) throw new EditorFileError(outside())
    if (st.size > EDITOR_MAX_BYTES) throw new EditorFileError({ ...tooLarge(), size: st.size })
    // Read at most the snapshot size plus one byte to catch growth without an unbounded allocation.
    const buf = Buffer.allocUnsafe(st.size + 1)
    let size = 0
    while (size < buf.length) {
      const { bytesRead } = await file.read(buf, size, buf.length - size, size)
      if (!bytesRead) break
      size += bytesRead
    }
    const after = await file.stat()
    if (after.size > EDITOR_MAX_BYTES) throw new EditorFileError({ ...tooLarge(), size: after.size })
    if (size !== st.size || !sameVersion(st, after)) {
      throw new EditorFileError(failure('IO_ERROR', 'File changed while reading'))
    }
    if (buf.subarray(0, Math.min(size, BINARY_PROBE_BYTES)).includes(0)) throw new EditorFileError(binary())
    return { text: buf.toString('utf8', 0, size), st }
  } finally {
    await file.close()
  }
}

export async function readEditorFile(req: EditorReadRequest, opts: EditorFileOptions = {}): Promise<EditorReadResult> {
  const resolved = await resolveAuthorizedEditorPath(req?.path, req?.workspaceDir, opts.isExtraAllowed, opts.isWorkspaceAllowed)
  if (!resolved.ok) return resolved
  const { realPath } = resolved
  try {
    const { text, st } = await readTextFile(realPath)
    return {
      ok: true, path: req.path, realPath, content: text.replace(/\r\n/g, '\n'),
      mtimeMs: st.mtimeMs, size: st.size, eol: eolOf(text), language: detectEditorLanguage(realPath)
    }
  } catch (error) {
    const result = fileError(error)
    return result.code === 'FILE_TOO_LARGE' || result.code === 'BINARY_FILE' ? { ...result, realPath } : result
  }
}

const activeSaves = new Map<string, Promise<void>>()
const MTIME_TOLERANCE_MS = 0.5
const conflict = (st: Stats): EditorSaveResult => ({
  ...failure('CONFLICT', 'File modified on disk'), currentMtimeMs: st.mtimeMs
})

export async function saveEditorFile(req: EditorSaveRequest, opts: EditorFileOptions = {}): Promise<EditorSaveResult> {
  const resolved = await resolveAuthorizedEditorPath(req?.path, req?.workspaceDir, opts.isExtraAllowed, opts.isWorkspaceAllowed)
  if (!resolved.ok) return resolved
  if (typeof req.content !== 'string' || (req.force !== true && !Number.isFinite(req.expectedMtimeMs))) {
    return failure('IO_ERROR', 'Invalid editor save request')
  }

  const { realPath } = resolved
  const pending = activeSaves.get(realPath)
  let release!: () => void
  const done = new Promise<void>((resolve) => { release = resolve })
  activeSaves.set(realPath, done)
  await pending

  let tempPath: string | undefined
  try {
    const { text, st } = await readTextFile(realPath)
    if (req.force !== true && Math.abs(st.mtimeMs - req.expectedMtimeMs) > MTIME_TOLERANCE_MS) return conflict(st)

    const normalized = req.content.replace(/\r\n/g, '\n')
    const content = (req.eol ?? eolOf(text)) === 'CRLF' ? normalized.replace(/\n/g, '\r\n') : normalized
    if (Buffer.byteLength(content) > EDITOR_MAX_BYTES) return tooLarge()
    const bytes = Buffer.from(content)
    if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) return binary()

    const temp = join(dirname(realPath), `.agentswitch-edit-${process.pid}-${randomBytes(6).toString('hex')}.tmp`)
    const mode = st.mode & 0o7777
    const file = await open(temp, 'wx', mode)
    tempPath = temp
    let saved: Stats
    try {
      await file.writeFile(bytes)
      await file.chmod(mode)
      saved = await file.stat()
      // Keep even rapid consecutive saves distinguishable within the conflict tolerance.
      if (Math.abs(saved.mtimeMs - st.mtimeMs) <= MTIME_TOLERANCE_MS) {
        await file.utimes(saved.atime, new Date(Math.ceil(st.mtimeMs) + 1))
        saved = await file.stat()
      }
    } finally {
      await file.close()
    }

    // Recheck after the temporary write, which can overlap an AI or external editor's save.
    const current = await statCanonicalFile(realPath)
    if (!sameVersion(st, current)) return conflict(current)
    await rename(temp, realPath)
    tempPath = undefined
    opts.watcher?.markSelfWrite(realPath, saved.mtimeMs)
    const after = await lstat(realPath).catch(() => null)
    // An external edit after rename must keep its own event and conflict baseline.
    const result = after && sameFile(saved, after) && after.mtimeMs === saved.mtimeMs ? after : saved
    return { ok: true, mtimeMs: result.mtimeMs, size: result.size }
  } catch (error) {
    return fileError(error)
  } finally {
    if (tempPath) await unlink(tempPath).catch(() => {})
    release()
    if (activeSaves.get(realPath) === done) activeSaves.delete(realPath)
  }
}

type WatchedFile = {
  realPath: string
  watcher: FSWatcher
  lastStat: Stats | null
  timer?: NodeJS.Timeout
  recentSelfWrite?: { mtimeMs: number; expiresAt: number }
}

const WATCH_DEBOUNCE_MS = 150
const SELF_WRITE_TTL_MS = 1000

export class EditorFileWatcher {
  private readonly watched = new Map<string, WatchedFile>()

  constructor(private readonly onChange: (event: EditorFileChangedEvent) => void) {}

  watch(path: string, realPath: string): EditorActionResult {
    if (this.watched.get(path)?.realPath === realPath) return { ok: true }
    this.unwatch(path)
    try {
      const lastStat = lstatSync(realPath)
      if (!lastStat.isFile()) return notFile()
      // Watch the parent so atomic saves and delete/recreate cycles keep the subscription alive.
      const name = basename(realPath)
      const watcher = watch(dirname(realPath), { persistent: false }, (_event, filename) => {
        if ((filename !== null && filename !== name) || this.watched.get(path) !== entry) return
        clearTimeout(entry.timer)
        entry.timer = setTimeout(() => {
          entry.timer = undefined
          void this.check(path, entry)
        }, WATCH_DEBOUNCE_MS)
      })
      const entry: WatchedFile = { realPath, watcher, lastStat }
      watcher.on('error', () => {
        if (this.watched.get(path) === entry) this.unwatch(path)
      })
      this.watched.set(path, entry)
      return { ok: true }
    } catch (error) {
      return fileError(error)
    }
  }

  unwatch(path: string): void {
    const entry = this.watched.get(path)
    if (!entry) return
    this.watched.delete(path)
    clearTimeout(entry.timer)
    entry.watcher.close()
  }

  unwatchAll(): void {
    for (const path of this.watched.keys()) this.unwatch(path)
  }

  markSelfWrite(realPath: string, mtimeMs: number): void {
    const expiresAt = Date.now() + SELF_WRITE_TTL_MS
    for (const entry of this.watched.values()) {
      if (entry.realPath === realPath) entry.recentSelfWrite = { mtimeMs, expiresAt }
    }
  }

  private async check(path: string, entry: WatchedFile): Promise<void> {
    const { realPath } = entry
    let st: Stats
    try {
      st = await statCanonicalFile(realPath)
    } catch (error) {
      const { code } = fileError(error)
      if (this.watched.get(path) === entry && entry.lastStat &&
          (code === 'NOT_FOUND' || code === 'NOT_A_FILE' || code === 'OUT_OF_BOUNDS')) {
        entry.lastStat = null
        entry.recentSelfWrite = undefined
        this.onChange({ path, realPath, mtimeMs: 0, size: 0, deleted: true })
      }
      return
    }
    if (this.watched.get(path) !== entry) return
    if (entry.lastStat && sameVersion(entry.lastStat, st)) return
    entry.lastStat = st
    const self = entry.recentSelfWrite
    if (self && self.expiresAt > Date.now() && self.mtimeMs === st.mtimeMs) return
    entry.recentSelfWrite = undefined
    this.onChange({ path, realPath, mtimeMs: st.mtimeMs, size: st.size })
  }
}
