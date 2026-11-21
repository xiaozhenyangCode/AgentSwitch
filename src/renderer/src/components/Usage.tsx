import { useCallback, useEffect, useRef, useState } from 'react'
import type { AccountUsage, ProfileId, ProfileState, QuotaWindow, UsageTotals } from '@shared/types'
import { useApp } from '../state/AppContext'
import {
  effectiveQuota,
  fmtAgo,
  fmtCost,
  fmtReset,
  fmtTokens,
  liveWindow,
  probeEnabled,
  quotaLevel,
  recommendSwitch,
  refreshUsage,
  setEnginesTab,
  setProbeEnabled,
  tokenSum,
  useUsage
} from '../state/usage'
import { KindAvatar } from './common'
import { IconChevronDown, IconRefresh, Spinner } from './icons'

const STALE = 6 * 3600_000

/** Semantic fill: calm brand blue, amber ≥80%, coral ≥95%. */
const fillFor = (pct: number) => (pct >= 95 ? 'bg-[#F0524F]' : pct >= 80 ? 'bg-[#F5A524]' : 'bg-accent')
const pctOf = (w: QuotaWindow) => Math.min(100, Math.max(0, w.percent))

/** One quota window: label / % on top, h-1.5 bar, reset time below. */
function QuotaMeter({ label, w, stale }: { label: string; w: QuotaWindow | null; stale: boolean }) {
  const pct = w ? pctOf(w) : 0
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between text-[11.5px] leading-4">
        <span className="text-ink-3">{label}</span>
        <span className={`tabular-nums ${!w ? 'text-ink-3' : pct >= 80 ? 'font-semibold text-ink' : 'font-medium text-ink-2'}`}>{w ? `${Math.round(pct)}%` : '—'}</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-black/[0.06]">
        {w && <div className={`h-full rounded-full transition-[width] duration-500 ${fillFor(pct)} ${stale ? 'opacity-45' : ''}`} style={{ width: `${Math.max(pct, pct > 0 ? 2 : 0)}%` }} />}
      </div>
      <div className="mt-1 text-[11px] leading-4 text-ink-3/80 tabular-nums">{w ? (w.resetsAt ? `${fmtReset(w.resetsAt)} 重置` : '滚动窗口') : '无此窗口'}</div>
    </div>
  )
}

/** Two tiny stacked bars for dense tables. */
function MiniBars({ five, seven }: { five: QuotaWindow | null; seven: QuotaWindow | null }) {
  const row = (label: string, w: QuotaWindow | null) => (
    <div className="flex items-center gap-1.5 text-[11px] leading-[14px]">
      <span className="w-[18px] text-ink-3">{label}</span>
      <div className="h-1 w-14 overflow-hidden rounded-full bg-black/[0.06]">{w && <div className={`h-full rounded-full ${fillFor(pctOf(w))}`} style={{ width: `${pctOf(w)}%` }} />}</div>
      <span className="w-8 text-right text-ink-2 tabular-nums">{w ? `${Math.round(pctOf(w))}%` : '—'}</span>
    </div>
  )
  return (
    <div className="space-y-1">
      {row('5h', five)}
      {row('7d', seven)}
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
export function QuotaGroupChip({ u, model }: { u: AccountUsage | undefined; model?: string | null }) {
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
        <div className="absolute top-7 left-0 z-30 w-[300px] rounded-xl border border-black/[0.07] bg-white/95 p-1.5 shadow-[0_12px_36px_rgba(0,0,0,0.14)] backdrop-blur-xl">
          {q.groups.map((g) => {
            const five = liveWindow(g.fiveHour)
            const seven = liveWindow(g.sevenDay)
            const cur = g.key === eff.group?.key
            return (
              <div key={g.key} className={`rounded-lg px-2.5 py-2 ${cur ? 'bg-accent/[0.06]' : ''}`}>
                <div className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
                  {g.name}
                  {cur && <span className="rounded bg-accent/10 px-1 text-[10.5px] font-medium text-accent">当前模型</span>}
                </div>
                <div className="mt-0.5 truncate text-[11px] text-ink-3" title={g.models.join(', ')}>
                  {g.models.join(' · ')}
                </div>
                <div className="mt-2 grid grid-cols-2 gap-3">
                  <QuotaMeter label="5h" w={g.fiveHour ? five : null} stale={false} />
                  <QuotaMeter label="7d" w={g.sevenDay ? seven : null} stale={false} />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Account row dashboard: 5h | 7d meters + today's usage on the right. */
export function AccountMeters({ u, model }: { u: AccountUsage | undefined; model?: string | null }) {
  if (!u) return null
  const q = u.quota
  const eff = effectiveQuota(u, model)
  const five = liveWindow(eff.fiveHour)
  const seven = liveWindow(eff.sevenDay)
  const stale = !!q && Date.now() - q.fetchedAt > STALE
  const t = u.today
  return (
    <div className="grid grid-cols-[1fr_1fr_auto] items-start gap-x-6">
      {q ? (
        <>
          <QuotaMeter label="5h 窗口" w={eff.fiveHour ? five : null} stale={stale} />
          <QuotaMeter label="7d 窗口" w={eff.sevenDay ? seven : null} stale={stale} />
        </>
      ) : (
        <div className="col-span-2 flex h-full items-center rounded-lg border border-dashed border-black/[0.08] px-3 py-2 text-[12px] text-ink-3">此账号不提供额度数据，仅统计本地用量</div>
      )}
      <div className="min-w-[96px] text-right" title={`本周 ${fmtTokens(tokenSum(u.week))} · 累计 ${fmtTokens(tokenSum(u.total))}`}>
        <div className="text-[11.5px] leading-4 text-ink-3">今日</div>
        <div className="text-[17px] leading-6 font-semibold tracking-tight text-ink tabular-nums">{fmtTokens(tokenSum(t))}</div>
        <div className="text-[11px] leading-4 text-ink-3/80 tabular-nums">
          {[t.costUsd > 0 && fmtCost(t.costUsd), q && fmtAgo(q.fetchedAt), q?.limited && !stale && '已限流'].filter(Boolean).join(' · ') || 'Token'}
        </div>
      </div>
    </div>
  )
}

/** "刷新用量" split button; the optional Claude probe lives in its menu. */
export function RefreshUsage() {
  const [busy, setBusy] = useState(false)
  const [probe, setProbe] = useState(probeEnabled)
  const [menu, setMenu] = useState(false)
  const close = useCallback(() => setMenu(false), [])
  const ref = useOutsideClose(menu, close)
  const snap = useUsage()
  const run = async () => {
    setBusy(true)
    try {
      await refreshUsage()
    } finally {
      setBusy(false)
    }
  }
  const seg = 'flex h-7 items-center text-[12.5px] font-medium text-ink transition-colors hover:bg-black/[0.035] active:bg-black/[0.06] disabled:opacity-60'
  return (
    <div ref={ref} className="relative">
      <div className="flex overflow-hidden rounded-lg border border-black/[0.09] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
        <button onClick={() => void run()} disabled={busy} className={`${seg} gap-1.5 pr-2.5 pl-2.5`} title={probe ? '刷新（含 Claude 额度探测）' : '刷新（不消耗额度）'}>
          {busy || snap?.backfill === 'running' ? <Spinner size={12} /> : <IconRefresh size={13} />}
          {busy ? '刷新中…' : '刷新用量'}
          {probe && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
        </button>
        <div className="w-px bg-black/[0.08]" />
        <button onClick={() => setMenu((m) => !m)} className={`${seg} w-7 justify-center ${menu ? 'bg-black/[0.05]' : ''}`} title="刷新选项">
          <IconChevronDown size={12} />
        </button>
      </div>
      {menu && (
        <div className="absolute top-9 right-0 z-30 w-[280px] rounded-xl border border-black/[0.07] bg-white/95 p-1.5 shadow-[0_12px_36px_rgba(0,0,0,0.14)] backdrop-blur-xl">
          <button
            onClick={() => {
              setProbe(!probe)
              setProbeEnabled(!probe)
            }}
            className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-black/[0.04]"
          >
            <span
              className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors ${probe ? 'border-accent bg-accent text-white' : 'border-black/[0.2] bg-white'}`}
            >
              {probe && (
                <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2.5 6.2 5 8.5l4.5-5" />
                </svg>
              )}
            </span>
            <span>
              <span className="block text-[13px] font-medium text-ink">刷新时探测 Claude 额度</span>
              <span className="mt-0.5 block text-[11.5px] leading-4 text-ink-3">用 haiku 给每个 Claude 账号发一句极短消息拉取最新额度，会消耗极少额度。关闭时刷新不耗额度。</span>
            </span>
          </button>
        </div>
      )}
    </div>
  )
}

const sumOf = (accounts: AccountUsage[], pick: (u: AccountUsage) => number) => accounts.reduce((a, u) => a + pick(u), 0)

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-black/[0.07] bg-white px-4 py-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
      <div className="text-[12px] text-ink-3">{label}</div>
      <div className="mt-1 text-[24px] leading-8 font-semibold tracking-tight text-ink tabular-nums">{value}</div>
      {sub && <div className="text-[11.5px] text-ink-3 tabular-nums">{sub}</div>}
    </div>
  )
}

/** Usage tab: bento strip + per-account table. */
export function UsageView() {
  const { profiles } = useApp()
  const snap = useUsage()
  const all = snap ? Object.values(snap.accounts) : []
  const cost = sumOf(all, (u) => u.total.costUsd)
  const runs = sumOf(all, (u) => u.total.runs)
  const num = 'px-4 py-3 text-right tabular-nums'
  const cell = (t: UsageTotals | undefined) =>
    t ? (
      <td
        className={num}
        title={`输入 ${fmtTokens(t.input)} · 输出 ${fmtTokens(t.output)} · 缓存读 ${fmtTokens(t.cacheRead)} · 缓存写 ${fmtTokens(t.cacheWrite)}${t.reasoning ? ` · 思考 ${fmtTokens(t.reasoning)}` : ''}`}
      >
        <div className="text-[13px] font-medium text-ink">{fmtTokens(tokenSum(t))}</div>
        <div className="text-[11px] text-ink-3">{t.costUsd > 0 ? fmtCost(t.costUsd) : '—'}</div>
      </td>
    ) : (
      <td className={`${num} text-ink-3`}>—</td>
    )
  return (
    <div>
      <div className="grid grid-cols-3 gap-3">
        <Stat label="今日总 Token" value={fmtTokens(sumOf(all, (u) => tokenSum(u.today)))} sub={`输出 ${fmtTokens(sumOf(all, (u) => u.today.output))}`} />
        <Stat label="本周总 Token" value={fmtTokens(sumOf(all, (u) => tokenSum(u.week)))} sub="自周一起" />
        <Stat label="AgentMux 累计费用" value={fmtCost(cost)} sub={`${runs} 次运行`} />
      </div>
      <div className="mt-4 overflow-hidden rounded-xl border border-black/[0.07] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-black/[0.06] bg-neutral-50/80 text-[11.5px] text-ink-3">
              <th className="px-4 py-2 text-left font-medium">账号</th>
              <th className="px-4 py-2 text-left font-medium">额度</th>
              <th className="px-4 py-2 text-right font-medium">今日</th>
              <th className="px-4 py-2 text-right font-medium">本周</th>
              <th className="px-4 py-2 text-right font-medium">累计</th>
            </tr>
          </thead>
          <tbody>
            {profiles.map((p) => {
              const u = snap?.accounts[p.id]
              const eff = effectiveQuota(u, p.defaultModel)
              return (
                <tr key={p.id} className="border-b border-black/[0.05] last:border-0">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <KindAvatar kind={p.kind} size={22} />
                      <div className="min-w-0">
                        <div className="truncate font-medium text-ink">{p.name}</div>
                        {eff.group && <div className="truncate text-[11px] text-ink-3">{eff.group.name}</div>}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">{u?.quota ? <MiniBars five={liveWindow(eff.fiveHour)} seven={liveWindow(eff.sevenDay)} /> : <span className="text-[12px] text-ink-3">无额度数据</span>}</td>
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
        Token 含缓存读写；费用仅统计 AgentMux 运行时 CLI 报告的金额，历史回填（Claude 近 {snap?.claudeDays ?? 30} 天、Codex 与 agy 全部）只计 Token。
        {snap?.backfill === 'running' && ' 正在后台回填历史用量…'}
      </p>
    </div>
  )
}

/** Sidebar entry: today's total; click jumps to the engines page usage tab. */
export function UsageSummaryButton() {
  const snap = useUsage()
  const { navigate } = useApp()
  const today = snap ? Object.values(snap.accounts).reduce((a, u) => a + tokenSum(u.today), 0) : 0
  return (
    <button
      onClick={() => {
        setEnginesTab('usage')
        navigate('engines')
      }}
      className="no-drag shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-ink-3 tabular-nums hover:bg-black/[0.05] hover:text-ink-2"
      title="查看用量统计"
    >
      今日 {fmtTokens(today)}
    </button>
  )
}

/** Amber / red dot beside the driver picker when its quota runs low; click to switch. */
export function QuotaDot({ driver, model, onSwitch }: { driver: ProfileState | null; model?: string | null; onSwitch: (id: ProfileId) => void }) {
  const { profiles } = useApp()
  const snap = useUsage()
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
  const detail = [
    five && `5h 剩余 ${Math.max(0, 100 - Math.round(five.percent))}%${five.resetsAt ? ` · ${fmtReset(five.resetsAt)} 重置` : ''}`,
    seven && `7d 剩余 ${Math.max(0, 100 - Math.round(seven.percent))}%${seven.resetsAt ? ` · ${fmtReset(seven.resetsAt)} 重置` : ''}`
  ].filter(Boolean) as string[]
  const color = level === 'danger' ? 'bg-[#FF3B30]' : 'bg-[#FF9F0A]'
  return (
    <div ref={ref} className="relative">
      <button
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
        className="flex h-8 w-6 items-center justify-center rounded-full hover:bg-fill"
        title={[`${driver.name}：${reason}`, ...detail, alt ? `可切换到 ${alt.name}` : ''].filter(Boolean).join('\n')}
      >
        <span className={`h-2 w-2 rounded-full ${color} shadow-[0_0_0_3px_rgba(255,159,10,0.18)]`} />
      </button>
      {open && (
        <div className="absolute bottom-10 left-0 z-30 w-64 rounded-2xl bg-white/95 p-3 text-[12.5px] shadow-[0_0_0_1px_rgba(0,0,0,0.07),0_12px_40px_rgba(0,0,0,0.16)] backdrop-blur-xl">
          <div className={`font-medium ${level === 'danger' ? 'text-[#D70015]' : 'text-[#A05A00]'}`}>
            {driver.name} · {reason}
          </div>
          {eff.group && <div className="mt-0.5 text-ink-3">额度组：{eff.group.name}</div>}
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
              切换到 <KindAvatar kind={alt.kind} size={14} /> {alt.name}
            </button>
          ) : (
            <div className="mt-2 text-ink-3">没有可切换的同类账号</div>
          )}
        </div>
      )}
    </div>
  )
}
