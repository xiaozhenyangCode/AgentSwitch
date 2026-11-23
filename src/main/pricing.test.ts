import { describe, expect, it } from 'vitest'
import builtin from './prices.builtin.json'
import { candidates, cleanRate, costOf, findRate, isLong, type PriceTable } from './pricing'

const table = builtin.models as PriceTable

describe('model names', () => {
  it('normalizes the names CLIs report', () => {
    expect(candidates('claude-opus-5-5[1m]')[0]).toBe('claude-opus-5-5')
    expect(candidates('anthropic/Claude-Sonnet-5-5')[0]).toBe('claude-sonnet-5-5')
    expect(candidates('models/gemini-3.8-flash')[0]).toBe('gemini-3.8-flash')
    expect(candidates('claude-opus-4-6@20251101')[0]).toBe('claude-opus-4-6')
    expect(candidates('claude-haiku-4-5-20251001')).toContain('claude-haiku-4-5')
  })
  it('never falls back to a bare family', () => {
    expect(candidates('claude-unknown-9')).not.toContain('claude')
    expect(candidates('gemini-3-ultra-x')).not.toContain('gemini-3')
  })
})

describe('price lookup', () => {
  it('finds built-in prices, stripping variants', () => {
    expect(findRate('claude-opus-5-5[1m]', table, {})).toMatchObject({ key: 'claude-opus-5-5', source: 'builtin', rate: { input: 4, output: 20 } })
    expect(findRate('gpt-6.2-sol', table, {})?.rate.input).toBe(2)
    expect(findRate('no-such-model', table, {})).toBeNull()
    expect(findRate('<synthetic>', table, {})?.rate).toEqual({ input: 0, output: 0 })
  })
  it('lets overrides win, also for unknown models', () => {
    const o = { 'claude-opus-5-5': { input: 1, output: 2 }, 'my-model': { input: 3, output: 4 } }
    expect(findRate('claude-opus-5-5', table, o)).toMatchObject({ source: 'custom', rate: { input: 1 } })
    expect(findRate('my-model-20260101', table, o)).toMatchObject({ key: 'my-model', source: 'custom' })
  })
})

describe('cost', () => {
  const opus = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 }
  it('bills every bucket at its rate', () => {
    // 1M each: 4 + 20 + 0.2 + (0.5M x 5 + 0.5M x 8)
    expect(costOf({ input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6, cacheWrite1h: 5e5 }, opus)).toBeCloseTo(4 + 20 + 0.2 + 2.5 + 4, 9)
  })
  it('falls back to input for missing cache rates', () => {
    expect(costOf({ input: 0, output: 0, cacheRead: 1e6, cacheWrite: 1e6 }, { input: 2, output: 8 })).toBeCloseTo(4, 9)
    expect(costOf({ input: 0, output: 0, cacheRead: 0, cacheWrite: 1e6, cacheWrite1h: 1e6 }, { input: 2, output: 8, cacheWrite: 2.5 })).toBeCloseTo(4, 9)
  })
  it('uses the long-context tier past its threshold', () => {
    const r = { input: 2, output: 10, cacheRead: 0.1, long: { threshold: 272000, input: 4, output: 15, cacheRead: 0.2 } }
    expect(isLong(r, 300000)).toBe(true)
    expect(isLong(r, 272000)).toBe(false)
    expect(costOf({ input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 0 }, r, true)).toBeCloseTo(4 + 15 + 0.2, 9)
  })
  it('accepts only sane user rates', () => {
    expect(cleanRate({ input: 1, output: 2, cacheRead: -1, cacheWrite: 'x' })).toEqual({ input: 1, output: 2 })
    expect(cleanRate({ input: NaN, output: 2 })).toBeNull()
  })
})
