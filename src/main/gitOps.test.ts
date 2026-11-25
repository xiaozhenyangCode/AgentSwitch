import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { classifyGitError } from '@shared/gitErrors'
import { gitChanges, gitCommitDetail } from './gitChanges'
import { gitGraph, gitLog, gitMutate, gitStatus, parseGitGraph, parseGitLog } from './gitOps'

vi.mock('./fileProtocol', () => ({ allowRoot: vi.fn() }))

const exec = promisify(execFile)
async function git(cwd: string, ...args: string[]) {
  return (await exec('git', args, { cwd, env: { ...process.env, LC_ALL: 'C' } })).stdout.trimEnd()
}

let temp: string
let repo: string

async function initRepository(dir: string) {
  await mkdir(dir)
  await git(dir, 'init', '-b', 'main')
  await git(dir, 'config', '--local', 'user.name', 'Git GUI Tests')
  await git(dir, 'config', '--local', 'user.email', 'git-gui@example.invalid')
  await git(dir, 'config', '--local', 'commit.gpgSign', 'false')
}

async function addCommit(dir: string, path: string, contents: string, message: string) {
  await writeFile(join(dir, path), contents)
  await git(dir, 'add', '--', path)
  await git(dir, 'commit', '-m', message)
}

async function createOrigin() {
  const bare = join(temp, 'remote.git')
  await git(temp, 'init', '--bare', '-b', 'main', '--', bare)
  await git(repo, 'remote', 'add', 'origin', bare)
  expect(await gitMutate(repo, { kind: 'push' })).toMatchObject({ ok: true, outcome: { kind: 'push', target: 'origin/main', published: true } })
  return bare
}

describe('Git log parsing', () => {
  const hash = '1234567890abcdef'.repeat(2) + '12345678'
  const sha256 = '182abdf'.padEnd(64, '0')
  const record = (fields: string[]) => '\x1e' + fields.join('\x1f') + '\n'

  it('preserves multiline and special-character subjects and parses both hash lengths', () => {
    const subject = '修复 “工作区”\t[#42]\nNext line with inline \x1e separator'
    const output = record([hash, '1234567', subject, 'José & 李', '1700000000']) +
      record([sha256, '182abd', '', 'Naomi', '0'])

    expect(parseGitLog(output)).toEqual([
      { sha: '1234567', shortHash: '1234567', hash, subject, author: 'José & 李', authoredAt: 1700000000000, timestamp: 1700000000000 },
      { sha: '182abd', shortHash: '182abd', hash: sha256, subject: '', author: 'Naomi', authoredAt: 0, timestamp: 0 }
    ])
  })

  it('ignores empty output and skips malformed records without dropping surrounding commits', () => {
    expect(parseGitLog('')).toEqual([])
    expect(parseGitLog('\n')).toEqual([])

    const valid = record([hash, '1234567', 'Valid', 'Author', '1'])
    const malformed = [
      [hash, '1234567', 'Incomplete'],
      ['bad-hash', '1234567', 'Subject', 'Author', '1'],
      [hash, 'abcde', 'Wrong abbreviation', 'Author', '1'],
      [hash, '1234567', 'Bad timestamp', 'Author', '1.5'],
      [hash, '1234567', 'Out-of-range timestamp', 'Author', '9000000000000'],
      [hash, '1234567', 'Embedded\x1f field separator', 'Author', '1']
    ].map(record).join('')

    expect(parseGitLog(valid + malformed + valid).map((commit) => commit.subject)).toEqual(['Valid', 'Valid'])
  })
})

describe('Git graph parsing', () => {
  it('preserves parents, all decoration kinds, and multiline commit text', () => {
    const hashes = ['1', '2', '3'].map((digit) => digit.repeat(40))
    const subject = '修复 “分支”\t[#42]\nMerge the second line'
    const row = (hash: string, parents: string[], refs: string, summary: string) =>
      '\x1e' + [hash, hash.slice(0, 7), parents.join(' '), refs, summary, 'José', '1700000000'].join('\x1f') + '\n'
    const output = row(hashes[0], hashes.slice(1), 'HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1.0, refs/stash', subject) +
      '\x1etruncated\n' + row(hashes[1], [hashes[2]], 'refs/heads/feature,topic', 'Feature') +
      row(hashes[2], [], '', 'Root')
    const commits = parseGitGraph(output)

    expect(commits).toHaveLength(3)
    expect(commits[0]).toMatchObject({
      hash: hashes[0], shortHash: '1111111', parents: hashes.slice(1), subject, author: 'José', timestamp: 1700000000000,
      refs: [
        { kind: 'head', name: 'HEAD' }, { kind: 'branch', name: 'main' },
        { kind: 'remote', name: 'origin/main' }, { kind: 'tag', name: 'v1.0' }, { kind: 'other', name: 'stash' }
      ]
    })
    expect(commits[1]).toMatchObject({ parents: [hashes[2]], refs: [{ kind: 'branch', name: 'feature,topic' }] })
    expect(commits[2]).toMatchObject({ parents: [], refs: [] })
    expect(parseGitGraph('')).toEqual([])
  })
})

describe('Git workbench operations', () => {
  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'agentswitch-git-'))
    repo = join(temp, 'repo')
    await initRepository(repo)
    await addCommit(repo, 'tracked.txt', 'initial\n', 'Initial commit')
  })

  afterEach(async () => {
    await rm(temp, { recursive: true, force: true })
  })

  it('reports branch and dirty state from a subfolder and handles detached HEAD', async () => {
    const child = join(repo, 'child')
    await mkdir(child)
    await writeFile(join(child, 'new.txt'), 'new')
    expect(await gitStatus(child)).toMatchObject({
      ok: true, repo: true, branch: 'main', detached: null, upstream: null, dirty: true,
      staged: 0, unstaged: 1, atRoot: false, branches: [{ name: 'main', remote: null }]
    })
    await git(repo, 'switch', '--detach', 'HEAD')
    const sha = await git(repo, 'rev-parse', '--short', 'HEAD')
    expect(await gitStatus(repo)).toMatchObject({ ok: true, repo: true, branch: null, detached: sha })
  })

  it('pushes with upstream, fetches, fast-forwards, tracks remote branches and rejects a divergent pull', async () => {
    const bare = await createOrigin()
    expect(await gitStatus(repo)).toMatchObject({ upstream: 'origin/main', ahead: 0, behind: 0 })
    const peer = join(temp, 'peer')
    await git(temp, 'clone', '--', bare, peer)
    await git(peer, 'config', '--local', 'user.name', 'Git GUI Peer')
    await git(peer, 'config', '--local', 'user.email', 'peer@example.invalid')
    await git(peer, 'config', '--local', 'commit.gpgSign', 'false')
    await addCommit(peer, 'upstream.txt', 'remote', 'Remote commit')
    await git(peer, 'branch', '--', 'topic')
    await git(peer, 'push', '--', 'origin', 'main', 'topic')
    expect(await gitMutate(repo, { kind: 'fetch' })).toEqual({ ok: true })
    expect(await gitStatus(repo)).toMatchObject({ ahead: 0, behind: 1 })
    expect(await gitMutate(repo, { kind: 'pull' })).toEqual({ ok: true, outcome: { kind: 'pull', count: 1 } })
    expect(await gitMutate(repo, { kind: 'pull' })).toEqual({ ok: true, outcome: { kind: 'pull', count: 0 } })
    expect(await gitMutate(repo, { kind: 'switch', name: 'origin/topic', remote: 'origin' })).toEqual({ ok: true, outcome: { kind: 'switch', branch: 'topic' } })
    expect(await gitStatus(repo)).toMatchObject({ branch: 'topic', upstream: 'origin/topic' })
    expect(await gitMutate(repo, { kind: 'switch', name: 'main', remote: null })).toEqual({ ok: true, outcome: { kind: 'switch', branch: 'main' } })
    await addCommit(repo, 'local.txt', 'local', 'Local commit')
    expect(await gitStatus(repo)).toMatchObject({ ahead: 1, behind: 0 })
    expect(await gitMutate(repo, { kind: 'push' })).toEqual({ ok: true, outcome: { kind: 'push', target: 'origin/main', count: 1, published: false } })
    await git(peer, 'pull', '--ff-only')
    await addCommit(peer, 'upstream.txt', 'diverged', 'Diverged remotely')
    await git(peer, 'push')
    await addCommit(repo, 'local.txt', 'diverged', 'Diverged locally')
    await git(repo, 'config', '--local', 'pull.rebase', 'true')
    expect(await gitMutate(repo, { kind: 'pull' })).toMatchObject({ ok: false, code: 'diverged', error: expect.stringMatching(/fast-forward/) })
    expect(await gitStatus(repo)).toMatchObject({ ahead: 1, behind: 1 })
    await git(repo, 'config', '--local', 'remote.origin.push', '+refs/heads/main:refs/heads/main')
    expect(await gitMutate(repo, { kind: 'push' })).toMatchObject({ ok: false, code: 'pushRejected' })
    await git(repo, 'config', '--local', 'remote.origin.mirror', 'true')
    expect(await gitMutate(repo, { kind: 'push' })).toMatchObject({ ok: false })
    expect(await git(bare, 'rev-parse', 'refs/heads/main')).toBe(await git(peer, 'rev-parse', 'HEAD'))
  })

  it('returns a Git error when a remote requires credentials', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git test"' })
      response.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Expected a TCP port.')
      await git(repo, 'config', '--local', 'credential.helper', '')
      await git(repo, 'remote', 'add', 'origin', `http://127.0.0.1:${address.port}/private.git`)
      expect(await gitMutate(repo, { kind: 'fetch' })).toMatchObject({ ok: false, error: expect.stringMatching(/terminal prompts disabled|unable to get password from user/) })
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })

  it('creates and switches branches and rejects option, revision and invalid ref names', async () => {
    expect(await gitMutate(repo, { kind: 'createBranch', name: 'test/topic' })).toEqual({ ok: true, outcome: { kind: 'createBranch', branch: 'test/topic' } })
    expect(await gitStatus(repo)).toMatchObject({ branch: 'test/topic' })
    expect(await gitMutate(repo, { kind: 'switch', name: 'main', remote: null })).toEqual({ ok: true, outcome: { kind: 'switch', branch: 'main' } })
    for (const name of ['-c', 'bad name', 'foo..bar', '@{-1}']) {
      expect(await gitMutate(repo, { kind: 'createBranch', name })).toMatchObject({ ok: false, code: 'invalidBranch' })
    }
    expect(await gitMutate(repo, { kind: 'switch', name: 'HEAD~1', remote: null })).toMatchObject({ ok: false })
    expect(await gitStatus(repo)).toMatchObject({ branch: 'main' })
  })

  it('stages literal paths concurrently, removes staged changes, and commits a multiline message', async () => {
    await writeFile(join(repo, 'tracked.txt'), 'modified\n')
    await writeFile(join(repo, ':(glob)*.txt'), 'literal\n')
    expect(await Promise.all([
      gitMutate(repo, { kind: 'stage', path: 'tracked.txt' }),
      gitMutate(repo, { kind: 'stage', path: ':(glob)*.txt' })
    ])).toEqual([{ ok: true }, { ok: true }])
    expect(await gitStatus(repo)).toMatchObject({ staged: 2, unstaged: 0 })
    expect(await gitMutate(repo, { kind: 'unstage', path: ':(glob)*.txt' })).toEqual({ ok: true })
    expect(await gitStatus(repo)).toMatchObject({ staged: 1, unstaged: 1 })
    expect(await gitMutate(repo, { kind: 'unstageAll' })).toEqual({ ok: true })
    expect(await gitMutate(repo, { kind: 'stageAll' })).toEqual({ ok: true })
    expect(await gitMutate(repo, { kind: 'commit', message: 'GUI commit\n\nSecond paragraph' })).toEqual({ ok: true, outcome: { kind: 'commit', sha: expect.stringMatching(/^[a-f0-9]+$/), subject: 'GUI commit' } })
    expect(await git(repo, 'log', '-1', '--format=%B')).toBe('GUI commit\n\nSecond paragraph')
    expect(await gitLog(repo)).toMatchObject({ ok: true, commits: [
      { sha: expect.stringMatching(/^[a-f0-9]+$/), subject: 'GUI commit', author: 'Git GUI Tests', authoredAt: expect.any(Number) },
      { subject: 'Initial commit' }
    ] })
    expect(await gitStatus(repo)).toMatchObject({ dirty: false, staged: 0, unstaged: 0 })
  })

  it('reads full and short Git hashes and UTF-8 subjects, with bounded request limits', async () => {
    for (let index = 1; index <= 19; index++) {
      await git(repo, 'commit', '--allow-empty', '-m', `Fixture commit ${index}`)
    }
    await git(repo, 'config', 'i18n.logOutputEncoding', 'ISO-8859-1')
    await git(repo, '-c', 'user.name=José & 李', 'commit', '--allow-empty', '-m', '修复 #42 — “入口”\n第二行\n\nBody')
    const hash = await git(repo, 'rev-parse', 'HEAD')
    const shortHash = await git(repo, 'rev-parse', '--short', 'HEAD')
    const timestamp = Number(await git(repo, 'show', '-s', '--format=%at', 'HEAD')) * 1000

    const defaultLog = await gitLog(repo)
    if (!defaultLog.ok) throw new Error(defaultLog.error)
    expect(defaultLog.commits).toHaveLength(20)
    expect(defaultLog.commits.at(-1)?.subject).toBe('Fixture commit 1')
    expect(await gitLog(repo, '1')).toEqual(defaultLog)
    expect(await gitLog(repo, 2)).toEqual({ ok: true, commits: defaultLog.commits.slice(0, 2) })
    expect(await gitLog(repo, 0)).toEqual({ ok: true, commits: [{
      sha: shortHash, shortHash, hash, subject: '修复 #42 — “入口” 第二行', author: 'José & 李', authoredAt: timestamp, timestamp
    }] })
    const largeLog = await gitLog(repo, 999)
    if (!largeLog.ok) throw new Error(largeLog.error)
    expect(largeLog.commits).toHaveLength(21)
    expect(largeLog.commits.at(-1)?.subject).toBe('Initial commit')
  })

  it('reports Git log errors for a HEAD pointing to a missing object', async () => {
    await writeFile(join(repo, '.git', 'refs', 'heads', 'main'), '1'.repeat(40) + '\n')
    expect(await gitLog(repo)).toMatchObject({ ok: false, error: expect.any(String) })
  })

  it('loads the graph for a branch, an unreferenced detached HEAD, and an unborn branch', async () => {
    await git(repo, 'tag', '-a', 'v1', '-m', 'Release')
    await git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    const main = await git(repo, 'rev-parse', 'HEAD')
    expect(await gitGraph(repo)).toMatchObject({
      ok: true, headHash: main, branch: 'main', dirty: false, uncommittedCount: 0,
      commits: [{ hash: main, parents: [], refs: expect.arrayContaining([
        { kind: 'head', name: 'HEAD' }, { kind: 'branch', name: 'main' },
        { kind: 'remote', name: 'origin/main' }, { kind: 'tag', name: 'v1' }
      ]) }]
    })
    await git(repo, 'switch', '--detach', 'HEAD')
    await addCommit(repo, 'detached.txt', 'Detached\n', 'Detached commit')
    const detached = await git(repo, 'rev-parse', 'HEAD')
    expect(await gitGraph(repo, 1)).toMatchObject({
      ok: true, headHash: detached, branch: null, commits: [{ hash: detached, parents: [main], refs: [{ kind: 'head', name: 'HEAD' }] }]
    })
    await git(repo, 'branch', 'newer', detached)
    await git(repo, 'switch', '--detach', main)
    expect(await gitGraph(repo, 1)).toMatchObject({ ok: true, headHash: main, branch: null, commits: [{ hash: main }] })

    const unborn = join(temp, 'unborn-graph')
    await initRepository(unborn)
    await writeFile(join(unborn, 'both.txt'), 'stage me\n')
    await git(unborn, 'add', 'both.txt')
    await writeFile(join(unborn, 'both.txt'), 'unstaged edit\n')
    await writeFile(join(unborn, 'untracked.txt'), 'new\n')
    expect(await gitGraph(unborn)).toEqual({
      ok: true, commits: [], headHash: null, branch: 'main', dirty: true, uncommittedCount: 2, staged: 1, unstaged: 2
    })
    expect(await gitGraph(temp)).toMatchObject({ ok: false, error: expect.any(String) })
  })

  it('returns a root diff, a first-parent merge diff and normal rename/binary changes', async () => {
    const root = await git(repo, 'rev-parse', 'HEAD')
    const shortHash = await git(repo, 'rev-parse', '--short', root)
    expect(await gitCommitDetail(repo, shortHash)).toMatchObject({
      ok: true, commit: { hash: root, shortHash, parents: [], body: '', email: 'git-gui@example.invalid',
        files: [{ path: 'tracked.txt', status: 'A', added: 1, removed: 0, diff: expect.stringContaining('+initial') }] }
    })

    await git(repo, 'switch', '-c', 'feature')
    const renamed = 'new name\t有\n换行.txt'
    await git(repo, 'mv', 'tracked.txt', renamed)
    await writeFile(join(repo, 'binary.bin'), Buffer.from([0, 1, 2]))
    await git(repo, 'add', 'binary.bin')
    await git(repo, 'commit', '-m', 'Rename and add binary\n\nBody with 中文\nand a second line')
    const feature = await git(repo, 'rev-parse', 'HEAD')
    expect(await gitCommitDetail(repo, feature)).toMatchObject({
      ok: true, commit: { hash: feature, parents: [root], subject: 'Rename and add binary', body: 'Body with 中文\nand a second line\n',
        files: expect.arrayContaining([
          expect.objectContaining({ path: renamed, oldPath: 'tracked.txt', status: 'R', added: 0, removed: 0 }),
          expect.objectContaining({ path: 'binary.bin', status: 'A', binary: true })
        ]) }
    })

    await git(repo, 'switch', 'main')
    await addCommit(repo, 'main.txt', 'main\n', 'Main work')
    const main = await git(repo, 'rev-parse', 'HEAD')
    await git(repo, 'merge', '--no-ff', '-m', 'Merge feature', 'feature')
    const merge = await git(repo, 'rev-parse', 'HEAD')
    const detail = await gitCommitDetail(repo, merge)
    if (!detail.ok) throw new Error(detail.error)
    expect(detail.commit.parents).toEqual([main, feature])
    expect(detail.commit.files.map((file) => file.path).sort()).toEqual(['binary.bin', renamed].sort())
    expect(await gitGraph(repo)).toMatchObject({
      ok: true, headHash: merge, commits: expect.arrayContaining([expect.objectContaining({ hash: merge, parents: [main, feature] })])
    })
  })

  it('rejects invalid, missing and non-commit hashes in commit detail', async () => {
    const blob = await git(repo, 'rev-parse', 'HEAD:tracked.txt')
    const head = await git(repo, 'rev-parse', 'HEAD')
    const hexRef = head.startsWith('fab0') ? 'fea0' : 'fab0'
    await git(repo, 'branch', hexRef)
    for (const hash of [null, 'HEAD', '--all', '123', 'a'.repeat(65), '1000', blob, hexRef]) {
      expect(await gitCommitDetail(repo, hash)).toMatchObject({ ok: false })
    }
    expect(await gitCommitDetail(temp, 'abcd')).toMatchObject({ ok: false })
  })

  it('keeps the legacy diff and separates staged, working tree and untracked previews', async () => {
    const name = 'with a tab\tand newline\n.txt'
    await addCommit(repo, name, 'base\n', 'Add unusual name')
    await writeFile(join(repo, name), 'staged version\n')
    await git(repo, 'add', '--', name)
    await writeFile(join(repo, name), 'working version\n')
    await writeFile(join(repo, 'untracked.txt'), 'untracked version\n')
    const legacy = await gitChanges(repo)
    expect(legacy.files.find((file) => file.path === name)).toMatchObject({
      diff: expect.stringContaining('+working version'), added: 1, removed: 1
    })
    const split = await gitChanges(repo, true)
    const file = split.files.find((file) => file.path === name)
    expect(file).toMatchObject({
      staged: true, unstaged: true,
      stagedChange: { diff: expect.stringContaining('+staged version'), added: 1, removed: 1 },
      unstagedChange: { diff: expect.stringContaining('-staged version\n+working version'), added: 1, removed: 1 }
    })
    expect(file?.stagedChange?.diff).not.toContain('working version')
    expect(split.files.find((item) => item.path === 'untracked.txt')?.unstagedChange?.diff).toContain('+untracked version')
    expect(legacy.files[0]).not.toHaveProperty('unstagedChange')
  })

  it('stages and commits in one queued operation and leaves staged changes when a commit hook fails', async () => {
    const path = join(repo, 'tracked.txt')
    await writeFile(path, 'first edit\n')
    const result = await gitMutate(repo, { kind: 'stageAndCommit', message: 'Stage and commit' })
    expect(result).toMatchObject({ ok: true, outcome: { kind: 'commit', subject: 'Stage and commit' } })
    expect(await gitStatus(repo)).toMatchObject({ dirty: false })

    await writeFile(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nprintf "hook failed\\n" >&2\nexit 1\n', { mode: 0o755 })
    await writeFile(path, 'second edit\n')
    expect(await gitMutate(repo, { kind: 'stageAndCommit', message: 'Blocked' })).toMatchObject({ ok: false, error: 'hook failed' })
    expect(await gitStatus(repo)).toMatchObject({ staged: 1, unstaged: 0 })
    expect(await git(repo, 'log', '-1', '--format=%s')).toBe('Stage and commit')
  })

  it('unstages both sides of a rename and handles an unborn branch', async () => {
    await rename(join(repo, 'tracked.txt'), join(repo, 'renamed.txt'))
    await gitMutate(repo, { kind: 'stageAll' })
    expect(await gitMutate(repo, { kind: 'unstage', path: 'renamed.txt' })).toEqual({ ok: true })
    expect(await gitStatus(repo)).toMatchObject({ staged: 0, unstaged: 2 })
    const unborn = join(temp, 'unborn')
    await initRepository(unborn)
    expect(await gitLog(unborn)).toEqual({ ok: true, commits: [] })
    await writeFile(join(unborn, 'first.txt'), 'first')
    expect(await gitMutate(unborn, { kind: 'stage', path: 'first.txt' })).toEqual({ ok: true })
    expect(await gitMutate(unborn, { kind: 'unstageAll' })).toEqual({ ok: true })
    expect(await gitStatus(unborn)).toMatchObject({ branch: 'main', staged: 0, unstaged: 1 })
    expect(await readFile(join(unborn, 'first.txt'), 'utf8')).toBe('first')
  })

  it('discards only unstaged data and refuses path escapes and stale discard types', async () => {
    const outside = join(temp, 'preserve.txt')
    await writeFile(outside, 'outside')
    await symlink(temp, join(repo, 'escape'))
    for (const path of ['../preserve.txt', outside, 'escape/preserve.txt', '.git/config', '.GIT/config']) {
      expect(await gitMutate(repo, { kind: 'discard', path, untracked: true })).toMatchObject({ ok: false })
    }
    const tracked = join(repo, 'tracked.txt')
    await writeFile(tracked, 'stage this')
    await gitMutate(repo, { kind: 'stage', path: 'tracked.txt' })
    await writeFile(tracked, 'discard this')
    expect(await gitMutate(repo, { kind: 'discard', path: 'tracked.txt', untracked: true })).toMatchObject({ ok: false })
    expect(await gitMutate(repo, { kind: 'discard', path: 'tracked.txt', untracked: false })).toEqual({ ok: true })
    expect(await readFile(tracked, 'utf8')).toBe('stage this')
    expect(await gitMutate(repo, { kind: 'discard', path: 'escape', untracked: true })).toEqual({ ok: true })
    expect(await readFile(outside, 'utf8')).toBe('outside')
  })

  it('rejects invalid directories and writes while an agent occupies a repository', async () => {
    for (const dir of [null, 'relative', temp, join(repo, 'tracked.txt'), join(temp, 'missing')]) {
      expect(await gitStatus(dir)).toEqual({ ok: true, repo: false })
      expect(await gitMutate(dir, { kind: 'stageAll' })).toMatchObject({ ok: false })
      expect(await gitLog(dir)).toMatchObject({ ok: false })
    }
    expect(await gitMutate(repo, { kind: 'createBranch', name: 'blocked' }, async () => true)).toMatchObject({ ok: false })
    expect(await gitStatus(repo)).toMatchObject({ branch: 'main', branches: [{ name: 'main', remote: null }] })
  })
})

describe('Git error categories', () => {
  it.each([
    ['error: Your local changes to the following files would be overwritten by checkout:', 'switchChanges'],
    ['fatal: Not possible to fast-forward, aborting.', 'diverged'],
    ['There is no tracking information for the current branch.', 'noUpstream'],
    ['fatal: could not read Username for a remote: terminal prompts disabled', 'auth'],
    ['!\trefs/heads/main:refs/heads/main\t[rejected] (fetch first)', 'pushRejected'],
    ['fatal: Unable to create repo/.git/index.lock: File exists', 'indexLocked'],
    ['fatal: some other error', undefined]
  ])('categorizes %s', (error, code) => {
    expect(classifyGitError(error)).toBe(code)
  })
})
