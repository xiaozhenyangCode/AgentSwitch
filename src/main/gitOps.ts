import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants, realpathSync } from 'node:fs'
import { lstat, open, realpath, rename, stat, unlink } from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { GitBranch, GitCommandLogEntry, GitCommit, GitConflictFile, GitGraphCommit, GitGraphData, GitGraphOptions, GitGraphRef, GitHeadCommit, GitInProgressOp, GitMutation, GitMutationResult, GitPullStrategy, GitRemote, GitResult, GitStashEntry, GitStatus, GitTag } from '@shared/types'
import { applyConflictChoice, inspectGitConflicts } from '@shared/gitConflicts'
import { classifyGitError } from '@shared/gitErrors'
import { matchesGitCommit, normalizeGitCommitQuery } from '@shared/gitCommitMatch'
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
    'GIT_CONFIG_COUNT', 'GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS'
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

function gitArgs(args: string[], network = false): string[] {
  // Stash uses its own internal :/ pathspec when saving or restoring the index.
  // AgentSwitch passes stash options and refs only. File operations use literal paths.
  return ['-c', 'core.quotepath=off', '--no-optional-locks', ...(args[0] === 'stash' ? [] : ['--literal-pathspecs']),
    ...(network ? ['-c', 'credential.interactive=false', '-c', 'protocol.ext.allow=never'] : []), ...args]
}

const logCapacity = 200
const logFieldLimit = 4_096
const logCaptureLimit = 4 * logFieldLimit
const extraHeaderAssignment = /\bhttp(?:\.[^\s=\0]*)?\.extraheader\s*=(.+)/i
const commandLog: ({ entry: GitCommandLogEntry; repoKey: string } | undefined)[] = new Array(logCapacity)
const logRoots = new Map<string, string>()
let nextCommand = 0
let lastCommandId = 0

export function redactGitSecrets(value: string): string {
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#\0]*@/gi, '$1***@')
    .replace(/(\b(?:proxy-)?authorization\s*:\s*)[^\r\n\0]*(?:\r?\n[ \t]+[^\r\n\0]*)*/gi, '$1***')
    .replace(/(\bhttp(?:\.[^\s=\0]*)?\.extraheader\s*=)[^\r\n\0]*/gi, '$1***')
    .replace(/([?&](?:access[_-]?token|private[_-]?token|token|auth|password|api[_-]?key|signature|x-amz-credential|x-amz-signature)=)[^&#\s\0]*/gi, '$1***')
    .replace(/(?:gh[pousr]_|github_pat_|glpat-|gldt-|xox[baprs]-|ATATT)[a-z0-9_.-]+/gi, '***')
}

function logOutput(output: Buffer, headers: string[] = []): string {
  let sample = output.subarray(0, logCaptureLimit).toString()
  // A clipped field may be missing the delimiter used to identify a credential.
  if (output.length >= logCaptureLimit) sample = sample.slice(0, Math.max(0, sample.lastIndexOf('\n'), sample.lastIndexOf('\0')))
  for (const header of headers) sample = sample.replaceAll(header, '***')
  const redacted = redactGitSecrets(sample)
  return output.length >= logCaptureLimit || redacted.length > logFieldLimit
    ? redacted.slice(0, logFieldLimit - 1) + '…' : redacted
}

function recordGit(cwd: string, args: string[], started: number, exitCode: number | null, ok: boolean, stdout: Buffer, stderr: Buffer) {
  let realDir = cwd
  try { realDir = realpathSync.native(cwd) } catch { /* A command can finish after its cwd has been removed. */ }
  if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
    logRoots.delete(realDir)
    const root = stdout.toString().replace(/\n$/, '')
    if (ok && isAbsolute(root) && isInside(root, realDir)) {
      logRoots.set(realDir, root)
      if (logRoots.size > logCapacity) {
        const first = logRoots.keys().next()
        if (!first.done) logRoots.delete(first.value)
      }
    }
  }
  const repoPath = logRoots.get(realDir) ?? realDir
  const headers = args.flatMap((arg) => {
    const match = extraHeaderAssignment.exec(arg)
    return match ? [match[1].trim()] : []
  }).filter(Boolean)
  const readsExtraHeader = args.includes('config') && args.some((arg) => /^http(?:\.[^\s=\0]*)?\.extraheader$/i.test(arg))
  const entry: GitCommandLogEntry = {
    id: ++lastCommandId, timestamp: started, repoPath: redactGitSecrets(repoPath), args: args.map((arg) => redactGitSecrets(arg).slice(0, logFieldLimit)),
    durationMs: Math.max(0, Date.now() - started), exitCode, ok,
    stdout: readsExtraHeader && stdout.length ? '***' : logOutput(stdout, headers), stderr: logOutput(stderr, headers)
  }
  commandLog[nextCommand] = { entry, repoKey: gitRepoKey(repoPath) }
  nextCommand = (nextCommand + 1) % logCapacity
}

const gitRepoKey = (path: string) => createHash('sha256').update(path).digest('hex')

export async function gitCommandLog(dir?: unknown): Promise<GitCommandLogEntry[]> {
  const entries = [...commandLog.slice(nextCommand), ...commandLog.slice(0, nextCommand)].reverse()
  const worktree = dir == null ? null : await gitWorktree(dir, true)
  if (dir != null && !worktree) return []
  const keys = worktree && new Set([gitRepoKey(worktree.root), gitRepoKey(worktree.dir)])
  return entries.flatMap((record) => record && (!keys || keys.has(record.repoKey))
    ? [{ ...record.entry, args: [...record.entry.args] }] : [])
}

export function clearGitCommandLog(): void {
  commandLog.fill(undefined)
  nextCommand = 0
}

/** Visits NUL-delimited output without buffering it all. Returning false stops Git early. */
export function visitGitRecords(cwd: string, args: string[], visit: (record: string) => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const child = spawn('git', gitArgs(args), {
      cwd, env: gitEnv(false), stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000
    })
    const decoder = new StringDecoder()
    let stdout: Buffer = Buffer.alloc(0)
    let stderr: Buffer = Buffer.alloc(0)
    const capture = (sample: Buffer, chunk: Buffer) => sample.length < logCaptureLimit
      ? Buffer.concat([sample, chunk.subarray(0, logCaptureLimit - sample.length)]) : sample
    let tail = ''
    let stopped = false
    let failure: Error | undefined
    child.stdout.on('data', (chunk: Buffer) => {
      if (stopped) return
      stdout = capture(stdout, chunk)
      const data = tail + decoder.write(chunk)
      let start = 0
      for (let end = data.indexOf('\0'); end !== -1; end = data.indexOf('\0', start)) {
        if (!visit(data.slice(start, end))) {
          stopped = true
          child.kill()
          return
        }
        start = end + 1
      }
      tail = data.slice(start)
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr = capture(stderr, chunk) })
    child.on('error', (error) => { failure = error })
    child.on('close', (code) => {
      const ok = stopped || code === 0
      recordGit(cwd, args, started, code, ok, stdout, stderr)
      if (ok) resolve()
      else reject(new Error(logOutput(stderr).trim() || failure?.message || `Git ${args[0]} failed.`))
    })
  })
}

export function gitBytes(cwd: string, args: string[], options: {
  network?: boolean; timeout?: number; env?: NodeJS.ProcessEnv; input?: Buffer; maxBuffer?: number
} = {}): Promise<Buffer> {
  const { network = false, timeout = 15_000, env, input, maxBuffer = 4 * 1024 * 1024 } = options
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const child = execFile('git', gitArgs(args, network), {
      cwd, env: { ...gitEnv(network), ...env }, encoding: 'buffer', maxBuffer, timeout
    }, (err, stdout, stderr) => {
      recordGit(cwd, args, started, err ? typeof err.code === 'number' ? err.code : null : 0, !err, stdout, stderr)
      if (!err) return resolve(stdout)
      const output = ['push', 'merge', 'pull', 'stash', 'rebase', 'cherry-pick', 'revert'].includes(args[0])
        ? [logOutput(stderr).trim(), logOutput(stdout).trim()].filter(Boolean).join('\n')
        : logOutput(stderr).trim()
      const detail = output.slice(0, 4_000)
      reject(new Error(detail || (err.killed ? 'Git command timed out.' : `Git ${args[0]} failed${err.code == null ? '.' : ` (${err.code}).`}`), { cause: { code: err.code } }))
    })
    child.stdin?.on('error', () => { /* The command callback reports early exits. */ })
    child.stdin?.end(input)
  })
}

export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}

export async function gitWorktree(dir: unknown, reportErrors = false): Promise<{ root: string; dir: string } | null> {
  if (typeof dir !== 'string' || dir.includes('\0') || !isAbsolute(dir)) return null
  try {
    const canonicalDir = await realpath(dir)
    if (!(await stat(canonicalDir)).isDirectory()) return null
    const top = await git(canonicalDir, ['rev-parse', '--show-toplevel'])
    const root = await realpath(top.replace(/\n$/, ''))
    return isInside(root, canonicalDir) ? { root, dir: canonicalDir } : null
  } catch (error) {
    if (reportErrors && error instanceof Error
      && !['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
      && !/not a git repository|must be run in a work tree/i.test(error.message)) throw error
    return null
  }
}

export function parseStatus(output: string) {
  const tokens = output.split('\0')
  const files: { xy: string; path: string; oldPath?: string; staged: boolean; unstaged: boolean; conflicted: boolean }[] = []
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i]
    if (entry.length < 4) continue
    const xy = entry.slice(0, 2)
    const conflicted = /^(?:[ADU]U|U[AD]|AA|DD)$/.test(xy)
    const oldPath = /[RC]/.test(xy) ? tokens[++i] : undefined
    files.push({
      xy, path: entry.slice(3), oldPath,
      conflicted, staged: xy !== '??' && xy[0] !== ' ',
      unstaged: xy[1] !== ' '
    })
  }
  return files
}

const porcelain = ['status', '--porcelain=v1', '-z', '--untracked-files=all']

function currentBranch(root: string): Promise<string | null> {
  return git(root, ['symbolic-ref', '--quiet', 'HEAD']).then((name) => name.trim().slice('refs/heads/'.length), () => null)
}

async function listBranches(root: string, knownRemotes = listRemotes(root)): Promise<GitBranch[]> {
  const [output, remotes] = await Promise.all([
    git(root, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)%00%(symref)', 'refs/heads', 'refs/remotes']),
    knownRemotes
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
class RepositoryBusy extends Error {}
class OperationInProgress extends Error {
  constructor() {
    super('A Git operation is in progress. Finish or abort it first.')
  }
}
class Unmerged extends Error {}

export function gitFailure(error: unknown): Extract<GitResult, { ok: false }> {
  const message = redactGitSecrets(error instanceof Error ? error.message : String(error)).slice(0, 4_000)
  const code = error instanceof InvalidBranch ? 'invalidBranch'
    : error instanceof RepositoryBusy ? 'busy'
    : error instanceof OperationInProgress ? 'operationInProgress'
    : error instanceof Unmerged ? 'unmerged' : classifyGitError(message)
  return { ok: false, error: message, ...(code ? { code } : {}) }
}

const operationsInProgress = ['merge', 'rebase', 'cherry-pick', 'revert'] as const

function lstatIfPresent(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
}

async function gitInProgress(root: string): Promise<GitInProgressOp | null> {
  const gitDir = resolve(root, (await git(root, ['rev-parse', '--git-dir'])).replace(/\n$/, ''))
  const names = ['rebase-merge', 'rebase-apply', 'rebase-apply/applying', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']
  const [rebaseMerge, rebaseApply, am, merge, cherryPick, revert] = await Promise.all(
    names.map((name) => lstatIfPresent(resolve(gitDir, name))))
  // REBASE_HEAD can survive a successful skip in a linked worktree. Git uses the sequencer directories to decide if rebase can continue.
  if (rebaseMerge || (rebaseApply && !am)) return 'rebase'
  if (merge) return 'merge'
  if (revert) return 'revert'
  if (cherryPick) return 'cherry-pick'
  return null
}

export async function gitStatus(dir: unknown): Promise<GitResult<GitStatus>> {
  try {
    const worktree = await gitWorktree(dir, true)
    if (!worktree) return { ok: true, repo: false }
    const { root } = worktree
    const knownRemotes = listRemotes(root)
    const [branch, headCommit, upstream, status, branches, remotes, stashCount, inProgress] = await Promise.all([
      currentBranch(root),
      readHeadCommit(root),
      git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).then((s) => s.trim(), () => null),
      git(root, porcelain),
      listBranches(root, knownRemotes),
      knownRemotes,
      git(root, ['stash', 'list', '--format=%H']).then((output) => output.split('\n').filter(Boolean).length),
      gitInProgress(root)
    ])
    const counts = upstream && headCommit
      ? await git(root, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}', '--'])
      : '0 0'
    if (branch && !branches.some((entry) => entry.remote === null && entry.name === branch)) {
      branches.push({ name: branch, remote: null }) // unborn branch
    }
    const [ahead, behind] = counts.trim().split(/\s+/).map(Number)
    const files = parseStatus(status)
    return {
      ok: true, repo: true, repoPath: root, branch, detached: branch ? null : headCommit?.shortHash ?? null, upstream, ahead, behind,
      dirty: files.length > 0, staged: files.filter((file) => file.staged && !file.conflicted).length,
      unstaged: files.filter((file) => file.unstaged && !file.conflicted).length,
      untracked: files.filter((file) => file.xy === '??').length,
      conflicts: files.filter((file) => file.conflicted).length,
      atRoot: root === worktree.dir, branches, remotes, stashCount, headCommit, inProgress
    }
  } catch (error) {
    return gitFailure(error)
  }
}

const fullHash = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const commitHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{4,64}$/i.test(value) && !/\s/.test(value)
const logOptions = ['--no-show-signature', '--no-notes', '--no-color', '--encoding=UTF-8']

export async function verifyCommitHash(root: string, hash: unknown): Promise<string> {
  if (!commitHash(hash)) throw new Error('Invalid Git commit hash.')
  const verified = (await git(root, ['rev-parse', '--verify', '--end-of-options', `${hash.toLowerCase()}^{commit}`])).trim()
  if (!fullHash.test(verified) || !verified.startsWith(hash.toLowerCase())) throw new Error('Invalid Git commit hash.')
  return verified
}

async function readHeadCommit(root: string): Promise<GitHeadCommit | null> {
  const hash = await resolveRef(root, 'HEAD')
  if (!hash) return null
  const metadata = await git(root, ['log', '-1', '-z', ...logOptions, '--format=%h%x00%P%x00%s%x00%B', hash, '--'])
  const [shortHash, parents, subject, message] = metadata.split('\0')
  // Git log hides parent edges at a shallow boundary. Treat a shallow tip as non-root.
  const hasParent = !!parents || (await git(root, ['cat-file', 'commit', hash])).split('\n', 2)[1]?.startsWith('parent ')
  return { hash, shortHash, subject, message: message.replace(/\n$/, ''), hasParent: !!hasParent }
}

export function resolveRef(root: string, ref: string): Promise<string | null> {
  return git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', ref])
    .then((output) => output.trim(), (error: Error) => {
      if ((error.cause as { code?: number } | undefined)?.code === 1) return null
      throw error
    })
}

export function isStashRef(ref: unknown): ref is string {
  return typeof ref === 'string' && /^stash@\{\d+\}$/.test(ref) && ref.endsWith('}')
}

export async function gitStashes(dir: unknown): Promise<GitResult<{ stashes: GitStashEntry[] }>> {
  try {
    const worktree = await gitWorktree(dir, true)
    if (!worktree) return gitFailure('This folder is not in a Git worktree.')
    const output = await git(worktree.root, ['stash', 'list', '-z', ...logOptions, '--format=%gd%x00%H%x00%h%x00%ct%x00%gs'])
    const fields = output.split('\0')
    const stashes: GitStashEntry[] = []
    for (let i = 0; i + 4 < fields.length; i += 5) {
      const [ref, hash, shortHash, time, message] = fields.slice(i, i + 5)
      if (!isStashRef(ref)) throw new Error('Invalid Git stash metadata.')
      const branch = /^(?:WIP on|On) ([^:]+):/.exec(message)?.[1]
      stashes.push({ ref, index: Number(ref.slice(7, -1)), hash, shortHash, timestamp: Number(time) * 1000,
        message, branch: !branch || branch === '(no branch)' ? null : branch })
    }
    return { ok: true, stashes }
  } catch (error) {
    return gitFailure(error)
  }
}

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
  try {
    const worktree = await gitWorktree(dir, true)
    if (!worktree) return gitFailure('This folder is not in a Git worktree.')
    const { root } = worktree
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
  const count = Number(readLimit(params.limit, 100, 500))
  const skip = typeof params.skip === 'number' && Number.isSafeInteger(params.skip)
    ? Math.min(2_147_483_647, Math.max(0, params.skip))
    : 0
  const chosenBranch = params.branch
  const query = normalizeGitCommitQuery(params.query)
  const allBranches = chosenBranch == null || chosenBranch === '__ALL__'
  const decorations = [...logOptions, '--decorate=full', '--decorate-refs-exclude=refs/agentswitch/*']
  const fields = '%H%x1f%h%x1f%P%x1f%D%x1f%s%x1f%an%x1f%at'
  const format = [...decorations, `--format=%x1e${fields}`]
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
    let commits: GitGraphCommit[] = []
    let pageSize = 0
    if (revisions.length && query) {
      let skipped = 0
      await visitGitRecords(root, ['log', '--parents', '--topo-order', '-z', ...decorations, `--format=${fields}`, ...revisions, '--'], (record) => {
        const [commit] = parseGraphRecord(record)
        if (!commit || !matchesGitCommit(commit, query)) return true
        if (skipped < skip) {
          skipped++
          return true
        }
        pageSize++
        if (pageSize > count) return false
        commits.push(commit)
        return true
      })
    } else if (revisions.length) {
      const output = await git(root, ['log', '--parents', '--topo-order', '-n', String(count + 1), '--skip', String(skip), ...format, ...revisions, '--'])
      const records = logRecords(output)
      commits = records.slice(0, count).flatMap(parseGraphRecord)
      pageSize = records.length
    }
    let headCommit: GitGraphCommit | undefined
    if (!query && !skip && head && !commits.some((commit) => commit.hash === head)) {
      const headInScope = allBranches || tip === head || (tip && await git(root, ['merge-base', '--is-ancestor', head, tip]).then(() => true, () => false))
      if (headInScope) {
        [headCommit] = parseGitGraph(await git(root, ['log', '-n', '1', ...format, head, '--']))
      }
    }
    const files = parseStatus(status)
    return {
      ok: true, commits, headHash: head, branch, dirty: files.length > 0,
      ...(headCommit ? { headCommit } : {}),
      hasMore: pageSize > count, nextSkip: skip + Math.min(pageSize, count), branches,
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

async function validateRemote(root: string, remote: string) {
  if (remote.startsWith('-') || !(await listRemotes(root)).includes(remote)) {
    throw new Error('Unknown or invalid Git remote.')
  }
}

async function validateRemoteName(root: string, name: string) {
  if (!/^[a-z0-9_][a-z0-9._/-]*$/i.test(name) || /\s/.test(name)) throw new Error('Invalid Git remote name.')
  await git(root, ['check-ref-format', `refs/remotes/${name}/HEAD`])
}

function validateRemoteUrl(url: string) {
  if (!url || url.startsWith('-') || /[\s\x00-\x1f\x7f]/.test(url) || /^[a-z0-9+.-]+::/i.test(url)) {
    throw new Error('Invalid Git remote URL.')
  }
}

function validateTag(root: string, name: string) {
  if (!name || name.startsWith('-') || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Invalid Git tag name.')
  return git(root, ['check-ref-format', `refs/tags/${name}`])
}

export async function gitTags(dir: unknown, remote?: unknown, pushDestination = false): Promise<GitResult<{ tags: GitTag[] }>> {
  try {
    const worktree = await gitWorktree(dir, true)
    if (!worktree) return gitFailure('This folder is not in a Git worktree.')
    const { root } = worktree
    if (remote !== undefined) {
      if (typeof remote !== 'string') throw new Error('Invalid Git remote name.')
      await validateRemoteName(root, remote)
      await validateRemote(root, remote)
      const urls = pushDestination
        ? (await git(root, ['remote', 'get-url', '--push', '--all', '--', remote])).trimEnd().split('\n')
        : [remote]
      const outputs = await Promise.all([...new Set(urls)].map((url) => git(root, ['ls-remote', '--tags', '--', url], true)))
      const tags = new Map<string, GitTag>()
      for (const output of outputs) {
        const refs = new Map(output.split('\n').map((line) => {
          const [hash, ref] = line.split('\t')
          return [ref, hash]
        }))
        for (const [ref, hash] of refs) {
          if (!ref?.startsWith('refs/tags/') || ref.endsWith('^{}') || !fullHash.test(hash)) continue
          const target = refs.get(ref + '^{}')
          const object = target && fullHash.test(target) ? target : hash
          const name = ref.slice('refs/tags/'.length)
          if (!tags.has(name)) tags.set(name, { name, hash: object, shortHash: object.slice(0, 7), annotated: !!target,
            message: '', tagger: '', timestamp: 0 })
        }
      }
      return { ok: true, tags: [...tags.values()].sort((a, b) => a.name.localeCompare(b.name)) }
    }
    const output = await git(root, ['for-each-ref', '--sort=refname',
      '--format=%(refname:strip=2)%00%(objecttype)%00%(objectname)%00%(*objectname)%00%(taggername)%00%(creatordate:unix)%00%(contents)%00',
      'refs/tags'])
    const tags = output.split('\0\n').filter(Boolean).map((line): GitTag => {
      const [name, type, hash, target, tagger, time, contents] = line.split('\0')
      const annotated = type === 'tag'
      const object = target || hash
      return { name, hash: object, shortHash: object.slice(0, 7), annotated, tagger: tagger ?? '',
        timestamp: Number(time) * 1000 || 0, message: annotated ? contents.replace(/\n$/, '') : '' }
    })
    return { ok: true, tags }
  } catch (error) {
    return gitFailure(error)
  }
}

export async function gitRemotes(dir: unknown): Promise<GitResult<{ remotes: GitRemote[] }>> {
  try {
    const worktree = await gitWorktree(dir, true)
    if (!worktree) return gitFailure('This folder is not in a Git worktree.')
    const { root } = worktree
    const names = (await listRemotes(root)).sort()
    const remotes = await Promise.all(names.map(async (name) => {
      const [fetchUrl, pushUrl] = await Promise.all([
        git(root, ['remote', 'get-url', '--', name]),
        git(root, ['remote', 'get-url', '--push', '--', name])
      ])
      return { name, fetchUrl: fetchUrl.replace(/\n$/, ''), pushUrl: pushUrl.replace(/\n$/, '') }
    }))
    return { ok: true, remotes }
  } catch (error) {
    return gitFailure(error)
  }
}

async function branchRef(root: string, name: string, remote: string | null) {
  await validateBranch(root, name)
  if (remote !== null) {
    await validateRemote(root, remote)
    if (!name.startsWith(remote + '/')) throw new Error('Invalid remote branch.')
    await validateBranch(root, name.slice(remote.length + 1))
  }
  const ref = (remote === null ? 'refs/heads/' : 'refs/remotes/') + name
  await git(root, ['show-ref', '--verify', '--', ref])
  return ref
}

/** Accept a symlink as the file itself, never as a directory leading to it. */
async function validatePath(root: string, dir: string, path: string): Promise<string> {
  const parts = sep === '\\' ? path.split(/[\\/]/) : path.split('/')
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
  return relative(root, abs).split(sep).join('/')
}

const conflictFileLimit = 512 * 1024

async function readConflictSnapshot(abs: string) {
  const entry = await lstatIfPresent(abs)
  if (!entry) return { missing: true } as const
  if (!entry.isFile()) return { binary: true, nonRegular: true } as const
  const handle = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (!info.isFile()) return { binary: true, nonRegular: true } as const
    if (info.size > conflictFileLimit) return { truncated: true } as const
    const buffer = Buffer.alloc(info.size + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    const after = await handle.stat()
    if (length !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) {
      throw new Error('The conflict file changed. Reload it and try again.')
    }
    const bytes = buffer.subarray(0, length)
    if (bytes.includes(0)) return { binary: true } as const
    let content: string
    try {
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
      return { binary: true } as const
    }
    return { content, version: createHash('sha256').update(bytes).digest('hex'), info }
  } finally {
    await handle.close()
  }
}

async function requireUnmergedPath(root: string, path: string) {
  const output = await git(root, ['ls-files', '--unmerged', '-z', '--', path])
  if (!output.split('\0').some((record) => record.slice(record.indexOf('\t') + 1) === path)) {
    throw new Error('This file is no longer unmerged.')
  }
}

async function ensureNoUnmerged(root: string) {
  if (await git(root, ['ls-files', '--unmerged', '-z'])) throw new Unmerged('Resolve and stage the unmerged files first.')
}

export async function gitConflictFile(dir: unknown, path: unknown, repoRelative = false): Promise<GitResult<{ file: GitConflictFile }>> {
  try {
    const worktree = await gitWorktree(dir, true)
    if (!worktree || typeof path !== 'string') return gitFailure('Invalid Git conflict file.')
    const rel = await validatePath(worktree.root, repoRelative ? worktree.root : worktree.dir, path)
    await requireUnmergedPath(worktree.root, rel)
    const abs = resolve(worktree.root, rel)
    const snapshot = await readConflictSnapshot(abs)
    const { hunks, malformed } = 'content' in snapshot && snapshot.content !== undefined
      ? inspectGitConflicts(snapshot.content) : { hunks: [], malformed: false }
    return { ok: true, file: { path, abs, hunks, unresolvedCount: hunks.length, malformed,
      binary: snapshot.binary ?? false, truncated: snapshot.truncated ?? false, missing: snapshot.missing,
      nonRegular: snapshot.nonRegular, version: snapshot.version } }
  } catch (error) {
    return gitFailure(error)
  }
}

type ConflictMutation = Extract<GitMutation, { kind: 'resolveConflict' | 'markResolved' }>

async function resolveConflict(root: string, dir: string, op: ConflictMutation, checkBusy: () => Promise<void>) {
  const path = await validatePath(root, op.repoRelative ? root : dir, op.path)
  await requireUnmergedPath(root, path)
  const abs = resolve(root, path)
  if (op.kind === 'markResolved') {
    const entry = await lstatIfPresent(abs)
    if (entry?.isDirectory()) throw new Error('Resolve this file path in an external editor.')
    if (op.expectedVersion && (await readConflictSnapshot(abs)).version !== op.expectedVersion) {
      throw new Error('The conflict file changed. Reload it and try again.')
    }
    await checkBusy()
    await git(root, [entry ? 'add' : 'rm', '--', path])
    return
  }
  const snapshot = await readConflictSnapshot(abs)
  if (snapshot.content === undefined) throw new Error('Open this file in an external editor to resolve it.')
  if (op.expectedVersion && op.expectedVersion !== snapshot.version) throw new Error('The conflict file changed. Reload it and try again.')
  const updated = applyConflictChoice(snapshot.content, op.hunkIndex ?? 'all', op.choice)
  if (updated !== snapshot.content) {
    // Replace the path atomically so an interrupted write never truncates the worktree file.
    const temp = resolve(dirname(abs), `.agentswitch-conflict-${randomUUID()}`)
    const mode = snapshot.info.mode & 0o777
    const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode)
    try {
      try {
        await handle.writeFile(updated, 'utf8')
        await handle.chmod(mode)
      } finally {
        await handle.close()
      }
      await checkBusy()
      await validatePath(root, root, path)
      const current = await lstatIfPresent(abs)
      const original = snapshot.info
      if (!current?.isFile() || current.dev !== original.dev || current.ino !== original.ino
        || current.mtimeMs !== original.mtimeMs || current.ctimeMs !== original.ctimeMs || current.size !== original.size) {
        throw new Error('The conflict file changed. Reload it and try again.')
      }
      await rename(temp, abs)
    } finally {
      await unlink(temp).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
    }
  }
  const remaining = inspectGitConflicts(updated)
  if (op.stageIfComplete && !remaining.malformed && !remaining.hunks.length) {
    await checkBusy()
    await git(root, ['add', '--', path])
  }
}

async function unstage(root: string, paths: string[]) {
  const hasHead = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '')
  // An unborn branch has no HEAD tree for git restore to use.
  await git(root, hasHead
    ? ['restore', '--staged', '--', ...paths]
    : ['rm', '--cached', '-r', '-f', '--ignore-unmatch', '--', ...paths])
}

type FileMutation = Extract<GitMutation, { kind: 'stage' | 'unstage' | 'discard' }>

async function fileMutation(root: string, dir: string, op: FileMutation, checkBusy: () => Promise<void>) {
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

async function ignorePath(root: string, dir: string, op: Extract<GitMutation, { kind: 'ignore' }>, checkBusy: () => Promise<void>) {
  const path = await validatePath(root, dir, op.path)
  const escape = (value: string) => value.replace(/[\\*?[\] #!]/g, '\\$&')
  const parent = path.slice(0, path.lastIndexOf('/'))
  const extension = extname(path)
  const value = op.mode === 'dir' ? parent : op.mode === 'ext' ? extension : path
  if (!value || /[\r\n]/.test(value)) throw new Error('This path cannot be represented by the selected .gitignore rule.')
  const rule = op.mode === 'ext' ? '*' + escape(value) : '/' + escape(value) + (op.mode === 'dir' ? '/' : '')
  const target = resolve(root, '.gitignore')
  const entry = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  // Git ignores a symlinked .gitignore. O_NOFOLLOW also protects against a swap before open.
  if (entry && !entry.isFile()) throw new Error('.gitignore must be a regular file inside the Git worktree.')
  await checkBusy()
  const file = await open(target, constants.O_CREAT | constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (!(await file.stat()).isFile()) throw new Error('.gitignore must be a regular file inside the Git worktree.')
    const contents = await file.readFile('utf8')
    if (contents.split(/\r?\n/).includes(rule)) return
    const newline = contents.includes('\r\n') ? '\r\n' : '\n'
    await file.appendFile((contents && !contents.endsWith('\n') ? newline : '') + rule + newline)
  } finally {
    await file.close()
  }
}

async function branchTracking(root: string, branch: string) {
  const source = 'refs/heads/' + branch
  const output = await git(root, ['for-each-ref', '--format=%(refname)%00%(upstream:remotename)%00%(upstream:remoteref)', source])
  const [, remote, ref] = output.split('\n').find((line) => line.startsWith(source + '\0'))?.split('\0') ?? []
  if (remote) {
    if (!ref?.startsWith('refs/heads/')) throw new Error('The upstream is not a remote branch.')
    await validateBranch(root, ref.slice('refs/heads/'.length))
  }
  return { remote, ref }
}

async function pushBranch(root: string, forceWithLease: boolean | undefined, checkBusy: () => Promise<void>) {
  const branch = await currentBranch(root)
  if (!branch) throw new Error('Cannot push from a detached HEAD.')
  await validateBranch(root, branch)
  const source = 'refs/heads/' + branch
  const { remote: upstreamRemote, ref: upstreamRef } = await branchTracking(root, branch)
  const remote = upstreamRemote || 'origin'
  if (!upstreamRemote && !(await listRemotes(root)).includes(remote)) throw new Error('No push remote is available for this branch.')
  await validateRemote(root, remote)
  // An explicit refspec prevents configured push refspecs from forcing updates or touching other refs.
  await checkBusy()
  const output = await git(root, ['push', '--porcelain', '--no-mirror', '--no-follow-tags', '--recurse-submodules=no',
    ...(!upstreamRemote ? ['-u'] : []), ...(forceWithLease ? ['--force-with-lease'] : []),
    '--', remote, source + ':' + (upstreamRef || source)], true)
  const line = output.split('\n').find((row) => /^[ =*+]\t/.test(row))
  const range = line?.split('\t')[2]?.match(/^([a-f\d]+)\.{2,3}([a-f\d]+)(?:\s|$)/i)
  // Use the range accepted by the remote, which may differ from the last fetched upstream.
  const count = line?.startsWith('=') ? 0 : range ? await countCommits(root, range[1], range[2]) : null
  const target = remote + '/' + (upstreamRef || source).slice('refs/heads/'.length)
  return { kind: 'push' as const, target, count, published: !upstreamRemote, ...(line?.startsWith('+') ? { forced: true } : {}) }
}

async function countCommits(root: string, before: string, after: string): Promise<number | null> {
  const result = await git(root, ['rev-list', '--count', before ? before + '..' + after : after, '--']).catch(() => '')
  return result ? Number(result.trim()) : null
}

function pathParents(path: string): string[] {
  const parents: string[] = []
  for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) {
    parents.push(path.slice(0, slash))
  }
  return parents
}

/** Local paths (original names for renames) that the incoming commits would touch, including file/directory collisions. */
async function overlappingPullPaths(root: string, before: string | null, target: string): Promise<string[]> {
  const base = before
    ? await git(root, ['merge-base', before, target]).then((sha) => sha.trim(), (error) => {
      if (error.cause?.code === 1) return ''
      throw error
    })
    : ''
  // An unborn HEAD (or unrelated history) has no base tree. Comparing with the whole remote tree still protects local files.
  const incomingArgs = base
    ? ['diff', '--name-only', '-z', '--no-renames', base, target, '--']
    : ['ls-tree', '-r', '--name-only', '-z', target, '--']
  const [incoming, local, ignoreCase] = await Promise.all([
    git(root, incomingArgs),
    git(root, porcelain),
    git(root, ['config', '--bool', '--default', 'false', 'core.ignorecase'])
  ])
  const caseInsensitive = ignoreCase.trim() === 'true'
  const normalize = (path: string) => caseInsensitive ? path.toLowerCase() : path
  const remotePaths = new Set(incoming.split('\0').filter(Boolean).map(normalize))
  const remoteParents = new Set([...remotePaths].flatMap(pathParents))
  const overlaps = new Set<string>()
  for (const { path, oldPath } of parseStatus(local)) {
    for (const localPath of [path, oldPath]) {
      if (!localPath) continue
      const key = normalize(localPath)
      if (remotePaths.has(key) || remoteParents.has(key) || pathParents(key).some((parent) => remotePaths.has(parent))) {
        overlaps.add(localPath)
      }
    }
  }
  return [...overlaps].sort()
}

async function pullBranch(root: string, strategy: GitPullStrategy = 'ff-only', checkBusy: () => Promise<void>): Promise<GitMutationResult> {
  const branch = await currentBranch(root)
  if (!branch) throw new Error('No upstream branch is configured for this HEAD.')
  await validateBranch(root, branch)
  const { remote, ref } = await branchTracking(root, branch)
  if (!remote || !ref) throw new Error('No upstream branch is configured for this branch.')
  await validateRemote(root, remote)
  await checkBusy()
  await git(root, ['fetch', '--no-recurse-submodules', '--', remote, ref], true)
  const [before, upstream] = await Promise.all([resolveRef(root, 'HEAD'), resolveRef(root, '@{u}')])
  if (!upstream) throw new Error('No upstream branch was found after fetching.')
  if (before === upstream) return { ok: true, outcome: { kind: 'pull', count: 0 } }
  const conflictFiles = await overlappingPullPaths(root, before, upstream)
  if (conflictFiles.length) {
    return { ok: false, code: 'pullConflict', error: 'Pull canceled because incoming changes overlap local changes.', conflictFiles }
  }
  const [currentHead, checkedOut, operation] = await Promise.all([resolveRef(root, 'HEAD'), currentBranch(root), gitInProgress(root)])
  if (operation) throw new OperationInProgress()
  if (currentHead !== before || checkedOut !== branch) {
    throw new Error('The checked-out branch changed during Pull. Refresh and try again.')
  }
  await checkBusy()
  const flags = strategy === 'ff-only' ? ['--ff-only', '--no-rebase'] : ['--ff', strategy === 'rebase' ? '--rebase' : '--no-rebase']
  // Integrate exactly the commit checked above. A second network fetch could advance the target.
  await gitBytes(root, ['-c', 'submodule.recurse=false', 'pull', ...flags, '--no-autostash', '--no-tags', '--no-recurse-submodules', '--', '.', upstream], {
    network: true, timeout: 120_000, env: { GIT_MERGE_AUTOEDIT: 'no' }
  })
  const after = await resolveRef(root, 'HEAD')
  const count = before === after ? 0 : after ? await countCommits(root, before ?? '', after) : null
  return { ok: true, outcome: { kind: 'pull', count } }
}

async function commit(root: string, message: string, amend?: boolean) {
  await git(root, ['commit', ...(amend ? ['--amend'] : []), '-m', message], false, 120_000)
  const metadata = await git(root, ['log', '-1', ...logOptions, '--format=%h%x00%s', 'HEAD', '--'])
  const [sha, subject] = metadata.trimEnd().split('\0')
  return { kind: 'commit' as const, sha, subject: subject ?? message.trim().split('\n')[0] }
}

function isMutation(value: unknown): value is GitMutation {
  if (!value || typeof value !== 'object' || !('kind' in value)) return false
  const op = value as GitMutation
  const optionalBoolean = (v: unknown) => v === undefined || typeof v === 'boolean'
  const stringOrNull = (v: unknown) => v === null || typeof v === 'string'
  const optionalText = (v: unknown) => v === undefined || (typeof v === 'string' && !v.includes('\0'))
  const optionalHash = (v: unknown) => v === undefined || commitHash(v)
  const optionalVersion = (v: unknown) => v === undefined || (typeof v === 'string' && v.length === 64 && /^[a-f0-9]{64}$/.test(v))
  switch (op.kind) {
    case 'switch': return typeof op.name === 'string' && stringOrNull(op.remote) && optionalBoolean(op.autoStash)
    case 'createBranch': return typeof op.name === 'string' && optionalHash(op.startPoint)
    case 'renameBranch': return typeof op.oldName === 'string' && typeof op.newName === 'string'
    case 'deleteBranch': return typeof op.name === 'string' && optionalBoolean(op.force)
    case 'deleteRemoteBranch': return typeof op.remote === 'string' && typeof op.branch === 'string'
    case 'setUpstream': return (op.branch === undefined || typeof op.branch === 'string') && stringOrNull(op.upstream)
    case 'merge': return typeof op.branch === 'string' && stringOrNull(op.remote) && ['default', 'no-ff', 'squash'].includes(op.mode)
    case 'stage':
    case 'unstage': return typeof op.path === 'string'
    case 'discard': return typeof op.path === 'string' && typeof op.untracked === 'boolean'
    case 'ignore': return typeof op.path === 'string' && ['file', 'dir', 'ext'].includes(op.mode)
    case 'stageAndCommit':
    case 'commit': return typeof op.message === 'string' && !!op.message.trim() && !op.message.includes('\0') && optionalBoolean(op.amend)
    case 'fetch': return optionalBoolean(op.prune)
    case 'pull': return op.strategy === undefined || ['ff-only', 'merge', 'rebase'].includes(op.strategy)
    case 'push': return optionalBoolean(op.forceWithLease)
    case 'stashPush': return optionalBoolean(op.includeUntracked) && optionalBoolean(op.keepIndex)
      && (op.message === undefined || (typeof op.message === 'string' && !op.message.includes('\0')))
    case 'stashApply':
    case 'stashPop':
    case 'stashDrop': return isStashRef(op.ref) && (op.expectedHash === undefined || (typeof op.expectedHash === 'string' && fullHash.test(op.expectedHash)))
    case 'stashBranch': return isStashRef(op.ref) && typeof op.name === 'string'
      && (op.expectedHash === undefined || (typeof op.expectedHash === 'string' && fullHash.test(op.expectedHash)))
    case 'checkoutCommit':
    case 'cherryPick': return commitHash(op.hash)
    case 'revert': return commitHash(op.hash) && (op.mainline === undefined || (Number.isSafeInteger(op.mainline) && op.mainline > 0))
    case 'reset': return commitHash(op.hash) && ['soft', 'mixed', 'hard'].includes(op.mode)
    case 'continueOperation':
    case 'skipOperation':
    case 'abortOperation': return op.expectedOperation === undefined || operationsInProgress.includes(op.expectedOperation)
    case 'resolveConflict': return typeof op.path === 'string' && ['current', 'incoming', 'both'].includes(op.choice)
      && (op.hunkIndex === undefined || (Number.isSafeInteger(op.hunkIndex) && op.hunkIndex >= 0))
      && optionalBoolean(op.repoRelative) && optionalBoolean(op.stageIfComplete) && optionalVersion(op.expectedVersion)
    case 'markResolved': return typeof op.path === 'string' && optionalBoolean(op.repoRelative) && optionalVersion(op.expectedVersion)
    case 'createTag': return typeof op.name === 'string' && optionalHash(op.target) && optionalText(op.message)
    case 'deleteTag':
    case 'removeRemote': return typeof op.name === 'string'
    case 'deleteRemoteTag': return typeof op.remote === 'string' && typeof op.name === 'string'
    case 'pushTag': return typeof op.remote === 'string' && optionalBoolean(op.all)
      && (op.all ? op.name === undefined : typeof op.name === 'string')
    case 'addRemote': return typeof op.name === 'string' && typeof op.url === 'string'
    case 'setRemoteUrl': return typeof op.name === 'string' && typeof op.url === 'string' && optionalText(op.pushUrl)
    case 'stageAll':
    case 'stageTracked':
    case 'stageUntracked':
    case 'unstageAll':
    case 'discardAll':
    case 'cleanAll':
    case 'undoLastCommit':
    case 'stashClear': return true
    default: return false
  }
}

async function stashPush(root: string, options: Omit<Extract<GitMutation, { kind: 'stashPush' }>, 'kind'>, checkBusy: () => Promise<void>) {
  if (!(await resolveRef(root, 'HEAD'))) throw new Error('Create the first commit before stashing changes.')
  const before = await resolveRef(root, 'refs/stash')
  await checkBusy()
  const output = await git(root, ['stash', 'push',
    ...(options.includeUntracked ? ['--include-untracked'] : []),
    ...(options.keepIndex ? ['--keep-index'] : []),
    ...(options.message?.trim() ? ['-m', options.message] : [])])
  const after = await resolveRef(root, 'refs/stash')
  if (after === before && /^No local changes to save\s*$/.test(output.trim())) return null
  if (!after) throw new Error('Git could not verify the saved stash.')
  return after
}

async function switchBranch(root: string, op: Extract<GitMutation, { kind: 'switch' }>, checkBusy: () => Promise<void>) {
  const ref = await branchRef(root, op.name, op.remote)
  const previousBranch = op.autoStash ? await currentBranch(root) : null
  const previousHead = op.autoStash ? await resolveRef(root, 'HEAD') : null
  const stashed = op.autoStash ? await stashPush(root, { includeUntracked: true }, checkBusy) : null
  try {
    await checkBusy()
    await git(root, ['switch', '--no-guess', '--no-recurse-submodules',
      ...(op.remote === null ? ['--', op.name] : ['--track', '--', ref])])
  } catch (error) {
    if (stashed) {
      try {
        await checkBusy()
        if (await currentBranch(root) !== previousBranch || await resolveRef(root, 'HEAD') !== previousHead) {
          throw new Error('Checkout changed HEAD. The saved changes are still stashed.')
        }
        if (await resolveRef(root, 'refs/stash') !== stashed) throw new Error('The stash list changed. The saved changes are still stashed.')
        await git(root, ['stash', 'pop', '--index', '--', 'stash@{0}'])
      } catch (rollback) {
        throw new Error(errorMessage(error) + '\nCould not restore the automatic stash (' + stashed.slice(0, 12) + '): ' + errorMessage(rollback))
      }
    }
    throw error
  }
  return { kind: 'switch' as const, branch: await currentBranch(root) ?? op.name }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

async function checkStashSelection(root: string, ref: string, expectedHash?: string) {
  if (expectedHash && await resolveRef(root, ref) !== expectedHash) {
    throw new Error('The stash list changed. Refresh it and select the stash again.')
  }
}

async function updateUpstream(root: string, op: Extract<GitMutation, { kind: 'setUpstream' }>, checkBusy: () => Promise<void>) {
  const branch = op.branch ?? await currentBranch(root)
  if (!branch) throw new Error('No local branch is checked out.')
  await validateBranch(root, branch)
  if (op.upstream === null) {
    await checkBusy()
    await git(root, ['branch', '--unset-upstream', '--', branch])
    return
  }
  const upstream = op.upstream
  const remote = (await listRemotes(root)).find((name) => upstream.startsWith(name + '/'))
  if (!remote) throw new Error('Unknown Git upstream branch.')
  const ref = await branchRef(root, upstream, remote)
  await checkBusy()
  await git(root, ['branch', '--set-upstream-to=' + ref, '--', branch])
}

const writes = new Map<string, Promise<GitMutationResult>>()
const bulkChanges = new Set<GitMutation['kind']>(['stageAll', 'stageTracked', 'stageAndCommit', 'unstageAll', 'discardAll'])
const blockedDuringOperation = new Set<GitMutation['kind']>(['switch', 'createBranch', 'pull', 'push', 'commit', 'stageAndCommit', 'merge', 'checkoutCommit', 'cherryPick', 'revert', 'stashBranch'])

export async function gitMutate(dir: unknown, op: unknown, isBusy?: (root: string) => boolean | Promise<boolean>, busyMessage?: string): Promise<GitMutationResult> {
  if (!isMutation(op)) return gitFailure('Invalid Git operation.')
  let worktree: Awaited<ReturnType<typeof gitWorktree>>
  try {
    worktree = await gitWorktree(dir, true)
  } catch (error) {
    return gitFailure(error)
  }
  if (!worktree) return gitFailure('This folder is not in a Git worktree.')
  const { root } = worktree
  const next = (writes.get(root) ?? Promise.resolve()).then(async (): Promise<GitMutationResult> => {
    try {
      const checkBusy = async () => {
        if (await isBusy?.(root)) throw new RepositoryBusy(busyMessage ?? 'The repository is busy.')
      }
      await checkBusy()
      if (blockedDuringOperation.has(op.kind)) {
        const committing = op.kind === 'commit' || op.kind === 'stageAndCommit'
        const operation = await gitInProgress(root)
        // A conflicted merge is concluded by committing; every other operation finishes with continue/skip/abort.
        if (operation && (!committing || operation !== 'merge')) throw new OperationInProgress()
      }
      if (bulkChanges.has(op.kind) || op.kind === 'commit') {
        await ensureNoUnmerged(root)
        await checkBusy()
      }
      switch (op.kind) {
        case 'switch':
          return { ok: true, outcome: await switchBranch(root, op, checkBusy) }
        case 'createBranch': {
          await validateBranch(root, op.name)
          const start = op.startPoint ? [await verifyCommitHash(root, op.startPoint)] : []
          await checkBusy()
          await git(root, ['switch', '--no-recurse-submodules', '-c', op.name, ...start])
          return { ok: true, outcome: { kind: 'createBranch', branch: op.name } }
        }
        case 'checkoutCommit':
        case 'cherryPick':
        case 'revert':
        case 'reset': {
          const hash = await verifyCommitHash(root, op.hash)
          if (op.kind === 'revert' && op.mainline !== undefined) {
            const commit = await git(root, ['cat-file', 'commit', hash])
            const parents = commit.split('\n\n', 1)[0].split('\n').filter((line) => line.startsWith('parent '))
            if (op.mainline > parents.length || parents.length < 2) throw new Error('Invalid mainline parent for this merge commit.')
          }
          const args = op.kind === 'checkoutCommit' ? ['switch', '--detach', '--no-recurse-submodules', hash]
            : op.kind === 'cherryPick' ? ['cherry-pick', hash]
              : op.kind === 'reset' ? ['reset', `--${op.mode}`, hash, '--']
                : ['revert', '--no-edit', ...(op.mainline === undefined ? [] : ['-m', String(op.mainline)]), hash]
          await checkBusy()
          await git(root, args, false, 120_000)
          break
        }
        case 'continueOperation':
        case 'skipOperation':
        case 'abortOperation': {
          const operation = await gitInProgress(root)
          if (!operation || (op.expectedOperation && op.expectedOperation !== operation)) {
            throw new Error('The Git operation changed. Refresh the repository status and try again.')
          }
          if (operation === 'merge' && op.kind === 'skipOperation') throw new Error('Git merge does not support skipping.')
          if (op.kind === 'continueOperation') await ensureNoUnmerged(root)
          const flag = op.kind === 'continueOperation' ? '--continue' : op.kind === 'skipOperation' ? '--skip' : '--abort'
          await checkBusy()
          await gitBytes(root, [operation, flag], { timeout: 120_000, env: { GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no' } })
          break
        }
        case 'resolveConflict':
        case 'markResolved':
          await resolveConflict(root, worktree.dir, op, checkBusy)
          break
        case 'createTag':
        case 'deleteTag': {
          await validateTag(root, op.name)
          const target = op.kind === 'createTag' && op.target ? [await verifyCommitHash(root, op.target)] : []
          const args = op.kind === 'deleteTag' ? ['tag', '--delete', '--', op.name]
            : ['tag', '--no-sign', ...(op.message?.trim() ? ['--annotate', '-m', op.message] : []), '--', op.name, ...target]
          await checkBusy()
          await git(root, args, false, 120_000)
          break
        }
        case 'pushTag':
        case 'deleteRemoteTag': {
          await validateRemoteName(root, op.remote)
          await validateRemote(root, op.remote)
          if (op.name !== undefined) await validateTag(root, op.name)
          const options = op.kind === 'deleteRemoteTag' ? ['--delete'] : op.all ? ['--tags'] : []
          await checkBusy()
          await git(root, ['push', '--no-mirror', '--no-follow-tags', '--recurse-submodules=no',
            ...options, '--', op.remote, ...(op.name === undefined ? [] : ['refs/tags/' + op.name])], true)
          break
        }
        case 'addRemote':
        case 'setRemoteUrl':
        case 'removeRemote': {
          await validateRemoteName(root, op.name)
          if (op.kind !== 'addRemote') await validateRemote(root, op.name)
          if (op.kind !== 'removeRemote') validateRemoteUrl(op.url)
          if (op.kind === 'setRemoteUrl' && op.pushUrl !== undefined) validateRemoteUrl(op.pushUrl)
          await checkBusy()
          if (op.kind === 'addRemote') await git(root, ['remote', 'add', '--', op.name, op.url])
          else if (op.kind === 'removeRemote') await git(root, ['remote', 'remove', '--', op.name])
          else {
            await git(root, ['remote', 'set-url', '--', op.name, op.url])
            if (op.pushUrl !== undefined) {
              await git(root, ['remote', 'set-url', '--push', '--', op.name, op.pushUrl])
            }
          }
          break
        }
        case 'renameBranch':
          await validateBranch(root, op.oldName)
          await validateBranch(root, op.newName)
          await checkBusy()
          await git(root, ['branch', '-m', '--', op.oldName, op.newName])
          break
        case 'deleteBranch':
          await validateBranch(root, op.name)
          if (await currentBranch(root) === op.name) throw new Error('Cannot delete the checked-out branch.')
          await checkBusy()
          await git(root, ['branch', op.force ? '-D' : '-d', '--', op.name])
          break
        case 'deleteRemoteBranch':
          await validateRemote(root, op.remote)
          await validateBranch(root, op.branch)
          await checkBusy()
          await git(root, ['push', '--no-mirror', '--no-follow-tags', '--recurse-submodules=no',
            '--delete', '--', op.remote, 'refs/heads/' + op.branch], true)
          break
        case 'setUpstream':
          await updateUpstream(root, op, checkBusy)
          break
        case 'merge': {
          if (!(await currentBranch(root))) throw new Error('Check out a local branch before merging.')
          const ref = await branchRef(root, op.branch, op.remote)
          const flags = op.mode === 'squash' ? ['--ff', '--squash'] : op.mode === 'no-ff' ? ['--no-ff'] : []
          await checkBusy()
          const output = await git(root, ['merge', '--no-edit', '--no-autostash', ...flags, '--', ref], false, 120_000)
          return { ok: true, outcome: { kind: 'merge', squashed: op.mode === 'squash' && !/already up.to.date/i.test(output) } }
        }
        case 'fetch':
          await git(root, ['fetch', op.prune === false ? '--no-prune' : '--prune', '--no-recurse-submodules'], true)
          break
        case 'pull':
          return await pullBranch(root, op.strategy, checkBusy)
        case 'push':
          return { ok: true, outcome: await pushBranch(root, op.forceWithLease, checkBusy) }
        case 'stage':
        case 'unstage':
        case 'discard':
          await fileMutation(root, worktree.dir, op, checkBusy)
          break
        case 'stageAll':
          await git(root, ['add', '-A', '--', '.'])
          break
        case 'stageTracked':
          await git(root, ['add', '-u', '--', '.'])
          break
        case 'stageUntracked': {
          const paths = parseStatus(await git(root, porcelain)).filter((file) => file.xy === '??').map((file) => file.path)
          if (paths.length) {
            await checkBusy()
            await gitBytes(root, ['add', '--pathspec-from-file=-', '--pathspec-file-nul', '--'], { input: Buffer.from(paths.join('\0') + '\0') })
          }
          break
        }
        case 'unstageAll':
          await unstage(root, ['.'])
          break
        case 'discardAll':
          await git(root, ['restore', '--worktree', '--no-recurse-submodules', '--', '.'])
          break
        case 'cleanAll':
          await git(root, ['clean', '-fd', '--', '.'])
          break
        case 'ignore':
          await ignorePath(root, worktree.dir, op, checkBusy)
          break
        case 'stageAndCommit':
        case 'commit':
          if (op.amend && !(await resolveRef(root, 'HEAD'))) throw new Error('There is no commit to amend.')
          await checkBusy()
          if (op.kind === 'stageAndCommit') {
            await git(root, ['add', '-A', '--', '.'])
            await checkBusy()
          }
          return { ok: true, outcome: await commit(root, op.message, op.amend) }
        case 'undoLastCommit': {
          const last = await readHeadCommit(root)
          if (!last) throw new Error('There is no commit to undo.')
          if (!last.hasParent && !(await currentBranch(root))) throw new Error('Check out a local branch to undo its first commit.')
          if (!last.hasParent && (await resolveRef(root, 'MERGE_HEAD') || parseStatus(await git(root, porcelain)).some(({ xy }) => /U|^AA$|^DD$/.test(xy)))) {
            throw new Error('Finish the merge or resolve the unmerged files before undoing a commit.')
          }
          await checkBusy()
          await git(root, last.hasParent ? ['reset', '--soft', 'HEAD~1'] : ['update-ref', '-d', 'HEAD', last.hash])
          return { ok: true, outcome: { kind: 'undoLastCommit', message: last.message } }
        }
        case 'stashPush':
          if (!(await stashPush(root, op, checkBusy))) throw new Error('No local changes to stash with the selected options.')
          break
        case 'stashApply':
        case 'stashPop':
        case 'stashDrop':
          await checkStashSelection(root, op.ref, op.expectedHash)
          await checkBusy()
          await git(root, ['stash', op.kind === 'stashApply' ? 'apply' : op.kind === 'stashPop' ? 'pop' : 'drop',
            '--', op.kind === 'stashApply' && op.expectedHash ? op.expectedHash : op.ref])
          break
        case 'stashClear':
          await git(root, ['stash', 'clear'])
          break
        case 'stashBranch':
          await validateBranch(root, op.name)
          await checkStashSelection(root, op.ref, op.expectedHash)
          await checkBusy()
          await git(root, ['stash', 'branch', op.name, op.ref])
          return { ok: true, outcome: { kind: 'createBranch', branch: op.name } }
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
