import { execFile } from 'node:child_process'
import { lstat, realpath, stat, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { GitBranch, GitCommit, GitGraphCommit, GitGraphData, GitGraphOptions, GitGraphRef, GitMutation, GitMutationResult, GitResult, GitStatus } from '@shared/types'
import { classifyGitError } from '@shared/gitErrors'
import { getBaseEnv } from './shellEnv'

function gitEnv(network: boolean): NodeJS.ProcessEnv {
  let base: NodeJS.ProcessEnv
  try {
    base = getBaseEnv()
  } catch {
    base = process.env
  }
  const env: NodeJS.ProcessEnv = { ...base, GIT_PAGER: 'cat', LC_ALL: 'C' }
  // Inherited git-local variables must not redirect a worktree or alter literal pathspecs.
  for (const key of [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX', 'GIT_CONFIG_PARAMETERS',
    'GIT_CONFIG_COUNT', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS'
  ]) delete env[key]
  if (network) {
    Object.assign(env, {
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      SSH_ASKPASS_REQUIRE: 'never',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
      GCM_INTERACTIVE: 'never'
    })
  }
  return env
}

/** `timeout` override: commits run user hooks (lint-staged, signing) that easily exceed 15s. */
export function git(cwd: string, args: string[], network = false, timeout = network ? 60_000 : 15_000): Promise<string> {
  return gitBytes(cwd, args, { network, timeout }).then((output) => output.toString())
}

export function gitBytes(cwd: string, args: string[], options: {
  network?: boolean; timeout?: number; env?: NodeJS.ProcessEnv; input?: Buffer; maxBuffer?: number
} = {}): Promise<Buffer> {
  const { network = false, timeout = 15_000, env, input, maxBuffer = 4 * 1024 * 1024 } = options
  return new Promise((resolve, reject) => {
    const child = execFile('git', [
      '-c', 'core.quotepath=off', '--no-optional-locks', '--literal-pathspecs',
      ...(network ? ['-c', 'credential.interactive=false'] : []),
      ...args
    ], {
      cwd, env: { ...gitEnv(network), ...env }, encoding: 'buffer', maxBuffer, timeout
    }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout)
      const output = args[0] === 'push' ? [stderr.toString().trim(), stdout.toString().trim()].filter(Boolean).join('\n') : stderr.toString().trim()
      const detail = output.slice(0, 4_000)
      reject(new Error(detail || (err.killed ? 'Git command timed out.' : err.message.split('\n')[0]), { cause: err }))
    })
    child.stdin?.on('error', () => { /* The command callback reports early exits. */ })
    child.stdin?.end(input)
  })
}

export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}

export async function gitWorktree(dir: unknown): Promise<{ root: string; dir: string } | null> {
  if (typeof dir !== 'string' || dir.includes('\0') || !isAbsolute(dir)) return null
  try {
    const canonicalDir = await realpath(dir)
    if (!(await stat(canonicalDir)).isDirectory()) return null
    const top = await git(canonicalDir, ['rev-parse', '--show-toplevel'])
    const root = await realpath(top.replace(/\n$/, ''))
    return isInside(root, canonicalDir) ? { root, dir: canonicalDir } : null
  } catch {
    return null
  }
}

export function parseStatus(output: string) {
  const tokens = output.split('\0')
  const files: { xy: string; path: string; oldPath?: string; staged: boolean; unstaged: boolean }[] = []
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i]
    if (entry.length < 4) continue
    const xy = entry.slice(0, 2)
    const oldPath = /[RC]/.test(xy) ? tokens[++i] : undefined
    files.push({
      xy, path: entry.slice(3), oldPath,
      staged: xy !== '??' && xy[0] !== ' ',
      unstaged: xy[1] !== ' '
    })
  }
  return files
}

const porcelain = ['status', '--porcelain=v1', '-z', '--untracked-files=all']

function currentBranch(root: string): Promise<string | null> {
  return git(root, ['symbolic-ref', '--quiet', 'HEAD']).then((name) => name.trim().slice('refs/heads/'.length), () => null)
}

async function listBranches(root: string): Promise<GitBranch[]> {
  const [output, remotes] = await Promise.all([
    git(root, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)%00%(symref)', 'refs/heads', 'refs/remotes']),
    listRemotes(root)
  ])
  const branches: GitBranch[] = []
  for (const row of output.trimEnd().split('\n')) {
    const [ref, symref] = row.split('\0')
    if (symref) continue
    if (ref.startsWith('refs/heads/')) {
      branches.push({ name: ref.slice('refs/heads/'.length), remote: null })
    } else if (ref.startsWith('refs/remotes/')) {
      const name = ref.slice('refs/remotes/'.length)
      const remote = remotes.find((r) => name.startsWith(r + '/')) ?? name.split('/')[0]
      branches.push({ name, remote })
    }
  }
  return branches
}

async function listRemotes(root: string): Promise<string[]> {
  return (await git(root, ['remote'])).trim().split('\n').filter(Boolean).sort((a, b) => b.length - a.length)
}

class InvalidBranch extends Error {}
class AgentBusy extends Error {}

export function gitFailure(error: unknown): Extract<GitResult, { ok: false }> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 4_000)
  const code = error instanceof InvalidBranch ? 'invalidBranch'
    : error instanceof AgentBusy ? 'busy' : classifyGitError(message)
  return { ok: false, error: message, ...(code ? { code } : {}) }
}

export async function gitStatus(dir: unknown): Promise<GitResult<GitStatus>> {
  const worktree = await gitWorktree(dir)
  if (!worktree) return { ok: true, repo: false }
  const { root } = worktree
  try {
    const [branch, detached, upstream, status, branches] = await Promise.all([
      currentBranch(root),
      git(root, ['rev-parse', '--short', 'HEAD']).then((s) => s.trim(), () => null),
      git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).then((s) => s.trim(), () => null),
      git(root, porcelain),
      listBranches(root)
    ])
    const counts = upstream && detached
      ? await git(root, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}', '--'])
      : '0 0'
    if (branch && !branches.some((entry) => entry.remote === null && entry.name === branch)) {
      branches.push({ name: branch, remote: null }) // unborn branch
    }
    const [ahead, behind] = counts.trim().split(/\s+/).map(Number)
    const files = parseStatus(status)
    return {
      ok: true, repo: true, branch, detached: branch ? null : detached, upstream, ahead, behind,
      dirty: files.length > 0, staged: files.filter((file) => file.staged).length,
      unstaged: files.filter((file) => file.unstaged).length, atRoot: root === worktree.dir, branches
    }
  } catch (error) {
    return gitFailure(error)
  }
}

const fullHash = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const logOptions = ['--no-show-signature', '--no-notes', '--no-color', '--encoding=UTF-8']

function logRecords(output: string): string[] {
  // Git terminates each formatted record with a newline. Splitting at the record
  // boundary preserves line breaks and inline record separators in commit text.
  return output.split(/(?:^|\r?\n)\x1e/).slice(1)
}

export function parseGitCommitFields(hash: string, shortHash: string, subject: string, author: string, seconds: string): GitCommit | null {
  if (!fullHash.test(hash) ||
    !/^[a-f0-9]{4,}$/.test(shortHash) || !hash.startsWith(shortHash) || !/^\d+$/.test(seconds)) return null
  const timestamp = Number(seconds) * 1000
  if (timestamp > 8.64e15) return null
  return { sha: shortHash, shortHash, hash, subject, author, authoredAt: timestamp, timestamp }
}

export function parseGitParents(value: string, hash: string): string[] | null {
  const parents = value ? value.split(' ') : []
  return parents.every((parent) => parent.length === hash.length && fullHash.test(parent)) ? parents : null
}

export function parseGitLog(output: string): GitCommit[] {
  const commits: GitCommit[] = []
  for (const record of logRecords(output)) {
    const fields = record.trimEnd().split('\x1f')
    if (fields.length !== 5 || record.includes('\0')) continue
    const [hash, shortHash, subject, author, seconds] = fields
    const commit = parseGitCommitFields(hash, shortHash, subject, author, seconds)
    if (commit) commits.push(commit)
  }
  return commits
}

function readLimit(value: unknown, fallback: number, max: number): string {
  return String(typeof value === 'number' && Number.isSafeInteger(value) ? Math.max(1, Math.min(max, value)) : fallback)
}

export async function gitLog(dir: unknown, limit?: unknown): Promise<GitResult<{ commits: GitCommit[] }>> {
  const worktree = await gitWorktree(dir)
  if (!worktree) return gitFailure('This folder is not in a Git worktree.')
  const { root } = worktree
  try {
    const output = await git(root, [
      'log', '-n', readLimit(limit, 20, 100), ...logOptions,
      '--format=%x1e%H%x1f%h%x1f%s%x1f%an%x1f%at', '--'
    ])
    return { ok: true, commits: parseGitLog(output) }
  } catch (error) {
    // With implicit HEAD and LC_ALL=C, Git reports an unborn branch explicitly.
    if (error instanceof Error && /^fatal: your current branch '.+' does not have any commits yet$/.test(error.message)) {
      return { ok: true, commits: [] }
    }
    return gitFailure(error)
  }
}

function parseGraphRefs(value: string): GitGraphRef[] {
  const refs: GitGraphRef[] = []
  for (const decoration of value.split(', ')) {
    let ref = decoration
    if (ref === 'HEAD' || ref.startsWith('HEAD -> ')) {
      refs.push({ kind: 'head', name: 'HEAD' })
      if (ref === 'HEAD') continue
      ref = ref.slice('HEAD -> '.length)
    }
    if (/^(?:tag: )?refs\/agentswitch\//.test(ref)) continue
    if (ref.startsWith('tag: refs/tags/')) refs.push({ kind: 'tag', name: ref.slice('tag: refs/tags/'.length) })
    else if (ref.startsWith('refs/heads/')) refs.push({ kind: 'branch', name: ref.slice('refs/heads/'.length) })
    else if (ref.startsWith('refs/remotes/')) refs.push({ kind: 'remote', name: ref.slice('refs/remotes/'.length) })
    else if (ref.startsWith('refs/')) refs.push({ kind: 'other', name: ref.slice('refs/'.length) })
  }
  return refs
}

function parseGraphRecord(record: string): GitGraphCommit[] {
  const fields = record.trimEnd().split('\x1f')
  if (fields.length !== 7 || record.includes('\0')) return []
  const [hash, shortHash, parentField, decorations, subject, author, seconds] = fields
  const commit = parseGitCommitFields(hash, shortHash, subject, author, seconds)
  const parents = parseGitParents(parentField, hash)
  return commit && parents ? [{ ...commit, parents, refs: parseGraphRefs(decorations) }] : []
}

export function parseGitGraph(output: string): GitGraphCommit[] {
  return logRecords(output).flatMap(parseGraphRecord)
}

async function resolveGraphBranch(root: string, branch: unknown, branches: GitBranch[]): Promise<string> {
  if (typeof branch !== 'string' || !branch || branch.startsWith('-') || branch.includes('\0')) {
    throw new InvalidBranch('Invalid Git history branch.')
  }
  const candidates = branches.map(({ name, remote }) => ({ name, ref: `refs/${remote === null ? 'heads' : 'remotes'}/${name}` }))
  const named = candidates.filter((candidate) => candidate.name === branch)
  const ref = candidates.find((candidate) => candidate.ref === branch)?.ref ?? (named.length === 1 ? named[0].ref : undefined)
  if (!ref) throw new InvalidBranch('Unknown or ambiguous Git history branch.')
  return (await git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim()
}

export async function gitGraph(dir: unknown, options?: unknown): Promise<GitResult<GitGraphData>> {
  const worktree = await gitWorktree(dir)
  if (!worktree) return gitFailure('This folder is not in a Git worktree.')
  const { root } = worktree
  const params: GitGraphOptions = options && typeof options === 'object' ? options : { limit: typeof options === 'number' ? options : undefined }
  const count = Number(readLimit(params.limit, 200, 500))
  const skip = typeof params.skip === 'number' && Number.isSafeInteger(params.skip)
    ? Math.min(2_147_483_647, Math.max(0, params.skip))
    : 0
  const chosenBranch = params.branch
  const allBranches = chosenBranch == null || chosenBranch === '__ALL__'
  const format = [...logOptions, '--decorate=full', '--decorate-refs-exclude=refs/agentswitch/*',
    '--format=%x1e%H%x1f%h%x1f%P%x1f%D%x1f%s%x1f%an%x1f%at']
  try {
    const [branch, head, status, branches] = await Promise.all([
      currentBranch(root),
      git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).then((hash) => hash.trim(), () => null),
      git(root, porcelain),
      listBranches(root)
    ])
    const tip = allBranches ? null : chosenBranch === 'HEAD' ? head : await resolveGraphBranch(root, chosenBranch, branches)
    const revisions = allBranches
      ? ['--exclude=refs/agentswitch/*', '--branches', '--tags', '--remotes', ...(head ? [head] : [])]
      : tip ? [tip] : []
    const output = revisions.length
      ? await git(root, ['log', '--parents', '--topo-order', '-n', String(count + 1), '--skip', String(skip), ...format, ...revisions, '--'])
      : ''
    const records = logRecords(output)
    const commits = records.slice(0, count).flatMap(parseGraphRecord)
    let headCommit: GitGraphCommit | undefined
    if (!skip && head && !commits.some((commit) => commit.hash === head)) {
      const headInScope = allBranches || tip === head || (tip && await git(root, ['merge-base', '--is-ancestor', head, tip]).then(() => true, () => false))
      if (headInScope) {
        [headCommit] = parseGitGraph(await git(root, ['log', '-n', '1', ...format, head, '--']))
      }
    }
    const files = parseStatus(status)
    return {
      ok: true, commits, headHash: head, branch, dirty: files.length > 0,
      ...(headCommit ? { headCommit } : {}),
      hasMore: records.length > count, nextSkip: skip + Math.min(records.length, count), branches,
      uncommittedCount: files.length,
      staged: files.filter((file) => file.staged).length,
      unstaged: files.filter((file) => file.unstaged).length
    }
  } catch (error) {
    return gitFailure(error)
  }
}

async function validateBranch(root: string, name: string) {
  if (!name || name.startsWith('-') || name.includes('\0')
    || (await git(root, ['check-ref-format', '--branch', name]).catch(() => '')).trim() !== name) {
    throw new InvalidBranch('Invalid Git branch name.')
  }
}

/** Accept a symlink as the file itself, never as a directory leading to it. */
async function validatePath(root: string, dir: string, path: string): Promise<string> {
  const parts = path.split(sep)
  if (isAbsolute(path) || path.includes('\0') || parts.some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
    throw new Error('Invalid repository file path.')
  }
  const abs = resolve(dir, path)
  if (!isInside(root, abs)) throw new Error('File is outside the Git worktree.')
  // A deleted tracked file can have missing parents.
  for (let parent = dirname(abs); parent !== root; parent = dirname(parent)) {
    const entry = await lstat(parent).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (entry && !entry.isDirectory()) throw new Error('File path traverses a non-directory or symbolic link.')
  }
  return relative(root, abs)
}

async function unstage(root: string, paths: string[]) {
  const hasHead = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '')
  // An unborn branch has no HEAD tree for git restore to use.
  await git(root, hasHead
    ? ['restore', '--staged', '--', ...paths]
    : ['rm', '--cached', '-r', '-f', '--ignore-unmatch', '--', ...paths])
}

async function fileMutation(root: string, dir: string, op: Extract<GitMutation, { path: string }>, checkBusy: () => Promise<void>) {
  const path = await validatePath(root, dir, op.path)
  const files = parseStatus(await git(root, porcelain)).filter((file) => file.path === path)
  const abs = resolve(root, path)
  if (op.kind === 'stage' && files.some((file) => file.unstaged)) {
    await checkBusy()
    await git(root, ['add', '--', path])
  } else if (op.kind === 'unstage' && files.some((file) => file.staged)) {
    const paths = [path]
    const oldPath = files.find((file) => file.xy[0] === 'R')?.oldPath
    if (oldPath) paths.push(await validatePath(root, root, oldPath))
    await checkBusy()
    await unstage(root, paths)
  } else if (op.kind === 'discard' && files.some((file) => file.unstaged && (file.xy === '??') === op.untracked)) {
    if (op.untracked) {
      const entry = await lstat(abs)
      if (!entry.isFile() && !entry.isSymbolicLink()) throw new Error('Only individual untracked files can be discarded.')
      await checkBusy()
      await unlink(abs)
    } else {
      await checkBusy()
      await git(root, ['restore', '--no-recurse-submodules', '--', path])
    }
  } else {
    throw new Error('The file status changed. Refresh the Git changes and try again.')
  }
}

async function pushBranch(root: string, checkBusy: () => Promise<void>) {
  const branch = await currentBranch(root)
  if (!branch) throw new Error('Cannot push from a detached HEAD.')
  await validateBranch(root, branch)
  const source = 'refs/heads/' + branch
  const [tracking, remotes] = await Promise.all([
    git(root, ['for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)', source]),
    listRemotes(root)
  ])
  const [upstreamRemote, upstreamRef] = tracking.trimEnd().split('\0')
  const remote = upstreamRemote || 'origin'
  if (!remotes.includes(remote) || remote.startsWith('-')) throw new Error('No push remote is available for this branch.')
  if (upstreamRemote && !upstreamRef?.startsWith('refs/heads/')) throw new Error('The upstream is not a remote branch.')
  if (upstreamRemote) await validateBranch(root, upstreamRef.slice('refs/heads/'.length))
  // An explicit refspec prevents configured push refspecs from forcing updates or touching other refs.
  await checkBusy()
  const output = await git(root, ['push', '--porcelain', '--no-mirror', '--no-follow-tags', '--recurse-submodules=no',
    ...(!upstreamRemote ? ['-u'] : []), '--', remote, source + ':' + (upstreamRef || source)], true)
  const line = output.split('\n').find((row) => /^[ =*]\t/.test(row))
  const range = line?.split('\t')[2]?.match(/^([a-f\d]+)\.\.([a-f\d]+)$/i)
  // Use the range accepted by the remote, which may differ from the last fetched upstream.
  const count = line?.startsWith('=') ? 0 : range ? await countCommits(root, range[1], range[2]) : null
  const target = remote + '/' + (upstreamRef || source).slice('refs/heads/'.length)
  return { kind: 'push' as const, target, count, published: !upstreamRemote }
}

async function countCommits(root: string, before: string, after: string): Promise<number | null> {
  const result = await git(root, ['rev-list', '--count', before ? before + '..' + after : after, '--']).catch(() => '')
  return result ? Number(result.trim()) : null
}

function head(root: string): Promise<string> {
  return git(root, ['rev-parse', '--verify', 'HEAD']).then((sha) => sha.trim(), () => '')
}

async function commit(root: string, message: string) {
  await git(root, ['commit', '-m', message], false, 120_000)
  const metadata = await git(root, ['log', '-1', '--format=%h%x00%s', 'HEAD', '--']).catch(() => '')
  const [sha, subject] = metadata.trimEnd().split('\0')
  return { kind: 'commit' as const, sha, subject: subject ?? message.trim().split('\n')[0] }
}

function isMutation(value: unknown): value is GitMutation {
  if (!value || typeof value !== 'object' || !('kind' in value)) return false
  const op = value as GitMutation
  switch (op.kind) {
    case 'switch': return typeof op.name === 'string' && (op.remote === null || typeof op.remote === 'string')
    case 'createBranch': return typeof op.name === 'string'
    case 'stage':
    case 'unstage': return typeof op.path === 'string'
    case 'discard': return typeof op.path === 'string' && typeof op.untracked === 'boolean'
    case 'stageAndCommit':
    case 'commit': return typeof op.message === 'string' && !!op.message.trim() && !op.message.includes('\0')
    case 'fetch':
    case 'pull':
    case 'push':
    case 'stageAll':
    case 'unstageAll': return true
    default: return false
  }
}

const writes = new Map<string, Promise<GitMutationResult>>()

export async function gitMutate(dir: unknown, op: unknown, isBusy?: (root: string) => Promise<boolean>, busyMessage?: string): Promise<GitMutationResult> {
  if (!isMutation(op)) return gitFailure('Invalid Git operation.')
  const worktree = await gitWorktree(dir)
  if (!worktree) return gitFailure('This folder is not in a Git worktree.')
  const { root } = worktree
  const next = (writes.get(root) ?? Promise.resolve()).then(async (): Promise<GitMutationResult> => {
    try {
      const checkBusy = async () => {
        if (await isBusy?.(root)) throw new AgentBusy(busyMessage ?? 'An Agent is running.')
      }
      await checkBusy()
      switch (op.kind) {
        case 'switch': {
          await validateBranch(root, op.name)
          const ref = op.remote === null ? 'refs/heads/' + op.name : 'refs/remotes/' + op.name
          if (op.remote !== null && !op.name.startsWith(op.remote + '/')) throw new Error('Invalid remote branch.')
          await git(root, ['show-ref', '--verify', '--', ref])
          await checkBusy()
          await git(root, ['switch', '--no-guess', '--no-recurse-submodules',
            ...(op.remote === null ? ['--', op.name] : ['--track', '--', ref])])
          return { ok: true, outcome: { kind: 'switch', branch: await currentBranch(root) ?? op.name } }
        }
        case 'createBranch':
          await validateBranch(root, op.name)
          await checkBusy()
          await git(root, ['switch', '--no-recurse-submodules', '-c', op.name])
          return { ok: true, outcome: { kind: 'createBranch', branch: op.name } }
        case 'fetch':
          await git(root, ['fetch', '--prune', '--no-recurse-submodules'], true)
          break
        case 'pull': {
          const before = await head(root)
          await checkBusy()
          await git(root, ['pull', '--ff-only', '--no-rebase', '--no-autostash', '--no-recurse-submodules'], true)
          const after = await head(root)
          const count = before === after ? 0 : after ? await countCommits(root, before, after) : null
          return { ok: true, outcome: { kind: 'pull', count } }
        }
        case 'push':
          return { ok: true, outcome: await pushBranch(root, checkBusy) }
        case 'stage':
        case 'unstage':
        case 'discard':
          await fileMutation(root, worktree.dir, op, checkBusy)
          break
        case 'stageAll':
          await git(root, ['add', '-A', '--', '.'])
          break
        case 'unstageAll':
          await unstage(root, ['.'])
          break
        case 'stageAndCommit':
          await git(root, ['add', '-A', '--', '.'])
          await checkBusy()
          return { ok: true, outcome: await commit(root, op.message) }
        case 'commit':
          return { ok: true, outcome: await commit(root, op.message) }
      }
      return { ok: true }
    } catch (error) {
      return gitFailure(error)
    }
  })
  writes.set(root, next)
  try {
    return await next
  } finally {
    if (writes.get(root) === next) writes.delete(root)
  }
}
