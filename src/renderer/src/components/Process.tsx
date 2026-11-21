import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { MarkdownBase } from './Markdown'
import type { Usage } from '@shared/types'
import type { Activity, Thinking } from '../state/chat'
import { IconCheck, IconChevronDown, IconCopy, IconTerminal, IconX, Spinner } from './icons'

/**
 * Process views for one assistant step: live/folded thinking, the expandable tool-call bar
 * (diff · terminal output · tool input/output), "other events" and the usage footer.
 */

const fmtSec = (ms: number): string => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} 秒` : `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`)
const fmtNum = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [active])
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

export function ThinkingCard({ t, live }: { t: Thinking; live: boolean }) {
  const thinkingNow = live && !t.endedAt
  const now = useNow(thinkingNow)
  const [open, setOpen] = useState(false)
  const { ref, onScroll } = useStickBottom<HTMLDivElement>(t.text)
  const timed = t.timed !== false
  const secs = timed ? fmtSec((t.endedAt ?? now) - t.startedAt) : ''
  const tokens = t.tokens ? `${timed ? ' · ' : ''}${fmtNum(t.tokens)} tokens` : ''
  // reasoning summaries come as markdown headings like **Checking files**: show them plain
  const text = t.text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\n{3,}/g, '\n\n').trim()

  if (thinkingNow)
    return (
      <div className="mb-3 rounded-xl bg-black/[0.035] px-3 py-2.5">
        <div className="flex items-center gap-2 text-[12px] text-ink-2">
          <Spinner size={12} className="text-accent" />
          <span className="font-medium">正在深度思考…</span>
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
          <div className="mt-1 text-[11.5px] text-ink-3/80">该模型不公开思考内容，仅显示用时与 token 估计</div>
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
          已思考{secs || tokens ? (timed ? ' ' : ' · ') : ''}
          {secs}
          {tokens}
        </span>
        {text ? (
          <>
            <span>· {open ? '收起思考过程' : '展开思考过程'}</span>
            <IconChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
          </>
        ) : (
          <span className="text-ink-3/70">（未公开思考内容）</span>
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

// ---- activity -------------------------------------------------------------------------------

const ACT: Record<Activity['type'], { verb: string; unit: string }> = {
  read: { verb: '读取', unit: '个文件' },
  write: { verb: '写入', unit: '个文件' },
  run: { verb: '执行', unit: '条命令' },
  search: { verb: '搜索', unit: '次' },
  tool: { verb: '调用', unit: '个工具' }
}

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
      title="复制"
    >
      {done ? <IconCheck size={11} /> : <IconCopy size={11} />}
    </button>
  )
}

export function DiffView({ diff }: { diff: string }) {
  const lines = diff.replace(/\n$/, '').split('\n')
  return (
    <div className="overflow-hidden rounded-lg border border-black/[0.06] bg-white">
      <div className="max-h-80 overflow-auto py-1 font-mono text-[11.5px] leading-[18px]">
        {lines.map((l, i) => {
          if (l.startsWith('---') || l.startsWith('+++'))
            return (
              <div key={i} className="px-3 text-ink-3/80">
                {l}
              </div>
            )
          const cls = l.startsWith('@@')
            ? 'bg-[#F1F5FD] text-[#4A6FA5]'
            : l.startsWith('+')
              ? 'bg-[#E9F7EE] text-[#1A6E3B]'
              : l.startsWith('-')
                ? 'bg-[#FDEEEE] text-[#A8281E]'
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
          <span className="shrink-0 text-[10.5px] text-white/50">运行中…</span>
        ) : null}
        <CopyButton text={[d.output, d.stderr].filter(Boolean).join('\n')} dark />
      </div>
      <pre className="max-h-72 overflow-auto px-3 py-2 font-mono text-[11.5px] leading-[17px] whitespace-pre-wrap text-[#E6E6E8] select-text">
        {d.output || (a.status === 'running' ? '' : <span className="text-white/40">（无输出）</span>)}
        {d.stderr && <span className="text-[#FF9C93]">{(d.output ? '\n' : '') + d.stderr}</span>}
      </pre>
    </div>
  )
}

function Block({ label, text }: { label: string; text: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-black/[0.06] bg-white">
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
  if (d.input && a.type !== 'write') parts.push(<Block key="i" label="入参" text={d.input} />)
  if (d.output) parts.push(<Block key="o" label={a.status === 'error' ? '错误' : '结果'} text={d.output} />)
  if (!parts.length) return <div className="px-1 text-[11.5px] text-ink-3">{a.status === 'running' ? '进行中…' : '该 CLI 没有提供更多细节'}</div>
  return <div className="space-y-1.5">{parts}</div>
}

function StatusIcon({ s }: { s?: Activity['status'] }) {
  if (s === 'running') return <Spinner size={11} className="text-accent" />
  if (s === 'error') return <IconX size={12} className="text-[#C4321F]" />
  return <IconCheck size={12} className="text-[#2E9E5B]" />
}

function ActivityRow({ a }: { a: Activity }) {
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
        <span className="w-8 shrink-0 text-ink-3">{ACT[a.type]?.verb ?? a.type}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-ink-2" title={a.target}>
          {shown}
        </span>
        {stat && (
          <span className="shrink-0 font-mono text-[11px]">
            <span className="text-[#2E9E5B]">+{stat.add}</span> <span className="text-[#C4321F]">−{stat.del}</span>
          </span>
        )}
        {a.type === 'run' && d?.exitCode !== undefined && d.exitCode !== null && (
          <span className={`shrink-0 rounded-full px-1.5 font-mono text-[10.5px] ${d.exitCode === 0 ? 'bg-[#E3F6E8] text-[#1A7F45]' : 'bg-[#FDECEC] text-[#B42318]'}`}>exit {d.exitCode}</span>
        )}
        <IconChevronDown size={12} className={`shrink-0 text-ink-3 opacity-0 transition group-hover:opacity-100 ${open ? 'rotate-180 opacity-100' : ''}`} />
      </button>
      {open && (
        <div className="mt-1 mb-2 ml-[22px]">
          <ActivityDetailView a={a} />
        </div>
      )}
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
        <span className="flex-1">其他事件（{others.length}）· 未专门适配的结构化输出，原样保留</span>
        <IconChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="ml-[22px] space-y-0.5 pb-1">
          {others.map((o, i) => (
            <div key={i}>
              <button onClick={() => setPick(pick === i ? null : i)} className="flex w-full items-center gap-2 rounded px-1.5 py-px text-left font-mono text-[11.5px] text-ink-2 hover:bg-black/[0.035]">
                <span className="min-w-0 flex-1 truncate">{o.kind}</span>
                <span className="shrink-0 text-[10.5px] text-ink-3">{o.payload.length} 字符</span>
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

export function ActivityBar({ items, others, live }: { items: Activity[]; others: { kind: string; payload: string }[]; live: boolean }) {
  const [open, setOpen] = useState(false)
  const running = [...items].reverse().find((i) => i.status === 'running')
  const current = live ? (running ?? items[items.length - 1]) : null
  const errors = items.filter((i) => i.status === 'error').length
  const summary = (['read', 'write', 'run', 'search', 'tool'] as const)
    .map((t) => {
      const xs = items.filter((i) => i.type === t)
      if (!xs.length) return null
      // single write: show the path, it's usually what the user cares about
      return t === 'write' && xs.length === 1 ? `写入 ${xs[0].target.split('/').pop()}` : `${ACT[t].verb}了 ${xs.length} ${ACT[t].unit}`
    })
    .filter(Boolean)
    .join(' · ')
  if (!items.length && !others.length) return null
  return (
    <div className="mb-3 overflow-hidden rounded-xl bg-black/[0.035]">
      <button onClick={() => setOpen((o) => !o)} className="flex h-8 w-full items-center gap-2 px-3 text-left text-[12px] text-ink-2 transition-colors hover:bg-black/[0.025]">
        {current ? <Spinner size={12} className="text-accent" /> : <IconTerminal size={13} className="text-ink-3" />}
        <span className="min-w-0 flex-1 truncate">{current ? `正在${ACT[current.type]?.verb ?? ''} ${current.target}` : summary || `其他事件 ${others.length} 条`}</span>
        {errors > 0 && <span className="shrink-0 rounded-full bg-[#FDECEC] px-1.5 text-[11px] text-[#B42318]">{errors} 个失败</span>}
        <span className="shrink-0 text-ink-3">{open ? '收起' : '展开过程'}</span>
        <IconChevronDown size={13} className={`shrink-0 text-ink-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="border-t border-black/[0.05] px-1.5 py-1.5">
          {items.map((a, i) => (
            <ActivityRow key={a.id ?? i} a={a} />
          ))}
          {others.length > 0 && <OthersRow others={others} />}
        </div>
      )}
    </div>
  )
}

// ---- usage footer ---------------------------------------------------------------------------

export function UsageLine({ usage, ms }: { usage: Usage | null | undefined; ms: number | null }) {
  const u = usage ?? {}
  const parts: string[] = []
  if (ms) parts.push(fmtSec(ms))
  if (u.input !== undefined || u.output !== undefined) {
    parts.push(`输入 ${fmtNum(u.input ?? 0)}`)
    parts.push(`输出 ${fmtNum(u.output ?? 0)}${u.reasoning ? `（思考 ${fmtNum(u.reasoning)}）` : ''}`)
  }
  if (u.cacheRead || u.cacheWrite) parts.push(`缓存 读 ${fmtNum(u.cacheRead ?? 0)}${u.cacheWrite ? ` / 写 ${fmtNum(u.cacheWrite)}` : ''}`)
  if (typeof u.costUsd === 'number') parts.push(`$${u.costUsd < 0.01 ? u.costUsd.toFixed(4) : u.costUsd.toFixed(3)}`)
  if (!parts.length) return null
  return (
    <span className="text-[11px] text-ink-3/70 tabular-nums" title="tokens：输入不含缓存命中部分">
      {parts.join(' · ')}
    </span>
  )
}
