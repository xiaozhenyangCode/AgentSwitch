import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { AccountUsage, BankedResets, ModelPrice, PriceRate, ProfileId, ProfileKind, ProfileState, QuotaGroup, QuotaWindow, RequestLogPage, UsageTotals } from '@shared/types'
import { canUseSubscriptionQuota } from '@shared/providerCapabilities'
import { useLayer } from '../lib/escStack'
import { KIND_META, accountBadge, btnPrimary, btnSecondary, inputCls } from '../lib/ui'
import { useApp } from '../state/AppContext'
import { currentLocale, t, tNode } from '../state/i18n'
import { getSettings, useSettings } from '../state/settings'
import {
  effectiveQuota,
  fmtAgo,
  fmtCost,
  fmtReset,
  fmtTokens,
  idlestAccounts,
  liveWindow,
  quotaCardProfiles,
  quotaLevel,
  recommendSwitch,
  refreshUsage,
  setModelPrice,
  syncPrices,
  tokenSum,
  useUsage
} from '../state/usage'
import { KindAvatar, Modal, ProfileAvatar } from './common'
import { IconChevronDown, IconEdit, IconPlus, IconRefresh, Spinner } from './icons'
import { RequestLogView } from './RequestLogView'

const STALE = 6 * 3600_000
const CARD = 'rounded-xl border border-black/[0.07] bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.03)]'
const PRICE_TOOL_BUTTON = 'inline-flex h-7 items-center gap-1 rounded-lg bg-fill px-2.5 text-[12px] font-medium text-ink-2 hover:bg-fill-hover hover:text-ink disabled:opacity-60'
const STICKY_HEAD = 'text-[11.5px] text-ink-3 [&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-surface-2 [&_th]:shadow-[inset_0_-1px_var(--hairline)]'

/**
 * Fill in the brand's official colors; the gradient spans the whole track (background-size), so
 * a short bar shows its start and a full one the whole ramp. Amber from the warning threshold
 * (设置 › 用量与刷新) and coral ≥95% still win.
 */
const fillStyle = (kind: ProfileKind, pct: number, width: number): CSSProperties => ({
  width: `${width}%`,
  background: pct >= 95 ? 'var(--red)' : pct >= getSettings().quotaWarn ? 'var(--orange)' : KIND_META[kind].bar,
  backgroundSize: `${10000 / Math.max(width, 1)}% 100%`
})
const pctOf = (w: QuotaWindow) => Math.min(100, Math.max(0, w.percent))

const pad2 = (x: number) => String(x).padStart(2, '0')
/** Compact reset label: 20:00 today · 明天 09:00 · 11-25 beyond. */
function fmtResetShort(ts: number): string {
  const d = new Date(ts)
  const day = new Date()
  day.setHours(0, 0, 0, 0)
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  if (ts < day.getTime() + 86400_000) return hm
  if (ts < day.getTime() + 2 * 86400_000) return t('time.tomorrow', { time: hm })
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** Re-render every `ms` (relative times such as "3 分钟前更新"). */
function useTick(ms: number) {
  const [, setN] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setN((n) => n + 1), ms)
    return () => clearInterval(id)
  }, [ms])
}

/** One quota window: label / % on top, h-1.5 bar, reset time below. A rounded 0% draws no fill. */
export function QuotaMeter({ kind, label, w, stale, title }: { kind: ProfileKind; label: string; w: QuotaWindow | null; stale: boolean; title?: string }) {
  const { quotaWarn } = useSettings()
  const pct = w ? pctOf(w) : 0
  const shown = Math.round(pct)
  return (
    <div className="min-w-0" title={title}>
      <div className="flex items-baseline justify-between text-[11.5px] leading-4">
        <span className="text-ink-3">{label}</span>
        <span className={`tabular-nums ${!w ? 'text-ink-3' : pct >= quotaWarn ? 'font-semibold text-ink' : 'font-medium text-ink-2'}`}>{w ? `${shown}%` : '—'}</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-black/[0.06]">
        {w && shown > 0 && <div className={`h-full rounded-full transition-[width] duration-500 ${stale ? 'opacity-45' : ''}`} style={fillStyle(kind, pct, Math.max(pct, 3))} />}
      </div>
      <div className="mt-1 text-[11px] leading-4 text-ink-3/80 tabular-nums">
        {w ? (w.resetsAt ? t('usage.resets', { time: fmtResetShort(w.resetsAt) }) : t('usage.rolling')) : t('usage.noWindow')}
      </div>
    </div>
  )
}

const MAX_GROUP_LABEL_LEN = 16

/** Compact label for a quota pool segmented control tab. */
export function formatQuotaGroupLabel(group: Pick<QuotaGroup, 'key' | 'name'>): string {
  const key = group.key.trim().toLowerCase()
  const name = group.name.trim()
  if (key === 'gemini' || /^gemini\s+models?$/i.test(name)) return 'Gemini'
  if (key === '3p' || /^claude\s+(?:and|&)\s+gpt(?:\s+models?)?$/i.test(name)) return 'Claude & GPT'
  const compact = (name || group.key.trim())
    .replace(/\s+models?$/i, '')
    .replace(/\s+and\s+/gi, ' & ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!compact) return group.key
  return compact.length > MAX_GROUP_LABEL_LEN ? `${compact.slice(0, MAX_GROUP_LABEL_LEN - 1).trimEnd()}…` : compact
}

export type QuotaGroupAlert = 'danger' | 'warn' | null

/** Alert dot level for a quota pool: red if rate-limited or >=100%, orange if >=80%, else null. */
export function quotaGroupAlertLevel(
  group: Pick<QuotaGroup, 'fiveHour' | 'sevenDay'>,
  opts?: { limited?: boolean; warnThreshold?: number }
): QuotaGroupAlert {
  const five = liveWindow(group.fiveHour)
  const seven = liveWindow(group.sevenDay)
  const maxPct = Math.max(five ? pctOf(five) : 0, seven ? pctOf(seven) : 0)
  if (opts?.limited || maxPct >= 100) return 'danger'
  if (maxPct >= (opts?.warnThreshold ?? 80)) return 'warn'
  return null
}

/** Resolve which quota pool should be active for a card (selected if still valid, else active model's pool). */
export function resolveActiveQuotaGroup(
  groups: QuotaGroup[] | undefined,
  selectedKey: string | null | undefined,
  defaultGroup: QuotaGroup | null | undefined
): QuotaGroup | null {
  if (!groups?.length) return null
  if (selectedKey) {
    const matched = groups.find((g) => g.key === selectedKey)
    if (matched) return matched
  }
  return defaultGroup ?? groups[0]
}

/** Hover tooltip text for a quota pool segment: full name, included models, and 5h / 7d summary. */
export function formatQuotaGroupTooltip(
  group: QuotaGroup,
  opts?: { isDefault?: boolean; limited?: boolean }
): string {
  const five = liveWindow(group.fiveHour)
  const seven = liveWindow(group.sevenDay)
  const fiveText = five ? `${Math.round(pctOf(five))}%` : '—'
  const sevenText = seven ? `${Math.round(pctOf(seven))}%` : '—'
  const isLimited = !!opts?.limited || (five ? pctOf(five) >= 100 : false) || (seven ? pctOf(seven) >= 100 : false)
  const title = (group.name.trim() || group.key) + (opts?.isDefault ? ` (${t('usage.currentModel')})` : '')
  const modelsLine = group.models.length ? group.models.join(' · ') : ''
  const usageLine = `5h ${fiveText} · 7d ${sevenText}${isLimited ? t('usage.limitedSuffix') : ''}`
  return [title, modelsLine, usageLine].filter(Boolean).join('\n')
}

/** Compact macOS-style segmented control for switching an account's quota pools inline. */
function QuotaGroupSegmentedControl({
  groups,
  activeKey,
  defaultKey,
  accountRateLimited,
  onSelect
}: {
  groups: QuotaGroup[]
  activeKey: string
  defaultKey: string | null
  accountRateLimited: boolean
  onSelect: (key: string) => void
}) {
  if (groups.length <= 1) return null
  const dense = groups.length > 3
  return (
    <div
      role="tablist"
      aria-label={t('usage.quotaGroupSwitch')}
      className="inline-flex max-w-full items-center gap-0.5 overflow-x-auto overflow-y-hidden rounded-[7px] bg-black/[0.055] p-0.5 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.04)] [scrollbar-width:none] dark:bg-canvas dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] [&::-webkit-scrollbar]:hidden"
    >
      {groups.map((g) => {
        const selected = g.key === activeKey
        const isDefault = g.key === defaultKey
        const groupLimited = accountRateLimited && isDefault
        const alert = !selected ? quotaGroupAlertLevel(g, { limited: groupLimited }) : null
        const label = formatQuotaGroupLabel(g)
        return (
          <button
            key={g.key}
            type="button"
            role="tab"
            aria-selected={selected}
            title={formatQuotaGroupTooltip(g, { isDefault, limited: groupLimited })}
            onClick={() => onSelect(g.key)}
            className={`inline-flex h-5 shrink-0 items-center gap-1 rounded-[5px] text-[11px] leading-none whitespace-nowrap transition-all ${
              dense ? 'px-1.5' : 'px-2'
            } ${
              selected
                ? 'bg-surface font-medium text-ink shadow-[0_1px_2px_rgba(0,0,0,0.08),0_0_0_0.5px_rgba(0,0,0,0.06)] dark:bg-fill-hover dark:shadow-[0_1px_2px_rgba(0,0,0,0.35),0_0_0_0.5px_rgba(255,255,255,0.12)]'
                : 'text-ink-2 hover:text-ink'
            }`}
          >
            <span>{label}</span>
            {alert && (
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${alert === 'danger' ? 'bg-red' : 'bg-orange'}`}
              />
            )}
          </button>
        )
      })}
    </div>
  )
}

/** "今日 61M · $0.186" (cost only when the CLI reported one). */
const todayBrief = (u: AccountUsage | undefined) => {
  const tt = u?.today
  if (!tt) return t('usage.today', { n: 0 })
  return t('usage.today', { n: fmtTokens(tokenSum(tt)) }) + (tt.costUsd > 0 ? ` · ${fmtCost(tt.costUsd)}` : '')
}

/** The two fixed-width quota cells of an account row (5h | 7d); one spanning note when there is no data. */
function AccountQuotaCells({ kind, u, model, group }: { kind: ProfileKind; u: AccountUsage | undefined; model?: string | null; group?: QuotaGroup | null }) {
  const q = u?.quota
  if (!q) return <div className="col-span-2 text-right text-[11.5px] text-ink-3/80">{t('usage.noQuota')}</div>
  const eff = effectiveQuota(u, model)
  const fiveRaw = group ? group.fiveHour : eff.fiveHour
  const sevenRaw = group ? group.sevenDay : eff.sevenDay
  const five = fiveRaw ? liveWindow(fiveRaw) : null
  const seven = sevenRaw ? liveWindow(sevenRaw) : null
  const stale = Date.now() - q.fetchedAt > STALE
  const groupLimited = group ? (five ? pctOf(five) >= 100 : false) || (seven ? pctOf(seven) >= 100 : false) : q.limited
  const tip = t('usage.quotaAge', { ago: fmtAgo(q.fetchedAt) }) + (groupLimited && !stale ? t('usage.limitedSuffix') : '')
  return (
    <>
      <QuotaMeter kind={kind} label="5h" w={five} stale={stale} title={tip} />
      <QuotaMeter kind={kind} label="7d" w={seven} stale={stale} title={tip} />
    </>
  )
}

/** "3 分钟前更新" + 刷新用量. The Claude probe is a setting (设置 › 用量与刷新). */
export function RefreshUsage({ onRefreshed }: { onRefreshed?: () => void }) {
  const [busy, setBusy] = useState(false)
  const { probeClaude } = useSettings()
  const snap = useUsage()
  useTick(30_000)
  const run = async () => {
    setBusy(true)
    try {
      await refreshUsage()
      onRefreshed?.()
    } finally {
      setBusy(false)
    }
  }
  const backfill = snap?.backfill === 'running'
  return (
    <div className="flex items-center gap-3">
      {snap?.updatedAt && (
        <span className="text-[12px] text-ink-3 tabular-nums" title={new Date(snap.updatedAt).toLocaleString()}>
          {backfill ? t('usage.backfilling') : t('usage.updatedAgo', { ago: fmtAgo(snap.updatedAt) })}
        </span>
      )}
      <button
        onClick={() => void run()}
        disabled={busy}
        title={probeClaude ? t('usage.refreshHintProbe') : t('usage.refreshHint')}
        className="flex h-7 items-center gap-1.5 rounded-lg border border-black/[0.09] bg-surface px-2.5 text-[12.5px] font-medium text-ink shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-colors hover:bg-black/[0.035] active:bg-black/[0.06] disabled:opacity-60"
      >
        {busy || backfill ? <Spinner size={12} /> : <IconRefresh size={13} />}
        {busy ? t('usage.refreshing') : t('usage.refresh')}
        {probeClaude && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
      </button>
    </div>
  )
}

const sumOf = (accounts: AccountUsage[], pick: (u: AccountUsage) => number) => accounts.reduce((a, u) => a + pick(u), 0)

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className={`${CARD} px-4 py-3.5`}>
      <div className="text-[12px] text-ink-3">{label}</div>
      <div className="mt-1 text-[24px] leading-8 font-semibold tracking-tight text-ink tabular-nums">{value}</div>
      {sub && <div className="text-[11.5px] text-ink-3 tabular-nums">{sub}</div>}
    </div>
  )
}

const SectionTitle = ({ children }: { children: string }) => <h2 className="mt-8 mb-3 px-1 text-[13px] font-semibold text-ink-2">{children}</h2>

export function getLiveBankedResets(bankedResets: BankedResets | null | undefined, now = Date.now()): BankedResets | null {
  if (!bankedResets) return null
  if (!bankedResets.items.length) return bankedResets.remainingCount > 0 ? bankedResets : null
  const items = bankedResets.items.filter((item) => item.expiresAt > now).sort((a, b) => a.expiresAt - b.expiresAt)
  const remainingCount = items.reduce((count, item) => count + item.count, 0)
  return remainingCount > 0 ? { items, remainingCount } : null
}

export function formatBankedResetDate(ts: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(ts)
}

export function formatBankedResetCountdown(expiresAt: number, now = Date.now()): string {
  const hours = Math.floor((expiresAt - now) / 3_600_000)
  if (hours < 1) return t('usage.resetInLessThanHour')
  if (hours < 24) return t('usage.resetInHours', { h: hours })
  const d = Math.floor(hours / 24)
  const h = hours % 24
  return h ? t('usage.resetInDaysHours', { d, h }) : t('usage.resetInDays', { d })
}

function BankedResetsPopover({ resets, now }: { resets: BankedResets; now: number }) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<CSSProperties>({})
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const id = useId()
  const close = useCallback(() => setOpen(false), [])
  useLayer({ onEsc: close, onClose: close, active: open })

  useLayoutEffect(() => {
    if (!open || !trigger.current || !panel.current) return
    const anchor = trigger.current.getBoundingClientRect()
    const below = window.innerHeight - anchor.bottom - 14
    const above = anchor.top - 14
    const flip = panel.current.scrollHeight > below && above > below
    setPosition({
      right: Math.max(8, window.innerWidth - anchor.right),
      ...(flip ? { bottom: window.innerHeight - anchor.top + 6 } : { top: anchor.bottom + 6 }),
      maxHeight: Math.max(0, flip ? above : below)
    })
  }, [open, resets.items.length])

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !panel.current?.contains(event.target)) close()
    }
    const scroll = (event: Event) => {
      if (event.target instanceof Node && panel.current?.contains(event.target)) return
      close()
    }
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', scroll, true)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', scroll, true)
    }
  }, [open, close])

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-ok-soft px-2 text-[11px] font-medium whitespace-nowrap text-ok ring-1 ring-ok/20 ring-inset hover:bg-ok-soft/80"
        onClick={() => setOpen(!open)}
      >
        <span>{tNode('usage.bankedResetsPill', { n: <span className="font-semibold tabular-nums">{resets.remainingCount}</span> })}</span>
        <IconChevronDown size={12} className={open ? 'rotate-180' : undefined} />
      </button>
      {open && createPortal(
        <div
          id={id}
          ref={panel}
          role="region"
          aria-labelledby={`${id}-title`}
          className="fixed z-[70] w-[288px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl border border-editor-hairline bg-elevated px-3 py-2.5 text-[12px] shadow-[0_12px_32px_rgba(0,0,0,0.16)]"
          style={position}
        >
          <div className="flex items-baseline justify-between gap-2">
            <span id={`${id}-title`} className="font-semibold text-ink">{t('usage.bankedResetsTitle')}</span>
            <span className="shrink-0 font-semibold text-ok tabular-nums">{t('usage.bankedResetsRemaining', { n: resets.remainingCount })}</span>
          </div>
          {resets.items.length > 0 && (
            <ul className="mt-1.5 divide-y divide-black/[0.06] dark:divide-white/[0.08]">
              {resets.items.map((item, i) => (
                <li key={`${item.expiresAt}-${i}`} className="flex items-baseline justify-between gap-2 py-1.5 tabular-nums">
                  <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                    <span className="text-ink-2">{formatBankedResetDate(item.expiresAt, currentLocale())}</span>
                    <span className="text-[11px] text-ink-3">{formatBankedResetCountdown(item.expiresAt, now)}</span>
                  </span>
                  <span className="shrink-0 text-ink-2">{t('usage.bankedResetsCount', { n: item.count })}</span>
                </li>
              ))}
            </ul>
          )}
        </div>,
        document.body
      )}
    </>
  )
}

/** One account in the quota grid: 5h / 7d bars (or local stats when the CLI reports no quota). */
function QuotaCard({ p, idlest }: { p: ProfileState; idlest: boolean }) {
  const { openLogin } = useApp()
  const snap = useUsage()
  const u = snap?.accounts[p.id]
  const [, tick] = useState(0)
  const now = Date.now()
  const liveBanked = p.kind === 'codex' ? getLiveBankedResets(u?.quota?.bankedResets, now) : null
  const nextExpiry = liveBanked?.items[0]?.expiresAt
  useEffect(() => {
    if (nextExpiry === undefined) return
    const timer = window.setTimeout(() => tick((n) => n + 1), Math.max(0, Math.min(nextExpiry - Date.now(), 60_000)))
    return () => window.clearTimeout(timer)
  }, [nextExpiry, now])
  const groups = u?.quota?.groups
  const eff = effectiveQuota(u, p.defaultModel)
  const [selectedGroupKey, setSelectedGroupKey] = useState<string | null>(null)
  useEffect(() => {
    setSelectedGroupKey(null)
  }, [p.defaultModel])
  const activeGroup = resolveActiveQuotaGroup(groups, selectedGroupKey, eff.group)
  const hasGroupSwitcher = !!(groups && groups.length > 1 && activeGroup)
  const level = quotaLevel(p, u)
  const authExpired = u?.quotaErrorKind === 'auth_expired'
  const isErrorRateLimited = u?.quotaErrorKind === 'rate_limited'
  const isRateLimited = p.status === 'rate_limited' || isErrorRateLimited
  const limited = isRateLimited || level.level === 'danger'
  const notReadyBadge = p.status === 'uninstalled' || p.status === 'not_logged_in' ? accountBadge(p) : null
  const resetAt = u?.quotaErrorResetAt && u.quotaErrorResetAt > Date.now() ? u.quotaErrorResetAt : null
  const resetHint = resetAt ? t('usage.retryAfter', { time: fmtReset(resetAt) }) : null
  const errText = authExpired ? null : [resetHint, u?.quotaError].filter(Boolean).join(' · ') || (p.status === 'rate_limited' ? t('usage.limited') : null)
  const errTone = isRateLimited ? 'bg-danger-soft/80 text-danger' : 'bg-warn-soft/70 text-warn'
  const limitedLabel =
    p.status === 'rate_limited'
      ? t('status.rateLimited')
      : isErrorRateLimited
        ? t('usage.refreshLimited')
        : (level.reason ?? t('status.rateLimited'))
  return (
    <div className={`${CARD} px-4 py-3.5`}>
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <div className="mt-0.5 shrink-0"><ProfileAvatar profile={p} size={22} /></div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2 whitespace-nowrap">
              <span className="truncate text-[13.5px] font-semibold text-ink">{p.name}</span>
              {idlest && !authExpired && (
                <span className="shrink-0 rounded-md bg-ok-soft px-1.5 py-px text-[11px] font-medium text-ok" title={t('usage.idlestHint')}>
                  {t('usage.idlest')}
                </span>
              )}
              {authExpired ? null : notReadyBadge ? (
                <span className={`shrink-0 rounded-md px-1.5 py-px text-[11px] font-medium ${notReadyBadge.cls}`}>{notReadyBadge.label}</span>
              ) : limited ? (
                <span className="shrink-0 rounded-md bg-danger-soft px-1.5 py-px text-[11px] font-medium text-danger">{limitedLabel}</span>
              ) : null}
            </div>
            {(u?.planType || u?.email) && (
              <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                {u.planType && (
                  <span className="max-w-full shrink-0 truncate rounded bg-fill px-1.5 py-[1px] text-[10.5px] leading-4 font-medium text-ink-2 ring-1 ring-black/[0.06] ring-inset dark:ring-white/[0.08]" title={u.planType}>
                    {u.planType}
                  </span>
                )}
                {u.email && <span className="min-w-0 truncate text-[11.5px] leading-4 text-ink-3" title={u.email}>{u.email}</span>}
              </div>
            )}
          </div>
        </div>
        {(hasGroupSwitcher || authExpired || liveBanked) && (
          <div className={`flex min-w-0 shrink-0 items-center gap-1.5 ${groups && groups.length > 3 ? 'max-w-[58%]' : 'max-w-[65%]'}`}>
            {hasGroupSwitcher && (
              <QuotaGroupSegmentedControl
                groups={groups!}
                activeKey={activeGroup!.key}
                defaultKey={eff.group?.key ?? null}
                accountRateLimited={isRateLimited}
                onSelect={setSelectedGroupKey}
              />
            )}
            {liveBanked && <BankedResetsPopover resets={liveBanked} now={now} />}
            {authExpired && (
              <span className="shrink-0 rounded-md bg-warn-soft px-1.5 py-px text-[11px] font-medium text-warn">{t('usage.authExpiredBadge')}</span>
            )}
          </div>
        )}
      </div>
      {u?.quota ? (
        <>
          <div className="mt-3 grid grid-cols-2 gap-5">
            <AccountQuotaCells kind={p.kind} u={u} model={p.defaultModel} group={activeGroup} />
          </div>
          <div className="mt-2 text-[11px] text-ink-3 tabular-nums">
            {todayBrief(u)} · {t('usage.quotaAge', { ago: fmtAgo(u.quota.fetchedAt) })}
            {authExpired && <> · {t('usage.localWeek')} {fmtTokens(tokenSum(u.week))}{u.week.costUsd > 0 && ` · ${fmtCost(u.week.costUsd)}`}</>}
          </div>
          {errText && (
            <div className={`mt-1.5 truncate rounded-md px-2 py-1 text-[11px] select-text ${errTone}`} title={errText}>
              {errText}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-2 gap-5 text-[12px] tabular-nums">
            <div>
              <div className="text-ink-3">{t('usage.localToday')}</div>
              <div className="mt-0.5 flex items-baseline gap-1.5">
                <span className="text-[15px] font-semibold text-ink">{fmtTokens(u ? tokenSum(u.today) : 0)}</span>
                {u && u.today.costUsd > 0 && <span className="text-[11.5px] text-ink-3">{fmtCost(u.today.costUsd)}</span>}
              </div>
            </div>
            <div>
              <div className="text-ink-3">{t('usage.localWeek')}</div>
              <div className="mt-0.5 flex items-baseline gap-1.5">
                <span className="text-[15px] font-semibold text-ink">{fmtTokens(u ? tokenSum(u.week) : 0)}</span>
                {u && u.week.costUsd > 0 && <span className="text-[11.5px] text-ink-3">{fmtCost(u.week.costUsd)}</span>}
              </div>
            </div>
          </div>
          {authExpired ? null : errText ? (
            <div className={`mt-2 rounded-lg px-2.5 py-1.5 text-[11.5px] leading-[17px] break-words select-text ${errTone}`}>
              {errText}
            </div>
          ) : (
            <div className="mt-2 text-[11px] text-ink-3">{t(canUseSubscriptionQuota(p.kind, !!p.apiKey) ? 'usage.noQuotaNote' : 'apikey.noQuota')}</div>
          )}
        </>
      )}
      {authExpired && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md bg-warn-soft px-2 py-1 text-[11px] text-warn" title={u?.quotaError ?? undefined}>
          <span>{t('usage.authExpiredMsg')}</span>
          {canUseSubscriptionQuota(p.kind, !!p.apiKey) && (
            <button type="button" className="font-semibold underline underline-offset-2" onClick={() => openLogin(p.id)}>
              {t('usage.reauth')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

type Period = 'today' | '7d' | '30d' | 'all'
const PERIODS: Period[] = ['today', '7d', '30d', 'all']
let lastPeriod: Period = 'today'

/** First day (YYYY-MM-DD, local) of a period; null: everything. */
function periodFrom(p: Period): string | null {
  if (p === 'all') return null
  const d = new Date()
  d.setDate(d.getDate() - (p === 'today' ? 0 : p === '7d' ? 6 : 29))
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const emptyTotals = (): UsageTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0, runs: 0, unpriced: 0 })
function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning,
    costUsd: a.costUsd + b.costUsd,
    runs: a.runs + b.runs,
    unpriced: (a.unpriced ?? 0) + (b.unpriced ?? 0)
  }
}
/** Share of the prompt served from cache. */
const cacheHit = (u: UsageTotals): number | null => {
  const prompt = u.input + u.cacheRead + u.cacheWrite
  return prompt > 0 ? u.cacheRead / prompt : null
}
const fmtPct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`)
const fmtRate = (v: number | undefined) => (v === undefined ? '—' : String(Math.round(v * 1e4) / 1e4))

const isUnidentifiedModel = (m: string): boolean => !m.trim() || m.startsWith('?') || /^unknown$/i.test(m.trim())

/** `?claude`: tokens recorded before models were (see main/usage.ts UNRECORDED). */
const modelLabel = (m: string): string =>
  m.startsWith('?')
    ? t('usage.priceUnrecorded', { kind: KIND_META[m.slice(1) as ProfileKind]?.name ?? '' }).trim()
    : !m.trim() || /^unknown$/i.test(m.trim())
      ? t('usage.priceUnknownModel')
      : m

function SourceBadge({ price }: { price: ModelPrice | undefined }) {
  const cls = 'shrink-0 whitespace-nowrap rounded px-1.5 py-px text-[10.5px]'
  if (!price?.source) return <span className={`${cls} bg-[var(--orange)]/15 font-medium text-[var(--orange)]`}>{t('usage.priceNone')}</span>
  if (price.source === 'custom')
    return <span className={`${cls} bg-accent/15 font-medium text-accent`}>{t('usage.priceCustom')}</span>
  if (price.source === 'estimate')
    return (
      <span className={`${cls} bg-fill text-ink-3`} title={t('usage.priceEstimateTip')}>
        {t('usage.priceEstimate')}
      </span>
    )
  return <span className={`${cls} bg-fill text-ink-3`}>{{ litellm: 'LiteLLM', modelsdev: 'models.dev', openrouter: 'OpenRouter', ccswitch: 'CC Switch' }[price.source]}</span>
}

interface PriceEditTarget {
  model: string
  editableModel: boolean
  current: PriceRate | null
  defaultRate: PriceRate | null
  isCustom: boolean
}

function CustomPriceModal({ target, onClose }: { target: PriceEditTarget; onClose: () => void }) {
  const { toast } = useApp()
  const base = target.current ?? target.defaultRate
  const [modelName, setModelName] = useState(target.model)
  const [inputVal, setInputVal] = useState(base ? String(base.input) : '')
  const [outputVal, setOutputVal] = useState(base ? String(base.output) : '')
  const [cacheReadVal, setCacheReadVal] = useState(base?.cacheRead !== undefined ? String(base.cacheRead) : '')
  const [cacheWriteVal, setCacheWriteVal] = useState(base?.cacheWrite !== undefined ? String(base.cacheWrite) : '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const parseNum = (raw: string, optional: boolean): number | undefined | null => {
    const s = raw.trim()
    if (!s) return optional ? undefined : null
    const v = Number(s)
    return Number.isFinite(v) && v >= 0 ? v : null
  }

  const save = async () => {
    const key = modelName.trim()
    if (!key) return setErr(t('usage.priceErrModel'))
    const input = parseNum(inputVal, false)
    const output = parseNum(outputVal, false)
    const cacheRead = parseNum(cacheReadVal, true)
    const cacheWrite = parseNum(cacheWriteVal, true)
    if (input === null || input === undefined || output === null || output === undefined || cacheRead === null || cacheWrite === null) {
      return setErr(t('usage.priceErrNumber'))
    }
    setErr(null)
    setSaving(true)
    try {
      const rate: PriceRate = {
        input,
        output,
        ...(cacheRead !== undefined ? { cacheRead } : {}),
        ...(cacheWrite !== undefined ? { cacheWrite } : {})
      }
      await setModelPrice(key, rate)
      toast({ kind: 'success', title: t('usage.priceSaved') })
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const reset = async () => {
    const key = (target.model || modelName).trim()
    if (!key) return
    setSaving(true)
    try {
      await setModelPrice(key, null)
      toast({ kind: 'success', title: t('usage.priceResetDone') })
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const def = target.defaultRate
  return (
    <Modal onClose={onClose} width={460}>
      <div className="p-6" role="dialog" aria-modal="true">
        <div className="text-[17px] font-semibold text-ink">{t('usage.priceEditTitle')}</div>
        <div className="mt-1 text-[12.5px] text-ink-3">{t('usage.priceUnitHint')}</div>

        <div className="mt-4 space-y-3">
          <div>
            <label className="mb-1 block text-[12px] font-medium text-ink-2">{t('usage.priceModel')}</label>
            {target.editableModel ? (
              <input
                autoFocus
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
                placeholder="e.g. claude-opus-5-5"
                className={inputCls + ' w-full font-mono text-[13px]'}
              />
            ) : (
              <div className="rounded-lg bg-fill px-3 py-2 font-mono text-[13px] text-ink">{target.model}</div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-[12px] font-medium text-ink-2">{t('usage.priceInput')}</label>
              <input
                type="number"
                min="0"
                step="any"
                value={inputVal}
                onChange={(e) => setInputVal(e.target.value)}
                placeholder={def ? String(def.input) : '0'}
                className={inputCls + ' w-full font-mono text-[13px] tabular-nums'}
              />
            </div>
            <div>
              <label className="mb-1 block text-[12px] font-medium text-ink-2">{t('usage.priceOutput')}</label>
              <input
                type="number"
                min="0"
                step="any"
                value={outputVal}
                onChange={(e) => setOutputVal(e.target.value)}
                placeholder={def ? String(def.output) : '0'}
                className={inputCls + ' w-full font-mono text-[13px] tabular-nums'}
              />
            </div>
            <div>
              <label className="mb-1 block text-[12px] font-medium text-ink-2">{t('usage.priceCacheRead')}</label>
              <input
                type="number"
                min="0"
                step="any"
                value={cacheReadVal}
                onChange={(e) => setCacheReadVal(e.target.value)}
                placeholder={def ? fmtRate(def.cacheRead ?? def.input) : t('usage.priceFollowInput')}
                className={inputCls + ' w-full font-mono text-[13px] tabular-nums'}
              />
            </div>
            <div>
              <label className="mb-1 block text-[12px] font-medium text-ink-2">{t('usage.priceCacheWrite')}</label>
              <input
                type="number"
                min="0"
                step="any"
                value={cacheWriteVal}
                onChange={(e) => setCacheWriteVal(e.target.value)}
                placeholder={def ? fmtRate(def.cacheWrite ?? def.input) : t('usage.priceFollowInput')}
                className={inputCls + ' w-full font-mono text-[13px] tabular-nums'}
              />
            </div>
          </div>

          {def && (
            <div className="rounded-lg bg-fill/70 px-3 py-2 text-[11.5px] text-ink-3 tabular-nums">
              {t('usage.priceDefaultRef', {
                input: fmtRate(def.input),
                output: fmtRate(def.output),
                cacheRead: fmtRate(def.cacheRead ?? def.input),
                cacheWrite: fmtRate(def.cacheWrite ?? def.input)
              })}
            </div>
          )}

          {err && <div className="rounded-lg bg-danger-soft px-3 py-2 text-[12px] text-danger">{err}</div>}
        </div>

        <div className="mt-5 flex items-center gap-2">
          {target.isCustom && (
            <button type="button" disabled={saving} onClick={() => void reset()} className={btnSecondary + ' mr-auto text-danger hover:text-danger'}>
              {t('usage.priceReset')}
            </button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button type="button" disabled={saving} onClick={onClose} className={btnSecondary}>
              {t('common.cancel')}
            </button>
            <button type="button" disabled={saving} onClick={() => void save()} className={btnPrimary}>
              {saving ? <Spinner size={13} /> : t('common.save')}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

/** Per-model breakdown of the period, at the price each model is billed at (USD / 1M tokens). */
function ModelTable({
  rows,
  models,
  customPrices,
  syncedAt,
  footnote
}: {
  rows: [string, UsageTotals][]
  models: Record<string, ModelPrice>
  customPrices: Record<string, PriceRate>
  syncedAt: number | null
  footnote: string
}) {
  const { toast } = useApp()
  const [editing, setEditing] = useState<PriceEditTarget | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [, setClock] = useState(0)
  useEffect(() => {
    if (syncedAt === null) return
    const timer = setInterval(() => setClock(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [syncedAt])

  const sync = async () => {
    setSyncing(true)
    try {
      await syncPrices()
    } catch {
      // Keep showing the current prices if the renderer loses its IPC connection.
    } finally {
      setSyncing(false)
    }
  }
  const th = 'px-3 py-2 text-right font-medium whitespace-nowrap'
  const td = 'px-3 py-2.5 text-right whitespace-nowrap tabular-nums'

  // Include any custom-priced model not present in the current period so users can always edit/reset it.
  const seen = new Set(rows.map(([m]) => m.toLowerCase()))
  const extraCustom = Object.entries(customPrices)
    .filter(([k]) => !seen.has(k.toLowerCase()))
    .map(([k]): [string, UsageTotals] => [k, emptyTotals()])
  const allRows = [...rows, ...extraCustom]

  const openEdit = (model: string, p: ModelPrice | undefined) => {
    const key = model.toLowerCase()
    const customKey = p?.source === 'custom' && p.key ? p.key : customPrices[key] ? key : model
    const isCustom = p?.source === 'custom' || !!customPrices[key]
    setEditing({
      model: isCustom ? customKey : model,
      editableModel: false,
      current: p?.rate ?? customPrices[key] ?? null,
      defaultRate: isCustom ? (p?.defaultRate ?? null) : (p?.rate ?? null),
      isCustom
    })
  }

  const quickReset = async (model: string, p: ModelPrice | undefined) => {
    const key = p?.source === 'custom' && p.key ? p.key : model.toLowerCase()
    await setModelPrice(key, null)
    toast({ kind: 'success', title: t('usage.priceResetDone') })
  }

  return (
    <>
      <div className="mb-2.5 flex shrink-0 flex-wrap items-center justify-between gap-2">
        <div className="text-[12px] font-medium text-ink-3">{t('usage.modelSection')}</div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11.5px] text-ink-3" title={syncedAt === null ? undefined : new Date(syncedAt).toLocaleString()}>
            {syncedAt === null ? t('usage.priceBuiltin') : t('usage.priceUpdated', { time: fmtAgo(syncedAt) })}
          </span>
          <button type="button" className={PRICE_TOOL_BUTTON} onClick={() => void sync()} disabled={syncing} aria-busy={syncing}>
            {syncing ? <Spinner size={12} /> : <IconRefresh size={12} />} {t('usage.syncPrices')}
          </button>
          <button
            type="button"
            onClick={() => setEditing({ model: '', editableModel: true, current: null, defaultRate: null, isCustom: false })}
            className={PRICE_TOOL_BUTTON}
          >
            <IconPlus size={12} /> {t('usage.priceAddCustom')}
          </button>
        </div>
      </div>
      <div className={`min-h-0 flex-1 overflow-auto ${CARD}`}>
        <table className="w-full text-[13px]">
          <thead className={STICKY_HEAD}>
            <tr>
              <th className="min-w-[10rem] px-4 py-2 text-left font-medium">{t('usage.priceModel')}</th>
              <th className={th}>{t('usage.priceInput')}</th>
              <th className={th}>{t('usage.priceOutput')}</th>
              <th className={th}>{t('usage.priceCacheRead')}</th>
              <th className={th}>{t('usage.priceCacheWrite')}</th>
              <th className={th}>{t('usage.colTokens')}</th>
              <th className={th}>{t('usage.colCacheHit')}</th>
              <th className={th}>{t('usage.colCost')}</th>
              <th className={th + ' pr-4'}>{t('usage.priceActions')}</th>
            </tr>
          </thead>
          <tbody>
            {allRows.length ? (
              allRows.map(([model, u]) => {
                const key = model.toLowerCase()
                const p: ModelPrice | undefined =
                  models[model] ?? (customPrices[key] ? { key, source: 'custom', rate: customPrices[key] } : undefined)
                const r = p?.rate
                const isCustom = p?.source === 'custom' || !!customPrices[key]
                const canEdit = !isUnidentifiedModel(model)
                return (
                  <tr key={model} className="border-b border-black/[0.05] last:border-0">
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className={`wrap-anywhere text-[12px] text-ink ${canEdit ? 'font-mono' : ''}`}>{modelLabel(model)}</span>
                        <SourceBadge price={p} />
                      </div>
                      {p?.key && (p.source === 'estimate' || p.key !== key) && (
                        <div className="mt-0.5 font-mono text-[10.5px] wrap-anywhere text-ink-3">{t('usage.priceMatched', { key: p.key })}</div>
                      )}
                    </td>
                    <td className={`${td} ${isCustom ? 'font-medium text-accent' : 'text-ink-2'}`}>{fmtRate(r?.input)}</td>
                    <td className={`${td} ${isCustom ? 'font-medium text-accent' : 'text-ink-2'}`}>{fmtRate(r?.output)}</td>
                    <td className={`${td} ${isCustom ? 'font-medium text-accent' : 'text-ink-2'}`}>{fmtRate(r ? (r.cacheRead ?? r.input) : undefined)}</td>
                    <td className={`${td} ${isCustom ? 'font-medium text-accent' : 'text-ink-2'}`}>{fmtRate(r ? (r.cacheWrite ?? r.input) : undefined)}</td>
                    <td className={`${td} text-ink`}>{tokenSum(u) > 0 ? fmtTokens(tokenSum(u)) : '—'}</td>
                    <td className={`${td} text-ink-2`}>{fmtPct(cacheHit(u))}</td>
                    <td className={`${td} font-medium text-ink`}>{r && tokenSum(u) > 0 ? fmtCost(u.costUsd) : '—'}</td>
                    <td className="px-3 py-2.5 pr-4 text-right whitespace-nowrap">
                      {canEdit ? (
                        <div className="inline-flex items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => openEdit(model, p)}
                            className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11.5px] text-ink-3 transition-colors hover:bg-black/[0.06] hover:text-ink dark:hover:bg-white/[0.08]"
                            title={t('usage.priceEdit')}
                          >
                            <IconEdit size={12} /> {t('usage.priceEdit')}
                          </button>
                          {isCustom && (
                            <button
                              type="button"
                              onClick={() => void quickReset(model, p)}
                              className="inline-flex h-6 items-center rounded-md px-1.5 text-[11.5px] text-ink-3 transition-colors hover:bg-danger-soft hover:text-danger"
                              title={t('usage.priceReset')}
                            >
                              {t('usage.priceResetShort')}
                            </button>
                          )}
                        </div>
                      ) : (
                        <span
                          className="text-[11px] text-ink-3/80"
                          title={p?.source === 'estimate' ? t('usage.priceEstimateTip') : t('usage.priceUnknownActionTip')}
                        >
                          {p?.source === 'estimate' ? t('usage.priceAutoEstimated') : t('usage.priceUnknownAction')}
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })
            ) : (
              <tr>
                <td colSpan={9} className="px-4 py-5 text-[13px] text-ink-3">
                  {t('usage.periodEmpty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-2.5 shrink-0 px-1 text-[11.5px] leading-relaxed text-ink-3">{footnote}</p>
      {editing && <CustomPriceModal target={editing} onClose={() => setEditing(null)} />}
    </>
  )
}

type UsageTab = 'logs' | 'accounts' | 'models'
let lastUsageTab: UsageTab = 'logs'

/** 用量限额 page body: multi-tab view (Request Logs, Providers/Accounts, Models). */
export function UsageView({ onClose, refreshToken = 0 }: { onClose?: () => void; refreshToken?: number }) {
  const { profiles } = useApp()
  const snap = useUsage()
  const [tab, setTabState] = useState<UsageTab>(lastUsageTab)
  const [logTotal, setLogTotal] = useState<number>(0)
  const updateLogTotal = useCallback((counts: RequestLogPage['counts']) => setLogTotal(counts.total), [])
  const setTab = (next: UsageTab) => {
    lastUsageTab = next
    setTabState(next)
  }
  const [period, setPeriodState] = useState<Period>(lastPeriod)
  const setPeriod = (p: Period) => {
    lastPeriod = p
    setPeriodState(p)
  }

  // Keep the Request Logs tab badge synced even while viewing other tabs.
  useEffect(() => {
    let alive = true
    const fetchCount = () => {
      void window.agentswitch.usage.requestLogs({ limit: 1 }).then((page) => {
        if (alive) setLogTotal(page.counts.total)
      }).catch(() => {})
    }
    fetchCount()
    const unsub = window.agentswitch.usage.onRequestLogsChanged(fetchCount)
    return () => {
      alive = false
      unsub()
    }
  }, [refreshToken])

  const from = periodFrom(period)
  const rows = (snap?.daily ?? []).filter((d) => from === null || d.day >= from)
  const byAccount = new Map<ProfileId, UsageTotals>()
  const byModel = new Map<string, UsageTotals>()
  let total = emptyTotals()
  for (const d of rows) {
    total = addTotals(total, d)
    byAccount.set(d.profileId, addTotals(byAccount.get(d.profileId) ?? emptyTotals(), d))
    byModel.set(d.model, addTotals(byModel.get(d.model) ?? emptyTotals(), d))
  }
  const modelRows = [...byModel.entries()].filter(([m, u]) => m !== '<synthetic>' && tokenSum(u) > 0).sort((a, b) => b[1].costUsd - a[1].costUsd || tokenSum(b[1]) - tokenSum(a[1]))
  const customPrices = snap?.customPrices ?? {}
  const seenModels = new Set(modelRows.map(([m]) => m.toLowerCase()))
  const extraCustomCount = Object.keys(customPrices).filter((k) => !seenModels.has(k.toLowerCase())).length
  const modelCount = modelRows.length + extraCustomCount
  const cards = quotaCardProfiles(profiles)
  const idlest = idlestAccounts(profiles, snap)
  const num = 'px-4 py-3 text-right whitespace-nowrap tabular-nums'
  const unpriced = total.unpriced ?? 0

  const tabs: { id: UsageTab; label: string; count: number }[] = [
    { id: 'logs', label: t('reqLog.tab.logs'), count: logTotal },
    { id: 'accounts', label: t('reqLog.tab.accounts'), count: profiles.length },
    { id: 'models', label: t('reqLog.tab.models'), count: modelCount }
  ]

  const periodBar = (
    <div className="flex w-fit items-center gap-1 rounded-[10px] bg-fill p-0.5 text-[12.5px]">
      {PERIODS.map((p) => (
        <button
          key={p}
          className={`h-7 rounded-lg px-3 ${period === p ? 'bg-surface font-medium text-ink shadow-[0_1px_2px_rgba(0,0,0,0.08)]' : 'text-ink-2 hover:text-ink'}`}
          onClick={() => setPeriod(p)}
        >
          {t(`usage.period.${p}`)}
        </button>
      ))}
    </div>
  )

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div
        className="flex shrink-0 items-center gap-1 overflow-x-auto overflow-y-hidden border-b border-hairline px-8 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="tablist"
      >
        {tabs.map((item) => {
          const active = tab === item.id
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(item.id)}
              className={`relative flex shrink-0 items-center gap-2 px-3.5 py-2.5 text-[13px] font-medium whitespace-nowrap transition-colors ${
                active ? 'text-ink' : 'text-ink-3 hover:text-ink-2'
              }`}
            >
              <span>{item.label}</span>
              <span
                className={`rounded-full px-1.5 py-px text-[11px] font-medium tabular-nums ${
                  active ? 'bg-accent/12 text-accent' : 'bg-black/[0.05] text-ink-3 dark:bg-white/[0.08]'
                }`}
              >
                {item.count.toLocaleString()}
              </span>
              {active && <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] bg-accent" />}
            </button>
          )
        })}
      </div>

      {tab === 'logs' && <RequestLogView onCloseDialog={onClose} onCountsChange={updateLogTotal} refreshToken={refreshToken} />}

      {tab === 'accounts' && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 px-8 pt-4 pb-3">{periodBar}</div>
          <div className="@container min-h-0 flex-1 overflow-auto px-8 pb-8">
            <div className="grid grid-cols-2 gap-3 @[680px]:grid-cols-4">
              <Stat
                label={t('usage.statCost')}
                value={fmtCost(total.costUsd)}
                sub={unpriced > 0 ? t('usage.statCostUnpriced', { n: fmtTokens(unpriced) }) : t('usage.statCostSub')}
              />
              <Stat label={t('usage.statTokens')} value={fmtTokens(tokenSum(total))} sub={t('usage.statTodaySub', { n: fmtTokens(total.output) })} />
              <Stat label={t('usage.statCacheHit')} value={fmtPct(cacheHit(total))} sub={t('usage.statCacheHitSub', { n: fmtTokens(total.cacheRead) })} />
              <Stat label={t('usage.statRuns')} value={String(total.runs)} sub={t('usage.statRunsSub')} />
            </div>

            <SectionTitle>{t('usage.quotaSection')}</SectionTitle>
            {cards.length ? (
              <div className="grid grid-cols-1 gap-3 @[660px]:grid-cols-2 @[1080px]:grid-cols-3">
                {cards.map((p) => (
                  <QuotaCard key={p.id} p={p} idlest={idlest.has(p.id)} />
                ))}
              </div>
            ) : (
              <div className={`${CARD} px-4 py-5 text-[13px] text-ink-3`}>{t('usage.noReady')}</div>
            )}

            <SectionTitle>{t('usage.detailSection')}</SectionTitle>
            {!profiles.length ? (
              <div className={`${CARD} px-4 py-5 text-[13px] text-ink-3`}>{t('usage.noData')}</div>
            ) : (
              <div className={CARD}>
                <table className="w-full text-[13px]">
                  <thead className={STICKY_HEAD}>
                    <tr>
                      <th className="px-4 py-2 text-left font-medium">{t('usage.colAccount')}</th>
                      <th className="px-4 py-2 text-right font-medium whitespace-nowrap">{t('usage.colTokens')}</th>
                      <th className="px-4 py-2 text-right font-medium whitespace-nowrap">{t('usage.colCacheHit')}</th>
                      <th className="px-4 py-2 text-right font-medium whitespace-nowrap">{t('usage.colRuns')}</th>
                      <th className="px-4 py-2 text-right font-medium whitespace-nowrap">{t('usage.colCost')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {profiles.map((p) => {
                      const u = byAccount.get(p.id)
                      return (
                        <tr key={p.id} className="border-b border-black/[0.05] last:border-0">
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2.5">
                              <ProfileAvatar profile={p} size={22} />
                              <span className="font-medium wrap-anywhere text-ink">{p.name}</span>
                            </div>
                          </td>
                          <td
                            className={num}
                            title={
                              u
                                ? t('usage.cellTip', { input: fmtTokens(u.input), output: fmtTokens(u.output), cacheRead: fmtTokens(u.cacheRead), cacheWrite: fmtTokens(u.cacheWrite) }) +
                                  (u.reasoning ? t('usage.cellTipReasoning', { n: fmtTokens(u.reasoning) }) : '')
                                : undefined
                            }
                          >
                            {u ? fmtTokens(tokenSum(u)) : '—'}
                          </td>
                          <td className={`${num} text-ink-2`}>{u ? fmtPct(cacheHit(u)) : '—'}</td>
                          <td className={`${num} text-ink-2`}>{u?.runs || '—'}</td>
                          <td className={`${num} font-medium text-ink`}>{u && u.costUsd > 0 ? fmtCost(u.costUsd) : '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'models' && (
        <div className="flex min-h-0 flex-1 flex-col px-8 pt-4 pb-6">
          <div className="mb-3 shrink-0">{periodBar}</div>
          <ModelTable
            rows={modelRows}
            models={snap?.models ?? {}}
            customPrices={customPrices}
            syncedAt={snap?.pricesSyncedAt ?? null}
            footnote={
              t('usage.footnote', { days: snap?.claudeDays ?? 30, date: snap?.pricesAt ?? '' }) +
              (snap?.pricesLive ? '' : t('usage.footnoteOffline')) +
              (snap?.backfill === 'running' ? t('usage.backfillRunning') : '')
            }
          />
        </div>
      )}
    </div>
  )
}

/** Amber / red dot beside the driver picker when its quota runs low; click to switch. */
/** Level each account's usage popover was last auto-opened at (so closing it sticks). */
const autoShown = new Map<ProfileId, 'warn' | 'danger'>()

export function QuotaDot({ driver, model, onSwitch }: { driver: ProfileState | null; model?: string | null; onSwitch: (id: ProfileId) => void }) {
  const { profiles } = useApp()
  const snap = useUsage()
  useSettings() // threshold changes re-evaluate the level
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  // reaching the warning threshold (or escalating to danger) opens the popover once by itself
  const driverId = driver?.id ?? null
  const autoLevel = driver ? quotaLevel(driver, snap?.accounts[driver.id], model).level : 'ok'
  useEffect(() => {
    if (!driverId) return
    if (autoLevel === 'ok') return void autoShown.delete(driverId)
    if (autoShown.get(driverId) === autoLevel) return
    autoShown.set(driverId, autoLevel)
    // an outside mousedown closes whichever composer popover is open (model, 扩展…): stay exclusive
    window.dispatchEvent(new MouseEvent('mousedown'))
    setOpen(true)
  }, [driverId, autoLevel])
  if (!driver) return null
  const u = snap?.accounts[driver.id]
  const { level, reason } = quotaLevel(driver, u, model)
  // always shown: green = fine, gray = no quota data (e.g. API key), orange / red = running low
  const alt = level === 'ok' ? null : recommendSwitch(driver, profiles, snap, model)
  const eff = effectiveQuota(u, model ?? driver.defaultModel)
  const five = liveWindow(eff.fiveHour)
  const seven = liveWindow(eff.sevenDay)
  const line = (which: string, w: QuotaWindow | null) =>
    w && t('usage.remaining', { which, pct: Math.max(0, 100 - Math.round(w.percent)) }) + (w.resetsAt ? t('usage.remainingReset', { time: fmtReset(w.resetsAt) }) : '')
  const detail = [line('5h', five), line('7d', seven)].filter(Boolean) as string[]
  const known = !!(five || seven) || level !== 'ok'
  const status = reason ?? (known ? t('usage.okShort') : t('usage.noQuotaShort'))
  const dot =
    level === 'danger'
      ? 'bg-red shadow-[0_0_0_3px_rgba(255,59,48,0.18)]'
      : level === 'warn'
        ? 'bg-orange shadow-[0_0_0_3px_rgba(255,159,10,0.18)]'
        : known
          ? 'bg-green shadow-[0_0_0_3px_rgba(52,199,89,0.16)]'
          : 'bg-ink-3/45'
  return (
    <div ref={ref} className="relative">
      <button
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
        className="flex h-8 w-6 items-center justify-center rounded-full hover:bg-fill"
        title={[`${driver.name}: ${status}`, ...detail, alt ? t('usage.canSwitch', { name: alt.name }) : ''].filter(Boolean).join('\n')}
        aria-label={`${driver.name}: ${status}`}
      >
        <span className={`h-2 w-2 rounded-full ${dot}`} />
      </button>
      {open && (
        <div className="absolute bottom-10 left-0 z-30 w-64 rounded-xl border border-editor-hairline bg-elevated p-3 text-[12.5px] shadow-[0_12px_32px_rgba(0,0,0,0.14)]">
          <div className={`font-medium ${level === 'danger' ? 'text-danger' : level === 'warn' ? 'text-warn' : known ? 'text-ok' : 'text-ink-2'}`}>
            {driver.name} · {status}
          </div>
          {eff.group && <div className="mt-0.5 text-ink-3">{t('usage.group', { name: eff.group.name })}</div>}
          {detail.map((d) => (
            <div key={d} className="mt-0.5 text-ink-3">
              {d}
            </div>
          ))}
          {level === 'ok' ? null : alt ? (
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onSwitch(alt.id)
                setOpen(false)
              }}
              className="mt-2.5 flex h-8 w-full items-center justify-center gap-1.5 rounded-full bg-accent font-medium text-white hover:bg-accent/90"
            >
              {t('usage.switchTo')} <ProfileAvatar profile={alt} size={14} /> {alt.name}
            </button>
          ) : (
            <div className="mt-2 text-ink-3">{t('usage.noAlt')}</div>
          )}
        </div>
      )}
    </div>
  )
}
