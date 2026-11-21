import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AccountQuota, AccountUsage, ProfileId, ProfileState, QuotaWindow, UsageTotals } from '@shared/types'
import { useApp } from '../state/AppContext'
import { effectiveQuota, fmtAgo, fmtCost, fmtReset, fmtTokens, liveWindow, probeEnabled, quotaLevel, recommendSwitch, refreshUsage, setProbeEnabled, tokenSum, useUsage } from '../state/usage'
import { KindAvatar } from './common'
import { IconRefresh, IconX, Spinner } from './icons'

const STALE = 6 * 3600_000

function Bar({ label, w, stale }: { label: string; w: QuotaWindow; stale: boolean }) {
  const pct = Math.min(100, Math.max(0, w.percent))
  const color = pct >= 95 ? 'bg-[#FF3B30]' : pct >= 80 ? 'bg-[#FF9F0A]' : 'bg-accent'
  return (
    <div className="flex items-center gap-2 text-[11.5px] leading-4 text-ink-3">
      <span className="w-6 shrink-0">{label}</span>
      <div className="h-1 w-24 shrink-0 overflow-hidden rounded-full bg-black/[0.07]">
        <div className={`h-full rounded-full ${color} ${stale ? 'opacity-50' : ''}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`tabular-nums ${pct >= 80 ? 'font-medium text-ink-2' : ''}`}>{Math.round(pct)}%</span>
      {w.resetsAt && <span>· {fmtReset(w.resetsAt)} 重置</span>}
    </div>
  )
}

const pctText = (w: QuotaWindow | null) => (w ? `${Math.round(w.percent)}%${w.resetsAt ? `（${fmtReset(w.resetsAt)} 重置）` : ''}` : '—')
/** agy: every model group, for hover text. */
const groupsTitle = (q: AccountQuota | null | undefined) =>
  q?.groups?.length ? q.groups.map((g) => `${g.name}：5h ${pctText(liveWindow(g.fiveHour))} · 7d ${pctText(liveWindow(g.sevenDay))}`).join('\n') : undefined

const todayLine = (t: UsageTotals) => `今日 ${fmtTokens(tokenSum(t))} Token${t.costUsd > 0 ? ` · ${fmtCost(t.costUsd)}` : ''}`

/** Compact block for an account card: quota bars (when the CLI reports them) + today's usage. */
export function AccountUsageBlock({ u, model }: { u: AccountUsage | undefined; model?: string | null }) {
  if (!u) return null
  const q = u.quota
  const eff = effectiveQuota(u, model)
  const five = liveWindow(eff.fiveHour)
  const seven = liveWindow(eff.sevenDay)
  const stale = !!q && Date.now() - q.fetchedAt > STALE
  return (
    <div className="mt-1 space-y-0.5" title={groupsTitle(q)}>
      {eff.group && q?.groups && q.groups.length > 1 && <div className="text-[11px] leading-4 text-ink-3">额度组：{eff.group.name}（悬停查看全部）</div>}
      {q && (five || seven) ? (
        <>
          {five && <Bar label="5h" w={five} stale={stale} />}
          {seven && <Bar label="7d" w={seven} stale={stale} />}
        </>
      ) : q ? (
        <div className="text-[11.5px] text-ink-3">额度窗口已重置</div>
      ) : null}
      <div className="text-[11px] leading-4 text-ink-3/80" title={`本周 ${fmtTokens(tokenSum(u.week))} · 累计 ${fmtTokens(tokenSum(u.total))}`}>
        {todayLine(u.today)}
        {q ? ` · 额度数据 ${fmtAgo(q.fetchedAt)}${q.limited && !stale ? ' · 已限流' : ''}` : ' · 此账号不提供额度数据'}
      </div>
    </div>
  )
}

/** "刷新用量" + the optional probe switch. */
export function RefreshUsage() {
  const [busy, setBusy] = useState(false)
  const [probe, setProbe] = useState(probeEnabled)
  const snap = useUsage()
  const run = async () => {
    setBusy(true)
    try {
      await refreshUsage()
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex items-center gap-3">
      <label className="flex cursor-default items-center gap-1.5 text-[12px] text-ink-3" title="开启后，刷新时会用 haiku 给每个 Claude 账号发一句极短的消息来拉取最新额度（会消耗极少额度）">
        <input
          type="checkbox"
          checked={probe}
          onChange={(e) => {
            setProbe(e.target.checked)
            setProbeEnabled(e.target.checked)
          }}
          className="accent-[#0071E3]"
        />
        刷新时探测 Claude 额度（耗极少额度）
      </label>
      <button
        onClick={() => void run()}
        disabled={busy}
        className="flex h-7 items-center gap-1.5 rounded-full bg-white px-3 text-[12.5px] font-medium text-ink shadow-[0_0_0_1px_rgba(0,0,0,0.08)] hover:bg-[#FAFAFB] disabled:opacity-60"
      >
        {busy || snap?.backfill === 'running' ? <Spinner size={12} /> : <IconRefresh size={13} />}
        {busy ? '刷新中…' : '刷新用量'}
      </button>
    </div>
  )
}

/** All accounts: today / this week / total. */
export function UsageTable() {
  const { profiles } = useApp()
  const snap = useUsage()
  const rows = profiles.map((p) => ({ p, u: snap?.accounts[p.id] }))
  const cell = (t: UsageTotals | undefined) =>
    t ? (
      <td className="px-3 py-2 text-right tabular-nums" title={`输入 ${fmtTokens(t.input)} · 输出 ${fmtTokens(t.output)} · 缓存读 ${fmtTokens(t.cacheRead)} · 缓存写 ${fmtTokens(t.cacheWrite)}${t.reasoning ? ` · 思考 ${fmtTokens(t.reasoning)}` : ''}`}>
        <div className="text-ink">{fmtTokens(tokenSum(t))}</div>
        <div className="text-[11px] text-ink-3">{t.costUsd > 0 ? fmtCost(t.costUsd) : '—'}</div>
      </td>
    ) : (
      <td className="px-3 py-2 text-right text-ink-3">—</td>
    )
  return (
    <div className="overflow-hidden rounded-xl bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.06)]">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-hairline text-[12px] text-ink-3">
            <th className="px-3 py-2 text-left font-medium">账号</th>
            <th className="px-3 py-2 text-left font-medium">额度</th>
            <th className="px-3 py-2 text-right font-medium">今日</th>
            <th className="px-3 py-2 text-right font-medium">本周</th>
            <th className="px-3 py-2 text-right font-medium">累计</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ p, u }) => {
            const eff = effectiveQuota(u, p.defaultModel)
            const five = liveWindow(eff.fiveHour)
            const seven = liveWindow(eff.sevenDay)
            return (
              <tr key={p.id} className="border-b border-hairline last:border-0" title={groupsTitle(u?.quota)}>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <KindAvatar kind={p.kind} size={18} />
                    <span className="truncate text-ink">{p.name}</span>
                  </div>
                </td>
                <td className="px-3 py-2 text-[12px] text-ink-2 tabular-nums">
                  {eff.group && <div className="text-[11px] text-ink-3">{eff.group.name}</div>}
                  {u?.quota ? [five && `5h ${Math.round(five.percent)}%`, seven && `7d ${Math.round(seven.percent)}%`].filter(Boolean).join(' · ') || '已重置' : <span className="text-ink-3">无数据</span>}
                </td>
                {cell(u?.today)}
                {cell(u?.week)}
                {cell(u?.total)}
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="border-t border-hairline px-3 py-2 text-[11px] leading-relaxed text-ink-3">
        Token 含缓存读写。费用仅统计 AgentMux 运行时 CLI 报告的金额；历史回填（Claude 近 {snap?.claudeDays ?? 30} 天、Codex 全部）只计 Token。
        {snap?.backfill === 'running' && ' 正在后台回填历史用量…'}
      </div>
    </div>
  )
}

/** Sidebar entry: today's total; click for the summary table. */
export function UsageSummaryButton() {
  const snap = useUsage()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  const today = snap ? Object.values(snap.accounts).reduce((a, u) => a + tokenSum(u.today), 0) : 0
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="no-drag shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-ink-3 tabular-nums hover:bg-black/[0.05] hover:text-ink-2"
        title="查看各账号用量"
      >
        今日 {fmtTokens(today)}
      </button>
      {open &&
        createPortal(
          <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/25 backdrop-blur-sm" onMouseDown={() => setOpen(false)}>
            <div className="w-[640px] max-w-[90vw] rounded-2xl bg-[#F5F5F7] p-5 shadow-[0_24px_80px_rgba(0,0,0,0.3)]" onMouseDown={(e) => e.stopPropagation()}>
              <div className="mb-3 flex items-center gap-3">
                <div className="flex-1 text-[16px] font-semibold text-ink">账号用量</div>
                <RefreshUsage />
                <button onClick={() => setOpen(false)} className="rounded-md p-1 text-ink-3 hover:bg-black/[0.06] hover:text-ink">
                  <IconX size={14} />
                </button>
              </div>
              <UsageTable />
            </div>
          </div>,
          document.body
        )}
    </>
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
  const detail = [five && `5h 剩余 ${Math.max(0, 100 - Math.round(five.percent))}%${five.resetsAt ? ` · ${fmtReset(five.resetsAt)} 重置` : ''}`, seven && `7d 剩余 ${Math.max(0, 100 - Math.round(seven.percent))}%${seven.resetsAt ? ` · ${fmtReset(seven.resetsAt)} 重置` : ''}`].filter(Boolean) as string[]
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
