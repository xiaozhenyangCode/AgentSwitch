import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatChanges, MessageInput, OpenChats, Thread } from '@shared/chat'
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
  deleteThread: vi.fn(),
  save: vi.fn<(session: number, revision: number, changes: ChatChanges) => Promise<{ ok: boolean; revision: number }>>(),
  compactSessions: vi.fn(),
  rewindPlan: vi.fn(),
  rewind: vi.fn()
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
  api.save.mockResolvedValue({ ok: true, revision: 1 })
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

describe('chat native title updates', () => {
  const stepAdd = (threadId: string, turnId: string, stepId = 'step-1') =>
    emit({ kind: 'step-add', threadId, turnId, stepId, profileId: 'test', name: 'Gemini', profileKind: 'gemini', model: null, dispatchedBy: null, review: false, retry: 0, after: null })

  it('prefers the CLI-native title over a hidden title marker while still stripping markers', async () => {
    await open()
    await send('帮我排查一下 agy 的标题同步问题')
    const { threadId, turnId } = api.send.mock.lastCall![0]
    stepAdd(threadId, turnId)
    emit({ kind: 'agent', threadId, turnId, stepId: 'step-1', event: { t: 'title', title: 'agy 原生会话标题' } })
    expect(chat.getThread(threadId)?.title).toBe('agy 原生会话标题')

    emit({ kind: 'agent', threadId, turnId, stepId: 'step-1', event: { t: 'text', delta: '查到了原因。\n<!-- agentswitch:title:标记标题 -->' } })
    emit({ kind: 'step-end', threadId, turnId, stepId: 'step-1', status: 'done' })
    finish()

    const th = chat.getThread(threadId)
    expect(th?.title).toBe('agy 原生会话标题')
    const reply = th?.messages.find((m) => m.role === 'assistant')
    expect(reply?.role === 'assistant' ? reply.content : '').toBe('查到了原因。')
  })

  it('falls back to the hidden title marker when no native title arrives and respects manual renames', async () => {
    await open()
    await send('第一条消息')
    const { threadId, turnId } = api.send.mock.lastCall![0]
    stepAdd(threadId, turnId)
    emit({ kind: 'agent', threadId, turnId, stepId: 'step-1', event: { t: 'text', delta: '好的。\n<!-- agentswitch:title:标记兜底标题 -->' } })
    emit({ kind: 'step-end', threadId, turnId, stepId: 'step-1', status: 'done' })
    finish()
    expect(chat.getThread(threadId)?.title).toBe('标记兜底标题')

    const second = chat.newThread({ projectDir: null, participants: ['test'], driver: fixture.driver })
    await send('另一条消息', second)
    const req2 = api.send.mock.lastCall![0]
    stepAdd(req2.threadId, req2.turnId, 'step-2')
    chat.renameThread(second, '我手动改的标题')
    emit({ kind: 'agent', threadId: req2.threadId, turnId: req2.turnId, stepId: 'step-2', event: { t: 'title', title: '不该覆盖手动标题' } })
    expect(chat.getThread(second)?.title).toBe('我手动改的标题')
  })
})

describe('chat task summary', () => {
  const addReply = async (text: string) => {
    await send('继续检查')
    const { threadId, turnId } = api.send.mock.lastCall![0]
    const ids = { threadId, turnId, stepId: `step-${turnId}` }
    emit({ kind: 'step-add', ...ids, profileId: 'test', name: 'Test', profileKind: 'claude', model: null, dispatchedBy: null, review: false, retry: 0, after: null })
    emit({ kind: 'agent', ...ids, event: { t: 'text', delta: text } })
    return ids
  }

  it('stores and persists progress separately from the completed reply', async () => {
    await open()
    const ids = await addReply('已找到原因。\n')
    const updatedAt = Date.now()
    emit({ kind: 'step-end', ...ids, status: 'done', marks: { title: null, next: null, task: '已定位原因，接下来修复' } })
    finish()
    const expected = { text: '已定位原因，接下来修复', updatedAt }
    expect(chat.getThread(ids.threadId)?.taskSummary).toEqual(expected)
    expect(chat.getThread(ids.threadId)?.messages.at(-1)).toMatchObject({ content: '已找到原因。' })
    await vi.advanceTimersByTimeAsync(400)
    expect(api.save.mock.lastCall?.[2].upserts).toEqual([expect.objectContaining({ id: ids.threadId, taskSummary: expected })])
    expect(sent()).toEqual(['继续检查'])
  })

  it('falls back to the first substantive sentence and preserves it after an incomplete step', async () => {
    await open()
    const ids = await addReply('## 总结\n- 已补回归测试。下一步全量验证。')
    emit({ kind: 'step-end', ...ids, status: 'done' })
    finish()
    const summary = chat.getThread(ids.threadId)?.taskSummary
    expect(summary?.text).toBe('已补回归测试。')

    const incomplete = await addReply('验证中。\n<!-- agentswitch:task:尚未完成 -->')
    emit({ kind: 'step-end', ...incomplete, status: 'stopped' })
    finish('stopped')
    expect(chat.getThread(ids.threadId)?.taskSummary).toEqual(summary)
    expect(chat.getThread(ids.threadId)?.messages.at(-1)).toMatchObject({ content: '验证中。' })
  })
})

describe('chat rewind, archive, and quote', () => {
  it('keeps the archived clipboard path and editable file token on rewind', async () => {
    await open()
    const staged = { id: 'clip', name: 'image.png', refLabel: 'image-2.png', source: 'chat-attachment' as const,
      isImage: true, path: '/tmp/staging/image.png', thumb: null, size: 10 }
    const text = 'Inspect #image-2.png in the middle'
    await chat.send(fixture.id, { ...input, text, attachments: [staged] })
    const { threadId, turnId, attachments } = api.send.mock.lastCall![0]
    expect(attachments[0]).toMatchObject({ path: staged.path, source: staged.source, refLabel: staged.refLabel })
    const archive = input.projectDir + '/.agentswitch/runs/' + turnId + '/attachments/image.png'
    emit({ kind: 'turn-start', threadId, turnId, cwd: input.projectDir!, archivedAttachments: [{ from: staged.path, to: archive }] })
    finish()
    const message = chat.getThread(fixture.id)!.messages.find((m) => m.role === 'user')!
    api.rewind.mockResolvedValueOnce({ kind: 'ok', restored: 0, skipped: 0, clearedSessions: true })
    const rewind = await chat.rewindThread(fixture.id, message.id, false)
    expect(rewind.message).toMatchObject({ text, attachments: [{ ...staged, path: archive }] })
  })

  it('validates before rewinding, preserves thread on backend failure, and truncates + returns original message on success', async () => {
    await open()
    const quote = { messageId: 'q1', role: 'assistant' as const, author: 'Claude', excerpt: 'quoted answer' }
    await chat.send(fixture.id, { ...input, text: 'turn one', quote })
    expect(api.send.mock.lastCall![0].quote).toEqual({ role: 'assistant', author: 'Claude', excerpt: 'quoted answer' })
    expect(api.send.mock.lastCall![0].text).toBe('turn one')
    const turn1 = api.send.mock.lastCall![0].turnId
    finish()

    await send('turn two')
    const turn2 = api.send.mock.lastCall![0].turnId
    const userMsgs = chat.getThread(fixture.id)!.messages.filter((m) => m.role === 'user')
    const msg1 = userMsgs[0]
    const msg2 = userMsgs[1]

    // Refuses while busy without calling api.rewind
    const busyRes = await chat.rewindThread(fixture.id, msg1.id, true)
    expect(busyRes.kind).toBe('busy')
    expect(api.rewind).not.toHaveBeenCalled()
    finish()

    // Backend failure does not truncate messages
    api.rewind.mockResolvedValueOnce({ kind: 'unavailable', reason: 'missing snapshot' })
    const failed = await chat.rewindThread(fixture.id, msg1.id, true)
    expect(failed.kind).toBe('unavailable')
    expect(chat.getThread(fixture.id)?.messages.filter((m) => m.role === 'user')).toHaveLength(2)

    // Backend success truncates from target message onward and returns original user message
    api.rewind.mockResolvedValueOnce({ kind: 'ok', restored: 2, skipped: 0, clearedSessions: true })
    const ok = await chat.rewindThread(fixture.id, msg2.id, true)
    expect(ok.kind).toBe('ok')
    expect(ok.message?.text).toBe('turn two')
    expect(chat.getThread(fixture.id)?.messages.filter((m) => m.role === 'user')).toHaveLength(1)
    expect(api.rewind).toHaveBeenLastCalledWith(fixture.id, [turn2], true, 'overwrite')
    expect(api.save).toHaveBeenCalled()

    // Rewinding first turn returns its quote
    api.rewind.mockResolvedValueOnce({ kind: 'ok', restored: 0, skipped: 0, clearedSessions: true })
    const okFirst = await chat.rewindThread(fixture.id, msg1.id, false)
    expect(okFirst.kind).toBe('ok')
    expect(okFirst.message?.quote).toEqual(quote)
    expect(chat.getThread(fixture.id)?.messages).toEqual([])
    expect(api.rewind).toHaveBeenLastCalledWith(fixture.id, [turn1], false, 'overwrite')
  })

  it('handles archive, unarchive, unpinning on archive, and auto-unarchive on send', async () => {
    await open({ ...fixture, pinned: true, unread: 'done' })
    chat.newThread({ projectDir: null, participants: ['test'], driver: fixture.driver })
    chat.selectThread(fixture.id)

    chat.archiveThread(fixture.id)
    const archived = chat.getThread(fixture.id)!
    expect(archived.archived).toBe(true)
    expect(typeof archived.archivedAt).toBe('number')
    expect(archived.pinned).toBe(false)
    expect(archived.unread).toBeNull()

    // Pinning an archived thread is a no-op
    chat.togglePin(fixture.id)
    expect(chat.getThread(fixture.id)?.pinned).toBe(false)

    // Sending in an archived thread automatically unarchives it
    await send('revive thread', fixture.id)
    finish()
    expect(chat.getThread(fixture.id)?.archived).toBe(false)
    expect(chat.getThread(fixture.id)?.archivedAt).toBeUndefined()

    // Explicit archive + unarchive roundtrip
    chat.archiveThread(fixture.id)
    expect(chat.getThread(fixture.id)?.archived).toBe(true)
    chat.unarchiveThread(fixture.id)
    expect(chat.getThread(fixture.id)?.archived).toBe(false)
  })

  it('inserts a system divider on compactContext success while preserving history and omitting it from transcript and markdown', async () => {
    await open()
    await send('first question')
    const turnId = api.send.mock.lastCall![0].turnId
    emit({ kind: 'step-add', threadId: fixture.id, turnId, stepId: 's1', profileId: 'test', name: 'Test', profileKind: 'claude', model: null, dispatchedBy: null, review: false, retry: 0, after: null })
    emit({ kind: 'step-start', threadId: fixture.id, turnId, stepId: 's1' })
    emit({ kind: 'agent', threadId: fixture.id, turnId, stepId: 's1', event: { t: 'text', delta: 'first answer' } })
    emit({ kind: 'step-end', threadId: fixture.id, turnId, stepId: 's1', status: 'done' })
    finish()

    // No bound session -> returns false and does not insert a divider
    api.compactSessions.mockResolvedValueOnce(false)
    await expect(chat.compactContext(fixture.id, ['test'], 's1', 1)).resolves.toBe(false)
    expect(chat.getThread(fixture.id)?.messages.some((m) => m.role === 'system')).toBe(false)

    // Bound session -> returns true, keeps all prior messages, appends system compact divider
    api.compactSessions.mockResolvedValueOnce(true)
    await expect(chat.compactContext(fixture.id, ['test'], 's1', 1)).resolves.toBe(true)
    const thread = chat.getThread(fixture.id)!
    expect(thread.messages).toHaveLength(3)
    expect(thread.messages[2]).toMatchObject({ role: 'system', kind: 'compact', profileIds: ['test'] })
    expect(api.compactSessions).toHaveBeenLastCalledWith(fixture.id, ['test'])

    // Markdown export omits system divider while keeping user + assistant content
    const md = chat.chatMarkdown(thread)
    expect(md).toContain('first question')
    expect(md).toContain('first answer')

    // Next turn transcript excludes the UI-only system divider
    await send('follow up')
    const sentTranscript = api.send.mock.lastCall![0].transcript
    expect(sentTranscript.map((e) => e.text)).toEqual(['first question', 'first answer'])
  })
})

describe('chat transfer import and project rebind', () => {
  it('rebinds an idle thread project, rewrites workspace files, preserves chat attachments, and rotates sessionScope', async () => {
    const importedThread: Thread = {
      ...fixture,
      id: 'imported-1',
      projectDir: null,
      workdir: null,
      sourceProjectDir: '/machine-a/ProjectX',
      sourceProjectName: 'ProjectX',
      sessionScope: 'scope-a',
      messages: [
        {
          role: 'user',
          id: 'u1',
          turnId: 't1',
          text: 'check these',
          createdAt: 1,
          driver: input.driver,
          mentions: [],
          attachments: [
            { id: 'att-chat', name: 'shot.png', path: '/machine-b/userData/attachments/abc.png', size: 10, isImage: true, thumb: null, source: 'chat-attachment' },
            { id: 'att-ws', name: 'spec.md', path: '/machine-a/ProjectX/docs/spec.md', size: 20, isImage: false, thumb: null, source: 'workspace-file', relativePath: 'docs/spec.md' }
          ]
        },
        {
          role: 'assistant',
          id: 'a1',
          turnId: 't1',
          agent: input.driver,
          actualModel: null,
          dispatchedBy: null,
          status: 'done',
          content: '![chart](assets/chart.png)',
          activity: [],
          thinking: null,
          usage: null,
          others: [],
          outputs: ['/machine-a/ProjectX/src/app.ts', '/machine-b/userData/attachments/priv.png'],
          outputFiles: [
            { path: '/machine-a/ProjectX/src/app.ts', name: 'app.ts', source: 'workspace-file', relativePath: 'src/app.ts' },
            { path: '/machine-a/ProjectX/assets/chart.png', name: 'chart.png', source: 'workspace-file', relativePath: 'assets/chart.png', fallbackPath: '/machine-b/userData/attachments/chart.png', inlineOnly: true },
            { path: '/machine-b/userData/attachments/priv.png', name: 'priv.png', source: 'chat-attachment' }
          ],
          error: null,
          notices: [],
          review: false,
          retry: 0,
          verdict: null,
          startedAt: 1,
          endedAt: 2
        }
      ]
    }
    await open(importedThread)

    expect(chat.rebindThreadProject('imported-1', '/machine-b/ProjectX')).toBe(true)
    const updated = chat.getThread('imported-1')!
    expect(updated.projectDir).toBe('/machine-b/ProjectX')
    expect(updated.workdir).toBe('/machine-b/ProjectX')
    expect(updated.sourceProjectDir).toBe('/machine-a/ProjectX')
    expect(updated.sessionScope).not.toBe('scope-a')

    const u = updated.messages[0]
    expect(u.role === 'user' ? u.attachments[0].path : null).toBe('/machine-b/userData/attachments/abc.png')
    expect(u.role === 'user' ? u.attachments[1].path : null).toBe('/machine-b/ProjectX/docs/spec.md')

    const a = updated.messages[1]
    expect(a.role === 'assistant' ? a.outputs : null).toEqual([
      '/machine-b/ProjectX/src/app.ts',
      '/machine-b/userData/attachments/priv.png'
    ])
    expect(a.role === 'assistant' ? a.outputFiles : null).toMatchObject([
      { path: '/machine-b/ProjectX/src/app.ts', sourcePath: '/machine-a/ProjectX/src/app.ts', relativePath: 'src/app.ts' },
      { path: '/machine-b/ProjectX/assets/chart.png', fallbackPath: '/machine-b/userData/attachments/chart.png', inlineOnly: true },
      { path: '/machine-b/userData/attachments/priv.png', source: 'chat-attachment' }
    ])

    // Refuses to rebind while a turn is active
    await send('busy turn', 'imported-1')
    expect(chat.rebindThreadProject('imported-1', '/machine-b/Other')).toBe(false)
    finish()
  })

  it('applies imported threads with source project metadata and supports replace vs duplicate modes', async () => {
    await open(fixture)
    const item = {
      thread: { ...fixture, title: 'From A', projectDir: '/machine-b/App', workdir: null, updatedAt: 99 },
      projectName: 'App',
      sourceProjectDir: '/machine-a/App',
      driverKind: 'claude' as const
    }
    const profiles = [{ id: 'test', kind: 'claude' as const, status: 'idle' }]
    const dup = chat.applyThreadImport([item], profiles, 'duplicate')
    expect(dup).toEqual({ added: 1, replaced: 0 })
    const copy = chat.useChat
    expect(copy).toBeTypeOf('function')
    const added = chat.getThread(fixture.id)
    expect(added?.title).toBe('Test')

    const rep = chat.applyThreadImport([item], profiles, 'replace')
    expect(rep).toEqual({ added: 0, replaced: 1 })
    const replaced = chat.getThread(fixture.id)!
    expect(replaced.title).toBe('From A')
    expect(replaced.projectDir).toBe('/machine-b/App')
    expect(replaced.sourceProjectDir).toBe('/machine-a/App')
    expect(replaced.sourceProjectName).toBe('App')
  })
})
