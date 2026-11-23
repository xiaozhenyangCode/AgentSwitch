import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PermissionEvent } from '@shared/types'
import { PermissionRegistry } from './permissions'

function request(registry: PermissionRegistry, id: string, kind: PermissionEvent['kind'] = 'approval', withOptions = true) {
  const event: PermissionEvent = {
    t: 'permission', requestId: id, kind, title: 'Test', expiresAt: Date.now() + 100,
    options: withOptions ? [{ id: 'yes', label: 'Yes', role: 'allow_once' }, { id: 'no', label: 'No', role: 'reject_once' }] : []
  }
  const ref = { threadId: 'thread', turnId: 'turn', stepId: id }
  const resolve = vi.fn()
  const emit = vi.fn()
  registry.register({ ref, event, resolve, emit, turn: Symbol(id), connection: {} })
  return { ref, event, resolve, emit }
}

describe('ACP permission registry', () => {
  afterEach(() => vi.useRealTimers())

  it('validates option IDs, settles once and removes the request from the pending snapshot', () => {
    const registry = new PermissionRegistry()
    const { ref, event, resolve, emit } = request(registry, 'abc')
    expect(registry.pending()).toEqual([{ ...ref, event }])
    expect(registry.reply('other', 'yes', 'user')).toBe(false)
    expect(registry.reply('abc', 'bogus', 'user')).toBe(false)
    expect(resolve).not.toHaveBeenCalled()
    expect(registry.reply('abc', 'yes', 'user')).toBe(true)
    expect(registry.reply('abc', null, 'user')).toBe(false)
    expect(registry.pending()).toEqual([])
    expect(resolve).toHaveBeenCalledExactlyOnceWith({ outcome: { outcome: 'selected', optionId: 'yes' } })
    expect(emit).toHaveBeenCalledExactlyOnceWith({ t: 'permission_resolved', requestId: 'abc', outcome: 'selected', optionId: 'yes', label: 'Yes', by: 'user' })
  })

  it('cancels only the scoped requests and supports explicit user cancellation', () => {
    const registry = new PermissionRegistry()
    const first = request(registry, 'first')
    const second = request(registry, 'second')
    registry.cancelAll((entry) => entry.ref?.stepId === 'first', 'cancelled')
    expect(first.resolve).toHaveBeenCalledExactlyOnceWith({ outcome: { outcome: 'cancelled' } })
    expect(first.emit).toHaveBeenCalledExactlyOnceWith({ t: 'permission_resolved', requestId: 'first', outcome: 'cancelled', by: 'auto' })
    expect(second.resolve).not.toHaveBeenCalled()
    expect(registry.reply('second', null, 'user')).toBe(true)
    expect(second.emit).toHaveBeenCalledExactlyOnceWith({ t: 'permission_resolved', requestId: 'second', outcome: 'cancelled', by: 'user' })
  })

  it('rejects expired approvals, cancels questions and falls back to cancellation without reject_once', () => {
    vi.useFakeTimers()
    const registry = new PermissionRegistry()
    const a = request(registry, 'approval')
    const q = request(registry, 'question', 'question')
    const noChoice = request(registry, 'approval-without-reject', 'approval', false)
    vi.advanceTimersByTime(99)
    expect(registry.pending()).toHaveLength(3)
    vi.advanceTimersByTime(1)
    expect(registry.pending()).toHaveLength(0)
    expect(a.resolve).toHaveBeenCalledExactlyOnceWith({ outcome: { outcome: 'selected', optionId: 'no' } })
    expect(a.emit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: 'timeout', by: 'auto', optionId: 'no' }))
    for (const item of [q, noChoice]) {
      expect(item.resolve).toHaveBeenCalledExactlyOnceWith({ outcome: { outcome: 'cancelled' } })
      expect(item.emit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: 'timeout', by: 'auto' }))
    }
  })

  it('refuses a reply after the deadline even if the timer has not fired', () => {
    vi.useFakeTimers()
    const registry = new PermissionRegistry()
    const { event, resolve } = request(registry, 'late')
    vi.setSystemTime(event.expiresAt + 1)
    expect(registry.reply('late', 'yes', 'user')).toBe(false)
    expect(resolve).toHaveBeenCalledExactlyOnceWith({ outcome: { outcome: 'selected', optionId: 'no' } })
  })
})
