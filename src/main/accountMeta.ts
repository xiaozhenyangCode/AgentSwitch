import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import type { BankedResetItem, BankedResets, ProfileConfig } from '@shared/types'
import { agyTokenFiles, isolatedKeychainFiles, isSystemClaudeDir, resolveProfileDir, safeRealpath } from './profiles'
import { realHome } from './shellEnv'

export interface AccountMeta {
  email: string | null
  planType: string | null
}

const emptyMeta = (): AccountMeta => ({ email: null, planType: null })
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const nonEmpty = (value: unknown): string | null => typeof value === 'string' ? value.trim() || null : null

const planNames = new Map([
  ['max_20x', 'Max 20x'], ['max_5x', 'Max 5x'], ['max', 'Max'], ['pro', 'Pro'], ['plus', 'Plus'],
  ['team', 'Team'], ['enterprise', 'Enterprise'], ['ultra', 'Ultra'], ['edu', 'Edu'], ['free', 'Free']
])
const placeholderPlans = new Set(['default_claude_ai', 'consumer', 'unknown', 'none', 'default', 'null'])

export function normalizePlanType(raw?: string | null): string | null {
  const value = nonEmpty(raw)?.toLowerCase().replace(/[\s-]+/g, '_')
  if (!value || placeholderPlans.has(value)) return null
  const plan = value.replace(/^(?:default_claude_|claude_|chatgpt_|google_ai_)/, '')
  if (placeholderPlans.has(plan)) return null
  return planNames.get(plan) ?? (plan.split('_').filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join(' ') || null)
}

export function decodeJwtPayload(token: unknown): Record<string, unknown> | null {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 3 || !/^[\w-]+$/.test(parts[1])) return null
  return parseJson(Buffer.from(parts[1], 'base64url').toString('utf8'))
}

function parseJson(raw: string | null): Record<string, unknown> | null {
  try { return raw === null ? null : record(JSON.parse(raw)) } catch { return null }
}

export function parseCodexAuthMeta(authJson: unknown): AccountMeta {
  const tokens = record(record(authJson)?.tokens)
  const id = decodeJwtPayload(tokens?.id_token)
  const access = decodeJwtPayload(tokens?.access_token)
  const auth = 'https://api.openai.com/auth'
  return {
    email: nonEmpty(id?.email) ?? nonEmpty(record(access?.['https://api.openai.com/profile'])?.email),
    planType: normalizePlanType(nonEmpty(record(id?.[auth])?.chatgpt_plan_type ?? record(access?.[auth])?.chatgpt_plan_type))
  }
}

export function parseClaudeAccountMeta(claudeJson: unknown, oauthCreds?: unknown): AccountMeta {
  const account = record(record(claudeJson)?.oauthAccount)
  const oauth = record(record(oauthCreds)?.claudeAiOauth)
  const plans = [oauth?.rateLimitTier, account?.userRateLimitTier, account?.organizationRateLimitTier,
    oauth?.subscriptionType, account?.organizationType, account?.seatTier]
  return {
    email: nonEmpty(account?.emailAddress),
    planType: plans.map((plan) => normalizePlanType(nonEmpty(plan))).find(Boolean) ?? null
  }
}

export function parseAgyCredentialPayload(raw: string): AccountMeta {
  const prefix = 'go-keyring-base64:'
  const text = raw.trim()
  const data = parseJson(text.startsWith(prefix) ? Buffer.from(text.slice(prefix.length), 'base64').toString('utf8') : text)
  return {
    email: nonEmpty(data?.id_token_email) ?? nonEmpty(data?.email) ?? nonEmpty(data?.account_email),
    planType: parseAgyPlanType(data)
  }
}

export function parseAgyPlanType(value: unknown): string | null {
  const data = record(value)
  return [data?.tier_name, data?.user_tier, data?.tier, data?.plan]
    .map((plan) => normalizePlanType(nonEmpty(plan))).find(Boolean) ?? null
}

const positiveCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

export function parseCodexBankedResets(raw: unknown, now = Date.now()): BankedResets | null {
  const result = record(raw)
  const data = record(result?.rateLimitResetCredits ?? result?.rate_limit_reset_credits ?? result)
  const credits = data?.credits
  if (credits == null || (Array.isArray(credits) && credits.length === 0)) {
    const count = data?.availableCount ?? data?.available_count
    return positiveCount(count) ? { remainingCount: count, items: [] } : null
  }
  if (!Array.isArray(credits)) return null

  const items: BankedResetItem[] = []
  for (const entry of credits) {
    const credit = record(entry)
    if (!credit || (credit.status != null && nonEmpty(credit.status)?.toLowerCase() !== 'available')) continue
    const expiry = credit.expiresAt ?? credit.expires_at
    const expiresAt = typeof expiry === 'number' ? (expiry < 1e12 ? expiry * 1000 : expiry)
      : typeof expiry === 'string' ? Date.parse(expiry) : NaN
    if (!Number.isFinite(new Date(expiresAt).getTime()) || expiresAt <= now) continue
    const title = nonEmpty(credit.title)
    items.push({ expiresAt, count: positiveCount(credit.count) ? credit.count : 1, ...(title ? { title } : {}) })
  }
  items.sort((a, b) => a.expiresAt - b.expiresAt)
  return items.length ? { remainingCount: items.reduce((sum, item) => sum + item.count, 0), items } : null
}

function readText(path: string): string | null {
  try { return readFileSync(path, 'utf8') } catch { return null }
}

function readProfileJson(dir: string, name: string) {
  const path = safeRealpath(join(dir, name))
  return path.startsWith(safeRealpath(dir) + sep) ? parseJson(readText(path)) : null
}

export function readClaudeAccountMeta(dir: string, oauthCreds?: unknown): AccountMeta {
  const account = isSystemClaudeDir(dir)
    ? parseJson(readText(join(realHome, '.claude.json')))
    : readProfileJson(dir, '.claude.json')
  return parseClaudeAccountMeta(account, oauthCreds ?? readProfileJson(dir, '.credentials.json'))
}

function mergeAgyFileMeta(meta: AccountMeta, raw: string | null): AccountMeta {
  if (!raw) return meta
  const candidate = parseAgyCredentialPayload(raw)
  if (meta.email && candidate.email && meta.email !== candidate.email) return meta
  return { email: meta.email ?? candidate.email, planType: meta.planType ?? candidate.planType }
}

export function readSyncAccountMeta(cfg: ProfileConfig): AccountMeta {
  if (cfg.apiKey || cfg.kind === 'reasonix') return emptyMeta()
  const dir = resolveProfileDir(cfg)
  if (cfg.kind === 'claude') return readClaudeAccountMeta(dir)
  if (cfg.kind === 'codex') return parseCodexAuthMeta(readProfileJson(dir, 'auth.json'))
  let meta = emptyMeta()
  for (const file of agyTokenFiles(dir)) {
    meta = mergeAgyFileMeta(meta, readText(file))
    if (meta.email && meta.planType) break
  }
  return meta
}

export async function readAsyncAgyAccountMeta(cfg: ProfileConfig, signal?: AbortSignal): Promise<AccountMeta> {
  if (cfg.apiKey || cfg.kind !== 'gemini' || signal?.aborted) return emptyMeta()
  const dir = resolveProfileDir(cfg)
  if (process.platform === 'darwin') {
    const global = safeRealpath(dir) === safeRealpath(realHome)
    const paths = global ? [] : isolatedKeychainFiles(dir)
    if (global || paths.length) {
      const raw = await new Promise<string | null>((resolve) => {
        execFile('/usr/bin/security', ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w', ...paths], {
          env: { HOME: dir, PATH: '/usr/bin:/bin', USER: process.env.USER ?? '' }, signal, timeout: 3000
        }, (error, stdout) => resolve(error ? null : stdout))
      })
      if (raw) {
        const meta = parseAgyCredentialPayload(raw)
        if (meta.email || meta.planType) return meta
      }
    }
  }
  let meta = emptyMeta()
  for (const file of agyTokenFiles(dir)) {
    if (signal?.aborted) return emptyMeta()
    const raw = await readFile(file, { encoding: 'utf8', signal }).catch(() => null)
    meta = mergeAgyFileMeta(meta, raw)
    if (meta.email && meta.planType) break
  }
  return meta
}
