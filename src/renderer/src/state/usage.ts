import { useSyncExternalStore } from 'react'
import type { AccountUsage, ProfileId, ProfileState, QuotaGroup, QuotaWindow, UsageSnapshot } from '@shared/types'
import { EFFORT_SUFFIX_RE, splitSpec } from '@shared/modelSpec'
import { isReady } from '../lib/ui'

/** Usage & quota snapshot pushed by the main process (src/main/usage.ts). */

let snap: UsageSnapshot | null = null
const listeners = new Set<() => void>()
const emit = (s: UsageSnapshot) => {
  snap = s
  listeners.forEach((l) => l())
}
void window.agentmux.usage.get().then(emit)
window.agentmux.usage.onChanged(emit)

export function useUsage(): UsageSnapshot | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => snap
  )
}

/** Engines page view (sidebar "今日 …" jumps straight to 'usage'). */
export type EnginesTab = 'accounts' | 'usage'
let enginesTab: EnginesTab = 'accounts'
const tabListeners = new Set<() => void>()
export const setEnginesTab = (t: EnginesTab) => {
  enginesTab = t
  tabListeners.forEach((l) => l())
}
export function useEnginesTab(): EnginesTab {
  return useSyncExternalStore(
    (cb) => {
      tabListeners.add(cb)
      return () => tabListeners.delete(cb)
    },
    () => enginesTab
  )
}

const PROBE_KEY = 'agentmux.usage.probe'
export const probeEnabled = () => localStorage.getItem(PROBE_KEY) === '1'
export const setProbeEnabled = (v: boolean) => localStorage.setItem(PROBE_KEY, v ? '1' : '0')

export async function refreshUsage(): Promise<void> {
  emit(await window.agentmux.usage.refresh(probeEnabled()))
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
  const q = u?.quota
  const eff = effectiveQuota(u, model ?? p.defaultModel)
  const limited = p.status === 'rate_limited' || (!!q?.limited && !eff.group && Date.now() - q.fetchedAt < 6 * 3600_000)
  if (limited) return { level: 'danger', reason: '已触发限流' }
  const five = liveWindow(eff.fiveHour)
  const seven = liveWindow(eff.sevenDay)
  const max = Math.max(five?.percent ?? 0, seven?.percent ?? 0)
  const which = (seven?.percent ?? 0) >= (five?.percent ?? 0) ? '7d' : '5h'
  if (max >= 95) return { level: 'danger', reason: `${which} 额度已用 ${Math.round(max)}%` }
  if (max >= 80) return { level: 'warn', reason: `${which} 额度已用 ${Math.round(max)}%` }
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
  if (ts < day.getTime() + 2 * 86400_000) return `明天 ${hm}`
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`
}
export function fmtAgo(ts: number): string {
  const s = (Date.now() - ts) / 1000
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  return `${Math.floor(s / 86400)} 天前`
}
/** All tokens that went through the model (uncached + cached + written + output). */
export const tokenSum = (t: { input: number; output: number; cacheRead: number; cacheWrite: number }) => t.input + t.output + t.cacheRead + t.cacheWrite

export const usageOf = (snap: UsageSnapshot | null, id: ProfileId): AccountUsage | undefined => snap?.accounts[id]
