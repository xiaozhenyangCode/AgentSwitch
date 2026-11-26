import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  Object.assign(globalThis, {
    document: { documentElement: { lang: '' } },
    window: {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      agentswitch: {
        i18n: { get: () => ({ locale: 'en', pref: 'en' }), onChanged: vi.fn(() => () => {}) },
        usage: {
          get: async () => null,
          onChanged: vi.fn(() => () => {}),
          requestLogs: vi.fn(),
          onRequestLogsChanged: vi.fn(() => () => {})
        },
        chat: {
          open: async () => ({ session: 1, revision: 0, threads: [], activeId: null }),
          onEvent: vi.fn(() => () => {}),
          active: async () => [],
          pendingPermissions: async () => []
        }
      }
    }
  })
})

import {
  COLUMN_PREFS_STORAGE_KEY,
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  PAGE_SIZE_STORAGE_KEY,
  REQUEST_LOG_COLUMNS,
  buildPageTokens,
  clampPage,
  createLatestRequestGuard,
  defaultColumnVisibility,
  fmtCompactTokens,
  fmtHitRate,
  fmtLatency,
  fmtRequestCost,
  fmtSpeed,
  getPageRange,
  getTotalPages,
  loadColumnVisibility,
  loadPageSize,
  saveColumnVisibility,
  savePageSize
} from './RequestLogView'

describe('RequestLogView column config & formatters', () => {
  it('defines all 13 optional columns with 9 default-visible and 4 default-hidden', () => {
    expect(REQUEST_LOG_COLUMNS).toHaveLength(13)
    const defaults = defaultColumnVisibility()
    const visible = REQUEST_LOG_COLUMNS.filter((c) => defaults[c.key]).map((c) => c.key)
    const hidden = REQUEST_LOG_COLUMNS.filter((c) => !defaults[c.key]).map((c) => c.key)
    expect(visible).toEqual(['engine', 'provider', 'model', 'cost', 'uncachedInput', 'output', 'cacheRead', 'speed', 'ttft'])
    expect(hidden).toEqual(['cacheWrite', 'hitRate', 'duration', 'statusCode'])
  })

  it('persists and restores column visibility via storage', () => {
    const map = new Map<string, string>()
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v)
      }
    }
    const next = { ...defaultColumnVisibility(), cacheWrite: true, statusCode: true, provider: false }
    saveColumnVisibility(next, storage)
    expect(map.has(COLUMN_PREFS_STORAGE_KEY)).toBe(true)
    expect(loadColumnVisibility(storage)).toEqual(next)
  })

  it('formats cost, tokens, latency, speed, and hit rate cleanly', () => {
    expect(fmtRequestCost(0.0578)).toBe('$0.0578')
    expect(fmtRequestCost(null)).toBe('—')
    expect(fmtCompactTokens(265_400)).toBe('265K')
    expect(fmtCompactTokens(1_250_000)).toBe('1.3M')
    expect(fmtLatency(1600, true)).toBe('≈1.6s')
    expect(fmtLatency(null, true)).toBe('—')
    expect(fmtSpeed(124.2)).toBe('≈124 tok/s')
    expect(fmtSpeed(null)).toBe('—')
    expect(fmtHitRate({ uncachedInputTokens: 20_000, cacheReadTokens: 80_000, cacheWriteTokens: 0 })).toBe('80.0%')
    expect(fmtHitRate({ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe('—')
  })
})

describe('RequestLogView pagination helpers & race guard', () => {
  it('persists page size preference (20 / 50 / 100) and falls back to 20 on invalid values', () => {
    expect(PAGE_SIZE_OPTIONS).toEqual([20, 50, 100])
    expect(DEFAULT_PAGE_SIZE).toBe(20)

    const map = new Map<string, string>()
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v)
      }
    }

    expect(loadPageSize(storage)).toBe(20)
    savePageSize(50, storage)
    expect(map.get(PAGE_SIZE_STORAGE_KEY)).toBe('50')
    expect(loadPageSize(storage)).toBe(50)

    savePageSize(100, storage)
    expect(loadPageSize(storage)).toBe(100)

    map.set(PAGE_SIZE_STORAGE_KEY, '999')
    expect(loadPageSize(storage)).toBe(20)
    map.set(PAGE_SIZE_STORAGE_KEY, 'not-a-number')
    expect(loadPageSize(storage)).toBe(20)
  })

  it('computes total pages, clamps out-of-range pages, and formats page ranges', () => {
    expect(getTotalPages(0, 20)).toBe(1)
    expect(getTotalPages(20, 20)).toBe(1)
    expect(getTotalPages(58, 20)).toBe(3)
    expect(getTotalPages(500, 20)).toBe(25)

    expect(clampPage(0, 25)).toBe(1)
    expect(clampPage(-5, 25)).toBe(1)
    expect(clampPage(30, 25)).toBe(25)
    expect(clampPage(12.9, 25)).toBe(12)
    expect(clampPage(Number.NaN, 25)).toBe(1)

    expect(getPageRange(1, 20, 0)).toEqual({ start: 0, end: 0 })
    expect(getPageRange(1, 20, 58)).toEqual({ start: 1, end: 20 })
    expect(getPageRange(2, 20, 58)).toEqual({ start: 21, end: 40 })
    expect(getPageRange(3, 20, 58)).toEqual({ start: 41, end: 58 })
    // Out-of-bounds page clamps to last page range
    expect(getPageRange(5, 20, 58)).toEqual({ start: 41, end: 58 })
  })

  it('renders full page lists for <= 7 pages and compact ellipsis tokens for large page counts (500 rows / 25 pages)', () => {
    expect(buildPageTokens(1, 1)).toEqual([1])
    expect(buildPageTokens(3, 5)).toEqual([1, 2, 3, 4, 5])
    expect(buildPageTokens(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7])

    // 12 pages
    expect(buildPageTokens(5, 12)).toEqual([1, 'ellipsis-left', 4, 5, 6, 'ellipsis-right', 12])

    // 500 entries / 20 per page = 25 pages
    expect(buildPageTokens(1, 25)).toEqual([1, 2, 3, 4, 5, 'ellipsis-right', 25])
    expect(buildPageTokens(4, 25)).toEqual([1, 2, 3, 4, 5, 'ellipsis-right', 25])
    expect(buildPageTokens(5, 25)).toEqual([1, 'ellipsis-left', 4, 5, 6, 'ellipsis-right', 25])
    expect(buildPageTokens(13, 25)).toEqual([1, 'ellipsis-left', 12, 13, 14, 'ellipsis-right', 25])
    expect(buildPageTokens(22, 25)).toEqual([1, 'ellipsis-left', 21, 22, 23, 24, 25])
    expect(buildPageTokens(25, 25)).toEqual([1, 'ellipsis-left', 21, 22, 23, 24, 25])
  })

  it('ignores stale responses when rapid page clicks resolve out of order', async () => {
    const guard = createLatestRequestGuard()
    const applied: number[] = []

    const fetchPage = (pageNum: number, delayMs: number) =>
      new Promise<void>((resolve) => {
        const token = guard.next()
        setTimeout(() => {
          if (guard.isLatest(token)) {
            applied.push(pageNum)
          }
          resolve()
        }, delayMs)
      })

    // User clicks page 2 (slow) then immediately clicks page 3 (fast) then page 4 (medium)
    const p2 = fetchPage(2, 40)
    const p3 = fetchPage(3, 5)
    const p4 = fetchPage(4, 15)
    await Promise.all([p2, p3, p4])

    expect(applied).toEqual([4])
  })
})
