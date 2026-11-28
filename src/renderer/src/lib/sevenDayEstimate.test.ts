import { describe, expect, it } from 'vitest'
import { estimateSevenDayUsage, formatSevenDayEstimateTime, type SevenDayEstimateInput } from './sevenDayEstimate'

const hour = 3_600_000
const start = Date.UTC(2026, 10, 24)
const resetAt = start + 168 * hour
const sample = (elapsed: number, patch: Partial<SevenDayEstimateInput> = {}): SevenDayEstimateInput => ({
  usedPct: 40, resetAt, now: start + elapsed * hour,
  windowCost: 100, last24hCost: 50, windowRequestCount: 20, last24hRequestCount: 8,
  ...patch
})

describe('estimateSevenDayUsage', () => {
  it.each([
    { resetAt: null }, { resetAt: NaN }, { resetAt: Infinity }, { resetAt: Number.MAX_VALUE },
    { resetAt: start + 12 * hour }, { resetAt: start }, { now: NaN }, { usedPct: NaN },
    { windowCost: Infinity }, { last24hCost: NaN }, { windowTokens: Infinity }, { last24hTokens: NaN },
    { windowRequestCount: Infinity }, { last24hRequestCount: NaN }
  ])('rejects invalid or expired data %o', (patch) => {
    expect(estimateSevenDayUsage(sample(12, patch))).toEqual({ status: 'unavailable', timeProgressPct: 0 })
  })

  it.each([100, 110])('returns depleted at %s percent before considering logs', (usedPct) => {
    expect(estimateSevenDayUsage(sample(12, { usedPct, windowCost: 0, windowRequestCount: 0 }))).toMatchObject({ status: 'depleted' })
  })

  it.each([
    { windowRequestCount: 0 }, { windowCost: 0 }, { windowCost: -1, windowTokens: 0 }
  ])('reports unusable local logs %o', (patch) => {
    expect(estimateSevenDayUsage(sample(12, patch))).toMatchObject({ status: 'no_local_logs' })
  })

  it('keeps elapsed progress bounded and handles both cold-start gates', () => {
    expect(estimateSevenDayUsage(sample(-1))).toEqual({ status: 'insufficient_sample', timeProgressPct: 0 })
    expect(estimateSevenDayUsage(sample(5.99))).toMatchObject({ status: 'insufficient_sample' })
    expect(estimateSevenDayUsage(sample(6, { usedPct: 2.99 }))).toMatchObject({ status: 'insufficient_sample' })
    expect(estimateSevenDayUsage(sample(6, { usedPct: 3 }))).toMatchObject({ status: 'within_limit', projectedPct: 84 })
  })

  it('uses full-window average before the first 24 hours', () => {
    const result = estimateSevenDayUsage(sample(12))
    expect(result).toMatchObject({ status: 'will_deplete', basis: 'cost', depleteAt: start + 30 * hour, hoursBeforeReset: 138 })
    expect(result.timeProgressPct).toBeCloseTo(12 / 168 * 100)
  })

  it('switches to 60/40 weighting at exactly 24 hours', () => {
    const result = estimateSevenDayUsage(sample(24))
    expect(result).toMatchObject({ status: 'will_deplete', basis: 'cost' })
    if ('ratePctPerHour' in result) expect(result.ratePctPerHour).toBeCloseTo(40 * (0.6 * 50 / 24 + 0.4 * 100 / 24) / 100)
  })

  it('handles quiet recent periods and clamps anomalous recent weights', () => {
    const quiet = estimateSevenDayUsage(sample(84, { last24hCost: 0, last24hRequestCount: 0 }))
    expect(quiet).toMatchObject({ status: 'within_limit', projectedPct: 56 })
    expect(estimateSevenDayUsage(sample(84, { last24hCost: -1 }))).toEqual(quiet)
    expect(estimateSevenDayUsage(sample(84, { last24hCost: 1000 }))).toEqual(estimateSevenDayUsage(sample(84, { last24hCost: 100 })))
  })

  it('falls back to tokens without mixing units and prioritizes positive cost', () => {
    const data = { windowTokens: 10_000, last24hTokens: 5_000 }
    const result = estimateSevenDayUsage(sample(48, { windowCost: 0, last24hCost: 0, ...data }))
    expect(result).toEqual({ ...estimateSevenDayUsage(sample(48)), basis: 'tokens' })
    expect(estimateSevenDayUsage(sample(48, data))).toMatchObject({ basis: 'cost' })
  })

  it('treats depletion exactly at reset as within the limit', () => {
    expect(estimateSevenDayUsage(sample(12, { usedPct: 100 / 14 }))).toMatchObject({ status: 'within_limit', projectedPct: 100 })
  })

  it('keeps arithmetic finite with tiny or huge weight totals', () => {
    for (const cost of [Number.MIN_VALUE, Number.MAX_VALUE]) {
      const result = estimateSevenDayUsage(sample(84, { windowCost: cost, last24hCost: cost }))
      expect(result.status).toBe('will_deplete')
      expect(Object.values(result).filter((value) => typeof value === 'number').every(Number.isFinite)).toBe(true)
    }
  })
})

describe('formatSevenDayEstimateTime', () => {
  it('shows a localized same-day time, tomorrow, and compact or detailed dates', () => {
    const now = new Date(2026, 10, 29, 12).getTime()
    expect(formatSevenDayEstimateTime(new Date(2026, 10, 29, 18, 30).getTime(), now, 'zh-CN')).toBe('18:30')
    expect(formatSevenDayEstimateTime(new Date(2026, 10, 30, 9).getTime(), now, 'zh-CN')).toBe('明天 09:00')
    expect(formatSevenDayEstimateTime(new Date(2026, 10, 30, 9).getTime(), now, 'en')).toBe('Tmrw 09:00')
    expect(formatSevenDayEstimateTime(new Date(2026, 10, 30, 9).getTime(), now, 'en', true)).toBe('Tomorrow 09:00')
    const later = new Date(2026, 11, 1, 9).getTime()
    expect(formatSevenDayEstimateTime(later, now, 'zh-CN')).toBe('12-01')
    expect(formatSevenDayEstimateTime(later, now, 'zh-CN', true)).toBe('12-01 09:00')
    expect(formatSevenDayEstimateTime(NaN, now, 'en')).toBe('')
  })
})
