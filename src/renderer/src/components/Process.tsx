import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Markdown, MarkdownBase } from './Markdown'
import type { PermissionOption, Usage } from '@shared/types'
import { replyPermission, type Activity, type Thinking } from '../state/chat'
import { isPendingPermission, type PendingPermission } from '../state/permissionState'
import { IconAlert, IconCheck, IconChevronDown, IconCopy, IconTerminal, IconX, Spinner } from './icons'
import { cacheHitPercentage } from '../state/usage'
import { fmtDuration, t } from '../state/i18n'

/**
 * Process views for one assistant step: live/folded thinking, the expandable tool-call bar
 * (diff · terminal output · tool input/output), "other events" and the usage footer.
 */

const fmtSec = fmtDuration
const fmtNum = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

function useNow(active: boolean, interval = 500): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), interval)
    return () => clearInterval(t)
  }, [active, interval])
  return now
}

/** Keeps a scroll box pinned to the bottom while content streams in (unless the user scrolled up). */
function useStickBottom<T extends HTMLElement>(dep: unknown) {
  const ref = useRef<T>(null)
  const stuck = useRef(true)
  useLayoutEffect(() => {
    const el = ref.current
    if (el && stuck.current) el.scrollTop = el.scrollHeight
  }, [dep])
  const onScroll = () => {
    const el = ref.current
    if (el) stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }
  return { ref, onScroll }
}

// ---- thinking -------------------------------------------------------------------------------

export function ThinkingCard({ t: th, live }: { t: Thinking; live: boolean }) {
  const thinkingNow = live && !th.endedAt
  const now = useNow(thinkingNow)
  const [open, setOpen] = useState(false)
  const { ref, onScroll } = useStickBottom<HTMLDivElement>(th.text)
  const timed = th.timed !== false
  const secs = timed ? fmtSec((th.endedAt ?? now) - th.startedAt) : ''
  const tokens = th.tokens ? `${timed ? ' · ' : ''}${fmtNum(th.tokens)} tokens` : ''
  // reasoning summaries come as markdown headings like **Checking files**: show them plain
  const text = th.text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\n{3,}/g, '\n\n').trim()

  if (thinkingNow)
    return (
      <div className="mb-3 rounded-xl bg-black/[0.035] px-3 py-2.5">
        <div className="flex items-center gap-2 text-[12px] text-ink-2">
          <Spinner size={12} className="text-accent" />
          <span className="font-medium">{t('proc.thinkingNow')}</span>
          <span className="text-ink-3 tabular-nums">
            {secs}
            {tokens}
          </span>
        </div>
        {text ? (
          <div ref={ref} onScroll={onScroll} className="mt-1.5 max-h-40 overflow-y-auto text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-3 select-text">
            {text}
          </div>
        ) : (
          <div className="mt-1 text-[11.5px] text-ink-3/80">{t('proc.hiddenThinking')}</div>
        )}
      </div>
    )

  return (
    <div className="mb-2">
      <button
        disabled={!text}
        onClick={() => setOpen((o) => !o)}
        className="flex h-6 items-center gap-1.5 rounded-md px-1 -ml-1 text-[12px] text-ink-3 transition-colors enabled:hover:bg-black/[0.04] enabled:hover:text-ink-2"
      >
        <span>
          {t('proc.thought')}{secs || tokens ? (timed ? ' ' : ' · ') : ''}
          {secs}
          {tokens}
        </span>
        {text ? (
          <>
            <span>· {open ? t('proc.collapseThinking') : t('proc.expandThinking')}</span>
            <IconChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
          </>
        ) : (
          <span className="text-ink-3/70">{t('proc.hiddenShort')}</span>
        )}
      </button>
      {open && text && (
        <div className="mt-1 max-h-80 overflow-y-auto rounded-xl border-l-2 border-black/[0.08] bg-black/[0.025] px-3 py-2 text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-3 select-text">
          {text}
        </div>
      )}
    </div>
  )
}

// ---- permissions ----------------------------------------------------------------------------

const permissionRoles = ['allow_once', 'allow_always', 'reject_once', 'reject_always'] as const
const optionLabel = (option: PermissionOption): string =>
  option.role === 'answer' ? option.label : t(`permission.${option.role}`)

export function PermissionCard({ permission: p }: { permission: PendingPermission }) {
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)
  const inFlight = useRef(false)
  const now = useNow(isPendingPermission(p), 1000)
  const question = p.kind === 'question'
  const seconds = Math.max(0, Math.ceil((p.expiresAt - now) / 1000))
  const resolved = p.resolved
  if (resolved || p.expired) {
    const selected = p.options.find((option) => option.id === resolved?.optionId)
    let status: string
    if (!resolved) status = t('permission.expired')
    else if (resolved.outcome === 'cancelled') status = t(question ? 'permission.skipped' : 'permission.cancelled')
    else if (resolved.outcome === 'timeout') status = t(question ? 'permission.questionTimeout' : 'permission.approvalTimeout')
    else if (question) status = t('permission.answered', { label: resolved.label ?? '' })
    else status = t(selected?.role === 'allow_once' || selected?.role === 'allow_always' ? 'permission.allowed' : 'permission.denied')
    return (
      <div role="status" className="my-1.5 flex min-w-0 flex-wrap gap-x-2 rounded-md bg-fill px-2.5 py-1.5 text-[12px] text-ink-2">
        <span className="min-w-0 truncate" title={p.title}>{p.title}</span>
        <span className="min-w-0 break-words">{status}{!question && resolved?.by === 'auto' ? t('permission.auto') : ''}</span>
      </div>
    )
  }
  const reply = async (optionId: string | null) => {
    if (inFlight.current || Date.now() >= p.expiresAt) return
    inFlight.current = true
    setSending(true)
    setFailed(false)
    try {
      await replyPermission(p.requestId, optionId)
    } catch {
      inFlight.current = false
      setSending(false)
      setFailed(true)
    }
  }
  const options = question ? p.options : permissionRoles.flatMap((role) => p.options.filter((o) => o.role === role))
  const cancel = t(question ? 'permission.skip' : 'common.cancel')
  const countdown = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  const action = 'min-h-7 max-w-full rounded-md px-2.5 py-1 text-left text-[12px] font-medium break-words transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50'
  return (
    <section aria-label={t(question ? 'permission.question' : 'permission.approval')} className="my-1.5 rounded-lg border border-hairline bg-surface px-3 py-2.5">
      <div className="mb-1 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 text-[13px] font-medium break-words text-ink">
          {question ? <Markdown text={p.title} readOnly /> : p.title}
        </div>
        <span title={t('permission.countdown', { time: countdown })} className={`shrink-0 text-[12px] tabular-nums ${seconds <= 30 ? 'text-warn' : 'text-ink-3'}`}>
          {countdown}
        </span>
      </div>
      {!question && p.detail && (
        <details className="my-1 text-[12px] text-ink-2">
          <summary className="cursor-pointer break-all font-mono">{p.detail.split('\n', 1)[0]}</summary>
          <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-fill p-2 font-mono break-words whitespace-pre-wrap select-text">{p.detail}</pre>
        </details>
      )}
      <div className="mt-2 flex flex-wrap items-start gap-1.5">
        {options.map((option) => {
          const label = optionLabel(option)
          return (
            <div key={option.id} className="flex max-w-full flex-wrap items-center gap-1.5">
              <button
                type="button"
                className={`${action} ${option.role === 'allow_once' ? 'bg-accent text-white enabled:hover:bg-accent-hover' : 'bg-fill text-ink enabled:hover:bg-fill-hover'}`}
                aria-label={label}
                disabled={sending || seconds === 0}
                onClick={() => void reply(option.id)}
              >
                {label}
              </button>
              {option.warning && (
                <span className="flex min-w-0 items-start gap-1 text-[11.5px] break-words text-warn">
                  <IconAlert size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                  <span>{option.warning}</span>
                </span>
              )}
            </div>
          )
        })}
        <button type="button" className={`${action} text-ink-2 enabled:hover:bg-fill`} aria-label={cancel} disabled={sending || seconds === 0} onClick={() => void reply(null)}>
          {cancel}
        </button>
      </div>
      {failed && <div role="status" className="mt-1.5 text-[12px] text-danger">{t('permission.replyFailed')}</div>}
    </section>
  )
}

// ---- activity -------------------------------------------------------------------------------

const ACT_TYPES = ['read', 'write', 'run', 'search', 'tool'] as const
const actDone = (type: Activity['type'], n: number) => t(`proc.done.${type}` as 'proc.done.read', { n })
const actNow = (type: Activity['type'], target: string) => (ACT_TYPES.includes(type) ? t(`proc.now.${type}` as 'proc.now.read', { target }) : target)

const diffStat = (diff: string): { add: number; del: number } => {
  let add = 0
  let del = 0
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++') || l.startsWith('---')) continue
    if (l.startsWith('+')) add++
    else if (l.startsWith('-')) del++
  }
  return { add, del }
}

function CopyButton({ text, dark }: { text: string; dark?: boolean }) {
  const [done, setDone] = useState(false)
  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        void window.agentswitch.sys.copy(text)
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
      className={`flex h-5 items-center gap-1 rounded px-1.5 text-[11px] ${dark ? 'text-white/50 hover:bg-white/10 hover:text-white/90' : 'text-ink-3 hover:bg-black/[0.06] hover:text-ink'}`}
      title={t('common.copy')}
    >
      {done ? <IconCheck size={11} /> : <IconCopy size={11} />}
    </button>
  )
}

export function DiffView({ diff }: { diff: string }) {
  const lines = diff.replace(/\n$/, '').split('\n')
  return (
    <div className="overflow-hidden rounded-lg border border-black/[0.06] bg-surface">
      <div className="max-h-80 overflow-auto py-1 font-mono text-[11.5px] leading-[18px]">
        {lines.map((l, i) => {
          if (l.startsWith('---') || l.startsWith('+++'))
            return (
              <div key={i} className="px-3 text-ink-3/80">
                {l}
              </div>
            )
          const cls = l.startsWith('@@')
            ? 'bg-info-soft text-info'
            : l.startsWith('+')
              ? 'bg-ok-soft text-ok dark:text-ink'
              : l.startsWith('-')
                ? 'bg-danger-soft text-danger dark:text-ink'
                : l.startsWith('\\') || l.startsWith('…')
                  ? 'text-ink-3 italic'
                  : 'text-ink-2'
          return (
            <div key={i} className={`min-w-max px-3 whitespace-pre ${cls}`}>
              {l || ' '}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function TerminalView({ a }: { a: Activity }) {
  const d = a.detail ?? {}
  const code = d.exitCode
  return (
    <div className="overflow-hidden rounded-lg bg-[#1F1F22] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]">
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[#9FE39A]">$ {d.input ?? a.target}</span>
        {code !== undefined && code !== null ? (
          <span className={`shrink-0 rounded-full px-1.5 py-px font-mono text-[10.5px] ${code === 0 ? 'bg-[#2E5B36] text-[#B5F0B9]' : 'bg-[#6B2A27] text-[#FFC2BC]'}`}>exit {code}</span>
        ) : a.status === 'running' ? (
          <span className="shrink-0 text-[10.5px] text-white/50">{t('proc.running')}</span>
        ) : null}
        <CopyButton text={[d.output, d.stderr].filter(Boolean).join('\n')} dark />
      </div>
      <pre className="max-h-72 overflow-auto px-3 py-2 font-mono text-[11.5px] leading-[17px] whitespace-pre-wrap text-[#E6E6E8] select-text">
        {d.output || (a.status === 'running' ? '' : <span className="text-white/40">{t('proc.noOutput')}</span>)}
        {d.stderr && <span className="text-[#FF9C93]">{(d.output ? '\n' : '') + d.stderr}</span>}
      </pre>
    </div>
  )
}

function Block({ label, text }: { label: string; text: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-black/[0.06] bg-surface">
      <div className="flex items-center border-b border-black/[0.05] px-3 py-1 text-[11px] text-ink-3">
        <span className="flex-1">{label}</span>
        <CopyButton text={text} />
      </div>
      <pre className="max-h-60 overflow-auto px-3 py-2 font-mono text-[11.5px] leading-[17px] whitespace-pre-wrap text-ink-2 select-text">{text}</pre>
    </div>
  )
}

function ActivityDetailView({ a }: { a: Activity }) {
  const d = a.detail ?? {}
  if (a.type === 'run') return <TerminalView a={a} />
  const parts: ReactNode[] = []
  if (d.diff) parts.push(<DiffView key="d" diff={d.diff} />)
  if (d.input && a.type !== 'write') parts.push(<Block key="i" label={t('proc.input')} text={d.input} />)
  if (d.output) parts.push(<Block key="o" label={a.status === 'error' ? t('proc.error') : t('proc.result')} text={d.output} />)
  if (!parts.length) return <div className="px-1 text-[11.5px] text-ink-3">{a.status === 'running' ? t('proc.inProgress') : t('proc.noDetail')}</div>
  return <div className="space-y-1.5">{parts}</div>
}

function StatusIcon({ s }: { s?: Activity['status'] }) {
  if (s === 'running') return <Spinner size={11} className="text-accent" />
  if (s === 'error') return <IconX size={12} className="text-danger" />
  return <IconCheck size={12} className="text-ok" />
}

function ActivityRow({ a, permissions }: { a: Activity; permissions?: PendingPermission[] }) {
  const [open, setOpen] = useState(false)
  const { baseDir } = useContext(MarkdownBase)
  // paths inside the project read better relative
  const shown = baseDir && a.target.startsWith(baseDir + '/') ? a.target.slice(baseDir.length + 1) : a.target
  const d = a.detail
  const stat = d?.diff ? diffStat(d.diff) : null
  return (
    <div>
      <button onClick={() => setOpen((o) => !o)} className="group flex w-full items-center gap-2 rounded-md px-1.5 py-[3px] text-left text-[12px] leading-5 hover:bg-black/[0.035]">
        <span className="flex w-3.5 shrink-0 justify-center">
          <StatusIcon s={a.status} />
        </span>
        <span className="min-w-8 shrink-0 pr-1 text-ink-3">{ACT_TYPES.includes(a.type) ? t(`proc.verb.${a.type}` as 'proc.verb.read') : a.type}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-ink-2" title={a.target}>
          {shown}
        </span>
        {stat && (
          <span className="shrink-0 font-mono text-[11px]">
            <span className="text-ok">+{stat.add}</span> <span className="text-danger">−{stat.del}</span>
          </span>
        )}
        {a.type === 'run' && d?.exitCode !== undefined && d.exitCode !== null && (
          <span className={`shrink-0 rounded-full px-1.5 font-mono text-[10.5px] ${d.exitCode === 0 ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger'}`}>exit {d.exitCode}</span>
        )}
        <IconChevronDown size={12} className={`shrink-0 text-ink-3 opacity-0 transition group-hover:opacity-100 ${open ? 'rotate-180 opacity-100' : ''}`} />
      </button>
      {open && (
        <div className="mt-1 mb-2 ml-[22px]">
          <ActivityDetailView a={a} />
        </div>
      )}
      {permissions?.map((permission) => <PermissionCard key={permission.requestId} permission={permission} />)}
    </div>
  )
}

function OthersRow({ others }: { others: { kind: string; payload: string }[] }) {
  const [open, setOpen] = useState(false)
  const [pick, setPick] = useState<number | null>(null)
  return (
    <div className="mt-1 border-t border-black/[0.05] pt-1">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 rounded-md px-1.5 py-[3px] text-left text-[12px] text-ink-3 hover:bg-black/[0.035]">
        <span className="w-3.5" />
        <span className="flex-1">{t('proc.others', { n: others.length })}</span>
        <IconChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="ml-[22px] space-y-0.5 pb-1">
          {others.map((o, i) => (
            <div key={i}>
              <button onClick={() => setPick(pick === i ? null : i)} className="flex w-full items-center gap-2 rounded px-1.5 py-px text-left font-mono text-[11.5px] text-ink-2 hover:bg-black/[0.035]">
                <span className="min-w-0 flex-1 truncate">{o.kind}</span>
                <span className="shrink-0 text-[10.5px] text-ink-3">{t('proc.chars', { n: o.payload.length })}</span>
              </button>
              {pick === i && (
                <div className="my-1">
                  <Block label={o.kind} text={o.payload} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function ActivityBar({ items, others, permissions, live, openSeq = 0 }: { items: Activity[]; others: { kind: string; payload: string }[]; permissions?: PendingPermission[]; live: boolean; openSeq?: number }) {
  const waiting = permissions?.filter(isPendingPermission).at(-1)?.requestId
  const [open, setOpen] = useState(!!waiting)
  // the live progress line asks for the details
  useEffect(() => {
    if (openSeq) setOpen(true)
  }, [openSeq])
  useEffect(() => {
    if (waiting) setOpen(true)
  }, [waiting])
  const running = [...items].reverse().find((i) => i.status === 'running')
  const current = live ? (running ?? items[items.length - 1]) : null
  const errors = items.filter((i) => i.status === 'error').length
  const summary = ACT_TYPES
    .map((type) => {
      const xs = items.filter((i) => i.type === type)
      if (!xs.length) return null
      // single write: show the path, it's usually what the user cares about
      return type === 'write' && xs.length === 1 ? t('proc.wroteOne', { name: xs[0].target.split('/').pop() ?? '' }) : actDone(type, xs.length)
    })
    .filter(Boolean)
    .join(' · ')
  if (!items.length && !others.length) return null
  return (
    <div className="mb-3 overflow-hidden rounded-xl bg-black/[0.035]">
      <button onClick={() => setOpen((o) => !o)} className="flex h-8 w-full items-center gap-2 px-3 text-left text-[12px] text-ink-2 transition-colors hover:bg-black/[0.025]">
        {current ? <Spinner size={12} className="text-accent" /> : <IconTerminal size={13} className="text-ink-3" />}
        <span className="min-w-0 flex-1 truncate">{current ? actNow(current.type, current.target) : summary || t('proc.othersCount', { n: others.length })}</span>
        {errors > 0 && <span className="shrink-0 rounded-full bg-danger-soft px-1.5 text-[11px] text-danger">{t('proc.failedN', { n: errors })}</span>}
        <span className="shrink-0 text-ink-3">{open ? t('common.collapse') : t('proc.expand')}</span>
        <IconChevronDown size={13} className={`shrink-0 text-ink-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="border-t border-black/[0.05] px-1.5 py-1.5">
          {items.map((a, i) => (
            <ActivityRow key={a.id ?? i} a={a} permissions={a.id ? permissions?.filter((p) => p.activityId === a.id) : undefined} />
          ))}
          {others.length > 0 && <OthersRow others={others} />}
        </div>
      )}
    </div>
  )
}

// ---- usage footer ---------------------------------------------------------------------------

export function UsageLine({ usage, ms, reasonix, costUsd }: { usage: Usage | null | undefined; ms: number | null; reasonix?: boolean; costUsd?: number | null }) {
  const u = usage ?? {}
  const parts: string[] = []
  if (ms) parts.push(fmtSec(ms))
  if (u.input !== undefined || u.output !== undefined) {
    parts.push(t('proc.usageIn', { n: fmtNum(u.input ?? 0) }))
    parts.push(t('proc.usageOut', { n: fmtNum(u.output ?? 0) }) + (u.reasoning ? t('proc.usageReasoning', { n: fmtNum(u.reasoning) }) : ''))
  }
  if (u.cacheRead || u.cacheWrite) parts.push(t('proc.usageCache', { n: fmtNum(u.cacheRead ?? 0) }) + (u.cacheWrite ? t('proc.usageCacheWrite', { n: fmtNum(u.cacheWrite) }) : ''))
  if (reasonix) {
    const pct = cacheHitPercentage(u)
    if (pct !== null) parts.push(t('proc.usageCacheRate', { pct }))
  }
  if (reasonix && typeof u.costCny === 'number') parts.push(`CN¥${u.costCny.toFixed(u.costCny < 0.01 ? 6 : 3)}`)
  const cost = typeof costUsd === 'number' ? costUsd : typeof u.costUsd === 'number' ? u.costUsd : null
  if (cost !== null) parts.push(`$${cost < 0.01 ? cost.toFixed(reasonix ? 6 : 4) : cost.toFixed(3)}`)
  if (!parts.length) return null
  return (
    <span className="text-[11px] text-ink-3/70 tabular-nums" title={t('proc.usageTip')}>
      {parts.join(' · ')}
    </span>
  )
}

const fmtKB = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`)
/** Tool names that write files (Claude Write / Edit / MultiEdit / NotebookEdit). */
const WRITE_TOOLS = /^(write|edit|multiedit|notebookedit|str_replace|create_file|apply_patch)/i

/**
 * Compact live line under the newest text of a running reply: what the model is doing right
 * now (thinking / generating a tool call's arguments / running a tool / waiting), plus totals.
 * Clicking it opens the process details at the top of the reply.
 */
export function LiveProgress({
  activity,
  phase,
  thinking,
  tail,
  startedAt,
  onDetails
}: {
  activity: Activity[]
  phase: { tool: string; bytes: number; since: number } | null | undefined
  thinking: boolean
  tail: 'text' | 'tool' | 'thinking' | undefined
  startedAt: number | null
  onDetails?: () => void
}) {
  const now = Date.now()
  const running = [...activity].reverse().find((a) => a.status === 'running')
  const done = activity.filter((a) => a.status !== 'running').length
  let label: string
  let since: number | null = null
  if (phase) {
    const what = WRITE_TOOLS.test(phase.tool) ? t('live.prepWrite') : t('live.prepTool', { tool: phase.tool })
    label = phase.bytes > 0 ? `${what} · ${t('live.generated', { size: fmtKB(phase.bytes) })}` : what
    since = phase.since
  } else if (running) {
    label = actNow(running.type, running.target.split('/').pop() || running.target)
    since = running.startedAt ?? null
  } else if (thinking) label = t('live.thinking')
  else if (tail === 'text') label = t('live.writing')
  else label = t('live.waiting')
  const stepMs = since ? now - since : 0
  return (
    <button
      onClick={onDetails}
      disabled={!onDetails}
      className="mt-2.5 flex h-7 max-w-full items-center gap-2 rounded-full bg-black/[0.035] pr-3 pl-2.5 text-left text-[12px] text-ink-2 transition-colors enabled:hover:bg-black/[0.06]"
      title={onDetails ? t('live.details') : undefined}
    >
      <Spinner size={11} className="shrink-0 text-accent" />
      <span className="min-w-0 truncate">{label}</span>
      {stepMs >= 3000 && <span className="shrink-0 text-ink-3 tabular-nums">{fmtDuration(stepMs)}</span>}
      <span className="shrink-0 text-ink-3/60">·</span>
      <span className="shrink-0 text-ink-3 tabular-nums">
        {done > 0 ? t('live.totals', { n: done, dur: fmtDuration(startedAt ? now - startedAt : 0) }) : fmtDuration(startedAt ? now - startedAt : 0)}
      </span>
    </button>
  )
}
