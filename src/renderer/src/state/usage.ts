import { useSyncExternalStore } from 'react'
import type { AccountUsage, PriceRate, ProfileId, ProfileState, QuotaGroup, QuotaWindow, Usage, UsageSnapshot } from '@shared/types'
import { getProviderCapabilities } from '@shared/providerCapabilities'
import { EFFORT_SUFFIX_RE, splitSpec } from '@shared/modelSpec'
import { isReady } from '../lib/ui'
import { getSettings } from './settings'
import { fmtAgo as fmtAgoI18n, t } from './i18n'

/** Usage & quota snapshot pushed by the main process (src/main/usage.ts). */

let snap: UsageSnapshot | null = null
const listeners = new Set<() => void>()
const emit = (s: UsageSnapshot) => {
  snap = s
  listeners.forEach((l) => l())
}
void window.agentswitch.usage.get().then(emit)
window.agentswitch.usage.onChanged(emit)

export function useUsage(): UsageSnapshot | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => snap
  )
}

/** Refresh now; probes Claude quota only when enabled in 设置 › 用量与刷新. */
export async function refreshUsage(): Promise<void> {
  emit(await window.agentswitch.usage.refresh(getSettings().probeClaude))
}

/** Saves or clears (`rate === null`) a custom per-model price override (USD / 1M tokens). */
export async function setModelPrice(model: string, rate: PriceRate | null): Promise<UsageSnapshot> {
  const next = await window.agentswitch.usage.setPrice(model, rate)
  emit(next)
  return next
}

/**
 * Estimates a single message's USD cost from its token counts and the current usage price table
 * (custom overrides take precedence; falls back to the CLI-reported `usage.costUsd`).
 */
export function estimateMessageCost(usage: Usage | null | undefined, model: string | null | undefined, s: UsageSnapshot | null = snap): number | null {
  if (!usage) return null
  const m = (model ?? '').trim()
  const key = m.toLowerCase()
  const custom = key ? s?.customPrices?.[key] : undefined
  const tableRate = custom ?? (m ? s?.models?.[m]?.rate : undefined) ?? (key ? s?.models?.[key]?.rate : undefined) ?? null
  const input = usage.input ?? 0
  const output = usage.output ?? 0
  const cacheRead = usage.cacheRead ?? 0
  const cacheWrite = usage.cacheWrite ?? 0
  const hasTokens = input + output + cacheRead + cacheWrite > 0
  if (tableRate && hasTokens) {
    const prompt = usage.context ?? input + cacheRead + cacheWrite
    const l = tableRate.long && prompt > tableRate.long.threshold ? tableRate.long : null
    const rIn = l?.input ?? tableRate.input
    const rOut = l?.output ?? tableRate.output
    const rCR = l?.cacheRead ?? tableRate.cacheRead ?? rIn
    const rCW = l?.cacheWrite ?? tableRate.cacheWrite ?? rIn
    const rCW1h = l ? rCW * 1.6 : (tableRate.cacheWrite1h ?? (tableRate.cacheWrite !== undefined ? tableRate.cacheWrite * 1.6 : rIn))
    const w1h = Math.min(usage.cacheWrite1h ?? 0, cacheWrite)
    return (input * rIn + output * rOut + cacheRead * rCR + (cacheWrite - w1h) * rCW + w1h * rCW1h) / 1e6
  }
  return typeof usage.costUsd === 'number' ? usage.costUsd : null
}

// ---- interpretation ------------------------------------------------------------------------

/** Window still current (a past reset means the old percentage no longer applies). */
export const liveWindow = (w: QuotaWindow | null | undefined): QuotaWindow | null => (w && (!w.resetsAt || w.resetsAt > Date.now()) ? w : null)

const norm = (s: string) => s.toLowerCase().replace(/[-_.()]+/g, ' ').replace(/\s+/g, ' ').trim()

/** agy quota group a model belongs to (Argon has its own; Claude/GPT share '3p'; default Gemini). */
export function groupFor(groups: QuotaGroup[] | undefined, model: string | null | undefined): QuotaGroup | null {
  if (!groups?.length) return null
  const base = splitSpec(model).model ?? ''
  const m = norm(EFFORT_SUFFIX_RE.exec(base)?.[1] ?? base)
  if (m) {
    let best: { g: QuotaGroup; len: number } | null = null
    for (const g of groups)
      for (const name of [g.name, ...g.models]) {
        const c = norm(name)
        if (c && (m === c || m.startsWith(c + ' ') || c.startsWith(m)) && (!best || c.length > best.len)) best = { g, len: c.length }
      }
    if (best) return best.g
    if (/^(claude|gpt)/.test(m)) return groups.find((g) => g.key === '3p') ?? null
  }
  return groups.find((g) => g.key === 'gemini') ?? groups[0]
}

/** Windows that apply to the selected model (agy: its group; others: the account's). */
export function effectiveQuota(u: AccountUsage | undefined, model: string | null | undefined): { fiveHour: QuotaWindow | null; sevenDay: QuotaWindow | null; group: QuotaGroup | null } {
  const q = u?.quota
  if (!q) return { fiveHour: null, sevenDay: null, group: null }
  const g = groupFor(q.groups, model)
  return g ? { fiveHour: g.fiveHour, sevenDay: g.sevenDay, group: g } : { fiveHour: q.fiveHour, sevenDay: q.sevenDay, group: null }
}

export type QuotaLevel = 'ok' | 'warn' | 'danger'

export function quotaLevel(p: ProfileState | undefined, u: AccountUsage | undefined, model?: string | null): { level: QuotaLevel; reason: string | null } {
  if (!p) return { level: 'ok', reason: null }
  if (!getProviderCapabilities(p.kind).supportsUsageQuota) return p.status === 'rate_limited' ? { level: 'danger', reason: t('usage.limited') } : { level: 'ok', reason: null }
  const q = u?.quota
  const eff = effectiveQuota(u, model ?? p.defaultModel)
  const limited = p.status === 'rate_limited' || (!!q?.limited && !eff.group && Date.now() - q.fetchedAt < 6 * 3600_000)
  if (limited) return { level: 'danger', reason: t('usage.limited') }
  const five = liveWindow(eff.fiveHour)
  const seven = liveWindow(eff.sevenDay)
  const max = Math.max(five?.percent ?? 0, seven?.percent ?? 0)
  const which = (seven?.percent ?? 0) >= (five?.percent ?? 0) ? '7d' : '5h'
  const reason = t('usage.used', { which, pct: Math.round(max) })
  if (max >= 95) return { level: 'danger', reason }
  if (max >= getSettings().quotaWarn) return { level: 'warn', reason }
  return { level: 'ok', reason: null }
}

/**
 * Best same-vendor account to switch to: ready, not rate limited, 7d < 95%; lowest 5h usage
 * first; accounts without quota data (e.g. API key) come after those with data.
 */
export function recommendSwitch(current: ProfileState, profiles: ProfileState[], snap: UsageSnapshot | null, model?: string | null): ProfileState | null {
  const cands = profiles
    .filter((p) => p.id !== current.id && p.kind === current.kind && isReady(p) && p.status !== 'rate_limited')
    .map((p) => {
      const u = snap?.accounts[p.id]
      const q = u?.quota
      // same model group as what the user is running now (agy), else the account's windows
      const eff = effectiveQuota(u, model ?? p.defaultModel)
      const fresh = q && Date.now() - q.fetchedAt < 6 * 3600_000
      if (fresh && q.limited && !eff.group) return null
      const seven = liveWindow(eff.sevenDay)
      if (seven && seven.percent >= 95) return null
      const five = liveWindow(eff.fiveHour)
      if (five && five.percent >= 100) return null
      return { p, hasData: !!q, five: five?.percent ?? 0 }
    })
    .filter((x): x is { p: ProfileState; hasData: boolean; five: number } => !!x)
  cands.sort((a, b) => Number(b.hasData) - Number(a.hasData) || a.five - b.five)
  return cands[0]?.p ?? null
}

// ---- formatting ----------------------------------------------------------------------------

export function fmtTokens(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(v >= 1e10 ? 0 : 1)}B`
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`
  if (v >= 1e3) return `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k`
  return String(Math.round(v))
}
export const fmtCost = (v: number) => (v >= 100 ? `$${v.toFixed(0)}` : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`)
const pad = (x: number) => String(x).padStart(2, '0')
/** 16:40 today, 明天 09:00, 11-24 09:00 later. */
export function fmtReset(ts: number): string {
  const d = new Date(ts)
  const day = new Date()
  day.setHours(0, 0, 0, 0)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (ts < day.getTime() + 86400_000) return hm
  if (ts < day.getTime() + 2 * 86400_000) return t('time.tomorrow', { time: hm })
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`
}
export const fmtAgo = fmtAgoI18n
/** All tokens that went through the model (uncached + cached + written + output). */
export const tokenSum = (t: { input: number; output: number; cacheRead: number; cacheWrite: number }) => t.input + t.output + t.cacheRead + t.cacheWrite

export const usageOf = (snap: UsageSnapshot | null, id: ProfileId): AccountUsage | undefined => snap?.accounts[id]

/** Highest quota use across the live 5h / 7d windows (null: account reports no quota). */
export function quotaUse(u: AccountUsage | undefined, model?: string | null): number | null {
  if (!u?.quota) return null
  const eff = effectiveQuota(u, model)
  return Math.max(liveWindow(eff.fiveHour)?.percent ?? 0, liveWindow(eff.sevenDay)?.percent ?? 0)
}

/**
 * Per vendor, the ready account with the most headroom (lowest quota use, not rate limited).
 * Only marked when the vendor has at least two ready accounts with quota data.
 */
export function idlestAccounts(profiles: ProfileState[], snap: UsageSnapshot | null): Set<ProfileId> {
  const out = new Set<ProfileId>()
  for (const kind of new Set(profiles.map((p) => p.kind))) {
    const cands = profiles
      .filter((p) => p.kind === kind && isReady(p) && p.status !== 'rate_limited')
      .map((p) => ({ p, use: quotaUse(snap?.accounts[p.id], p.defaultModel) }))
      .filter((x): x is { p: ProfileState; use: number } => x.use !== null)
    if (cands.length < 2) continue
    cands.sort((a, b) => a.use - b.use)
    out.add(cands[0].p.id)
  }
  return out
}

/** Reasonix reports cache misses as uncached input. */
export function cacheHitPercentage(usage: Usage): number | null {
  const input = (usage.input ?? 0) + (usage.cacheRead ?? 0)
  return input > 0 ? Math.round((usage.cacheRead ?? 0) / input * 100) : null
}
