import { describe, expect, it } from 'vitest'
import { formatFullLocalTime, formatListTime } from './listTime'

const yesterday = (hm: string) => `昨天 ${hm}`
const now = new Date(2026, 10, 25, 14, 32)

describe('formatListTime', () => {
  it('shows only the time for the current local day', () => {
    expect(formatListTime(new Date(2026, 10, 25, 9, 5).getTime(), now, yesterday)).toBe('09:05')
    expect(formatListTime(new Date(2026, 10, 25, 21, 5).getTime(), now, yesterday)).toBe('21:05')
  })

  it('shows yesterday for a timestamp ten minutes before now across midnight', () => {
    const now = new Date(2026, 10, 25, 0, 5)
    expect(formatListTime(new Date(2026, 10, 24, 23, 55).getTime(), now, yesterday)).toBe('昨天 23:55')
  })

  it('only labels the previous calendar day as yesterday near the end of the day', () => {
    const now = new Date(2026, 10, 25, 23, 55)
    expect(formatListTime(new Date(2026, 10, 24, 0, 5).getTime(), now, yesterday)).toBe('昨天 00:05')
    expect(formatListTime(new Date(2026, 10, 23, 23, 59).getTime(), now, yesterday)).toBe('11-23 23:59')
  })

  it('shows yesterday across a month boundary', () => {
    const now = new Date(2026, 2, 1, 8, 0)
    expect(formatListTime(new Date(2026, 1, 28, 21, 0).getTime(), now, yesterday)).toBe('昨天 21:00')
  })

  it('shows yesterday across a year boundary', () => {
    const now = new Date(2026, 0, 1, 0, 10)
    expect(formatListTime(new Date(2025, 11, 31, 23, 50).getTime(), now, yesterday)).toBe('昨天 23:50')
  })

  it('uses calendar boundaries on dates with daylight saving transitions in New York', () => {
    const afterSpringForward = new Date(2026, 2, 9, 8, 0)
    const afterFallBack = new Date(2026, 10, 2, 8, 0)
    expect(formatListTime(new Date(2026, 2, 7, 23, 30).getTime(), afterSpringForward, yesterday)).toBe('03-07 23:30')
    expect(formatListTime(new Date(2026, 10, 1, 0, 30).getTime(), afterFallBack, yesterday)).toBe('昨天 00:30')
  })

  it('includes the month, day, and time for earlier dates this year', () => {
    expect(formatListTime(new Date(2026, 10, 22, 9, 15).getTime(), now, yesterday)).toBe('11-22 09:15')
  })

  it('includes the year for dates in previous years', () => {
    expect(formatListTime(new Date(2025, 11, 30, 21, 40).getTime(), now, yesterday)).toBe('2025-12-30 21:40')
  })

  it('includes the year for future calendar days', () => {
    expect(formatListTime(new Date(2026, 10, 27, 10, 0).getTime(), now, yesterday)).toBe('2026-11-27 10:00')
  })
})

describe('formatFullLocalTime', () => {
  it('shows the full local date and time with leading zeros', () => {
    expect(formatFullLocalTime(new Date(2026, 0, 2, 3, 4, 5).getTime())).toBe('2026-01-02 03:04:05')
  })
})

it.each([NaN, Infinity, -Infinity, Number.MAX_VALUE])('returns empty strings for invalid timestamps (%s)', (ts) => {
  expect(formatListTime(ts, now, yesterday)).toBe('')
  expect(formatFullLocalTime(ts)).toBe('')
})
