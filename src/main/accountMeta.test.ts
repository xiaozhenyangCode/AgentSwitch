import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProfileConfig } from '@shared/types'
import {
  decodeJwtPayload, normalizePlanType, parseAgyCredentialPayload, parseClaudeAccountMeta,
  parseCodexAuthMeta, parseCodexBankedResets, readAsyncAgyAccountMeta, readSyncAccountMeta
} from './accountMeta'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() }, safeStorage: {} }))

const noMeta = { email: null, planType: null }
const jwt = (payload: unknown): string => 'header.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.signature'
const authClaim = 'https://api.openai.com/auth'
const profileClaim = 'https://api.openai.com/profile'

describe('account metadata parsing', () => {
  it.each([
    ['default_claude_max_5x', 'Max 5x'], ['claude_max_20x', 'Max 20x'], ['claude_max', 'Max'],
    ['google_ai_pro', 'Pro'], ['chatgpt_plus', 'Plus'], ['team', 'Team'], ['claude_enterprise', 'Enterprise'],
    ['google_ai_ultra', 'Ultra'], ['edu', 'Edu'], ['free', 'Free'], ['chatgpt_future_tier', 'Future Tier'],
    ['default_claude_ai', null], ['consumer', null], ['unknown', null], ['none', null], ['default', null],
    ['null', null], ['   ', null], [undefined, null]
  ])('normalizes %s', (raw, expected) => {
    expect(normalizePlanType(raw)).toBe(expected)
  })

  it('decodes Codex ID claims and falls back to access token claims', () => {
    const access_token = jwt({ [authClaim]: { chatgpt_plan_type: 'team' }, [profileClaim]: { email: 'fallback@example.test' } })
    const id_token = jwt({ [authClaim]: { chatgpt_plan_type: 'plus' }, email: 'access@example.test' })
    expect(parseCodexAuthMeta({ tokens: { access_token, id_token } })).toEqual({ email: 'access@example.test', planType: 'Plus' })
    expect(parseCodexAuthMeta({ tokens: { access_token, id_token: 'invalid' } })).toEqual({ email: 'fallback@example.test', planType: 'Team' })
    expect(decodeJwtPayload(jwt([]))).toBeNull()
    expect(decodeJwtPayload('a.!.b')).toBeNull()
    expect(parseCodexAuthMeta({})).toEqual(noMeta)
  })

  it('uses Claude account email and prefers a recognized credential tier to the subscription', () => {
    const config = { oauthAccount: { emailAddress: 'claude@example.test', userRateLimitTier: 'default_claude_max_5x' } }
    expect(parseClaudeAccountMeta(config, { claudeAiOauth: { rateLimitTier: 'default_claude_max_20x', subscriptionType: 'claude_pro' } }))
      .toEqual({ email: 'claude@example.test', planType: 'Max 20x' })
    expect(parseClaudeAccountMeta(config, { claudeAiOauth: { rateLimitTier: 'default_claude_ai' } }).planType).toBe('Max 5x')
    expect(parseClaudeAccountMeta(null, { claudeAiOauth: { subscriptionType: 'claude_pro' } }))
      .toEqual({ email: null, planType: 'Pro' })
    expect(parseClaudeAccountMeta(null)).toEqual(noMeta)
  })

  it('reads raw and Keychain-encoded Gemini credentials without treating consumer auth as a plan', () => {
    const consumer = JSON.stringify({ id_token_email: 'agy@example.test', auth_method: 'consumer', tier: 'consumer' })
    expect(parseAgyCredentialPayload('go-keyring-base64:' + Buffer.from(consumer).toString('base64')))
      .toEqual({ email: 'agy@example.test', planType: null })
    expect(parseAgyCredentialPayload(JSON.stringify({ account_email: 'ultra@example.test', tier_name: 'unknown', plan: 'google_ai_ultra' })))
      .toEqual({ email: 'ultra@example.test', planType: 'Ultra' })
    expect(parseAgyCredentialPayload('go-keyring-base64:invalid')).toEqual(noMeta)
  })
})

describe('isolated metadata reads', () => {
  const dirs: string[] = []
  function profile(kind: ProfileConfig['kind']): ProfileConfig {
    const configDir = mkdtempSync(join(tmpdir(), 'agentswitch-meta-'))
    dirs.push(configDir)
    return { id: kind, name: kind, kind, configDir, imported: false, loginCommand: '', runCommand: '', extraEnv: {}, defaultModel: '', autoApprove: 'edits', createdAt: 0 }
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('reads each Claude profile from its own directory', () => {
    const a = profile('claude')
    const b = profile('claude')
    writeFileSync(join(a.configDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@example.test' } }))
    writeFileSync(join(a.configDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { rateLimitTier: 'default_claude_max_5x' } }))
    writeFileSync(join(b.configDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'b@example.test', organizationType: 'pro' } }))
    expect(readSyncAccountMeta(a)).toEqual({ email: 'a@example.test', planType: 'Max 5x' })
    expect(readSyncAccountMeta(b)).toEqual({ email: 'b@example.test', planType: 'Pro' })
  })

  it('uses resolved Codex paths and skips a sibling account’s symlinked credentials', () => {
    const a = profile('codex')
    const b = profile('codex')
    const path = join(a.configDir, 'auth.json')
    writeFileSync(path, JSON.stringify({ tokens: { id_token: jwt({ email: 'codex@example.test' }) } }))
    symlinkSync(path, join(b.configDir, 'auth.json'))
    expect(readSyncAccountMeta(b)).toEqual(noMeta)
    expect(readSyncAccountMeta({ ...b, extraEnv: { CODEX_HOME: a.configDir } })).toEqual({ email: 'codex@example.test', planType: null })
  })

  it('reads Gemini file fallback from the selected HOME', async () => {
    const a = profile('gemini')
    const b = profile('gemini')
    const tokenPath = join(a.configDir, '.gemini', 'oauth-token.json')
    mkdirSync(join(a.configDir, '.gemini'))
    writeFileSync(tokenPath, JSON.stringify({ id_token_email: 'gemini@example.test', plan: 'google_ai_pro' }))
    symlinkSync(join(a.configDir, '.gemini'), join(b.configDir, '.gemini'), 'dir')
    expect(readSyncAccountMeta(a)).toEqual({ email: 'gemini@example.test', planType: 'Pro' })
    await expect(readAsyncAgyAccountMeta(a)).resolves.toEqual({ email: 'gemini@example.test', planType: 'Pro' })
    await expect(readAsyncAgyAccountMeta(b)).resolves.toEqual(noMeta)
  })
})

describe('Codex banked resets', () => {
  const now = 1_800_000_000_000
  it('accepts seconds, milliseconds and ISO expiry dates and sorts live batches', () => {
    const banked = parseCodexBankedResets({ rateLimitResetCredits: { availableCount: 30, credits: [
      { status: 'available', expiresAt: new Date(now + 9000).toISOString(), count: 2 },
      { status: 'available', expiresAt: now - 1000 },
      { expiresAt: now, count: 3 },
      { status: 'used', expiresAt: now + 1000 },
      { status: 'AVAILABLE', expires_at: (now + 3000) / 1000, title: 'Full reset' },
      { expires_at: now + 6000, count: 1.5 },
      { expiresAt: 'invalid' }
    ] } }, now)
    expect(banked).toEqual({ remainingCount: 4, items: [
      { count: 1, expiresAt: now + 3000, title: 'Full reset' },
      { count: 1, expiresAt: now + 6000 },
      { count: 2, expiresAt: now + 9000 }
    ] })
  })

  it('preserves count-only responses and drops totals backed only by expired or invalid credits', () => {
    expect(parseCodexBankedResets({ rate_limit_reset_credits: { available_count: 2, credits: [] } }, now))
      .toEqual({ remainingCount: 2, items: [] })
    expect(parseCodexBankedResets({ availableCount: 1 }, now)).toEqual({ remainingCount: 1, items: [] })
    expect(parseCodexBankedResets({ availableCount: 1, credits: [{ expiresAt: now }] }, now)).toBeNull()
    expect(parseCodexBankedResets({ availableCount: 3, credits: {} }, now)).toBeNull()
    expect(parseCodexBankedResets(null, now)).toBeNull()
  })
})
