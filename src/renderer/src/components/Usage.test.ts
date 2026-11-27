import { describe, expect, it, vi } from 'vitest'
import type { QuotaGroup } from '@shared/types'

vi.hoisted(() => {
  Object.assign(globalThis, {
    localStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() },
    document: { documentElement: { lang: '' } },
    window: {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      agentswitch: {
        i18n: { get: () => ({ locale: 'en', pref: 'en' }), onChanged: vi.fn(() => () => {}) },
        settings: {
          get: async () => ({ quotaWarn: 80, probeClaude: false }),
          onChanged: vi.fn(() => () => {})
        },
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
  formatQuotaGroupLabel,
  formatQuotaGroupTooltip,
  quotaGroupAlertLevel,
  resolveActiveQuotaGroup
} from './Usage'

function makeGroup(overrides: Partial<QuotaGroup> & { key: string; name: string }): QuotaGroup {
  return {
    models: [],
    fiveHour: null,
    sevenDay: null,
    ...overrides
  }
}

describe('formatQuotaGroupLabel', () => {
  it('maps Gemini and Claude/GPT pool names to compact macOS segment labels', () => {
    expect(formatQuotaGroupLabel({ key: 'gemini', name: 'Gemini Models' })).toBe('Gemini')
    expect(formatQuotaGroupLabel({ key: 'custom', name: 'Gemini models' })).toBe('Gemini')
    expect(formatQuotaGroupLabel({ key: '3p', name: 'Claude and GPT models' })).toBe('Claude & GPT')
    expect(formatQuotaGroupLabel({ key: 'other', name: 'Claude and GPT Models' })).toBe('Claude & GPT')
    expect(formatQuotaGroupLabel({ key: 'other', name: 'Claude & GPT' })).toBe('Claude & GPT')
  })

  it('compacts unknown group names and truncates overly long labels cleanly', () => {
    expect(formatQuotaGroupLabel({ key: 'gemini-argon', name: 'Gemini Argon Models' })).toBe('Gemini Argon')
    expect(formatQuotaGroupLabel({ key: 'alpha', name: 'Alpha and Beta models' })).toBe('Alpha & Beta')
    const longLabel = formatQuotaGroupLabel({ key: 'long', name: 'Enterprise Super Ultra Long Pool Models' })
    expect(longLabel.endsWith('…')).toBe(true)
    expect(longLabel.length).toBeLessThanOrEqual(16)
  })

  it('falls back to key when name is blank', () => {
    expect(formatQuotaGroupLabel({ key: 'custom-pool', name: '   ' })).toBe('custom-pool')
  })
})

describe('quotaGroupAlertLevel', () => {
  const future = Date.now() + 3600_000
  const past = Date.now() - 3600_000

  it('returns null when usage is below warning threshold', () => {
    const g = makeGroup({
      key: '3p',
      name: 'Claude and GPT models',
      fiveHour: { percent: 45, resetsAt: future, minutes: 300 },
      sevenDay: { percent: 79.9, resetsAt: future, minutes: 10080 }
    })
    expect(quotaGroupAlertLevel(g)).toBeNull()
  })

  it('returns warn (orange) when max(5h, 7d) >= 80% and < 100%', () => {
    const g5h = makeGroup({
      key: '3p',
      name: 'Claude and GPT models',
      fiveHour: { percent: 80, resetsAt: future, minutes: 300 },
      sevenDay: { percent: 20, resetsAt: future, minutes: 10080 }
    })
    const g7d = makeGroup({
      key: '3p',
      name: 'Claude and GPT models',
      fiveHour: { percent: 15, resetsAt: future, minutes: 300 },
      sevenDay: { percent: 92, resetsAt: future, minutes: 10080 }
    })
    expect(quotaGroupAlertLevel(g5h)).toBe('warn')
    expect(quotaGroupAlertLevel(g7d)).toBe('warn')
  })

  it('returns danger (red) when rate-limited or max(5h, 7d) >= 100%', () => {
    const exhausted = makeGroup({
      key: '3p',
      name: 'Claude and GPT models',
      fiveHour: { percent: 100, resetsAt: future, minutes: 300 },
      sevenDay: { percent: 50, resetsAt: future, minutes: 10080 }
    })
    const limited = makeGroup({
      key: 'gemini',
      name: 'Gemini Models',
      fiveHour: { percent: 10, resetsAt: future, minutes: 300 }
    })
    expect(quotaGroupAlertLevel(exhausted)).toBe('danger')
    expect(quotaGroupAlertLevel(limited, { limited: true })).toBe('danger')
  })

  it('ignores expired quota windows whose reset time is in the past', () => {
    const expired = makeGroup({
      key: '3p',
      name: 'Claude and GPT models',
      fiveHour: { percent: 100, resetsAt: past, minutes: 300 },
      sevenDay: { percent: 90, resetsAt: past, minutes: 10080 }
    })
    expect(quotaGroupAlertLevel(expired)).toBeNull()
  })
})

describe('resolveActiveQuotaGroup', () => {
  const gemini = makeGroup({ key: 'gemini', name: 'Gemini Models' })
  const thirdParty = makeGroup({ key: '3p', name: 'Claude and GPT models' })

  it('returns null when groups are empty or undefined', () => {
    expect(resolveActiveQuotaGroup(undefined, null, null)).toBeNull()
    expect(resolveActiveQuotaGroup([], 'gemini', null)).toBeNull()
  })

  it('uses selectedKey when present and valid, otherwise falls back to defaultGroup or first group', () => {
    expect(resolveActiveQuotaGroup([gemini, thirdParty], '3p', gemini)).toBe(thirdParty)
    expect(resolveActiveQuotaGroup([gemini, thirdParty], null, thirdParty)).toBe(thirdParty)
    expect(resolveActiveQuotaGroup([gemini, thirdParty], 'missing', thirdParty)).toBe(thirdParty)
    expect(resolveActiveQuotaGroup([gemini, thirdParty], null, null)).toBe(gemini)
  })
})

describe('formatQuotaGroupTooltip', () => {
  const future = Date.now() + 3600_000

  it('formats full pool name, included models, and 5h/7d usage summary', () => {
    const g = makeGroup({
      key: 'gemini',
      name: 'Gemini Models',
      models: ['Gemini 4 Neon', 'Gemini 4 Carbon', 'Gemini 4 Argon'],
      fiveHour: { percent: 34.4, resetsAt: future, minutes: 300 },
      sevenDay: { percent: 67.8, resetsAt: future, minutes: 10080 }
    })
    const tip = formatQuotaGroupTooltip(g, { isDefault: true })
    expect(tip).toContain('Gemini Models')
    expect(tip).toContain('Gemini 4 Neon · Gemini 4 Carbon · Gemini 4 Argon')
    expect(tip).toContain('5h 34% · 7d 68%')
  })

  it('renders em-dash for missing windows and appends limited suffix when exhausted', () => {
    const g = makeGroup({
      key: '3p',
      name: 'Claude and GPT models',
      models: ['Claude Sonnet', 'GPT-5'],
      fiveHour: { percent: 100, resetsAt: future, minutes: 300 },
      sevenDay: null
    })
    const tip = formatQuotaGroupTooltip(g)
    expect(tip).toContain('Claude and GPT models')
    expect(tip).toContain('Claude Sonnet · GPT-5')
    expect(tip).toContain('5h 100% · 7d —')
  })
})
