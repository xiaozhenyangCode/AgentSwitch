import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { classifyGitError } from '@shared/gitErrors'
import { gitChanges, gitCommitDetail } from './gitChanges'
import { gitGraph, gitLog, gitMutate, gitStatus, parseGitGraph, parseGitLog, parseStatus } from './gitOps'

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

async function cloneOrigin(bare: string) {
  const peer = join(temp, 'peer')
  await git(temp, 'clone', '--', bare, peer)
  await git(peer, 'config', '--local', 'user.name', 'Git GUI Peer')
  await git(peer, 'config', '--local', 'user.email', 'peer@example.invalid')
  await git(peer, 'config', '--local', 'commit.gpgSign', 'false')
  return peer
}

async function createDivergingCommits() {
  await git(repo, 'switch', '-c', 'feature')
  await addCommit(repo, 'tracked.txt', 'feature edit\n', 'Feature edit')
  await git(repo, 'switch', 'main')
  await addCommit(repo, 'tracked.txt', 'main edit\n', 'Main edit')
  return git(repo, 'rev-parse', 'HEAD')
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
    const output = row(hashes[0], hashes.slice(1), 'HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1.0, refs/stash, refs/agentswitch/checkpoints/t1/after', subject) +
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
      ok: true, repo: true, repoPath: await realpath(repo), branch: 'main', detached: null, upstream: null, dirty: true,
      staged: 0, unstaged: 1, atRoot: false, branches: [{ name: 'main', remote: null }]
    })
    await git(repo, 'switch', '--detach', 'HEAD')
    const sha = await git(repo, 'rev-parse', '--short', 'HEAD')
    expect(await gitStatus(repo)).toMatchObject({ ok: true, repo: true, branch: null, detached: sha })
  })

  it('pushes with upstream, fetches, fast-forwards, tracks remote branches and rejects a divergent pull', { timeout: 15_000 }, async () => {
    const bare = await createOrigin()
    expect(await gitStatus(repo)).toMatchObject({ upstream: 'origin/main', ahead: 0, behind: 0 })
    const peer = await cloneOrigin(bare)
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

  it('fetches before refusing overlapping modified and untracked files without touching HEAD or the worktree', { timeout: 15_000 }, async () => {
    await addCommit(repo, 'a.ts', 'base\n', 'Track a')
    const before = await git(repo, 'rev-parse', 'HEAD')
    const peer = await cloneOrigin(await createOrigin())
    await addCommit(peer, 'a.ts', 'remote a\n', 'Update a')
    await addCommit(peer, 'new.ts', 'remote new\n', 'Add new')
    await git(peer, 'push')
    await writeFile(join(repo, 'a.ts'), 'working a\n')
    await writeFile(join(repo, 'new.ts'), 'working new\n')
    expect(await gitMutate(repo, { kind: 'pull' })).toMatchObject({
      ok: false, code: 'pullConflict', files: ['a.ts', 'new.ts']
    })
    expect(await git(repo, 'rev-parse', 'refs/remotes/origin/main')).toBe(await git(peer, 'rev-parse', 'HEAD'))
    expect(await git(repo, 'rev-parse', 'HEAD')).toBe(before)
    expect(await readFile(join(repo, 'a.ts'), 'utf8')).toBe('working a\n')
    expect(await readFile(join(repo, 'new.ts'), 'utf8')).toBe('working new\n')
    expect(await git(repo, 'status', '--porcelain')).toBe(' M a.ts\n?? new.ts')
  })

  it('reports original local paths for renames, case-insensitive matches and file-directory collisions', { timeout: 15_000 }, async () => {
    await git(repo, 'config', '--local', 'core.ignorecase', 'true')
    const peer = await cloneOrigin(await createOrigin())
    await git(repo, 'mv', 'tracked.txt', 'Renamed.txt')
    await writeFile(join(repo, 'LocalCase.ts'), 'local\n')
    await writeFile(join(repo, 'prefix'), 'local file\n')
    await mkdir(join(repo, 'folder'))
    await writeFile(join(repo, 'folder', 'child'), 'local child\n')
    await addCommit(peer, 'tracked.txt', 'remote change\n', 'Update the original path')
    await addCommit(peer, 'localcase.ts', 'remote case\n', 'Add case variant')
    await mkdir(join(peer, 'prefix'))
    await addCommit(peer, 'prefix/child', 'remote child\n', 'Add directory')
    await addCommit(peer, 'folder', 'remote file\n', 'Add file')
    await git(peer, 'push')
    expect(await gitMutate(repo, { kind: 'pull' })).toMatchObject({
      ok: false, code: 'pullConflict', files: ['LocalCase.ts', 'folder/child', 'prefix', 'tracked.txt']
    })
  })

  it('fast-forwards a disjoint change while preserving staged and unstaged local edits', { timeout: 15_000 }, async () => {
    await addCommit(repo, 'a.ts', 'base\n', 'Track a')
    const peer = await cloneOrigin(await createOrigin())
    await addCommit(peer, 'b.ts', 'remote b\n', 'Add b')
    await git(peer, 'push')
    await writeFile(join(repo, 'a.ts'), 'staged a\n')
    await git(repo, 'add', 'a.ts')
    await writeFile(join(repo, 'a.ts'), 'working a\n')
    expect(await gitMutate(repo, { kind: 'pull' })).toEqual({ ok: true, outcome: { kind: 'pull', count: 1 } })
    expect(await git(repo, 'show', ':a.ts')).toBe('staged a')
    expect(await readFile(join(repo, 'a.ts'), 'utf8')).toBe('working a\n')
    expect(await readFile(join(repo, 'b.ts'), 'utf8')).toBe('remote b\n')
    expect(await gitMutate(repo, { kind: 'pull' })).toEqual({ ok: true, outcome: { kind: 'pull', count: 0 } })
  })

  it('reports a missing upstream and still honors the repository busy guard', async () => {
    expect(await gitMutate(repo, { kind: 'pull' })).toMatchObject({ ok: false, code: 'noUpstream' })
    expect(await gitMutate(repo, { kind: 'pull' }, async () => true)).toMatchObject({
      ok: false, code: 'busy', error: 'The repository is busy.'
    })
  })

  it('lets Git reject a local edit that lands after preflight', { timeout: 15_000 }, async () => {
    const before = await git(repo, 'rev-parse', 'HEAD')
    const peer = await cloneOrigin(await createOrigin())
    await addCommit(peer, 'tracked.txt', 'remote edit\n', 'Remote change')
    await git(peer, 'push')
    let checks = 0
    const result = await gitMutate(repo, { kind: 'pull' }, async () => {
      if (++checks === 3) await writeFile(join(repo, 'tracked.txt'), 'late local edit\n')
      return false
    })
    expect(result).toMatchObject({ ok: false, code: 'localChanges' })
    expect(await git(repo, 'rev-parse', 'HEAD')).toBe(before)
    expect(await readFile(join(repo, 'tracked.txt'), 'utf8')).toBe('late local edit\n')
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
    expect(await gitGraph(repo, 1)).toMatchObject({
      ok: true, headHash: main, branch: null, commits: [{ hash: detached }], headCommit: { hash: main }, hasMore: true, nextSkip: 1
    })
    expect(await gitGraph(repo, { limit: 1, skip: 1 })).toMatchObject({
      ok: true, commits: [{ hash: main }], hasMore: false, nextSkip: 2
    })

    const unborn = join(temp, 'unborn-graph')
    await initRepository(unborn)
    await writeFile(join(unborn, 'both.txt'), 'stage me\n')
    await git(unborn, 'add', 'both.txt')
    await writeFile(join(unborn, 'both.txt'), 'unstaged edit\n')
    await writeFile(join(unborn, 'untracked.txt'), 'new\n')
    expect(await gitGraph(unborn)).toEqual({
      ok: true, commits: [], headHash: null, branch: 'main', dirty: true, uncommittedCount: 2, staged: 1, unstaged: 2,
      hasMore: false, nextSkip: 0, branches: []
    })
    expect(await gitGraph(unborn, { branch: 'HEAD' })).toMatchObject({ ok: true, commits: [] })
    expect(await gitGraph(temp)).toMatchObject({ ok: false, error: expect.any(String) })
  })

  it('excludes checkpoint-only commits and hides checkpoint decorations on public commits', async () => {
    const head = await git(repo, 'rev-parse', 'HEAD')
    const ref = 'refs/agentswitch/checkpoints/turn'
    const snapshot = await git(repo, 'commit-tree', 'HEAD^{tree}', '-p', head, '-m', 'Internal checkpoint')
    await git(repo, 'update-ref', ref + '/after', snapshot)
    await git(repo, 'update-ref', ref + '/before', head)

    expect(await gitGraph(repo)).toMatchObject({ ok: true, commits: [{
      hash: head, refs: [{ kind: 'head', name: 'HEAD' }, { kind: 'branch', name: 'main' }]
    }] })
    expect(await gitGraph(repo, { branch: ref + '/after' })).toMatchObject({ ok: false, code: 'invalidBranch' })
  })

  it('filters exact local and remote histories and rejects revision syntax', async () => {
    const root = await git(repo, 'rev-parse', 'HEAD')
    await git(repo, 'switch', '-c', 'topic')
    await addCommit(repo, 'topic.txt', 'topic', 'Topic commit')
    const topic = await git(repo, 'rev-parse', 'HEAD')
    await git(repo, 'update-ref', 'refs/remotes/origin/topic', topic)
    await git(repo, 'switch', 'main')
    await addCommit(repo, 'main.txt', 'main', 'Main commit')
    const main = await git(repo, 'rev-parse', 'HEAD')

    for (const branch of ['topic', 'refs/heads/topic', 'refs/remotes/origin/topic']) {
      const result = await gitGraph(repo, { branch })
      expect(result).toMatchObject({ ok: true, commits: [{ hash: topic }, { hash: root }], headHash: main, hasMore: false })
      expect(result).not.toHaveProperty('headCommit')
    }
    expect(await gitGraph(repo, { branch: 'HEAD' })).toMatchObject({ ok: true, commits: [{ hash: main }, { hash: root }] })
    expect(await gitGraph(repo, { branch: '__ALL__' })).toMatchObject({ ok: true, commits: expect.arrayContaining([
      expect.objectContaining({ hash: topic }), expect.objectContaining({ hash: main })
    ]) })
    for (const branch of ['--all', 'HEAD~1', 'topic\0--all', 'refs/tags/topic', 'missing']) {
      expect(await gitGraph(repo, { branch })).toMatchObject({ ok: false, code: 'invalidBranch' })
    }
  })

  it('reads distinct pages and reports whether another page exists at exact boundaries', async () => {
    await addCommit(repo, 'second.txt', 'two', 'Second')
    await addCommit(repo, 'third.txt', 'three', 'Third')
    await addCommit(repo, 'fourth.txt', 'four', 'Fourth')
    expect(await gitGraph(repo, { limit: 2, skip: -1 })).toMatchObject({
      ok: true, commits: [{ subject: 'Fourth' }, { subject: 'Third' }], hasMore: true, nextSkip: 2
    })
    expect(await gitGraph(repo, { limit: 2, skip: 2 })).toMatchObject({
      ok: true, commits: [{ subject: 'Second' }, { subject: 'Initial commit' }], hasMore: false, nextSkip: 4
    })
    expect(await gitGraph(repo, { limit: 2, skip: 4 })).toMatchObject({ ok: true, commits: [], hasMore: false, nextSkip: 4 })
  })

  it('searches subjects, authors and short hashes with case-insensitive AND terms', async () => {
    await git(repo, 'config', 'user.name', 'Mina Rivera')
    await addCommit(repo, 'docs.txt', 'docs', 'Update documentation')
    const docs = await git(repo, 'rev-parse', '--short', 'HEAD')
    await git(repo, 'config', 'user.name', 'Another Author')
    await addCommit(repo, 'code.txt', 'code', 'Update application')
    for (const query of ['documentation', 'RIVERA', docs, `  UPDATE mina ${docs.toUpperCase()}  `]) {
      const page = await gitGraph(repo, { query })
      expect(page).toMatchObject({
        ok: true, commits: [{ shortHash: docs, subject: 'Update documentation', author: 'Mina Rivera' }],
        hasMore: false, nextSkip: 1
      })
      expect(page).not.toHaveProperty('headCommit')
    }
    expect(await gitGraph(repo, { query: 'documentation Another' })).toMatchObject({
      ok: true, commits: [], hasMore: false, nextSkip: 0
    })
  })

  it('pages matching commits and treats invalid search terms as empty', async () => {
    await addCommit(repo, 'older.txt', 'old', 'Fix older bug')
    await addCommit(repo, 'break.txt', 'break', 'Unrelated')
    await addCommit(repo, 'newer.txt', 'new', 'Fix newer bug')
    expect(await gitGraph(repo, { query: 'fix bug', limit: 1 })).toMatchObject({
      ok: true, commits: [{ subject: 'Fix newer bug' }], hasMore: true, nextSkip: 1
    })
    expect(await gitGraph(repo, { query: 'fix bug', limit: 1, skip: 1 })).toMatchObject({
      ok: true, commits: [{ subject: 'Fix older bug' }], hasMore: false, nextSkip: 2
    })
    expect(await gitGraph(repo, { query: 'fix bug', limit: 1, skip: 2 })).toMatchObject({
      ok: true, commits: [], hasMore: false, nextSkip: 2
    })
    const unfiltered = await gitGraph(repo, { limit: 1 })
    for (const query of [4, 'fix\0bug', 'x'.repeat(201)]) {
      expect(await gitGraph(repo, { query, limit: 1 })).toEqual(unfiltered)
    }
  })

  it('returns a root diff, a first-parent merge diff and normal rename/binary changes', async () => {
    const root = await git(repo, 'rev-parse', 'HEAD')
    const shortHash = await git(repo, 'rev-parse', '--short', root)
    expect(await gitCommitDetail(repo, shortHash)).toMatchObject({
      ok: true, commit: { hash: root, shortHash, parents: [], body: '', email: 'git-gui@example.invalid', added: 1, removed: 0,
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

  it('detects merge conflicts, guards mutations and aborts only the requested active operation', { timeout: 15_000 }, async () => {
    await createOrigin()
    const before = await createDivergingCommits()
    await expect(git(repo, 'merge', '--no-edit', 'feature')).rejects.toThrow(/merge/i)
    expect(await gitStatus(repo)).toMatchObject({ operation: 'merge', conflicts: 1 })
    expect((await gitChanges(repo, true)).files).toMatchObject([{ path: 'tracked.txt', conflicted: true, staged: true, unstaged: true }])
    for (const op of [{ kind: 'pull' }, { kind: 'push' }, { kind: 'switch', name: 'feature', remote: null }, { kind: 'createBranch', name: 'blocked' }]) {
      expect(await gitMutate(repo, op)).toMatchObject({ ok: false, code: 'operationInProgress' })
    }
    for (const kind of ['commit', 'stageAndCommit']) {
      expect(await gitMutate(repo, { kind, message: 'Blocked' })).toMatchObject({ ok: false, code: 'unmerged' })
    }
    expect(await gitMutate(repo, { kind: 'fetch' })).toEqual({ ok: true })
    expect(await gitMutate(repo, { kind: 'abortOperation', operation: 'constructor' })).toEqual({ ok: false, error: 'Invalid Git operation.' })
    expect(await gitMutate(repo, { kind: 'abortOperation', operation: 'rebase' })).toEqual({
      ok: false, error: 'The Git operation changed. Refresh and try again.'
    })
    expect(await gitMutate(repo, { kind: 'abortOperation', operation: 'merge' }, async () => true)).toMatchObject({ ok: false, code: 'busy' })
    expect(await gitStatus(repo)).toMatchObject({ operation: 'merge', conflicts: 1 })
    expect(await gitMutate(repo, { kind: 'abortOperation', operation: 'merge' })).toEqual({
      ok: true, outcome: { kind: 'abortOperation', operation: 'merge' }
    })
    expect(await gitStatus(repo)).toMatchObject({ operation: null, conflicts: 0, dirty: false })
    expect(await git(repo, 'rev-parse', 'HEAD')).toBe(before)
    expect(await readFile(join(repo, 'tracked.txt'), 'utf8')).toBe('main edit\n')
  })

  it('allows a merge commit after staging a resolution that leaves the current tree unchanged', async () => {
    const before = await createDivergingCommits()
    const feature = await git(repo, 'rev-parse', 'feature')
    await expect(git(repo, 'merge', '--no-edit', 'feature')).rejects.toThrow(/merge/i)
    await writeFile(join(repo, 'tracked.txt'), 'main edit\n')
    expect(await gitMutate(repo, { kind: 'stage', path: 'tracked.txt' })).toEqual({ ok: true })
    expect(await gitStatus(repo)).toMatchObject({ operation: 'merge', conflicts: 0, staged: 0, dirty: false })
    expect(await gitMutate(repo, { kind: 'commit', message: 'Resolve merge' })).toMatchObject({ ok: true, outcome: { kind: 'commit' } })
    expect(await git(repo, 'log', '-1', '--format=%P')).toBe(`${before} ${feature}`)
    expect(await gitStatus(repo)).toMatchObject({ operation: null, conflicts: 0 })
  })

  it('detects a rebase conflict and aborts back to the original branch and HEAD', async () => {
    const before = await createDivergingCommits()
    await expect(git(repo, 'rebase', 'feature')).rejects.toThrow(/could not apply/i)
    expect(await gitStatus(repo)).toMatchObject({ branch: null, operation: 'rebase', conflicts: 1 })
    expect(await gitMutate(repo, { kind: 'commit', message: 'Blocked' })).toMatchObject({ ok: false, code: 'operationInProgress' })
    expect(await gitMutate(repo, { kind: 'abortOperation', operation: 'rebase' })).toEqual({
      ok: true, outcome: { kind: 'abortOperation', operation: 'rebase' }
    })
    expect(await gitStatus(repo)).toMatchObject({ branch: 'main', operation: null, conflicts: 0 })
    expect(await git(repo, 'rev-parse', 'HEAD')).toBe(before)
  })

  it('detects cherry-pick and revert markers in their linked worktree', { timeout: 15_000 }, async () => {
    const before = await createDivergingCommits()
    const linked = join(temp, 'linked worktree')
    await git(repo, 'worktree', 'add', '--detach', linked, before)
    await expect(git(linked, 'cherry-pick', 'feature')).rejects.toThrow(/could not apply/i)
    expect(await gitStatus(linked)).toMatchObject({ operation: 'cherryPick', conflicts: 1 })
    expect(await gitStatus(repo)).toMatchObject({ operation: null, conflicts: 0 })
    expect(await gitMutate(linked, { kind: 'abortOperation', operation: 'cherryPick' })).toMatchObject({ ok: true })
    await expect(git(linked, 'revert', '--no-edit', 'HEAD^')).rejects.toThrow(/could not revert/i)
    expect(await gitStatus(linked)).toMatchObject({ operation: 'revert', conflicts: 1 })
    expect(await gitMutate(linked, { kind: 'abortOperation', operation: 'revert' })).toMatchObject({ ok: true })
    expect(await gitStatus(linked)).toMatchObject({ operation: null, conflicts: 0 })
    expect(await git(linked, 'rev-parse', 'HEAD')).toBe(before)
  })

  it('detects unmerged files without an operation marker and does not auto-stage them on commit', async () => {
    await createDivergingCommits()
    await expect(git(repo, 'merge', '--squash', 'feature')).rejects.toThrow(/merge/i)
    expect(await gitStatus(repo)).toMatchObject({ operation: null, conflicts: 1 })
    expect(await gitMutate(repo, { kind: 'stageAndCommit', message: 'Blocked' })).toMatchObject({ ok: false, code: 'unmerged' })
    expect(await git(repo, 'status', '--porcelain')).toBe('UU tracked.txt')
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
    ['error: The following untracked working tree files would be overwritten by checkout:', 'switchChanges'],
    ['error: Your local changes to the following files would be overwritten by merge:', 'localChanges'],
    ['error: The following untracked working tree files would be overwritten by merge:', 'localChanges'],
    ['error: you need to resolve your current index first', 'unmerged'],
    ['error: Pulling is not possible because you have unmerged files.', 'unmerged'],
    ['tracked.txt: needs merge', 'unmerged'],
    ['hint: fix conflicts and then commit', 'unmerged'],
    ['Auto-merging a.ts\nCONFLICT (content): Merge conflict in a.ts', 'unmerged'],
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

it('flags all porcelain unmerged codes without changing staged and unstaged flags', () => {
  const codes = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']
  const status = codes.map((xy) => `${xy} ${xy}.txt\0`).join('') + '?? new.txt\0 M edited.txt\0'
  expect(parseStatus(status)).toMatchObject([
    ...codes.map((xy) => ({ xy, conflicted: true, staged: true, unstaged: true })),
    { xy: '??', conflicted: false, staged: false, unstaged: true },
    { xy: ' M', conflicted: false, staged: false, unstaged: true }
  ])
})
