import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import type { CheckpointStatus, RewindPlan } from '@shared/checkpoints'
import type { OutputFileRef } from '@shared/chat'
import { deriveRelativePath, extractMarkdownImageTargets, findMatchingOutputFile, isPreviewableImagePath, joinPosixRelative, outputRefsForMessage, resolveOutputFileCandidates } from '@shared/fileResolve'
import { defaultContextWindowFor, getProviderCapabilities } from '@shared/providerCapabilities'
import type { ModelOption, ProfileId, ProfileState, SkillItem } from '@shared/types'
import { QuickSkillsButton, QuickSkillsPopover } from '../components/Extensions'
import { FileSearchMenu } from '../components/FileSearchMenu'
import { usePins, useSkills } from '../state/extensions'
import { useFileSearch, type ComposerFileCandidate } from '../state/useFileSearch'
import { openOnboarding } from '../state/onboarding'
import { useApp, useSortedAccounts } from '../state/AppContext'
import { groupQuickSkills, matchSlashTrigger, type SlashTrigger } from '../lib/slashTrigger'
import {
  clampFileTreeWidth, clampPanelHeight, clampPanelWidth, EDITOR_CHAT_MIN_W, EDITOR_PANEL_DEFAULT_H,
  EDITOR_PANEL_DEFAULT_W, EDITOR_TREE_DEFAULT_W, setEditorDockPosition, TRAFFIC_LIGHT_SAFE_LEFT_PX,
  type EditorDockPosition, type EditorFileTreePosition
} from '../lib/editorLayout'
import { KIND_META, accountBadge, btnPrimary, btnSecondary, desktopToolbarButton, isReady, isSignedIn, popover } from '../lib/ui'
import { defaultHint, effectiveModel, modelLabel, resolveSpec, withEffort } from '../lib/models'
import { KindAvatar, Modal, ProfileAvatar } from '../components/common'
import { AttachmentViewer } from '../components/AttachmentViewer'
import { attachmentPaths, MissingFile, usePathsExist, type PathExistence } from '../components/FilePreview'
import { AttachmentBar, attachmentTitle } from '../components/AttachmentBar'
import { stripMarks } from '@shared/markers'
import { maskCode } from '@shared/mentions'
import { EffortBar } from '../components/EffortBar'
import { QuotaDot } from '../components/Usage'
import { estimateMessageCost, fmtTokens, useUsage } from '../state/usage'
import { ActivityBar, LiveProgress, PermissionCard, ThinkingCard, UsageLine } from '../components/Process'
import { CHANGES_PANEL_MIN_W, ChangesPanel, Counts, useFileChanges } from '../components/ChangesPanel'
import { CodeEditorPanel } from '../components/CodeEditorPanel'
import { QuickOpenModal } from '../components/QuickOpenModal'
import { useCodeEditor } from '../state/useCodeEditor'
import { GitGraphView } from '../components/GitGraphView'
import { gitConflictLabel } from '../components/GitConflicts'
import { ProjectBar } from '../components/ProjectBar'
import { GitBranchMenu, GitSyncBar } from '../components/GitBranchMenu'
import { useProjectGit } from '../state/useProjectGit'
import { CheckpointUndo, useCheckpoints } from '../components/CheckpointUndo'
import { CollapsibleBody } from '../components/CollapsibleBody'
import { escLayers, useEscape } from '../lib/escStack'
import { COMPOSER_MAX_HEIGHT, composerEscapeAction, nextComposerExpanded, showComposerExpand } from '../lib/composerExpand'
import { applyFileReference, insertFileReferenceAtCaret, matchFileTrigger, type FileTrigger } from '../lib/fileMention'
import { attachmentRefLabel, COMPOSER_ATTACHMENT_LIMIT, formatLineRangeSuffix, mergeAttachments, removeFileReferences, scanFileReferences, type FileLineRange, type FileReferenceSpan } from '@shared/fileReferences'
import { scrollListTo } from '../lib/scrollList'
import { shouldShowTaskSummaryBar, TASK_SUMMARY_IDLE_MS } from '../lib/taskSummaryNotice'
import { loadInputHistory, pushInputHistory, stepInputHistory, type HistoryCursor } from '../lib/inputHistory'
import {
  COMPACT_COMMAND_INSERT,
  computeContextNotice,
  computeContextState,
  isCompactCommand,
  makeCompactSlashItem,
  type ContextNoticeDismissal
} from '../lib/compactCommand'
import { useStartThread } from '../state/threads'
import { Markdown, MarkdownBase, OutputImage } from '../components/Markdown'
import { IconAlert, IconArchive, IconArrowRight, IconArrowUp, IconAt, IconCheck, IconChevronDown, IconClock, IconCompact, IconCopy, IconEdit, IconFile, IconFolder, IconFolderTree, IconMaximize, IconMinimize, IconPlus, IconQuote, IconRefresh, IconSidebar, IconStop, IconTerminal, IconX, Spinner } from '../components/icons'
import { findModel, getModelList, loadModels, useModels, useModelsVersion } from '../state/models'
import {
  activeThread,
  clearQueuedMessages,
  clearSuggestion,
  continueInNewThread,
  continueQueuedMessages,
  compactContext,
  editQueuedMessage,
  exportHandoff,
  isThreadBusy,
  lastSpeaker,
  loadHistory,
  newThread,
  rebindThreadProject,
  removeQueuedMessage,
  rewindThread,
  skipHandoff,
  threadMessages,
  onExternalSync,
  resolvePause,
  send,
  stop,
  toAttachment,
  unarchiveThread,
  updateThread,
  useChat,
  type Activity,
  type AgentRef,
  type AssistantMessage,
  type Attachment,
  type MessageQuote,
  type SystemMessage,
  type Thread,
  type UserMessage,
  NEW_DRAFT,
  clearComposerDraft,
  composerDraft,
  saveComposerDraft
} from '../state/chat'
import { fmtDuration, t, tNode } from '../state/i18n'
import { isPendingPermission } from '../state/permissionState'
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

function makeQuote(msg: UserMessage | AssistantMessage): MessageQuote | null {
  const raw = msg.role === 'user' ? msg.text : stripMarks(msg.content)
  const excerpt = raw.replace(/\r\n/g, '\n').trim()
  if (!excerpt) return null
  const capped = excerpt.length > 360 ? excerpt.slice(0, 360).trimEnd() + '…' : excerpt
  return {
    messageId: msg.id,
    role: msg.role,
    author: msg.role === 'user' ? t('chat.mdYou') : msg.agent.name,
    excerpt: capped
  }
}

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

/** `@Name` or `@Name(model)` tokens for the given accounts, in text order (code blocks / inline code skipped). */
function parseMentions(text: string, accounts: ProfileState[], files: FileReferenceSpan[]): { p: ProfileState; model: string | null; index: number; length: number }[] {
  const out: { p: ProfileState; model: string | null; index: number; length: number }[] = []
  const taken: [number, number][] = files.map(({ start, end }) => [start, end])
  const plain = maskCode(text)
  for (const p of [...accounts].sort((a, b) => b.name.length - a.name.length)) {
    const re = new RegExp('@' + escapeRe(p.name) + '(?:\\(([^)\\s]+)\\))?', 'g')
    for (const m of plain.matchAll(re)) {
      const s = m.index!
      if (taken.some(([a, b]) => s < b && s + m[0].length > a)) continue
      taken.push([s, s + m[0].length])
      out.push({ p, model: m[1] ?? null, index: s, length: m[0].length })
    }
  }
  return out.sort((a, b) => a.index - b.index)
}

/**
 * Text of the composer mirror: plain runs as-is, mentions as accent capsules. The capsule
 * background reaches past the glyphs through box-shadow only (no padding / margin), so every
 * character keeps the exact position it has in the textarea above and the caret lines up.
 */
function mirrorSegments(text: string, spans: { index: number; length: number }[]): ReactNode[] {
  const out: ReactNode[] = []
  let at = 0
  for (const s of spans) {
    if (s.index > at) out.push(text.slice(at, s.index))
    out.push(
      <span key={s.index} spellCheck={false} className="mention-capsule text-accent">
        {text.slice(s.index, s.index + s.length)}
      </span>
    )
    at = s.index + s.length
  }
  if (at < text.length) out.push(text.slice(at))
  // a trailing newline only gets its own line box when something follows it
  out.push('\u200b')
  return out
}

/**
 * Context window when the CLI doesn't report one (tokens). Claude: 200k, or 1M for `[1m]`
 * variants; Codex: 272k (its runs normally report the real window); Gemini and Reasonix: 1M.
 */
function contextWindow(kind: ProfileState['kind'], model: string | null): number {
  return defaultContextWindowFor(kind, model)
}

export function WorkbenchPage() {
  const { byId, profiles, info, confirm, toast, drawer, openDrawer, closeDrawer, sidebarOpen, toggleSidebar,
    trafficLightOwner, editorLayout: layout, setEditorLayout, setEditorMaximized, setWorkspaceEditorOpen } = useApp()
  const { showDebugTerminal, showGitTools } = useSettings()
  const chat = useChat()
  const thread = activeThread(chat)
  const sorted = useSortedAccounts()

  // settings for a conversation that hasn't been created yet (no thread selected)
  const draft = useDraft()

  const ctx: Ctx = thread ?? draft
  const update = (patch: Partial<Ctx>) => (thread ? updateThread(thread.id, patch) : patchDraft(patch))

  // participants default to every signed-in account when unset
  const participants = ctx.participants.length ? ctx.participants.filter((id) => byId(id)) : sorted.filter(isSignedIn).map((p) => p.id)
  const driverP = pickDriver(ctx, sorted, participants)
  const driverModel = ctx.driver.profileId === driverP?.id ? ctx.driver.model : null
  const setDriver = (id: ProfileId, model: string | null) =>
    update({ driver: { profileId: id, model }, participants: participants.includes(id) ? participants : [...participants, id] })

  // Started chats change their folder through rebind so old CLI sessions cannot resume there.
  const projectLocked = !!thread && (!!thread.imported || thread.messages.some((m) => m.role === 'user'))
  const [previewRevision, refreshPreviews] = useReducer((n: number) => n + 1, 0)
  const projectDir = ctx.projectDir
  const sourceProjectDir = thread?.sourceProjectDir
  const projectExists = usePathsExist(projectDir ? [projectDir] : [], previewRevision)
  const projectMissing = !!thread && (projectDir ? projectExists[projectDir] === false : !!sourceProjectDir)
  const rebinding = useRef(false)
  const threadId = thread?.id
  const canRebindProject = !!thread && !thread.preview && !thread.pause && !isThreadBusy(thread)
  const rebindProject = useCallback(async () => {
    if (!threadId || !canRebindProject || rebinding.current) return
    rebinding.current = true
    try {
      const dir = await window.agentswitch.sys.pickProject(projectMissing ? undefined : projectDir ?? undefined)
      if (dir && rebindThreadProject(threadId, dir)) refreshPreviews()
    } catch (error) {
      toast({ kind: 'error', title: t('proj.rebindFailed'), desc: error instanceof Error ? error.message : String(error) })
    } finally {
      rebinding.current = false
    }
  }, [threadId, canRebindProject, projectMissing, projectDir, toast])
  const onRebindProject = useMemo(() => canRebindProject ? () => void rebindProject() : undefined, [canRebindProject, rebindProject])
  const startThread = useStartThread()
  const pickProject = async () => {
    if (projectLocked) return
    const dir = await window.agentswitch.sys.pickProject(ctx.projectDir ?? undefined)
    if (dir) update({ projectDir: dir })
  }

  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const scrollingToBottom = useRef(false)
  const scrollTimer = useRef<number | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [composerH, setComposerH] = useState(150)
  const scrollToBottom = useCallback(() => {
    const el = scroller.current
    if (!el) return
    stick.current = true
    scrollingToBottom.current = true
    setAtBottom(true)
    if (scrollTimer.current) window.clearTimeout(scrollTimer.current)
    scrollTimer.current = window.setTimeout(() => {
      scrollingToBottom.current = false
      scrollTimer.current = null
    }, 650)
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [])
  useEffect(() => () => {
    if (scrollTimer.current) window.clearTimeout(scrollTimer.current)
  }, [])
  const messages = useMemo(() => threadMessages(thread), [thread])
  const filePaths = useMemo(() => messages.flatMap((msg) => {
    if (msg.role === 'user') return msg.attachments.flatMap((a) => attachmentPaths(a, projectDir))
    if (msg.role !== 'assistant') return []
    return outputRefsForMessage(msg, projectDir, sourceProjectDir)
      .filter((file) => !file.inlineOnly && !isOutputImage(file)).slice(0, 12)
      .flatMap((file) => resolveOutputFileCandidates(file, projectDir))
  }), [messages, projectDir, sourceProjectDir])
  const codeEditor = useCodeEditor(projectDir)
  const layoutRef = useRef<HTMLDivElement>(null)
  const [layoutSize, setLayoutSize] = useState<{ width: number; height: number }>()
  const { dockPosition, fileTreePosition, fileTreeVisible } = layout
  const editorMaximized = codeEditor.open && dockPosition === 'maximized'
  const editorOnLeft = codeEditor.open && dockPosition === 'left'
  const editorOnSide = editorOnLeft || (codeEditor.open && dockPosition === 'right')
  const editorOnBottom = codeEditor.open && dockPosition === 'bottom'
  const panelWidth = clampPanelWidth(layout.panelWidth, layoutSize?.width)
  const panelHeight = clampPanelHeight(layout.panelHeight, layoutSize?.height)
  const treeContainerWidth = editorOnSide ? panelWidth - 1 : layoutSize?.width
  const treeWidth = clampFileTreeWidth(layout.fileTreeWidth, treeContainerWidth)
  const changesOverlay = layoutSize !== undefined
    && layoutSize.width - (editorOnSide ? panelWidth : 0) < EDITOR_CHAT_MIN_W + CHANGES_PANEL_MIN_W

  useLayoutEffect(() => {
    setWorkspaceEditorOpen(codeEditor.open)
  }, [codeEditor.open, setWorkspaceEditorOpen])
  useLayoutEffect(() => () => setWorkspaceEditorOpen(false), [setWorkspaceEditorOpen])
  useLayoutEffect(() => {
    const container = layoutRef.current
    if (!container) return
    const measure = () => {
      const { clientWidth: width, clientHeight: height } = container
      setLayoutSize((prior) => prior?.width === width && prior.height === height ? prior : { width, height })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  const changeDock = (position: EditorDockPosition) => {
    setEditorLayout((prefs) => setEditorDockPosition(prefs, position))
  }
  const changeTreePosition = (position: EditorFileTreePosition | 'hidden') => {
    setEditorLayout((prefs) => ({
      ...prefs,
      fileTreePosition: position === 'hidden' ? prefs.fileTreePosition : position,
      fileTreeVisible: position !== 'hidden'
    }))
  }

  const [quickOpen, setQuickOpen] = useState(false)
  useEffect(() => {
    const onQuickOpenKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && !e.isComposing && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setQuickOpen(true)
      }
    }
    window.addEventListener('keydown', onQuickOpenKey)
    return () => window.removeEventListener('keydown', onQuickOpenKey)
  }, [])
  const fileExists = usePathsExist(filePaths, previewRevision)
  const markdownBase = useMemo(() => ({
    baseDir: thread?.workdir ?? projectDir, home: info?.realHome ?? null, projectDir, sourceProjectDir, onRebindProject, onOpenEditorFile: codeEditor.openFile, revision: previewRevision
  }), [thread?.workdir, projectDir, info?.realHome, sourceProjectDir, onRebindProject, codeEditor.openFile, previewRevision])
  const checkpoints = useCheckpoints(thread?.id)
  const checkpointReplies = useMemo(() => {
    const turns = new Map(checkpoints.turns?.map(({ turnId, status }) => [turnId, status]))
    const replies = new Map<string, CheckpointStatus>()
    for (const message of [...messages].reverse()) {
      if (message.role !== 'assistant' || message.status === 'queued' || (message.status === 'stopped' && !message.startedAt)) continue
      const status = turns.get(message.turnId)
      if (status) {
        replies.set(message.id, status)
        turns.delete(message.turnId)
      }
    }
    return replies
  }, [messages, checkpoints.turns])
  /** Text-only sent prompts for ↑/↓ recall: current thread's user messages, or recent global prompts in a new chat. */
  const inputHistory = useMemo(() => {
    const out: string[] = []
    for (const m of messages) {
      if (m.role !== 'user') continue
      const s = m.text.trim()
      if (s && out[out.length - 1] !== s) out.push(s)
    }
    return out.length ? out : loadInputHistory()
  }, [messages])
  // the newest reply starts expanded; older long replies start folded
  const lastReplyId = useMemo(() => [...messages].reverse().find((m) => m.role === 'assistant')?.id ?? null, [messages])
  // imported history is not persisted: re-read it from the CLI files when the thread opens
  useEffect(() => {
    if (!thread?.imported || thread.history || thread.historyState) return
    const p = byId(thread.imported.profileId)
    if (!p) return // wait for account names (or the account was removed: nothing to resume with)
    void loadHistory(thread.id, { profileId: p.id, name: p.name, kind: p.kind, model: null })
  }, [thread?.id, thread?.imported, thread?.history, thread?.historyState, byId])

  // ---- cross-model handoff: the driver switched away from the latest speaker's native session
  const speaker = thread ? lastSpeaker(thread) : null
  const srcP = speaker ? byId(speaker.profileId) : undefined
  const sameNativeSession =
    !!driverP &&
    !!speaker &&
    (speaker.profileId === driverP.id ||
      (!!srcP && srcP.kind === driverP.kind && !!srcP.sessionStoreKey && srcP.sessionStoreKey === driverP.sessionStoreKey))
  const handoffNeeded =
    !!thread &&
    !!driverP &&
    !!speaker &&
    !isThreadBusy(thread) &&
    !sameNativeSession &&
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
  const doExport = async (toNewThread = false) => {
    if (!thread || !driverP) return
    setExporting(true)
    try {
      await exportHandoff(thread.id, ref(driverP, driverModel), toNewThread)
    } finally {
      setExporting(false)
    }
  }

  // ---- context notices: ephemeral per-visit dismissal so switching away and returning shows
  // them again while context stays above threshold.
  const [ctxDismissed, setCtxDismissed] = useState<ContextNoticeDismissal | null>(null)
  useEffect(() => {
    setCtxDismissed(null)
  }, [thread?.id])
  const contextStats = useMemo(() => {
    const state = computeContextState(messages, driverP?.id, thread?.carriedMessageCount ?? 0, thread?.imported, thread?.preview)
    // the window the CLI reported (codex, agy ACP) wins; otherwise it follows from the model
    const window = state.reportedWindow || (driverP ? contextWindow(driverP.kind, driverModel ?? state.model) : 0)
    return { ...state, window }
  }, [messages, driverP, driverModel, thread?.carriedMessageCount, thread?.imported, thread?.preview])
  const canShowContextNotice =
    !!thread &&
    !!driverP &&
    !isThreadBusy(thread) &&
    !handoffNeeded &&
    !handoffReady &&
    !thread.pause
  const contextNotice = canShowContextNotice
    ? computeContextNotice({
        threadId: thread.id,
        lastTokens: contextStats.lastTokens,
        lastId: contextStats.lastId,
        window: contextStats.window,
        userTurns: contextStats.userTurns,
        dismissed: ctxDismissed,
        compactedMessageId: thread.contextCostDismissed?.compacted ? thread.contextCostDismissed.messageId : null
      })
    : null
  const contextLong = contextNotice === 'long'
  const contextCostly = contextNotice === 'costly'
  const dismissWarn = () => {
    if (!thread) return
    setCtxDismissed((prev) => ({
      ...(prev?.threadId === thread.id ? prev : { threadId: thread.id }),
      warnAt: contextStats.userTurns
    }))
  }
  const dismissCost = () => {
    if (!thread) return
    setCtxDismissed((prev) => ({
      ...(prev?.threadId === thread.id ? prev : { threadId: thread.id }),
      cost: { messageId: contextStats.lastId, userTurns: contextStats.userTurns }
    }))
  }
  const [compacting, setCompacting] = useState(false)
  const canCompact = !!thread && !!driverP && !isThreadBusy(thread) && !thread.pause && contextStats.hasActiveSession
  const startCompact = useCallback(async () => {
    if (!driverP) return
    if (thread && (isThreadBusy(thread) || !!thread.pause)) {
      toast({ kind: 'warn', title: t('wb.compactBusy') })
      return
    }
    if (!thread || !contextStats.hasActiveSession) {
      toast({ kind: 'warn', title: t('wb.ctxCompactNone') })
      return
    }
    if (compacting) return
    setCompacting(true)
    try {
      stick.current = true
      const ok = await compactContext(thread.id, [driverP.id], contextStats.lastId, contextStats.userTurns)
      toast(ok ? { kind: 'success', title: t('wb.ctxCompactDone', { name: driverP.name }) } : { kind: 'warn', title: t('wb.ctxCompactNone') })
    } finally {
      setCompacting(false)
    }
  }, [thread, driverP, contextStats.hasActiveSession, contextStats.lastId, contextStats.userTurns, compacting, toast])
  const ctxHandoffSrc = srcP && isReady(srcP) ? srcP : driverP && isReady(driverP) ? driverP : null
  const startHandoffToNew = () => {
    if (!thread || !driverP || !ctxHandoffSrc) return
    stick.current = true
    void send(thread.id, {
      text: t('wb.handoffNewText', { name: driverP.name }),
      attachments: [],
      driver: { ...ref(ctxHandoffSrc, null), model: speaker?.profileId === ctxHandoffSrc.id ? speaker.model : driverModel },
      mentions: [],
      participants,
      projectDir: ctx.projectDir,
      handoffTo: ref(driverP, driverModel),
      newThreadOnHandoff: true
    })
  }
  const startWithHistory = () => {
    if (!thread || !driverP) return
    stick.current = true
    continueInNewThread(thread.id, { profileId: driverP.id, model: driverModel }, participants)
  }
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    if (stick.current) {
      el.scrollTop = el.scrollHeight
      setAtBottom(true)
    } else {
      setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
    }
  }, [messages, composerH])
  useEffect(() => {
    stick.current = true
    scrollingToBottom.current = false
    setAtBottom(true)
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [thread?.id])

  const [composerSeed, setComposerSeed] = useState<{ seq: number; text: string; atts: Attachment[]; quote: MessageQuote | null } | null>(null)
  const [fileRefSeed, setFileRefSeed] = useState<FileRefSeed | null>(null)
  const [quoteSeed, setQuoteSeed] = useState<{ seq: number; quote: MessageQuote } | null>(null)
  const [rewindModal, setRewindModal] = useState<{
    threadId: string
    message: UserMessage
    turnsCount: number
    plan: RewindPlan | null
    loading: boolean
    error: string | null
  } | null>(null)

  const ref = (p: ProfileState, model: string | null): AgentRef => ({ profileId: p.id, name: p.name, kind: p.kind, model: effectiveModel(model, p) })
  const confirmExternalBusy = () => confirm({ title: t('wb.extBusyTitle'), message: t('wb.extBusyDesc'), confirmLabel: t('wb.extBusySend') })

  const onSend = (text: string, attachments: Attachment[], quote: MessageQuote | null) => {
    if (!driverP) return
    const found = parseMentions(text, profiles, scanFileReferences(text, attachments))
    const seen = new Set<string>()
    const mentions = found.filter((m) => !seen.has(m.p.id) && seen.add(m.p.id)).map((m) => ref(m.p, m.model))
    const joined = [...new Set([...participants, driverP.id, ...mentions.map((m) => m.profileId)])]
    let id = thread?.id
    if (!id) id = newThread({ ...ctx, participants: joined, driver: { profileId: driverP.id, model: driverModel } })
    else if (joined.length !== participants.length) updateThread(id, { participants: joined })
    stick.current = true
    return send(id, { text, attachments, quote, driver: ref(driverP, driverModel), mentions, participants: joined, projectDir: ctx.projectDir }, confirmExternalBusy)
  }

  const onQuote = useCallback((msg: UserMessage | AssistantMessage) => {
    const q = makeQuote(msg)
    if (!q) return
    setQuoteSeed((prev) => ({ seq: (prev?.seq ?? 0) + 1, quote: q }))
  }, [])

  // turns continued elsewhere (terminal, another app) merged into the open chat: a short notice
  const [synced, setSynced] = useState<{ n: number; seq: number } | null>(null)
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
  const [history, setHistory] = useState<{ dir: string; open: boolean } | null>(null)
  const setChangesVisible = (visible: boolean) => {
    localStorage.setItem('agentswitch.changesOpen', visible ? '1' : '0')
    setChangesOpen(visible)
  }
  const toggleChanges = () => setChangesVisible(!changesOpen)
  const openHistory = () => setHistory(ctx.projectDir ? { dir: ctx.projectDir, open: true } : null)
  const closeHistory = () => setHistory((current) => current && { ...current, open: false })
  const agentRunning = isThreadBusy(thread)
  const fc = useFileChanges(thread, ctx.projectDir, agentRunning, showGitTools && changesOpen)
  const git = useProjectGit(showGitTools ? ctx.projectDir : null, thread?.id ?? null, agentRunning, fc.refresh)
  const gitTools = showGitTools && git.status ? { status: git.status, disabled: git.disabled, run: git.run } : null
  const conflictLabel = gitTools ? gitConflictLabel(gitTools.status.inProgress, gitTools.status.conflicts) : null
  const nChanged = (fc.changes?.files.length ?? 0) + (fc.changes?.more ?? 0)

  const openRewind = useCallback(
    async (msg: UserMessage) => {
      if (!thread) return
      if (isThreadBusy(thread) || thread.pause || (thread.queuedMessages?.length ?? 0) > 0) {
        toast({ kind: 'warn', title: t('rewind.busy') })
        return
      }
      const idx = thread.messages.findIndex((m) => m.id === msg.id)
      if (idx < 0) return
      const affected = thread.messages.slice(idx)
      const turnIds = [...new Set(affected.map((m) => m.turnId).filter(Boolean))]
      const turnsCount = Math.max(1, affected.filter((m) => m.role === 'user' && m.kind !== 'handoff').length)
      setRewindModal({ threadId: thread.id, message: msg, turnsCount, plan: null, loading: true, error: null })
      try {
        const res = await window.agentswitch.chat.rewindPlan(thread.id, turnIds)
        if (res.kind === 'ready') {
          setRewindModal((cur) => (cur && cur.message.id === msg.id ? { ...cur, plan: res, loading: false } : cur))
        } else {
          const reason = res.kind === 'busy' ? t('rewind.busy') : res.reason || t('rewind.unavailable')
          setRewindModal((cur) => (cur && cur.message.id === msg.id ? { ...cur, loading: false, error: reason } : cur))
        }
      } catch (e) {
        setRewindModal((cur) => (cur && cur.message.id === msg.id ? { ...cur, loading: false, error: e instanceof Error ? e.message : String(e) } : cur))
      }
    },
    [thread, toast]
  )

  const executeRewind = useCallback(
    async (restoreFiles: boolean) => {
      if (!rewindModal) return
      const { threadId: tid, message } = rewindModal
      setRewindModal((cur) => (cur ? { ...cur, loading: true, error: null } : null))
      const res = await rewindThread(tid, message.id, restoreFiles)
      if (res.kind !== 'ok') {
        const errMsg =
          res.kind === 'busy'
            ? t('rewind.busy')
            : res.kind === 'unavailable'
              ? t('rewind.unavailable')
              : res.kind === 'partial'
                ? t('rewind.partial', { restored: res.restored, failed: res.failed })
                : res.reason || t('rewind.failed')
        setRewindModal((cur) => (cur ? { ...cur, loading: false, error: errMsg } : null))
        return
      }
      setRewindModal(null)
      checkpoints.refresh()
      if (showGitTools) git.refreshAll()
      else fc.refresh()
      setComposerSeed((prev) => ({
        seq: (prev?.seq ?? 0) + 1,
        text: message.text,
        atts: message.attachments ?? [],
        quote: message.quote ?? null
      }))
      toast({
        kind: 'success',
        title: restoreFiles && res.restored > 0 ? t('rewind.doneWithFiles', { n: res.restored }) : t('rewind.done')
      })
    },
    [rewindModal, checkpoints, showGitTools, git, fc, toast]
  )

  const chatPanel = (
      <div className="@container relative flex min-h-0 min-w-0 flex-1 flex-col overflow-clip">
        <div className="drag relative z-30 flex h-[52px] shrink-0 items-center gap-1 border-b border-editor-hairline bg-sidebar px-3 @min-[520px]:gap-2.5"
          style={trafficLightOwner === 'chat' ? { paddingLeft: TRAFFIC_LIGHT_SAFE_LEFT_PX } : undefined}>
          {!sidebarOpen && !editorOnLeft && (
            <button
              onClick={toggleSidebar}
              className="no-drag flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-2 transition-colors hover:bg-black/[0.06] hover:text-ink dark:hover:bg-white/[0.08]"
              title={`${t('nav.showSidebar')} (⌘\\)`}
              aria-label={t('nav.showSidebar')}
            >
              <IconSidebar size={16} strokeWidth={1.7} />
            </button>
          )}
          <div className="min-w-0 truncate text-[14px] font-semibold text-ink" title={thread?.title}>
            {thread && !thread.preview ? thread.title : t('nav.newChat')}
          </div>
          <div className="flex-1" />
          {synced && (
            <div key={synced.seq} className="pointer-events-none absolute inset-x-0 top-3.5 z-20 flex justify-center px-3"
              style={trafficLightOwner === 'chat' ? { paddingLeft: TRAFFIC_LIGHT_SAFE_LEFT_PX } : undefined}>
              <div className="flex min-w-0 items-center gap-1.5 rounded-lg border border-editor-hairline bg-elevated px-3 py-1 text-[12px] text-ink-2 shadow-[0_4px_16px_rgba(0,0,0,0.10)]">
                <IconRefresh size={12} className="shrink-0 text-accent" />
                <span className="truncate">{t('wb.extSynced', { n: synced.n })}</span>
              </div>
            </div>
          )}
          <div className="no-drag flex items-center gap-0.5 @min-[520px]:min-w-0 @min-[520px]:gap-1.5">
            {showGitTools && git.status && <GitSyncBar key={ctx.projectDir} status={git.status} disabled={git.disabled}
              pending={git.pending} run={git.run} compact />}
            {!changesOpen && conflictLabel && <button type="button" onClick={() => setChangesVisible(true)}
              className="flex shrink-0 items-center gap-1 rounded-md px-1 py-1 text-[12px] font-medium text-danger hover:bg-danger-soft"
              title={conflictLabel}><IconAlert size={14} /><span className="hidden @min-[520px]:inline">{conflictLabel}</span></button>}
            <ParticipantsButton participants={participants} driverId={driverP?.id ?? null} onChange={(ids) => update({ participants: ids })} />
            {showDebugTerminal && (
              <button
                onClick={() => (drawer.open ? closeDrawer() : openDrawer())}
                className={`${desktopToolbarButton} relative w-7 justify-center`}
                aria-pressed={drawer.open}
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
              aria-pressed={changesOpen}
              className={`${desktopToolbarButton} px-1.5 @min-[520px]:px-2`}
              title={nChanged ? t('chg.btnHint', { n: nChanged }) : t('chg.title')}
            >
              <IconFile size={15} className={changesOpen ? 'text-accent' : 'text-ink-2'} />
              {nChanged > 0 ? (
                <>
                  <span className="hidden text-[13px] tabular-nums @min-[520px]:inline">{nChanged}</span>
                  <span className="hidden @min-[520px]:inline"><Counts added={fc.changes!.added} removed={fc.changes!.removed} className="text-[11.5px]" /></span>
                </>
              ) : (
                <span className="hidden text-[13px] text-ink-2 @min-[520px]:inline">{t('chg.short')}</span>
              )}
            </button>
            <button type="button" onClick={codeEditor.togglePanel}
              className={`${desktopToolbarButton} px-1.5 @min-[520px]:px-2`}
              title={t('editor.togglePanel')} aria-label={t('editor.togglePanel')} aria-pressed={codeEditor.open}>
              <IconFolderTree size={15} className={codeEditor.open ? 'text-accent' : undefined} />
              <span className="hidden text-[13px] @min-[520px]:inline">{t('editor.panelShort')}</span>
            </button>
          </div>
        </div>

        <div
          ref={scroller}
          data-scroller
          className="min-h-0 flex-1 overflow-y-auto"
          onWheel={() => {
            scrollingToBottom.current = false
          }}
          onScroll={(e) => {
            const el = e.currentTarget
            const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80
            if (scrollingToBottom.current) {
              if (near) scrollingToBottom.current = false
              return
            }
            stick.current = near
            setAtBottom(near)
          }}
        >
          <div className="mx-auto flex min-h-full max-w-[820px] flex-col px-8 pt-2" style={{ paddingBottom: composerH + 28 }}>
            {projectMissing && (
              <div className="project-missing-banner" role="status">
                <IconFolder size={16} className="shrink-0" />
                <span className="min-w-0 flex-1" title={projectDir ?? sourceProjectDir ?? undefined}>
                  <span className="block">{t(projectDir ? 'proj.missing' : 'proj.unlinked')}</span>
                  <span className="block truncate text-[11.5px] text-ink-2">{projectDir ?? sourceProjectDir}</span>
                </span>
                {onRebindProject && <button type="button" className="file-preview-rebind shrink-0" onClick={onRebindProject}>{t('proj.rebind')}</button>}
              </div>
            )}
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
            {thread?.archived && (
              <div className="mb-4 flex items-center gap-2.5 rounded-xl bg-black/[0.04] px-3.5 py-2.5 text-[12.5px] text-ink-2 dark:bg-white/[0.05]">
                <IconArchive size={14} className="shrink-0 text-ink-3" />
                <span className="min-w-0 flex-1">{t('nav.archivedBanner')}</span>
                <button
                  onClick={() => unarchiveThread(thread.id)}
                  className="shrink-0 rounded-full bg-surface px-3 py-1 text-[12px] font-medium text-ink shadow-[0_0_0_1px_var(--ring)] hover:bg-surface-2"
                >
                  {t('nav.unarchive')}
                </button>
              </div>
            )}
            {messages.length === 0 ? (
              <EmptyState projectDir={ctx.projectDir} onPickProject={() => void pickProject()} participants={participants} />
            ) : (
              <div className="space-y-6">
                <MarkdownBase.Provider value={markdownBase}>
                  {(() => {
                    const editableIds = new Set(thread?.messages.map((x) => x.id) ?? [])
                    const rewindBlocked = !thread || isThreadBusy(thread) || !!thread.pause || (thread.queuedMessages?.length ?? 0) > 0
                    return messages.map((m) => {
                      if (m.role === 'system') return <SystemDivider key={m.id} msg={m} />
                      if (m.role === 'user') {
                        const canRewind = !!thread && editableIds.has(m.id) && m.kind !== 'handoff'
                        return (
                          <UserBubble
                            key={m.id}
                            msg={m}
                            fileExists={fileExists}
                            onQuote={m.kind !== 'handoff' && m.text.trim() ? () => onQuote(m) : undefined}
                            onRewind={canRewind ? () => void openRewind(m) : undefined}
                            rewindDisabled={rewindBlocked}
                          />
                        )
                      }
                      const checkpoint = checkpointReplies.get(m.id)
                      return (
                        <AssistantBlock key={m.id} msg={m} fileExists={fileExists} latest={m.id === lastReplyId} onQuote={m.content.trim() ? () => onQuote(m) : undefined}>
                          {checkpoint && thread && (
                            <CheckpointUndo threadId={thread.id} turnId={m.turnId} status={checkpoint} busy={isThreadBusy(thread)}
                              onChange={() => {
                                checkpoints.refresh()
                                if (showGitTools) git.refreshAll()
                                else fc.refresh()
                              }} />
                          )}
                        </AssistantBlock>
                      )
                    })
                  })()}
                </MarkdownBase.Provider>
              </div>
            )}
          </div>
        </div>

        <div
          className={`pointer-events-none absolute inset-x-0 z-10 flex justify-center transition-all duration-200 ease-out ${
            !atBottom && messages.length > 0 ? 'translate-y-0 scale-100 opacity-100' : 'translate-y-2 scale-90 opacity-0'
          }`}
          style={{ bottom: composerH + (thread?.pause || (!!driverP && (handoffNeeded || handoffReady || contextLong || contextCostly)) ? 54 : 8) }}
        >
          <button
            type="button"
            onClick={scrollToBottom}
            tabIndex={!atBottom && messages.length > 0 ? 0 : -1}
            aria-label={t('wb.scrollToBottom')}
            title={t('wb.scrollToBottom')}
            className={`flex h-8 w-8 items-center justify-center rounded-lg border border-editor-hairline bg-elevated text-ink-2 shadow-[0_4px_14px_rgba(0,0,0,0.12)] transition-all duration-150 hover:bg-fill hover:text-ink active:scale-95 ${
              !atBottom && messages.length > 0 ? 'pointer-events-auto' : 'pointer-events-none'
            }`}
          >
            <IconArrowUp size={15} className="rotate-180" />
          </button>
        </div>

        <Composer
          driver={driverP ?? null}
          driverModel={driverModel}
          onDriver={setDriver}
          participants={participants}
          busy={isThreadBusy(thread)}
          threadId={thread?.id ?? null}
          projectDir={ctx.projectDir}
          previewRevision={previewRevision}
          onRebindProject={onRebindProject}
          onOpenEditorFile={codeEditor.openFile}
          onHeight={setComposerH}
          onSend={onSend}
          onStop={() => thread && stop(thread.id)}
          canCompact={canCompact}
          compacting={compacting}
          contextTokens={contextStats.hasActiveSession ? contextStats.lastTokens : 0}
          contextWindow={contextStats.window}
          onCompact={startCompact}
          notice={<TaskSummaryBar thread={thread} />}
          queue={thread?.queuedMessages?.length ? <QueuedMessages key={thread.id} thread={thread} confirmBusy={confirmExternalBusy} /> : null}
          suggestion={thread && !isThreadBusy(thread) ? thread.suggestedInput : null}
          history={inputHistory}
          seed={composerSeed}
          fileRefSeed={fileRefSeed}
          quoteSeed={quoteSeed}
          footer={
            <ProjectBar
              dir={ctx.projectDir}
              locked={projectLocked}
              projectMissing={projectMissing}
              onRebind={onRebindProject}
              onChange={(dir) => !projectLocked && update({ projectDir: dir })}
              onPick={() => void pickProject()}
              onNewHere={startThread}
              gitBranch={showGitTools && git.status && (
                <GitBranchMenu key={ctx.projectDir} dir={ctx.projectDir!} status={git.status} disabled={git.disabled} pending={git.pending}
                  run={git.run} onViewChanges={() => setChangesVisible(true)} onViewHistory={openHistory} />
              )}
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
              <div className="pointer-events-auto mx-auto flex max-w-[820px] items-center gap-2.5 rounded-xl border border-editor-hairline bg-elevated px-4 py-2.5 text-[13px] text-ink shadow-[0_8px_24px_rgba(0,0,0,0.08)]">
                <button
                  onClick={() => skipHandoff(thread!.id, driverP.id)}
                  className="-ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-black/[0.06] hover:text-ink dark:hover:bg-white/[0.08]"
                  title={t('common.close')}
                  aria-label={t('common.close')}
                >
                  <IconX size={14} />
                </button>
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
                  <button disabled={exporting} className="h-7 shrink-0 rounded-full bg-accent px-3 font-medium text-white hover:bg-accent/90 disabled:opacity-60" onClick={() => void doExport(false)}>
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
        {contextLong && thread && driverP && (
          <div className="pointer-events-none absolute inset-x-0 z-20 px-8" style={{ bottom: composerH - 8 }}>
            <div className="pointer-events-auto mx-auto flex max-w-[820px] flex-wrap items-center gap-2.5 rounded-xl border border-editor-hairline bg-elevated px-4 py-2.5 text-[13px] text-ink shadow-[0_8px_24px_rgba(0,0,0,0.08)]">
              <button
                onClick={dismissWarn}
                className="-ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-black/[0.06] hover:text-ink dark:hover:bg-white/[0.08]"
                title={t('common.close')}
                aria-label={t('common.close')}
              >
                <IconX size={14} />
              </button>
              <span className="min-w-40 flex-1">
                {t('wb.ctxLongTokens', {
                  name: driverP.name,
                  tokens: fmtTokens(contextStats.lastTokens),
                  window: fmtTokens(contextStats.window),
                  pct: Math.round((contextStats.lastTokens / contextStats.window) * 100)
                })}
                {handoffFailed && (
                  <span className="block text-[12px] text-warn">
                    {t('wb.handoffFailed', { name: ctxHandoffSrc?.name ?? t('wb.origAccount'), suffix: thread.handoffFailed!.error === 'rate_limited' ? t('wb.rateLimitedSuffix') : '' })}
                  </span>
                )}
              </span>
              {ctxHandoffSrc && !handoffFailed ? (
                <button className="h-7 shrink-0 rounded-full bg-accent px-3 font-medium text-white hover:bg-accent/90" onClick={startHandoffToNew}>
                  {t('wb.ctxHandoffNew', { name: ctxHandoffSrc.name })}
                </button>
              ) : (
                <button disabled={exporting} className="h-7 shrink-0 rounded-full bg-accent px-3 font-medium text-white hover:bg-accent/90 disabled:opacity-60" onClick={() => void doExport(true)}>
                  {exporting ? t('wb.exporting') : t('wb.ctxExportNew')}
                </button>
              )}
              <button className="h-7 shrink-0 rounded-full border border-accent/30 px-3 font-medium text-accent hover:bg-accent/10" onClick={startCompact} title={t('wb.ctxCompactHint')}>
                {t('wb.ctxCompact')}
              </button>
              <button className="h-7 shrink-0 rounded-full border border-accent/30 px-3 font-medium text-accent hover:bg-accent/10" onClick={startWithHistory}>
                {t('wb.ctxCarryHistory')}
              </button>
              <button className="h-7 shrink-0 rounded-full px-3 font-medium text-ink-2 hover:bg-black/[0.05] dark:hover:bg-white/[0.08]" onClick={() => startThread(ctx.projectDir)}>
                {t('wb.ctxNewDirect')}
              </button>
              <button className="h-7 shrink-0 rounded-full px-3 font-medium text-ink-2 hover:bg-black/[0.05] dark:hover:bg-white/[0.08]" onClick={dismissWarn}>
                {t('wb.ctxContinue')}
              </button>
            </div>
          </div>
        )}
        {contextCostly && thread && driverP && (
          <div className="pointer-events-none absolute inset-x-0 z-20 px-8" style={{ bottom: composerH - 8 }}>
            <div className="pointer-events-auto mx-auto flex max-w-[820px] flex-wrap items-center gap-2.5 rounded-2xl bg-surface px-4 py-2 text-[13px] text-ink shadow-[0_0_0_1px_var(--ring),0_8px_24px_rgba(0,0,0,0.08)]">
              <button
                onClick={dismissCost}
                className="-ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-black/[0.06] hover:text-ink dark:hover:bg-white/[0.08]"
                title={t('common.close')}
                aria-label={t('common.close')}
              >
                <IconX size={14} />
              </button>
              <span className="min-w-40 flex-1 text-ink-2">{t('wb.ctxCostly', { name: driverP.name, tokens: fmtTokens(contextStats.lastTokens) })}</span>
              <button className="h-7 shrink-0 rounded-full bg-accent px-3 font-medium text-white hover:bg-accent/90" onClick={startCompact} title={t('wb.ctxCompactHint')}>
                {t('wb.ctxCompact')}
              </button>
              <button className="h-7 shrink-0 rounded-full px-3 font-medium text-ink-2 hover:bg-black/[0.05] dark:hover:bg-white/[0.08]" onClick={dismissCost}>
                {t('wb.ctxContinue')}
              </button>
            </div>
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
  )

  return (
    <div ref={layoutRef} className={`relative flex h-full min-h-0 min-w-0 ${editorOnBottom ? 'flex-col' : ''}`}>
      <div className={`relative min-h-0 min-w-0 flex-1 ${editorMaximized ? 'hidden' : 'flex'} ${editorOnLeft ? 'order-1' : ''}`}>
        {chatPanel}
        {changesOpen && !editorMaximized && (
          <ChangesPanel key={ctx.projectDir} changes={fc.changes} loading={fc.loading} readFailed={fc.readFailed} dir={ctx.projectDir}
            overlay={changesOverlay}
            onRefresh={showGitTools ? git.refreshAll : fc.refresh} onClose={toggleChanges} onViewHistory={openHistory}
            onEditFile={(p) => codeEditor.openFile(p)} gitRevision={git.revision} gitTools={gitTools
              ? { ...gitTools, disabled: gitTools.disabled || fc.loading }
              : null} />
        )}
      </div>
      {codeEditor.open && (
        <CodeEditorPanel
          tabs={codeEditor.tabs}
          activeTab={codeEditor.activeTab}
          projectDir={ctx.projectDir}
          home={info?.realHome ?? null}
          dockPosition={dockPosition}
          fileTreePosition={fileTreePosition}
          fileTreeVisible={fileTreeVisible}
          panelWidth={panelWidth}
          panelHeight={panelHeight}
          fileTreeWidth={treeWidth}
          needsTrafficLightSafeArea={trafficLightOwner === 'editor'}
          showSidebarToggle={editorMaximized || (!sidebarOpen && editorOnLeft)}
          onShowSidebar={toggleSidebar}
          onChangeDockPosition={changeDock}
          onChangeFileTreePosition={changeTreePosition}
          onToggleFileTree={() => setEditorLayout((prefs) => ({ ...prefs, fileTreeVisible: !prefs.fileTreeVisible }))}
          onResizePanelWidth={(width) => setEditorLayout((prefs) => ({
            ...prefs, panelWidth: clampPanelWidth(clampPanelWidth(width, layoutSize?.width))
          }))}
          onResizePanelHeight={(height) => setEditorLayout((prefs) => ({
            ...prefs, panelHeight: clampPanelHeight(clampPanelHeight(height, layoutSize?.height))
          }))}
          onResizeTreeWidth={(width) => setEditorLayout((prefs) => ({
            ...prefs, fileTreeWidth: clampFileTreeWidth(clampFileTreeWidth(width, treeContainerWidth))
          }))}
          onResetPanelSize={() => setEditorLayout((prefs) => dockPosition === 'bottom'
            ? { ...prefs, panelHeight: EDITOR_PANEL_DEFAULT_H }
            : { ...prefs, panelWidth: EDITOR_PANEL_DEFAULT_W })}
          onResetTreeWidth={() => setEditorLayout((prefs) => ({ ...prefs, fileTreeWidth: EDITOR_TREE_DEFAULT_W }))}
          focusToken={codeEditor.focusToken}
          pendingClose={codeEditor.pendingClose}
          changedFiles={fc.changes?.files ?? []}
          onRefreshChangedFiles={fc.refresh}
          onToggleMaximize={() => setEditorMaximized(!editorMaximized)}
          onSelectTab={codeEditor.selectTab}
          onSelectAdjacentTab={codeEditor.selectAdjacentTab}
          onOpenFile={codeEditor.openFile}
          onSetTabViewMode={codeEditor.setTabViewMode}
          onCloseTab={codeEditor.requestCloseTab}
          onClosePanel={codeEditor.requestClosePanel}
          onChangeContent={codeEditor.updateContent}
          onSaveTab={(id, opts) => void codeEditor.saveTab(id, opts)}
          onReloadTab={codeEditor.reloadTab}
          onDismissExternalChange={codeEditor.dismissExternalChange}
          onOpenConflictDiff={(id) => void codeEditor.openConflictDiff(id)}
          onToggleUnsavedDiff={codeEditor.toggleUnsavedDiff}
          onExitDiff={codeEditor.exitDiff}
          onResolvePendingClose={(action) => void codeEditor.resolvePendingClose(action)}
          onReferenceToChat={({ path, realPath, lineRange }) => {
            if (editorMaximized) setEditorMaximized(false)
            setFileRefSeed((prior) => ({ seq: (prior?.seq ?? 0) + 1, path, realPath, lineRange }))
          }}
        />
      )}
      {quickOpen && (
        <QuickOpenModal
          projectDir={ctx.projectDir}
          onSelect={(absPath) => codeEditor.openFile(absPath)}
          onClose={() => setQuickOpen(false)}
        />
      )}
      {git.pullConflict && (
        <Modal onClose={git.dismissPullConflict} width={460}>
          <div role="alertdialog" aria-label={t('git.errPullConflict')} className="space-y-3 p-6">
            <h2 className="text-[16px] font-semibold text-ink">{t('git.errPullConflict')}</h2>
            <p className="text-[13px] text-ink-2">{t('git.pullConflictDetail')}</p>
            <ul className="max-h-[38vh] space-y-1 overflow-y-auto rounded-lg bg-surface-2 p-3 font-mono text-[12px] text-ink">
              {git.pullConflict.files.map((path) => <li key={path} className="break-all whitespace-pre-wrap">{path}</li>)}
            </ul>
            <div className="flex justify-end"><button type="button" autoFocus className={btnPrimary}
              onClick={git.dismissPullConflict}>{t('common.close')}</button></div>
          </div>
        </Modal>
      )}
      {history && history.dir === ctx.projectDir && (
        <GitGraphView key={history.dir} dir={history.dir} open={history.open} onClose={closeHistory}
          onExited={() => setHistory((current) => current?.open ? current : null)} gitRevision={git.revision}
          remote={showGitTools ? { status: git.status, disabled: git.disabled, pending: git.pending, run: git.run, refresh: git.refresh } : null}
          onViewChanges={() => {
            closeHistory()
            setChangesVisible(true)
            if (showGitTools) git.refreshAll()
            else fc.refresh()
          }} />
      )}
      {rewindModal && (
        <RewindDialog
          turnsCount={rewindModal.turnsCount}
          plan={rewindModal.plan}
          loading={rewindModal.loading}
          error={rewindModal.error}
          onClose={() => !rewindModal.loading && setRewindModal(null)}
          onConfirm={(restoreFiles) => void executeRewind(restoreFiles)}
        />
      )}
    </div>
  )
}

function RewindDialog({
  turnsCount,
  plan,
  loading,
  error,
  onClose,
  onConfirm
}: {
  turnsCount: number
  plan: RewindPlan | null
  loading: boolean
  error: string | null
  onClose: () => void
  onConfirm: (restoreFiles: boolean) => void
}) {
  const hasRestorable = (plan?.checkpointTurnIds.length ?? 0) > 0
  const hasUnavailable = (plan?.unavailableTurnIds.length ?? 0) > 0
  const [restoreFiles, setRestoreFiles] = useState(true)
  useEffect(() => {
    if (!plan) return
    setRestoreFiles(plan.checkpointTurnIds.length > 0 && plan.unavailableTurnIds.length === 0)
  }, [plan])
  const blockedRestore = restoreFiles && hasUnavailable

  return (
    <Modal onClose={onClose} width={460} escClose={!loading} closeOnCmdW={!loading}>
      <div className="p-6" role="dialog" aria-modal="true">
        <h2 className="text-[17px] font-semibold text-ink">{t('rewind.title')}</h2>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">{t('rewind.desc', { n: turnsCount })}</p>

        {loading && !plan && !error && (
          <div className="mt-4 flex items-center gap-2 text-[13px] text-ink-3">
            <Spinner size={14} /> {t('rewind.checking')}
          </div>
        )}

        {plan && (hasRestorable || hasUnavailable) && (
          <div className="mt-4 rounded-xl border border-hairline bg-fill/60 p-3.5">
            {hasRestorable && (
              <label className="flex cursor-pointer items-start gap-2.5 text-[13px] text-ink">
                <input
                  type="checkbox"
                  checked={restoreFiles}
                  disabled={loading}
                  onChange={(e) => setRestoreFiles(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
                />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{t('rewind.restoreFiles')}</span>
                  <span className="mt-0.5 block text-[12px] text-ink-3">{t('rewind.fileCount', { n: plan.files.length })}</span>
                </span>
              </label>
            )}
            {hasUnavailable && (
              <div className={`${hasRestorable ? 'mt-2.5' : ''} rounded-lg bg-warn-soft px-2.5 py-2 text-[12px] leading-relaxed text-warn`}>
                {t('rewind.someUnavailable')}
              </div>
            )}
          </div>
        )}

        {error && <div className="mt-3 rounded-xl bg-danger-soft px-3 py-2 text-[12.5px] text-danger">{error}</div>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={btnSecondary} disabled={loading} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={btnPrimary}
            disabled={loading || (!plan && !error) || blockedRestore}
            onClick={() => onConfirm(hasRestorable && restoreFiles)}
          >
            {loading ? <Spinner size={13} /> : t('rewind.confirm')}
          </button>
        </div>
      </div>
    </Modal>
  )
}

// ---- header: participants ---------------------------------------------------------------

function ParticipantsButton({ participants, driverId, onChange }: { participants: ProfileId[]; driverId: ProfileId | null; onChange: (ids: ProfileId[]) => void }) {
  const { navigate } = useApp()
  const accounts = useSortedAccounts()
  const [open, setOpen] = useState(false)
  useEscape(() => setOpen(false), open)
  const ref = useOutside<HTMLDivElement>(open, () => setOpen(false))
  const active = accounts.filter((p) => participants.includes(p.id))

  return (
    <div ref={ref} className="no-drag shrink-0 @min-[520px]:relative">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className={`${desktopToolbarButton} px-1 @min-[420px]:px-1.5`} title={`${t('wb.participantsHint')}\n${active.map((p) => p.name).join(' · ')}`}>
        {active[0] ? (
          <span className="relative">
            <ProfileAvatar profile={active.find((p) => p.id === driverId) ?? active[0]} size={18} />
          </span>
        ) : (
          <span className="size-[18px] rounded-md border border-dashed border-black/20 dark:border-white/25" />
        )}
        <span className="hidden text-[13px] text-ink-2 tabular-nums @min-[420px]:inline">{active.length}</span>
        <IconChevronDown size={13} className="hidden text-ink-3 @min-[420px]:block" />
      </button>
      {open && (
        <div className={popover + ' absolute top-full right-1 z-30 mt-1 w-72 @min-[520px]:right-0'}>
          <div className="px-2.5 pt-1 pb-1.5 text-[12px] text-ink-3">{t('wb.participantsTitle')}</div>
          {accounts.map((p) => {
            const signedIn = isSignedIn(p)
            const on = participants.includes(p.id)
            const isDriver = p.id === driverId
            return (
              <button
                key={p.id}
                disabled={!signedIn || isDriver}
                onClick={() => onChange(on ? participants.filter((x) => x !== p.id) : [...participants, p.id])}
                className="flex h-10 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-left transition-colors enabled:hover:bg-black/[0.04] disabled:cursor-default"
                title={isDriver ? t('wb.driverAlways') : undefined}
              >
                <span className={`flex h-[18px] w-[18px] items-center justify-center rounded-[5px] ${on && signedIn ? 'bg-accent text-white' : 'bg-surface shadow-[inset_0_0_0_1.5px_var(--ring)]'} ${!signedIn ? 'opacity-40' : ''}`}>
                  {on && signedIn && <IconCheck size={12} strokeWidth={3} />}
                </span>
                <ProfileAvatar profile={p} size={22} />
                <span className={`min-w-0 flex-1 truncate text-[14px] ${signedIn ? 'text-ink' : 'text-ink-3'}`}>{p.name}</span>
                {isDriver ? (
                  <span className="text-[11px] text-ink-3">{t('wb.driver')}</span>
                ) : (
                  !isReady(p) && <span className={`text-[11px] ${p.status === 'rate_limited' ? 'text-danger' : 'text-ink-3'}`}>{accountBadge(p).label}</span>
                )}
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
  const ready = useSortedAccounts().filter((p) => isSignedIn(p) && participants.includes(p.id))
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
              <ProfileAvatar profile={p} size={20} />
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

/** Replaces recognized references for display while retaining the editable message text. */
function renderUserText({ text, mentions, attachments }: UserMessage, onOpen: (a: Attachment) => void): ReactNode[] {
  const refs = scanFileReferences(text, attachments)
  const chips = refs.map(({ start, end, index, lineRange }): { start: number; end: number; node: ReactNode } => {
    const a = attachments[index]
    return { start, end, node: (
      <button key={start} type="button" spellCheck={false} title={attachmentTitle(a)} onClick={() => onOpen(a)}
        className="mx-0.5 inline-flex max-w-full items-center gap-1 rounded bg-white/25 px-1.5 py-0.5 align-baseline leading-tight text-white hover:bg-white/35">
        <IconFile size={12} className="shrink-0" aria-hidden="true" /> <span className="truncate">{(a.refLabel || a.name) + formatLineRangeSuffix(lineRange)}</span>
      </button>
    ) }
  })
  if (mentions.length) {
    const names = [...mentions].sort((a, b) => b.name.length - a.name.length).map((m) => escapeRe(m.name))
    const re = new RegExp('@(' + names.join('|') + ')(?:\\(([^)\\s]+)\\))?', 'g')
    for (const m of maskCode(text).matchAll(re)) {
      const start = m.index
      const end = start + m[0].length
      if (refs.some((ref) => ref.start < end && ref.end > start)) continue
      const ref = mentions.find((x) => x.name === m[1])!
      chips.push({ start, end, node: <MentionChip key={start} a={{ ...ref, model: m[2] ?? ref.model }} /> })
    }
  }
  const out: ReactNode[] = []
  let last = 0
  for (const { start, end, node } of chips.sort((a, b) => a.start - b.start)) {
    out.push(text.slice(last, start), node)
    last = end
  }
  out.push(text.slice(last))
  return out
}

/** Long user messages start folded (≈6 lines); short ones never show the toggle. */
const FOLD_PX = 140

function UserText({ msg, onOpen }: { msg: UserMessage; onOpen: (a: Attachment) => void }) {
  return (
    <div className="max-w-full rounded-[20px] rounded-br-md bg-accent text-[15px] leading-[1.7] text-white">
      {msg.quote?.excerpt && (
        <div className="mx-2.5 mt-2.5 rounded-xl border-l-2 border-white/60 bg-black/15 px-3 py-1.5 text-[12px] leading-[1.5] text-white/90">
          <div className="font-medium text-white/80">{t('quote.from', { name: msg.quote.author })}</div>
          <div className="mt-0.5 line-clamp-3 whitespace-pre-wrap">{msg.quote.excerpt}</div>
        </div>
      )}
      <CollapsibleBody threshold={FOLD_PX + 40} collapsedHeight={FOLD_PX} tone="bubble" className="overflow-clip rounded-[inherit]">
        <div className="px-4 py-2.5 whitespace-pre-wrap select-text">{renderUserText(msg, onOpen)}</div>
      </CollapsibleBody>
    </div>
  )
}

/** Copy for a sent message: the full original text, even while the bubble is folded. */
function CopyText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => {
        void window.agentswitch.sys.copy(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      }}
      className="-my-0.5 flex h-5 items-center gap-1 rounded-md px-1.5 text-ink-3 transition-colors hover:bg-black/[0.05] hover:text-ink dark:hover:bg-white/[0.07]"
    >
      {copied ? <IconCheck size={12} className="text-ok" /> : <IconCopy size={12} />}
      {copied ? t('common.copied') : t('common.copy')}
    </button>
  )
}

function SystemDivider({ msg }: { msg: SystemMessage }) {
  return (
    <div className="flex items-center gap-3 py-1 select-none" role="status">
      <div className="h-px flex-1 bg-hairline" />
      <span
        className="inline-flex items-center gap-1.5 rounded-full bg-black/[0.035] px-3 py-1 text-[11.5px] text-ink-3 shadow-[inset_0_0_0_1px_var(--ring)]"
        title={fullTime(msg.createdAt)}
      >
        <IconCompact size={12} className="shrink-0 text-accent" />
        <span>{t('wb.ctxCompactDivider')}</span>
      </span>
      <div className="h-px flex-1 bg-hairline" />
    </div>
  )
}

function UserBubble({
  msg,
  fileExists,
  onQuote,
  onRewind,
  rewindDisabled
}: {
  msg: UserMessage
  fileExists: PathExistence
  onQuote?: () => void
  onRewind?: () => void
  rewindDisabled?: boolean
}) {
  const [viewingId, setViewing] = useState<string | null>(null)
  const viewing = msg.attachments.find((a) => a.id === viewingId)
  const { projectDir, onRebindProject, onOpenEditorFile, revision } = useContext(MarkdownBase)
  const rebindFor = (a: Attachment) => (a.source === 'workspace-file' || !!a.relativePath) ? onRebindProject : undefined
  const openAttachment = (a: Attachment) => {
    if (!a.isImage && onOpenEditorFile) {
      const candidates = attachmentPaths(a, projectDir)
      const target = candidates.find((p) => fileExists[p] !== false) ?? candidates[0]
      if (target) {
        onOpenEditorFile(target)
        return
      }
    }
    setViewing(a.id)
  }
  return (
    <div className="flex flex-col items-end gap-1.5 pl-24">
      {viewing && <AttachmentViewer a={viewing} projectDir={projectDir} onRebindProject={rebindFor(viewing)} revision={revision} onClose={() => setViewing(null)} />}
      <AttachmentBar items={msg.attachments} projectDir={projectDir} revision={revision} fileExists={fileExists}
        alignEnd onRebindProject={onRebindProject} onOpen={openAttachment} />
      {msg.text && msg.kind === 'handoff' ? (
        <div className="flex items-center gap-1.5 rounded-full bg-black/[0.05] px-3 py-1 text-[12.5px] text-ink-2">
          <IconArrowRight size={13} className="text-accent" />
          {msg.text}
        </div>
      ) : (
        (msg.text || msg.quote) && <UserText msg={msg} onOpen={openAttachment} />
      )}
      {msg.note && (
        <div className="flex items-center gap-1 text-[11px] text-info">
          <IconCheck size={11} /> {msg.note}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-end gap-1 text-[11px] text-ink-3">
        {!msg.mentions.length && (
          <>
            {tNode('wb.sentTo', {
              who: (
                <>
                  <RefAvatar r={msg.driver} size={13} /> {msg.driver.name}
                </>
              )
            })}
          </>
        )}
        {msg.text && <CopyText text={msg.text} />}
        {onQuote && (
          <button
            onClick={onQuote}
            className="-my-0.5 flex h-5 items-center gap-1 rounded-md px-1.5 text-ink-3 transition-colors hover:bg-black/[0.05] hover:text-ink dark:hover:bg-white/[0.07]"
          >
            <IconQuote size={12} /> {t('quote.action')}
          </button>
        )}
        {onRewind && (
          <button
            onClick={onRewind}
            disabled={rewindDisabled}
            title={rewindDisabled ? t('rewind.busy') : t('rewind.btnHint')}
            className="-my-0.5 flex h-5 items-center gap-1 rounded-md px-1.5 text-ink-3 transition-colors enabled:hover:bg-black/[0.05] enabled:hover:text-ink disabled:cursor-not-allowed disabled:opacity-45 dark:enabled:hover:bg-white/[0.07]"
          >
            <IconEdit size={11.5} /> {t('rewind.btn')}
          </button>
        )}
        <span title={fullTime(msg.createdAt)}>{msgTime(msg.createdAt)}</span>
      </div>
    </div>
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
          {msg.permissions?.some(isPendingPermission) && <span className="rounded-full bg-warn-soft px-2 py-0.5 font-medium text-warn">{t('permission.waiting')}</span>}
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

function AssistantBlock({ msg, fileExists, latest = false, onQuote, children }: {
  msg: AssistantMessage
  fileExists: PathExistence
  latest?: boolean
  onQuote?: () => void
  children?: ReactNode
}) {
  const base = useContext(MarkdownBase)
  const { projectDir, sourceProjectDir } = base
  const outputFiles = useMemo(() => outputRefsForMessage(msg, projectDir ?? null, sourceProjectDir),
    [msg.outputs, msg.outputFiles, projectDir, sourceProjectDir])
  const preview = useMemo(() => ({ ...base, outputFiles }), [base, outputFiles])
  const usageSnap = useUsage()
  const streaming = msg.status === 'streaming'
  useTicker(streaming)
  const rootRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)
  const [detailsSeq, setDetailsSeq] = useState(0)
  const detailsRef = useRef<HTMLDivElement>(null)
  const showDetails = () => {
    setDetailsSeq((n) => n + 1)
    scrollListTo(detailsRef.current)
  }
  const busy = msg.content || msg.activity.length > 0 || msg.thinking || msg.phase
  const awaitingPermission = msg.permissions?.some(isPendingPermission)
  const inlinePermissions = msg.permissions?.filter((p) => p.activityId && msg.activity.some((a) => a.id === p.activityId))
  const standalonePermissions = msg.permissions?.filter((p) => !inlinePermissions?.includes(p))
  const copy = async () => {
    await window.agentswitch.sys.copy(stripMarks(msg.content))
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  if (msg.status === 'queued' || (msg.status === 'stopped' && !msg.startedAt))
    return (
      <div className="flex items-center gap-2.5 opacity-55">
        <RefAvatar r={msg.agent} size={28} />
        <SpeakerLine msg={msg} />
      </div>
    )

  const body = (
    <div ref={rootRef} className="flex gap-3 pr-10">
      <div className="pt-0.5">
        <RefAvatar r={msg.agent} size={28} />
      </div>
      <div className="min-w-0 flex-1">
        <SpeakerLine msg={msg} />
        <div className="mt-2">
          {msg.thinking && <ThinkingCard t={msg.thinking} live={streaming} />}
          <div ref={detailsRef}>
            {(msg.activity.length > 0 || (msg.others?.length ?? 0) > 0) && (
              <ActivityBar items={msg.activity} others={msg.others ?? []} permissions={inlinePermissions} live={streaming && !msg.content} openSeq={detailsSeq} />
            )}
          </div>
          {standalonePermissions?.map((permission) => <PermissionCard key={permission.requestId} permission={permission} />)}
          {msg.content ? (
            <CollapsibleBody threshold={REPLY_FOLD_AT} collapsedHeight={REPLY_FOLD_PX} defaultOpen={latest || streaming} disabled={streaming} anchor={rootRef}>
              <Markdown text={msg.content} />
            </CollapsibleBody>
          ) : streaming ? (
            msg.activity.length === 0 && !standalonePermissions?.length && !(msg.thinking && !msg.thinking.endedAt) && (
              <div className="flex h-6 items-center gap-1">
                {[0, 1, 2].map((i) => (
                  <span key={i} className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-3" style={{ animationDelay: `${i * 160}ms` }} />
                ))}
              </div>
            )
          ) : (
            !msg.error && !outputFiles.length && !msg.notices?.length && <div className="text-[14px] text-ink-3">{t('wb.noText')}</div>
          )}
          {streaming && busy && !awaitingPermission && (
            <LiveProgress
              activity={msg.activity}
              phase={msg.phase}
              thinking={!!msg.thinking && !msg.thinking.endedAt}
              tail={msg.tail}
              startedAt={msg.startedAt}
              onDetails={msg.activity.length > 0 ? showDetails : undefined}
            />
          )}
          <Outputs msg={msg} fileExists={fileExists} />
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
          <div className="mt-1 -ml-2 flex flex-wrap items-center gap-2">
            {msg.content && (
              <button onClick={() => void copy()} className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12px] text-ink-3 transition-colors hover:bg-black/[0.05] hover:text-ink dark:hover:bg-white/[0.07]">
                {copied ? <IconCheck size={14} className="text-ok" /> : <IconCopy size={14} />}
                {copied ? t('common.copied') : t('common.copy')}
              </button>
            )}
            {onQuote && msg.content && (
              <button onClick={onQuote} className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12px] text-ink-3 transition-colors hover:bg-black/[0.05] hover:text-ink dark:hover:bg-white/[0.07]">
                <IconQuote size={14} />
                {t('quote.action')}
              </button>
            )}
            <UsageLine
              usage={msg.usage}
              reasonix={getProviderCapabilities(msg.agent.kind).showsFineGrainedCost}
              costUsd={estimateMessageCost(msg.usage, msg.actualModel || msg.agent.model, usageSnap)}
              ms={msg.startedAt && msg.endedAt ? msg.endedAt - msg.startedAt : null}
            />
          </div>
        )}
        {children}
      </div>
    </div>
  )
  return <MarkdownBase.Provider value={preview}>{body}</MarkdownBase.Provider>
}

const isOutputImage = (file: OutputFileRef): boolean => isPreviewableImagePath(file.path) || isPreviewableImagePath(file.name)

/** Files the step produced that are not already rendered inline. */
function Outputs({ msg, fileExists }: { msg: AssistantMessage; fileExists: PathExistence }) {
  const { baseDir, home, projectDir = baseDir, sourceProjectDir, outputFiles = [], onRebindProject, revision } = useContext(MarkdownBase)
  if (!outputFiles.length) return null
  const inline = new Set(extractMarkdownImageTargets(msg.content).map((src) =>
    findMatchingOutputFile(src, baseDir, home, outputFiles, sourceProjectDir)))
  const images = outputFiles.filter((file) => !file.inlineOnly && isOutputImage(file) && !inline.has(file))
  const files = outputFiles.filter((file) => !file.inlineOnly && !isOutputImage(file))
  if (!images.length && !files.length) return null
  return (
    <div className="mt-3">
      {images.length > 0 && (
        <div className="md">
          {images.map((file) => (
            <OutputImage key={file.path} file={file} projectDir={projectDir} onRebindProject={onRebindProject} revision={revision} />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {files.slice(0, 12).map((file) => {
            const paths = resolveOutputFileCandidates(file, projectDir)
            if (paths.every((path) => fileExists[path] === false)) {
              return <MissingFile key={file.path} name={file.name} relativePath={file.relativePath} path={file.path || file.sourcePath}
                skippedReason={file.skippedReason} onRebindProject={file.source === 'workspace-file' ? onRebindProject : undefined} />
            }
            const existing = paths.find((path) => fileExists[path] === true)
            return (
              <button
                key={file.path}
                type="button"
                disabled={!existing}
                onClick={() => { if (existing) void window.agentswitch.sys.showInFolder(existing) }}
                className="flex h-7 max-w-[260px] items-center gap-1.5 rounded-lg bg-black/[0.04] px-2.5 text-[12px] text-ink-2 enabled:hover:bg-black/[0.07] enabled:hover:text-ink"
                title={existing ? existing + '\n' + t('common.showInFinder') : file.path}
              >
                <IconFile size={13} className="shrink-0" />
                <span className="truncate">{file.name}</span>
              </button>
            )
          })}
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
      <ProfileAvatar profile={p} size={24} />
      <span className={`min-w-0 flex-1 truncate text-[14px] ${isSignedIn(p) ? 'text-ink' : 'text-ink-3'}`}>{p.name}</span>
      {trailing}
      {!isReady(p) && <span className={`text-[11px] ${p.status === 'rate_limited' ? 'text-danger' : 'text-ink-3'}`}>{accountBadge(p).label}</span>}
      {isSignedIn(p) && selected && <IconCheck size={15} className="text-accent" />}
    </div>
  )
}

function DriverPicker({ driver, onPick }: { driver: ProfileState | null; onPick: (id: ProfileId) => void }) {
  const { navigate } = useApp()
  const accounts = useSortedAccounts()
  const [open, setOpen] = useState(false)
  const ref = useOutside<HTMLDivElement>(open, () => setOpen(false))
  useEscape(() => setOpen(false), open)
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex h-8 items-center gap-2 rounded-full pr-2 pl-1 text-[13px] font-medium text-ink transition-colors hover:bg-fill ${open ? 'bg-fill' : ''}`}
        title={t('wb.driverHint')}
      >
        {driver ? <ProfileAvatar profile={driver} size={22} /> : <span className="h-[22px] w-[22px] rounded-[6px] border border-dashed border-black/20" />}
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
  useEscape(() => setOpen(false), open)
  const { list, loading, refresh } = useModels(account.id)
  const eff = effectiveModel(model, account)
  const defaultModel = account.defaultModel || list?.defaultModel
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
        title={model || defaultModel || t('wb.subModelHint')}
      >
        <span className="truncate">{model ? modelLabel(model, account.id) : defaultModel ? t('wb.defaultResolved', { model: modelLabel(defaultModel, account.id) }) : t('common.default')}</span>
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
          <EffortBar reasonix={getProviderCapabilities(account.kind).supportsDisabledEffort} opt={cur.opt} effort={cur.effort} onChange={(e) => cur.model && onPick(withEffort(cur.opt, cur.model, e))} />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <button onClick={() => pick(null)} className={`flex w-full items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-left transition-colors ${!model ? 'bg-accent/10' : 'hover:bg-black/[0.04]'}`}>
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] leading-5 text-ink">{t('common.default')}</span>
                <span className="block truncate text-[10.5px] leading-4 text-ink-3" title={defaultModel}>{account.defaultModel ? t('wb.accountDefault', { model: account.defaultModel }) : defaultHint(account.kind, list?.defaultModel)}</span>
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

function QueuedMessages({ thread, confirmBusy }: { thread: Thread; confirmBusy: () => Promise<boolean> }) {
  const [edit, setEdit] = useState<{ id: string; text: string } | null>(null)
  const action = 'rounded-md px-2 py-1 text-ink-2 hover:bg-fill hover:text-ink disabled:opacity-50'
  return (
    <section aria-label={t('wb.queueHeading')} className="mb-2 rounded-2xl bg-surface px-3 py-2 text-[13px] text-ink ring-1 ring-[var(--ring)]">
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-auto flex items-center gap-2 px-1 font-medium">
          <IconClock size={14} /> {t('wb.queueHeading')}
        </span>
        {(thread.queueHold || !thread.activeTurn) && (
          <button
            className={action + ' font-medium text-accent'}
            disabled={!!thread.activeTurn || !!thread.pause}
            onClick={() => void continueQueuedMessages(thread.id, confirmBusy)}
          >
            {t('wb.queueContinue')}
          </button>
        )}
        <button className={action} onClick={() => {
          setEdit(null)
          clearQueuedMessages(thread.id)
        }}>{t('wb.queueClear')}</button>
      </div>
      {(thread.queueHold === 'external' || thread.pause) && (
        <p role="status" className="px-1 py-1 text-ink-2">{t(thread.pause ? 'wb.queueReview' : 'wb.queueExternal')}</p>
      )}
      <ul className="max-h-40 overflow-y-auto overscroll-contain">
        {thread.queuedMessages?.map((message) => {
          const summary = message.text || message.attachments.map((file) => file.name).join(t('common.listSep'))
          return (
            <li key={message.id} className="border-t border-[var(--ring)]">
              {edit?.id === message.id ? (
                <form className="flex items-start gap-1 py-1" onSubmit={(e) => {
                  e.preventDefault()
                  if (!edit.text.trim() && !message.attachments.length) return
                  editQueuedMessage(thread.id, message.id, edit.text)
                  setEdit(null)
                }}>
                  <textarea
                    autoFocus
                    aria-label={t('wb.queueEdit')}
                    value={edit.text}
                    rows={2}
                    className="min-w-0 flex-1 resize-y rounded-md bg-fill px-2 py-1 text-ink outline-accent"
                    onChange={(e) => setEdit({ ...edit, text: e.target.value })}
                    onKeyDown={(e) => { if (e.key === 'Escape' && !e.nativeEvent.isComposing) setEdit(null) }}
                  />
                  <button className={action} type="submit" disabled={!edit.text.trim() && !message.attachments.length}>{t('common.save')}</button>
                  <button className={action} type="button" onClick={() => setEdit(null)}>{t('common.cancel')}</button>
                </form>
              ) : (
                <div className="flex min-w-0 items-center gap-1 py-0.5">
                  <span className="flex-1 truncate px-1" title={summary}>{summary}</span>
                  <button className={action} onClick={() => setEdit({ id: message.id, text: message.text })}>{t('wb.queueEdit')}</button>
                  <button className={action} onClick={() => removeQueuedMessage(thread.id, message.id)}>{t('common.remove')}</button>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function TaskSummaryBar({ thread }: { thread: Thread | null }) {
  const threadId = thread?.id
  const summary = thread?.taskSummary
  const summaryText = typeof summary?.text === 'string' ? summary.text : ''
  const idleSince = thread?.updatedAt ?? 0
  const paused = !!thread?.pause
  const busy = isThreadBusy(thread) || (!!summaryText && !!thread?.messages.some(
    (m) => m.role === 'assistant' && (m.status === 'queued' || m.status === 'streaming')
  ))
  const previousThread = useRef(threadId)
  const [dismissed, setDismissed] = useState<Map<string, number>>(() => new Map())
  const [revealed, setRevealed] = useState<{ threadId: string; idleSince: number } | null>(null)
  const dismissedThreadId = threadId && summary && dismissed.get(threadId) === summary.updatedAt ? threadId : null

  useEffect(() => {
    const switchedThread = previousThread.current !== threadId
    previousThread.current = threadId
    if (!threadId || !summaryText || busy || paused || dismissedThreadId) return

    const reveal = (trigger: 'idle' | 'focus' | 'switch') => {
      if (shouldShowTaskSummaryBar({
        threadId, summary: summaryText, busy, paused, idleSince, now: Date.now(), dismissedThreadId,
        refocused: trigger === 'focus', switchedThread: trigger === 'switch'
      })) setRevealed({ threadId, idleSince })
    }
    const remaining = idleSince + TASK_SUMMARY_IDLE_MS - Date.now()
    if (switchedThread || remaining <= 0) {
      reveal(switchedThread ? 'switch' : 'idle')
      return
    }

    let blurred = !document.hasFocus()
    const onBlur = () => { blurred = true }
    const onFocus = () => {
      if (blurred) reveal('focus')
      blurred = false
    }
    const timer = window.setTimeout(() => reveal('idle'), remaining)
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
    }
  }, [threadId, summaryText, busy, paused, idleSince, dismissedThreadId])

  if (!threadId || !summary || !summaryText || busy || paused || dismissedThreadId || revealed?.threadId !== threadId || revealed.idleSince !== idleSince) return null
  return (
    <div className="mb-2 flex items-center gap-2.5 rounded-2xl bg-surface px-4 py-2 text-[13px] text-ink shadow-[0_0_0_1px_var(--ring),0_8px_24px_rgba(0,0,0,0.08)]">
      <div className="min-w-0 flex-1" role="status">
        <span className="font-semibold">{t('wb.taskSummaryTitle')}</span>
        <span className="block wrap-break-word text-ink-2">{summaryText}</span>
      </div>
      <button
        type="button"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-black/[0.06] hover:text-ink dark:hover:bg-white/[0.08]"
        onClick={() => setDismissed((current) => new Map(current).set(threadId, summary.updatedAt))}
        title={t('wb.taskSummaryDismiss')}
        aria-label={t('wb.taskSummaryDismiss')}
      >
        <IconX size={14} />
      </button>
    </div>
  )
}

interface FileRefSeed {
  seq: number
  path: string
  realPath: string | null
  lineRange: FileLineRange | null
}

function Composer({
  driver,
  driverModel,
  onDriver,
  participants,
  busy,
  threadId,
  projectDir,
  previewRevision,
  onRebindProject,
  onOpenEditorFile,
  onHeight,
  onSend,
  onStop,
  canCompact,
  compacting,
  contextTokens,
  contextWindow,
  onCompact,
  notice,
  queue,
  suggestion,
  history,
  seed,
  fileRefSeed,
  quoteSeed,
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
  previewRevision: number
  onRebindProject?: () => void
  onOpenEditorFile?: (path: string) => void
  onHeight: (h: number) => void
  /** Resolves false when the user declined to send (the draft comes back). */
  onSend: (text: string, attachments: Attachment[], quote: MessageQuote | null) => Promise<boolean> | void
  onStop: () => void
  canCompact: boolean
  compacting: boolean
  contextTokens: number
  contextWindow: number
  onCompact: () => Promise<void> | void
  notice?: ReactNode
  queue?: ReactNode
  /** Next input the model suggested (ghost text; Tab takes it). */
  suggestion?: string | null
  /** Text-only sent history (oldest -> newest) for ↑/↓ recall. */
  history: string[]
  /** Populates composer after a P1-1 rewind / re-edit. */
  seed?: { seq: number; text: string; atts: Attachment[]; quote: MessageQuote | null } | null
  fileRefSeed?: FileRefSeed | null
  /** Attaches a quoted message snippet to the composer. */
  quoteSeed?: { seq: number; quote: MessageQuote } | null
  /** Context line under the input card (project folder). */
  footer?: ReactNode
}) {
  const { toast, navigate, openSettings } = useApp()
  const { sendKey } = useSettings()
  useModelsVersion()
  const accounts = useSortedAccounts()
  const draftKey = threadId ?? NEW_DRAFT
  const [text, setText] = useState(() => composerDraft(draftKey)?.text ?? '')
  const [atts, setAtts] = useState<Attachment[]>(() => composerDraft(draftKey)?.atts ?? [])
  const [viewingId, setViewing] = useState<string | null>(null)
  const viewing = atts.find((a) => a.id === viewingId)
  const [quote, setQuote] = useState<MessageQuote | null>(() => composerDraft(draftKey)?.quote ?? null)
  const [expanded, changeExpansion] = useReducer(nextComposerExpanded, false)
  const [compactMetrics, setCompactMetrics] = useState({ scrollHeight: 46, padding: 24, lineHeight: 22 })
  const [drag, setDrag] = useState(false)
  /** @ menu: `sub` = index of the account whose sub-model list is open. */
  const [mention, setMention] = useState<{ start: number; query: string; index: number; sub: number | null; subIndex: number } | null>(null)
  /** / menu: AgentSwitch built-in commands + skills/commands of the lead account in this project. */
  const [slash, setSlash] = useState<(
    | ({ mode: 'inline' } & SlashTrigger)
    | { mode: 'picker'; query: string }
  ) & { index: number } | null>(null)
  const [file, setFile] = useState<{ trigger: FileTrigger; index: number } | null>(null)
  const fileMenuId = useId()
  const cliSkillsEnabled = !driver || !!getProviderCapabilities(driver.kind).skillTriggerPrefix
  const skills = useSkills(cliSkillsEnabled ? (driver?.id ?? null) : null, projectDir, !!slash && cliSkillsEnabled)
  const skillItems = skills.data?.items
  const compactDesc = t('wb.compactSlashDesc')
  const builtinSlash = useMemo(() => [makeCompactSlashItem(compactDesc)], [compactDesc])
  const pins = usePins(driver?.kind)
  const slashQuery = slash?.query
  const slashGroups = useMemo(
    () => slashQuery === undefined ? null : groupQuickSkills(skillItems ?? [], builtinSlash, slashQuery, pins),
    [skillItems, builtinSlash, slashQuery, pins]
  )
  const slashActive = Math.min(slash?.index ?? 0, Math.max(0, (slashGroups?.flat.length ?? 0) - 1))
  const fileOpen = !mention && !slash && !!file
  const fileSearch = useFileSearch(projectDir, fileOpen ? file.trigger : null, atts)
  const fileActive = Math.min(file?.index ?? 0, Math.max(0, fileSearch.items.length - 1))
  const ta = useRef<HTMLTextAreaElement>(null)
  const mirror = useRef<HTMLDivElement>(null)
  const editor = useRef<HTMLDivElement>(null)
  const composingRef = useRef(false)
  const dismissed = useRef<{ value: string; caret: number } | null>(null)
  const pendingReferenceFocus = useRef<{ value: string; caret: number } | null>(null)
  const appliedFileRefSeq = useRef(0)
  /** Active ↑/↓ history cursor (`idx` into `history`, plus the unsent draft to restore on ↓). */
  const histRef = useRef<HistoryCursor | null>(null)
  // per-conversation drafts: park the leaving chat's input, bring back the target's
  const live = useRef({ key: draftKey, text, atts, quote })
  const priorProject = useRef({ key: draftKey, dir: projectDir })
  live.current.text = text
  live.current.atts = atts
  live.current.quote = quote
  useLayoutEffect(() => {
    const cur = live.current
    if (cur.key === draftKey) return
    saveComposerDraft(cur.key, cur.text, cur.atts, cur.quote)
    const d = composerDraft(draftKey)
    cur.key = draftKey
    histRef.current = null
    setText(d?.text ?? '')
    setAtts(d?.atts ?? [])
    setQuote(d?.quote ?? null)
    setMention(null)
    setSlash(null)
    setFile(null)
    setViewing(null)
    dismissed.current = null
    pendingReferenceFocus.current = null
    changeExpansion('thread')
  }, [draftKey])
  useLayoutEffect(() => {
    const prior = priorProject.current
    priorProject.current = { key: draftKey, dir: projectDir }
    if (prior.key !== draftKey || prior.dir === projectDir) return
    setAtts((items) => items.map((a) => {
      if (!a.path) return a
      const relativePath = deriveRelativePath(a.path, projectDir) ?? undefined
      if (a.relativePath === relativePath) return a
      return { ...a, relativePath, source: relativePath ? 'workspace-file' : 'chat-attachment', refLabel: attachmentRefLabel(a) }
    }))
  }, [draftKey, projectDir])
  useEffect(() => () => saveComposerDraft(live.current.key, live.current.text, live.current.atts, live.current.quote), [])
  useEffect(() => {
    if (!seed) return
    histRef.current = null
    setText(seed.text)
    setAtts(seed.atts)
    setQuote(seed.quote)
    setMention(null)
    setSlash(null)
    setFile(null)
    setViewing(null)
    requestAnimationFrame(() => {
      const el = ta.current
      if (!el) return
      el.focus()
      el.setSelectionRange(seed.text.length, seed.text.length)
    })
  }, [seed])
  useEffect(() => {
    if (!quoteSeed) return
    setQuote(quoteSeed.quote)
    requestAnimationFrame(() => ta.current?.focus())
  }, [quoteSeed])
  const fileSpans = useMemo(() => scanFileReferences(text, atts), [text, atts])
  // Reference capsules drawn in a mirror under the transparent textarea.
  const mentionSpans = useMemo(() => [
    ...parseMentions(text, accounts, fileSpans),
    ...fileSpans.map(({ start, end }) => ({ index: start, length: end - start }))
  ].sort((a, b) => a.index - b.index), [text, accounts, fileSpans])
  const syncMirror = useCallback(() => {
    const el = ta.current
    const m = mirror.current
    if (!el || !m) return
    m.style.width = el.clientWidth + 'px'
    m.scrollTop = el.scrollTop
  }, [])
  const ghost = !!suggestion && !text && !atts.length && !mention && !slash && !file
  const compactHeight = Math.min(compactMetrics.scrollHeight, COMPOSER_MAX_HEIGHT)
  const showExpand = showComposerExpand({ ...compactMetrics, expanded, hasText: !!text, clientHeight: compactHeight })
  const editorPadding = ghost ? (showExpand ? 'pr-24' : 'pr-16') : showExpand ? 'pr-14' : 'pr-5'
  const editorText = `pt-4 pb-3 pl-5 text-[15px] leading-[22px] break-words whitespace-pre-wrap ${editorPadding}`
  useEffect(() => {
    if (!ghost) return
    const onWinKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return
      const active = document.activeElement as HTMLElement | null
      if (active?.closest('[data-editor-panel]')) return
      if (active === ta.current) return // handled by textarea onKeyDown
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.isContentEditable || active.closest('.xterm'))) return
      e.preventDefault()
      const v = suggestion!
      setText(v)
      requestAnimationFrame(() => {
        const el = ta.current
        if (!el) return
        el.focus()
        el.setSelectionRange(v.length, v.length)
      })
    }
    window.addEventListener('keydown', onWinKey)
    return () => window.removeEventListener('keydown', onWinKey)
  }, [ghost, suggestion])
  const fileInput = useRef<HTMLInputElement>(null)
  const wrap = useRef<HTMLDivElement>(null)

  const measureCompact = useCallback(() => {
    const el = ta.current
    if (!el || expanded) return
    const scroll = el.scrollTop
    // Read the natural height at the full text width before any scrollbar takes space.
    el.style.height = '0px'
    el.style.overflowY = 'hidden'
    const scrollHeight = el.scrollHeight
    const style = getComputedStyle(el)
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
    const lineHeight = parseFloat(style.lineHeight)
    el.style.height = ''
    el.style.overflowY = ''
    el.scrollTop = scroll
    setCompactMetrics({ scrollHeight, padding, lineHeight })
    syncMirror()
  }, [expanded, syncMirror])

  useLayoutEffect(() => {
    measureCompact()
  }, [text, suggestion, editorPadding, measureCompact])

  useLayoutEffect(() => {
    const el = ta.current
    if (!el) return
    let width = el.offsetWidth
    const ro = new ResizeObserver(() => {
      if (el.offsetWidth !== width) {
        width = el.offsetWidth
        measureCompact()
      }
      syncMirror()
    })
    ro.observe(el)
    syncMirror()
    return () => ro.disconnect()
  }, [measureCompact, syncMirror])

  useEffect(() => {
    const el = wrap.current
    const area = editor.current
    if (!el || !area) return
    // Track actual overlay height when expanded so the upper message list remains scrollable above it;
    // when compact/closing, target the compact slot immediately instead of waiting for the 200ms collapse.
    const report = () => onHeight(expanded ? el.offsetHeight : el.offsetHeight - area.offsetHeight + compactHeight)
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [compactHeight, expanded, onHeight])

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
      .filter(isSignedIn)
      .map((p, i) => ({ p, s: score(p), i: i - (participants.includes(p.id) ? 1000 : 0) + (p.id === driver?.id ? 100000 : 0) }))
      .filter((x) => x.s >= 0)
    const byName = scored.filter((x) => x.s < 9)
    const isDriver = (x: { p: ProfileState }) => Number(x.p.id === driver?.id)
    return (byName.length ? byName : scored).sort((a, b) => isDriver(a) - isDriver(b) || a.s - b.s || a.i - b.i).map((x) => x.p)
  }, [mention, accounts, participants, driver])

  // preload model lists for the @ menu's sub-model column
  useEffect(() => {
    for (const p of accounts) if (isSignedIn(p) && !getModelList(p.id)) void loadModels(p.id)
  }, [accounts])
  const subOptions = (p: ProfileState): (string | null)[] => {
    const main = (getModelList(p.id)?.models ?? []).filter((m) => m.group === 'main').map((m) => m.id)
    const def = resolveSpec(p.defaultModel, p.id).model
    return [null, ...new Set([...(def ? [def] : []), ...main])].slice(0, 12)
  }
  // effort chosen in the @ sub-model column (applies to the inserted model if it supports it)
  const [subEffort, setSubEffort] = useState<string | null>(null)

  /**
   * Updates completion from the text before the caret. `@` (or full-width `＠`)
   * triggers anywhere except right after a letter or digit (e-mail addresses): line start, after a
   * space and right after Chinese text (`让@`). Same `@` and query -> the menu keeps its selection.
   */
  const syncCompletion = (value: string, caret: number | null) => {
    if (slash?.mode === 'picker') return
    if (caret === null) {
      setFile(null)
      setMention(null)
      setSlash(null)
      return
    }
    // closed with Esc: stay closed until the text or the caret changes
    const d = dismissed.current
    if (d && d.value === value && d.caret === caret) return
    dismissed.current = null
    const fileTrigger = matchFileTrigger(value, caret)
    if (fileTrigger) {
      setMention(null)
      setSlash(null)
      setFile((cur) => cur?.trigger.start === fileTrigger.start && cur.trigger.query === fileTrigger.query ? cur : { trigger: fileTrigger, index: 0 })
      return
    }
    setFile(null)
    const before = value.slice(0, caret)
    const m = /(?:^|[^A-Za-z0-9_.+\-])[@＠]([^\s@＠]{0,24})$/.exec(before)
    if (!m) {
      setMention(null)
      const trigger = matchSlashTrigger(value, caret)
      return setSlash((current) => {
        if (!trigger) return null
        if (current?.mode === 'inline' && current.start === trigger.start && current.query === trigger.query) return current
        return { mode: 'inline', ...trigger, index: 0 }
      })
    }
    setSlash(null)
    const start = caret - m[1].length - 1
    setMention((cur) => (cur && cur.start === start && cur.query === m[1] ? cur : { start, query: m[1], index: 0, sub: null, subIndex: 0 }))
  }
  useEffect(() => {
    if (!expanded && !mention && !slash && !fileOpen && !ghost) return
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const el = ta.current
      if (!el || (!expanded && event.target !== el)) return
      if (event.target instanceof Element && event.target.closest('.xterm, [data-editor-panel]')) return
      const action = composerEscapeAction({
        expanded, composing: composingRef.current || event.isComposing || event.keyCode === 229,
        higherLayer: escLayers() > 0, extensionsOpen: slash?.mode === 'picker', mention: !!mention, slash: !!slash, file: fileOpen, ghost
      })
      if (!action) return
      event.preventDefault()
      if (action === 'mention' || action === 'slash' || action === 'file') {
        dismissed.current = { value: el.value, caret: el.selectionStart }
        if (action === 'mention') setMention(null)
        else if (action === 'slash') setSlash(null)
        else setFile(null)
      } else if (action === 'ghost') {
        if (threadId) clearSuggestion(threadId)
      } else {
        changeExpansion('escape')
        el.focus({ preventScroll: true })
      }
    }
    window.addEventListener('keydown', onEscape)
    return () => window.removeEventListener('keydown', onEscape)
  }, [expanded, fileOpen, ghost, mention, slash, threadId])

  const runCompact = () => {
    changeExpansion('send')
    void onCompact()
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

  const dismissQuickSkills = useCallback(() => {
    const el = ta.current
    if (el) dismissed.current = { value: el.value, caret: el.selectionStart }
    setSlash(null)
  }, [])

  /** Inserts a skill using its provider's trigger, or runs the standalone built-in command. */
  const insertSkill = (it: SkillItem, trigger: 'click' | 'enter' | 'tab' = 'click') => {
    const el = ta.current
    if (!slash || !el) return
    const picker = slash.mode === 'picker'
    const start = picker ? el.selectionStart : slash.start
    const end = picker ? el.selectionEnd : el.selectionStart
    const before = el.value.slice(0, start)
    const after = el.value.slice(end)
    const standalone = picker ? !el.value.trim() : !before.trim() && !after.trim()

    if (it.source === 'builtin' && it.insert === COMPACT_COMMAND_INSERT && standalone) {
      if (trigger === 'tab') {
        applyReferenceEdit(el, { value: COMPACT_COMMAND_INSERT, caret: COMPACT_COMMAND_INSERT.length })
        return
      }
      setSlash(null)
      setText('')
      if (!atts.length && !quote) clearComposerDraft(draftKey)
      if (picker) el.focus({ preventScroll: true })
      runCompact()
      return
    }

    const prefix = picker && before && !/\s$/u.test(before) ? ' ' : ''
    const suffix = picker && /^\s/u.test(after) ? '' : ' '
    const token = prefix + it.insert + suffix
    applyReferenceEdit(el, { value: before + token + after, caret: start + token.length })
  }

  const focusReference = useCallback((el: HTMLTextAreaElement, next: { value: string; caret: number }) => {
    dismissed.current = next
    el.focus({ preventScroll: true })
    el.setSelectionRange(next.caret, next.caret)
  }, [])

  useLayoutEffect(() => {
    const next = pendingReferenceFocus.current
    const el = ta.current
    if (!next || !el) return
    pendingReferenceFocus.current = null
    if (el.value === next.value) focusReference(el, next)
  }, [text, focusReference])

  const applyReferenceEdit = useCallback((el: HTMLTextAreaElement, next: { value: string; caret: number }) => {
    histRef.current = null
    setFile(null)
    setMention(null)
    setSlash(null)
    if (el.value === next.value) {
      focusReference(el, next)
    } else {
      pendingReferenceFocus.current = next
      setText(next.value)
    }
  }, [focusReference])

  useEffect(() => {
    const el = ta.current
    if (!el || !fileRefSeed || appliedFileRefSeq.current === fileRefSeed.seq) return
    appliedFileRefSeq.current = fileRefSeed.seq
    let path = fileRefSeed.path
    let relativePath = deriveRelativePath(path, projectDir)
    if (!relativePath && fileRefSeed.realPath) {
      relativePath = deriveRelativePath(fileRefSeed.realPath, projectDir)
      if (relativePath) path = fileRefSeed.realPath
    }
    const name = path.split(path.startsWith('/') ? '/' : /[/\\]/).at(-1) || path
    const merged = mergeAttachments(live.current.atts, [{
      id: fileMenuId + ':' + path,
      path,
      name,
      source: relativePath ? 'workspace-file' : 'chat-attachment',
      relativePath: relativePath ?? undefined,
      isImage: false,
      size: 0,
      thumb: null
    }], projectDir)
    const attachment = merged.resolved[0]
    if (!attachment) {
      toast({ kind: 'warn', title: t('att.limit', { n: COMPOSER_ATTACHMENT_LIMIT }) })
      return
    }
    setAtts(merged.next)
    const next = insertFileReferenceAtCaret(el.value, el.selectionStart, el.selectionEnd, attachmentRefLabel(attachment), fileRefSeed.lineRange)
    if (/[^\S\r\n]/.test(next.value[next.caret] ?? '')) next.caret++
    applyReferenceEdit(el, next)
  }, [fileRefSeed, projectDir, fileMenuId, toast, applyReferenceEdit])

  const insertFile = (item: ComposerFileCandidate) => {
    const el = ta.current
    if (!el || !file || !fileOpen || el.selectionStart !== el.selectionEnd) return
    const match = matchFileTrigger(el.value, el.selectionStart)
    if (!match || match.start !== file.trigger.start || match.query !== file.trigger.query) return
    let attachment: Attachment
    if (item.kind === 'added') attachment = item.attachment
    else {
      const path = projectDir && joinPosixRelative(projectDir, item.relPath, { literalPosix: true })
      if (!path) return
      const merged = mergeAttachments(atts, [{
        id: fileMenuId + ':' + path, path, name: item.name, source: 'workspace-file', relativePath: item.relPath,
        isImage: isPreviewableImagePath(item.relPath), size: 0, thumb: null
      }], projectDir)
      if (!merged.resolved.length) return toast({ kind: 'warn', title: t('att.limit', { n: COMPOSER_ATTACHMENT_LIMIT }) })
      attachment = merged.resolved[0]
      setAtts(merged.next)
    }
    applyReferenceEdit(el, applyFileReference(el.value, match.start, el.selectionStart, attachmentRefLabel(attachment)))
  }


  const removeAttachment = (a: Attachment) => {
    setAtts((items) => items.filter((item) => item.id !== a.id))
    setText((value) => removeFileReferences(value, a, atts))
    setFile(null)
    histRef.current = null
  }

  const addFiles = async (files: File[]) => {
    if (!files.length) return
    const added = await Promise.allSettled(files.slice(0, COMPOSER_ATTACHMENT_LIMIT).map((f) => toAttachment(f, projectDir)))
    const ready = added.flatMap((result) => result.status === 'fulfilled' && result.value.path ? [result.value] : [])
    if (ready.length !== added.length) toast({ kind: 'warn', title: t('att.addFailed') })
    if (!ready.length) return
    if (live.current.key !== draftKey) {
      const draft = composerDraft(draftKey)
      saveComposerDraft(draftKey, draft?.text ?? '', mergeAttachments(draft?.atts ?? [], ready, projectDir).next, draft?.quote ?? null)
      return
    }
    setAtts((items) => mergeAttachments(items, ready, projectDir).next)
  }

  const canSend = !!driver && (text.trim().length > 0 || atts.length > 0)
  const doSend = () => {
    if (isCompactCommand(text)) {
      setSlash(null)
      setText('')
      if (!atts.length && !quote) clearComposerDraft(draftKey)
      runCompact()
      return
    }
    if (!driver) return toast({ kind: 'warn', title: t('wb.noModel'), action: { label: t('wb.addAccount'), run: () => navigate('engines') } })
    if (!text.trim() && !atts.length) return
    if (!isSignedIn(driver))
      return toast({
        kind: 'warn',
        title: t('wb.notUsable', { name: driver.name }),
        desc: accountBadge(driver).label,
        action: { label: driver.status === 'uninstalled' ? t('wb.goInstall') : t('wb.goLogin'), run: () => navigate('engines', driver.id) }
      })
    const sentText = text
    const sentAtts = atts
    const sentQuote = quote
    const trimmed = text.trim()
    if (trimmed) pushInputHistory(trimmed)
    histRef.current = null
    const r = onSend(trimmed, atts, quote)
    clearComposerDraft(draftKey)
    setText('')
    setFile(null)
    setAtts([])
    setQuote(null)
    if (!r) changeExpansion('send')
    // cancelled (e.g. the session is being written elsewhere): give the draft back if still empty
    void r?.then((ok) => {
      if (ok) {
        if (live.current.key === draftKey) changeExpansion('send')
        return
      }
      if (live.current.key !== draftKey) {
        const draft = composerDraft(draftKey)
        saveComposerDraft(draftKey, draft?.text || sentText, draft?.atts.length ? draft.atts : sentAtts, draft?.quote ?? sentQuote)
        return
      }
      setText((cur) => cur || sentText)
      setAtts((cur) => (cur.length ? cur : sentAtts))
      setQuote((cur) => cur ?? sentQuote)
    })
  }

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const composing = composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229
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
    }
    if (slash?.mode === 'inline' && slashGroups && !composing) {
      const n = slashGroups.flat.length
      if (n && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault()
        const d = e.key === 'ArrowDown' ? 1 : -1
        return setSlash((x) => x && { ...x, index: (slashActive + d + n) % n })
      }
      if (n && (e.key === 'Enter' || e.key === 'Tab')) {
        e.preventDefault()
        return insertSkill(slashGroups.flat[slashActive], e.key === 'Tab' ? 'tab' : 'enter')
      }
    }
    if (fileOpen && !composing && fileSearch.items.length && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const n = fileSearch.items.length
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const d = e.key === 'ArrowDown' ? 1 : -1
        return setFile((x) => x && { ...x, index: (fileActive + d + n) % n })
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        return insertFile(fileSearch.items[fileActive])
      }
    }
    // suggested next input: Tab takes it as editable text
    if (ghost && !composing && !mention && !slash) {
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault()
        const v = suggestion!
        setText(v)
        requestAnimationFrame(() => {
          const el = ta.current
          if (!el) return
          el.focus()
          el.setSelectionRange(v.length, v.length)
        })
        return
      }
    }
    // ↑/↓ input history recall (text only; preserves multiline caret movement & never conflicts with @, / or IME)
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !composing && !mention && !slash && !fileOpen && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && history.length > 0) {
      const el = e.currentTarget
      const step = stepInputHistory({
        key: e.key,
        value: text,
        selectionStart: el.selectionStart,
        selectionEnd: el.selectionEnd,
        history,
        cursor: histRef.current
      })
      if (step.handled) {
        e.preventDefault()
        histRef.current = step.cursor
        if (step.text !== undefined) {
          const val = step.text
          setText(val)
          requestAnimationFrame(() => {
            const box = ta.current
            if (!box) return
            box.focus()
            box.setSelectionRange(val.length, val.length)
          })
        }
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

  const completionPopover = `absolute bottom-full left-0 z-30 mb-2 ${expanded ? '[&>div]:max-h-[min(380px,calc(50dvh-4.5rem))]' : ''}`
  return (
    <div ref={wrap} className={`pointer-events-none absolute inset-x-0 bottom-0 flex flex-col px-8 pt-8 pb-6 [interpolate-size:allow-keywords] transition-[height] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
      expanded ? 'z-30 h-[clamp(260px,50%,calc(100%-3.5rem))] bg-[linear-gradient(to_bottom,transparent,var(--chat-canvas)_48px)]' : 'h-auto bg-[linear-gradient(to_bottom,transparent,var(--chat-canvas)_42%)]'
    }`}>
      <div className="pointer-events-auto relative mx-auto flex min-h-0 w-full max-w-[820px] flex-1 flex-col">
        {notice}
        {queue}
        {slash && slashGroups && (
          <div className={completionPopover + ' right-0 pointer-events-none [&>div]:pointer-events-auto'}>
            <QuickSkillsPopover
              mode={slash.mode}
              query={slash.query}
              groups={slashGroups}
              kind={driver?.kind}
              pins={pins}
              loading={skills.loading}
              active={slashActive}
              onQuery={(query) => setSlash((current) => current?.mode === 'picker' ? { ...current, query, index: 0 } : current)}
              onPick={insertSkill}
              onHover={(index) => setSlash((current) => current && { ...current, index })}
              onDismiss={dismissQuickSkills}
              onCancel={() => {
                dismissQuickSkills()
                ta.current?.focus({ preventScroll: true })
              }}
              onManage={() => {
                dismissQuickSkills()
                openSettings('extensions')
              }}
            />
          </div>
        )}
        {fileOpen && (
          <div className={completionPopover + ' right-0 pointer-events-none [&>div]:pointer-events-auto'}>
            <FileSearchMenu
              id={fileMenuId}
              {...fileSearch}
              active={fileActive}
              projectDir={projectDir}
              hasAttachments={!!atts.length}
              onPick={insertFile}
              onHover={(index) => setFile((x) => x && { ...x, index })}
            />
          </div>
        )}
        {mention && (
          <div className={`absolute bottom-full left-0 z-30 mb-2 flex items-end gap-2 ${expanded ? '[&>div]:max-h-[min(400px,calc(50dvh-4.5rem))] [&>div]:min-w-0' : ''}`}>
            <div className={popover + ' max-h-[min(400px,calc(100dvh-12rem))] w-72 overflow-y-auto overscroll-contain'}>
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
                        {p.defaultModel || getProviderCapabilities(p.kind).hasExplicitDefaultModel ? modelLabel(p.defaultModel, p.id) : t('common.default')} ›
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
                  <EffortBar reasonix={getProviderCapabilities(p.kind).supportsDisabledEffort} opt={hotOpt} effort={subEffort} onChange={setSubEffort} />
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
          className={`relative flex min-h-0 flex-1 flex-col rounded-[24px] border border-editor-hairline bg-elevated shadow-[0_4px_16px_rgba(0,0,0,0.08)] transition-shadow ${
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
          {quote && (
            <div className="mx-3.5 mt-3 flex shrink-0 items-start gap-2.5 rounded-xl border-l-2 border-accent bg-fill/75 px-3 py-2 text-[12px] text-ink-2">
              <IconQuote size={13} className="mt-0.5 shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <div className="font-medium text-ink">{t('quote.replyingTo', { name: quote.author })}</div>
                <div className="mt-0.5 line-clamp-2 text-ink-3 whitespace-pre-wrap">{quote.excerpt}</div>
              </div>
              <button
                type="button"
                onClick={() => setQuote(null)}
                className="shrink-0 rounded-full p-1 text-ink-3 transition-colors hover:bg-black/[0.06] hover:text-ink dark:hover:bg-white/[0.08]"
                title={t('quote.remove')}
                aria-label={t('quote.remove')}
              >
                <IconX size={12} />
              </button>
            </div>
          )}
          {viewing && (
            <AttachmentViewer a={viewing} projectDir={projectDir} revision={previewRevision}
              onRebindProject={viewing.source === 'workspace-file' ? onRebindProject : undefined} onClose={() => setViewing(null)} />
          )}
          {atts.length > 0 && (
            <div className="shrink-0 px-4 pt-3">
              <AttachmentBar variant="cards" items={atts} projectDir={projectDir} revision={previewRevision}
                onOpen={(a) => {
                  if (!a.isImage && onOpenEditorFile) {
                    const target = attachmentPaths(a, projectDir)[0]
                    if (target) {
                      onOpenEditorFile(target)
                      return
                    }
                  }
                  setViewing(a.id)
                }} onRemove={removeAttachment} />
            </div>
          )}

          <div ref={editor} className={`relative flex-auto ${expanded ? 'min-h-[96px]' : 'min-h-0'}`} style={expanded ? undefined : { height: compactHeight }}>
            {ghost && (
              <span className={`pointer-events-none absolute top-[17px] z-10 rounded-[5px] px-1.5 py-px font-mono text-[10.5px] leading-4 text-ink-3 shadow-[inset_0_0_0_1px_var(--ring),0_1px_0_var(--ring)] ${showExpand ? 'right-14' : 'right-4'}`} title={t('wb.tabAccept')}>
                Tab
              </span>
            )}
            {showExpand && (
              <button type="button" aria-expanded={expanded}
                aria-label={t(expanded ? 'wb.collapseComposer' : 'wb.expandComposer')}
                title={t(expanded ? 'wb.collapseComposer' : 'wb.expandComposer')}
                className="absolute top-2.5 right-4 z-10 grid size-8 place-items-center rounded-lg text-ink-3 transition-colors hover:bg-fill hover:text-ink focus-visible:text-ink motion-safe:animate-[composer-control-in_140ms_ease-out]"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  changeExpansion('toggle')
                  ta.current?.focus({ preventScroll: true })
                }}>
                {expanded ? <IconMinimize size={15} aria-hidden="true" /> : <IconMaximize size={15} aria-hidden="true" />}
              </button>
            )}
            <div
              ref={mirror}
              aria-hidden
              spellCheck={false}
              className={`pointer-events-none absolute inset-y-0 left-0 overflow-hidden text-ink ${editorText}`}
            >
              {mirrorSegments(text, mentionSpans)}
            </div>
            <textarea
              ref={ta}
              rows={1}
              spellCheck={false}
              onScroll={syncMirror}
              value={text}
              aria-autocomplete={fileOpen ? 'list' : undefined}
              aria-controls={fileOpen ? fileMenuId : undefined}
              aria-activedescendant={fileOpen && fileSearch.items.length ? `${fileMenuId}-${fileActive}` : undefined}
              onChange={(e) => {
                histRef.current = null
                // the suggestion only hides while there is text (ghost needs an empty box): typing,
                // pinyin or a thread switch never throws it away — sending or Esc does
                setText(e.target.value)
                // mid-composition text is pinyin, not the query: wait for compositionend
                if (!composingRef.current && !(e.nativeEvent as InputEvent).isComposing) syncCompletion(e.target.value, e.target.selectionStart)
              }}
              onCompositionStart={() => {
                composingRef.current = true
                setFile(null)
                setSlash(null)
              }}
              onCompositionEnd={(e) => {
                composingRef.current = false
                syncCompletion(e.currentTarget.value, e.currentTarget.selectionStart)
              }}
              // caret moved (click, ←/→, Home/End) without typing: reopen / close for that position
              onSelect={(e) => {
                const el = e.currentTarget
                if (!composingRef.current) syncCompletion(el.value, el.selectionStart === el.selectionEnd ? el.selectionStart : null)
              }}
              onBlur={() => {
                setMention(null)
                setSlash((current) => current?.mode === 'inline' ? null : current)
                setFile(null)
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
              className={`absolute inset-0 block h-full w-full resize-none overflow-y-auto overscroll-contain bg-transparent scroll-py-3 text-transparent caret-ink outline-none selection:bg-accent/25 ${editorText} ${ghost ? 'placeholder:text-ink-3/80' : 'placeholder:text-ink-3'}`}
            />
          </div>

          <div className="flex shrink-0 items-center gap-1 px-3 pt-1 pb-3">
            <DriverPicker driver={driver} onPick={(id) => onDriver(id, null)} />
            <QuotaDot driver={driver} model={driverModel} onSwitch={(id) => onDriver(id, null)} />
            {driver && <ModelCapsule account={driver} model={driverModel} onPick={(m) => onDriver(driver.id, m)} />}
            <QuickSkillsButton
              open={!!slash}
              onToggle={() => {
                if (slash?.mode === 'picker') {
                  dismissQuickSkills()
                  ta.current?.focus({ preventScroll: true })
                  return
                }
                setMention(null)
                setFile(null)
                setSlash({ mode: 'picker', query: '', index: 0 })
              }}
            />
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
            <button
              type="button"
              onClick={runCompact}
              disabled={!canCompact || compacting}
              className="flex h-7 items-center gap-1 rounded-full bg-black/[0.045] px-2.5 text-[12px] font-medium text-ink-2 transition-colors enabled:hover:bg-black/[0.07] enabled:hover:text-ink disabled:cursor-not-allowed disabled:opacity-45"
              title={
                busy
                  ? t('wb.compactBusy')
                  : canCompact
                    ? `${t('wb.ctxCompactHint')}${contextTokens > 0 && contextWindow > 0 ? `\n${fmtTokens(contextTokens)} / ${fmtTokens(contextWindow)} (${Math.round((contextTokens / contextWindow) * 100)}%)` : ''}`
                    : t('wb.compactBtnEmpty')
              }
            >
              <IconCompact size={13} className="shrink-0 text-ink-3" />
              <span>{t('wb.compactBtn')}</span>
              {canCompact && contextTokens > 0 && (
                <span className="text-ink-3 tabular-nums">· {fmtTokens(contextTokens)}</span>
              )}
            </button>
            {busy && (
              <button onClick={onStop} className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-canvas transition-transform active:scale-95" title={t('common.stop')}>
                <IconStop size={14} />
              </button>
            )}
            <button
              onClick={doSend}
              disabled={!canSend}
              className={`flex h-8 items-center justify-center rounded-full bg-accent text-white shadow-[0_1px_2px_rgba(0,122,255,0.35)] transition-all hover:bg-accent-hover active:scale-95 disabled:text-ink-3 disabled:shadow-none ${busy ? 'gap-1.5 px-3 text-[13px] font-medium disabled:bg-fill' : 'w-8 disabled:bg-black/[0.08]'}`}
              title={t(busy ? 'wb.queueHint' : 'wb.sendHint', { key: sendKeys(sendKey).send })}
            >
              {busy ? <><IconClock size={15} /> {t('wb.queueSend')}</> : <IconArrowUp size={17} strokeWidth={2.2} />}
            </button>
          </div>
        </div>
        {footer}
      </div>
    </div>
  )
}

/** Avatar for a message's agent/driver ref, using the live account when it still exists. */
function RefAvatar({ r, size }: { r: { profileId: string | null; kind: ProfileState['kind'] }; size: number }) {
  const { profiles } = useApp()
  const p = profiles.find((x) => x.id === r.profileId)
  return <ProfileAvatar profile={p ?? { kind: r.kind }} size={size} />
}
