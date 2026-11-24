import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageInput, OpenChats, Thread } from '@shared/chat'
import type { ChatEvent, RunRequest } from '@shared/types'

vi.mock('./i18n', () => ({ t: (key: string) => key }))

const input: MessageInput = {
  text: '', attachments: [], driver: { profileId: 'test', name: 'Test', kind: 'claude', model: 'test-model' },
  mentions: [], participants: ['test'], projectDir: '/tmp/test-project'
}
const imported: Thread['imported'] = {
  key: 'history', profileId: 'test', kind: 'claude', nativeId: 'native', importedAt: 1, notice: null
}
const fixture: Thread = {
  id: 'thread', title: 'Test', projectDir: null, workdir: null, participants: ['test'],
  driver: { profileId: 'test', model: null }, messages: [], activeTurn: null, pause: null, createdAt: 1, updatedAt: 1
}

const api = {
  open: vi.fn<() => Promise<OpenChats>>(),
  onEvent: vi.fn<(callback: (event: ChatEvent) => void) => void>(),
  send: vi.fn<(request: RunRequest) => Promise<void>>(),
  active: vi.fn(),
  pendingPermissions: vi.fn(),
  resume: vi.fn(),
  stop: vi.fn(),
  deleteThread: vi.fn()
}
const stat = vi.fn()
let chat: typeof import('./chat')
const emit = (event: ChatEvent) => api.onEvent.mock.calls[0][0](event)
const sent = () => api.send.mock.calls.map(([request]) => request.text)
const finish = (status: 'done' | 'error' | 'stopped' = 'done') => {
  const { threadId, turnId } = api.send.mock.lastCall![0]
  emit({ kind: 'turn-end', threadId, turnId, status })
}
const send = (text: string, id = fixture.id) => chat.send(id, { ...input, text })

async function open(thread: Thread = fixture) {
  api.open.mockResolvedValue({ threads: [thread], activeId: thread.id, session: 1, hasBackup: true, migrationComplete: true })
  chat = await import('./chat')
  await vi.waitFor(() => expect(api.pendingPermissions).toHaveBeenCalled())
}

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.useFakeTimers()
  api.send.mockResolvedValue(undefined)
  api.active.mockResolvedValue([])
  api.pendingPermissions.mockResolvedValue([])
  vi.stubGlobal('window', { addEventListener: vi.fn(), agentswitch: { chat: api, history: { stat } } })
  vi.stubGlobal('localStorage', { getItem: () => null })
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('chat queue dispatch', () => {
  it('sends idle input immediately and drains only one queued message per successful turn', async () => {
    await open()
    await send('first')
    const firstTurn = api.send.mock.lastCall![0].turnId
    const attachment = { id: 'file', name: 'note.txt', path: '/tmp/note.txt', size: 8, isImage: false, thumb: null }
    await chat.send(fixture.id, { ...input, text: 'second', attachments: [attachment], mentions: [input.driver] })
    await send('third')
    chat.editQueuedMessage(fixture.id, 'absent', 'ignored')
    chat.updateThread(fixture.id, { projectDir: '/tmp/changed', driver: { profileId: 'new', model: null } })
    const other = chat.newThread({ projectDir: null, participants: [], driver: fixture.driver })
    await send('other', other)
    await send('other queued', other)
    expect(sent()).toEqual(['first', 'other'])

    emit({ kind: 'turn-end', threadId: fixture.id, turnId: firstTurn, status: 'done' })
    await Promise.resolve()
    expect(sent()).toEqual(['first', 'other', 'second'])
    expect(api.send.mock.lastCall![0]).toMatchObject({
      projectDir: input.projectDir, driver: { profileId: 'test', model: 'test-model' },
      mentions: [{ profileId: 'test', model: 'test-model' }], participants: ['test'],
      attachments: [{ name: attachment.name, path: attachment.path, isImage: false }]
    })
    emit({ kind: 'turn-end', threadId: fixture.id, turnId: firstTurn, status: 'done' })
    await Promise.resolve()
    expect(sent()).toEqual(['first', 'other', 'second'])
    finish()
    await Promise.resolve()
    expect(sent()).toEqual(['first', 'other', 'second', 'third'])
  })

  it.each(['error', 'stopped', 'pause', 'stop-race', 'send-rejected'] as const)('holds the queue after %s until a manual continuation', async (outcome) => {
    await open()
    if (outcome === 'send-rejected') api.send.mockRejectedValueOnce(new Error('rejected'))
    await send('first')
    await send('waiting')
    if (outcome === 'pause') {
      emit({ kind: 'paused', ...api.send.mock.lastCall![0], reason: 'review' })
      await chat.continueQueuedMessages(fixture.id, vi.fn())
      expect(sent()).toEqual(['first'])
      chat.resolvePause(fixture.id, 'skip')
      finish()
    } else if (outcome === 'stop-race') {
      chat.stop(fixture.id)
      finish()
    } else if (outcome !== 'send-rejected') {
      finish(outcome)
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(sent()).toEqual(['first'])
    await send('new direct message')
    finish()
    expect(sent()).toEqual(['first', 'new direct message'])
    await chat.continueQueuedMessages(fixture.id, vi.fn())
    expect(sent()).toEqual(['first', 'new direct message', 'waiting'])
  })

  it('checks an imported session even without loaded history and retains the head without a prompt', async () => {
    await open()
    await send('first')
    chat.patchThreadState(fixture.id, { imported })
    const confirmBusy = vi.fn<() => Promise<boolean>>().mockResolvedValue(false)
    await chat.send(fixture.id, { ...input, text: 'waiting' }, confirmBusy)
    stat.mockResolvedValue({ mtimeMs: Date.now(), size: 100 })
    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(stat).toHaveBeenCalledTimes(1)
    expect(confirmBusy).not.toHaveBeenCalled()
    expect(sent()).toEqual(['first'])

    await chat.continueQueuedMessages(fixture.id, confirmBusy)
    expect(confirmBusy).toHaveBeenCalledOnce()
    expect(sent()).toEqual(['first'])
    stat.mockResolvedValue({ mtimeMs: Date.now() - 5000, size: 100 })
    await chat.continueQueuedMessages(fixture.id, confirmBusy)
    expect(sent()).toEqual(['first', 'waiting'])
  })

  it('reattaches a live review pause and holds the queue after ending that turn', async () => {
    api.active.mockResolvedValue([{ threadId: fixture.id, turnId: 'review', running: [], pauseReason: 'waiting for review' }])
    const queuedMessages = [{ ...input, id: 'queue', text: 'waiting' }]
    await open({ ...fixture, activeTurn: 'review', queuedMessages })
    await chat.continueQueuedMessages(fixture.id, vi.fn())
    expect(sent()).toEqual([])
    chat.resolvePause(fixture.id, 'stop')
    expect(api.resume).toHaveBeenCalledWith(fixture.id, 'review', 'stop')
    emit({ kind: 'turn-end', threadId: fixture.id, turnId: 'review', status: 'stopped' })
    await chat.continueQueuedMessages(fixture.id, vi.fn())
    expect(sent()).toEqual(['waiting'])
  })

  it('does not restart an interrupted queue when a new direct turn finishes', async () => {
    await open({ ...fixture, activeTurn: 'lost', queuedMessages: [{ ...input, id: 'queue', text: 'waiting' }] })
    await send('first after restart')
    finish()
    expect(sent()).toEqual(['first after restart'])
    await chat.continueQueuedMessages(fixture.id, vi.fn())
    expect(sent()).toEqual(['first after restart', 'waiting'])
  })

  it('edits, removes and clears queued messages and discards the queue with its thread', async () => {
    await open({ ...fixture, queuedMessages: [{ ...input, id: 'edit', text: 'edit me' }, { ...input, id: 'remove', text: 'remove me' }] })
    chat.editQueuedMessage(fixture.id, 'edit', '  edited  ')
    chat.removeQueuedMessage(fixture.id, 'remove')
    await chat.continueQueuedMessages(fixture.id, vi.fn())
    expect(sent()).toEqual(['edited'])
    await send('clear me')
    chat.clearQueuedMessages(fixture.id)
    finish()
    await send('new turn')
    await chat.send(fixture.id, { ...input, text: 'handoff', handoffTo: input.driver })
    finish()
    expect(sent()).toEqual(['edited', 'new turn'])
    await send('last turn')
    await send('discard with chat')
    const deleting = chat.deleteThread(fixture.id)
    finish()
    await deleting
    expect(sent()).toEqual(['edited', 'new turn', 'last turn'])
  })
})
