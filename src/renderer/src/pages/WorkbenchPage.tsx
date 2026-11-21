import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ProfileId, ProfileState } from '@shared/types'
import { useApp } from '../state/AppContext'
import { KIND_META, accountBadge, isReady } from '../lib/ui'
import { KindAvatar } from '../components/common'
import { Markdown } from '../components/Markdown'
import {
  IconArrowRight,
  IconArrowUp,
  IconAt,
  IconCheck,
  IconChevronDown,
  IconCompose,
  IconCopy,
  IconFile,
  IconFolder,
  IconPlus,
  IconReturn,
  IconStop,
  IconTerminal,
  IconX,
  Spinner
} from '../components/icons'
import {
  isBusy,
  newConversation,
  plainExcerpt,
  send,
  stop,
  toAttachment,
  useChat,
  type Activity,
  type Agent,
  type AssistantMessage,
  type Attachment,
  type Handoff,
  type UserMessage
} from '../state/chat'

const LS_KEY = 'agentmux.workbench.v1'

interface UiState {
  projectDir: string | null
  agentId: ProfileId | null
}

function loadUi(): UiState {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) ?? '')
    return { projectDir: v.projectDir ?? null, agentId: v.agentId ?? null }
  } catch {
    return { projectDir: null, agentId: null }
  }
}

const shortPath = (p: string) => p.replace(/^\/Users\/[^/]+/, '~')
const baseName = (p: string) => p.split('/').filter(Boolean).pop() ?? p
const toAgent = (p: ProfileState): Agent => ({ profileId: p.id, name: p.name, kind: p.kind })
const fmtDur = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} 秒` : `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`)

const pill =
  'flex h-9 items-center gap-2 rounded-full bg-white px-4 text-[14px] font-medium text-ink shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.04)] transition-colors hover:bg-[#FAFAFB] active:scale-[0.98]'
const popover = 'rounded-2xl bg-white/95 p-1.5 shadow-[0_0_0_1px_rgba(0,0,0,0.07),0_12px_40px_rgba(0,0,0,0.16)] backdrop-blur-xl'

/** Accounts sorted: ready first, then by kind order, then creation. */
function useSortedAccounts(): ProfileState[] {
  const { profiles } = useApp()
  return useMemo(() => {
    const order = { claude: 0, codex: 1, gemini: 2 } as const
    return [...profiles].sort((a, b) => Number(isReady(b)) - Number(isReady(a)) || order[a.kind] - order[b.kind] || a.createdAt - b.createdAt)
  }, [profiles])
}

export function WorkbenchPage() {
  const { byId, profiles } = useApp()
  const chat = useChat()
  const [ui, setUi] = useState<UiState>(loadUi)
  useEffect(() => localStorage.setItem(LS_KEY, JSON.stringify(ui)), [ui])
  const [handoff, setHandoff] = useState<Handoff | null>(null)
  const [focusAt, setFocusAt] = useState(0)

  const sorted = useSortedAccounts()
  const agent = (ui.agentId && byId(ui.agentId)) || sorted.find(isReady) || sorted[0] || null
  const setAgent = (id: ProfileId) => setUi((u) => ({ ...u, agentId: id }))

  const pickProject = async () => {
    const dir = await window.agentmux.sys.pickDirectory(ui.projectDir ?? undefined, '选择目标项目文件夹')
    if (dir) setUi((u) => ({ ...u, projectDir: dir }))
  }

  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [chat.messages])

  const [composerH, setComposerH] = useState(150)
  const empty = chat.messages.length === 0

  return (
    <div className="relative flex h-full flex-col">
      <div className="drag flex h-14 shrink-0 items-center gap-2.5 px-8">
        <button onClick={() => void pickProject()} className={pill + ' max-w-[320px] min-w-0'} title={ui.projectDir ? shortPath(ui.projectDir) : '模型在这个文件夹中读写文件'}>
          <IconFolder size={16} className="shrink-0 text-accent" />
          <span className={`truncate ${ui.projectDir ? '' : 'text-ink-2'}`}>{ui.projectDir ? baseName(ui.projectDir) : '选择项目文件夹…'}</span>
        </button>
        <div className="flex-1" />
        <button
          onClick={() => {
            newConversation()
            setHandoff(null)
          }}
          disabled={empty}
          className={pill + ' disabled:pointer-events-none disabled:opacity-45'}
          title="清空当前对话"
        >
          <IconCompose size={16} className="text-ink-2" />
          新对话
        </button>
      </div>

      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        <div className="mx-auto flex min-h-full max-w-[800px] flex-col px-8 pt-2" style={{ paddingBottom: composerH + 28 }}>
          {empty ? (
            <EmptyState
              projectDir={ui.projectDir}
              onPickProject={() => void pickProject()}
              selected={agent?.id ?? null}
              onSelect={(id) => {
                setAgent(id)
                setFocusAt(Date.now())
              }}
            />
          ) : (
            <div className="space-y-7">
              {chat.messages.map((m) =>
                m.role === 'user' ? (
                  <UserBubble key={m.id} msg={m} />
                ) : (
                  <AssistantBlock
                    key={m.id}
                    msg={m}
                    others={profiles.filter((p) => p.id !== m.agent.profileId)}
                    onHandoff={(to) => {
                      setAgent(to.id)
                      setHandoff({ messageId: m.id, from: m.agent, excerpt: m.content.slice(0, 600) })
                      setFocusAt(Date.now())
                    }}
                  />
                )
              )}
            </div>
          )}
        </div>
      </div>

      <Composer
        agent={agent}
        onAgent={setAgent}
        handoff={handoff}
        onClearHandoff={() => setHandoff(null)}
        busy={isBusy(chat)}
        followUp={!empty}
        focusAt={focusAt}
        onHeight={setComposerH}
        onSend={(text, attachments) => {
          stick.current = true
          send({ text, attachments, to: toAgent(agent!), handoff })
          setHandoff(null)
        }}
        onStop={stop}
      />
    </div>
  )
}

// ---- empty state ---------------------------------------------------------------------

function EmptyState({
  projectDir,
  onPickProject,
  selected,
  onSelect
}: {
  projectDir: string | null
  onPickProject: () => void
  selected: ProfileId | null
  onSelect: (id: ProfileId) => void
}) {
  const { navigate } = useApp()
  const ready = useSortedAccounts().filter(isReady)
  return (
    <div className="flex flex-1 flex-col items-center justify-center pb-8 text-center">
      <div className="text-[28px] leading-tight font-semibold tracking-tight text-ink">选择项目，随时调度你的 AI 团队</div>
      <div className="mt-2.5 text-[14px] text-ink-2">
        {projectDir ? (
          <>
            当前项目 <span className="font-medium text-ink">{baseName(projectDir)}</span>
          </>
        ) : (
          <button className="text-accent hover:text-accent-hover" onClick={onPickProject}>
            先选择一个项目文件夹
          </button>
        )}
        <span className="mx-1.5 text-ink-3">·</span>每一轮都可以换一个模型来回答
      </div>

      {ready.length ? (
        <div className="mt-8 flex max-w-[640px] flex-wrap justify-center gap-2">
          {ready.map((p) => (
            <button
              key={p.id}
              onClick={() => onSelect(p.id)}
              className={`flex h-9 items-center gap-2 rounded-full bg-white pr-3.5 pl-1.5 text-[13px] font-medium text-ink transition-all active:scale-[0.98] ${
                p.id === selected ? 'shadow-[0_0_0_1.5px_var(--accent),0_1px_3px_rgba(0,0,0,0.06)]' : 'shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.04)] hover:bg-[#FAFAFB]'
              }`}
              title={`使用 ${p.name}`}
            >
              <KindAvatar kind={p.kind} size={24} />
              {p.name}
            </button>
          ))}
        </div>
      ) : (
        <button className="mt-8 flex items-center gap-1 text-[14px] font-medium text-accent hover:text-accent-hover" onClick={() => navigate('engines')}>
          还没有就绪的模型，去添加账号 <IconArrowRight size={15} />
        </button>
      )}
    </div>
  )
}

// ---- messages ----------------------------------------------------------------------------

function UserBubble({ msg }: { msg: UserMessage }) {
  const images = msg.attachments.filter((a) => a.isImage && a.thumb)
  const files = msg.attachments.filter((a) => !(a.isImage && a.thumb))
  return (
    <div className="flex flex-col items-end gap-1.5 pl-24">
      <div className="flex items-center gap-1 text-[12px] text-ink-3">
        发给 <KindAvatar kind={msg.to.kind} size={14} /> {msg.to.name}
      </div>
      {msg.handoff && (
        <div className="max-w-[480px] rounded-2xl bg-black/[0.035] px-3.5 py-2.5 text-left">
          <div className="flex items-center gap-1.5 text-[12px] font-medium text-ink-2">
            <IconReturn size={13} className="-scale-x-100" /> 引用 {msg.handoff.from.name} 的回复
          </div>
          <div className="mt-1 line-clamp-2 text-[13px] leading-[19px] text-ink-2">{plainExcerpt(msg.handoff.excerpt)}</div>
        </div>
      )}
      {images.length > 0 && (
        <div className="flex flex-wrap justify-end gap-2">
          {images.map((a) => (
            <img key={a.id} src={a.thumb!} title={a.path ?? a.name} className="h-20 w-20 rounded-xl object-cover shadow-[0_0_0_1px_rgba(0,0,0,0.06)]" />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap justify-end gap-2">
          {files.map((a) => (
            <FileChip key={a.id} a={a} />
          ))}
        </div>
      )}
      {msg.text && <div className="max-w-full rounded-[20px] rounded-br-md bg-accent px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-white select-text">{msg.text}</div>}
    </div>
  )
}

function FileChip({ a, onRemove }: { a: Attachment; onRemove?: () => void }) {
  return (
    <span className="flex h-10 max-w-[220px] items-center gap-2 rounded-xl bg-white pr-2 pl-2.5 text-[12px] text-ink shadow-[0_0_0_1px_rgba(0,0,0,0.07)]" title={a.path ?? a.name}>
      <IconFile size={16} className="shrink-0 text-ink-2" />
      <span className="min-w-0 truncate">{a.name}</span>
      {onRemove && (
        <button onClick={onRemove} className="rounded-full p-0.5 text-ink-3 hover:bg-fill hover:text-ink">
          <IconX size={12} />
        </button>
      )}
    </span>
  )
}

function useTicker(active: boolean) {
  const [, setN] = useState(0)
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setN((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [active])
}

function AssistantBlock({ msg, others, onHandoff }: { msg: AssistantMessage; others: ProfileState[]; onHandoff: (to: ProfileState) => void }) {
  const streaming = msg.status === 'streaming'
  useTicker(streaming)
  const [copied, setCopied] = useState(false)
  const meta = KIND_META[msg.agent.kind]
  const copy = async () => {
    await window.agentmux.sys.copy(msg.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  return (
    <div className="group/msg pr-10">
      <div className="mb-2 flex items-center gap-2">
        <KindAvatar kind={msg.agent.kind} size={26} />
        <span className="text-[14px] font-semibold text-ink">{msg.agent.name}</span>
        <span className="text-[12px] text-ink-3">{meta.cli}</span>
        <span className="text-[12px] text-ink-3">·</span>
        {streaming ? (
          <span className="flex items-center gap-1.5 text-[12px] text-accent">
            <Spinner size={11} /> 正在回复 {fmtDur(Date.now() - msg.startedAt)}
          </span>
        ) : (
          <span className="text-[12px] text-ink-3">
            {msg.status === 'stopped' ? '已停止 · ' : ''}用时 {fmtDur((msg.endedAt ?? Date.now()) - msg.startedAt)}
          </span>
        )}
      </div>

      <div className="rounded-[20px] rounded-tl-md bg-white px-5 py-4 shadow-[0_0_0_1px_rgba(0,0,0,0.05),0_1px_3px_rgba(0,0,0,0.04)]">
        {msg.activity.length > 0 && <ActivityBar items={msg.activity} live={streaming && !msg.content} />}
        {msg.content ? (
          <Markdown text={msg.content} />
        ) : streaming ? (
          msg.activity.length === 0 && (
            <div className="flex h-6 items-center gap-1">
              {[0, 1, 2].map((i) => (
                <span key={i} className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-3" style={{ animationDelay: `${i * 160}ms` }} />
              ))}
            </div>
          )
        ) : (
          <div className="text-[14px] text-ink-3">没有输出</div>
        )}
        {streaming && msg.content && <span className="ml-0.5 inline-block h-4 w-[3px] translate-y-0.5 animate-pulse rounded-full bg-accent" />}
      </div>

      {!streaming && msg.content && (
        <div className="mt-1.5 flex items-center gap-1 pl-1">
          <button onClick={() => void copy()} className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12px] text-ink-2 transition-colors hover:bg-black/[0.05] hover:text-ink">
            {copied ? <IconCheck size={14} className="text-[#1A7F45]" /> : <IconCopy size={14} />}
            {copied ? '已复制' : '复制'}
          </button>
          <HandoffMenu others={others} onPick={onHandoff} />
        </div>
      )}
    </div>
  )
}

const ACT_LABEL: Record<Activity['type'], { verb: string; unit: string }> = {
  read: { verb: '读取', unit: '个文件' },
  write: { verb: '写入', unit: '个文件' },
  run: { verb: '执行', unit: '条命令' },
  search: { verb: '搜索', unit: '次' }
}

function ActivityBar({ items, live }: { items: Activity[]; live: boolean }) {
  const [open, setOpen] = useState(false)
  const counts = (['read', 'write', 'run', 'search'] as const).filter((t) => items.some((i) => i.type === t))
  const last = items[items.length - 1]
  return (
    <div className="mb-3 overflow-hidden rounded-xl bg-fill">
      <button onClick={() => setOpen((o) => !o)} className="flex h-9 w-full items-center gap-2 px-3 text-left text-[13px] text-ink-2 transition-colors hover:bg-black/[0.025]">
        {live ? <Spinner size={13} className="text-accent" /> : <IconTerminal size={14} className="text-ink-3" />}
        <span className="min-w-0 flex-1 truncate">
          {live
            ? `正在${ACT_LABEL[last.type].verb} ${last.target}`
            : counts.map((t) => `已${ACT_LABEL[t].verb} ${items.filter((i) => i.type === t).length} ${ACT_LABEL[t].unit}`).join(' · ')}
        </span>
        <span className="shrink-0 text-[12px] text-ink-3">{open ? '收起' : '展开过程'}</span>
        <IconChevronDown size={14} className={`shrink-0 text-ink-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="border-t border-black/[0.05] px-3 py-2">
          {items.map((a, i) => (
            <div key={i} className="flex items-baseline gap-2.5 py-0.5 text-[12px] leading-5">
              <span className="w-8 shrink-0 text-ink-3">{ACT_LABEL[a.type].verb}</span>
              <span className="min-w-0 font-mono break-all text-ink-2 select-text">{a.target}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function HandoffMenu({ others, onPick }: { others: ProfileState[]; onPick: (p: ProfileState) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={!others.length}
        className={`flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12px] text-ink-2 transition-colors hover:bg-black/[0.05] hover:text-ink disabled:opacity-40 ${open ? 'bg-black/[0.05] text-ink' : ''}`}
        title={others.length ? '把这条回复作为上下文，交给另一个模型继续' : '没有其他账号'}
      >
        <IconReturn size={14} className="-scale-x-100" />
        转交给其他模型…
      </button>
      {open && (
        <div className={popover + ' absolute bottom-9 left-0 z-20 w-60'}>
          <div className="px-2.5 pt-1 pb-1.5 text-[12px] text-ink-3">带着这条回复，交给</div>
          {others.map((p) => (
            <AccountRow
              key={p.id}
              p={p}
              onClick={() => {
                setOpen(false)
                onPick(p)
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function AccountRow({ p, active, selected, onClick }: { p: ProfileState; active?: boolean; selected?: boolean; onClick: () => void }) {
  const badge = accountBadge(p)
  return (
    <button
      onMouseDown={(e) => e.preventDefault() /* keep textarea focus */}
      onClick={onClick}
      className={`flex h-10 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-left transition-colors ${active ? 'bg-accent/10' : 'hover:bg-black/[0.04]'}`}
    >
      <KindAvatar kind={p.kind} size={24} />
      <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{p.name}</span>
      {isReady(p) ? (
        selected && <IconCheck size={15} className="text-accent" />
      ) : (
        <span className="flex items-center gap-1 text-[11px] text-ink-3">
          <span className={`h-1.5 w-1.5 rounded-full ${badge.dot}`} />
          {badge.label}
        </span>
      )}
    </button>
  )
}

// ---- composer ------------------------------------------------------------------------------

function AgentPicker({ agent, onAgent }: { agent: ProfileState | null; onAgent: (id: ProfileId) => void }) {
  const { navigate } = useApp()
  const accounts = useSortedAccounts()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  const ready = isReady(agent ?? undefined)

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex h-8 items-center gap-2 rounded-full pr-2.5 pl-1 text-[13px] font-medium text-ink transition-colors hover:bg-fill ${open ? 'bg-fill' : ''}`}
        title="选择这一轮由哪个模型回答（也可以输入 @）"
      >
        {agent ? <KindAvatar kind={agent.kind} size={22} /> : <span className="h-[22px] w-[22px] rounded-[6px] border border-dashed border-black/20" />}
        <span className="max-w-[160px] truncate">{agent?.name ?? '选择模型'}</span>
        {agent && <span className={`h-1.5 w-1.5 rounded-full ${ready ? 'bg-[#34C759]' : 'bg-[#FF9F0A]'}`} />}
        <IconChevronDown size={14} className="text-ink-3" />
      </button>
      {open && (
        <div className={popover + ' absolute bottom-10 left-0 z-30 w-64'}>
          {accounts.length === 0 && <div className="px-3 py-3 text-[13px] text-ink-2">还没有添加任何账号</div>}
          {accounts.map((p) => (
            <AccountRow
              key={p.id}
              p={p}
              selected={p.id === agent?.id}
              active={p.id === agent?.id}
              onClick={() => {
                onAgent(p.id)
                setOpen(false)
              }}
            />
          ))}
          <div className="mx-2 my-1 h-px bg-hairline" />
          <button className="flex h-9 w-full items-center gap-2 rounded-[10px] px-2.5 text-[13px] text-ink-2 hover:bg-black/[0.04] hover:text-ink" onClick={() => navigate('engines')}>
            <IconPlus size={15} /> 管理模型与账号…
          </button>
        </div>
      )}
    </div>
  )
}

function Composer({
  agent,
  onAgent,
  handoff,
  onClearHandoff,
  busy,
  followUp,
  focusAt,
  onHeight,
  onSend,
  onStop
}: {
  agent: ProfileState | null
  onAgent: (id: ProfileId) => void
  handoff: Handoff | null
  onClearHandoff: () => void
  busy: boolean
  followUp: boolean
  focusAt: number
  onHeight: (h: number) => void
  onSend: (text: string, attachments: Attachment[]) => void
  onStop: () => void
}) {
  const { toast, navigate } = useApp()
  const accounts = useSortedAccounts()
  const [text, setText] = useState('')
  const [atts, setAtts] = useState<Attachment[]>([])
  const [drag, setDrag] = useState(false)
  const [mention, setMention] = useState<{ start: number; query: string; index: number } | null>(null)
  const ta = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const wrap = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }, [text])

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(() => onHeight(el.offsetHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [onHeight])

  useEffect(() => ta.current?.focus(), [focusAt])

  const matches = useMemo(() => {
    if (!mention) return []
    const q = mention.query.toLowerCase()
    // account / model name beats CLI name ("cod" -> Codex before "Claude Code")
    const score = (p: ProfileState) => {
      const name = p.name.toLowerCase()
      const kind = KIND_META[p.kind].name.toLowerCase()
      if (name.startsWith(q) || kind.startsWith(q)) return 0
      if (name.includes(q) || kind.includes(q)) return 1
      if (KIND_META[p.kind].cli.toLowerCase().includes(q)) return 2
      return -1
    }
    return accounts
      .map((p, i) => ({ p, s: score(p), i }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => a.s - b.s || a.i - b.i)
      .map((x) => x.p)
  }, [mention, accounts])

  /** Opens the @ list when the caret sits right after `@query` at a word start. */
  const syncMention = (value: string, caret: number) => {
    const m = /(^|\s)@([^\s@]{0,24})$/.exec(value.slice(0, caret))
    setMention(m ? { start: caret - m[2].length - 1, query: m[2], index: 0 } : null)
  }

  const pickMention = (p: ProfileState) => {
    if (!mention) return
    const caret = ta.current?.selectionStart ?? text.length
    const next = (text.slice(0, mention.start) + text.slice(caret)).replace(/^\s+/, '')
    setText(next)
    setMention(null)
    onAgent(p.id)
    requestAnimationFrame(() => {
      const el = ta.current
      if (!el) return
      const pos = Math.min(mention.start, next.length)
      el.focus()
      el.setSelectionRange(pos, pos)
    })
  }

  const addFiles = async (files: File[]) => {
    if (!files.length) return
    const next = await Promise.all(files.map(toAttachment))
    setAtts((a) => [...a, ...next].slice(0, 12))
  }

  const canSend = !busy && !!agent && (text.trim().length > 0 || atts.length > 0)
  const doSend = () => {
    if (busy) return toast({ kind: 'info', title: '上一条还在回复', desc: '等它完成，或点击停止后再发送。' })
    if (!agent) return toast({ kind: 'warn', title: '还没有可用的模型', action: { label: '添加账号', run: () => navigate('engines') } })
    if (!text.trim() && !atts.length) return
    if (!isReady(agent))
      return toast({
        kind: 'warn',
        title: `${agent.name} 还不能使用`,
        desc: accountBadge(agent).label,
        action: { label: agent.status === 'uninstalled' ? '去安装' : '去登录', run: () => navigate('engines', agent.id) }
      })
    onSend(text.trim(), atts)
    setText('')
    setAtts([])
  }

  return (
    <div ref={wrap} className="pointer-events-none absolute inset-x-0 bottom-0 bg-[linear-gradient(to_bottom,transparent,var(--canvas)_42%)] px-8 pt-8 pb-6">
      <div className="pointer-events-auto relative mx-auto max-w-[800px]">
        {/* @ mention list */}
        {mention && (
          <div className={popover + ' absolute bottom-full left-0 z-30 mb-2 w-72'}>
            <div className="flex items-center gap-1.5 px-2.5 pt-1 pb-1.5 text-[12px] text-ink-3">
              <IconAt size={13} /> 这一轮交给
            </div>
            {matches.length ? (
              matches.map((p, i) => <AccountRow key={p.id} p={p} active={i === mention.index} selected={p.id === agent?.id} onClick={() => pickMention(p)} />)
            ) : (
              <div className="px-2.5 py-2 text-[13px] text-ink-3">没有匹配的账号</div>
            )}
          </div>
        )}

        <div
          className={`rounded-[24px] bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_4px_12px_rgba(0,0,0,0.05),0_16px_40px_rgba(0,0,0,0.08)] transition-shadow ${
            drag ? 'shadow-[0_0_0_2px_rgba(0,122,255,0.6),0_16px_40px_rgba(0,0,0,0.08)]' : ''
          }`}
          onDragOver={(e) => {
            e.preventDefault()
            setDrag(true)
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDrag(false)
            void addFiles([...e.dataTransfer.files])
          }}
        >
          {handoff && (
            <div className="mx-3 mt-3 flex items-start gap-2.5 rounded-2xl bg-fill px-3.5 py-2.5">
              <IconReturn size={14} className="mt-0.5 shrink-0 -scale-x-100 text-ink-3" />
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-medium text-ink-2">引用 {handoff.from.name} 的回复，作为这一轮的上下文</div>
                <div className="mt-0.5 truncate text-[12px] text-ink-3">{plainExcerpt(handoff.excerpt)}</div>
              </div>
              <button onClick={onClearHandoff} className="rounded-full p-1 text-ink-3 hover:bg-black/[0.06] hover:text-ink" title="移除引用">
                <IconX size={12} />
              </button>
            </div>
          )}

          {atts.length > 0 && (
            <div className="flex flex-wrap gap-2 px-4 pt-4">
              {atts.map((a) =>
                a.isImage && a.thumb ? (
                  <span key={a.id} className="group relative" title={a.path ?? a.name}>
                    <img src={a.thumb} className="h-16 w-16 rounded-xl object-cover shadow-[0_0_0_1px_rgba(0,0,0,0.07)]" />
                    <button
                      onClick={() => setAtts((x) => x.filter((y) => y.id !== a.id))}
                      className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-[#1C1C1E] text-white opacity-0 shadow transition-opacity group-hover:opacity-100"
                      title="移除"
                    >
                      <IconX size={11} strokeWidth={2.4} />
                    </button>
                  </span>
                ) : (
                  <FileChip key={a.id} a={a} onRemove={() => setAtts((x) => x.filter((y) => y.id !== a.id))} />
                )
              )}
            </div>
          )}

          <textarea
            ref={ta}
            rows={1}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              syncMention(e.target.value, e.target.selectionStart)
            }}
            onSelect={(e) => mention && syncMention(e.currentTarget.value, e.currentTarget.selectionStart)}
            onBlur={() => setMention(null)}
            onKeyDown={(e) => {
              const composing = e.nativeEvent.isComposing || e.keyCode === 229
              if (mention && !composing) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  const d = e.key === 'ArrowDown' ? 1 : -1
                  setMention((m) => m && { ...m, index: (m.index + d + Math.max(1, matches.length)) % Math.max(1, matches.length) })
                  return
                }
                if ((e.key === 'Enter' || e.key === 'Tab') && matches.length) {
                  e.preventDefault()
                  pickMention(matches[Math.min(mention.index, matches.length - 1)])
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setMention(null)
                  return
                }
              }
              // IME (Chinese input) confirms candidates with Enter -> never send mid-composition
              if (e.key === 'Enter' && !e.shiftKey && !composing) {
                e.preventDefault()
                doSend()
              }
            }}
            onPaste={(e) => {
              const files = [...e.clipboardData.files]
              if (files.length) {
                e.preventDefault()
                void addFiles(files)
              }
            }}
            placeholder={
              agent
                ? `${followUp ? '继续追问' : '描述你的任务'}，交给 ${agent.name}…  输入 @ 切换模型`
                : '先在「模型引擎」添加一个账号'
            }
            className="block max-h-[200px] w-full resize-none bg-transparent px-5 pt-4 pb-1 text-[15px] leading-[22px] text-ink outline-none placeholder:text-ink-3"
          />

          <div className="flex items-center gap-1 px-3 pt-1 pb-3">
            <AgentPicker agent={agent} onAgent={onAgent} />
            <div className="mx-1 h-4 w-px bg-black/[0.08]" />
            <button
              onClick={() => fileInput.current?.click()}
              className="flex h-8 w-8 items-center justify-center rounded-full text-ink-2 transition-colors hover:bg-fill hover:text-ink"
              title="添加参考图或文件（也可以拖入或粘贴）"
            >
              <IconPlus size={17} />
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                void addFiles([...(e.target.files ?? [])])
                e.target.value = ''
              }}
            />
            <div className="flex-1" />
            {busy ? (
              <button onClick={onStop} className="flex h-8 w-8 items-center justify-center rounded-full bg-[#1C1C1E] text-white transition-transform active:scale-95" title="停止">
                <IconStop size={14} />
              </button>
            ) : (
              <button
                onClick={doSend}
                disabled={!canSend}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-white shadow-[0_1px_2px_rgba(0,122,255,0.35)] transition-all hover:bg-accent-hover active:scale-95 disabled:bg-black/[0.08] disabled:text-ink-3 disabled:shadow-none"
                title="发送（Enter）"
              >
                <IconArrowUp size={17} strokeWidth={2.2} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
