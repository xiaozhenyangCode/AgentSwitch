import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, isAbsolute, join, relative } from 'node:path'
import { LEGACY_USER_DATA } from './legacy'
import type { AgentEvent, ChatEvent, Usage, ProfileConfig, ProfileId, RunAgentRef, RunRequest, StepStatus } from '@shared/types'
import { runAgent, type RunHandle } from './agentRunner'
import { FileBaseline } from './fileBaseline'
import { recordLimited, recordQuota, recordRun, refreshPostRunQuota } from './usage'
import { allowRoot } from './fileProtocol'
import { KIND_LABEL, getConfig, hasProfile } from './profiles'
import { t } from './i18n'
import { stripMarks } from '@shared/markers'
import { maskCode } from '@shared/mentions'
import { historyModel, numberTranscript, reportedContextWindow, unseenTranscript } from '@shared/transcript'
import { budgetedHandoff, contextBudgetFor } from '@shared/contextBudget'
import {
  defaultContextWindowFor,
  getProviderCapabilities,
  shouldUnbindSessionsOnRewind,
  usesInlineSystemPrompt
} from '@shared/providerCapabilities'
import { bindNativeSession, canResume, clearActiveSessions, recordUnconfirmedSession, type NativeSessions } from './historyResume'
import { createThreadHistory, supportsThreadHistory } from './threadHistoryConfig'
import { Checkpoints } from './checkpoints'
import { SKIP_DIRS, SNAPSHOT_MAX_FILES } from './checkpointFiles'
import { isInside } from './gitOps'

/**
 * One user message = one turn. A turn is a strictly serial list of steps: the next CLI
 * process starts only after the previous one exited. Steps hand over through files in
 * <project>/.agentswitch/runs/<turnId>/ (task.json, step-N.md, step-N.files.json, attachments/),
 * never by scraping terminal text.
 *
 * Step sources:
 *  - a message that starts with an @mention: the mentioned accounts in text order (each gets
 *    the text segment after its mention) — the user named them directly
 *  - otherwise the driver answers first; it may append an ```agentswitch:dispatch``` block to
 *    delegate to other participants (and anyone @-named mid-sentence), run in order, after
 *    which the driver comes back to finish the remaining work (review, edit, import)
 *  - a short driver summary after any multi-model chain
 * Review steps must end with {"status":"PASS"|"REJECT","reason"}; REJECT re-runs the
 * previous step with the reason, at most MAX_RETRIES times, then the turn pauses.
 */

const MAX_RETRIES = 3
const MAX_DISPATCH = 6
const PREV_STEP_CHARS = 4000
/** Resumed inline-system sessions get the fixed instructions again after this many compact turns. */
const SYSTEM_RESEND_TURNS = 8

interface StepPrompt {
  prompt: string
  /**
   * System text: only what stays the same across turns (identity, project, permissions, dispatch
   * rules). It sits in front of the whole history in every engine's prompt cache (claude
   * --append-system-prompt, agy ACP systemPrompt.append), so any per-turn byte in it would
   * invalidate the cached conversation. Per-turn lines (run / output dirs, reply language) go at
   * the end of the prompt instead.
   */
  system: string
}

/** The prompt with this turn's environment lines appended (`tail`: lines that must stay last). */
function stepPrompt(parts: string[], sys: string[], turnLines: string[], tail: string[] = []): StepPrompt {
  return {
    prompt: [...parts, '', '## 本轮环境', ...turnLines, ...tail].join('\n'),
    system: sys.join('\n')
  }
}
const REVIEW_RE = /验收|审核|审查|复核|评审|检查|review/i

type StepKind = 'own' | 'mention' | 'dispatch' | 'summary'

interface Step {
  id: string
  n: number
  profileId: ProfileId
  model: string | null
  task: string
  kind: StepKind
  dispatchedBy: ProfileId | null
  review: boolean
  /** Re-run number caused by a reviewer's REJECT (0 = first attempt). */
  retry: number
  feedback: string | null
  allowDispatch: boolean
  status: 'queued' | 'running' | StepStatus
  text: string
  outputs: string[]
}

interface Turn {
  req: RunRequest
  cwd: string
  runDir: string
  outDir: string
  attachments: string[]
  steps: Step[]
  idx: number
  current: RunHandle | null
  stopped: boolean
  paused: { reviewIdx: number; reason: string } | null
  retryBudget: number
  counter: number
  /** Accounts the user @-named mid-sentence: the driver plans and dispatches to them (with these models). */
  named: RunAgentRef[]
  checkpoint: Promise<void>
  ending?: Promise<void>
  done: Promise<void>
  resolveDone: () => void
}

const uid = (): string => randomBytes(6).toString('hex')

// ---- per-thread CLI sessions ----------------------------------------------------------------

const sessionsFile = (threadId: string): string => join(app.getPath('userData'), 'threads', `${threadId.replace(/[^\w-]/g, '')}.json`)
function loadSessions(threadId: string): NativeSessions {
  try {
    return JSON.parse(readFileSync(sessionsFile(threadId), 'utf8')) ?? {}
  } catch {
    return {}
  }
}

function saveSession(
  threadId: string, profileId: ProfileId, sid: string,
  binding: Parameters<typeof bindNativeSession>[3] | { unconfirmed: true }
): void {
  const f = sessionsFile(threadId)
  const previous = loadSessions(threadId)
  const state = 'unconfirmed' in binding
    ? recordUnconfirmedSession(previous, profileId, sid)
    : bindNativeSession(previous, profileId, sid, binding)
  mkdirSync(join(f, '..'), { recursive: true })
  writeFileSync(f, JSON.stringify(state, null, 2))
}

/**
 * The user's language, from their message. The prompts AgentSwitch sends are Chinese, so "match the
 * user" alone lets some models (Codex especially) answer an English message in Chinese.
 */
function userLanguage(text: string): 'ja' | 'zh' | 'en' | null {
  const body = text.replace(/```[\s\S]*?```|`[^`]*`|https?:\/\/\S+|@\S+/g, ' ')
  if (/[\u3040-\u30ff]/.test(body)) return 'ja'
  if (/[\u4e00-\u9fff]/.test(body)) return 'zh'
  if (/[a-z]{2,}/i.test(body)) return 'en'
  return null
}

/** Reply-language rule for the system prompt. */
function replyLanguage(text: string): string {
  const lang = userLanguage(text)
  if (lang === 'en') return 'Reply in Markdown. The user writes in English: write your whole reply in English, including summaries and any review reason.'
  if (lang === 'ja') return '回复使用 Markdown，用日语回复（用户使用日语）。'
  if (lang === 'zh') return '回复使用 Markdown，用中文回复。'
  return '回复使用 Markdown，语言与用户一致。'
}

/** Language rule for the generated chat title. */
function titleLanguage(text: string): string {
  const lang = userLanguage(text)
  if (lang === 'en') return 'the user wrote in English: the title MUST be English, 3–7 words'
  if (lang === 'ja') return '用日语，8–20 个字'
  if (lang === 'zh') return '用中文，6–18 个字'
  return '与用户消息的语言一致，6–18 个字'
}

/** Imported CLI history: the thread continues that native session (--resume / exec resume / --conversation). */
export const importSession = (threadId: string, profileId: ProfileId, sid: string): void =>
  saveSession(threadId, profileId, sid, { importedAt: Date.now() })

/** Folder a thread's runs use: its project, or AgentSwitch's private workspace when unset/missing. */
export function threadCwd(threadId: string, projectDir: string | null): string {
  if (projectDir && isAbsolute(projectDir) && existsSync(projectDir) && statSync(projectDir).isDirectory()) return projectDir
  const id = threadId.replace(/[^\w-]/g, '')
  // threads from the AgentMux era keep their workspace: CLI sessions are keyed by this path
  const legacy = join(LEGACY_USER_DATA, 'workspaces', id)
  if (id && existsSync(legacy)) return legacy
  const cwd = join(app.getPath('userData'), 'workspaces', id)
  mkdirSync(cwd, { recursive: true })
  return cwd
}

const HANDOFF_DOC_CHARS = 20000
const handoffPrompt = (target: string): string =>
  [
    `用户要把这个对话交给另一个模型（${target}）继续。请根据你在本对话中的全部上下文，写一份交接文档，让对方无需翻看历史就能接手。`,
    '只输出文档本身（Markdown），不要修改任何文件、不要执行命令。不要复述 AgentSwitch 的环境说明（授权方式、交接目录、输出目录、回复格式等，对方会收到自己的版本），只写与任务本身有关的内容。按以下小节组织，没有内容的小节写「无」：',
    '',
    '## 目标',
    '用户最终要达成什么，验收标准是什么。',
    '## 已完成的工作',
    '做了什么；列出修改/新建过的文件路径（相对项目目录）。',
    '## 关键决策与约束',
    '已经定下的方案、用户明确提出的要求和禁忌、踩过的坑。',
    '## 未完成事项与下一步',
    '还没做完的事，按优先级给出具体的下一步。'
  ].join('\n')

// ---- file snapshots (fallback detection of produced files) ------------------------------------

function snapshot(root: string, extra: string[]): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (dir: string, depth: number): void => {
    if (out.size >= SNAPSHOT_MAX_FILES || depth > 8) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.size >= SNAPSHOT_MAX_FILES) return
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p, depth + 1)
      } else if (e.isFile()) {
        try {
          const st = statSync(p)
          out.set(p, `${st.mtimeMs}:${st.size}`)
        } catch {
          /* vanished */
        }
      }
    }
  }
  walk(root, 0)
  for (const d of extra) if (existsSync(d)) walk(d, 0)
  return out
}

// ---- prompt building ------------------------------------------------------------------------

const modelText = (cfg: ProfileConfig, model: string | null): string => model || (cfg.defaultModel ? cfg.defaultModel : '默认模型')

function verdictOf(text: string): { status: 'PASS' | 'REJECT'; reason: string } | null {
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1])
  const bare = [...text.matchAll(/\{[^{}]*"status"\s*:\s*"(?:PASS|REJECT)"[^{}]*\}/g)].map((m) => m[0])
  for (const c of [...blocks, ...bare].reverse()) {
    try {
      const v = JSON.parse(c)
      if (v?.status === 'PASS' || v?.status === 'REJECT') return { status: v.status, reason: String(v.reason ?? '') }
    } catch {
      /* not json */
    }
  }
  return null
}

function dispatchOf(text: string): { account: string; model?: string; task: string }[] {
  const m = [...text.matchAll(/```(?:agentswitch|agentmux):dispatch\s*([\s\S]*?)```/g)].pop()
  if (!m) return []
  try {
    const v = JSON.parse(m[1])
    const arr = Array.isArray(v) ? v : [v]
    return arr.filter((x) => x && typeof x.account === 'string' && typeof x.task === 'string' && x.task.trim())
  } catch {
    return []
  }
}

/** @mentions with their position in the text (outside code), in text order. */
function mentionMarks(req: RunRequest): { ref: RunAgentRef; i: number; end: number }[] {
  const plain = maskCode(req.text)
  return req.mentions
    .filter((r) => hasProfile(r.profileId))
    .map((ref) => {
      const name = getConfig(ref.profileId).name
      const i = plain.indexOf('@' + name)
      return { ref, i, end: i < 0 ? -1 : i + name.length + 1 }
    })
    .filter((m) => m.i >= 0)
    .sort((a, b) => a.i - b.i)
}

/**
 * The message opens with an @mention ("@B 做…", "@A 做步骤 1 @B 做步骤 2"): the user is naming
 * who does what. A mention after real instructions ("写好提示词让 @B 出图，再审核导入") is not.
 */
function startsWithMention(req: RunRequest): boolean {
  const marks = mentionMarks(req)
  return marks.length > 0 && marks[0].i === maskCode(req.text).search(/\S/)
}

/** Splits "@A 写提示词，然后让 @B 出图" into per-mention tasks, in text order. */
function mentionTasks(req: RunRequest): { ref: RunAgentRef; task: string }[] {
  const marks = mentionMarks(req)
  const PUNCT = /^[\s，,。、；;]+|[\s，,。、；;]+$/g
  return marks.map((m, k) => {
    let seg = req.text.slice(m.end, k + 1 < marks.length ? marks[k + 1].i : undefined).replace(/^\([^)]*\)/, '')
    seg = seg.replace(PUNCT, '').replace(/^(然后|再|并且|最后|接着)?(让|由|请)?/, '').replace(/(然后|再|并且|最后|接着)?(让|由|请)?$/, '').replace(PUNCT, '')
    return { ref: m.ref, task: seg || '协助完成用户的请求' }
  })
}

export class Orchestrator {
  private turns = new Map<string, Turn>() // by threadId
  private busy = new Map<ProfileId, number>()
  readonly rateLimited = new Set<ProfileId>()

  constructor(
    private emit: (e: ChatEvent) => void,
    private log: (profileId: ProfileId, text: string) => void,
    private onState: () => void,
    readonly checkpoints = new Checkpoints(app.getPath('userData'))
  ) {}

  isRunning = (id: ProfileId): boolean => (this.busy.get(id) ?? 0) > 0
  hasActiveTurn = (threadId: string): boolean => this.turns.has(threadId)

  /**
   * Unbinds all active native CLI sessions for `threadId` after a conversation rewind so the next
   * turn starts fresh CLI sessions with P0-3 budgeted handoff instead of resuming truncated history.
   */
  clearThreadSessions(threadId: string): boolean {
    return this.unbindSessions(threadId, (profileId) => !hasProfile(profileId) || shouldUnbindSessionsOnRewind(getConfig(profileId).kind))
  }

  /**
   * 「新开会话并交接核心上下文」: unbinds these accounts' native sessions of `threadId` (the chat
   * history stays), so their next turn starts a fresh CLI session with the P0-3 budgeted handoff
   * (16k + read_thread) instead of resuming a long, expensive context.
   */
  compactThreadSessions(threadId: string, profileIds: ProfileId[]): boolean {
    if (this.turns.has(threadId)) return false
    const only = new Set(profileIds)
    return this.unbindSessions(threadId, (profileId) => only.has(profileId))
  }

  private unbindSessions(threadId: string, shouldUnbind: (profileId: ProfileId) => boolean): boolean {
    const f = sessionsFile(threadId)
    const previous = loadSessions(threadId)
    const activeEntries = Object.entries(previous.sessions ?? {}).filter(([id, sid]) => !!sid && shouldUnbind(id))
    const hasModelsToClear = Object.keys(previous.models ?? {}).some(shouldUnbind)
    if (!activeEntries.length && !hasModelsToClear) return false
    for (const [, sid] of activeEntries) this.sentSystem.delete(sid)
    const next = clearActiveSessions(previous, shouldUnbind)
    mkdirSync(join(f, '..'), { recursive: true })
    writeFileSync(f, JSON.stringify(next, null, 2))
    return true
  }

  start(req: RunRequest): void {
    if (this.turns.has(req.threadId)) throw new Error(t('main.busy'))
    if (!hasProfile(req.driver.profileId)) throw new Error(t('main.noDriver'))

    if (req.projectDir && !req.allowMissingProject)
      if (!isAbsolute(req.projectDir) || !existsSync(req.projectDir) || !statSync(req.projectDir).isDirectory()) throw new Error(t('main.noProject', { dir: req.projectDir }))
    const cwd = threadCwd(req.threadId, req.projectDir)
    if (this.checkpoints.isRestoring(cwd)) throw new Error(t('checkpoint.restoring'))
    allowRoot(cwd)
    const base = join(cwd, '.agentswitch')
    mkdirSync(base, { recursive: true })
    // self-ignoring: run artefacts never show up in the project's git status
    if (!existsSync(join(base, '.gitignore'))) writeFileSync(join(base, '.gitignore'), '*\n')
    const runDir = join(base, 'runs', req.turnId.replace(/[^\w-]/g, ''))
    const outDir = join(base, 'outputs', req.turnId.replace(/[^\w-]/g, ''))
    mkdirSync(join(runDir, 'attachments'), { recursive: true })
    mkdirSync(outDir, { recursive: true })

    // attachments -> runs/<turn>/attachments/
    const attachments: string[] = []
    for (const a of req.attachments) {
      try {
        if (!isAbsolute(a.path) || !statSync(a.path).isFile()) continue
        let name = basename(a.name || a.path).replace(/[/\\]/g, '_') || 'file'
        while (existsSync(join(runDir, 'attachments', name))) name = `${basename(name, extname(name))}-${uid().slice(0, 4)}${extname(name)}`
        const dst = join(runDir, 'attachments', name)
        copyFileSync(a.path, dst)
        attachments.push(dst)
      } catch (e) {
        this.log(req.driver.profileId, `[attachments] skip ${a.path}: ${String(e)}\n`)
      }
    }

    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => { resolveDone = resolve })
    const checkpoint = this.checkpoints.begin(req.threadId, req.turnId, cwd).catch(() => {})
    const turn: Turn = {
      req, cwd, runDir, outDir, attachments, done, resolveDone, checkpoint,
      steps: [], idx: 0, current: null, stopped: false, paused: null, retryBudget: MAX_RETRIES, counter: 0, named: []
    }
    this.turns.set(req.threadId, turn)
    this.emit({ kind: 'turn-start', threadId: req.threadId, turnId: req.turnId, cwd })

    const driver = req.driver
    if (req.mode === 'handoff') {
      this.add(turn, { profileId: driver.profileId, model: driver.model, task: '生成交接文档', kind: 'own', dispatchedBy: null, allowDispatch: false })
      this.writeTask(turn)
      void checkpoint.then(() => this.next(turn))
      return
    }
    const tasks = mentionTasks(req)
    const others = tasks.filter((t) => t.ref.profileId !== driver.profileId)
    if (!others.length || !startsWithMention(req)) {
      // the driver goes first; accounts named mid-sentence are its collaborators for this turn
      turn.named = others.map((t) => t.ref).filter((r, i, a) => a.findIndex((x) => x.profileId === r.profileId) === i)
      const multi = turn.named.length > 0 || req.participants.filter((p) => p !== driver.profileId && hasProfile(p)).length > 0
      this.add(turn, { profileId: driver.profileId, model: driver.model, task: req.text, kind: 'own', dispatchedBy: null, allowDispatch: multi })
    } else {
      // the user named who does what, in order: nobody "dispatched" these steps
      for (const t of tasks)
        this.add(turn, {
          profileId: t.ref.profileId,
          model: t.ref.model ?? (t.ref.profileId === driver.profileId ? driver.model : null),
          task: t.task,
          kind: 'mention',
          dispatchedBy: null,
          allowDispatch: false
        })
      this.add(turn, { profileId: driver.profileId, model: driver.model, task: '', kind: 'summary', dispatchedBy: null, allowDispatch: false })
    }
    this.writeTask(turn)
    void checkpoint.then(() => this.next(turn))
  }

  /** Turns still in flight (a reloaded window re-attaches to them instead of marking them stopped). */
  active(): { threadId: string; turnId: string; running: string[]; pauseReason: string | null }[] {
    return [...this.turns.values()].map((t) => ({
      threadId: t.req.threadId, turnId: t.req.turnId,
      running: t.steps.filter((s) => s.status === 'running').map((s) => s.id),
      pauseReason: t.paused?.reason ?? null
    }))
  }

  activeProjects(): { threadId: string; dir: string }[] {
    return [...this.turns.values()].filter((turn) => turn.req.projectDir).map((turn) => ({ threadId: turn.req.threadId, dir: turn.cwd }))
  }

  isWorkspaceBusy(threadId: string, root: string): boolean {
    return [...this.turns.values()].some((turn) => {
      if (turn.req.threadId === threadId) return true
      try {
        const cwd = realpathSync(turn.cwd)
        return isInside(root, cwd) || isInside(cwd, root)
      } catch {
        return false
      }
    })
  }

  async stopAndWait(threadId: string): Promise<void> {
    const turn = this.turns.get(threadId)
    if (!turn) return
    this.stop(threadId)
    await turn.done
  }

  stop(threadId: string): void {
    const turn = this.turns.get(threadId)
    if (!turn) return
    turn.stopped = true
    if (turn.current) turn.current.kill()
    else this.end(turn, 'stopped')
  }

  resume(threadId: string, turnId: string, action: 'retry' | 'skip' | 'stop'): void {
    const turn = this.turns.get(threadId)
    if (!turn || turn.req.turnId !== turnId || !turn.paused) return
    const { reviewIdx } = turn.paused
    turn.paused = null
    if (action === 'stop') return this.end(turn, 'stopped')
    if (action === 'retry') {
      turn.retryBudget += MAX_RETRIES
      this.requeueRetry(turn, reviewIdx, turn.steps[reviewIdx].feedback ?? '')
    }
    turn.idx = reviewIdx + 1
    void this.next(turn)
  }

  // ---- internals ---------------------------------------------------------------------------

  private add(turn: Turn, s: Omit<Step, 'id' | 'n' | 'review' | 'retry' | 'feedback' | 'status' | 'text' | 'outputs'> & { retry?: number; feedback?: string | null; review?: boolean }, at?: number): Step {
    const step: Step = {
      id: uid(),
      n: ++turn.counter,
      review: s.review ?? (s.kind !== 'summary' && s.kind !== 'own' && REVIEW_RE.test(s.task)),
      retry: s.retry ?? 0,
      feedback: s.feedback ?? null,
      status: 'queued',
      text: '',
      outputs: [],
      ...s
    } as Step
    if (at === undefined) turn.steps.push(step)
    else turn.steps.splice(at, 0, step)
    const cfg = getConfig(step.profileId)
    const by = step.dispatchedBy && hasProfile(step.dispatchedBy) ? getConfig(step.dispatchedBy) : null
    this.emit({
      kind: 'step-add',
      threadId: turn.req.threadId,
      turnId: turn.req.turnId,
      stepId: step.id,
      profileId: step.profileId,
      name: cfg.name,
      profileKind: cfg.kind,
      model: step.model || cfg.defaultModel || null,
      dispatchedBy: by ? { profileId: by.id, name: by.name, profileKind: by.kind } : null,
      retry: step.retry,
      review: step.review,
      after: at === undefined ? null : (turn.steps[at - 1]?.id ?? null)
    })
    return step
  }

  private writeTask(turn: Turn): void {
    const task = {
      turnId: turn.req.turnId,
      threadId: turn.req.threadId,
      cwd: turn.cwd,
      userText: turn.req.text,
      attachments: turn.attachments,
      outputsDir: turn.outDir,
      steps: turn.steps.map((s) => ({
        n: s.n,
        account: getConfig(s.profileId).name,
        profileId: s.profileId,
        model: s.model,
        kind: s.kind,
        task: s.task,
        review: s.review,
        retry: s.retry,
        status: s.status,
        output: s.status === 'done' ? `step-${s.n}.md` : null,
        files: s.outputs
      }))
    }
    try {
      writeFileSync(join(turn.runDir, 'task.json'), JSON.stringify(task, null, 2))
    } catch {
      /* project dir may have become read-only */
    }
  }

  private end(turn: Turn, status: 'done' | 'stopped' | 'error'): void {
    if (turn.ending || this.turns.get(turn.req.threadId) !== turn) return
    this.writeTask(turn)
    turn.ending = turn.checkpoint
      .then(() => this.checkpoints.finish(turn.req.threadId, turn.req.turnId))
      .catch(() => {})
      .then(() => {
        this.turns.delete(turn.req.threadId)
        turn.resolveDone()
        this.emit({ kind: 'turn-end', threadId: turn.req.threadId, turnId: turn.req.turnId, status })
      })
  }

  private requeueRetry(turn: Turn, reviewIdx: number, reason: string): void {
    const review = turn.steps[reviewIdx]
    // the step being reviewed: nearest earlier non-review, non-summary step
    let prevIdx = reviewIdx - 1
    while (prevIdx >= 0 && (turn.steps[prevIdx].review || turn.steps[prevIdx].kind === 'summary')) prevIdx--
    if (prevIdx < 0) return
    const prev = turn.steps[prevIdx]
    const retry = review.retry + 1
    this.add(turn, { profileId: prev.profileId, model: prev.model, task: prev.task, kind: prev.kind === 'own' ? 'mention' : prev.kind, dispatchedBy: prev.dispatchedBy, allowDispatch: false, retry, feedback: reason, review: false }, reviewIdx + 1)
    this.add(turn, { profileId: review.profileId, model: review.model, task: review.task, kind: review.kind, dispatchedBy: review.dispatchedBy, allowDispatch: false, retry, review: true }, reviewIdx + 2)
  }

  /**
   * Engines that get the system text inlined into the user message (codex, reasonix, agy -p) keep it
   * in their session history. Per resumed session: the fixed part it already holds, and how many
   * turns ago it was sent (resent now and then: context compaction may have dropped it).
   */
  private sentSystem = new Map<string, { fixed: string; turns: number }>()

  private prompt(turn: Turn, step: Step, recap: string, resuming: boolean): StepPrompt {
    const cfg = getConfig(step.profileId)
    const caps = getProviderCapabilities(cfg.kind)
    const rel = (p: string): string => relative(turn.cwd, p) || '.'
    const permStyle = caps.permissionPromptStyle
    const interactiveAcp = caps.supportsInteractiveTransport && cfg.agyTransport === 'acp'
    const sys: string[] = [
      `你在 AgentSwitch 中工作：一个把多个 AI 模型放进同一对话协作的桌面应用。你的身份：${cfg.name}（${KIND_LABEL[cfg.kind]} · ${modelText(cfg, step.model)}）。`,
      `项目目录（当前工作目录）：${turn.cwd}`,
      '每轮的交接目录、产出目录和回复语言见用户消息末尾的「本轮环境」。',
      cfg.autoApprove === 'full'
        ? (permStyle === 'reasonix'
          ? '当前授权：Reasonix 跳过权限审批，命令仍遵循 Reasonix 自身的沙箱设置。'
          : '当前授权：完全放行，可以执行命令。')
        : cfg.autoApprove === 'cli'
          ? (permStyle === 'reasonix'
            ? '当前授权：沿用 Reasonix 自身的权限设置。无交互模式下遇到权限拒绝时，请说明原因。'
            : '当前授权：沿用 CLI 自身的权限设置（与用户在终端中使用时相同），可以按需执行命令；被拒绝的操作说明原因，让用户决定。')
          : permStyle === 'reasonix'
          ? '当前授权：Reasonix acceptEdits 模式会自动允许文件编辑，其他操作仍受 Reasonix 权限规则约束。无交互模式下遇到权限拒绝时，请说明原因。'
          : permStyle === 'workspace-sandbox'
          ? '当前授权：沙箱模式（workspace-write）。可以正常执行命令和读写项目内文件；沙箱内不能写项目以外的位置，也不能联网。'
          : interactiveAcp
          ? '当前授权：项目内的文件读写会自动允许；执行 shell 命令或修改项目以外的文件时，会在对话里请求用户确认。需要时可以直接调用命令工具，用户会在界面上允许或拒绝；被拒绝时说明原因，不要反复重试。'
          : '当前授权：只能读写项目内的文件，执行 shell 命令会被自动拒绝。请直接用文件读取 / 查看 / 编辑工具完成任务（图片可以直接用读取工具查看）；确实需要执行命令时，说明需要执行什么，让用户决定。'
    ]
    if (step.allowDispatch) {
      // the thread's participants with their defaults only: accounts and models @-named this turn
      // are listed in the prompt (「用户点名的协作者」), keeping this part the same every turn
      const others = turn.req.participants.filter((p) => p !== step.profileId && hasProfile(p)).map((p) => getConfig(p))
      sys.push(
        '',
        '## 可调度的其他参与模型',
        ...others.map((o) => `- account: "${o.id}" · ${o.name}（${KIND_LABEL[o.kind]}，默认子模型 ${o.defaultModel || 'CLI 默认'}）`),
        '仅当用户明确要求多模型协作、或任务明显需要其他参与模型配合时才调度；普通单轮问答直接回复即可。',
        '调度方法：先简要说明你的安排，然后在回复最后输出一个代码块（系统会按顺序执行，再把结果交回给你汇总）：',
        '```agentswitch:dispatch',
        '[{"account": "<account>", "model": "<可选子模型>", "task": "<交给它的具体任务>"}]',
        '```'
      )
    }

    const turnLines = [
      `本轮交接目录：${rel(turn.runDir)}/（task.json、用户附件、前序步骤的完整输出都在这里，可按需读取）。`,
      `如果你生成了新文件（尤其是图片等素材），请保存到 ${rel(turn.outDir)}/ 下，并在回复中用相对路径引用，图片用 Markdown 图片语法，例如 ![说明](${rel(turn.outDir)}/name.png)。`,
      replyLanguage(turn.req.text)
    ]
    const parts: string[] = []
    if (recap) parts.push(resuming ? '## 你上次回复之后的对话（节选）' : '## 之前的对话（节选）', recap, '')
    if (turn.req.mode === 'handoff') {
      const to = turn.req.handoffTo && hasProfile(turn.req.handoffTo) ? getConfig(turn.req.handoffTo).name : '另一个模型'
      parts.push('## 用户消息', turn.req.text, '', '## 你的任务', handoffPrompt(to))
      return stepPrompt(parts, sys, turnLines)
    }
    if (turn.req.handoffDoc) {
      let doc = ''
      try {
        doc = readFileSync(turn.req.handoffDoc, 'utf8')
      } catch {
        /* missing: path is still given */
      }
      if (doc.length > HANDOFF_DOC_CHARS) doc = doc.slice(0, HANDOFF_DOC_CHARS) + '\n…（已截断，完整内容见文件）'
      parts.push(`## 交接文档（前一个模型写给你的，文件：${turn.req.handoffDoc}）`, doc || '（文件读取失败，请自行打开上面的路径）', '', '请先阅读交接文档，在此基础上继续。', '')
    }
    if (turn.attachments.length) parts.push('## 用户附件（绝对路径，可直接读取查看）', ...turn.attachments.map((p) => `- ${p}`), '')
    const prev = turn.steps.slice(0, turn.steps.indexOf(step)).filter((s) => s.status === 'done')
    if (prev.length) {
      parts.push('## 本轮前序步骤的结果')
      for (const s of prev) {
        const c = getConfig(s.profileId)
        const txt = stripMarks(s.text)
        const body = txt.length > PREV_STEP_CHARS ? txt.slice(0, PREV_STEP_CHARS) + `\n…（已截断，完整内容见 ${rel(join(turn.runDir, `step-${s.n}.md`))}）` : txt
        parts.push(`### 第 ${s.n} 步 · ${c.name}（${modelText(c, s.model)}）${s.task && s.kind !== 'own' ? `：${s.task}` : ''}`, body || '（无文字输出）')
        if (s.outputs.length) parts.push('产出文件：', ...s.outputs.map((p) => `- ${rel(p)}`))
        parts.push('')
      }
    }
    if (turn.req.quote?.excerpt) {
      const quoted = turn.req.quote.excerpt
        .split(/\r?\n/)
        .map((line) => `> ${line}`)
        .join('\n')
      parts.push(`## 引用的消息（来自 ${turn.req.quote.author}）`, quoted, '')
    }
    if (step.kind === 'own') {
      parts.push('## 用户消息', turn.req.text)
      if (step.allowDispatch && turn.named.length)
        parts.push(
          '',
          '## 用户点名的协作者',
          ...turn.named.map((r) => {
            const c = getConfig(r.profileId)
            return `- account: "${c.id}" · ${c.name}${r.model ? `（指定子模型：${r.model}，调度时请在 model 字段填写它）` : ''}`
          }),
          '用户在消息中指定了上述协作者。请按用户描述的顺序推进：先完成由你负责的前置部分（例如写提示词、拆解需求、准备材料），再在回复最后用 agentswitch:dispatch 把需要对方完成的具体任务派发出去（任务要写清楚、可直接执行，带上你准备好的内容或文件路径）；用户要求的后续步骤（例如审核、修改、导入项目）不要派给对方——对方完成后，系统会把结果交回给你，由你继续完成。'
        )
    } else if (step.kind === 'summary')
      parts.push(
        '## 用户原始消息',
        turn.req.text,
        '',
        '## 你的任务',
        '以上是本轮其他模型的结果，现在轮到你收尾。如果用户的要求里还有由你负责的后续步骤（例如审核产出、修改文件、导入或落盘到项目中），请先实际完成这些操作（可以读写文件、按授权执行命令）；产出不合格时可以自己修正。完成后用简短几行向用户汇总结论和最终文件位置；不要重复全文，不要再调度。'
      )
    else parts.push('## 用户原始消息', turn.req.text, '', '## 你的任务', step.task)
    if (step.feedback) parts.push('', `## 验收打回意见（第 ${step.retry} 次重做）`, step.feedback, '请据此修改你的产出。')
    // replies the user reads as the answer: hidden title / next-step markers (the UI strips them)
    if (step.kind === 'own' || step.kind === 'summary')
      parts.push(
        '',
        '## 回复末尾的隐藏标记（界面会自动隐藏，正文中不要提及）',
        '在回复的最后另起一行输出（如果本条回复输出了 agentswitch:dispatch 调度代码块，则不要输出这些标记）：',
        ...(turn.req.wantTitle ? [`<!-- agentswitch:title:对话标题 -->（概括本次对话主题，不加引号；${titleLanguage(turn.req.text)}）`] : []),
        '<!-- agentswitch:next:建议用户下一步发送的一句话 -->（可选：站在用户角度，结合任务完成情况给出自然、简洁、可直接发送的下一步指令或追问；没有合适建议就省略这一行）'
      )
    if (step.review)
      parts.push(
        '',
        '## 验收输出格式',
        '完成检查后，在回复最后单独输出一个 json 代码块：',
        '```json',
        '{"status": "PASS 或 REJECT", "reason": "简短理由"}',
        '```'
      )
    // the prompt above is Chinese: restate the language last, where models weigh it most
    const tail = userLanguage(turn.req.text) === 'en' ? ['', 'Language: the user writes in English. Reply in English.'] : []
    return stepPrompt(parts, sys, turnLines, tail)
  }

  private async next(turn: Turn): Promise<void> {
    if (turn.ending) return
    if (turn.stopped) return this.end(turn, 'stopped')
    const step = turn.steps[turn.idx]
    if (!step) return this.end(turn, 'done')
    if (!hasProfile(step.profileId)) {
      step.status = 'error'
      this.emit({ kind: 'step-end', threadId: turn.req.threadId, turnId: turn.req.turnId, stepId: step.id, status: 'error' })
      return this.end(turn, 'error')
    }
    const cfg = getConfig(step.profileId)
    const ids = { threadId: turn.req.threadId, turnId: turn.req.turnId, stepId: step.id }
    step.status = 'running'
    this.writeTask(turn)
    this.emit({ kind: 'step-start', ...ids })
    this.busy.set(cfg.id, (this.busy.get(cfg.id) ?? 0) + 1)
    this.onState()

    const before = snapshot(turn.cwd, [turn.outDir])
    const baseline = new FileBaseline(turn.cwd)
    const reported = new Set<string>()
    const written = new Set<string>()
    const { transcript, threadId, sessionScope } = turn.req
    const model = step.model || cfg.defaultModel || null
    const sessions = loadSessions(threadId)
    const previousDriver = [...transcript].reverse().find((entry) => entry.driverId)?.driverId
    const ranThisTurn = turn.steps.slice(0, turn.idx).some((previous) => previous.profileId === cfg.id && previous.status === 'done')
    const takingOver = cfg.id === turn.req.driver.profileId && !!previousDriver && previousDriver !== cfg.id && !ranThisTurn
    const resume = sessions.scope === sessionScope ? canResume(sessions, cfg.id, cfg.kind, model, transcript, takingOver) : null
    const numberedTranscript = numberTranscript(transcript)
    const entries = unseenTranscript(numberedTranscript, cfg.id, !!resume)
    const caps = getProviderCapabilities(cfg.kind)
    const budget = contextBudgetFor(reportedContextWindow(transcript, cfg.id, model, cfg.kind) ?? defaultContextWindowFor(cfg.kind, model))
    let recap = budgetedHandoff(entries, budget, !resume, supportsThreadHistory(cfg.kind))
    let history: ReturnType<typeof createThreadHistory> | undefined
    if (recap.readable) {
      try {
        history = createThreadHistory(threadId, transcript)
      } catch (error) {
        this.log(cfg.id, `[thread history] ${String(error)}\n`)
        recap = budgetedHandoff(entries, budget, !resume, false)
      }
    }
    const { prompt, system: fixed } = this.prompt(turn, step, recap.text, !!resume)
    const inline = usesInlineSystemPrompt(cfg.kind, cfg.agyTransport)
    const sent = inline && resume ? this.sentSystem.get(resume) : undefined
    // the resumed session already holds the fixed instructions (this turn's lines are in the prompt)
    const compact = !!sent && sent.fixed === fixed && sent.turns < SYSTEM_RESEND_TURNS
    const system = compact ? null : fixed
    let stepUsage: Usage | null = null
    const allowNativeTitle = turn.req.wantTitle === true && (step.kind === 'own' || step.kind === 'summary')
    const emit = (event: AgentEvent): void => {
      if (event.t === 'quota') return recordQuota(cfg.id, event.quota, 'claude-stream')
      if (event.t === 'title' && !allowNativeTitle) return
      if (event.t === 'usage') stepUsage = { ...(stepUsage ?? {}), ...event.usage }
      if (event.t === 'text') step.text += event.delta
      if (event.t === 'output' || (event.t === 'activity' && event.type === 'write')) {
        const p = event.t === 'output' ? event.path : event.target
        const abs = isAbsolute(p) ? p : join(turn.cwd, p)
        if (event.t === 'activity') {
          written.add(abs)
          // finished edits without a CLI-supplied patch: diff against the pre-step baseline
          if (event.status !== 'running') {
            if (event.detail?.diff) baseline.touch(abs)
            else {
              const diff = baseline.diff(abs)
              if (diff) event = { ...event, detail: { ...event.detail, diff } }
            }
          }
        }
        if (event.t === 'output') {
          if (reported.has(abs)) return
          reported.add(abs)
          step.outputs.push(abs)
          return this.emit({ kind: 'agent', ...ids, event: { t: 'output', path: abs } })
        }
      }
      if (event.t === 'rate_limited') {
        recordLimited(cfg.id)
        this.rateLimited.add(cfg.id)
        this.onState()
      }
      this.emit({ kind: 'agent', ...ids, event })
    }

    const handle = runAgent(
      {
        ref: ids,
        cfg,
        model,
        prompt,
        freshPrompt: resume && caps.supportsInteractiveTransport && cfg.agyTransport === 'acp' ? () => {
          const freshEntries = unseenTranscript(numberedTranscript, cfg.id, false)
          const freshRecap = budgetedHandoff(freshEntries, budget, true, supportsThreadHistory(cfg.kind))
          return this.prompt(turn, step, freshRecap.text, false).prompt
        } : undefined,
        system,
        cwd: turn.cwd,
        images: caps.supportsImageInput ? turn.attachments.filter((p) => /\.(png|jpe?g|gif|webp)$/i.test(p)) : [],
        resume,
        outDir: turn.outDir,
        threadHistory: history?.config
      },
      emit,
      (text) => this.log(cfg.id, text)
    )
    turn.current = handle
    const r = await handle.done.finally(() => {
      try {
        history?.dispose()
      } catch (error) {
        this.log(cfg.id, `[thread history] ${String(error)}\n`)
      }
    })
    turn.current = null
    this.busy.set(cfg.id, Math.max(0, (this.busy.get(cfg.id) ?? 1) - 1))
    if (r.ok) this.rateLimited.delete(cfg.id)
    this.onState()
    // usage & quota bookkeeping never blocks the turn
    try {
      if (stepUsage || r.ok) recordRun(cfg.id, r.model || step.model || cfg.defaultModel || null, stepUsage)
      if (caps.supportsUsageQuota) refreshPostRunQuota(cfg, r.ok)
    } catch (e) {
      this.log(cfg.id, `[usage] ${String(e)}\n`)
    }
    if (r.sessionId) {
      saveSession(threadId, cfg.id, r.sessionId, r.ok && !r.stopped && !turn.stopped
        ? { scope: sessionScope, model: historyModel(model, cfg.kind) }
        : { unconfirmed: true })
    }
    if (inline && r.ok && r.sessionId) this.sentSystem.set(r.sessionId, compact && sent ? { fixed, turns: sent.turns + 1 } : { fixed, turns: 0 })

    // files changed on disk but not reported by the CLI's own events
    const after = snapshot(turn.cwd, [turn.outDir])
    let extra = 0
    for (const [p, sig] of after) {
      if (before.get(p) === sig || reported.has(p) || extra >= 30) continue
      extra++
      if (!written.has(p)) emit({ t: 'activity', type: 'write', target: relative(turn.cwd, p), status: 'done', detail: { tool: t('main.diskDetect') } })
      emit({ t: 'output', path: p })
    }

    try {
      writeFileSync(join(turn.runDir, `step-${step.n}.md`), stripMarks(step.text))
      writeFileSync(join(turn.runDir, `step-${step.n}.files.json`), JSON.stringify(step.outputs, null, 2))
    } catch {
      /* ignore */
    }

    if (r.stopped || turn.stopped) {
      step.status = 'stopped'
      this.emit({ kind: 'step-end', ...ids, status: 'stopped' })
      return this.end(turn, 'stopped')
    }
    if (!r.ok) {
      step.status = 'error'
      if (r.error) this.emit({ kind: 'agent', ...ids, event: { t: 'error', message: r.error } })
      this.emit({ kind: 'step-end', ...ids, status: 'error' })
      if (turn.req.mode === 'handoff')
        this.emit({ kind: 'handoff', threadId: turn.req.threadId, turnId: turn.req.turnId, path: '', to: turn.req.handoffTo ?? step.profileId, ok: false, error: r.rateLimited ? 'rate_limited' : (r.error ?? t('chat.genFailed')) })
      return this.end(turn, 'error')
    }

    step.status = 'done'
    if (turn.req.mode === 'handoff') {
      const to = turn.req.handoffTo ?? step.profileId
      try {
        const dir = join(turn.cwd, '.agentswitch', 'handoffs')
        mkdirSync(dir, { recursive: true })
        const file = join(dir, `${turn.req.turnId.replace(/[^\w-]/g, '')}.md`)
        writeFileSync(file, stripMarks(step.text).trim() + '\n')
        this.emit({ kind: 'handoff', threadId: turn.req.threadId, turnId: turn.req.turnId, path: file, to, ok: true })
      } catch (e) {
        this.emit({ kind: 'handoff', threadId: turn.req.threadId, turnId: turn.req.turnId, path: '', to, ok: false, error: String(e) })
      }
    }
    const verdict = step.review ? verdictOf(step.text) : null
    if (step.review && !verdict) this.emit({ kind: 'agent', ...ids, event: { t: 'notice', message: t('main.noVerdict') } })
    this.emit({ kind: 'step-end', ...ids, status: 'done', verdict: verdict ?? undefined })

    if (verdict?.status === 'REJECT') {
      step.feedback = verdict.reason
      const used = step.retry
      if (used < turn.retryBudget) this.requeueRetry(turn, turn.idx, verdict.reason)
      else {
        const reason = t('main.rejectedN', { n: used + 1, reason: verdict.reason })
        turn.paused = { reviewIdx: turn.idx, reason }
        this.writeTask(turn)
        this.emit({ kind: 'paused', threadId: turn.req.threadId, turnId: turn.req.turnId, reason })
        return
      }
    }

    if (step.allowDispatch) {
      const items = dispatchOf(step.text)
        .map((d) => {
          const id = this.dispatchable(turn, step.profileId).find((p) => p === d.account || getConfig(p).name === d.account)
          // the sub-model the user asked for (@B(model)) unless the driver chose one
          return id ? { id, model: d.model?.trim() || turn.named.find((r) => r.profileId === id)?.model || null, task: d.task.trim() } : null
        })
        .filter((x): x is { id: string; model: string | null; task: string } => !!x)
        .slice(0, MAX_DISPATCH)
      if (items.length) {
        let at = turn.idx + 1
        for (const d of items)
          this.add(turn, { profileId: d.id, model: d.model, task: d.task, kind: 'dispatch', dispatchedBy: step.profileId, allowDispatch: false }, at++)
        this.add(turn, { profileId: step.profileId, model: step.model, task: '', kind: 'summary', dispatchedBy: null, allowDispatch: false }, at)
      }
    }

    this.writeTask(turn)
    turn.idx++
    void this.next(turn)
  }

  /** Who a step may dispatch to: this turn's participants plus anyone the user @-named. */
  private dispatchable(turn: Turn, self: ProfileId): ProfileId[] {
    return [...new Set([...turn.req.participants, ...turn.named.map((r) => r.profileId)])].filter((p) => p !== self && hasProfile(p))
  }

  stopAll(): void {
    for (const id of [...this.turns.keys()]) this.stop(id)
  }
}
