import { randomBytes } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import type { ProfileId, QuotaErrorKind } from '@shared/types'

export const OAUTH_AUTH_ERROR_RE = /\b(?:401|invalid_grant|invalid_token|authentication_error|(?:oauth access )?token (?:has )?expired|authentication required|unauthenticated|unauthori[sz]ed|not authenticated|not logged in)\b/i

export interface QuotaFailure {
  kind: QuotaErrorKind
  message: string
  resetAt: number | null
}

export type QuotaAttempt<T> = { value: T } | { error: QuotaFailure }
export type RefreshResult = 'refreshed' | QuotaFailure

export const quotaFailure = (message: string, kind: QuotaErrorKind = 'error'): QuotaFailure => ({
  kind, message, resetAt: null
})

const AUTH_REQUIRED = 'Authentication required'
export const authExpired = () => quotaFailure(AUTH_REQUIRED, 'auth_expired')

const refreshing = new Map<ProfileId, { request: Promise<RefreshResult>; signal?: AbortSignal }>()

export function singleFlightRefresh(id: ProfileId, refresh: () => Promise<RefreshResult>, signal?: AbortSignal): Promise<RefreshResult> {
  const pending = refreshing.get(id)
  if (pending && !pending.signal?.aborted) return pending.request
  const request = Promise.resolve().then(refresh).finally(() => {
    if (refreshing.get(id)?.request === request) refreshing.delete(id)
  })
  refreshing.set(id, { request, signal })
  return request
}

export async function runWithOAuth401Recovery<T>(
  id: ProfileId,
  { request, refresh, signal }: {
    request: (reload: boolean) => Promise<QuotaAttempt<T>>
    refresh: () => Promise<RefreshResult>
    signal?: AbortSignal
  }
): Promise<QuotaAttempt<T>> {
  try {
    signal?.throwIfAborted()
    const first = await request(false)
    if (!('error' in first) || first.error.kind !== 'auth_expired') return first
    signal?.throwIfAborted()
    const reloaded = await request(true)
    if (!('error' in reloaded) || reloaded.error.kind !== 'auth_expired') return reloaded
    signal?.throwIfAborted()
    const refreshed = await singleFlightRefresh(id, refresh, signal)
    if (refreshed !== 'refreshed') {
      const error = refreshed.kind === 'auth_expired' && refreshed.message === AUTH_REQUIRED ? reloaded.error : refreshed
      return { error }
    }
    signal?.throwIfAborted()
    return await request(true)
  } catch (err) {
    return { error: quotaFailure(err instanceof Error ? err.message : String(err)) }
  }
}

type CredentialData = Record<string, any>

export interface OAuthCredentialStore {
  read(): Promise<CredentialData | null>
  write(data: CredentialData): Promise<void>
}

export function oauthCredentialFile(path: string): OAuthCredentialStore {
  return {
    async read() {
      try {
        return JSON.parse(readFileSync(path, 'utf8'))
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw new Error('Could not read OAuth credentials')
      }
    },
    async write(data) {
      const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`
      try {
        writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' })
        renameSync(temp, path)
      } finally {
        rmSync(temp, { force: true })
      }
    }
  }
}

export type OAuthPost = (url: string, body: Record<string, string>) => Promise<{ status: number; text: string }>

const tokenString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

export async function refreshOAuthCredentials(
  kind: 'claude' | 'codex',
  store: OAuthCredentialStore,
  post: OAuthPost,
  signal?: AbortSignal,
  rejectedAccessToken?: string
): Promise<RefreshResult> {
  const claude = kind === 'claude'
  const key = claude ? 'claudeAiOauth' : 'tokens'
  const access = claude ? 'accessToken' : 'access_token'
  const refresh = claude ? 'refreshToken' : 'refresh_token'
  const before = await store.read()
  const tokens = before?.[key]
  if (rejectedAccessToken && tokenString(tokens?.[access]) && tokens[access] !== rejectedAccessToken) return 'refreshed'
  if (!tokenString(tokens?.[refresh])) return authExpired()

  const provenance = claude ? null : tokens.oauth_provenance
  const endpoint = new URL(claude ? 'https://platform.claude.com/v1/oauth/token' :
    `${(provenance?.issuer || 'https://auth.openai.com').replace(/\/$/, '')}/oauth/token`)
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    return quotaFailure('Invalid OAuth issuer')
  }
  signal?.throwIfAborted()
  const response = await post(endpoint.href, {
    grant_type: 'refresh_token',
    refresh_token: tokens[refresh],
    client_id: claude ? '9d1c250a-e61b-44d9-88ed-5944d1962f5e' : provenance?.client_id || 'app_EMoamEEZ73f0CkXaXp7hrann'
  })
  signal?.throwIfAborted()
  const latest = await store.read()
  signal?.throwIfAborted()
  if (!latest) return authExpired()
  const current = latest[key]
  if (current?.[access] !== tokens[access] || current?.[refresh] !== tokens[refresh]) return 'refreshed'

  let result
  try { result = JSON.parse(response.text) } catch { /* HTTP status is still available. */ }
  if (response.status < 200 || response.status >= 300) {
    const invalidGrant = result?.error === 'invalid_grant' || result?.error?.code === 'invalid_grant'
    if (response.status === 400 || response.status === 401 || (response.status < 500 && invalidGrant)) {
      return quotaFailure(`OAuth refresh HTTP ${response.status}${invalidGrant ? ': invalid_grant' : ''}`, 'auth_expired')
    }
    return quotaFailure(`OAuth refresh HTTP ${response.status}`)
  }
  if (!tokenString(result?.access_token)) return quotaFailure('OAuth refresh response did not contain an access token')
  const updated = { ...current, [access]: result.access_token }
  if (tokenString(result.refresh_token)) updated[refresh] = result.refresh_token
  if (claude && Number.isFinite(result.expires_in)) updated.expiresAt = Date.now() + result.expires_in * 1000
  if (!claude && tokenString(result.id_token)) updated.id_token = result.id_token
  await store.write({ ...latest, [key]: updated, ...(!claude && { last_refresh: new Date().toISOString() }) })
  return 'refreshed'
}
