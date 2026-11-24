import { describe, expect, it } from 'vitest'
import { KINDS, type AutoApprove } from './types'
import {
  PROVIDER_CAPABILITIES,
  canUseOAuthLogin,
  canUseSubscriptionQuota,
  defaultContextWindowFor,
  getProviderCapabilities,
  isPermissionModeSupported,
  resolvePermissionMode,
  shouldUnbindSessionsOnRewind,
  supportsThreadHistory,
  usesInlineSystemPrompt
} from './providerCapabilities'
import { splitSpec } from './modelSpec'
import { historyModel } from './transcript'

describe('providerCapabilities single source of truth', () => {
  it('declares complete and internally consistent capabilities for every registered ProfileKind', () => {
    expect(Object.keys(PROVIDER_CAPABILITIES).sort()).toEqual([...KINDS].sort())

    for (const kind of KINDS) {
      const caps = getProviderCapabilities(kind)
      expect(caps).toBe(PROVIDER_CAPABILITIES[kind])
      expect(Number.isFinite(caps.defaultContextWindow)).toBe(true)
      expect(caps.defaultContextWindow).toBeGreaterThan(0)
      expect(caps.permissionModes.length).toBeGreaterThan(0)
      expect(caps.permissionModes).toContain(caps.defaultPermissionMode)
      expect(['/', '$', null]).toContain(caps.skillTriggerPrefix)
      expect(caps.supportsExtensions).toBe(caps.skillTriggerPrefix !== null)
      expect(caps.supportsPassiveModelList).toBe(caps.modelListMode !== 'explicit-refresh')
      // Reserved for P2-1 persistent steering; must remain false until genuinely supported.
      expect(caps.supportsSteer).toBe(false)
      expect(caps.supportsNativeRewind).toBe(false)
      expect(caps.supportsFork).toBe(false)
    }
  })

  it('computes fallback context window and 1M variants from capability table', () => {
    expect(defaultContextWindowFor('claude', 'claude-opus-5-5')).toBe(200_000)
    expect(defaultContextWindowFor('claude', 'claude-opus-5-5[1m]')).toBe(1_000_000)
    expect(defaultContextWindowFor('claude', 'claude-sonnet-4-1m')).toBe(1_000_000)
    expect(defaultContextWindowFor('codex', 'gpt-5')).toBe(272_000)
    expect(defaultContextWindowFor('gemini', null)).toBe(1_000_000)
    expect(defaultContextWindowFor('reasonix', 'deepseek-v4-pro')).toBe(1_000_000)
  })

  it('derives system prompt delivery mode across providers and transports', () => {
    expect(usesInlineSystemPrompt('claude')).toBe(false)
    expect(usesInlineSystemPrompt('codex')).toBe(true)
    expect(usesInlineSystemPrompt('reasonix')).toBe(true)
    expect(usesInlineSystemPrompt('gemini', 'print')).toBe(true)
    expect(usesInlineSystemPrompt('gemini', undefined)).toBe(true)
    expect(usesInlineSystemPrompt('gemini', 'acp')).toBe(false)
  })

  it('offers history tools on Claude and Codex CLI and on Gemini ACP', () => {
    expect(supportsThreadHistory('claude')).toBe(true)
    expect(supportsThreadHistory('codex')).toBe(true)
    expect(supportsThreadHistory('gemini')).toBe(false)
    expect(supportsThreadHistory('gemini', 'print')).toBe(false)
    expect(supportsThreadHistory('gemini', 'acp')).toBe(true)
    expect(supportsThreadHistory('reasonix', 'acp')).toBe(false)
  })

  it('drives permission mode validation, skill trigger prefix, rewind unbinding, and auth/quota rules', () => {
    for (const kind of KINDS) {
      for (const mode of ['cli', 'edits', 'full'] as AutoApprove[]) {
        expect(isPermissionModeSupported(kind, mode)).toBe(true)
        expect(resolvePermissionMode(kind, mode)).toBe(mode)
      }
      expect(resolvePermissionMode(kind, 'nonexistent')).toBe(getProviderCapabilities(kind).defaultPermissionMode)
      expect(shouldUnbindSessionsOnRewind(kind)).toBe(!getProviderCapabilities(kind).supportsNativeRewind)
    }

    expect(getProviderCapabilities('claude').skillTriggerPrefix).toBe('/')
    expect(getProviderCapabilities('codex').skillTriggerPrefix).toBe('$')
    expect(getProviderCapabilities('gemini').skillTriggerPrefix).toBe('/')
    expect(getProviderCapabilities('reasonix').skillTriggerPrefix).toBeNull()

    expect(canUseOAuthLogin('claude')).toBe(true)
    expect(canUseOAuthLogin('codex')).toBe(true)
    expect(canUseOAuthLogin('gemini')).toBe(true)
    expect(canUseOAuthLogin('reasonix')).toBe(false)

    expect(canUseSubscriptionQuota('claude', false)).toBe(true)
    expect(canUseSubscriptionQuota('claude', true)).toBe(false)
    expect(canUseSubscriptionQuota('reasonix', false)).toBe(false)
  })

  it('drives :disabled effort parsing via supportsDisabledEffort', () => {
    expect(splitSpec('deepseek-v4-pro:disabled', 'reasonix')).toEqual({ model: 'deepseek-v4-pro', effort: 'disabled' })
    expect(historyModel('deepseek-v4-pro:disabled', 'reasonix')).toBe('deepseek-v4-pro')

    expect(splitSpec('claude-opus-5-5:disabled', 'claude')).toEqual({ model: 'claude-opus-5-5:disabled', effort: null })
    expect(splitSpec('gpt-5:disabled', 'codex')).toEqual({ model: 'gpt-5:disabled', effort: null })
    expect(splitSpec('gemini-4-neon:disabled', 'gemini')).toEqual({ model: 'gemini-4-neon:disabled', effort: null })
  })
})
