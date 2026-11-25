import { describe, expect, it } from 'vitest'
import { shouldShowTaskSummaryBar, TASK_SUMMARY_IDLE_MS, type TaskSummaryNoticeParams } from './taskSummaryNotice'

const idle: TaskSummaryNoticeParams = {
  threadId: 'thread', summary: '已实现，待验证', busy: false, paused: false, idleSince: 1000, now: 1000
}

describe('task summary notice', () => {
  it('appears when the current thread has been idle for five minutes', () => {
    expect(shouldShowTaskSummaryBar({ ...idle, now: idle.idleSince + TASK_SUMMARY_IDLE_MS - 1 })).toBe(false)
    expect(shouldShowTaskSummaryBar({ ...idle, now: idle.idleSince + TASK_SUMMARY_IDLE_MS })).toBe(true)
  })

  it('appears early when the user refocuses the window or switches to a historical thread', () => {
    expect(shouldShowTaskSummaryBar({ ...idle, refocused: true })).toBe(true)
    expect(shouldShowTaskSummaryBar({ ...idle, switchedThread: true })).toBe(true)
  })

  it('stays out of the way while a new message runs or a review is paused and requires a summary', () => {
    expect(shouldShowTaskSummaryBar({ ...idle, refocused: true, busy: true })).toBe(false)
    expect(shouldShowTaskSummaryBar({ ...idle, switchedThread: true, paused: true })).toBe(false)
    expect(shouldShowTaskSummaryBar({ ...idle, summary: ' ', refocused: true })).toBe(false)
  })

  it('respects manual dismissal for the matching thread', () => {
    expect(shouldShowTaskSummaryBar({ ...idle, refocused: true, dismissedThreadId: idle.threadId })).toBe(false)
    expect(shouldShowTaskSummaryBar({ ...idle, switchedThread: true, dismissedThreadId: 'another-thread' })).toBe(true)
  })
})
