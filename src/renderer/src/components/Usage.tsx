import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { AccountUsage, ProfileId, ProfileKind, ProfileState, QuotaWindow, UsageTotals } from '@shared/types'
import { KIND_META, isReady } from '../lib/ui'
import { useApp } from '../state/AppContext'
import { t } from '../state/i18n'
import { getSettings, useSettings } from '../state/settings'
import {
  effectiveQuota,
  fmtAgo,
  fmtCost,
  fmtReset,
  fmtTokens,
  idlestAccounts,
  liveWindow,
  quotaLevel,
  recommendSwitch,
  refreshUsage,
  tokenSum,
  useUsage
} from '../state/usage'
import { KindAvatar } from './common'
import { IconChevronDown, IconRefresh, Spinner } from './icons'

const STALE = 6 * 3600_000
const CARD = 'rounded-xl border border-black/[0.07] bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.03)]'

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

function useOutsideClose(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close()
    window.addEventListener('mousedown', h)
    return () => window.removeEventListener('mousedown', h)
  }, [open, close])
  return ref
}

/** agy: chip naming the quota group in use; hover / click shows every group. */
function QuotaGroupChip({ u, model }: { u: AccountUsage | undefined; model?: string | null }) {
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const close = useCallback(() => {
    setOpen(false)
    setPinned(false)
  }, [])
  const ref = useOutsideClose(open, close)
  const q = u?.quota
  const eff = effectiveQuota(u, model)
  if (!q?.groups?.length || !eff.group) return null
  return (
    <div ref={ref} className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => !pinned && setOpen(false)}>
      <button
        onClick={() => {
          setPinned((p) => !p)
          setOpen(true)
        }}
        className={`flex h-[22px] items-center gap-1 rounded-md border px-2 text-[11.5px] font-medium transition-colors ${open ? 'border-black/[0.14] bg-black/[0.03] text-ink' : 'border-black/[0.09] text-ink-2 hover:text-ink'}`}
      >
        {eff.group.name}
        <IconChevronDown size={11} />
      </button>
      {open && (
        // right-aligned to the chip (it sits at the card's right edge) so the panel opens inwards;
        // pt bridges the gap so moving the pointer onto it doesn't close the hover popover
        <div className="absolute top-full right-0 z-40 w-[360px] max-w-[calc(100vw-64px)] pt-1.5">
          <div className="max-h-[min(420px,60vh)] overflow-y-auto rounded-xl bg-surface/95 p-1.5 shadow-[0_0_0_1px_var(--ring),0_12px_36px_rgba(0,0,0,0.18)] backdrop-blur-xl">
            {q.groups.map((g) => {
              const five = liveWindow(g.fiveHour)
              const seven = liveWindow(g.sevenDay)
              const cur = g.key === eff.group?.key
              return (
                <div key={g.key} className={`rounded-lg px-2.5 py-2 ${cur ? 'bg-accent/[0.06]' : ''}`}>
                  <div className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
                    {g.name}
                    {cur && <span className="rounded bg-accent/10 px-1 text-[10.5px] font-medium text-accent">{t('usage.currentModel')}</span>}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-ink-3" title={g.models.join(', ')}>
                    {g.models.join(' · ')}
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-3">
                    <QuotaMeter kind="gemini" label="5h" w={g.fiveHour ? five : null} stale={false} />
                    <QuotaMeter kind="gemini" label="7d" w={g.sevenDay ? seven : null} stale={false} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
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
function AccountQuotaCells({ kind, u, model }: { kind: ProfileKind; u: AccountUsage | undefined; model?: string | null }) {
  const q = u?.quota
  if (!q) return <div className="col-span-2 text-right text-[11.5px] text-ink-3/80">{t('usage.noQuota')}</div>
  const eff = effectiveQuota(u, model)
  const stale = Date.now() - q.fetchedAt > STALE
  const tip = t('usage.quotaAge', { ago: fmtAgo(q.fetchedAt) }) + (q.limited && !stale ? t('usage.limitedSuffix') : '')
  return (
    <>
      <QuotaMeter kind={kind} label="5h" w={eff.fiveHour ? liveWindow(eff.fiveHour) : null} stale={stale} title={tip} />
      <QuotaMeter kind={kind} label="7d" w={eff.sevenDay ? liveWindow(eff.sevenDay) : null} stale={stale} title={tip} />
    </>
  )
}

/** "3 分钟前更新" + 刷新用量. The Claude probe is a setting (设置 › 用量与刷新). */
export function RefreshUsage() {
  const [busy, setBusy] = useState(false)
  const { probeClaude } = useSettings()
  const snap = useUsage()
  useTick(30_000)
  const run = async () => {
    setBusy(true)
    try {
      await refreshUsage()
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

/** One account in the quota grid: 5h / 7d bars (or local stats when the CLI reports no quota). */
function QuotaCard({ p, idlest }: { p: ProfileState; idlest: boolean }) {
  const snap = useUsage()
  const u = snap?.accounts[p.id]
  const limited = p.status === 'rate_limited' || quotaLevel(p, u).level === 'danger'
  return (
    <div className={`${CARD} px-4 py-3.5`}>
      <div className="flex min-w-0 items-center gap-2">
        <KindAvatar kind={p.kind} size={22} />
        <span className="truncate text-[13.5px] font-semibold text-ink">{p.name}</span>
        {idlest && (
          <span className="shrink-0 rounded-md bg-ok-soft px-1.5 py-px text-[11px] font-medium text-ok" title={t('usage.idlestHint')}>
            {t('usage.idlest')}
          </span>
        )}
        {limited && <span className="shrink-0 rounded-md bg-danger-soft px-1.5 py-px text-[11px] font-medium text-danger">{quotaLevel(p, u).reason ?? t('status.rateLimited')}</span>}
        <span className="flex-1" />
        <QuotaGroupChip u={u} model={p.defaultModel} />
      </div>
      {u?.quota ? (
        <>
          <div className="mt-3 grid grid-cols-2 gap-5">
            <AccountQuotaCells kind={p.kind} u={u} model={p.defaultModel} />
          </div>
          <div className="mt-2 text-[11px] text-ink-3 tabular-nums">
            {todayBrief(u)} · {t('usage.quotaAge', { ago: fmtAgo(u.quota.fetchedAt) })}
          </div>
          {u.quotaError && (
            <div className="mt-1.5 truncate rounded-md bg-warn-soft/70 px-2 py-1 text-[11px] text-warn select-text" title={u.quotaError}>
              {u.quotaError}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-2 gap-5 text-[12px] tabular-nums">
            <div>
              <div className="text-ink-3">{t('usage.localToday')}</div>
              <div className="mt-0.5 text-[15px] font-semibold text-ink">{fmtTokens(u ? tokenSum(u.today) : 0)}</div>
            </div>
            <div>
              <div className="text-ink-3">{t('usage.localWeek')}</div>
              <div className="mt-0.5 text-[15px] font-semibold text-ink">{fmtTokens(u ? tokenSum(u.week) : 0)}</div>
            </div>
          </div>
          {u?.quotaError ? (
            <div className="mt-2 rounded-lg bg-warn-soft/70 px-2.5 py-1.5 text-[11.5px] leading-[17px] break-words text-warn select-text">
              {u.quotaError}
            </div>
          ) : (
            <div className="mt-2 text-[11px] text-ink-3">{t('usage.noQuotaNote')}</div>
          )}
        </>
      )}
    </div>
  )
}

/** 用量限额 page body: overview strip, per-account quota grid, per-account detail table. */
export function UsageView() {
  const { profiles } = useApp()
  const snap = useUsage()
  const all = snap ? Object.values(snap.accounts) : []
  const cost = sumOf(all, (u) => u.total.costUsd)
  const runs = sumOf(all, (u) => u.total.runs)
  const ready = profiles.filter(isReady)
  const idlest = idlestAccounts(profiles, snap)
  const num = 'px-4 py-3 text-right tabular-nums'
  const cell = (tt: UsageTotals | undefined) =>
    tt ? (
      <td
        className={num}
        title={
          t('usage.cellTip', { input: fmtTokens(tt.input), output: fmtTokens(tt.output), cacheRead: fmtTokens(tt.cacheRead), cacheWrite: fmtTokens(tt.cacheWrite) }) +
          (tt.reasoning ? t('usage.cellTipReasoning', { n: fmtTokens(tt.reasoning) }) : '')
        }
      >
        <div className="text-[13px] font-medium text-ink">{fmtTokens(tokenSum(tt))}</div>
        <div className="text-[11px] text-ink-3">{tt.costUsd > 0 ? fmtCost(tt.costUsd) : '—'}</div>
      </td>
    ) : (
      <td className={`${num} text-ink-3`}>—</td>
    )
  return (
    <div>
      <div className="grid grid-cols-3 gap-3">
        <Stat label={t('usage.statToday')} value={fmtTokens(sumOf(all, (u) => tokenSum(u.today)))} sub={t('usage.statTodaySub', { n: fmtTokens(sumOf(all, (u) => u.today.output)) })} />
        <Stat label={t('usage.statWeek')} value={fmtTokens(sumOf(all, (u) => tokenSum(u.week)))} sub={t('usage.statWeekSub')} />
        <Stat label={t('usage.statCost')} value={fmtCost(cost)} sub={t('usage.statCostSub', { n: runs })} />
      </div>

      <SectionTitle>{t('usage.quotaSection')}</SectionTitle>
      {ready.length ? (
        <div className="grid grid-cols-2 gap-3">
          {ready.map((p) => (
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
        <>
          <div className={`overflow-hidden ${CARD}`}>
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-black/[0.06] bg-surface-2/80 text-[11.5px] text-ink-3">
                  <th className="px-4 py-2 text-left font-medium">{t('usage.colAccount')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('usage.colToday')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('usage.colWeek')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('usage.colTotal')}</th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((p) => {
                  const u = snap?.accounts[p.id]
                  return (
                    <tr key={p.id} className="border-b border-black/[0.05] last:border-0">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          <KindAvatar kind={p.kind} size={22} />
                          <span className="truncate font-medium text-ink">{p.name}</span>
                        </div>
                      </td>
                      {cell(u?.today)}
                      {cell(u?.week)}
                      {cell(u?.total)}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2.5 px-1 text-[11.5px] leading-relaxed text-ink-3">
            {t('usage.footnote', { days: snap?.claudeDays ?? 30 })}
            {snap?.backfill === 'running' && t('usage.backfillRunning')}
          </p>
        </>
      )}
    </div>
  )
}

/** Amber / red dot beside the driver picker when its quota runs low; click to switch. */
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
  if (!driver) return null
  const u = snap?.accounts[driver.id]
  const { level, reason } = quotaLevel(driver, u, model)
  if (level === 'ok') return null
  const alt = recommendSwitch(driver, profiles, snap, model)
  const eff = effectiveQuota(u, model ?? driver.defaultModel)
  const five = liveWindow(eff.fiveHour)
  const seven = liveWindow(eff.sevenDay)
  const line = (which: string, w: QuotaWindow | null) =>
    w && t('usage.remaining', { which, pct: Math.max(0, 100 - Math.round(w.percent)) }) + (w.resetsAt ? t('usage.remainingReset', { time: fmtReset(w.resetsAt) }) : '')
  const detail = [line('5h', five), line('7d', seven)].filter(Boolean) as string[]
  const color = level === 'danger' ? 'bg-red' : 'bg-orange'
  return (
    <div ref={ref} className="relative">
      <button
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
        className="flex h-8 w-6 items-center justify-center rounded-full hover:bg-fill"
        title={[`${driver.name}: ${reason}`, ...detail, alt ? t('usage.canSwitch', { name: alt.name }) : ''].filter(Boolean).join('\n')}
      >
        <span className={`h-2 w-2 rounded-full ${color} shadow-[0_0_0_3px_rgba(255,159,10,0.18)]`} />
      </button>
      {open && (
        <div className="absolute bottom-10 left-0 z-30 w-64 rounded-2xl bg-surface/95 p-3 text-[12.5px] shadow-[0_0_0_1px_var(--ring),0_12px_40px_rgba(0,0,0,0.16)] backdrop-blur-xl">
          <div className={`font-medium ${level === 'danger' ? 'text-danger' : 'text-warn'}`}>
            {driver.name} · {reason}
          </div>
          {eff.group && <div className="mt-0.5 text-ink-3">{t('usage.group', { name: eff.group.name })}</div>}
          {detail.map((d) => (
            <div key={d} className="mt-0.5 text-ink-3">
              {d}
            </div>
          ))}
          {alt ? (
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onSwitch(alt.id)
                setOpen(false)
              }}
              className="mt-2.5 flex h-8 w-full items-center justify-center gap-1.5 rounded-full bg-accent font-medium text-white hover:bg-accent/90"
            >
              {t('usage.switchTo')} <KindAvatar kind={alt.kind} size={14} /> {alt.name}
            </button>
          ) : (
            <div className="mt-2 text-ink-3">{t('usage.noAlt')}</div>
          )}
        </div>
      )}
    </div>
  )
}
