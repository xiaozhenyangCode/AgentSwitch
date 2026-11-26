import { afterEach, expect, it, vi } from 'vitest'

vi.mock('./i18n', () => ({ fmtAgo: vi.fn(), t: vi.fn() }))
vi.mock('./settings', () => ({}))

afterEach(() => vi.unstubAllGlobals())

it('includes cache writes in the message cache hit rate', async () => {
  vi.stubGlobal('window', {
    agentswitch: { usage: { get: async () => null, onChanged: vi.fn() } }
  })
  const { cacheHitPercentage } = await import('./usage')
  expect(cacheHitPercentage({ input: 10, cacheRead: 80, cacheWrite: 10 })).toBe(80)
  expect(cacheHitPercentage({ cacheWrite: 10 })).toBe(0)
  expect(cacheHitPercentage({ output: 10 })).toBeNull()
})
