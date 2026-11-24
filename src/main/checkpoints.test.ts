import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Checkpoints } from './checkpoints'

vi.mock('./legacy', () => ({ LEGACY_PROJECT_DIR: '.agentmux' }))

const exec = promisify(execFile)
const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd })).stdout.trimEnd()
const idle = () => false
const refs = (repo: string) => git(repo, 'for-each-ref', '--format=%(refname)', 'refs/agentswitch/checkpoints')
let temp: string
let data: string
let repo: string
let store: Checkpoints

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'agentswitch-checkpoint-test-'))
  data = join(temp, 'data')
  repo = join(temp, 'repo')
  await Promise.all([mkdir(data), mkdir(repo)])
  store = new Checkpoints(data)
})

afterEach(async () => {
  await rm(temp, { recursive: true, force: true })
})

const put = (path: string, value: string | Buffer) => writeFile(join(repo, path), value)
const content = (path: string) => readFile(join(repo, path), 'utf8')
const missing = (path: string) => expect(stat(join(repo, path))).rejects.toHaveProperty('code', 'ENOENT')

async function init() {
  await git(repo, 'init', '-b', 'main')
  await git(repo, 'config', '--local', 'user.name', 'Checkpoint Test')
  await git(repo, 'config', '--local', 'user.email', 'checkpoint@example.invalid')
  await git(repo, 'config', '--local', 'commit.gpgSign', 'false')
  await put('.gitignore', '*.ignored\n')
  await put('tracked.txt', 'original\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-m', 'Initial commit')
}

async function plan(thread: string, turn: string) {
  const result = await store.action(thread, turn, idle)
  expect(result.kind).toBe('plan')
  if (result.kind !== 'plan') throw new Error(JSON.stringify(result))
  return result
}

describe('turn checkpoints', () => {
  it('restores tracked, untracked, deleted, new and binary files while preserving HEAD, index, stash, and unrelated files', async () => {
    await init()
    await put('tracked.txt', 'stashed\n')
    await git(repo, 'stash', 'push', '-m', 'User stash')
    await put('tracked.txt', 'staged\n')
    await git(repo, 'add', 'tracked.txt')
    await put('tracked.txt', 'dirty\n')
    await put('delete.txt', 'keep me')
    await put('untracked.txt', 'untracked before')
    await put('keep.ignored', 'ignored before')
    await put('raw.bin', Buffer.from([0, 255, 13, 10, 128]))
    await put('quoted\nname.txt', 'has a newline')
    await symlink('tracked.txt', join(repo, 'link'))
    const state = () => Promise.all([
      git(repo, 'status', '--porcelain'), git(repo, 'stash', 'list'), git(repo, 'rev-parse', 'HEAD'),
      git(repo, 'symbolic-ref', 'HEAD'), git(repo, 'diff', '--cached'), readFile(join(repo, '.git/index'))
    ])
    await git(repo, 'config', '--local', 'commit.gpgSign', 'true')
    const hook = '.git/hooks/reference-transaction'
    await put(hook, '#!/bin/sh\nexit 1\n')
    await chmod(join(repo, hook), 0o755)
    const originalState = await state()
    await store.begin('thread', 'turn', repo)
    expect(await state()).toEqual(originalState)
    expect(await refs(repo)).toContain('/turn/before')

    await put('tracked.txt', 'model\n')
    await put('untracked.txt', 'model untracked')
    await rm(join(repo, 'delete.txt'))
    await rm(join(repo, 'link'))
    await put('new.txt', 'new')
    await put('keep.ignored', 'ignored afterwards')
    await put('raw.bin', Buffer.from([4, 3, 0, 2]))
    await put('quoted\nname.txt', 'updated')
    const afterState = await state()
    await store.finish('thread', 'turn')
    expect(await state()).toEqual(afterState)
    expect(await refs(repo)).toContain('/turn/after')
    expect(await git(repo, 'log', '--all', '--oneline')).toContain('AgentSwitch checkpoint before')

    const info = await plan('thread', 'turn')
    expect(info.conflicts).toEqual([])
    expect(new Set(info.files)).toEqual(new Set(['tracked.txt', 'untracked.txt', 'delete.txt', 'link', 'new.txt', 'raw.bin', 'quoted\nname.txt']))
    await put('unrelated.txt', 'after the turn')
    expect(await store.action('thread', 'turn', idle, info.token, 'skip')).toEqual({ kind: 'undone', restored: 7, skipped: 0 })
    expect(await content('tracked.txt')).toBe('dirty\n')
    expect(await content('untracked.txt')).toBe('untracked before')
    expect(await content('delete.txt')).toBe('keep me')
    expect(await readlink(join(repo, 'link'))).toBe('tracked.txt')
    expect(await content('quoted\nname.txt')).toBe('has a newline')
    expect(await readFile(join(repo, 'raw.bin'))).toEqual(Buffer.from([0, 255, 13, 10, 128]))
    expect(await content('keep.ignored')).toBe('ignored afterwards')
    expect(await content('unrelated.txt')).toBe('after the turn')
    await missing('new.txt')
    expect((await state()).slice(1)).toEqual(originalState.slice(1))
    const restarted = new Checkpoints(data)
    expect(await restarted.list('thread')).toEqual([{ turnId: 'turn', status: 'undone' }])
    expect(await restarted.action('thread', 'turn', idle)).toEqual({ kind: 'unavailable' })
  })

  it.each(['skip', 'overwrite'] as const)('recognizes conflicts and can %s them without changing unrelated files', async (choice) => {
    await init()
    await put('keep.txt', 'before')
    await store.begin('thread', 'turn', repo)
    await put('tracked.txt', 'turn')
    await put('keep.txt', 'turn')
    await store.finish('thread', 'turn')
    const oldPlan = await plan('thread', 'turn')
    expect(oldPlan.conflicts).toEqual([])
    await put('keep.txt', 'user edited')
    const newPlan = await store.action('thread', 'turn', idle, oldPlan.token, choice)
    expect(newPlan).toMatchObject({ kind: 'plan', conflicts: ['keep.txt'] })
    expect(await content('tracked.txt')).toBe('turn')
    expect(await store.action('thread', 'turn', () => true)).toEqual({ kind: 'busy' })
    expect(await store.action('wrong-thread', 'turn', idle)).toEqual({ kind: 'unavailable' })
    const current = await plan('thread', 'turn')
    expect(await store.action('thread', 'turn', idle, current.token, choice)).toMatchObject({ kind: 'undone', skipped: choice === 'skip' ? 1 : 0 })
    expect(await content('tracked.txt')).toBe('original\n')
    expect(await content('keep.txt')).toBe(choice === 'skip' ? 'user edited' : 'before')
  })

  it('protects files touched by later turns even when the contents match the earlier ending state', async () => {
    await init()
    await store.begin('thread', 'first', repo)
    await put('tracked.txt', 'first')
    await store.finish('thread', 'first')
    await store.begin('thread', 'second', repo)
    await put('tracked.txt', 'second')
    await store.finish('thread', 'second')
    await put('tracked.txt', 'first')
    expect((await plan('thread', 'first')).conflicts).toEqual(['tracked.txt'])
  })

  it('restores files in a non-Git workspace without adding a .git directory and skips excluded folders', async () => {
    await mkdir(join(repo, 'src', 'node_modules'), { recursive: true })
    await put('src/node_modules/cache.txt', 'first')
    await put('notes.txt', 'before')
    await store.begin('private', 'turn', repo)
    await put('notes.txt', 'after')
    await put('src/node_modules/cache.txt', 'second')
    await store.finish('private', 'turn')
    const info = await plan('private', 'turn')
    expect(info.files).toEqual(['notes.txt'])
    expect(await store.action('private', 'turn', idle, info.token, 'skip')).toEqual({ kind: 'undone', restored: 1, skipped: 0 })
    expect(await content('notes.txt')).toBe('before')
    expect(await content('src/node_modules/cache.txt')).toBe('second')
    await missing('.git')
  })

  it('restores both directions of file and directory replacement, with original permissions', async () => {
    await init()
    await mkdir(join(repo, 'directory'))
    await put('directory/child', 'child before')
    await put('private-file', 'private before')
    await chmod(join(repo, 'private-file'), 0o600)
    await store.begin('thread', 'turn', repo)
    await rm(join(repo, 'directory'), { recursive: true })
    await put('directory', 'child replaced by a file')
    await rm(join(repo, 'private-file'))
    await mkdir(join(repo, 'private-file', 'deep'), { recursive: true })
    await put('private-file/deep/child', 'new child')
    await store.finish('thread', 'turn')

    const info = await plan('thread', 'turn')
    expect(info.conflicts).toEqual([])
    expect(await store.action('thread', 'turn', idle, info.token, 'skip')).toEqual({ kind: 'undone', restored: 4, skipped: 0 })
    expect(await content('private-file')).toBe('private before')
    expect((await stat(join(repo, 'private-file'))).mode & 0o777).toBe(0o600)
    expect(await content('directory/child')).toBe('child before')
  })

  it('protects an unrelated file in a replacement directory even when overwrite is chosen', async () => {
    await init()
    await store.begin('thread', 'turn', repo)
    await rm(join(repo, 'tracked.txt'))
    await mkdir(join(repo, 'tracked.txt'))
    await put('tracked.txt/model.txt', 'new')
    await store.finish('thread', 'turn')
    await put('tracked.txt/user.txt', 'keep')
    const info = await plan('thread', 'turn')
    expect(new Set(info.conflicts)).toEqual(new Set(['tracked.txt', 'tracked.txt/model.txt']))
    expect(await store.action('thread', 'turn', idle, info.token, 'overwrite')).toEqual({ kind: 'partial', restored: 0, failed: 2 })
    expect(await content('tracked.txt/user.txt')).toBe('keep')
    expect(await content('tracked.txt/model.txt')).toBe('new')
  })

  it('uses the linked worktree index and shares the retention limit with the main worktree', async () => {
    await init()
    const main = repo
    repo = join(temp, 'linked')
    await git(main, 'worktree', 'add', '-b', 'linked', repo)
    await put('linked.txt', 'staged in the linked worktree')
    await git(repo, 'add', 'linked.txt')
    await put('.gitignore', '*.ignored\nlinked.txt\n')
    store = new Checkpoints(data, { retain: 1 })
    await store.begin('main-thread', 'main-turn', main)
    await store.finish('main-thread', 'main-turn')

    const index = await git(repo, 'diff', '--cached')
    await store.begin('linked-thread', 'linked-turn', repo)
    await put('linked.txt', 'changed')
    await store.finish('linked-thread', 'linked-turn')
    expect(await git(repo, 'diff', '--cached')).toBe(index)
    expect(await refs(main)).not.toContain('/main-turn/')
    const info = await plan('linked-thread', 'linked-turn')
    expect(info.files).toEqual(['linked.txt'])
    expect(await store.action('linked-thread', 'linked-turn', idle, info.token, 'skip')).toMatchObject({ kind: 'undone' })
    expect(await content('linked.txt')).toBe('staged in the linked worktree')
  })

  it('does not publish ambiguous checkpoints for turns running in the same workspace', async () => {
    await init()
    await store.begin('one', 'first', repo)
    await store.begin('two', 'second', repo)
    await put('tracked.txt', 'overlapping change')
    await store.finish('one', 'first')
    await store.finish('two', 'second')
    expect(await store.list('one')).toEqual([{ turnId: 'first', status: 'overlap' }])
    expect(await store.list('two')).toEqual([{ turnId: 'second', status: 'overlap' }])
    expect(await refs(repo)).toBe('')
    expect(await store.action('one', 'first', idle)).toEqual({ kind: 'unavailable' })
  })

  it('says nothing about overlap when overlapping turns changed no files', async () => {
    await init()
    await store.begin('one', 'quiet-a', repo)
    await store.begin('two', 'quiet-b', repo)
    await store.finish('one', 'quiet-a')
    await store.finish('two', 'quiet-b')
    expect(await store.list('one')).toEqual([])
    expect(await store.list('two')).toEqual([])
    expect(await refs(repo)).toBe('')
  })

  it('explains overlap for a turn that started while another was still running', async () => {
    await init()
    await store.begin('one', 'early', repo)
    await store.finish('one', 'early')
    await store.begin('one', 'long', repo)
    await store.begin('two', 'late', repo)
    await put('tracked.txt', 'changed by one of them')
    await store.finish('two', 'late')
    await store.finish('one', 'long')
    expect(await store.list('one')).toEqual([{ turnId: 'long', status: 'overlap' }])
    expect(await store.list('two')).toEqual([{ turnId: 'late', status: 'overlap' }])
  })

  it('keeps unowned checkpoint refs when publishing fails', async () => {
    await init()
    const ref = 'refs/agentswitch/checkpoints/collision/before'
    await git(repo, 'update-ref', ref, 'HEAD')
    await store.begin('thread', 'collision', repo)
    await put('tracked.txt', 'model can keep working')
    await store.finish('thread', 'collision')
    expect(await store.list('thread')).toEqual([])
    expect(await refs(repo)).toBe(ref)
    expect(await git(repo, 'rev-parse', ref)).toBe(await git(repo, 'rev-parse', 'HEAD'))
  })

  it('retains only the newest checkpoints per repository and deletes refs by thread after restart', async () => {
    await init()
    store = new Checkpoints(data, { retain: 2 })
    for (const [thread, turn] of [['one', 'old'], ['two', 'new'], ['one', 'latest']]) {
      await store.begin(thread, turn, repo)
      await put('tracked.txt', turn)
      await store.finish(thread, turn)
    }
    expect(await refs(repo)).toBe([
      'refs/agentswitch/checkpoints/latest/after', 'refs/agentswitch/checkpoints/latest/before',
      'refs/agentswitch/checkpoints/new/after', 'refs/agentswitch/checkpoints/new/before'
    ].join('\n'))
    store = new Checkpoints(data)
    expect(await store.deleteThread('one')).toEqual([])
    expect(await store.list('one')).toEqual([])
    expect(await refs(repo)).toBe('refs/agentswitch/checkpoints/new/after\nrefs/agentswitch/checkpoints/new/before')
  })

  it('hides unchanged turns and fails safely without Git, for oversize snapshots, and when capture fails', async () => {
    await init()
    await store.begin('thread', 'unchanged', repo)
    await store.finish('thread', 'unchanged')
    expect(await store.list('thread')).toEqual([])

    const noGit = new Checkpoints(data, { gitAvailable: async () => false })
    await noGit.begin('thread', 'absent', repo)
    await noGit.finish('thread', 'absent')
    expect(await noGit.list('thread')).toEqual([])
    expect(await refs(repo)).not.toContain('/absent/')

    const limited = new Checkpoints(data, { maxFiles: 1 })
    await limited.begin('thread', 'limit', repo)
    await limited.finish('thread', 'limit')
    expect(await limited.list('thread')).toEqual([{ turnId: 'limit', status: 'tooLarge' }])
    expect(await refs(repo)).not.toContain('/limit/')

    await store.begin('thread', 'huge', repo)
    await put('huge.bin', '')
    await truncate(join(repo, 'huge.bin'), 21 * 1024 * 1024)
    await store.finish('thread', 'huge')
    expect(await store.list('thread')).toContainEqual({ turnId: 'huge', status: 'tooLarge' })
    expect(await refs(repo)).not.toContain('/huge/')

    await store.begin('thread', 'broken', join(repo, 'missing'))
    await store.finish('thread', 'broken')
    expect(await store.list('thread')).not.toContainEqual(expect.objectContaining({ turnId: 'broken' }))
  })
})

describe('conversation rewind checkpoints', () => {
  it('restores multiple turns newest-to-oldest and discards truncated checkpoints', async () => {
    await init()
    await store.begin('thread', 't1', repo)
    await put('tracked.txt', 'after-t1\n')
    await store.finish('thread', 't1')

    await store.begin('thread', 't2', repo)
    await put('tracked.txt', 'after-t2\n')
    await put('from-t2.txt', 'hello')
    await store.finish('thread', 't2')

    await store.begin('thread', 't3', repo)
    await put('tracked.txt', 'after-t3\n')
    await put('from-t3.txt', 'world')
    await store.finish('thread', 't3')

    const p = await store.planRewind('thread', ['t2', 't3'], idle)
    expect(p.kind).toBe('ready')
    if (p.kind !== 'ready') throw new Error(JSON.stringify(p))
    expect(p.checkpointTurnIds).toEqual(['t3', 't2'])
    expect(p.unavailableTurnIds).toEqual([])
    expect(new Set(p.files)).toEqual(new Set(['tracked.txt', 'from-t2.txt', 'from-t3.txt']))

    const res = await store.rewind('thread', ['t2', 't3'], true, idle, 'overwrite')
    expect(res.kind).toBe('ok')
    expect(await content('tracked.txt')).toBe('after-t1\n')
    await missing('from-t2.txt')
    await missing('from-t3.txt')

    // Truncated turns removed, earlier turn preserved
    expect(await store.list('thread')).toEqual([{ turnId: 't1', status: 'ready' }])
    expect(await refs(repo)).toContain('/t1/before')
    expect(await refs(repo)).not.toContain('/t2/')
    expect(await refs(repo)).not.toContain('/t3/')
  })

  it('aborts before touching any file if any checkpoint in rewind range is unavailable or corrupted', async () => {
    await init()
    await store.begin('thread', 't1', repo)
    await put('tracked.txt', 'after-t1\n')
    await store.finish('thread', 't1')

    await store.begin('thread', 't2', repo)
    await put('tracked.txt', 'after-t2\n')
    await put('t2.txt', 'created-in-t2')
    await store.finish('thread', 't2')

    // Delete t1's checkpoint refs and prune unreachable objects so pre-check fails before t2 is rolled back
    await git(repo, 'update-ref', '-d', 'refs/agentswitch/checkpoints/t1/before')
    await git(repo, 'update-ref', '-d', 'refs/agentswitch/checkpoints/t1/after')
    await git(repo, 'gc', '--prune=now')

    const res = await store.rewind('thread', ['t1', 't2'], true, idle, 'overwrite')
    expect(res.kind).toBe('unavailable')
    // Workspace and checkpoint state must remain completely untouched
    expect(await content('tracked.txt')).toBe('after-t2\n')
    expect(await content('t2.txt')).toBe('created-in-t2')
    expect(await store.list('thread')).toEqual([
      { turnId: 't1', status: 'ready' },
      { turnId: 't2', status: 'ready' }
    ])
  })

  it('discards checkpoints without altering files when restoreFiles is false, and rejects when busy', async () => {
    await init()
    await store.begin('thread', 't1', repo)
    await put('tracked.txt', 'after-t1\n')
    await store.finish('thread', 't1')

    expect(await store.rewind('thread', ['t1'], true, () => true)).toEqual({ kind: 'busy' })
    expect(await content('tracked.txt')).toBe('after-t1\n')

    const res = await store.rewind('thread', ['t1'], false, idle)
    expect(res).toEqual({ kind: 'ok', restored: 0, skipped: 0, clearedSessions: false })
    expect(await content('tracked.txt')).toBe('after-t1\n')
    expect(await store.list('thread')).toEqual([])
  })
})
