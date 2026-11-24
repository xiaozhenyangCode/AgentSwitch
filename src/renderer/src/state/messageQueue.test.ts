import { describe, expect, it } from 'vitest'
import type { MessageInput, Thread } from '@shared/chat'
import { dequeueMessage, enqueueMessage, shouldAutoSendQueued } from './messageQueue'

const input: MessageInput = {
  text: 'first', driver: { profileId: 'driver', name: 'Driver', kind: 'claude', model: 'model' },
  mentions: [{ profileId: 'helper', name: 'Helper', kind: 'codex', model: null }],
  participants: ['driver', 'helper'], projectDir: '/project',
  attachments: [{ id: 'file', name: 'notes.txt', path: '/notes.txt', size: 20, isImage: false, thumb: null }]
}

describe('message queue', () => {
  it('takes a snapshot of all send parameters and dequeues one entry at a time in order', () => {
    const first = enqueueMessage(undefined, '1', input)
    const second = enqueueMessage(first, '2', { ...input, text: 'second' })
    expect(first).toEqual([{ ...input, id: '1' }])
    expect(first?.[0].attachments[0]).not.toBe(input.attachments[0])
    expect(first?.[0].mentions[0]).not.toBe(input.mentions[0])
    expect(first?.[0].driver).not.toBe(input.driver)
    expect(first?.[0].participants).not.toBe(input.participants)

    const next = dequeueMessage(second)
    expect(next?.message).toEqual({ ...input, id: '1' })
    expect(dequeueMessage(next?.remaining)).toEqual({ message: { ...input, id: '2', text: 'second' }, remaining: [] })
    expect(dequeueMessage([])).toBeNull()
    expect(second).toHaveLength(2)
  })

  it('keeps handoff requests out of the queue', () => {
    const queue = enqueueMessage(undefined, '1', input)
    expect(enqueueMessage(queue, '2', { ...input, handoffTo: input.driver })).toBe(queue)
  })

  it('auto-sends only on successful completion of the current unpaused, unheld turn', () => {
    const chat: Thread = {
      id: 'chat', title: 'Chat', projectDir: null, workdir: null,
      participants: [], driver: { profileId: null, model: null }, messages: [], createdAt: 0, updatedAt: 0,
      activeTurn: 'turn', pause: null, queuedMessages: enqueueMessage(undefined, '1', input)
    }
    expect(shouldAutoSendQueued(chat, 'turn', 'done')).toBe(true)
    expect(shouldAutoSendQueued(chat, 'stale', 'done')).toBe(false)
    expect(shouldAutoSendQueued(chat, 'turn', 'error')).toBe(false)
    expect(shouldAutoSendQueued(chat, 'turn', 'stopped')).toBe(false)
    expect(shouldAutoSendQueued({ ...chat, pause: { turnId: 'turn', reason: 'review' } }, 'turn', 'done')).toBe(false)
    expect(shouldAutoSendQueued({ ...chat, queueHold: 'manual' }, 'turn', 'done')).toBe(false)
    expect(shouldAutoSendQueued({ ...chat, queueHold: 'external' }, 'turn', 'done')).toBe(false)
    expect(shouldAutoSendQueued({ ...chat, queuedMessages: [] }, 'turn', 'done')).toBe(false)
  })
})
