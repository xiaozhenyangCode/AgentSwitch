export const TASK_SUMMARY_IDLE_MS = 5 * 60_000

export interface TaskSummaryNoticeParams {
  threadId: string
  summary: string | null | undefined
  busy: boolean
  paused: boolean
  idleSince: number
  now: number
  refocused?: boolean
  switchedThread?: boolean
  dismissedThreadId?: string | null
}

export function shouldShowTaskSummaryBar(params: TaskSummaryNoticeParams): boolean {
  if (!params.summary?.trim() || params.busy || params.paused || params.dismissedThreadId === params.threadId) return false
  return !!params.refocused || !!params.switchedThread || params.now - params.idleSince >= TASK_SUMMARY_IDLE_MS
}
