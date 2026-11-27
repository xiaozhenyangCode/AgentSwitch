import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { authExpired, clearOAuthRefreshCooldown, oauthCredentialFile, quotaFailure, refreshOAuthCredentials, runWithOAuth401Recovery, type QuotaAttempt } from './oauthQuotaAuth'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const denied = { error: authExpired() }
const success = { value: 'quota' }
const json = (status: number, body: unknown) => ({ status, text: JSON.stringify(body) })

function credentialFile(data: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'agentswitch-oauth-'))
  dirs.push(dir)
  const file = join(dir, 'auth.json')
  writeFileSync(file, JSON.stringify(data))
  return { file, store: oauthCredentialFile(file) }
}

describe('OAuth quota recovery', () => {
  it.each(['claude', 'codex', 'gemini'])('retries %s with reloaded credentials before renewing', async (kind) => {
    const request = vi.fn(async (reload: boolean) => reload ? success : denied)
    const refresh = vi.fn()
    await expect(runWithOAuth401Recovery(kind, { request, refresh })).resolves.toEqual(success)
    expect(request.mock.calls).toEqual([[false], [true]])
    expect(refresh).not.toHaveBeenCalled()
  })

  it.each(['claude', 'codex'] as const)('updates %s credentials atomically, then retries', async (kind) => {
    const claude = kind === 'claude'
    const key = claude ? 'claudeAiOauth' : 'tokens'
    const access = claude ? 'accessToken' : 'access_token'
    const refresh = claude ? 'refreshToken' : 'refresh_token'
    const fields = { account_id: 'stable', ...(claude ? {} : { oauth_provenance: { issuer: 'https://login.example.test/', client_id: 'test-client' } }) }
    const { file, store } = credentialFile({ mcpOAuth: { a: true }, [key]: { [access]: 'old', [refresh]: 'refresh', ...fields } })
    const post = vi.fn(async () => json(200, { access_token: 'new', refresh_token: 'rotated', id_token: 'id-new', expires_in: 3600 }))
    const request = vi.fn(async () => (await store.read())?.[key][access] === 'new' ? success : denied)
    const result = await runWithOAuth401Recovery(kind, { request, refresh: () => refreshOAuthCredentials(kind, store, post) })
    expect(result).toEqual(success)
    expect(request.mock.calls).toHaveLength(3)
    expect(post).toHaveBeenCalledExactlyOnceWith(claude ? 'https://platform.claude.com/v1/oauth/token' : 'https://login.example.test/oauth/token', {
      grant_type: 'refresh_token', refresh_token: 'refresh', client_id: claude ? '9d1c250a-e61b-44d9-88ed-5944d1962f5e' : 'test-client'
    })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      mcpOAuth: { a: true },
      [key]: { [access]: 'new', [refresh]: 'rotated', ...fields, ...(claude ? { expiresAt: expect.any(Number) } : { id_token: 'id-new' }) },
      ...(claude ? {} : { last_refresh: expect.any(String) })
    })
  })

  it('shares one Gemini CLI renewal across simultaneous 401s for the same profile', async () => {
    let open = false
    let release!: () => void
    const waiting = new Promise<void>((resolve) => { release = resolve })
    const refresh = vi.fn(async () => {
      await waiting
      open = true
      return 'refreshed' as const
    })
    const request = vi.fn(async (): Promise<QuotaAttempt<string>> => open ? success : denied)
    const attempts = Array.from({ length: 3 }, () => runWithOAuth401Recovery('gemini-concurrent', { request, refresh }))
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(6))
    expect(refresh).toHaveBeenCalledTimes(1)
    release()
    await expect(Promise.all(attempts)).resolves.toEqual([success, success, success])
  })

  it('separates permanent errors from transient renewal failures', async () => {
    const { store } = credentialFile({ tokens: { refresh_token: 'refresh' } })
    await expect(refreshOAuthCredentials('codex', store, async () => json(400, { error: 'invalid_grant' })))
      .resolves.toMatchObject({ kind: 'auth_expired' })
    await expect(refreshOAuthCredentials('codex', store, async () => json(503, { error: 'invalid_grant' })))
      .resolves.toMatchObject({ kind: 'error' })
    const noToken = credentialFile({ tokens: { access_token: 'old' } })
    const post = vi.fn()
    await expect(refreshOAuthCredentials('codex', noToken.store, post)).resolves.toEqual(authExpired())
    expect(post).not.toHaveBeenCalled()

    const request = vi.fn(async () => denied)
    await expect(runWithOAuth401Recovery('gemini-denied', { request, refresh: async () => 'refreshed' })).resolves.toEqual(denied)
    expect(request).toHaveBeenCalledTimes(3)
    await expect(runWithOAuth401Recovery('gemini-transient', { request, refresh: async () => { throw new Error('timeout') } }))
      .resolves.toEqual({ error: quotaFailure('timeout') })
  })

  it('keeps a newer credential written by another CLI and drops results from canceled refreshes', async () => {
    const { store } = credentialFile({ tokens: { access_token: 'old', refresh_token: 'refresh' } })
    const newer = { tokens: { access_token: 'cli', refresh_token: 'cli-rotated' } }
    await expect(refreshOAuthCredentials('codex', store, async () => {
      await store.write(newer)
      return json(200, { access_token: 'racing' })
    })).resolves.toBe('refreshed')
    expect(await store.read()).toEqual(newer)

    const controller = new AbortController()
    await expect(refreshOAuthCredentials('codex', store, async () => {
      controller.abort()
      return json(200, { access_token: 'ignored' })
    }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(await store.read()).toEqual(newer)
  })

  it('classifies HTTP 429 refresh as rate_limited with Retry-After and backs off repeat attempts', async () => {
    const id = 'claude-429-backoff'
    clearOAuthRefreshCooldown(id)
    const { store } = credentialFile({ claudeAiOauth: { accessToken: 'old', refreshToken: 'refresh' } })
    const post = vi.fn(async (): Promise<{ status: number; text: string; headers?: Record<string, string> }> => ({ status: 429, text: '{"error":"rate_limit_error"}', headers: { 'retry-after': '120' } }))
    const request = vi.fn(async () => denied)

    const first = await runWithOAuth401Recovery(id, {
      request,
      refresh: () => refreshOAuthCredentials('claude', store, post)
    })
    expect(first).toEqual({
      error: { kind: 'rate_limited', message: 'OAuth refresh HTTP 429', resetAt: expect.any(Number) }
    })
    expect(post).toHaveBeenCalledTimes(1)

    // Subsequent poll during cooldown must not hammer the OAuth token endpoint again.
    const second = await runWithOAuth401Recovery(id, {
      request,
      refresh: () => refreshOAuthCredentials('claude', store, post)
    })
    expect(second).toEqual(first)
    expect(post).toHaveBeenCalledTimes(1)

    // Clearing cooldown (e.g. after reauth) allows refresh again.
    clearOAuthRefreshCooldown(id)
    post.mockResolvedValueOnce({ status: 200, text: JSON.stringify({ access_token: 'fresh', expires_in: 3600 }), headers: {} })
    const recovered = await runWithOAuth401Recovery(id, {
      request: async () => (await store.read())?.claudeAiOauth?.accessToken === 'fresh' ? success : denied,
      refresh: () => refreshOAuthCredentials('claude', store, post)
    })
    expect(recovered).toEqual(success)
    expect(post).toHaveBeenCalledTimes(2)
  })
})
