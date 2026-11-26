import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OutputFileRef, Thread } from '@shared/chat'
import { ChatStore } from './chatStore'

let userData: string
let chats: string
let store: ChatStore

function thread(id: string, title = id): Thread {
  return {
    id, title, messages: [], participants: [], driver: { profileId: null, model: null },
    projectDir: null, workdir: null, activeTurn: null, pause: null, createdAt: 1, updatedAt: 1
  }
}

beforeEach(() => {
  userData = mkdtempSync('/tmp/agentswitch-chat-store-')
  chats = join(userData, 'chats')
  store = new ChatStore(userData)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(userData, { recursive: true, force: true })
})

describe('ChatStore', () => {
  it('writes only requested chats, keeps their order and deletes the matching file', () => {
    const { session } = store.open(null, false)
    expect(existsSync(chats)).toBe(false)
    expect(store.save(session, 1, {
      upserts: [thread('a'), thread('b')], deletes: [], index: { order: ['b', 'a'], activeId: 'a' }
    })).toBe(true)
    expect(store.load().threads.map((t) => t.id)).toEqual(['b', 'a'])
    const sibling = join(chats, 'b.json')
    utimesSync(sibling, 1, 1)
    const indexTime = statSync(join(chats, 'index.json')).mtimeMs
    expect(store.save(session, 2, { upserts: [thread('a', 'Renamed')], deletes: [] })).toBe(true)
    expect(statSync(sibling).mtimeMs).toBe(1000)
    expect(statSync(join(chats, 'index.json')).mtimeMs).toBe(indexTime)
    expect(store.load().threads.find((t) => t.id === 'a')?.title).toBe('Renamed')

    expect(store.save(session, 3, { upserts: [], deletes: ['a'], index: { order: ['b'], activeId: 'b' } })).toBe(true)
    expect(readdirSync(chats).sort()).toEqual(['b.json', 'index.json'])
    expect(existsSync(join(userData, 'threads'))).toBe(false)
  })

  it('rejects malformed save requests before writing or consuming a revision', () => {
    const { session } = store.open(null, false)
    const changes = { upserts: [thread('good')], deletes: [] }
    expect(store.save(String(session), 1, changes)).toBe(false)
    expect(store.save(session, NaN, changes)).toBe(false)
    expect(store.save(session, 1, { ...changes, deletes: [null] })).toBe(false)
    expect(store.save(session, 1, { ...changes, upserts: [{ id: 'malformed' }] })).toBe(false)
    expect(store.save(session, 1, { ...changes, index: { activeId: null, order: [1] } })).toBe(false)
    expect(existsSync(chats)).toBe(false)
    expect(store.save(session, 1, changes)).toBe(true)
    expect(store.load().threads).toEqual([thread('good')])
  })

  it('restores a pending queue with its send parameters and removes it with the chat', () => {
    const driver = { profileId: 'driver', name: 'Driver', kind: 'claude' as const, model: 'model' }
    const queued = {
      ...thread('queued'), queueHold: 'external' as const,
      queuedMessages: [{
        id: 'pending', text: 'Waiting', driver, mentions: [driver], participants: [driver.profileId],
        projectDir: '/tmp/project', attachments: [{ id: 'file', name: 'notes.txt', path: '/tmp/notes.txt', size: 14, isImage: false, thumb: null }]
      }]
    }
    const { session } = store.open(null, false)
    expect(store.save(session, 1, { upserts: [queued], deletes: [] })).toBe(true)
    const reopened = new ChatStore(userData)
    const loaded = reopened.open(null, false)
    expect(loaded.threads).toEqual([queued])
    expect(reopened.save(loaded.session, 1, { upserts: [], deletes: [queued.id] })).toBe(true)
    expect(reopened.load().threads).toEqual([])
  })

  it('restores valid portable metadata while ignoring malformed optional fields', () => {
    const image: OutputFileRef = {
      path: '/original/project/figure.svg', name: 'figure.svg', source: 'workspace-file', relativePath: 'figure.svg',
      size: 100, mimeType: 'image/svg+xml', bundlePath: 'attachments/figure.svg',
      fallbackPath: '/app/attachments/figure.svg', skippedReason: 'missing', inlineOnly: true
    }
    const path = '/original/project/notes.txt'
    const notes = { path, name: 'notes.txt', source: 'workspace-file' }
    mkdirSync(chats, { recursive: true })
    writeFileSync(join(chats, 'portable.json'), JSON.stringify({
      ...thread('portable'),
      sourceProjectDir: '/original/project',
      sourceProjectName: 42,
      messages: [
        { role: 'assistant', content: 'Updated', agent: {}, outputs: [path], outputFiles: [image, null, {},
          { ...notes, bundlePath: ['invalid'], size: -1, skippedReason: 'other', inlineOnly: 'false' }] },
        { role: 'assistant', content: 'Legacy', agent: {}, outputs: [path], outputFiles: false }
      ]
    }))
    const [loaded] = store.load().threads
    expect(loaded.sourceProjectDir).toBe('/original/project')
    expect(loaded).not.toHaveProperty('sourceProjectName')
    expect(loaded.messages[0]).toHaveProperty('outputs', [path])
    expect(loaded.messages[0]).toHaveProperty('outputFiles', [image, notes])
    expect(loaded.messages[1]).not.toHaveProperty('outputFiles')
  })

  it('skips damaged chats and stale index entries while recovering unindexed files', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { session } = store.open(null, false)
    store.save(session, 1, {
      upserts: [thread('good'), thread('broken'), thread('invalid'), thread('unindexed')], deletes: [],
      index: { order: ['broken', 'invalid', 'good'], activeId: 'broken' }
    })
    writeFileSync(join(chats, 'broken.json'), '{"id":')
    writeFileSync(join(chats, 'invalid.json'), '{"id":"invalid","messages":null}')
    writeFileSync(join(chats, 'interrupted.json.tmp'), 'incomplete')
    expect(store.load()).toEqual({ threads: [thread('unindexed'), thread('good')], activeId: 'unindexed' })
    expect(warn).toHaveBeenCalledTimes(2)
    rmSync(join(chats, 'index.json'))
    mkdirSync(join(chats, 'index.json'))
    expect(store.open(null, false).threads.map((t) => t.id).sort()).toEqual(['good', 'unindexed'])
    expect(warn).toHaveBeenCalledWith('[chatStore] ignoring an unreadable chat index')
  })

  it('safely stores IDs that would collide with paths, metadata or other IDs', () => {
    const ids = ['index', '../outside', 'legacy-localstorage-backup', 'UPPER', 'upper', 'a'.repeat(300)]
    const { session } = store.open(null, false)
    expect(store.save(session, 1, { upserts: ids.map((id) => thread(id)), deletes: [] })).toBe(true)
    expect(new Set(store.load().threads.map((t) => t.id))).toEqual(new Set(ids))
    expect(readdirSync(userData)).toEqual(['chats'])
  })

  it('keeps the latest flush when a queued write arrives late, and retries a failed rename', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { session } = store.open(null, false)
    store.save(session, 2, { upserts: [thread('a', 'Flushed')], deletes: [] })
    store.save(session, 1, { upserts: [thread('a', 'Stale')], deletes: [] })
    expect(store.load().threads[0].title).toBe('Flushed')

    mkdirSync(join(chats, 'blocked.json'))
    const changes = { upserts: [thread('blocked')], deletes: [] }
    expect(store.save(session, 3, changes)).toBe(false)
    expect(readdirSync(chats).sort()).toEqual(['a.json', 'blocked.json'])
    rmSync(join(chats, 'blocked.json'), { recursive: true })
    expect(store.save(session, 4, changes)).toBe(true)
    expect(store.load().threads).toContainEqual(thread('blocked'))
    expect(store.open(null, false).session).not.toBe(session)
    expect(store.save(session, 5, changes)).toBe(false)
  })

  it('migrates once, verifies collisions, and preserves both existing chats and the original backup', () => {
    const { session } = store.open(null, false)
    store.save(session, 1, {
      upserts: [thread('existing', 'Disk copy')], deletes: [],
      index: { order: ['existing'], activeId: 'existing' }
    })
    const raw = JSON.stringify({
      activeId: 'new', threads: [
        thread('existing', 'Legacy copy'),
        { ...thread('new'), history: [], historyState: 'loading' },
        { ...thread('preview'), preview: true }
      ]
    }, null, 2)
    const backup = join(chats, 'legacy-localstorage-backup.json')
    const opened = store.open(raw, false)
    expect(opened).toMatchObject({
      activeId: 'existing', hasBackup: true, threads: [thread('existing', 'Disk copy'), thread('new')]
    })
    expect(readFileSync(backup, 'utf8')).toBe(raw)
    utimesSync(join(chats, 'new.json'), 1, 1)
    store.open(raw, false)
    expect(statSync(join(chats, 'new.json')).mtimeMs).toBe(1000)
    store.open(JSON.stringify({ threads: [thread('later')] }), false)
    expect(readFileSync(backup, 'utf8')).toBe(raw)
    expect(store.open(JSON.stringify({ threads: [thread('agentmux')] }), true).threads.map((t) => t.id)).not.toContain('agentmux')
  })

  it('skips one invalid legacy chat and saves two valid chats, including messages with missing optional fields', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const agent = { profileId: 'test', name: 'Test', kind: 'claude', model: null }
    const legacyUser = { role: 'user', id: 'message', turnId: 'turn', text: 'Hello', driver: agent, createdAt: 1 }
    const minimal = { id: 'minimal', title: 'Minimal', messages: [legacyUser] }
    const raw = JSON.stringify({ activeId: 'invalid', threads: [thread('first'), { id: 'invalid', messages: [] }, minimal] })
    const opened = store.open(raw, false)
    expect(opened).toMatchObject({
      migrationComplete: false, hasBackup: false, activeId: 'first',
      threads: [thread('first'), { ...thread('minimal', 'Minimal'), createdAt: 0, updatedAt: 0, messages: [{ ...legacyUser, attachments: [], mentions: [] }] }]
    })
    expect(readdirSync(chats).sort()).toEqual(['first.json', 'index.json', 'minimal.json'])
    expect(warn).toHaveBeenCalledWith('[chatStore] skipping legacy chat', 2, 'Error')
    expect(store.open(raw, false).migrationComplete).toBe(false)
  })

  it('returns existing chats while malformed legacy JSON remains pending', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { session } = store.open(null, false)
    store.save(session, 1, { upserts: [thread('existing')], deletes: [] })
    expect(store.open('{', false)).toMatchObject({
      migrationComplete: false, hasBackup: false, threads: [thread('existing')]
    })
    expect(existsSync(join(chats, 'legacy-localstorage-backup.json'))).toBe(false)
  })

  it('does not bring back a chat deleted while a partial migration is waiting to retry', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = JSON.stringify({ threads: [thread('deleted'), thread('kept'), { id: 'invalid' }] })
    const { session } = store.open(raw, false)
    expect(store.save(session, 1, {
      upserts: [], deletes: ['deleted'], index: { activeId: 'kept', order: ['kept'] }
    })).toBe(true)
    expect(store.open(raw, false)).toMatchObject({ migrationComplete: false, threads: [thread('kept')] })
    expect(existsSync(join(chats, 'deleted.json'))).toBe(false)
  })

  it('retries a partial migration without overwriting files and backs up only after verification', () => {
    const raw = JSON.stringify({ activeId: 'retry', threads: [thread('copied'), thread('retry')] })
    mkdirSync(chats)
    const blocked = join(chats, 'retry.json')
    writeFileSync(blocked, '{')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(store.open(raw, false)).toMatchObject({
      migrationComplete: false, hasBackup: false, threads: [thread('copied')]
    })
    expect(readFileSync(blocked, 'utf8')).toBe('{')
    expect(existsSync(join(chats, 'legacy-localstorage-backup.json'))).toBe(false)
    utimesSync(join(chats, 'copied.json'), 1, 1)
    rmSync(blocked)
    expect(store.open(raw, false)).toMatchObject({
      activeId: 'copied', migrationComplete: true, hasBackup: true, threads: [thread('copied'), thread('retry')]
    })
    expect(statSync(join(chats, 'copied.json')).mtimeMs).toBe(1000)
  })

  it('persists and reloads system compact divider messages cleanly', () => {
    const withCompact: Thread = {
      ...thread('compacted'),
      messages: [
        { role: 'system', id: 'sys-1', turnId: '', kind: 'compact', profileIds: ['claude-1'], createdAt: 1234 }
      ]
    }
    const { session } = store.open(null, false)
    expect(store.save(session, 1, { upserts: [withCompact], deletes: [] })).toBe(true)
    const reloaded = new ChatStore(userData).open(null, false)
    expect(reloaded.threads).toEqual([withCompact])
  })
})
