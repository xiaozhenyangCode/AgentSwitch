import * as fs from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fdir } from 'fdir'
import fuzzysort, { type SnapshotKey } from 'fuzzysort'
import ignore from 'ignore'
import type { FileSearchItem, FileSearchRequest, FileSearchResponse } from '@shared/types'
import { git, gitWorktree, isInside, parseStatus, visitGitRecords } from './gitOps'

const TTL_MS = 30_000
const MAX_FILES = 50_000
const MAX_CACHED_PROJECTS = 4
const PRUNED_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', '.next', '.nuxt',
  '.cache', 'coverage', 'target', 'vendor', 'Pods', '.venv', 'venv', '__pycache__', '.gradle'
])

type IndexedFile = Omit<FileSearchItem, 'indexes'>
interface FileIndex {
  defaults: IndexedFile[]
  names: SnapshotKey<IndexedFile>
  truncated: boolean
}
interface CacheEntry {
  index: Promise<FileIndex>
  expiresAt: number | null
}

const indexes = new Map<string, CacheEntry>()
const slashPath = (path: string) => path.split(sep).join('/')
const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')))

async function gitFiles(cwd: string, root: string) {
  const files = new Map<string, boolean>()
  let pending = ''
  let deleted = false
  let changed = false
  let truncated = false
  const keepPending = () => {
    if (!pending || deleted || pending.endsWith('/')) return true
    if (files.size === MAX_FILES && !files.has(pending)) {
      truncated = true
      return false
    }
    files.set(pending, changed || files.get(pending) === true)
    return true
  }

  const [status] = await Promise.all([
    // -z makes porcelain paths root-relative, even when cwd is a subdirectory.
    git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--no-renames', '--ignore-submodules=all', '--', '.']).catch(() => ''),
    visitGitRecords(cwd, ['ls-files', '--cached', '--others', '--exclude-standard', '--deleted', '-t', '-z'], (record) => {
      const path = record.slice(2)
      if (path !== pending) {
        if (!keepPending()) return false
        pending = path
        deleted = false
        changed = false
      }
      // Git emits the cached/conflict record followed by removal for the same path.
      // Group them before counting toward the cap. S entries are outside the sparse checkout.
      deleted ||= record[0] === 'R' || record[0] === 'S'
      changed ||= record[0] === '?' || record[0] === 'M'
      return true
    })
  ])
  if (!truncated) keepPending()
  const prefix = cwd === root ? '' : slashPath(relative(root, cwd)) + '/'
  for (const { path } of parseStatus(status)) {
    if (!path.startsWith(prefix)) continue
    const relPath = path.slice(prefix.length)
    if (files.has(relPath)) files.set(relPath, true)
  }
  return { files, truncated }
}

function scopedIgnorePatterns(dir: string, text: string): string[] {
  const prefix = '/' + dir.replace(/[\\*?[\]]/g, '\\$&') + '/'
  const patterns: string[] = []
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line || line[0] === '#') continue
    const negation = line[0] === '!' ? '!' : ''
    const pattern = line.slice(negation.length)
    const trimmed = pattern.replace(/ +$/, '')
    if (!trimmed || trimmed === '/') continue
    // A sole trailing slash restricts the type without anchoring the path.
    const anywhere = !trimmed.replace(/\/$/, '').includes('/')
    patterns.push(negation + prefix + (anywhere ? '**/' : '') + pattern.replace(/^\//, ''))
  }
  return patterns
}

async function crawlFiles(cwd: string) {
  const scopes = new Map<string, ReturnType<typeof ignore>>()
  const ignored = (path: string, parent: string) => scopes.get(parent)?.ignores(path) ?? false

  let count = 0
  let rootError: NodeJS.ErrnoException | null = null
  const readdir = (path: string, options: { withFileTypes: true }, done: (error: NodeJS.ErrnoException | null, entries: fs.Dirent[]) => void) => {
    fs.readdir(path, options, (error, entries) => {
      const dir = slashPath(relative(cwd, path))
      if (error) {
        if (!dir) rootError = error
        return done(error, [])
      }
      if (count > MAX_FILES) return done(null, [])
      const parent = dir ? scopes.get(parentOf(dir)) : undefined
      const ready = (scope: ReturnType<typeof ignore> | undefined) => {
        if (scope) scopes.set(dir, scope)
        done(null, entries)
      }
      // Install this directory's rules before fdir evaluates its files or schedules children.
      if (entries.some((entry) => entry.name === '.gitignore' && entry.isFile())) {
        void readFile(join(path, '.gitignore'), 'utf8').then(
          (rules) => {
            // One root-relative matcher lets nested negations reopen a parent directory
            // while retaining any ancestor rules that directly match its descendants.
            const scope = ignore({ ignorecase: false })
            if (parent) scope.add(parent)
            ready(scope.add(dir ? scopedIgnorePatterns(dir, rules) : rules))
          },
          () => ready(parent)
        )
      } else ready(parent)
    })
  }
  const paths = await new fdir({
    // fdir's asynchronous walker always calls the Dirent overload.
    fs: { ...fs, readdir: readdir as typeof fs.readdir }
  })
    .withPathSeparator('/')
    .withRelativePaths()
    .withMaxFiles(MAX_FILES + 1)
    .exclude((name, path) => {
      if (count > MAX_FILES || PRUNED_DIRS.has(name)) return true
      const relPath = slashPath(relative(cwd, path))
      return ignored(relPath + '/', parentOf(relPath))
    })
    .filter((path) => {
      if (count > MAX_FILES) return false
      if (ignored(path, parentOf(path))) return false
      count++
      return true
    })
    .crawl(cwd)
    .withPromise()

  if (rootError) throw new Error('Project directory is unavailable.', { cause: rootError })
  const truncated = paths.length > MAX_FILES
  if (truncated) paths.pop()
  return { files: new Map(paths.map((path) => [path, false])), truncated }
}

async function buildIndex(cwd: string): Promise<FileIndex> {
  const worktree = await gitWorktree(cwd)
  const { files, truncated } = worktree ? await gitFiles(cwd, worktree.root) : await crawlFiles(cwd)
  const ranked = Array.from(files, ([relPath, changed]) => {
    const slash = relPath.lastIndexOf('/')
    const item = { relPath, name: relPath.slice(slash + 1), dir: slash < 0 ? '' : relPath.slice(0, slash) }
    return { item, changed, depth: relPath.split('/').length }
  })
  ranked.sort((a, b) => Number(b.changed) - Number(a.changed) || a.depth - b.depth
    || (a.item.relPath < b.item.relPath ? -1 : Number(a.item.relPath > b.item.relPath)))
  const defaults = ranked.map(({ item }) => item)
  const names = fuzzysort.snapshot(defaults, { key: 'name' })
  // Finalize the basename index on demand and cancel fuzzysort's deferred preparation.
  fuzzysort.go('', names, { limit: 1 })
  return { defaults, names, truncated }
}

function getIndex(cwd: string, refresh: boolean): Promise<FileIndex> {
  const cached = indexes.get(cwd)
  if (cached && (cached.expiresAt === null || (!refresh && cached.expiresAt > Date.now()))) {
    indexes.delete(cwd)
    indexes.set(cwd, cached)
    return cached.index
  }

  const entry: CacheEntry = {
    expiresAt: null,
    index: buildIndex(cwd).then((index) => {
      entry.expiresAt = Date.now() + TTL_MS
      if (indexes.get(cwd) !== entry) return index
      for (const [key, candidate] of indexes) {
        if (indexes.size <= MAX_CACHED_PROJECTS) break
        if (candidate.expiresAt !== null) indexes.delete(key)
      }
      return index
    }, (error) => {
      if (indexes.get(cwd) === entry) indexes.delete(cwd)
      throw error
    })
  }
  indexes.delete(cwd)
  indexes.set(cwd, entry)
  return entry.index
}

export function invalidateFileIndex(cwd?: string): void {
  if (cwd === undefined) return indexes.clear()
  if (!indexes.size) return
  let dir = resolve(cwd)
  try { dir = fs.realpathSync(dir) } catch { /* The path may have been removed. */ }
  for (const key of indexes.keys()) {
    if (isInside(dir, key) || isInside(key, dir)) indexes.delete(key)
  }
}

export async function searchProjectFiles(request: FileSearchRequest): Promise<FileSearchResponse> {
  if (!request || typeof request.cwd !== 'string' || !isAbsolute(request.cwd) || request.cwd.includes('\0')
    || typeof request.query !== 'string') throw new Error('Invalid file search request.')
  const cwd = await realpath(request.cwd).catch(() => null)
  if (!cwd) throw new Error('Project directory is unavailable.')
  const requestedLimit = request.limit
  const limit = typeof requestedLimit === 'number' && Number.isFinite(requestedLimit)
    ? Math.min(50, Math.max(1, Math.trunc(requestedLimit)))
    : 20
  const index = await getIndex(cwd, request.refresh === true)
  const query = request.query.slice(0, 120).trim()
  return {
    items: query
      ? fuzzysort.go(query, index.names, { limit, threshold: 0 }).map(({ obj, indexes }) => ({ ...obj, indexes: [...indexes] }))
      : index.defaults.slice(0, limit).map((item) => ({ ...item, indexes: [] })),
    truncated: index.truncated
  }
}
