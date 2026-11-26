import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProfileConfig } from '@shared/types'

const { state, mockProfiles, dirs, fetchMock, runAgentMock } = vi.hoisted(() => ({
  state: { userDataDir: '/tmp/agentswitch-quota-rl-init' },
  mockProfiles: [] as ProfileConfig[],
  dirs: [] as string[],
  fetchMock: vi.fn(),
  runAgentMock: vi.fn()
}))

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

state.userDataDir = tempDir('agentswitch-quota-rl-userdata-')

vi.mock('electron', () => ({
  app: { getPath: () => state.userDataDir },
  net: { fetch: (...args: unknown[]) => fetchMock(...args) },
  safeStorage: {}
}))

vi.mock('./profiles', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./profiles')>()
  return {
    ...orig,
    listConfigs: () => mockProfiles,
    hasProfile: (id: unknown): id is string => typeof id === 'string' && mockProfiles.some((p) => p.id === id),
    getConfig: (id: string) => {
      const found = mockProfiles.find((p) => p.id === id)
      if (!found) throw new Error(`unknown account: ${id}`)
      return found
    },
    isLoggedIn: (id: string) => mockProfiles.some((p) => p.id === id),
    buildSpawnSpec: () => ({ env: {} as NodeJS.ProcessEnv })
  }
})

vi.mock('./agentRunner', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./agentRunner')>()
  return {
    ...orig,
    runAgent: (...args: unknown[]) => runAgentMock(...args)
  }
})

function makeClaudeProfile(overrides: Partial<ProfileConfig> = {}): ProfileConfig {
  const dir = tempDir('agentswitch-claude-home-')
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'test-oauth-token' } }))
  return {
    id: 'claude-sub',
    name: 'Claude Pro',
    kind: 'claude',
    configDir: dir,
    imported: false,
    loginCommand: 'claude login',
    runCommand: 'claude',
    extraEnv: {},
    defaultModel: '',
    autoApprove: 'edits',
    createdAt: 0,
    ...overrides
  }
}

function mockFetchResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    headers: {
      forEach: (cb: (v: string, k: string) => void) => {
        for (const [k, v] of Object.entries(headers)) cb(v, k)
      }
    }
  }
}

afterEach(() => {
  mockProfiles.length = 0
  fetchMock.mockReset()
  runAgentMock.mockReset()
  while (dirs.length > 1) {
    const dir = dirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('classifyQuotaError', () => {
  it('classifies HTTP 429 and parses Retry-After / reset headers and payloads across engines', async () => {
    const { classifyQuotaError } = await import('./usage')
    const now = 1_760_000_000_000

    // Claude OAuth 429 with Retry-After seconds
    const claude = classifyQuotaError({
      status: 429,
      message: 'HTTP 429: Rate limit exceeded',
      headers: { 'Retry-After': '180' },
      now
    })
    expect(claude).toEqual({
      kind: 'rate_limited',
      message: 'HTTP 429: Rate limit exceeded',
      resetAt: now + 180_000
    })

    // Claude OAuth 429 with anthropic-ratelimit-unified-reset epoch seconds
    const resetSec = Math.floor((now + 3600_000) / 1000)
    const claudeReset = classifyQuotaError({
      status: 429,
      message: 'HTTP 429',
      headers: { 'anthropic-ratelimit-unified-reset': String(resetSec) },
      now
    })
    expect(claudeReset?.kind).toBe('rate_limited')
    expect(claudeReset?.resetAt).toBe(resetSec * 1000)

    // Codex JSON-RPC rate limit error with resets_at in body
    const codex = classifyQuotaError({
      message: 'Usage limit reached for this account',
      body: { code: 429, resets_at: resetSec },
      now
    })
    expect(codex?.kind).toBe('rate_limited')
    expect(codex?.resetAt).toBe(resetSec * 1000)

    // Gemini RESOURCE_EXHAUSTED with inline duration hint
    const gemini = classifyQuotaError({
      message: 'RESOURCE_EXHAUSTED: Quota exceeded, try again in 15 minutes',
      now
    })
    expect(gemini?.kind).toBe('rate_limited')
    expect(gemini?.resetAt).toBe(now + 15 * 60_000)

    // Generic network error is classified as 'error' (not rate_limited)
    const generic = classifyQuotaError({
      message: 'fetch failed: ECONNRESET',
      now
    })
    expect(generic).toEqual({
      kind: 'error',
      message: 'fetch failed: ECONNRESET',
      resetAt: null
    })
  })
})

describe('quota refresh under 429 rate limiting', () => {
  it('Scenario A: preserves last valid 5h/7d snapshot and overlays rate_limited metadata on HTTP 429', async () => {
    state.userDataDir = tempDir('agentswitch-quota-a-')
    mkdirSync(state.userDataDir, { recursive: true })
    const cfg = makeClaudeProfile({ id: 'claude-a', name: 'Claude A' })
    mockProfiles.push(cfg)

    vi.resetModules()
    const usage = await import('./usage')

    const prevFetchedAt = Date.now() - 60_000
    const prevReset = Date.now() + 3 * 3600_000
    usage.recordQuota(
      cfg.id,
      {
        fiveHour: { percent: 62, resetsAt: prevReset, minutes: 300 },
        sevenDay: { percent: 41, resetsAt: prevReset + 86400_000, minutes: 10080 },
        limited: false,
        plan: null
      },
      'claude-oauth',
      prevFetchedAt
    )

    fetchMock.mockResolvedValueOnce(
      mockFetchResponse(429, { error: { type: 'rate_limit_error', message: 'Rate limited' } }, { 'retry-after': '300' })
    )

    const ok = await usage.refreshClaudeOauth(cfg.id)
    expect(ok).toBe(false)

    const snap = usage.snapshot()
    const acct = snap.accounts[cfg.id]
    // Cached 5h/7d snapshot is preserved intact
    expect(acct.quota).toMatchObject({
      fiveHour: { percent: 62, resetsAt: prevReset, minutes: 300 },
      sevenDay: { percent: 41, minutes: 10080 },
      fetchedAt: prevFetchedAt,
      source: 'claude-oauth'
    })
    // Rate-limit state & parsed reset time are surfaced
    expect(acct.quotaErrorKind).toBe('rate_limited')
    expect(acct.quotaError).toContain('HTTP 429')
    expect(acct.quotaErrorResetAt).toBeGreaterThan(Date.now())
    expect(acct.limitedAt).not.toBeNull()

    // refreshUsage(true) skips redundant Haiku probe when OAuth already reported 429
    fetchMock.mockResolvedValue(
      mockFetchResponse(429, { error: { type: 'rate_limit_error', message: 'Rate limited' } }, { 'retry-after': '300' })
    )
    await usage.refreshUsage(true)
    expect(runAgentMock).not.toHaveBeenCalled()
  })

  it('Scenario B: cold start with no cached snapshot keeps account with local today tokens/cost and rate_limited error', async () => {
    state.userDataDir = tempDir('agentswitch-quota-b-')
    mkdirSync(state.userDataDir, { recursive: true })
    const cfg = makeClaudeProfile({ id: 'claude-b', name: 'Claude Cold' })
    mockProfiles.push(cfg)

    vi.resetModules()
    const usage = await import('./usage')

    // Record local run so today has tokens and cost
    usage.recordRun(cfg.id, 'claude-sonnet-4-5', { input: 500_000, output: 100_000, cacheRead: 0 })

    fetchMock.mockResolvedValueOnce(
      mockFetchResponse(429, { error: { message: 'Too many requests' } }, { 'retry-after': '600' })
    )

    const ok = await usage.refreshClaudeOauth(cfg.id)
    expect(ok).toBe(false)

    const snap = usage.snapshot()
    const acct = snap.accounts[cfg.id]
    expect(acct).toBeDefined()
    expect(acct.quota).toBeNull()
    expect(acct.quotaErrorKind).toBe('rate_limited')
    expect(acct.quotaError).toContain('HTTP 429')
    expect(acct.quotaErrorResetAt).toBeGreaterThan(Date.now())
    expect(acct.today.input).toBe(500_000)
    expect(acct.today.output).toBe(100_000)
    expect(acct.today.costUsd).toBeGreaterThan(0)
  })

  it('Scenario C: successful refresh clears rate_limited error and API-key accounts are untouched', async () => {
    state.userDataDir = tempDir('agentswitch-quota-c-')
    mkdirSync(state.userDataDir, { recursive: true })
    const subCfg = makeClaudeProfile({ id: 'claude-ok', name: 'Claude Sub' })
    const apiCfg = makeClaudeProfile({
      id: 'claude-apikey',
      name: 'Claude API',
      apiKey: { provider: 'official' }
    })
    mockProfiles.push(subCfg, apiCfg)

    vi.resetModules()
    const usage = await import('./usage')

    // First hit 429, then recover with 200
    fetchMock.mockResolvedValueOnce(mockFetchResponse(429, { error: { message: 'Rate limited' } }, { 'retry-after': '60' }))
    await usage.refreshClaudeOauth(subCfg.id)
    expect(usage.snapshot().accounts[subCfg.id].quotaErrorKind).toBe('rate_limited')

    const futureIso = new Date(Date.now() + 2 * 3600_000).toISOString()
    fetchMock.mockResolvedValueOnce(
      mockFetchResponse(200, {
        five_hour: { utilization: 25.5, resets_at: futureIso },
        seven_day: { utilization: 10.0, resets_at: futureIso }
      })
    )
    const recovered = await usage.refreshClaudeOauth(subCfg.id)
    expect(recovered).toBe(true)

    const snap = usage.snapshot()
    expect(snap.accounts[subCfg.id].quota?.fiveHour?.percent).toBe(25.5)
    expect(snap.accounts[subCfg.id].quotaError).toBeNull()
    expect(snap.accounts[subCfg.id].quotaErrorKind).toBeNull()
    expect(snap.accounts[subCfg.id].quotaErrorResetAt).toBeNull()

    // API-key account is skipped by OAuth quota refresh
    const apiOk = await usage.refreshClaudeOauth(apiCfg.id)
    expect(apiOk).toBe(false)
    expect(snap.accounts[apiCfg.id].quota).toBeNull()
    expect(snap.accounts[apiCfg.id].quotaError).toBeNull()
  })
})
