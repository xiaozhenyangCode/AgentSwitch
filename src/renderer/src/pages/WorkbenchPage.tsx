import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ModelOption, ProfileId, ProfileState } from '@shared/types'
import { useApp } from '../state/AppContext'
import { KIND_META, accountBadge, isReady } from '../lib/ui'
import { DEFAULT_HINT, effectiveModel, modelLabel, resolveSpec, withEffort } from '../lib/models'
import { KindAvatar } from '../components/common'
import { EffortBar } from '../components/EffortBar'
import { ActivityBar, ThinkingCard, UsageLine } from '../components/Process'
import { Markdown, MarkdownBase, ZoomImage } from '../components/Markdown'
import { IconAlert, IconArrowRight, IconArrowUp, IconAt, IconCheck, IconChevronDown, IconCopy, IconFile, IconFolder, IconPlus, IconRefresh, IconStop, IconTerminal, IconX, Spinner } from '../components/icons'
import { IMAGE_RE, baseName as fileBase, fileUrl } from '../lib/fileUrl'
import { findModel, getModelList, loadModels, useModels, useModelsVersion } from '../state/models'
import {
  activeThread,
  exportHandoff,
  isThreadBusy,
  lastSpeaker,
  loadHistory,
  newThread,
  sessionAccounts,
  skipHandoff,
  threadMessages,
  resolvePause,
  send,
  stop,
  toAttachment,
  updateThread,
  useChat,
  type Activity,
  type AgentRef,
  type AssistantMessage,
  type Attachment,
  type Thread,
  type UserMessage
} from '../state/chat'

type Ctx = Pick<Thread, 'projectDir' | 'participants' | 'driver'>
const DRAFT_KEY = 'agentmux.draft.v1'

const shortPath = (p: string) => p.replace(/^\/Users\/[^/]+/, '~')
const baseName = (p: string) => p.split('/').filter(Boolean).pop() ?? p
const fmtDur = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} 秒` : `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`)
const pad2 = (n: number) => String(n).padStart(2, '0')
/** Message time: today HH:mm · 昨天 HH:mm · MM-DD HH:mm (hover: full). */
function msgTime(ts: number): string {
  const d = new Date(ts)
  const day = new Date()
  day.setHours(0, 0, 0, 0)
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  if (ts >= day.getTime()) return hm
  if (ts >= day.getTime() - 86400_000) return `昨天 ${hm}`
  return `${d.getFullYear() !== day.getFullYear() ? d.getFullYear() + '-' : ''}${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`
}
const fullTime = (ts: number) => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const pill =
  'flex h-9 items-center gap-2 rounded-full bg-white px-4 text-[14px] font-medium text-ink shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.04)] transition-colors hover:bg-[#FAFAFB] active:scale-[0.98]'
const popover = 'rounded-2xl bg-white/95 p-1.5 shadow-[0_0_0_1px_rgba(0,0,0,0.07),0_12px_40px_rgba(0,0,0,0.16)] backdrop-blur-xl'

function useOutside<T extends HTMLElement>(open: boolean, close: () => void) {
  const ref = useRef<T>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close()
    window.addEventListener('mousedown', h)
    return () => window.removeEventListener('mousedown', h)
  }, [open, close])
  return ref
}

/** Accounts sorted: ready first, then kind order, then creation. */
function useSortedAccounts(): ProfileState[] {
  const { profiles } = useApp()
  return useMemo(() => {
    const order = { claude: 0, codex: 1, gemini: 2 } as const
    return [...profiles].sort((a, b) => Number(isReady(b)) - Number(isReady(a)) || order[a.kind] - order[b.kind] || a.createdAt - b.createdAt)
  }, [profiles])
}

/** `@Name` or `@Name(model)` tokens for the given accounts, in text order. */
function parseMentions(text: string, accounts: ProfileState[]): { p: ProfileState; model: string | null; index: number; length: number }[] {
  const out: { p: ProfileState; model: string | null; index: number; length: number }[] = []
  const taken: [number, number][] = []
  for (const p of [...accounts].sort((a, b) => b.name.length - a.name.length)) {
    const re = new RegExp('@' + escapeRe(p.name) + '(?:\\(([^)\\s]+)\\))?', 'g')
    for (const m of text.matchAll(re)) {
      const s = m.index!
      if (taken.some(([a, b]) => s >= a && s < b)) continue
      taken.push([s, s + m[0].length])
      out.push({ p, model: m[1] ?? null, index: s, length: m[0].length })
    }
  }
  return out.sort((a, b) => a.index - b.index)
}

export function WorkbenchPage() {
  const { byId, profiles, info } = useApp()
  const chat = useChat()
  const thread = activeThread(chat)
  const sorted = useSortedAccounts()

  // settings for a conversation that hasn't been created yet (no thread selected)
  const [draft, setDraft] = useState<Ctx>(() => {
    try {
      return JSON.parse(localStorage.getItem(DRAFT_KEY) ?? '')
    } catch {
      return { projectDir: null, participants: [], driver: { profileId: null, model: null } }
    }
  })
  useEffect(() => localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)), [draft])

  const ctx: Ctx = thread ?? draft
  const update = (patch: Partial<Ctx>) => (thread ? updateThread(thread.id, patch) : setDraft((d) => ({ ...d, ...patch })))

  // participants default to every ready account when unset
  const participants = ctx.participants.length ? ctx.participants.filter((id) => byId(id)) : sorted.filter(isReady).map((p) => p.id)
  const driverP = (ctx.driver.profileId && byId(ctx.driver.profileId)) || sorted.find((p) => participants.includes(p.id) && isReady(p)) || sorted[0]
  const driverModel = ctx.driver.profileId === driverP?.id ? ctx.driver.model : null
  const setDriver = (id: ProfileId, model: string | null) =>
    update({ driver: { profileId: id, model }, participants: participants.includes(id) ? participants : [...participants, id] })

  const pickProject = async () => {
    const dir = await window.agentmux.sys.pickProject(ctx.projectDir ?? undefined)
    if (dir) update({ projectDir: dir })
  }

  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const messages = useMemo(() => threadMessages(thread), [thread])
  // imported history is not persisted: re-read it from the CLI files when the thread opens
  useEffect(() => {
    if (!thread?.imported || thread.history || thread.historyState) return
    const p = byId(thread.imported.profileId)
    if (!p) return // wait for account names (or the account was removed: nothing to resume with)
    void loadHistory(thread.id, { profileId: p.id, name: p.name, kind: p.kind, model: null })
  }, [thread?.id, thread?.imported, thread?.history, thread?.historyState, byId])

  // ---- cross-model handoff: the driver changed to an account with no session in this thread
  const speaker = thread ? lastSpeaker(thread) : null
  const srcP = speaker ? byId(speaker.profileId) : undefined
  const handoffNeeded =
    !!thread &&
    !!driverP &&
    !!speaker &&
    !isThreadBusy(thread) &&
    speaker.profileId !== driverP.id &&
    !sessionAccounts(thread).has(driverP.id) &&
    thread.handoff?.to !== driverP.id &&
    !(thread.handoffSkip ?? []).includes(driverP.id)
  const handoffReady = !!thread?.handoff && !!driverP && thread.handoff.to === driverP.id && !isThreadBusy(thread)
  const handoffFailed = !!thread?.handoffFailed && thread.handoffFailed.to === driverP?.id
  const srcOk = !!srcP && isReady(srcP)
  const [exporting, setExporting] = useState(false)
  const startHandoff = () => {
    if (!thread || !driverP || !srcP || !speaker) return
    stick.current = true
    send(thread.id, {
      text: `生成交接文档，交给 ${driverP.name}`,
      attachments: [],
      driver: { ...ref(srcP, null), model: speaker.model },
      mentions: [],
      participants,
      projectDir: ctx.projectDir,
      handoffTo: ref(driverP, driverModel)
    })
  }
  const doExport = async () => {
    if (!thread || !driverP) return
    setExporting(true)
    try {
      await exportHandoff(thread.id, ref(driverP, driverModel))
    } finally {
      setExporting(false)
    }
  }
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages])
  useEffect(() => {
    stick.current = true
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [thread?.id])

  const [composerH, setComposerH] = useState(150)
  const ref = (p: ProfileState, model: string | null): AgentRef => ({ profileId: p.id, name: p.name, kind: p.kind, model: effectiveModel(model, p) })

  const onSend = (text: string, attachments: Attachment[]) => {
    if (!driverP) return
    const found = parseMentions(text, profiles)
    const seen = new Set<string>()
    const mentions = found.filter((m) => !seen.has(m.p.id) && seen.add(m.p.id)).map((m) => ref(m.p, m.model))
    const joined = [...new Set([...participants, driverP.id, ...mentions.map((m) => m.profileId)])]
    let id = thread?.id
    if (!id) id = newThread({ ...ctx, participants: joined, driver: { profileId: driverP.id, model: driverModel } })
    else if (joined.length !== participants.length) updateThread(id, { participants: joined })
    stick.current = true
    send(id, { text, attachments, driver: ref(driverP, driverModel), mentions, participants: joined, projectDir: ctx.projectDir })
  }

  return (
    <div className="relative flex h-full flex-col">
      <div className="drag flex h-14 shrink-0 items-center gap-2.5 px-8">
        <button onClick={() => void pickProject()} className={pill + ' no-drag max-w-[340px] min-w-0'} title={ctx.projectDir ? shortPath(ctx.projectDir) : '这个对话里模型读写文件的位置'}>
          <IconFolder size={16} className="shrink-0 text-accent" />
          <span className={`truncate ${ctx.projectDir ? '' : 'text-ink-2'}`}>{ctx.projectDir ? baseName(ctx.projectDir) : '选择项目文件夹…'}</span>
          <IconChevronDown size={14} className="shrink-0 text-ink-3" />
        </button>
        <div className="flex-1" />
        <ParticipantsButton participants={participants} driverId={driverP?.id ?? null} onChange={(ids) => update({ participants: ids })} />
      </div>

      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        <div className="mx-auto flex min-h-full max-w-[820px] flex-col px-8 pt-2" style={{ paddingBottom: composerH + 28 }}>
          {thread?.imported && (
            <div className="mb-5 flex items-start gap-2 rounded-xl bg-black/[0.035] px-3.5 py-2.5 text-[12.5px] leading-relaxed text-ink-2">
              <KindAvatar kind={thread.imported.kind} size={16} />
              <span className="min-w-0 flex-1">
                从本机 CLI 历史导入（只读，不会改动原记录）· 用 {byId(thread.imported.profileId)?.name ?? '原账号'} 继续发送会接着原会话
                {thread.historyState === 'loading' && <span className="ml-1 text-ink-3">· 正在读取…</span>}
                {thread.historyState === 'error' && <span className="ml-1 text-[#A05A00]">· 历史读取失败</span>}
                {thread.imported.notice && <span className="block text-[#A05A00]">{thread.imported.notice}</span>}
              </span>
            </div>
          )}
          {messages.length === 0 ? (
            <EmptyState projectDir={ctx.projectDir} onPickProject={() => void pickProject()} participants={participants} />
          ) : (
            <div className="space-y-6">
              <MarkdownBase.Provider value={{ baseDir: thread?.workdir ?? ctx.projectDir, home: info?.realHome ?? null }}>
                {messages.map((m) => (m.role === 'user' ? <UserBubble key={m.id} msg={m} /> : <AssistantBlock key={m.id} msg={m} />))}
              </MarkdownBase.Provider>
            </div>
          )}
        </div>
      </div>

      <Composer
        driver={driverP ?? null}
        driverModel={driverModel}
        onDriver={setDriver}
        participants={participants}
        busy={isThreadBusy(thread)}
        threadId={thread?.id ?? null}
        onHeight={setComposerH}
        onSend={onSend}
        onStop={() => thread && stop(thread.id)}
      />
      {!thread?.pause && (handoffNeeded || handoffReady) && driverP && (
        <div className="pointer-events-none absolute inset-x-0 z-20 px-8" style={{ bottom: composerH - 8 }}>
          {handoffReady ? (
            <div className="pointer-events-auto mx-auto flex max-w-[820px] items-center gap-2.5 rounded-2xl bg-[#EEF5FF] px-4 py-2.5 text-[13px] text-[#0B4FA8] shadow-[0_0_0_1px_rgba(0,102,214,0.22),0_8px_24px_rgba(0,0,0,0.06)]">
              <IconCheck size={15} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                交接文档已就绪，下一条消息会同步给 <span className="font-semibold">{driverP.name}</span>
              </span>
              <button className="h-7 shrink-0 rounded-full px-3 font-medium hover:bg-black/[0.05]" onClick={() => void window.agentmux.sys.showInFolder(thread!.handoff!.path)} title={thread!.handoff!.path}>
                查看文档
              </button>
            </div>
          ) : (
            <div className="pointer-events-auto mx-auto flex max-w-[820px] items-center gap-2.5 rounded-2xl bg-white px-4 py-2.5 text-[13px] text-ink shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_8px_24px_rgba(0,0,0,0.08)]">
              <IconArrowRight size={15} className="shrink-0 text-accent" />
              <span className="min-w-0 flex-1">
                切换到 <span className="font-semibold">{driverP.name}</span> 需同步前文上下文
                {handoffFailed && <span className="block text-[12px] text-[#A05A00]">{srcP?.name ?? '原账号'} 生成交接失败{thread!.handoffFailed!.error === 'rate_limited' ? '（触发用量限制）' : ''}，可改为导出最近对话</span>}
                {!srcOk && !handoffFailed && <span className="block text-[12px] text-[#A05A00]">{srcP?.name ?? '原账号'} 当前不可用，可导出最近对话作为交接</span>}
              </span>
              {srcOk && !handoffFailed ? (
                <button className="h-7 shrink-0 rounded-full bg-accent px-3 font-medium text-white hover:bg-accent/90" onClick={startHandoff}>
                  让 {srcP!.name} 生成交接并切换
                </button>
              ) : (
                <button disabled={exporting} className="h-7 shrink-0 rounded-full bg-accent px-3 font-medium text-white hover:bg-accent/90 disabled:opacity-60" onClick={() => void doExport()}>
                  {exporting ? '导出中…' : '导出最近对话作为交接'}
                </button>
              )}
              <button className="h-7 shrink-0 rounded-full px-3 font-medium text-ink-2 hover:bg-black/[0.05]" onClick={() => skipHandoff(thread!.id, driverP.id)}>
                直接切换
              </button>
            </div>
          )}
        </div>
      )}
      {thread?.pause && (
        <div className="pointer-events-none absolute inset-x-0 z-20 px-8" style={{ bottom: composerH - 8 }}>
          <div className="pointer-events-auto mx-auto flex max-w-[820px] items-center gap-3 rounded-2xl bg-[#FFF6E5] px-4 py-3 text-[13px] text-[#8A5300] shadow-[0_0_0_1px_rgba(255,159,10,0.35),0_8px_24px_rgba(0,0,0,0.08)]">
            <IconAlert size={16} className="shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="font-semibold">需要人工介入</span> · {thread.pause.reason}
            </span>
            <button className="h-7 shrink-0 rounded-full bg-[#FF9F0A] px-3 font-medium text-white hover:bg-[#F29100]" onClick={() => resolvePause(thread.id, 'retry')}>
              再试一轮
            </button>
            <button className="h-7 shrink-0 rounded-full bg-white px-3 font-medium text-ink shadow-[0_0_0_1px_rgba(0,0,0,0.08)] hover:bg-[#FAFAFB]" onClick={() => resolvePause(thread.id, 'skip')}>
              跳过验收继续
            </button>
            <button className="h-7 shrink-0 rounded-full px-3 font-medium text-ink-2 hover:bg-black/[0.05]" onClick={() => resolvePause(thread.id, 'stop')}>
              结束本轮
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ---- header: participants ---------------------------------------------------------------

function ParticipantsButton({ participants, driverId, onChange }: { participants: ProfileId[]; driverId: ProfileId | null; onChange: (ids: ProfileId[]) => void }) {
  const { navigate } = useApp()
  const accounts = useSortedAccounts()
  const [open, setOpen] = useState(false)
  const ref = useOutside<HTMLDivElement>(open, () => setOpen(false))
  const active = accounts.filter((p) => participants.includes(p.id))

  return (
    <div ref={ref} className="no-drag relative">
      <button onClick={() => setOpen((o) => !o)} className={pill + ' gap-2.5 pr-3 pl-2'} title="这个对话允许调用的模型">
        <span className="flex -space-x-1">
          {active.slice(0, 5).map((p) => (
            <span key={p.id} className="rounded-[8px] ring-2 ring-white" title={p.name}>
              <KindAvatar kind={p.kind} size={22} />
            </span>
          ))}
          {active.length === 0 && <span className="h-[22px] w-[22px] rounded-[7px] border border-dashed border-black/20" />}
        </span>
        <span className="text-[13px] text-ink-2">{active.length} 个模型</span>
        <IconChevronDown size={14} className="text-ink-3" />
      </button>
      {open && (
        <div className={popover + ' absolute top-11 right-0 z-30 w-72'}>
          <div className="px-2.5 pt-1 pb-1.5 text-[12px] text-ink-3">这个对话可以调用的模型</div>
          {accounts.map((p) => {
            const ready = isReady(p)
            const on = participants.includes(p.id)
            const isDriver = p.id === driverId
            return (
              <button
                key={p.id}
                disabled={!ready || isDriver}
                onClick={() => onChange(on ? participants.filter((x) => x !== p.id) : [...participants, p.id])}
                className="flex h-10 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-left transition-colors enabled:hover:bg-black/[0.04] disabled:cursor-default"
                title={isDriver ? '主控账号始终参与' : undefined}
              >
                <span className={`flex h-[18px] w-[18px] items-center justify-center rounded-[5px] ${on && ready ? 'bg-accent text-white' : 'bg-white shadow-[inset_0_0_0_1.5px_rgba(0,0,0,0.18)]'} ${!ready ? 'opacity-40' : ''}`}>
                  {on && ready && <IconCheck size={12} strokeWidth={3} />}
                </span>
                <KindAvatar kind={p.kind} size={22} />
                <span className={`min-w-0 flex-1 truncate text-[14px] ${ready ? 'text-ink' : 'text-ink-3'}`}>{p.name}</span>
                {isDriver ? <span className="text-[11px] text-ink-3">主控</span> : !ready && <span className="text-[11px] text-ink-3">{accountBadge(p).label}</span>}
              </button>
            )
          })}
          <div className="mx-2 my-1 h-px bg-hairline" />
          <button className="flex h-9 w-full items-center gap-2 rounded-[10px] px-2.5 text-[13px] text-ink-2 hover:bg-black/[0.04] hover:text-ink" onClick={() => navigate('engines')}>
            <IconPlus size={15} /> 添加或登录账号…
          </button>
        </div>
      )}
    </div>
  )
}

// ---- empty state -------------------------------------------------------------------------

function EmptyState({ projectDir, onPickProject, participants }: { projectDir: string | null; onPickProject: () => void; participants: ProfileId[] }) {
  const { navigate } = useApp()
  const ready = useSortedAccounts().filter((p) => isReady(p) && participants.includes(p.id))
  return (
    <div className="flex flex-1 flex-col items-center justify-center pb-10 text-center">
      <div className="text-[28px] leading-tight font-semibold tracking-tight text-ink">选择项目，随时调度你的 AI 团队</div>
      <div className="mt-3 text-[14px] text-ink-2">
        {projectDir ? (
          <>
            项目 <span className="font-medium text-ink">{baseName(projectDir)}</span>
          </>
        ) : (
          <button className="text-accent hover:text-accent-hover" onClick={onPickProject}>
            选择项目文件夹
          </button>
        )}
        <span className="mx-1.5 text-ink-3">·</span>输入 <span className="rounded-md bg-black/[0.05] px-1.5 py-0.5 font-mono text-[13px] text-ink">@</span> 让多个模型协同
      </div>
      {ready.length ? (
        <div className="mt-8 flex items-center gap-1.5">
          {ready.map((p) => (
            <span key={p.id} className="flex items-center gap-1.5 rounded-full bg-white py-1 pr-3 pl-1 text-[12px] text-ink-2 shadow-[0_0_0_1px_rgba(0,0,0,0.05)]" title={`${p.name} 已就绪`}>
              <KindAvatar kind={p.kind} size={20} />
              {p.name}
            </span>
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

// ---- messages ------------------------------------------------------------------------------

function MentionChip({ a }: { a: AgentRef }) {
  return (
    <span className="mx-0.5 inline-flex items-center gap-1 rounded-md bg-white/25 px-1.5 align-baseline font-medium">
      @{a.name}
      {a.model && <span className="opacity-75">· {modelLabel(a.model, a.profileId)}</span>}
    </span>
  )
}

/** User text with @mentions rendered as chips. */
function renderWithMentions(text: string, mentions: AgentRef[]): ReactNode[] {
  if (!mentions.length) return [text]
  const re = new RegExp('@(' + [...mentions].sort((a, b) => b.name.length - a.name.length).map((m) => escapeRe(m.name)).join('|') + ')(?:\\(([^)\\s]+)\\))?', 'g')
  const out: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(re)) {
    out.push(text.slice(last, m.index))
    const ref = mentions.find((x) => x.name === m[1])!
    out.push(<MentionChip key={m.index} a={{ ...ref, model: m[2] ?? ref.model }} />)
    last = m.index! + m[0].length
  }
  out.push(text.slice(last))
  return out
}

function UserBubble({ msg }: { msg: UserMessage }) {
  const images = msg.attachments.filter((a) => a.isImage && a.thumb)
  const files = msg.attachments.filter((a) => !(a.isImage && a.thumb))
  return (
    <div className="flex flex-col items-end gap-1.5 pl-24">
      {images.length > 0 && (
        <div className="flex flex-wrap justify-end gap-2">
          {images.map((a) => (
            <img key={a.id} src={a.thumb!} title={a.path ?? a.name} className="h-24 w-24 rounded-2xl object-cover shadow-[0_0_0_1px_rgba(0,0,0,0.06)]" />
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
      {msg.text && msg.kind === 'handoff' ? (
        <div className="flex items-center gap-1.5 rounded-full bg-black/[0.05] px-3 py-1 text-[12.5px] text-ink-2">
          <IconArrowRight size={13} className="text-accent" />
          {msg.text}
        </div>
      ) : (
        msg.text && (
          <div className="max-w-full rounded-[20px] rounded-br-md bg-accent px-4 py-2.5 text-[15px] leading-[1.7] whitespace-pre-wrap text-white select-text">{renderWithMentions(msg.text, msg.mentions)}</div>
        )
      )}
      {msg.note && (
        <div className="flex items-center gap-1 text-[11px] text-[#0B4FA8]">
          <IconCheck size={11} /> {msg.note}
        </div>
      )}
      <div className="flex items-center gap-1 text-[11px] text-ink-3">
        {!msg.mentions.length && (
          <>
            发给 <KindAvatar kind={msg.driver.kind} size={13} /> {msg.driver.name} ·
          </>
        )}
        <span title={fullTime(msg.createdAt)}>{msgTime(msg.createdAt)}</span>
      </div>
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

function SpeakerLine({ msg }: { msg: AssistantMessage }) {
  const streaming = msg.status === 'streaming'
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="text-[14px] font-semibold text-ink">
        {msg.agent.name}
        <span className="font-normal text-ink-2">
          {' · '}
          {msg.agent.model || msg.actualModel ? modelLabel(msg.agent.model || msg.actualModel, msg.agent.profileId) : '默认模型'}
        </span>
      </span>
      {msg.dispatchedBy && <span className="rounded-full bg-black/[0.045] px-2 py-0.5 text-[11px] text-ink-2">响应 {msg.dispatchedBy.name} 的调度</span>}
      {msg.retry > 0 && !msg.review && <span className="rounded-full bg-[#FFF1DB] px-2 py-0.5 text-[11px] text-[#A05A00]">第 {msg.retry} 次重做</span>}
      {msg.verdict && (
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${msg.verdict.status === 'PASS' ? 'bg-[#E3F6E8] text-[#1A7F45]' : 'bg-[#FFF1DB] text-[#A05A00]'}`}
          title={msg.verdict.reason}
        >
          {msg.verdict.status === 'PASS' ? '验收通过' : '验收打回'}
        </span>
      )}
      {streaming ? (
        <span className="flex items-center gap-1.5 text-[12px] text-accent">
          <Spinner size={11} /> 正在回复 {msg.startedAt ? fmtDur(Date.now() - msg.startedAt) : ''}
        </span>
      ) : msg.status === 'queued' ? (
        <span className="text-[12px] text-ink-3">等待中</span>
      ) : (
        msg.startedAt && (
          <span className="text-[12px] text-ink-3" title={`开始 ${fullTime(msg.startedAt)}${msg.endedAt ? `\n结束 ${fullTime(msg.endedAt)}` : ''}`}>
            {msgTime(msg.startedAt)} ·{' '}
            {msg.status === 'stopped' ? '已停止 · ' : ''}
            {fmtDur((msg.endedAt ?? Date.now()) - msg.startedAt)}
          </span>
        )
      )}
    </div>
  )
}

function AssistantBlock({ msg }: { msg: AssistantMessage }) {
  const streaming = msg.status === 'streaming'
  useTicker(streaming)
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await window.agentmux.sys.copy(msg.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  if (msg.status === 'queued' || (msg.status === 'stopped' && !msg.startedAt))
    return (
      <div className="flex items-center gap-2.5 opacity-55">
        <KindAvatar kind={msg.agent.kind} size={28} />
        <SpeakerLine msg={msg} />
      </div>
    )

  return (
    <div className="flex gap-3 pr-10">
      <div className="pt-0.5">
        <KindAvatar kind={msg.agent.kind} size={28} />
      </div>
      <div className="min-w-0 flex-1">
        <SpeakerLine msg={msg} />
        <div className="mt-2">
          {msg.thinking && <ThinkingCard t={msg.thinking} live={streaming} />}
          {(msg.activity.length > 0 || (msg.others?.length ?? 0) > 0) && <ActivityBar items={msg.activity} others={msg.others ?? []} live={streaming && !msg.content} />}
          {msg.content ? (
            <Markdown text={msg.content} />
          ) : streaming ? (
            msg.activity.length === 0 && !(msg.thinking && !msg.thinking.endedAt) && (
              <div className="flex h-6 items-center gap-1">
                {[0, 1, 2].map((i) => (
                  <span key={i} className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-3" style={{ animationDelay: `${i * 160}ms` }} />
                ))}
              </div>
            )
          ) : (
            !msg.error && !msg.outputs.length && !msg.notices?.length && <div className="text-[14px] text-ink-3">没有文字输出</div>
          )}
          {streaming && msg.content && <span className="ml-0.5 inline-block h-4 w-[3px] translate-y-0.5 animate-pulse rounded-full bg-accent" />}
          <Outputs msg={msg} />
          {(msg.notices ?? []).map((n, i) => (
            <div key={i} className="mt-2 flex items-start gap-2 rounded-xl bg-[#FFF6E5] px-3 py-2 text-[12px] leading-relaxed text-[#8A5300]">
              <IconAlert size={14} className="mt-0.5 shrink-0" />
              <span className="min-w-0">{n}</span>
            </div>
          ))}
          {msg.error && (
            <div className="mt-2 flex items-start gap-2 rounded-xl bg-[#FDECEC] px-3 py-2 text-[13px] leading-relaxed text-[#B42318]">
              <IconAlert size={15} className="mt-0.5 shrink-0" />
              <span className="min-w-0 break-words whitespace-pre-wrap select-text">{msg.error}</span>
            </div>
          )}
        </div>
        {!streaming && (msg.content || msg.usage) && (
          <div className="mt-1 -ml-2 flex items-center gap-2">
            {msg.content && (
              <button onClick={() => void copy()} className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12px] text-ink-3 transition-colors hover:bg-black/[0.05] hover:text-ink">
                {copied ? <IconCheck size={14} className="text-[#1A7F45]" /> : <IconCopy size={14} />}
                {copied ? '已复制' : '复制'}
              </button>
            )}
            <UsageLine usage={msg.usage} ms={msg.startedAt && msg.endedAt ? msg.endedAt - msg.startedAt : null} />
          </div>
        )}
      </div>
    </div>
  )
}

/** Files the step produced that its text doesn't already show: images as previews, others as chips. */
function Outputs({ msg }: { msg: AssistantMessage }) {
  if (!msg.outputs.length) return null
  // only skip images the text already embeds with ![..](..); plain links still get a preview
  const shown = (p: string) => new RegExp('!\\[[^\\]]*\\]\\([^)]*' + fileBase(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\)').test(msg.content)
  const images = msg.outputs.filter((p) => IMAGE_RE.test(p) && !shown(p))
  const files = msg.outputs.filter((p) => !IMAGE_RE.test(p))
  if (!images.length && !files.length) return null
  return (
    <div className="mt-3">
      {images.length > 0 && (
        <div className="md">
          {images.map((p) => (
            <ZoomImage key={p} src={fileUrl(p)} alt={fileBase(p)} path={p} />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {files.slice(0, 12).map((p) => (
            <button
              key={p}
              onClick={() => void window.agentmux.sys.showInFolder(p)}
              className="flex h-7 max-w-[260px] items-center gap-1.5 rounded-lg bg-black/[0.04] px-2.5 text-[12px] text-ink-2 hover:bg-black/[0.07] hover:text-ink"
              title={`${p}\n在 Finder 中显示`}
            >
              <IconFile size={13} className="shrink-0" />
              <span className="truncate">{fileBase(p)}</span>
            </button>
          ))}
          {files.length > 12 && <span className="px-1 text-[12px] leading-7 text-ink-3">等 {files.length} 个文件</span>}
        </div>
      )}
    </div>
  )
}

// ---- composer --------------------------------------------------------------------------------

function AccountRow({ p, active, selected, trailing, onClick }: { p: ProfileState; active?: boolean; selected?: boolean; trailing?: ReactNode; onClick: () => void }) {
  return (
    <div
      onMouseDown={(e) => e.preventDefault() /* keep textarea focus */}
      onClick={onClick}
      className={`flex h-10 w-full cursor-default items-center gap-2.5 rounded-[10px] px-2.5 transition-colors ${active ? 'bg-accent/10' : 'hover:bg-black/[0.04]'}`}
    >
      <KindAvatar kind={p.kind} size={24} />
      <span className={`min-w-0 flex-1 truncate text-[14px] ${isReady(p) ? 'text-ink' : 'text-ink-3'}`}>{p.name}</span>
      {trailing}
      {!isReady(p) ? <span className="text-[11px] text-ink-3">{accountBadge(p).label}</span> : selected && <IconCheck size={15} className="text-accent" />}
    </div>
  )
}

function DriverPicker({ driver, onPick }: { driver: ProfileState | null; onPick: (id: ProfileId) => void }) {
  const { navigate } = useApp()
  const accounts = useSortedAccounts()
  const [open, setOpen] = useState(false)
  const ref = useOutside<HTMLDivElement>(open, () => setOpen(false))
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex h-8 items-center gap-2 rounded-full pr-2 pl-1 text-[13px] font-medium text-ink transition-colors hover:bg-fill ${open ? 'bg-fill' : ''}`}
        title="主控账号：默认由它回答，需要协同时由它拆解并调度其他模型"
      >
        {driver ? <KindAvatar kind={driver.kind} size={22} /> : <span className="h-[22px] w-[22px] rounded-[6px] border border-dashed border-black/20" />}
        <span className="max-w-[150px] truncate">{driver?.name ?? '选择模型'}</span>
        <IconChevronDown size={13} className="text-ink-3" />
      </button>
      {open && (
        <div className={popover + ' absolute bottom-10 left-0 z-30 w-64'}>
          <div className="px-2.5 pt-1 pb-1.5 text-[12px] text-ink-3">主控账号</div>
          {accounts.map((p) => (
            <AccountRow
              key={p.id}
              p={p}
              selected={p.id === driver?.id}
              active={p.id === driver?.id}
              onClick={() => {
                onPick(p.id)
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

/** Two-line model row: full display name, raw id underneath in faint mono. */
function ModelRow({ m, active, hot, onClick, onHover }: { m: { id: string; label: string }; active: boolean; hot?: boolean; onClick: () => void; onHover?: () => void }) {
  return (
    <button
      onMouseEnter={onHover}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      title={m.id}
      className={`flex w-full items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-left transition-colors ${active || hot ? 'bg-accent/10' : 'hover:bg-black/[0.04]'}`}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] leading-5 break-words text-ink">{m.label}</span>
        {m.label !== m.id && <span className="block truncate font-mono text-[10.5px] leading-4 text-ink-3/70">{m.id}</span>}
      </span>
      {active && <IconCheck size={15} className="shrink-0 text-accent" />}
    </button>
  )
}

/** Sub-model capsule: 默认 / account's live model list (+ effort) / custom name. */
function ModelCapsule({ account, model, onPick }: { account: ProfileState; model: string | null; onPick: (m: string | null) => void }) {
  const [open, setOpen] = useState(false)
  const [custom, setCustom] = useState('')
  const [more, setMore] = useState(false)
  const ref = useOutside<HTMLDivElement>(open, () => setOpen(false))
  const { list, loading, refresh } = useModels(account.id)
  const eff = effectiveModel(model, account)
  const cur = resolveSpec(eff, account.id)
  const picked = resolveSpec(model, account.id).model
  const all = list?.models ?? []
  const known = new Set(all.map((m) => m.id))
  const extra = [...new Set([account.defaultModel, model].map((m) => resolveSpec(m, account.id).model).filter((m): m is string => !!m && !known.has(m)))].map((id) => ({
    id,
    label: id,
    group: 'main' as const
  }))
  const main = [...all.filter((m) => m.group === 'main'), ...extra]
  const rest = all.filter((m) => m.group === 'more')
  const pick = (m: string | null) => {
    onPick(m)
    setOpen(false)
    setCustom('')
  }
  const row = (m: ModelOption | { id: string; label: string }) => (
    // switching model keeps the chosen effort when the new model supports it
    <ModelRow key={m.id} m={m} active={picked === m.id} onClick={() => pick(withEffort('efforts' in m ? m : null, m.id, cur.effort))} />
  )
  const SOURCE = { catalog: 'CLI 模型目录', command: 'CLI 实时查询', cache: '本地缓存', static: '内置列表' }
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex h-7 max-w-[260px] items-center gap-1 rounded-full bg-black/[0.045] pr-2 pl-2.5 text-[12px] font-medium text-ink-2 transition-colors hover:bg-black/[0.07] hover:text-ink ${open ? 'bg-black/[0.08] text-ink' : ''}`}
        title="子模型与思考强度（--model / effort）"
      >
        <span className="truncate">{eff ? modelLabel(eff, account.id) : '默认'}</span>
        <IconChevronDown size={12} className="shrink-0 text-ink-3" />
      </button>
      {open && (
        <div className={popover + ' absolute bottom-9 left-0 z-30 flex max-h-[480px] w-80 flex-col'}>
          <div className="flex items-center gap-2 px-2.5 pt-1 pb-1.5 text-[12px] text-ink-3">
            <span className="min-w-0 flex-1 truncate">子模型 · {account.name}</span>
            <button onClick={refresh} disabled={loading} className="flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-black/[0.05] hover:text-ink disabled:opacity-60" title="重新从 CLI 获取模型列表">
              {loading ? <Spinner size={11} /> : <IconRefresh size={12} />} 刷新
            </button>
          </div>
          <EffortBar opt={cur.opt} effort={cur.effort} onChange={(e) => cur.model && onPick(withEffort(cur.opt, cur.model, e))} />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <button onClick={() => pick(null)} className={`flex w-full items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-left transition-colors ${!model ? 'bg-accent/10' : 'hover:bg-black/[0.04]'}`}>
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] leading-5 text-ink">默认</span>
                <span className="block truncate text-[10.5px] leading-4 text-ink-3">{account.defaultModel ? `账号默认：${modelLabel(account.defaultModel, account.id)}` : DEFAULT_HINT[account.kind]}</span>
              </span>
              {!model && <IconCheck size={15} className="text-accent" />}
            </button>
            {main.map(row)}
            {rest.length > 0 && (
              <button onClick={() => setMore((x) => !x)} className="flex h-8 w-full items-center gap-1 rounded-[10px] px-2.5 text-[12px] text-ink-3 hover:bg-black/[0.04] hover:text-ink-2">
                {more ? '收起' : `更多模型（${rest.length}）`}
                <IconChevronDown size={12} className={more ? 'rotate-180' : ''} />
              </button>
            )}
            {more && rest.map(row)}
          </div>
          {list && (
            <div className="px-2.5 pt-1 text-[11px] text-ink-3" title={list.error}>
              来源：{SOURCE[list.source]}
              {list.error ? ' · 刷新失败' : ''}
            </div>
          )}
          <div className="mx-2 my-1 h-px bg-hairline" />
          <div className="px-1 pb-0.5">
            <input
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && custom.trim()) {
                  e.preventDefault()
                  pick(custom.trim())
                }
              }}
              placeholder="自定义模型名，回车使用（可写 模型:effort）"
              className="h-8 w-full rounded-lg bg-fill px-2.5 font-mono text-[12px] text-ink outline-none placeholder:font-sans placeholder:text-ink-3 focus:ring-2 focus:ring-accent/30"
            />
          </div>
        </div>
      )}
    </div>
  )
}

function Composer({
  driver,
  driverModel,
  onDriver,
  participants,
  busy,
  threadId,
  onHeight,
  onSend,
  onStop
}: {
  driver: ProfileState | null
  driverModel: string | null
  onDriver: (id: ProfileId, model: string | null) => void
  participants: ProfileId[]
  busy: boolean
  threadId: string | null
  onHeight: (h: number) => void
  onSend: (text: string, attachments: Attachment[]) => void
  onStop: () => void
}) {
  const { toast, navigate } = useApp()
  useModelsVersion()
  const accounts = useSortedAccounts()
  const [text, setText] = useState('')
  const [atts, setAtts] = useState<Attachment[]>([])
  const [drag, setDrag] = useState(false)
  /** @ menu: `sub` = index of the account whose sub-model list is open. */
  const [mention, setMention] = useState<{ start: number; query: string; index: number; sub: number | null; subIndex: number } | null>(null)
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

  useEffect(() => {
    ta.current?.focus()
  }, [threadId])

  // @ candidates: ready accounts (participants first). Display name wins; the underlying CLI
  // name ("Claude Code") is only a fallback when nothing matches by name, so `@cod` → Codex only.
  const matches = useMemo(() => {
    if (!mention) return []
    const q = mention.query.toLowerCase()
    const score = (p: ProfileState) => {
      const name = p.name.toLowerCase()
      const kind = KIND_META[p.kind].name.toLowerCase()
      if (!q || name.startsWith(q)) return 0
      if (kind.startsWith(q)) return 1
      if (name.includes(q) || kind.includes(q)) return 2
      if (KIND_META[p.kind].cli.toLowerCase().includes(q)) return 9
      return -1
    }
    const scored = accounts
      .filter(isReady)
      .map((p, i) => ({ p, s: score(p), i: i - (participants.includes(p.id) ? 1000 : 0) }))
      .filter((x) => x.s >= 0)
    const byName = scored.filter((x) => x.s < 9)
    return (byName.length ? byName : scored).sort((a, b) => a.s - b.s || a.i - b.i).map((x) => x.p)
  }, [mention, accounts, participants])

  // preload model lists for the @ menu's sub-model column
  useEffect(() => {
    for (const p of accounts) if (isReady(p) && !getModelList(p.id)) void loadModels(p.id)
  }, [accounts])
  const subOptions = (p: ProfileState): (string | null)[] => {
    const main = (getModelList(p.id)?.models ?? []).filter((m) => m.group === 'main').map((m) => m.id)
    const def = resolveSpec(p.defaultModel, p.id).model
    return [null, ...new Set([...(def ? [def] : []), ...main])].slice(0, 12)
  }
  // effort chosen in the @ sub-model column (applies to the inserted model if it supports it)
  const [subEffort, setSubEffort] = useState<string | null>(null)

  const syncMention = (value: string, caret: number) => {
    const m = /(^|\s)@([^\s@]{0,24})$/.exec(value.slice(0, caret))
    setMention(m ? { start: caret - m[2].length - 1, query: m[2], index: 0, sub: null, subIndex: 0 } : null)
  }

  /** Replaces `@query` with `@Name` or `@Name(model)` followed by a space. */
  const insertMention = (p: ProfileState, picked: string | null) => {
    if (!mention) return
    const r = resolveSpec(picked, p.id)
    const model = r.model ? withEffort(r.opt, r.model, subEffort) : null
    setSubEffort(null)
    const caret = ta.current?.selectionStart ?? text.length
    const token = `@${p.name}${model ? `(${model})` : ''} `
    const next = text.slice(0, mention.start) + token + text.slice(caret)
    setText(next)
    setMention(null)
    requestAnimationFrame(() => {
      const el = ta.current
      if (!el) return
      const pos = mention.start + token.length
      el.focus()
      el.setSelectionRange(pos, pos)
    })
  }

  const addFiles = async (files: File[]) => {
    if (!files.length) return
    const next = await Promise.all(files.map(toAttachment))
    setAtts((a) => [...a, ...next].slice(0, 12))
  }

  const canSend = !busy && !!driver && (text.trim().length > 0 || atts.length > 0)
  const doSend = () => {
    if (busy) return toast({ kind: 'info', title: '模型还在回复', desc: '等它完成，或点击停止后再发送。' })
    if (!driver) return toast({ kind: 'warn', title: '还没有可用的模型', action: { label: '添加账号', run: () => navigate('engines') } })
    if (!text.trim() && !atts.length) return
    if (!isReady(driver))
      return toast({
        kind: 'warn',
        title: `${driver.name} 还不能使用`,
        desc: accountBadge(driver).label,
        action: { label: driver.status === 'uninstalled' ? '去安装' : '去登录', run: () => navigate('engines', driver.id) }
      })
    onSend(text.trim(), atts)
    setText('')
    setAtts([])
  }

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const composing = e.nativeEvent.isComposing || e.keyCode === 229
    if (mention && !composing && matches.length) {
      const inSub = mention.sub !== null
      const p = matches[Math.min(inSub ? mention.sub! : mention.index, matches.length - 1)]
      const opts = subOptions(p)
      const move = (d: number) =>
        setMention((m) => m && (inSub ? { ...m, subIndex: (m.subIndex + d + opts.length) % opts.length } : { ...m, index: (m.index + d + matches.length) % matches.length }))
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        return move(e.key === 'ArrowDown' ? 1 : -1)
      }
      if (e.key === 'ArrowRight' && !inSub) {
        e.preventDefault()
        return setMention((m) => m && { ...m, sub: m.index, subIndex: 0 })
      }
      if (e.key === 'ArrowLeft' && inSub) {
        e.preventDefault()
        return setMention((m) => m && { ...m, sub: null })
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        return insertMention(p, inSub ? opts[mention.subIndex] : null)
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        return setMention(null)
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !composing) {
      e.preventDefault()
      doSend()
    }
  }

  return (
    <div ref={wrap} className="pointer-events-none absolute inset-x-0 bottom-0 bg-[linear-gradient(to_bottom,transparent,var(--canvas)_42%)] px-8 pt-8 pb-6">
      <div className="pointer-events-auto relative mx-auto max-w-[820px]">
        {mention && (
          <div className="absolute bottom-full left-0 z-30 mb-2 flex items-end gap-2">
            <div className={popover + ' w-72'}>
              <div className="flex items-center gap-1.5 px-2.5 pt-1 pb-1.5 text-[12px] text-ink-3">
                <IconAt size={13} /> 邀请模型参与 <span className="ml-auto">→ 选子模型</span>
              </div>
              {matches.length ? (
                matches.map((p, i) => (
                  <AccountRow
                    key={p.id}
                    p={p}
                    active={i === (mention.sub ?? mention.index)}
                    onClick={() => insertMention(p, null)}
                    trailing={
                      <span
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={(e) => {
                          e.stopPropagation()
                          setMention((m) => m && { ...m, index: i, sub: m.sub === i ? null : i, subIndex: 0 })
                        }}
                        className="rounded-full bg-black/[0.05] px-2 py-0.5 text-[11px] text-ink-2 hover:bg-black/[0.09]"
                        title="选择子模型"
                      >
                        {p.defaultModel ? modelLabel(p.defaultModel, p.id) : '默认'} ›
                      </span>
                    }
                  />
                ))
              ) : (
                <div className="px-2.5 py-2 text-[13px] text-ink-3">没有匹配的已就绪账号</div>
              )}
            </div>
            {mention.sub !== null && matches[mention.sub] && (() => {
              const p = matches[mention.sub]
              const opts = subOptions(p)
              const hot = opts[mention.subIndex]
              const hotOpt = hot ? (findModel(hot, p.id)?.opt ?? null) : null
              return (
                <div className={popover + ' flex max-h-[400px] w-80 flex-col'}>
                  <div className="px-2.5 pt-1 pb-1.5 text-[12px] text-ink-3">{p.name} 的子模型</div>
                  <EffortBar opt={hotOpt} effort={subEffort} onChange={setSubEffort} />
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    {opts.map((m, j) => {
                      const o = m ? findModel(m, p.id)?.opt : null
                      return (
                        <ModelRow
                          key={m ?? '_'}
                          m={m ? { id: m, label: o?.label.replace(/（最新）$/, '') ?? m } : { id: '默认', label: '默认' }}
                          active={false}
                          hot={j === mention.subIndex}
                          onClick={() => insertMention(p, m)}
                          onHover={() => setMention((x) => x && { ...x, subIndex: j })}
                        />
                      )
                    })}
                  </div>
                </div>
              )
            })()}
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
            onBlur={() => setMention(null)}
            onKeyDown={onKey}
            onPaste={(e) => {
              const files = [...e.clipboardData.files]
              if (files.length) {
                e.preventDefault()
                void addFiles(files)
              }
            }}
            placeholder={driver ? `给 ${driver.name} 发消息，输入 @ 邀请其他模型协同` : '先在「模型引擎」添加一个账号'}
            className="block max-h-[200px] w-full resize-none bg-transparent px-5 pt-4 pb-1 text-[15px] leading-[22px] text-ink outline-none placeholder:text-ink-3"
          />

          <div className="flex items-center gap-1 px-3 pt-1 pb-3">
            <DriverPicker driver={driver} onPick={(id) => onDriver(id, null)} />
            {driver && <ModelCapsule account={driver} model={driverModel} onPick={(m) => onDriver(driver.id, m)} />}
            <div className="mx-1.5 h-4 w-px bg-black/[0.08]" />
            <button
              onClick={() => fileInput.current?.click()}
              className="flex h-8 w-8 items-center justify-center rounded-full text-ink-2 transition-colors hover:bg-fill hover:text-ink"
              title="添加图片或文件（也可以拖入或粘贴）"
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
