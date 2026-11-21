import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ModelOption, ProfileId, ProfileState, SkillItem } from '@shared/types'
import { ExtensionsButton, ExtensionsPanel, SlashMenu, filterSkills } from '../components/Extensions'
import { pinnedFirst, useOverview, usePins, useSkills } from '../state/extensions'
import { openOnboarding } from '../state/onboarding'
import { useApp } from '../state/AppContext'
import { KIND_META, accountBadge, isReady } from '../lib/ui'
import { defaultHint, effectiveModel, modelLabel, resolveSpec, withEffort } from '../lib/models'
import { KindAvatar } from '../components/common'
import { AttachmentViewer } from '../components/AttachmentViewer'
import { stripMarks } from '@shared/markers'
import { maskCode } from '@shared/mentions'
import { EffortBar } from '../components/EffortBar'
import { QuotaDot } from '../components/Usage'
import { ActivityBar, LiveProgress, ThinkingCard, UsageLine } from '../components/Process'
import { ChangesPanel, Counts, useFileChanges } from '../components/ChangesPanel'
import { ProjectBar } from '../components/ProjectBar'
import { CollapsibleBody } from '../components/CollapsibleBody'
import { useStartThread } from '../state/threads'
import { Markdown, MarkdownBase, ZoomImage } from '../components/Markdown'
import { IconAlert, IconArrowRight, IconArrowUp, IconAt, IconCheck, IconChevronDown, IconCopy, IconFile, IconFolder, IconPlus, IconRefresh, IconStop, IconTerminal, IconX, Spinner } from '../components/icons'
import { IMAGE_RE, baseName as fileBase, fileUrl } from '../lib/fileUrl'
import { findModel, getModelList, loadModels, useModels, useModelsVersion } from '../state/models'
import {
  activeThread,
  clearSuggestion,
  exportHandoff,
  isThreadBusy,
  lastSpeaker,
  loadHistory,
  newThread,
  sessionAccounts,
  skipHandoff,
  threadMessages,
  onExternalSync,
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
import { fmtDuration, t, tNode } from '../state/i18n'
import { stripLatest } from '@shared/i18n'
import { patchDraft, pickDriver, useDraft, type DraftCtx } from '../state/draft'
import { sendKeys, useSettings } from '../state/settings'

type Ctx = DraftCtx

const shortPath = (p: string) => p.replace(/^\/Users\/[^/]+/, '~')
const baseName = (p: string) => p.split('/').filter(Boolean).pop() ?? p
const fmtDur = fmtDuration
const pad2 = (n: number) => String(n).padStart(2, '0')
/** Message time: today HH:mm · 昨天 HH:mm · MM-DD HH:mm (hover: full). */
function msgTime(ts: number): string {
  const d = new Date(ts)
  const day = new Date()
  day.setHours(0, 0, 0, 0)
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  if (ts >= day.getTime()) return hm
  if (ts >= day.getTime() - 86400_000) return t('time.yesterday', { time: hm })
  return `${d.getFullYear() !== day.getFullYear() ? d.getFullYear() + '-' : ''}${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`
}
const fullTime = (ts: number) => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const pill =
  'flex h-9 items-center gap-2 rounded-full bg-surface px-4 text-[14px] font-medium text-ink shadow-[0_0_0_1px_var(--ring),0_1px_2px_rgba(0,0,0,0.04)] transition-colors hover:bg-surface-2 active:scale-[0.98]'
const popover = 'rounded-2xl bg-surface/95 p-1.5 shadow-[0_0_0_1px_var(--ring),0_12px_40px_rgba(0,0,0,0.16)] backdrop-blur-xl'

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

/** `@Name` or `@Name(model)` tokens for the given accounts, in text order (code blocks / inline code skipped). */
function parseMentions(text: string, accounts: ProfileState[]): { p: ProfileState; model: string | null; index: number; length: number }[] {
  const out: { p: ProfileState; model: string | null; index: number; length: number }[] = []
  const taken: [number, number][] = []
  const plain = maskCode(text)
  for (const p of [...accounts].sort((a, b) => b.name.length - a.name.length)) {
    const re = new RegExp('@' + escapeRe(p.name) + '(?:\\(([^)\\s]+)\\))?', 'g')
    for (const m of plain.matchAll(re)) {
      const s = m.index!
      if (taken.some(([a, b]) => s >= a && s < b)) continue
      taken.push([s, s + m[0].length])
      out.push({ p, model: m[1] ?? null, index: s, length: m[0].length })
    }
  }
  return out.sort((a, b) => a.index - b.index)
}

export function WorkbenchPage() {
  const { byId, profiles, info, confirm, drawer, openDrawer, closeDrawer } = useApp()
  const { showDebugTerminal } = useSettings()
  const chat = useChat()
  const thread = activeThread(chat)
  const sorted = useSortedAccounts()

  // settings for a conversation that hasn't been created yet (no thread selected)
  const draft = useDraft()

  const ctx: Ctx = thread ?? draft
  const update = (patch: Partial<Ctx>) => (thread ? updateThread(thread.id, patch) : patchDraft(patch))

  // participants default to every ready account when unset
  const participants = ctx.participants.length ? ctx.participants.filter((id) => byId(id)) : sorted.filter(isReady).map((p) => p.id)
  const driverP = pickDriver(ctx, sorted, participants)
  const driverModel = ctx.driver.profileId === driverP?.id ? ctx.driver.model : null
  const setDriver = (id: ProfileId, model: string | null) =>
    update({ driver: { profileId: id, model }, participants: participants.includes(id) ? participants : [...participants, id] })

  // the folder is fixed once the first message went out (the CLI sessions are bound to it)
  const projectLocked = !!thread && (!!thread.imported || thread.messages.some((m) => m.role === 'user'))
  const startThread = useStartThread()
  const pickProject = async () => {
    if (projectLocked) return
    const dir = await window.agentswitch.sys.pickProject(ctx.projectDir ?? undefined)
    if (dir) update({ projectDir: dir })
  }

  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const messages = useMemo(() => threadMessages(thread), [thread])
  // the newest reply starts expanded; older long replies start folded
  const lastReplyId = useMemo(() => [...messages].reverse().find((m) => m.role === 'assistant')?.id ?? null, [messages])
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
    void send(thread.id, {
      text: t('wb.handoffText', { name: driverP.name }),
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
    const busy = () => confirm({ title: t('wb.extBusyTitle'), message: t('wb.extBusyDesc'), confirmLabel: t('wb.extBusySend') })
    return send(id, { text, attachments, driver: ref(driverP, driverModel), mentions, participants: joined, projectDir: ctx.projectDir }, busy)
  }

  // turns continued elsewhere (terminal, another app) merged into the open chat: a short notice
  const [synced, setSynced] = useState<{ n: number; seq: number } | null>(null)
  const threadId = thread?.id
  useEffect(
    () =>
      onExternalSync((e) => {
        if (e.threadId !== threadId) return
        stick.current = true
        setSynced((s) => ({ n: e.added, seq: (s?.seq ?? 0) + 1 }))
      }),
    [threadId]
  )
  useEffect(() => {
    if (!synced) return
    const h = setTimeout(() => setSynced(null), 3800)
    return () => clearTimeout(h)
  }, [synced])
  useEffect(() => setSynced(null), [threadId])

  // 文件修改 panel: open state remembered across chats
  const [changesOpen, setChangesOpen] = useState(() => localStorage.getItem('agentswitch.changesOpen') === '1')
  const toggleChanges = () =>
    setChangesOpen((o) => {
      localStorage.setItem('agentswitch.changesOpen', o ? '0' : '1')
      return !o
    })
  const fc = useFileChanges(thread, ctx.projectDir, isThreadBusy(thread))
  const nChanged = (fc.changes?.files.length ?? 0) + (fc.changes?.more ?? 0)

  return (
    <div className="flex h-full">
      <div className="relative flex h-full min-w-0 flex-1 flex-col">
        <div className="drag flex h-14 shrink-0 items-center gap-2.5 px-8">
          <div className="min-w-0 truncate text-[14px] font-semibold text-ink" title={thread?.title}>
            {thread && !thread.preview ? thread.title : t('nav.newChat')}
          </div>
          <div className="flex-1" />
          {synced && (
            <div key={synced.seq} className="no-drag pointer-events-none absolute top-3.5 left-1/2 z-20 -translate-x-1/2">
              <div className="flex items-center gap-1.5 rounded-full bg-surface/95 px-3 py-1 text-[12px] text-ink-2 shadow-[0_0_0_1px_var(--ring),0_4px_16px_rgba(0,0,0,0.10)] backdrop-blur-xl">
                <IconRefresh size={12} className="text-accent" />
                {t('wb.extSynced', { n: synced.n })}
              </div>
            </div>
          )}
          <div className="no-drag flex items-center gap-1.5">
            <ParticipantsButton participants={participants} driverId={driverP?.id ?? null} onChange={(ids) => update({ participants: ids })} />
            {showDebugTerminal && (
              <button
                onClick={() => (drawer.open ? closeDrawer() : openDrawer())}
                className={pill.replace('px-4', 'px-0') + ` relative w-9 justify-center ${drawer.open ? 'bg-surface-2 text-accent' : ''}`}
                title={
                  t('nav.debugLog') +
                  (info
                    ? '\n' +
                      (info.shellEnvSource === 'login' ? t('nav.shellLogin') : info.shellEnvSource === 'cache' ? t('nav.shellCache') : t('nav.shellFallback', { error: info.shellEnvError ?? '' }))
                    : '')
                }
              >
                <IconTerminal size={15} className={drawer.open ? 'text-accent' : 'text-ink-2'} />
                {info && <span className={`absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full ${info.shellEnvSource === 'fallback' ? 'bg-orange' : 'bg-green'}`} />}
              </button>
            )}
            <button
              onClick={toggleChanges}
              className={pill + ` gap-1.5 px-3 ${changesOpen ? 'bg-surface-2 text-accent' : ''}`}
              title={nChanged ? t('chg.btnHint', { n: nChanged }) : t('chg.title')}
            >
              <IconFile size={15} className={changesOpen ? 'text-accent' : 'text-ink-2'} />
              {nChanged > 0 ? (
                <>
                  <span className="text-[13px] tabular-nums">{nChanged}</span>
                  <Counts added={fc.changes!.added} removed={fc.changes!.removed} className="text-[11.5px]" />
                </>
              ) : (
                <span className="text-[13px] text-ink-2">{t('chg.short')}</span>
              )}
            </button>
          </div>
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
                  {thread.preview
                    ? t('wb.previewBanner', { name: byId(thread.imported.profileId)?.name ?? t('wb.origAccount') })
                    : t('wb.importedBanner', { name: byId(thread.imported.profileId)?.name ?? t('wb.origAccount') })}
                  {thread.historyState === 'loading' && <span className="ml-1 text-ink-3">{t('wb.historyLoading')}</span>}
                  {thread.historyState === 'error' && <span className="ml-1 text-warn">{t('wb.historyError')}</span>}
                  {thread.imported.notice && <span className="block text-warn">{thread.imported.notice}</span>}
                </span>
              </div>
            )}
            {messages.length === 0 ? (
              <EmptyState projectDir={ctx.projectDir} onPickProject={() => void pickProject()} participants={participants} />
            ) : (
              <div className="space-y-6">
                <MarkdownBase.Provider value={{ baseDir: thread?.workdir ?? ctx.projectDir, home: info?.realHome ?? null }}>
                  {messages.map((m) => (m.role === 'user' ? <UserBubble key={m.id} msg={m} /> : <AssistantBlock key={m.id} msg={m} latest={m.id === lastReplyId} />))}
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
          projectDir={ctx.projectDir}
          onHeight={setComposerH}
          onSend={onSend}
          onStop={() => thread && stop(thread.id)}
          suggestion={thread && !isThreadBusy(thread) ? thread.suggestedInput : null}
          footer={
            <ProjectBar
              dir={ctx.projectDir}
              locked={projectLocked}
              onChange={(dir) => !projectLocked && update({ projectDir: dir })}
              onPick={() => void pickProject()}
              onNewHere={startThread}
            />
          }
        />
        {!thread?.pause && (handoffNeeded || handoffReady) && driverP && (
          <div className="pointer-events-none absolute inset-x-0 z-20 px-8" style={{ bottom: composerH - 8 }}>
            {handoffReady ? (
              <div className="pointer-events-auto mx-auto flex max-w-[820px] items-center gap-2.5 rounded-2xl bg-info-soft px-4 py-2.5 text-[13px] text-info shadow-[0_0_0_1px_rgba(0,102,214,0.22),0_8px_24px_rgba(0,0,0,0.06)]">
                <IconCheck size={15} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  {tNode('wb.handoffReady', { name: <span className="font-semibold">{driverP.name}</span> })}
                </span>
                <button className="h-7 shrink-0 rounded-full px-3 font-medium hover:bg-black/[0.05]" onClick={() => void window.agentswitch.sys.showInFolder(thread!.handoff!.path)} title={thread!.handoff!.path}>
                  {t('wb.viewDoc')}
                </button>
              </div>
            ) : (
              <div className="pointer-events-auto mx-auto flex max-w-[820px] items-center gap-2.5 rounded-2xl bg-surface px-4 py-2.5 text-[13px] text-ink shadow-[0_0_0_1px_var(--ring),0_8px_24px_rgba(0,0,0,0.08)]">
                <IconArrowRight size={15} className="shrink-0 text-accent" />
                <span className="min-w-0 flex-1">
                  {tNode('wb.switchNeedsSync', { name: <span className="font-semibold">{driverP.name}</span> })}
                  {handoffFailed && <span className="block text-[12px] text-warn">{t('wb.handoffFailed', { name: srcP?.name ?? t('wb.origAccount'), suffix: thread!.handoffFailed!.error === 'rate_limited' ? t('wb.rateLimitedSuffix') : '' })}</span>}
                  {!srcOk && !handoffFailed && <span className="block text-[12px] text-warn">{t('wb.srcUnavailable', { name: srcP?.name ?? t('wb.origAccount') })}</span>}
                </span>
                {srcOk && !handoffFailed ? (
                  <button className="h-7 shrink-0 rounded-full bg-accent px-3 font-medium text-white hover:bg-accent/90" onClick={startHandoff}>
                    {t('wb.letHandoff', { name: srcP!.name })}
                  </button>
                ) : (
                  <button disabled={exporting} className="h-7 shrink-0 rounded-full bg-accent px-3 font-medium text-white hover:bg-accent/90 disabled:opacity-60" onClick={() => void doExport()}>
                    {exporting ? t('wb.exporting') : t('wb.exportHandoff')}
                  </button>
                )}
                <button className="h-7 shrink-0 rounded-full px-3 font-medium text-ink-2 hover:bg-black/[0.05]" onClick={() => skipHandoff(thread!.id, driverP.id)}>
                  {t('wb.switchDirect')}
                </button>
              </div>
            )}
          </div>
        )}
        {thread?.pause && (
          <div className="pointer-events-none absolute inset-x-0 z-20 px-8" style={{ bottom: composerH - 8 }}>
            <div className="pointer-events-auto mx-auto flex max-w-[820px] items-center gap-3 rounded-2xl bg-warn-soft px-4 py-3 text-[13px] text-warn shadow-[0_0_0_1px_rgba(255,159,10,0.35),0_8px_24px_rgba(0,0,0,0.08)]">
              <IconAlert size={16} className="shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="font-semibold">{t('wb.needHuman')}</span> · {thread.pause.reason}
              </span>
              <button className="h-7 shrink-0 rounded-full bg-orange px-3 font-medium text-white hover:bg-orange" onClick={() => resolvePause(thread.id, 'retry')}>
                {t('wb.retryRound')}
              </button>
              <button className="h-7 shrink-0 rounded-full bg-surface px-3 font-medium text-ink shadow-[0_0_0_1px_var(--ring)] hover:bg-surface-2" onClick={() => resolvePause(thread.id, 'skip')}>
                {t('wb.skipReview')}
              </button>
              <button className="h-7 shrink-0 rounded-full px-3 font-medium text-ink-2 hover:bg-black/[0.05]" onClick={() => resolvePause(thread.id, 'stop')}>
                {t('wb.endTurn')}
              </button>
            </div>
          </div>
        )}
      </div>
      {changesOpen && <ChangesPanel changes={fc.changes} loading={fc.loading} dir={ctx.projectDir} onRefresh={fc.refresh} onClose={toggleChanges} />}
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
      <button onClick={() => setOpen((o) => !o)} className={pill + ' gap-1.5 pr-2.5 pl-1.5'} title={`${t('wb.participantsHint')}\n${active.map((p) => p.name).join(' · ')}`}>
        {active[0] ? (
          <span className="relative">
            <KindAvatar kind={(active.find((p) => p.id === driverId) ?? active[0]).kind} size={22} />
          </span>
        ) : (
          <span className="h-[22px] w-[22px] rounded-[7px] border border-dashed border-black/20 dark:border-white/25" />
        )}
        <span className="text-[13px] text-ink-2 tabular-nums">{active.length}</span>
        <IconChevronDown size={13} className="text-ink-3" />
      </button>
      {open && (
        <div className={popover + ' absolute top-11 right-0 z-30 w-72'}>
          <div className="px-2.5 pt-1 pb-1.5 text-[12px] text-ink-3">{t('wb.participantsTitle')}</div>
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
                title={isDriver ? t('wb.driverAlways') : undefined}
              >
                <span className={`flex h-[18px] w-[18px] items-center justify-center rounded-[5px] ${on && ready ? 'bg-accent text-white' : 'bg-surface shadow-[inset_0_0_0_1.5px_var(--ring)]'} ${!ready ? 'opacity-40' : ''}`}>
                  {on && ready && <IconCheck size={12} strokeWidth={3} />}
                </span>
                <KindAvatar kind={p.kind} size={22} />
                <span className={`min-w-0 flex-1 truncate text-[14px] ${ready ? 'text-ink' : 'text-ink-3'}`}>{p.name}</span>
                {isDriver ? <span className="text-[11px] text-ink-3">{t('wb.driver')}</span> : !ready && <span className="text-[11px] text-ink-3">{accountBadge(p).label}</span>}
              </button>
            )
          })}
          <div className="mx-2 my-1 h-px bg-hairline" />
          <button className="flex h-9 w-full items-center gap-2 rounded-[10px] px-2.5 text-[13px] text-ink-2 hover:bg-black/[0.04] hover:text-ink" onClick={() => navigate('engines')}>
            <IconPlus size={15} /> {t('wb.addOrLogin')}
          </button>
        </div>
      )}
    </div>
  )
}

// ---- empty state -------------------------------------------------------------------------

function EmptyState({ projectDir, onPickProject, participants }: { projectDir: string | null; onPickProject: () => void; participants: ProfileId[] }) {
  const { navigate, profiles } = useApp()
  const ready = useSortedAccounts().filter((p) => isReady(p) && participants.includes(p.id))
  return (
    <div className="flex flex-1 flex-col items-center justify-center pb-10 text-center">
      <div className="text-[28px] leading-tight font-semibold tracking-tight text-ink">{t('wb.emptyTitle')}</div>
      <div className="mt-3 text-[14px] text-ink-2">
        {projectDir ? (
          <>
            {tNode('wb.project', { name: <span className="font-medium text-ink">{baseName(projectDir)}</span> })}
          </>
        ) : (
          <button className="text-accent hover:text-accent-hover" onClick={onPickProject}>
            {t('wb.pickProjectLink')}
          </button>
        )}
        <span className="mx-1.5 text-ink-3">·</span>
        {tNode('wb.atHint', { at: <span className="rounded-md bg-black/[0.05] px-1.5 py-0.5 font-mono text-[13px] text-ink">@</span> })}
      </div>
      {ready.length ? (
        <div className="mt-8 flex items-center gap-1.5">
          {ready.map((p) => (
            <span key={p.id} className="flex items-center gap-1.5 rounded-full bg-surface py-1 pr-3 pl-1 text-[12px] text-ink-2 shadow-[0_0_0_1px_var(--ring)]" title={t('wb.readyHint', { name: p.name })}>
              <KindAvatar kind={p.kind} size={20} />
              {p.name}
            </span>
          ))}
        </div>
      ) : (
        <div className="mt-8 flex flex-col items-center gap-2">
          <button className="flex items-center gap-1 text-[14px] font-medium text-accent hover:text-accent-hover" onClick={() => (profiles.length ? navigate('engines') : openOnboarding())}>
            {profiles.length ? t('wb.noReady') : t('wb.openGuide')} <IconArrowRight size={15} />
          </button>
          {profiles.length > 0 && (
            <button className="text-[12px] text-ink-3 hover:text-ink-2" onClick={openOnboarding}>
              {t('wb.orGuide')}
            </button>
          )}
        </div>
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

/** Long user messages start folded (≈6 lines); short ones never show the toggle. */
const FOLD_PX = 140

function UserText({ msg }: { msg: UserMessage }) {
  return (
    <div className="max-w-full rounded-[20px] rounded-br-md bg-accent text-[15px] leading-[1.7] text-white">
      <CollapsibleBody threshold={FOLD_PX + 40} collapsedHeight={FOLD_PX} fadeClass="to-accent" tone="bubble" className="overflow-hidden rounded-[inherit]">
        <div className="px-4 py-2.5 whitespace-pre-wrap select-text">{renderWithMentions(msg.text, msg.mentions)}</div>
      </CollapsibleBody>
    </div>
  )
}

function UserBubble({ msg }: { msg: UserMessage }) {
  const images = msg.attachments.filter((a) => a.isImage && (a.thumb || a.path))
  const files = msg.attachments.filter((a) => !(a.isImage && (a.thumb || a.path)))
  const [viewing, setViewing] = useState<Attachment | null>(null)
  return (
    <div className="flex flex-col items-end gap-1.5 pl-24">
      {viewing && <AttachmentViewer a={viewing} onClose={() => setViewing(null)} />}
      {images.length > 0 && (
        <div className="flex flex-wrap justify-end gap-2">
          {images.map((a) => (
            <button key={a.id} onClick={() => setViewing(a)} title={`${a.path ?? a.name}\n${t('md.clickZoom')}`} className="cursor-zoom-in rounded-2xl">
              <BubbleThumb a={a} />
            </button>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap justify-end gap-2">
          {files.map((a) => (
            <FileChip key={a.id} a={a} onOpen={() => setViewing(a)} />
          ))}
        </div>
      )}
      {msg.text && msg.kind === 'handoff' ? (
        <div className="flex items-center gap-1.5 rounded-full bg-black/[0.05] px-3 py-1 text-[12.5px] text-ink-2">
          <IconArrowRight size={13} className="text-accent" />
          {msg.text}
        </div>
      ) : (
        msg.text && <UserText msg={msg} />
      )}
      {msg.note && (
        <div className="flex items-center gap-1 text-[11px] text-info">
          <IconCheck size={11} /> {msg.note}
        </div>
      )}
      <div className="flex items-center gap-1 text-[11px] text-ink-3">
        {!msg.mentions.length && (
          <>
            {tNode('wb.sentTo', {
              who: (
                <>
                  <KindAvatar kind={msg.driver.kind} size={13} /> {msg.driver.name}
                </>
              )
            })}
          </>
        )}
        <span title={fullTime(msg.createdAt)}>{msgTime(msg.createdAt)}</span>
      </div>
    </div>
  )
}

/** Thumbnail in a sent bubble: the stored small JPEG, or the original file when there is none. */
function BubbleThumb({ a }: { a: Attachment }) {
  const [broken, setBroken] = useState(false)
  const src = a.thumb ?? (a.path ? fileUrl(a.path) : null)
  if (!src || broken)
    return <span className="flex h-24 w-24 items-center justify-center rounded-2xl bg-black/[0.05] px-2 text-center text-[11px] text-ink-3 shadow-[0_0_0_1px_var(--ring)]">{t('att.missingShort')}</span>
  return <img src={src} onError={() => setBroken(true)} className="h-24 w-24 rounded-2xl object-cover shadow-[0_0_0_1px_var(--ring)]" />
}

function FileChip({ a, onRemove, onOpen }: { a: Attachment; onRemove?: () => void; onOpen?: () => void }) {
  return (
    <span
      onClick={onOpen}
      className={`flex h-10 max-w-[220px] items-center gap-2 rounded-xl bg-surface pr-2 pl-2.5 text-[12px] text-ink shadow-[0_0_0_1px_var(--ring)] ${onOpen ? 'cursor-pointer hover:bg-surface-2' : ''}`}
      title={(a.path ?? a.name) + (onOpen ? `\n${t('att.clickPreview')}` : '')}
    >
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
          {msg.agent.model || msg.actualModel ? modelLabel(msg.agent.model || msg.actualModel, msg.agent.profileId) : t('wb.defaultModel')}
        </span>
      </span>
      {msg.dispatchedBy && <span className="rounded-full bg-black/[0.045] px-2 py-0.5 text-[11px] text-ink-2">{t('wb.dispatchedBy', { name: msg.dispatchedBy.name })}</span>}
      {msg.retry > 0 && !msg.review && <span className="rounded-full bg-warn-soft px-2 py-0.5 text-[11px] text-warn">{t('wb.retryN', { n: msg.retry })}</span>}
      {msg.verdict && (
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${msg.verdict.status === 'PASS' ? 'bg-ok-soft text-ok' : 'bg-warn-soft text-warn'}`}
          title={msg.verdict.reason}
        >
          {msg.verdict.status === 'PASS' ? t('wb.pass') : t('wb.reject')}
        </span>
      )}
      {streaming ? (
        <span className="flex items-center gap-1.5 text-[12px] text-accent">
          <Spinner size={11} /> {t('wb.replying', { dur: msg.startedAt ? fmtDur(Date.now() - msg.startedAt) : '' })}
        </span>
      ) : msg.status === 'queued' ? (
        <span className="text-[12px] text-ink-3">{t('wb.queued')}</span>
      ) : (
        msg.startedAt && (
          <span className="text-[12px] text-ink-3" title={t('wb.started', { time: fullTime(msg.startedAt) }) + (msg.endedAt ? '\n' + t('wb.ended', { time: fullTime(msg.endedAt) }) : '')}>
            {msgTime(msg.startedAt)} ·{' '}
            {msg.status === 'stopped' ? t('wb.stopped') : ''}
            {fmtDur((msg.endedAt ?? Date.now()) - msg.startedAt)}
          </span>
        )
      )}
    </div>
  )
}

/** Finished replies taller than this fold to REPLY_FOLD_PX (never while streaming). */
const REPLY_FOLD_AT = 360
const REPLY_FOLD_PX = 300

function AssistantBlock({ msg, latest = false }: { msg: AssistantMessage; latest?: boolean }) {
  const streaming = msg.status === 'streaming'
  useTicker(streaming)
  const rootRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)
  const [detailsSeq, setDetailsSeq] = useState(0)
  const detailsRef = useRef<HTMLDivElement>(null)
  const showDetails = () => {
    setDetailsSeq((n) => n + 1)
    detailsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const busy = msg.content || msg.activity.length > 0 || msg.thinking || msg.phase
  const copy = async () => {
    await window.agentswitch.sys.copy(stripMarks(msg.content))
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
    <div ref={rootRef} className="flex scroll-mt-16 gap-3 pr-10">
      <div className="pt-0.5">
        <KindAvatar kind={msg.agent.kind} size={28} />
      </div>
      <div className="min-w-0 flex-1">
        <SpeakerLine msg={msg} />
        <div className="mt-2">
          {msg.thinking && <ThinkingCard t={msg.thinking} live={streaming} />}
          <div ref={detailsRef} className="scroll-mt-4">
            {(msg.activity.length > 0 || (msg.others?.length ?? 0) > 0) && (
              <ActivityBar items={msg.activity} others={msg.others ?? []} live={streaming && !msg.content} openSeq={detailsSeq} />
            )}
          </div>
          {msg.content ? (
            <CollapsibleBody threshold={REPLY_FOLD_AT} collapsedHeight={REPLY_FOLD_PX} defaultOpen={latest || streaming} disabled={streaming} fadeClass="to-canvas" anchor={rootRef}>
              <Markdown text={msg.content} />
            </CollapsibleBody>
          ) : streaming ? (
            msg.activity.length === 0 && !(msg.thinking && !msg.thinking.endedAt) && (
              <div className="flex h-6 items-center gap-1">
                {[0, 1, 2].map((i) => (
                  <span key={i} className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-3" style={{ animationDelay: `${i * 160}ms` }} />
                ))}
              </div>
            )
          ) : (
            !msg.error && !msg.outputs.length && !msg.notices?.length && <div className="text-[14px] text-ink-3">{t('wb.noText')}</div>
          )}
          {streaming && busy && (
            <LiveProgress
              activity={msg.activity}
              phase={msg.phase}
              thinking={!!msg.thinking && !msg.thinking.endedAt}
              tail={msg.tail}
              startedAt={msg.startedAt}
              onDetails={msg.activity.length > 0 ? showDetails : undefined}
            />
          )}
          <Outputs msg={msg} />
          {(msg.notices ?? []).map((n, i) => (
            <div key={i} className="mt-2 flex items-start gap-2 rounded-xl bg-warn-soft px-3 py-2 text-[12px] leading-relaxed text-warn">
              <IconAlert size={14} className="mt-0.5 shrink-0" />
              <span className="min-w-0">{n}</span>
            </div>
          ))}
          {msg.error && (
            <div className="mt-2 flex items-start gap-2 rounded-xl bg-danger-soft px-3 py-2 text-[13px] leading-relaxed text-danger">
              <IconAlert size={15} className="mt-0.5 shrink-0" />
              <span className="min-w-0 break-words whitespace-pre-wrap select-text">{msg.error}</span>
            </div>
          )}
        </div>
        {!streaming && (msg.content || msg.usage) && (
          <div className="mt-1 -ml-2 flex items-center gap-2">
            {msg.content && (
              <button onClick={() => void copy()} className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12px] text-ink-3 transition-colors hover:bg-black/[0.05] hover:text-ink">
                {copied ? <IconCheck size={14} className="text-ok" /> : <IconCopy size={14} />}
                {copied ? t('common.copied') : t('common.copy')}
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
              onClick={() => void window.agentswitch.sys.showInFolder(p)}
              className="flex h-7 max-w-[260px] items-center gap-1.5 rounded-lg bg-black/[0.04] px-2.5 text-[12px] text-ink-2 hover:bg-black/[0.07] hover:text-ink"
              title={`${p}\n${t('common.showInFinder')}`}
            >
              <IconFile size={13} className="shrink-0" />
              <span className="truncate">{fileBase(p)}</span>
            </button>
          ))}
          {files.length > 12 && <span className="px-1 text-[12px] leading-7 text-ink-3">{t('wb.moreFiles', { n: files.length })}</span>}
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
        title={t('wb.driverHint')}
      >
        {driver ? <KindAvatar kind={driver.kind} size={22} /> : <span className="h-[22px] w-[22px] rounded-[6px] border border-dashed border-black/20" />}
        <span className="max-w-[150px] truncate">{driver?.name ?? t('wb.pickModel')}</span>
        <IconChevronDown size={13} className="text-ink-3" />
      </button>
      {open && (
        <div className={popover + ' absolute bottom-10 left-0 z-30 w-64'}>
          <div className="px-2.5 pt-1 pb-1.5 text-[12px] text-ink-3">{t('wb.driverAccount')}</div>
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
            <IconPlus size={15} /> {t('wb.manageAccounts')}
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
  const SOURCE = { catalog: t('wb.srcCatalog'), command: t('wb.srcCommand'), cache: t('wb.srcCache'), static: t('wb.srcStatic') }
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex h-7 max-w-[260px] items-center gap-1 rounded-full bg-black/[0.045] pr-2 pl-2.5 text-[12px] font-medium text-ink-2 transition-colors hover:bg-black/[0.07] hover:text-ink ${open ? 'bg-black/[0.08] text-ink' : ''}`}
        title={t('wb.subModelHint')}
      >
        <span className="truncate">{eff ? modelLabel(eff, account.id) : t('common.default')}</span>
        <IconChevronDown size={12} className="shrink-0 text-ink-3" />
      </button>
      {open && (
        <div className={popover + ' absolute bottom-9 left-0 z-30 flex max-h-[480px] w-80 flex-col'}>
          <div className="flex items-center gap-2 px-2.5 pt-1 pb-1.5 text-[12px] text-ink-3">
            <span className="min-w-0 flex-1 truncate">{t('wb.subModelOf', { name: account.name })}</span>
            <button onClick={refresh} disabled={loading} className="flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-black/[0.05] hover:text-ink disabled:opacity-60" title={t('wb.refetchModels')}>
              {loading ? <Spinner size={11} /> : <IconRefresh size={12} />} {t('common.refresh')}
            </button>
          </div>
          <EffortBar opt={cur.opt} effort={cur.effort} onChange={(e) => cur.model && onPick(withEffort(cur.opt, cur.model, e))} />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <button onClick={() => pick(null)} className={`flex w-full items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-left transition-colors ${!model ? 'bg-accent/10' : 'hover:bg-black/[0.04]'}`}>
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] leading-5 text-ink">{t('common.default')}</span>
                <span className="block truncate text-[10.5px] leading-4 text-ink-3">{account.defaultModel ? t('wb.accountDefault', { model: modelLabel(account.defaultModel, account.id) }) : defaultHint(account.kind)}</span>
              </span>
              {!model && <IconCheck size={15} className="text-accent" />}
            </button>
            {main.map(row)}
            {rest.length > 0 && (
              <button onClick={() => setMore((x) => !x)} className="flex h-8 w-full items-center gap-1 rounded-[10px] px-2.5 text-[12px] text-ink-3 hover:bg-black/[0.04] hover:text-ink-2">
                {more ? t('common.collapse') : t('wb.moreModels', { n: rest.length })}
                <IconChevronDown size={12} className={more ? 'rotate-180' : ''} />
              </button>
            )}
            {more && rest.map(row)}
          </div>
          {list && (
            <div className="px-2.5 pt-1 text-[11px] text-ink-3" title={list.error}>
              {t('wb.source', { src: SOURCE[list.source] })}
              {list.error ? t('wb.refreshFailed') : ''}
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
              placeholder={t('wb.customModel')}
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
  projectDir,
  onHeight,
  onSend,
  onStop,
  suggestion,
  footer
}: {
  driver: ProfileState | null
  driverModel: string | null
  onDriver: (id: ProfileId, model: string | null) => void
  participants: ProfileId[]
  busy: boolean
  threadId: string | null
  /** Project folder: decides which project-level skills / MCP servers apply. */
  projectDir: string | null
  onHeight: (h: number) => void
  /** Resolves false when the user declined to send (the draft comes back). */
  onSend: (text: string, attachments: Attachment[]) => Promise<boolean> | void
  onStop: () => void
  /** Next input the model suggested (ghost text; Tab takes it). */
  suggestion?: string | null
  /** Context line under the input card (project folder). */
  footer?: ReactNode
}) {
  const { toast, navigate } = useApp()
  const { sendKey } = useSettings()
  useModelsVersion()
  const accounts = useSortedAccounts()
  const [text, setText] = useState('')
  const [atts, setAtts] = useState<Attachment[]>([])
  const [drag, setDrag] = useState(false)
  /** @ menu: `sub` = index of the account whose sub-model list is open. */
  const [mention, setMention] = useState<{ start: number; query: string; index: number; sub: number | null; subIndex: number } | null>(null)
  /** / menu: skills and custom commands of the lead account in this project. */
  const [slash, setSlash] = useState<{ start: number; query: string; index: number } | null>(null)
  const skills = useSkills(driver?.id ?? null, projectDir, !!slash)
  const skillItems = skills.data?.items ?? []
  const pins = usePins(driver?.kind)
  // pinned skills lead the / menu while nothing is typed; with a query they win ties only
  const slashMatches = useMemo(() => {
    if (!slash) return []
    const found = filterSkills(skillItems, slash.query)
    return slash.query ? found : pinnedFirst(found, pins)
  }, [slash, skillItems, pins])
  /** Extensions panel (skills, agents, plugins, MCP, rules & hooks), read-only. */
  const [extOpen, setExtOpen] = useState(false)
  const overview = useOverview(driver?.id ?? null, projectDir, true)
  const closeExt = useCallback(() => setExtOpen(false), [])
  const reloadOverview = overview.reload
  useEffect(() => {
    if (extOpen) void reloadOverview()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extOpen])
  const ta = useRef<HTMLTextAreaElement>(null)
  const ghost = !!suggestion && !text && !atts.length && !mention && !slash
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

  // @ candidates: ready accounts; others first (participants before the rest), the current driver
  // last. Display name wins; the underlying CLI name ("Claude Code") is only a fallback when
  // nothing matches by name, so `@cod` → Codex only.
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
      .map((p, i) => ({ p, s: score(p), i: i - (participants.includes(p.id) ? 1000 : 0) + (p.id === driver?.id ? 100000 : 0) }))
      .filter((x) => x.s >= 0)
    const byName = scored.filter((x) => x.s < 9)
    const isDriver = (x: { p: ProfileState }) => Number(x.p.id === driver?.id)
    return (byName.length ? byName : scored).sort((a, b) => isDriver(a) - isDriver(b) || a.s - b.s || a.i - b.i).map((x) => x.p)
  }, [mention, accounts, participants, driver])

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

  /**
   * Opens / updates / closes the @ menu from the text before the caret. `@` (or full-width `＠`)
   * triggers anywhere except right after a letter or digit (e-mail addresses): line start, after a
   * space and right after Chinese text (`让@`). Same `@` and query -> the menu keeps its selection.
   */
  const syncMention = (value: string, caret: number | null) => {
    if (caret === null) return setMention(null)
    // closed with Esc: stay closed until the text or the caret changes
    const d = dismissed.current
    if (d && d.value === value && d.caret === caret) return
    dismissed.current = null
    const before = value.slice(0, caret)
    const m = /(?:^|[^A-Za-z0-9_.+\-])[@＠]([^\s@＠]{0,24})$/.exec(before)
    if (!m) {
      setMention(null)
      // `/` (or full-width `／`) at the start of a line or after a space opens the skill menu
      const sl = /(?:^|\s)[/／]([^\s/／]{0,48})$/.exec(before)
      if (!sl) return setSlash(null)
      // no account at all: the menu still opens, showing its empty state
      const at = caret - sl[1].length - 1
      return setSlash((cur) => (cur && cur.start === at && cur.query === sl[1] ? cur : { start: at, query: sl[1], index: 0 }))
    }
    setSlash(null)
    const start = caret - m[1].length - 1
    setMention((cur) => (cur && cur.start === start && cur.query === m[1] ? cur : { start, query: m[1], index: 0, sub: null, subIndex: 0 }))
  }
  const composingRef = useRef(false)
  const dismissed = useRef<{ value: string; caret: number } | null>(null)

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

  /** Replaces `/query` with the skill's trigger (`/name` or `$name`) followed by a space. */
  const insertSkill = (it: SkillItem) => {
    if (!slash) return
    const caret = ta.current?.selectionStart ?? text.length
    const token = `${it.insert} `
    setText(text.slice(0, slash.start) + token + text.slice(caret))
    setSlash(null)
    requestAnimationFrame(() => {
      const el = ta.current
      if (!el) return
      const pos = slash.start + token.length
      el.focus()
      el.setSelectionRange(pos, pos)
    })
  }

  /** Inserts a token at the caret (space-separated from what is around it) and focuses the box. */
  const insertAtCaret = (token: string) => {
    const el = ta.current
    const start = el?.selectionStart ?? text.length
    const end = el?.selectionEnd ?? start
    const before = text.slice(0, start)
    const lead = before && !/\s$/.test(before) ? ' ' : ''
    const piece = lead + token + (/[\s：:]$/.test(token) ? '' : ' ')
    setText(before + piece + text.slice(end))
    setExtOpen(false)
    requestAnimationFrame(() => {
      const box = ta.current
      if (!box) return
      const pos = start + piece.length
      box.focus()
      box.setSelectionRange(pos, pos)
    })
  }

  const addFiles = async (files: File[]) => {
    if (!files.length) return
    const next = await Promise.all(files.map(toAttachment))
    setAtts((a) => [...a, ...next].slice(0, 12))
  }

  const canSend = !busy && !!driver && (text.trim().length > 0 || atts.length > 0)
  const doSend = () => {
    if (busy) return toast({ kind: 'info', title: t('wb.busyTitle'), desc: t('wb.busyDesc') })
    if (!driver) return toast({ kind: 'warn', title: t('wb.noModel'), action: { label: t('wb.addAccount'), run: () => navigate('engines') } })
    if (!text.trim() && !atts.length) return
    if (!isReady(driver))
      return toast({
        kind: 'warn',
        title: t('wb.notUsable', { name: driver.name }),
        desc: accountBadge(driver).label,
        action: { label: driver.status === 'uninstalled' ? t('wb.goInstall') : t('wb.goLogin'), run: () => navigate('engines', driver.id) }
      })
    const sentText = text
    const sentAtts = atts
    const r = onSend(text.trim(), atts)
    setText('')
    setAtts([])
    // cancelled (e.g. the session is being written elsewhere): give the draft back if still empty
    void r?.then((ok) => {
      if (ok) return
      setText((cur) => cur || sentText)
      setAtts((cur) => (cur.length ? cur : sentAtts))
    })
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
        dismissed.current = { value: e.currentTarget.value, caret: e.currentTarget.selectionStart }
        return setMention(null)
      }
    }
    if (slash && !mention && !composing) {
      const n = slashMatches.length
      if (n && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault()
        const d = e.key === 'ArrowDown' ? 1 : -1
        return setSlash((x) => x && { ...x, index: (x.index + d + n) % n })
      }
      if (n && (e.key === 'Enter' || e.key === 'Tab')) {
        e.preventDefault()
        return insertSkill(slashMatches[Math.min(slash.index, n - 1)])
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        dismissed.current = { value: e.currentTarget.value, caret: e.currentTarget.selectionStart }
        return setSlash(null)
      }
    }
    // suggested next input: Tab takes it as editable text, Esc drops it
    if (ghost && !composing && !mention && !slash) {
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault()
        const v = suggestion!
        setText(v)
        if (threadId) clearSuggestion(threadId)
        requestAnimationFrame(() => {
          const el = ta.current
          if (!el) return
          el.focus()
          el.setSelectionRange(v.length, v.length)
        })
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        if (threadId) clearSuggestion(threadId)
        return
      }
    }
    if (e.key !== 'Enter' || composing) return
    const mod = e.metaKey || e.ctrlKey
    // enter: Enter sends, Shift+Enter newline. mod-enter: ⌘+Enter sends, Enter newline.
    if (sendKey === 'enter' ? !e.shiftKey && !mod : mod) {
      e.preventDefault()
      doSend()
    }
  }

  return (
    <div ref={wrap} className="pointer-events-none absolute inset-x-0 bottom-0 bg-[linear-gradient(to_bottom,transparent,var(--canvas)_42%)] px-8 pt-8 pb-6">
      <div className="pointer-events-auto relative mx-auto max-w-[820px]">
        {extOpen && (
          <div className="absolute bottom-full left-0 z-30 mb-2">
            <ExtensionsPanel account={driver} data={overview.data} loading={overview.loading} onReload={() => void overview.reload()} onInsert={insertAtCaret} onClose={closeExt} />
          </div>
        )}
        {!extOpen && !mention && slash && (
          <div className="absolute bottom-full left-0 z-30 mb-2">
            <SlashMenu
              account={driver}
              items={slashMatches}
              total={skillItems.length}
              loading={skills.loading}
              active={Math.min(slash.index, Math.max(0, slashMatches.length - 1))}
              pinned={pins}
              onPick={insertSkill}
              onHover={(i) => setSlash((x) => x && { ...x, index: i })}
            />
          </div>
        )}
        {mention && (
          <div className="absolute bottom-full left-0 z-30 mb-2 flex items-end gap-2">
            <div className={popover + ' w-72'}>
              <div className="flex items-center gap-1.5 px-2.5 pt-1 pb-1.5 text-[12px] text-ink-3">
                <IconAt size={13} /> {t('wb.inviteModels')} <span className="ml-auto">{t('wb.pickSubHint')}</span>
              </div>
              {matches.length ? (
                matches.map((p, i) => (
                  <AccountRow
                    key={p.id}
                    p={p}
                    active={i === (mention.sub ?? mention.index)}
                    onClick={() => insertMention(p, null)}
                    trailing={
                      <>
                      {p.id === driver?.id && <span className="text-[11px] text-ink-3">{t('wb.current')}</span>}
                      <span
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={(e) => {
                          e.stopPropagation()
                          setMention((m) => m && { ...m, index: i, sub: m.sub === i ? null : i, subIndex: 0 })
                        }}
                        className="rounded-full bg-black/[0.05] px-2 py-0.5 text-[11px] text-ink-2 hover:bg-black/[0.09]"
                        title={t('wb.pickSub')}
                      >
                        {p.defaultModel ? modelLabel(p.defaultModel, p.id) : t('common.default')} ›
                      </span>
                      </>
                    }
                  />
                ))
              ) : (
                <div className="px-2.5 py-2 text-[13px] text-ink-3">{t('wb.noMatchReady')}</div>
              )}
            </div>
            {mention.sub !== null && matches[mention.sub] && (() => {
              const p = matches[mention.sub]
              const opts = subOptions(p)
              const hot = opts[mention.subIndex]
              const hotOpt = hot ? (findModel(hot, p.id)?.opt ?? null) : null
              return (
                <div className={popover + ' flex max-h-[400px] w-80 flex-col'}>
                  <div className="px-2.5 pt-1 pb-1.5 text-[12px] text-ink-3">{t('wb.subModelsOf', { name: p.name })}</div>
                  <EffortBar opt={hotOpt} effort={subEffort} onChange={setSubEffort} />
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    {opts.map((m, j) => {
                      const o = m ? findModel(m, p.id)?.opt : null
                      return (
                        <ModelRow
                          key={m ?? '_'}
                          m={m ? { id: m, label: o ? stripLatest(o.label) : m } : { id: t('common.default'), label: t('common.default') }}
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
          className={`relative rounded-[24px] bg-surface shadow-[0_0_0_1px_var(--ring),0_4px_12px_rgba(0,0,0,0.05),0_16px_40px_rgba(0,0,0,0.08)] transition-shadow ${
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
                    <img src={a.thumb} className="h-16 w-16 rounded-xl object-cover shadow-[0_0_0_1px_var(--ring)]" />
                    <button
                      onClick={() => setAtts((x) => x.filter((y) => y.id !== a.id))}
                      className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-ink text-canvas opacity-0 shadow transition-opacity group-hover:opacity-100"
                      title={t('common.remove')}
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

          {ghost && (
            <span className="pointer-events-none absolute top-[17px] right-4 rounded-[5px] px-1.5 py-px font-mono text-[10.5px] leading-4 text-ink-3 shadow-[inset_0_0_0_1px_var(--ring),0_1px_0_var(--ring)]" title={t('wb.tabAccept')}>
              Tab
            </span>
          )}
          <textarea
            ref={ta}
            rows={1}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              if (e.target.value && suggestion && threadId) clearSuggestion(threadId)
              // mid-composition text is pinyin, not the query: wait for compositionend
              if (!composingRef.current) syncMention(e.target.value, e.target.selectionStart)
            }}
            onCompositionStart={() => (composingRef.current = true)}
            onCompositionEnd={(e) => {
              composingRef.current = false
              syncMention(e.currentTarget.value, e.currentTarget.selectionStart)
            }}
            // caret moved (click, ←/→, Home/End) without typing: reopen / close for that position
            onSelect={(e) => {
              const el = e.currentTarget
              if (!composingRef.current && el.selectionStart === el.selectionEnd) syncMention(el.value, el.selectionStart)
            }}
            onBlur={() => {
              setMention(null)
              setSlash(null)
            }}
            onKeyDown={onKey}
            onPaste={(e) => {
              const files = [...e.clipboardData.files]
              if (files.length) {
                e.preventDefault()
                void addFiles(files)
              }
            }}
            placeholder={ghost ? suggestion! : driver ? t('wb.placeholder', { name: driver.name }) : t('wb.placeholderNone')}
            className={`block max-h-[200px] w-full resize-none bg-transparent pt-4 pb-1 pl-5 text-[15px] leading-[22px] text-ink outline-none placeholder:text-ink-3 ${ghost ? 'pr-16 placeholder:text-ink-3/80' : 'pr-5'}`}
          />

          <div className="flex items-center gap-1 px-3 pt-1 pb-3">
            <DriverPicker driver={driver} onPick={(id) => onDriver(id, null)} />
            <QuotaDot driver={driver} model={driverModel} onSwitch={(id) => onDriver(id, null)} />
            {driver && <ModelCapsule account={driver} model={driverModel} onPick={(m) => onDriver(driver.id, m)} />}
            {driver && <ExtensionsButton data={overview.data} open={extOpen} onToggle={() => setExtOpen((o) => !o)} />}
            <div className="mx-1.5 h-4 w-px bg-black/[0.08]" />
            <button
              onClick={() => fileInput.current?.click()}
              className="flex h-8 w-8 items-center justify-center rounded-full text-ink-2 transition-colors hover:bg-fill hover:text-ink"
              title={t('wb.attachHint')}
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
              <button onClick={onStop} className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-canvas transition-transform active:scale-95" title={t('common.stop')}>
                <IconStop size={14} />
              </button>
            ) : (
              <button
                onClick={doSend}
                disabled={!canSend}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-white shadow-[0_1px_2px_rgba(0,122,255,0.35)] transition-all hover:bg-accent-hover active:scale-95 disabled:bg-black/[0.08] disabled:text-ink-3 disabled:shadow-none"
                title={t('wb.sendHint', { key: sendKeys(sendKey).send })}
              >
                <IconArrowUp size={17} strokeWidth={2.2} />
              </button>
            )}
          </div>
        </div>
        {footer}
      </div>
    </div>
  )
}
