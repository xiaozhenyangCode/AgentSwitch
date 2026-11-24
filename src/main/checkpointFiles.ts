import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, readlink, rename, rm, rmdir, symlink, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { LEGACY_PROJECT_DIR } from './legacy'

export const SNAPSHOT_MAX_FILES = 20_000
export const CHECKPOINT_MAX_BYTES = 20 * 1024 * 1024
export const SKIP_DIRS = new Set(['.git', 'node_modules', '.agentswitch', LEGACY_PROJECT_DIR, 'dist', 'build', 'out', '.next', 'target', '.venv', 'venv', '__pycache__', '.cache', '.turbo'])

export class CheckpointLimit extends Error {}

export function validPath(path: string): boolean {
  return path.split('/').every((part) => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')
}

export async function entryAt(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function parentEntry(root: string, path: string): Promise<'directory' | 'missing' | 'blocked'> {
  if (!validPath(path)) throw new Error('Invalid checkpoint path')
  let parent = root
  for (const part of path.split('/').slice(0, -1)) {
    parent = join(parent, part)
    const entry = await entryAt(parent)
    if (!entry) return 'missing'
    if (!entry.isDirectory()) return 'blocked'
  }
  return 'directory'
}

export interface FileVersion {
  mode: string
  oid: string
}

export async function currentVersion(root: string, path: string, algorithm: 'sha1' | 'sha256'): Promise<FileVersion | null> {
  const parent = await parentEntry(root, path)
  if (parent !== 'directory') return null
  const target = join(root, path)
  const entry = await entryAt(target)
  if (!entry) return null
  if (entry.isDirectory()) return { mode: 'directory', oid: '' }
  if (!entry.isSymbolicLink() && (!entry.isFile() || entry.size > CHECKPOINT_MAX_BYTES)) {
    // Include times so changing a large file invalidates previous consent to overwrite it.
    return { mode: entry.isFile() ? 'large' : 'special', oid: `${entry.ino}:${entry.size}:${entry.mtimeMs}:${entry.ctimeMs}` }
  }
  let data: Buffer
  let mode: string
  if (entry.isSymbolicLink()) {
    data = await readlink(target, { encoding: 'buffer' })
    mode = '120000'
  } else {
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size > CHECKPOINT_MAX_BYTES) throw new Error('Checkpoint file changed')
      data = Buffer.allocUnsafe(info.size + 1)
      const { bytesRead } = await file.read({ buffer: data, offset: 0, length: data.length, position: 0 })
      const after = await file.stat()
      if (bytesRead !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new Error('Checkpoint file changed')
      data = data.subarray(0, bytesRead)
      mode = fileMode(info.mode)
    } finally {
      await file.close()
    }
  }
  const oid = createHash(algorithm).update(`blob ${data.length}\0`).update(data).digest('hex')
  return { mode, oid }
}

export const fileMode = (mode: number) => mode & 0o100 ? '100755' : '100644'

export function sameVersion(a: FileVersion | null, b: FileVersion | null): boolean {
  return a?.mode === b?.mode && a?.oid === b?.oid
}

export async function directoryHasOtherFiles(dir: string, path: string, removable: Set<string>): Promise<boolean> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = path + '/' + entry.name
    if (entry.isDirectory()) {
      if (await directoryHasOtherFiles(join(dir, entry.name), relative, removable)) return true
    } else if (!removable.has(relative)) return true
  }
  return false
}

async function removeEmptyDirectories(dir: string) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await removeEmptyDirectories(join(dir, entry.name))
  }
  await rmdir(dir)
}

export async function restoreFile(root: string, path: string, before: FileVersion | null, data?: Buffer, permissions?: number) {
  const target = join(root, path)
  const parent = await parentEntry(root, path)
  if (parent === 'blocked') throw new Error('Checkpoint path is blocked')
  const entry = parent === 'directory' ? await entryAt(target) : null
  if (!before) {
    if (entry?.isDirectory()) await removeEmptyDirectories(target)
    else if (entry) await unlink(target)
    return
  }
  await mkdir(dirname(target), { recursive: true })
  // Rename in the same directory so a restored file is never visible half-written.
  const temp = join(dirname(target), `.agentswitch-restore-${randomUUID()}`)
  try {
    if (before.mode === '120000') await symlink(data!, temp)
    else {
      const file = await open(temp, 'wx', 0o600)
      try {
        await file.writeFile(data!)
        await file.chmod(permissions ?? (before.mode === '100755' ? 0o700 : 0o600))
      } finally {
        await file.close()
      }
    }
    if (entry?.isDirectory()) await removeEmptyDirectories(target)
    await rename(temp, target)
  } finally {
    await rm(temp, { force: true })
  }
}
