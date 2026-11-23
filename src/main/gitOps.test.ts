import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { classifyGitError } from '@shared/gitErrors'
import { gitChanges } from './gitChanges'
import { gitLog, gitMutate, gitStatus } from './gitOps'

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

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'agentswitch-git-'))
  repo = join(temp, 'repo')
  await initRepository(repo)
  await addCommit(repo, 'tracked.txt', 'initial\n', 'Initial commit')
})

afterEach(async () => {
  await rm(temp, { recursive: true, force: true })
})

describe('Git workbench operations', () => {
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
