import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountUsage, ProfileState, UsageSnapshot } from '@shared/types'

vi.mock('./i18n', () => ({ fmtAgo: vi.fn(), t: (k: string) => k }))
vi.mock('./settings', () => ({ getSettings: () => ({ quotaWarn: 80 }) }))

afterEach(() => vi.unstubAllGlobals())

function stubUsageBridge() {
  vi.stubGlobal('window', {
    agentswitch: { usage: { get: async () => null, onChanged: vi.fn() } }
  })
}

function makeProfile(id: string, status: ProfileState['status'], kind: ProfileState['kind'] = 'claude'): ProfileState {
  return {
    id,
    name: id,
    kind,
    configDir: `/tmp/${id}`,
    imported: false,
    loginCommand: '',
    runCommand: '',
    extraEnv: {},
    defaultModel: '',
    autoApprove: 'edits',
    createdAt: 0,
    status,
    binaryPath: '/usr/local/bin/cli',
    loggedIn: status !== 'not_logged_in' && status !== 'uninstalled',
    resolvedConfigDir: `/tmp/${id}`,
    sessionStoreKey: `${kind}:/tmp/${id}`,
    sessionMode: null,
    installing: false
  }
}

const emptyTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0, runs: 0 }

function makeAccountUsage(overrides: Partial<AccountUsage> = {}): AccountUsage {
  return {
    today: { ...emptyTotals },
    week: { ...emptyTotals },
    total: { ...emptyTotals },
    quota: null,
    quotaError: null,
    quotaErrorKind: null,
    quotaErrorResetAt: null,
    limitedAt: null,
    ...overrides
  }
}

it('includes cache writes in the message cache hit rate', async () => {
  stubUsageBridge()
  const { cacheHitPercentage } = await import('./usage')
  expect(cacheHitPercentage({ input: 10, cacheRead: 80, cacheWrite: 10 })).toBe(80)
  expect(cacheHitPercentage({ cacheWrite: 10 })).toBe(0)
  expect(cacheHitPercentage({ output: 10 })).toBeNull()
})

describe('account quota card list and rate-limit state', () => {
  it('never drops rate_limited, uncached, or not_logged_in accounts from the top quota cards', async () => {
    stubUsageBridge()
    const { quotaCardProfiles } = await import('./usage')
    const profiles = [
      makeProfile('claude-ok', 'idle', 'claude'),
      makeProfile('claude-limited', 'rate_limited', 'claude'),
      makeProfile('codex-cold', 'rate_limited', 'codex'),
      makeProfile('gemini-apikey', 'idle', 'gemini'),
      makeProfile('claude-unlogged', 'not_logged_in', 'claude')
    ]
    const cards = quotaCardProfiles(profiles)
    expect(cards.map((p) => p.id)).toEqual([
      'claude-ok',
      'claude-limited',
      'codex-cold',
      'gemini-apikey',
      'claude-unlogged'
    ])
  })

  it('marks quotaErrorKind=rate_limited as danger and excludes it from idlestAccounts', async () => {
    stubUsageBridge()
    const { quotaLevel, idlestAccounts } = await import('./usage')
    const p1 = makeProfile('claude-1', 'idle', 'claude')
    const p2 = makeProfile('claude-2', 'idle', 'claude')
    const p3 = makeProfile('claude-3', 'idle', 'claude')
    const now = Date.now()
    const snap: UsageSnapshot = {
      accounts: {
        'claude-1': makeAccountUsage({
          quota: {
            fiveHour: { percent: 10, resetsAt: now + 3600_000, minutes: 300 },
            sevenDay: { percent: 10, resetsAt: now + 86400_000, minutes: 10080 },
            limited: false,
            plan: null,
            fetchedAt: now - 60_000,
            source: 'claude-oauth'
          },
          quotaError: 'HTTP 429: Rate limited',
          quotaErrorKind: 'rate_limited',
          quotaErrorResetAt: now + 300_000
        }),
        'claude-2': makeAccountUsage({
          quota: {
            fiveHour: { percent: 45, resetsAt: now + 3600_000, minutes: 300 },
            sevenDay: { percent: 30, resetsAt: now + 86400_000, minutes: 10080 },
            limited: false,
            plan: null,
            fetchedAt: now,
            source: 'claude-oauth'
          }
        }),
        'claude-3': makeAccountUsage({
          quota: {
            fiveHour: { percent: 60, resetsAt: now + 3600_000, minutes: 300 },
            sevenDay: { percent: 40, resetsAt: now + 86400_000, minutes: 10080 },
            limited: false,
            plan: null,
            fetchedAt: now,
            source: 'claude-oauth'
          }
        })
      },
      backfill: 'done',
      claudeDays: 30,
      daily: [],
      models: {},
      customPrices: {},
      pricesAt: '2026-11-25',
      pricesLive: false,
      updatedAt: now
    }

    expect(quotaLevel(p1, snap.accounts['claude-1']).level).toBe('danger')
    const idlest = idlestAccounts([p1, p2, p3], snap)
    expect(idlest.has('claude-1')).toBe(false)
    expect(idlest.has('claude-2')).toBe(true)
  })
})
