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
  REQUEST_LOG_COLUMNS,
  defaultColumnVisibility,
  fmtCompactTokens,
  fmtHitRate,
  fmtLatency,
  fmtRequestCost,
  fmtSpeed,
  loadColumnVisibility,
  saveColumnVisibility
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
