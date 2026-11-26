import { constants, openSync, readSync, closeSync, fstatSync, realpathSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import type { FileChange, FileChangePreview, FileChanges, GitCommitDetail, GitCommitFile, GitResult, GitStashDetail } from '@shared/types'
import { git, gitFailure, gitWorktree, isInside, isStashRef, parseGitCommitFields, parseGitParents, parseStatus, resolveRef, verifyCommitHash } from './gitOps'
import { allowRoot } from './fileProtocol'

/** Read-only `git status` + `git diff` of a project folder for the 文件修改 panel. */

const MAX_FILES = 300
const MAX_DIFF = 200 * 1024 // per file
const MAX_UNTRACKED_READ = 256 * 1024

const cut = (d: string): { diff: string; truncated: boolean } =>
  d.length > MAX_DIFF ? { diff: d.slice(0, MAX_DIFF) + '\n… (diff truncated)', truncated: true } : { diff: d, truncated: false }

/** Synthetic all-added diff for an untracked file. */
function untrackedDiff(root: string, abs: string, rel: string): { diff: string; added: number; binary: boolean; truncated: boolean } {
  let fd: number | null = null
  try {
    if (!isInside(root, realpathSync(dirname(abs)))) return { diff: '', added: 0, binary: false, truncated: false }
    fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = fstatSync(fd)
    if (!info.isFile()) return { diff: '', added: 0, binary: false, truncated: false }
    const size = info.size
    const n = Math.min(size, MAX_UNTRACKED_READ)
    const buffer = Buffer.alloc(n)
    const buf = buffer.subarray(0, readSync(fd, buffer, 0, n, 0))
    if (buf.subarray(0, 8192).includes(0)) return { diff: '', added: 0, binary: true, truncated: false }
    const text = buf.toString('utf8')
    const lines = text.replace(/\n$/, '').split('\n')
    const added = text ? lines.length : 0
    const body = `--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${added} @@\n` + lines.map((l) => '+' + l).join('\n')
    const c = cut(body)
    return {
      diff: c.diff,
      added,
      binary: false,
      truncated: c.truncated || size > n
    }
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    return { diff: '', added: 0, binary: false, truncated: false }
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

type DiffStats = Pick<FileChangePreview, 'added' | 'removed' | 'binary' | 'diff' | 'truncated'>

const diffOptions = ['-z', '-M', '--no-ext-diff', '--no-color']

async function readDiff(root: string, scope: string | null, command: string[]): Promise<Map<string, DiffStats>> {
  const args = [...command, '--numstat', ...diffOptions]
  const paths = scope === null ? [] : ['--', scope]
  const { output, statsOnly } = await git(root, [...args, '--patch', ...paths])
    .then((output) => ({ output, statsOnly: false }))
    .catch(async (error: Error) => {
      if ((error.cause as { code?: string } | undefined)?.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw error
      return { output: await git(root, [...args, ...paths]), statsOnly: true }
    })
  const tokens = output.split('\0')
  const stats = new Map<string, DiffStats>()
  const orderedPaths: string[] = []
  let i = 0
  while (i < tokens.length && tokens[i]) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(tokens[i++])
    if (!match) break
    let path = match[3]
    if (!path) {
      path = tokens[i + 1]
      i += 2
    }
    orderedPaths.push(path)
    stats.set(path, {
      added: match[1] === '-' ? 0 : Number(match[1]),
      removed: match[2] === '-' ? 0 : Number(match[2]),
      binary: match[1] === '-',
      diff: '',
      ...(statsOnly && match[1] !== '-' && (match[1] !== '0' || match[2] !== '0') ? { truncated: true } : {})
    })
  }

  // Git emits numstat and patch records in the same order. Match by position so quoted
  // paths, tabs and embedded newlines in filenames do not affect the lookup.
  const patches = tokens.slice(i + 1).join('\0').split(/^(?=(?:diff --(?:git|cc|combined) |\* Unmerged path ))/m).filter(Boolean)
  if (patches.length === orderedPaths.length) {
    orderedPaths.forEach((path, index) => {
      const stat = stats.get(path)
      const patch = patches[index].replace(/^diff --.*\n(?:(?:index|similarity|rename|new file|deleted file|old mode|new mode).*\n)*/, '')
      if (stat) Object.assign(stat, cut(patch))
    })
  }
  return stats
}

function preview(status: FileChange['status'], stats?: DiffStats): FileChangePreview {
  return { status, added: 0, removed: 0, diff: '', ...stats }
}

function changeStatus(code: string): FileChange['status'] {
  if (code === 'D' || code === 'A' || code === 'R') return code
  return 'M'
}

export async function gitChanges(dir: unknown, split = false): Promise<FileChanges> {
  const none: FileChanges = { repo: false, files: [], added: 0, removed: 0 }
  const worktree = await gitWorktree(dir, true)
  if (!worktree || typeof dir !== 'string') return none
  const { root } = worktree
  allowRoot(dir) // Finder / open for the listed files

  const base = await resolveRef(root, 'HEAD') ?? (await git(root, ['hash-object', '-t', 'tree', '--stdin'])).trim()

  // only what lies under the chosen folder (it may be a subfolder of the repo)
  const scope = relative(root, worktree.dir) || '.'
  const readWorktreeDiff = (...comparison: string[]) => readDiff(root, scope, ['diff', '--no-textconv', ...comparison])
  const [status, combined, index, workingTree, repoStatus] = await Promise.all([
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', scope]),
    readWorktreeDiff(base),
    split ? readWorktreeDiff('--cached') : undefined,
    split ? readWorktreeDiff() : undefined,
    split && scope !== '.' ? git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=no']) : undefined
  ])

  const files: FileChange[] = []
  const scoped = parseStatus(status)
  const entries = repoStatus === undefined ? scoped : [
    ...scoped.filter((file) => !file.conflicted), ...parseStatus(repoStatus).filter((file) => file.conflicted)
  ]
  // Keep unresolved paths accessible even if a large ordinary changes list is truncated.
  entries.sort((a, b) => Number(b.conflicted) - Number(a.conflicted))
  const total = entries.length
  for (const { xy, path: p, staged, unstaged, conflicted } of entries) {
    if (files.length >= MAX_FILES && !conflicted) break
    const rel = relative(worktree.dir, join(root, p)).split(sep).join('/')
    const abs = join(dir, rel)
    if (conflicted) {
      files.push({ path: rel, abs, conflicted: true, conflictPath: p, ...preview('C', combined.get(p)) })
      continue
    }
    if (xy === '??') {
      const u = untrackedDiff(root, join(root, p), rel)
      const change = preview('U', { ...u, removed: 0 })
      files.push({ path: rel, abs, staged, unstaged, ...change, ...(split ? { unstagedChange: change } : {}) })
      continue
    }
    const status = xy.includes('D') ? 'D' : xy[0] === 'R' ? 'R' : xy.includes('A') ? 'A' : 'M'
    files.push({
      path: rel, abs, staged, unstaged, ...preview(status, combined.get(p)),
      ...(index && staged ? { stagedChange: preview(changeStatus(xy[0]), index.get(p)) } : {}),
      ...(workingTree && unstaged ? { unstagedChange: preview(changeStatus(xy[1]), workingTree.get(p)) } : {})
    })
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  return {
    repo: true,
    files,
    added: files.reduce((n, f) => n + f.added, 0),
    removed: files.reduce((n, f) => n + f.removed, 0),
    ...(total > files.length ? { more: total - files.length } : {})
  }
}

async function readChangedFiles(root: string, command: string[], scope: string | null) {
  const [names, stats] = await Promise.all([
    git(root, [...command, '--name-status', ...diffOptions, ...(scope === null ? [] : ['--', scope])]),
    readDiff(root, scope, command)
  ])
  const tokens = names.split('\0')
  const files: GitCommitFile[] = []
  for (let i = 0; i < tokens.length && tokens[i];) {
    const code = tokens[i++][0]
    const oldPath = code === 'R' || code === 'C' ? tokens[i++] : undefined
    const path = tokens[i++]
    if (!path) break
    files.push({ path, ...(oldPath ? { oldPath } : {}), ...preview(changeStatus(code), stats.get(path)) })
  }
  return files
}

function summarizeChangedFiles(files: GitCommitFile[]) {
  return {
    files: files.slice(0, MAX_FILES),
    added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0),
    ...(files.length > MAX_FILES ? { more: files.length - MAX_FILES } : {})
  }
}

export async function gitStashDetail(dir: unknown, ref: unknown): Promise<GitResult<{ stash: GitStashDetail }>> {
  if (!isStashRef(ref)) return gitFailure('Invalid Git stash reference.')
  try {
    const worktree = await gitWorktree(dir, true)
    if (!worktree) return gitFailure('This folder is not in a Git worktree.')
    const { root } = worktree
    const hash = (await git(root, ['rev-parse', '--verify', '--end-of-options', ref + '^{commit}'])).trim()
    let files: GitCommitFile[]
    try {
      files = await readChangedFiles(root, ['stash', 'show', '--include-untracked', '--no-textconv', hash], null)
    } catch (error) {
      // Older Git lacks stash show --include-untracked. Its third parent holds untracked files.
      if (!(error instanceof Error) || !/unknown option|unrecognized (?:argument|option)/i.test(error.message)
        || !/include-untracked/.test(error.message)) throw error
      const parents = (await git(root, ['log', '-1', '--format=%P', hash, '--'])).trim().split(' ')
      if (!parents[0]) throw new Error('Invalid Git stash metadata.')
      const diffTree = ['diff-tree', '-r', '--no-commit-id', '--no-textconv']
      const tracked = await readChangedFiles(root, [...diffTree, parents[0], hash], '.')
      const untracked = parents[2] ? await readChangedFiles(root, [...diffTree, '--root', parents[2]], '.') : []
      files = [...tracked, ...untracked]
    }
    return { ok: true, stash: { ref, ...summarizeChangedFiles(files) } }
  } catch (error) {
    return gitFailure(error)
  }
}

export async function gitCommitDetail(dir: unknown, hash: unknown, metadataOnly = false): Promise<GitResult<{ commit: GitCommitDetail }>> {
  try {
    const worktree = await gitWorktree(dir, true)
    if (!worktree) return gitFailure('This folder is not in a Git worktree.')
    const { root } = worktree
    const verified = await verifyCommitHash(root, hash)
    const output = await git(root, [
      'show', '-s', '--no-show-signature', '--no-notes', '--no-color', '--encoding=UTF-8',
      '--format=format:%H%x00%h%x00%P%x00%s%x00%an%x00%ae%x00%at%x00%b%x00%B', verified, '--'
    ])
    const fields = output.split('\0')
    if (fields.length !== 9) return gitFailure('Invalid Git commit metadata.')
    const [commitHash, shortHash, parentField, subject, author, email, seconds, body, message] = fields
    const commit = parseGitCommitFields(commitHash, shortHash, subject, author, seconds)
    const parents = parseGitParents(parentField, commitHash)
    if (!commit || commit.hash !== verified || !parents) return gitFailure('Invalid Git commit metadata.')

    // For merge commits compare with the first parent. --root compares with an
    // empty tree of the repository's object format (SHA-1 or SHA-256).
    const comparison = parents.length ? [parents[0], verified] : ['--root', verified]
    const files = metadataOnly ? [] : await readChangedFiles(root, ['diff-tree', '-r', '--no-commit-id', '--no-textconv', ...comparison], '.')
    return {
      ok: true,
      commit: { ...commit, parents, body, message, email, ...summarizeChangedFiles(files) }
    }
  } catch (error) {
    return gitFailure(error)
  }
}
