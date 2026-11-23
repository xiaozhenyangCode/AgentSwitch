import { describe, expect, it, vi } from 'vitest'
import type { AssistantMessage, ChatState, PendingPermission, Thread } from '@shared/chat'
import { ChatWrites, openChats, restoreChats } from './chatPersistence'

function thread(id: string): Thread {
  return {
    id, title: id, messages: [], participants: [], driver: { profileId: null, model: null },
    projectDir: null, workdir: null, activeTurn: null, pause: null, createdAt: 1, updatedAt: 1
  }
}

const withThreads = (...threads: Thread[]): ChatState => ({ threads, activeId: threads[0]?.id ?? null })

describe('ChatWrites', () => {
  it('ignores previews and history-only updates, and saves a preview when it becomes a chat', () => {
    const a = thread('a')
    const preview = { ...thread('preview'), preview: true }
    const prev = withThreads(a)
    const next = withThreads(preview, { ...a, history: [], historyState: 'loading' })
    const writes = new ChatWrites()
    writes.track(prev, next)
    expect(writes.snapshot()).toBeNull()

    writes.track(next, withThreads({ ...preview, preview: false, history: [] }, a))
    expect(writes.snapshot()?.changes).toEqual({
      upserts: [{ ...thread('preview'), preview: false }], deletes: [],
      index: { activeId: 'preview', order: ['preview', 'a'] }
    })
  })

  it('coalesces chat changes and keeps edits made while an earlier batch is in flight', () => {
    const a = thread('a')
    const b = thread('b')
    const writes = new ChatWrites()
    const prev = withThreads(a, b)
    const edited = withThreads({ ...a, title: 'First' }, b)
    writes.track(prev, edited)
    const batch = writes.snapshot()!
    const next = withThreads({ ...a, title: 'Second' }, b)
    writes.track(edited, next)
    expect(batch.changes.upserts.map((t) => t.title)).toEqual(['First'])
    batch.acknowledge()
    expect(writes.snapshot()?.changes).toEqual({ upserts: [{ ...a, title: 'Second' }], deletes: [], index: undefined })
    writes.snapshot()?.acknowledge()
    expect(writes.snapshot()).toBeNull()
  })

  it('retains a failed batch and tracks deletion and selection in the index', () => {
    const a = thread('a')
    const b = thread('b')
    const writes = new ChatWrites()
    const prev = withThreads(a, b)
    const next = { ...prev, activeId: 'b' }
    writes.track(prev, next)
    expect(writes.snapshot()?.changes).toEqual({ upserts: [], deletes: [], index: { activeId: 'b', order: ['a', 'b'] } })
    writes.track(next, withThreads(b))
    const batch = writes.snapshot()
    expect(writes.snapshot()?.changes).toEqual(batch?.changes)
    expect(batch?.changes).toEqual({ upserts: [], deletes: ['a'], index: { activeId: 'b', order: ['b'] } })
    batch?.acknowledge()
    expect(writes.snapshot()).toBeNull()
  })
})

describe('opening chats', () => {
  it('removes the canonical legacy key only after the main process succeeds', async () => {
    const storage = { getItem: vi.fn(() => 'legacy JSON'), removeItem: vi.fn() }
    const result = { ...withThreads(thread('a')), hasBackup: true, migrationComplete: true, session: 1 }
    const open = vi.fn().mockRejectedValueOnce(new Error('could not read chats')).mockResolvedValueOnce(result)
    await expect(openChats(storage, open)).rejects.toThrow('could not read chats')
    expect(storage.removeItem).not.toHaveBeenCalled()
    await expect(openChats(storage, open)).resolves.toEqual(result)
    expect(open).toHaveBeenLastCalledWith('legacy JSON')
    expect(storage.removeItem).toHaveBeenCalledExactlyOnceWith('agentswitch.threads.v2')
  })

  it('keeps the old key after a partial migration, even when two chats are available', async () => {
    const legacy = JSON.stringify({ threads: [thread('a'), { id: 'bad' }, thread('b')] })
    const storage = { getItem: vi.fn(() => legacy), removeItem: vi.fn() }
    const partial = { ...withThreads(thread('a'), thread('b')), hasBackup: false, migrationComplete: false, session: 1 }
    const open = vi.fn().mockResolvedValue(partial)
    await expect(openChats(storage, open)).resolves.toEqual(partial)
    expect(open).toHaveBeenCalledExactlyOnceWith(legacy)
    expect(storage.removeItem).not.toHaveBeenCalled()
  })

  it('consults the AgentMux key only until a backup exists and keeps the original key', async () => {
    const storage = { getItem: vi.fn((key) => key.startsWith('agentmux.') ? 'AgentMux JSON' : null), removeItem: vi.fn() }
    const empty = { ...withThreads(), hasBackup: false, migrationComplete: false, session: 1 }
    const migrated = { ...withThreads(thread('a')), hasBackup: true, migrationComplete: true, session: 2 }
    const open = vi.fn().mockResolvedValueOnce(empty).mockResolvedValue(migrated)
    await expect(openChats(storage, open)).resolves.toEqual(migrated)
    expect(open).toHaveBeenLastCalledWith('AgentMux JSON', true)
    storage.getItem.mockClear()
    await expect(openChats(storage, open)).resolves.toEqual(migrated)
    expect(storage.getItem).toHaveBeenCalledExactlyOnceWith('agentswitch.threads.v2')
    expect(storage.removeItem).not.toHaveBeenCalled()
  })

  it('restores the loaded selection, drops viewed-only history and resets a saved pause', () => {
    const viewed = {
      ...thread('viewed'),
      imported: { key: 'history', profileId: 'test', kind: 'claude' as const, nativeId: 'native', importedAt: 1, notice: null }
    }
    const permission: PendingPermission = {
      t: 'permission', requestId: 'request', kind: 'question', title: 'Choose', options: [], expiresAt: 10
    }
    const message: AssistantMessage = {
      role: 'assistant', id: 'step', turnId: 'turn', agent: { profileId: 'test', name: 'Test', kind: 'claude', model: null },
      actualModel: null, dispatchedBy: null, status: 'done', content: '', activity: [], permissions: [permission],
      thinking: null, usage: null, others: [], outputs: [], error: null, notices: [], review: false, retry: 0,
      verdict: null, startedAt: null, endedAt: null
    }
    const running: AssistantMessage = { ...message, id: 'live', status: 'streaming' }
    const paused = {
      ...thread('paused'), activeTurn: 'turn', pause: { turnId: 'turn', reason: 'review' }, messages: [message, running]
    }
    const restored = restoreChats(withThreads(viewed, paused))
    expect(restored.state).toEqual(withThreads({
      ...paused, pause: null, messages: [
        { ...message, permissions: [{ ...permission, resolved: { outcome: 'cancelled', by: 'auto' } }] },
        running
      ]
    }))
    expect(restored.viewedOnly).toEqual([viewed])
  })
})
