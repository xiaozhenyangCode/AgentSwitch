import { translate, type Locale } from '@shared/i18n'
import { SEVEN_DAY_QUOTA_WINDOW_MS, type AccountWindowLogSummary } from '@shared/types'

const HOUR_MS = 3_600_000
const HOURS_PER_WINDOW = SEVEN_DAY_QUOTA_WINDOW_MS / HOUR_MS

export interface SevenDayEstimateInput extends Omit<AccountWindowLogSummary, 'accountId' | 'resetAt' | 'windowTokens' | 'last24hTokens'> {
  usedPct: number
  resetAt: number | null
  now: number
  windowTokens?: number
  last24hTokens?: number
}

type EstimateStatus = 'unavailable' | 'depleted' | 'no_local_logs' | 'insufficient_sample'
type Forecast = { basis: 'cost' | 'tokens'; ratePctPerHour: number }
export type SevenDayEstimate = { timeProgressPct: number } & (
  | { status: EstimateStatus }
  | ({ status: 'will_deplete'; depleteAt: number; hoursBeforeReset: number } & Forecast)
  | ({ status: 'within_limit'; projectedPct: number } & Forecast)
)

export function estimateSevenDayUsage({
  usedPct, resetAt, now, windowCost, last24hCost, windowTokens = 0, last24hTokens = 0, windowRequestCount, last24hRequestCount
}: SevenDayEstimateInput): SevenDayEstimate {
  if (resetAt === null || resetAt <= now || !Number.isFinite(new Date(resetAt).getTime()) ||
      !Number.isFinite(new Date(now).getTime()) ||
      ![usedPct, windowCost, last24hCost, windowTokens, last24hTokens, windowRequestCount, last24hRequestCount].every(Number.isFinite)) {
    return { status: 'unavailable', timeProgressPct: 0 }
  }
  const remainingHours = (resetAt - now) / HOUR_MS
  const elapsedHours = (now - (resetAt - SEVEN_DAY_QUOTA_WINDOW_MS)) / HOUR_MS
  const timeProgressPct = Math.min(100, Math.max(0, elapsedHours / HOURS_PER_WINDOW * 100))

  if (usedPct >= 100) return { status: 'depleted', timeProgressPct }
  if (windowRequestCount <= 0 || (windowCost <= 0 && windowTokens <= 0)) {
    return { status: 'no_local_logs', timeProgressPct }
  }
  if (elapsedHours < 6 || usedPct < 3) return { status: 'insufficient_sample', timeProgressPct }

  const basis = windowCost > 0 ? 'cost' : 'tokens'
  const windowWeight = basis === 'cost' ? windowCost : windowTokens
  const last24hWeight = Math.min(windowWeight, Math.max(0, basis === 'cost' ? last24hCost : last24hTokens))
  // Divide the weights before applying the official percentage to keep the units consistent.
  const ratePctPerHour = usedPct * (elapsedHours < 24
    ? 1 / elapsedHours
    : 0.6 * (last24hWeight / windowWeight) / 24 + 0.4 / elapsedHours)
  if (ratePctPerHour <= 0 || !Number.isFinite(ratePctPerHour)) return { status: 'insufficient_sample', timeProgressPct }

  const hoursToDeplete = (100 - usedPct) / ratePctPerHour
  const depleteAt = now + hoursToDeplete * HOUR_MS
  const forecast = { basis, ratePctPerHour, timeProgressPct } as const
  if (depleteAt < resetAt) {
    return { ...forecast, status: 'will_deplete', depleteAt, hoursBeforeReset: (resetAt - depleteAt) / HOUR_MS }
  }
  return {
    ...forecast,
    status: 'within_limit',
    projectedPct: Math.min(100, Math.max(Math.round(usedPct), Math.round(usedPct + ratePctPerHour * remainingHours)))
  }
}

const pad = (value: number) => String(value).padStart(2, '0')

export function formatSevenDayEstimateTime(timestamp: number, now: number, locale: Locale, detail = false): string {
  const date = new Date(timestamp)
  const today = new Date(now)
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(today.getTime())) return ''
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (timestamp - now < 24 * HOUR_MS) {
    const tomorrow = new Date(today)
    tomorrow.setHours(0, 0, 0, 0)
    tomorrow.setDate(tomorrow.getDate() + 1)
    return date >= tomorrow ? translate(locale, detail ? 'time.tomorrow' : 'usage.estimateTomorrowShort', { time }) : time
  }
  const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return detail ? `${day} ${time}` : day
}
