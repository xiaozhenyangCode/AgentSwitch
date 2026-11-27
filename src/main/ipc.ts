import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import {
  IPC,
  KINDS,
  REASONIX_MODELS,
  installSessionId,
  kindOfInstallSession,
  type AppInfo,
  type CliUpdateSource,
  type KindConfig,
  type KindState,
  type ProfileConfig,
  type ProfileConnect,
  type ReasonixModel,
  type ProfileId,
  type ProfileKind,
  type PtyMode,
  type SessionId,
  type Snapshot,
  type StartPtyRequest
} from '@shared/types'
import {
  KIND_LABEL,
  addProfile,
  addReasonixProfile,
  buildInstallSpec,
  buildSpawnSpec,
  claudeDirs,
  cliVersion,
  clearIsolatedCredentials,
  clearProfileKeychainCache,
  envPreview,
  expandHome,
  getConfig,
  getKindConfig,
  firstRun,
  getState,
  hasProfile,
  installCommand,
  invalidateCliPathCache,
  invalidateCliVersionCache,
  isApiKeyAccount,
  missingInstallTool,
  isLoggedIn,
  kindBinaryPath,
  listConfigs,
  loginSignature,
  removeProfile,
  resolveProfileDir,
  reasonixCanImport,
  resetKindConfig,
  resetProfile,
  setReasonixKey,
  updateKindConfig,
  updateProfile
} from './profiles'
import { canRevealExtFile, extOverview, listMcp, listSkills, prepareRuleTarget, readExtFile, writeRuleFile } from './extensions'
import { readSettings, writeSettings } from './appSettings'
import { t } from './i18n'
import { secrets } from './secrets'
import { permissions } from './acp/permissions'
import { agyAcpPool } from './acp/pool'
import { ptyModeAllowed } from './apiKey'
import { ChatStore } from './chatStore'
import { createCliUpdateHandler } from './cliUpdate'
import type { ApiKeyConfig } from '@shared/types'

function assertConnect(kind: ProfileKind, v: unknown): ProfileConnect {
  if (kind === 'reasonix') {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(t('reasonix.badConnection'))
    const o = v as Record<string, unknown>
    if (o.reasonix === 'import' && Object.keys(o).length === 1) return { reasonix: 'import' }
    if (o.reasonix === 'managed' && Object.keys(o).length === 3 && typeof o.key === 'string' &&
      typeof o.defaultModel === 'string' && REASONIX_MODELS.some((m) => m === o.defaultModel))
      return { reasonix: 'managed', key: o.key, defaultModel: o.defaultModel as ReasonixModel }
    throw new Error(t('reasonix.badConnection'))
  }
  const o = v as { apiKey?: Partial<ApiKeyConfig>; key?: unknown }
  const a = o?.apiKey
  if (!a || typeof a !== 'object' || typeof a.provider !== 'string') throw new Error(t('apikey.badProvider'))
  return {
    apiKey: {
      provider: a.provider as ApiKeyConfig['provider'],
      baseUrl: typeof a.baseUrl === 'string' ? a.baseUrl : undefined,
      models: Array.isArray(a.models) ? a.models.filter((m): m is string => typeof m === 'string') : undefined
    },
    key: typeof o.key === 'string' ? o.key : ''
  }
}

/** SecretStore throws i18n codes; never includes the key itself. */
function keyError(e: unknown): Error {
  const code = e instanceof Error ? e.message : ''
  return new Error(code.startsWith('apikey.') ? t(code as Parameters<typeof t>[0]) : t('apikey.noKeychain'))
}
import { PtyManager } from './ptyManager'
import { Orchestrator, importSession, threadCwd } from './orchestrator'
import { cwdExists, historyStat, listHistory, openHistory, writeHandoff } from './history'
import { deleteThreadData, trashHistorySession } from './threadDelete'
import { clearAccountUsageCache, onUsageChange, pauseAccountQuota, refreshAccountQuota, refreshUsage, setCustomPrice, syncPrices, snapshot as usageSnapshot, startUsage } from './usage'
import { onRequestLogChange, queryRequestLogs } from './requestLog'
import { forgetModels, forgetModelsByKind, listModels, refreshModelsByKind } from './models'
import { gitChanges, gitCommitDetail, gitStashDetail } from './gitChanges'
import { clearGitCommandLog, gitCommandLog, gitConflictFile, gitGraph, gitLog, gitMutate, gitRemotes, gitStashes, gitStatus, gitTags } from './gitOps'
import { invalidateFileIndex, searchProjectFiles } from './fileSearch'
import { allowFile, allowRoot, attachmentsDir, isAllowedEditorAttachment, isAllowedEditorWorkspace, isAllowedPath } from './fileProtocol'
import { EditorFileWatcher, readEditorFile, resolveAuthorizedEditorPath, saveEditorFile } from './editorFiles'
import type { EditorActionResult, EditorReadRequest, EditorSaveRequest, EditorWatchRequest } from '@shared/editor'
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { AttachmentText, FileSearchRequest, OnboardingState, RunRequest } from '@shared/types'
import { findOnPath, getBaseEnv, realHome, refreshRuntimePaths, shellEnvStatus } from './shellEnv'
import { cliNodeRuntime } from './runtime'
import { isTranscriptEntry } from '@shared/transcript'
import type { CommitImportRequest, ThreadBundle } from '@shared/transfer'
import { commitThreadsImport, exportThreadsArchive, inspectThreadsImport } from './threadTransfer'

const assertId = (x: unknown): ProfileId => {
  if (!hasProfile(x)) throw new Error(`unknown account: ${String(x)}`)
  return x
}
const assertKind = (x: unknown): ProfileKind => {
  if (!KINDS.includes(x as ProfileKind)) throw new Error(`bad kind ${String(x)}`)
  return x as ProfileKind
}
const isTermSession = (x: unknown): x is SessionId => typeof x === 'string' && /^term:\d+$/.test(x)
const isSessionId = (x: unknown): x is SessionId => hasProfile(x) || isTermSession(x) || (typeof x === 'string' && kindOfInstallSession(x) !== null)
const PROFILE_MODES: PtyMode[] = ['login', 'run', 'test', 'shell']

const LOGIN_POLL_MS = 1200
/** After success, give the CLI a moment to finish writing before killing its TUI. */
const LOGIN_KILL_DELAY_MS = 1500

const STAGE_MAX = 50 * 1024 * 1024

export function registerIpc(getWindow: () => BrowserWindow | null): {
  ptys: PtyManager
  orchestrator: Orchestrator
  editorWatcher: EditorFileWatcher
  broadcastAll: () => void
} {
  const send = (channel: string, payload: unknown): void => {
    const w = getWindow()
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload)
  }

  // ---- state snapshot ---------------------------------------------------------
  const snapshot = (): Snapshot => {
    const kinds: KindState[] = KINDS.map((k) => ({
      ...getKindConfig(k),
      binaryPath: kindBinaryPath(k),
      installing: ptys.sessionMode(installSessionId(k)) !== null
    }))
    const byKind = new Map(kinds.map((k) => [k.kind, k]))
    const profiles = listConfigs().map((cfg) => {
      const k = byKind.get(cfg.kind)!
      const mode = ptys.sessionMode(cfg.id) ?? (orchestrator.isRunning(cfg.id) ? 'run' : null)
      return getState(cfg, k.binaryPath, mode, ptys.isRateLimited(cfg.id) || orchestrator.rateLimited.has(cfg.id), k.installing)
    })
    return { kinds, profiles }
  }
  // coalesce bursts (e.g. several pty state changes in one tick)
  let pending: NodeJS.Timeout | null = null
  const broadcast = (): void => {
    if (pending) return
    pending = setTimeout(() => {
      pending = null
      send(IPC.stateChanged, snapshot())
    }, 30)
  }

  const termDirs = new Map<SessionId, string>()
  const installSources = new Map<ProfileKind, Extract<CliUpdateSource, 'install' | 'update'>>()
  const sessionLabel = (id: SessionId): string => {
    const k = kindOfInstallSession(id)
    if (k) return t('main.installSession', { name: KIND_LABEL[k] })
    if (id.startsWith('term:')) {
      const d = termDirs.get(id)
      if (!d || d === realHome) return '~'
      return basename(d) || d
    }
    if (id.startsWith('run:')) {
      const pid = id.slice(4)
      return t('main.runSession', { name: hasProfile(pid) ? getConfig(pid).name : pid })
    }
    return hasProfile(id) ? getConfig(id).name : id
  }

  const ptys = new PtyManager({
    onData: (e) => send(IPC.ptyData, e),
    onExit: (e) => {
      const installKind = kindOfInstallSession(e.sessionId)
      if (installKind) {
        const source = installSources.get(installKind) ?? 'install'
        installSources.delete(installKind)
        refreshRuntimePaths()
        if (e.exitCode === 0 && kindBinaryPath(installKind)) void onCliUpdated(installKind, { source })
      }
      if (e.mode === 'login') finishLogin(e.sessionId, e.exitCode === 0)
      send(IPC.ptyExit, e)
    },
    onUrl: (e) => send(IPC.ptyUrl, e),
    onStateChange: () => broadcast()
  })

  const orchestrator = new Orchestrator(
    (e) => {
      send(IPC.chatEvent, e)
      if (e.kind === 'agent' && e.event.t === 'permission') {
        const window = getWindow()
        if (!window || window.isDestroyed() || !window.isFocused()) app.dock?.bounce('informational')
      }
    },
    (pid, text) => ptys.log(`run:${pid}`, text),
    () => broadcast()
  )
  const onCliUpdated = createCliUpdateHandler({
    invalidateCliPathCache,
    invalidateCliVersionCache,
    kindBinaryPath,
    probeCliVersion: (kind) => cliVersion(kind, true),
    retireAgyAcpOnCliUpdate: () => agyAcpPool.retireOnCliUpdate(),
    listProfiles: listConfigs,
    isProfileRunning: (id) => {
      const mode = ptys.sessionMode(id)
      return orchestrator.isRunning(id) || mode === 'run' || mode === 'test' || agyAcpPool.hasActive(id)
    },
    forgetModelsByKind,
    refreshModelsByKind,
    broadcastState: () => send(IPC.stateChanged, snapshot()),
    broadcastCliUpdated: (event) => send(IPC.cliUpdated, event)
  })

  // ---- login success watcher ----------------------------------------------------
  const loginWatchers = new Map<ProfileId, { before: string; timer: NodeJS.Timeout; verified: boolean }>()
  const stopWatch = (id: ProfileId): void => {
    const watch = loginWatchers.get(id)
    if (watch) clearTimeout(watch.timer)
    loginWatchers.delete(id)
    pauseAccountQuota(id, false)
  }
  const loginChanged = (id: ProfileId, before: string): boolean =>
    hasProfile(id) && loginSignature(id) !== before && isLoggedIn(id)

  const finishLogin = (id: ProfileId, exitedSuccessfully: boolean): void => {
    const watch = loginWatchers.get(id)
    if (!watch) return
    stopWatch(id)
    if ((!watch.verified && !exitedSuccessfully) || !loginChanged(id, watch.before)) return
    clearProfileKeychainCache(resolveProfileDir(getConfig(id)))
    agyAcpPool.retire(id)
    orchestrator.rateLimited.delete(id)
    forgetModels(id)
    void refreshAccountQuota(id).catch((err) => console.warn('[usage] refreshing account quota failed', err))
    send(IPC.loginSuccess, { profileId: id })
    broadcast()
  }

  const watchLogin = (id: ProfileId, before: string): void => {
    const timer = setInterval(() => {
      const watch = loginWatchers.get(id)
      if (!watch || !loginChanged(id, before)) return
      clearInterval(timer)
      watch.verified = true
      watch.timer = setTimeout(() => ptys.kill(id), LOGIN_KILL_DELAY_MS)
    }, LOGIN_POLL_MS)
    loginWatchers.set(id, { before, timer, verified: false })
  }

  // ---- accounts -------------------------------------------------------------------
  ipcMain.handle(IPC.stateGet, () => snapshot())
  ipcMain.handle(IPC.reasonixCanImport, () => reasonixCanImport())
  ipcMain.handle(IPC.profilesAdd, (_e, kind: unknown, name?: string, connect?: unknown) => {
    const k = assertKind(kind)
    const conn = k !== 'reasonix' && (connect === undefined || connect === null) ? null : assertConnect(k, connect)
    const label = typeof name === 'string' ? name : undefined
    if (conn && 'reasonix' in conn) {
      const p = addReasonixProfile(label, conn)
      broadcast()
      return p.id
    }
    const p = addProfile(k, label, conn?.apiKey)
    if (conn) {
      try {
        secrets().set(p.id, conn.key)
      } catch (e) {
        removeProfile(p.id) // no half-created account
        throw keyError(e)
      }
    }
    broadcast()
    return p.id
  })
  ipcMain.handle(IPC.profilesSetKey, (_e, id: unknown, key: unknown) => {
    const pid = assertId(id)
    const cfg = getConfig(pid)
    const value = typeof key === 'string' ? key : ''
    if (cfg.kind === 'reasonix') setReasonixKey(cfg, value)
    else {
      if (!isApiKeyAccount(cfg)) throw new Error(t('apikey.notApiKeyAccount'))
      try {
        secrets().set(pid, value)
      } catch (e) {
        throw keyError(e)
      }
    }
    forgetModels(pid)
    broadcast()
  })
  ipcMain.handle(IPC.profilesUpdate, (_e, id: unknown, patch: Partial<ProfileConfig>) => {
    const pid = assertId(id)
    const before = getConfig(pid)
    const after = updateProfile(pid, patch)
    if (before.configDir !== after.configDir || JSON.stringify(before.extraEnv) !== JSON.stringify(after.extraEnv)
      || JSON.stringify(before.apiKey) !== JSON.stringify(after.apiKey)) forgetModels(pid)
    broadcast()
  })
  ipcMain.handle(IPC.profilesReset, (_e, id: unknown) => {
    const pid = assertId(id)
    resetProfile(pid)
    forgetModels(pid)
    broadcast()
  })
  ipcMain.handle(IPC.profilesRemove, (_e, id: unknown) => {
    const pid = assertId(id)
    const reasonix = getConfig(pid).kind === 'reasonix'
    stopWatch(pid)
    if (!reasonix) orchestrator.abortProfile(pid)
    ptys.forget(pid, reasonix ? undefined : 'SIGKILL')
    ptys.forget(`run:${pid}`)
    if (!reasonix) agyAcpPool.retire(pid, undefined, true)
    forgetModels(pid)
    if (!reasonix) clearAccountUsageCache(pid)
    removeProfile(pid)
    broadcast()
  })
  ipcMain.handle(IPC.profilesEnvPreview, (_e, id: unknown, mode: PtyMode) => envPreview(assertId(id), mode))

  // ---- CLIs -----------------------------------------------------------------------
  const changeKindConfig = (kind: ProfileKind, change: () => KindConfig): void => {
    const before = getKindConfig(kind).binary
    const pathBefore = kindBinaryPath(kind)
    const after = change().binary
    if (before !== after || pathBefore !== kindBinaryPath(kind)) void onCliUpdated(kind, { source: 'config' })
    broadcast()
  }
  ipcMain.handle(IPC.kindsUpdate, (_e, kind: unknown, patch: Partial<KindConfig>) => {
    const k = assertKind(kind)
    changeKindConfig(k, () => updateKindConfig(k, patch))
  })
  ipcMain.handle(IPC.kindsReset, (_e, kind: unknown) => {
    const k = assertKind(kind)
    changeKindConfig(k, () => resetKindConfig(k))
  })
  ipcMain.handle(IPC.cliVersion, (_e, kind: unknown, force?: boolean) => cliVersion(assertKind(kind), force === true))
  /** Silent install in the `install:<kind>` session (real HOME); never touches account sessions. */
  ipcMain.handle(IPC.cliInstall, (_e, kind: unknown, update = false): SessionId => {
    const k = assertKind(kind)
    const tool = missingInstallTool(k, update === true)
    if (tool) throw new Error(t('main.needNode', { tool, cmd: installCommand(k, update === true) }))
    const sid = installSessionId(k)
    const spec = buildInstallSpec(k, update === true)
    if (ptys.sessionMode(sid)) ptys.kill(sid)
    installSources.set(k, update === true ? 'update' : 'install')
    ptys.start(sid, 'install', spec, 120, 32)
    return sid
  })

  // ---- pty --------------------------------------------------------------------------
  ipcMain.handle(IPC.ptyStart, (_e, req: StartPtyRequest): SessionId => {
    const id = assertId(req.profileId)
    if (!PROFILE_MODES.includes(req.mode)) throw new Error(`bad mode ${req.mode}`)
    if (req.mode === 'test' && !req.command?.trim()) throw new Error('test mode needs a command')
    const cfg = getConfig(id)
    if (!ptyModeAllowed(cfg, req.mode)) throw new Error(t('apikey.noLogin'))
    if (req.mode === 'login') {
      stopWatch(id)
      orchestrator.abortProfile(id)
      ptys.forget(id, 'SIGKILL')
      ptys.forget(`run:${id}`)
      agyAcpPool.retire(id, undefined, true)
      forgetModels(id)
      clearAccountUsageCache(id, { keepStats: true })
      clearProfileKeychainCache(resolveProfileDir(cfg))
      clearIsolatedCredentials(cfg)
    }
    const spec = buildSpawnSpec(id, req.mode, req.command, true)
    // the chat's project folder, when it still exists
    if (typeof req.cwd === 'string' && isAbsolute(req.cwd)) {
      try {
        if (statSync(req.cwd).isDirectory()) spec.cwd = req.cwd
      } catch {
        /* moved or deleted: keep the home folder */
      }
    }
    if (req.mode === 'login') {
      const before = loginSignature(id)
      pauseAccountQuota(id, true)
      watchLogin(id, before)
    }
    ptys.start(id, req.mode, spec, req.cols, req.rows)
    return id
  })
  let termSeq = 0
  ipcMain.handle(IPC.ptyShell, (_e, cwd: unknown, cols: number, rows: number): SessionId => {
    const id: SessionId = `term:${++termSeq}`
    let dir = realHome
    if (typeof cwd === 'string' && isAbsolute(cwd)) {
      try {
        if (statSync(cwd).isDirectory()) dir = cwd
      } catch {
        /* moved or deleted: fall back to home */
      }
    }
    const shell = process.env.SHELL || '/bin/zsh'
    const env = { ...getBaseEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor' }
    termDirs.set(id, dir)
    ptys.start(id, 'shell', { shell, args: ['-i'], cwd: dir, env, injected: {} }, cols, rows)
    return id
  })
  ipcMain.on(IPC.ptyWrite, (_e, id: unknown, data: string) => isSessionId(id) && ptys.write(id, data))
  ipcMain.on(IPC.ptyResize, (_e, id: unknown, cols: number, rows: number) => isSessionId(id) && ptys.resize(id, cols, rows))
  ipcMain.handle(IPC.ptyKill, (_e, id: unknown) => {
    if (isSessionId(id)) ptys.kill(id)
  })
  ipcMain.handle(IPC.ptyBuffer, (_e, id: unknown) => ptys.getBuffer(typeof id === 'string' ? id : ''))
  ipcMain.handle(IPC.ptySessions, () => ptys.list(sessionLabel))
  ipcMain.handle(IPC.filesSearch, (_e, request: FileSearchRequest) => searchProjectFiles(request))

  const editorWatcher = new EditorFileWatcher((event) => send(IPC.editorFileChanged, event))
  const editorOptions = {
    isExtraAllowed: isAllowedEditorAttachment,
    isWorkspaceAllowed: isAllowedEditorWorkspace,
    watcher: editorWatcher
  }
  const resolveEditorRequest = (req: EditorWatchRequest) =>
    resolveAuthorizedEditorPath(req?.path, req?.workspaceDir, editorOptions.isExtraAllowed, editorOptions.isWorkspaceAllowed)
  const pendingEditorWatches = new Map<string, symbol>()

  ipcMain.handle(IPC.editorReadFile, (_e, req: EditorReadRequest) => readEditorFile(req, editorOptions))
  ipcMain.handle(IPC.editorSaveFile, (_e, req: EditorSaveRequest) => saveEditorFile(req, editorOptions))
  ipcMain.handle(IPC.editorWatchFile, async (e, req: EditorWatchRequest): Promise<EditorActionResult> => {
    const path = req?.path
    const request = Symbol()
    if (typeof path === 'string') pendingEditorWatches.set(path, request)
    const resolved = await resolveEditorRequest(req)
    const isPending = pendingEditorWatches.get(path) === request
    if (isPending) pendingEditorWatches.delete(path)
    if (!resolved.ok) return resolved
    if (!isPending || e.sender.isDestroyed() || getWindow()?.webContents !== e.sender) {
      return { ok: false, code: 'IO_ERROR', message: 'Watch request was cancelled' }
    }
    return editorWatcher.watch(path, resolved.realPath)
  })
  ipcMain.handle(IPC.editorUnwatchFile, (_e, path: unknown) => {
    if (typeof path !== 'string') return
    pendingEditorWatches.delete(path)
    editorWatcher.unwatch(path)
  })
  ipcMain.handle(IPC.editorRevealInFinder, async (_e, req: EditorWatchRequest): Promise<EditorActionResult> => {
    const resolved = await resolveEditorRequest(req)
    if (!resolved.ok) return resolved
    shell.showItemInFolder(resolved.realPath)
    return { ok: true }
  })
  ipcMain.handle(IPC.editorOpenExternal, async (_e, req: EditorWatchRequest): Promise<EditorActionResult> => {
    const resolved = await resolveEditorRequest(req)
    if (!resolved.ok) return resolved
    const error = await shell.openPath(resolved.realPath)
    return error ? { ok: false, code: 'IO_ERROR', message: error } : { ok: true }
  })
  ipcMain.handle(IPC.gitChanges, (_e, dir: unknown, split: unknown) => gitChanges(dir, split === true))
  ipcMain.handle(IPC.gitStatus, (_e, dir: unknown) => gitStatus(dir))
  ipcMain.handle(IPC.gitLog, (_e, dir: unknown, limit?: unknown) => gitLog(dir, limit))
  ipcMain.handle(IPC.gitGraph, (_e, dir: unknown, options?: unknown) => gitGraph(dir, options))
  ipcMain.handle(IPC.gitCommitDetail, (_e, dir: unknown, hash: unknown, metadataOnly: unknown) => gitCommitDetail(dir, hash, metadataOnly === true))
  ipcMain.handle(IPC.gitStashes, (_e, dir: unknown) => gitStashes(dir))
  ipcMain.handle(IPC.gitStashDetail, (_e, dir: unknown, ref: unknown) => gitStashDetail(dir, ref))
  ipcMain.handle(IPC.gitConflictFile, (_e, dir: unknown, path: unknown, repoRelative: unknown) => gitConflictFile(dir, path, repoRelative === true))
  ipcMain.handle(IPC.gitTags, (_e, dir: unknown, remote?: unknown, pushDestination?: unknown) => gitTags(dir, remote, pushDestination === true))
  ipcMain.handle(IPC.gitRemotes, (_e, dir: unknown) => gitRemotes(dir))
  ipcMain.handle(IPC.gitCommandLog, (_e, dir?: unknown) => gitCommandLog(dir))
  ipcMain.handle(IPC.gitCommandLogClear, () => clearGitCommandLog())
  ipcMain.handle(IPC.gitMutate, async (_e, dir: unknown, op: unknown) => {
    let repoRoot: string | undefined
    const result = await gitMutate(dir, op, (root) => {
      repoRoot = root
      return orchestrator.checkpoints.isRestoring(root)
    }, t('git.checkpointBusy'))
    if (repoRoot) invalidateFileIndex(repoRoot)
    return result
  })
  /** Closes a drawer tab: kills the process (if any) and drops its scrollback. */
  ipcMain.handle(IPC.ptyForget, (_e, id: unknown) => {
    if (typeof id === 'string' && id) {
      termDirs.delete(id)
      ptys.forget(id)
    }
  })

  // ---- models / chat ------------------------------------------------------------------
  ipcMain.handle(IPC.modelsList, (_e, id: unknown, refresh?: boolean) => listModels(assertId(id), refresh === true))
  const chatStore = new ChatStore(app.getPath('userData'))
  ipcMain.handle(IPC.chatStoreOpen, (_e, legacy: unknown, aliasOnly: unknown) => {
    if ((legacy !== null && typeof legacy !== 'string') || typeof aliasOnly !== 'boolean') throw new Error('bad request')
    const opened = chatStore.open(legacy, aliasOnly)
    for (const dir of new Set(opened.threads.map((thread) => thread.projectDir))) {
      if (typeof dir === 'string' && isAbsolute(dir) && cwdExists(dir)) allowRoot(dir)
    }
    return opened
  })
  ipcMain.handle(IPC.chatStoreSave, (_e, session: unknown, revision: unknown, changes: unknown) => chatStore.save(session, revision, changes))
  ipcMain.on(IPC.chatStoreFlush, (e, session: unknown, revision: unknown, changes: unknown) => {
    e.returnValue = chatStore.save(session, revision, changes)
  })
  ipcMain.handle(IPC.chatSend, (_e, req: RunRequest) => {
    if (!req || typeof req.threadId !== 'string' || typeof req.turnId !== 'string' || typeof req.text !== 'string') throw new Error('bad request')
    const attachments = Array.isArray(req.attachments) ? req.attachments.flatMap((a) => {
      if (typeof a?.path !== 'string' || !isAbsolute(a.path) || a.path.includes('\0')) return []
      return [{
        path: a.path,
        name: typeof a.name === 'string' ? a.name : basename(a.path),
        isImage: a.isImage === true,
        source: a.source === 'workspace-file' || a.source === 'chat-attachment' ? a.source : undefined,
        relativePath: typeof a.relativePath === 'string' ? a.relativePath : undefined,
        refLabel: typeof a.refLabel === 'string' ? a.refLabel : undefined,
        fallbackPath: typeof a.fallbackPath === 'string' && isAllowedPath(a.fallbackPath) ? a.fallbackPath : undefined
      }]
    }) : []
    for (const { path } of attachments) allowFile(path)
    orchestrator.start({
      threadId: req.threadId,
      turnId: req.turnId,
      projectDir: typeof req.projectDir === 'string' ? req.projectDir : null,
      text: req.text,
      attachments,
      driver: { profileId: assertId(req.driver?.profileId), model: req.driver?.model || null },
      mentions: (Array.isArray(req.mentions) ? req.mentions : []).filter((m) => hasProfile(m?.profileId)).map((m) => ({ profileId: m.profileId, model: m.model || null })),
      participants: (Array.isArray(req.participants) ? req.participants : []).filter((p) => hasProfile(p)),
      transcript: Array.isArray(req.transcript) ? req.transcript.filter(isTranscriptEntry) : [],
      sessionScope: typeof req.sessionScope === 'string' ? req.sessionScope : undefined,
      mode: req.mode === 'handoff' ? 'handoff' : 'chat',
      handoffTo: hasProfile(req.handoffTo) ? req.handoffTo : undefined,
      handoffDoc: typeof req.handoffDoc === 'string' && isAbsolute(req.handoffDoc) ? req.handoffDoc : null,
      allowMissingProject: req.allowMissingProject === true,
      wantTitle: req.wantTitle === true,
      quote:
        req.quote &&
        typeof req.quote === 'object' &&
        (req.quote.role === 'user' || req.quote.role === 'assistant') &&
        typeof req.quote.author === 'string' &&
        typeof req.quote.excerpt === 'string' &&
        req.quote.excerpt.trim()
          ? {
              role: req.quote.role,
              author: req.quote.author.trim().slice(0, 80),
              excerpt: req.quote.excerpt.trim().slice(0, 1200)
            }
          : null
    })
  })
  ipcMain.handle(IPC.chatExportHandoff, (_e, threadId: unknown, turnId: unknown, projectDir: unknown, markdown: unknown) => {
    if (typeof threadId !== 'string' || typeof turnId !== 'string' || typeof markdown !== 'string') throw new Error('bad request')
    const cwd = threadCwd(threadId, typeof projectDir === 'string' ? projectDir : null)
    allowRoot(cwd)
    return writeHandoff(cwd, turnId, markdown)
  })

  ipcMain.handle(IPC.chatCheckpoints, (_e, threadId: unknown) =>
    typeof threadId === 'string' ? orchestrator.checkpoints.list(threadId) : []
  )
  ipcMain.handle(IPC.chatCheckpointAction, (_e, threadId: unknown, turnId: unknown, token: unknown, choice: unknown) => {
    if (typeof threadId !== 'string' || typeof turnId !== 'string'
      || (token !== undefined && (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)
        || (choice !== 'skip' && choice !== 'overwrite')))) return { kind: 'unavailable' }
    return orchestrator.checkpoints.action(
      threadId, turnId, (root) => orchestrator.isWorkspaceBusy(threadId, root),
      token, choice === 'skip' || choice === 'overwrite' ? choice : undefined
    )
  })
  ipcMain.handle(IPC.chatRewindPlan, (_e, threadId: unknown, turnIds: unknown) => {
    if (typeof threadId !== 'string' || !Array.isArray(turnIds)) return { kind: 'invalid' as const }
    if (orchestrator.hasActiveTurn(threadId)) return { kind: 'busy' as const }
    const ids = turnIds.filter((id): id is string => typeof id === 'string')
    return orchestrator.checkpoints.planRewind(threadId, ids, (root) => orchestrator.isWorkspaceBusy(threadId, root))
  })
  ipcMain.handle(IPC.chatRewind, async (_e, threadId: unknown, turnIds: unknown, restoreFiles: unknown, choice: unknown) => {
    if (typeof threadId !== 'string' || !Array.isArray(turnIds)) return { kind: 'invalid' as const }
    if (orchestrator.hasActiveTurn(threadId)) return { kind: 'busy' as const }
    const ids = turnIds.filter((id): id is string => typeof id === 'string')
    const res = await orchestrator.checkpoints.rewind(
      threadId,
      ids,
      restoreFiles === true,
      (root) => orchestrator.isWorkspaceBusy(threadId, root),
      choice === 'skip' ? 'skip' : 'overwrite'
    )
    if (res.kind !== 'ok') return res
    const clearedSessions = orchestrator.clearThreadSessions(threadId)
    return { ...res, clearedSessions }
  })
  ipcMain.handle(IPC.chatCompactSessions, (_e, threadId: unknown, profileIds: unknown) => {
    if (typeof threadId !== 'string' || !Array.isArray(profileIds)) return false
    return orchestrator.compactThreadSessions(threadId, profileIds.filter((id): id is string => typeof id === 'string'))
  })
  ipcMain.handle(IPC.chatDeleteThread, async (_e, req: unknown) => {
    const r = req as Record<string, unknown> | null
    if (!r || typeof r.threadId !== 'string') throw new Error('bad request')
    await orchestrator.stopAndWait(r.threadId)
    return deleteThreadData({
      threadId: r.threadId,
      projectDir: typeof r.projectDir === 'string' ? r.projectDir : null,
      turnIds: Array.isArray(r.turnIds) ? r.turnIds.filter((t): t is string => typeof t === 'string') : [],
      purgeCli: r.purgeCli === true
    }, orchestrator.checkpoints)
  })

  // ---- usage & quota ------------------------------------------------------------------------
  onUsageChange((s) => send(IPC.usageChanged, s))
  onRequestLogChange(() => send(IPC.requestLogsChanged, null))
  startUsage()
  ipcMain.handle(IPC.usageGet, () => usageSnapshot())
  ipcMain.handle(IPC.usageRefresh, (_e, probe?: boolean) => refreshUsage(probe === true))
  ipcMain.handle(IPC.usageSyncPrices, () => syncPrices(true))
  ipcMain.handle(IPC.usageSetPrice, (_e, model: unknown, rate: unknown) => {
    if (typeof model !== 'string' || !model.trim()) throw new Error('bad model')
    if (rate !== null && (typeof rate !== 'object' || Array.isArray(rate))) throw new Error('bad rate')
    return setCustomPrice(model, rate as Parameters<typeof setCustomPrice>[1])
  })
  ipcMain.handle(IPC.requestLogsQuery, (_e, raw?: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return queryRequestLogs()
    const q = raw as Record<string, unknown>
    const statusRaw = q.statusCode
    const statusCode =
      statusRaw === 'all' || statusRaw === '2xx' || statusRaw === '429' || statusRaw === '4xx5xx'
        ? statusRaw
        : typeof statusRaw === 'number' && Number.isInteger(statusRaw)
          ? statusRaw
          : undefined
    const engineKind = KINDS.includes(q.engineKind as ProfileKind) ? (q.engineKind as ProfileKind) : undefined
    return queryRequestLogs({
      offset: typeof q.offset === 'number' && Number.isFinite(q.offset) ? q.offset : undefined,
      limit: typeof q.limit === 'number' && Number.isFinite(q.limit) ? q.limit : undefined,
      statusCode,
      accountId: typeof q.accountId === 'string' && q.accountId ? q.accountId : undefined,
      engineKind,
      model: typeof q.model === 'string' && q.model ? q.model : undefined
    })
  })

  // ---- local CLI history (read-only) ------------------------------------------------------
  ipcMain.handle(IPC.historyList, (_e, force?: boolean) => listHistory(force === true))
  ipcMain.handle(IPC.historyOpen, async (_e, key: unknown) => {
    if (typeof key !== 'string') throw new Error('bad key')
    const h = await openHistory(key)
    if (h.entry.cwd && cwdExists(h.entry.cwd)) allowRoot(h.entry.cwd)
    return { ...h, cwdExists: !!h.entry.cwd && cwdExists(h.entry.cwd) }
  })
  ipcMain.handle(IPC.historyStat, (_e, key: unknown) => (typeof key === 'string' ? historyStat(key) : null))
  ipcMain.handle(IPC.historyTrash, (_e, key: unknown) => {
    if (typeof key !== 'string') throw new Error('bad key')
    return trashHistorySession(key)
  })
  ipcMain.handle(IPC.historyImport, (_e, threadId: unknown, profileId: unknown, nativeId: unknown) => {
    if (typeof threadId === 'string' && typeof nativeId === 'string' && hasProfile(profileId)) importSession(threadId, profileId, nativeId)
  })
  ipcMain.handle(IPC.chatActive, () => orchestrator.active())
  ipcMain.handle(IPC.chatPermissionReply, (_e, requestId: unknown, optionId: unknown) =>
    typeof requestId === 'string' && (typeof optionId === 'string' || optionId === null) && permissions.reply(requestId, optionId, 'user'))
  ipcMain.handle(IPC.chatPendingPermissions, () => permissions.pending())
  ipcMain.handle(IPC.chatStop, (_e, threadId: unknown) => typeof threadId === 'string' && orchestrator.stop(threadId))
  ipcMain.handle(IPC.chatResume, (_e, threadId: unknown, turnId: unknown, action: unknown) => {
    if (typeof threadId === 'string' && typeof turnId === 'string' && (action === 'retry' || action === 'skip' || action === 'stop'))
      orchestrator.resume(threadId, turnId, action)
  })
  /** Pasted (in-memory) attachments get a real file so CLIs can read them. */
  const stageDir = join(app.getPath('userData'), 'staging')
  try {
    const files = readdirSync(stageDir)
    // Queued messages can still need pasted files after the normal staging lifetime.
    const queuedPaths = new Set(chatStore.load().threads.flatMap((thread) =>
      thread.queuedMessages?.flatMap((message) => message.attachments.map((attachment) => attachment.path)) ?? []
    ))
    for (const f of files) {
      const p = join(stageDir, f)
      if (!queuedPaths.has(p) && Date.now() - statSync(p).mtimeMs > 3 * 86400_000) rmSync(p, { force: true })
    }
  } catch {
    /* no staging dir yet */
  }
  ipcMain.handle(IPC.attachStage, (_e, name: unknown, data: unknown) => {
    if (!(data instanceof Uint8Array) && !(data instanceof ArrayBuffer)) throw new Error('bad data')
    const buf = Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data)
    if (buf.length > STAGE_MAX) throw new Error(t('main.attachTooLarge'))
    mkdirSync(stageDir, { recursive: true })
    const safe = String(name || 'file').replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(-80) || 'file'
    const p = join(stageDir, `${randomBytes(4).toString('hex')}-${safe}`)
    writeFileSync(p, buf)
    allowFile(p)
    return p
  })
  ipcMain.handle(IPC.attachRegister, (_e, path: unknown): string | null => {
    if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) return null
    try {
      if (!statSync(path).isFile()) return null
      allowFile(path)
      return path
    } catch {
      return null
    }
  })
  /** Text preview of an attached file: allow-listed paths only, 64 KB, binary detected. */
  ipcMain.handle(IPC.attachRead, (_e, p: unknown): AttachmentText => {
    if (typeof p !== 'string' || !isAllowedPath(p)) throw new Error('not available')
    const st = statSync(p)
    if (!st.isFile()) throw new Error('not available')
    const fd = openSync(p, 'r')
    try {
      const buf = Buffer.alloc(Math.min(st.size, 64 * 1024))
      const n = readSync(fd, buf, 0, buf.length, 0)
      const head = buf.subarray(0, n)
      const binary = head.subarray(0, 8000).includes(0)
      return { text: binary ? '' : head.toString('utf8'), bytes: st.size, truncated: st.size > n, binary }
    } finally {
      closeSync(fd)
    }
  })

  // ---- system -----------------------------------------------------------------------
  ipcMain.handle(IPC.clipboardWrite, (_e, text: string) => clipboard.writeText(String(text)))
  ipcMain.handle(IPC.openExternal, (_e, url: string) => {
    if (!/^https?:\/\//.test(url)) throw new Error('only http(s) urls')
    return shell.openExternal(url)
  })
  ipcMain.handle(IPC.openPath, async (_e, p: string) => {
    const err = await shell.openPath(expandHome(p))
    if (err) throw new Error(err)
  })
  ipcMain.handle(IPC.pickDirectory, async (_e, defaultPath?: string, title?: string) => {
    const w = getWindow()
    const opts: Electron.OpenDialogOptions = {
      title,
      buttonLabel: t('main.choose'),
      properties: ['openDirectory', 'createDirectory', 'showHiddenFiles'],
      defaultPath: defaultPath ? expandHome(defaultPath) : realHome
    }
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? null : r.filePaths[0]
  })
  /** Project folder for a thread: also allow-listed for agentswitch-file:// image previews. */
  ipcMain.handle(IPC.pickProject, async (_e, defaultPath?: string) => {
    const w = getWindow()
    const opts: Electron.OpenDialogOptions = {
      title: t('main.pickProjectTitle'),
      buttonLabel: t('main.choose'),
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: defaultPath ? expandHome(defaultPath) : realHome
    }
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled) return null
    allowRoot(r.filePaths[0])
    return r.filePaths[0]
  })
  // ---- skills / MCP (local config files only; no CLI, no model call) -----------------
  const cwdArg = (cwd: unknown): string | null => (typeof cwd === 'string' && cwd.trim() ? cwd : null)
  ipcMain.handle(IPC.extSkills, (_e, id: unknown, cwd: unknown, refresh: unknown) => listSkills(assertId(id), cwdArg(cwd), refresh === true))
  ipcMain.handle(IPC.extMcp, (_e, id: unknown, cwd: unknown, refresh: unknown) => listMcp(assertId(id), cwdArg(cwd), refresh === true))
  ipcMain.handle(IPC.extOverview, (_e, id: unknown, cwd: unknown, refresh: unknown) => extOverview(assertId(id), cwdArg(cwd), refresh === true))
  // preview / reveal: only files an extensions scan listed (64 KB cap), never an arbitrary path
  ipcMain.handle(IPC.extRead, (_e, p: unknown) => {
    if (typeof p !== 'string') throw new Error('bad path')
    return readExtFile(p)
  })
  ipcMain.handle(IPC.extReveal, (_e, p: unknown) => {
    if (typeof p === 'string' && canRevealExtFile(p)) shell.showItemInFolder(p)
  })
  ipcMain.handle(IPC.extPrepareRule, (_e, id: unknown, cwd: unknown, scope: unknown) => {
    if (scope !== 'global' && scope !== 'project') throw new Error('bad scope')
    return prepareRuleTarget(assertId(id), cwdArg(cwd), scope)
  })
  ipcMain.handle(IPC.extWriteRule, (_e, p: unknown, content: unknown) => {
    if (typeof p !== 'string' || typeof content !== 'string') throw new Error('bad request')
    return writeRuleFile(p, content)
  })
  // pinned skills per CLI kind (names), shared by the panel and the / menu
  const pinKind = (k: unknown): ProfileKind => {
    if (k === 'claude' || k === 'codex' || k === 'gemini') return k
    throw new Error('bad kind')
  }
  ipcMain.handle(IPC.extPinsGet, (): Record<string, string[]> => {
    const v = readSettings().skillPins
    return v && typeof v === 'object' ? (v as Record<string, string[]>) : {}
  })
  ipcMain.handle(IPC.extPinsSet, (_e, kind: unknown, names: unknown) => {
    const k = pinKind(kind)
    const list = Array.isArray(names) ? [...new Set(names.filter((n): n is string => typeof n === 'string' && n.length < 200))].slice(0, 200) : []
    const cur = readSettings().skillPins
    writeSettings({ skillPins: { ...(cur && typeof cur === 'object' ? cur : {}), [k]: list } })
  })

  // ---- onboarding ------------------------------------------------------------------------
  ipcMain.handle(IPC.onboardingGet, (): OnboardingState => ({ completed: readSettings().onboardingCompleted === true, firstRun }))
  ipcMain.handle(IPC.onboardingSet, (_e, done: unknown) => writeSettings({ onboardingCompleted: done === true }))

  ipcMain.handle(IPC.showDataDir, () => shell.showItemInFolder(app.getPath('userData')))
  ipcMain.handle(IPC.exportThreadsFile, async (_e, defaultName: unknown, bundle: ThreadBundle) => {
    const w = getWindow()
    const name = typeof defaultName === 'string' && defaultName.trim()
      ? basename(defaultName.trim()).replace(/\.(?:json|zip)$/i, '') + '.zip'
      : 'AgentSwitch-chats.zip'
    const opts: Electron.SaveDialogOptions = {
      defaultPath: join(app.getPath('downloads'), name),
      filters: [{ name: 'AgentSwitch Chats', extensions: ['zip'] }]
    }
    const r = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return null
    const userData = app.getPath('userData')
    const exportRoots: string[] = []
    for (const candidate of [
      attachmentsDir(userData),
      stageDir,
      join(userData, 'workspaces'),
      ...chatStore.load().threads.flatMap((th) => [th.projectDir, th.workdir])
    ]) {
      if (typeof candidate !== 'string' || !isAbsolute(candidate)) continue
      try {
        exportRoots.push(realpathSync(candidate))
      } catch { /* folder may not exist */ }
    }
    const canExportFile = (real: string): boolean =>
      isAllowedPath(real) || exportRoots.some((root) => real === root || real.startsWith(root.endsWith(sep) ? root : root + sep))
    const manifest = exportThreadsArchive(bundle, r.filePath, {
      userData, appVersion: app.getVersion(), canReadFile: canExportFile
    })
    return { path: r.filePath, manifest }
  })
  let previewedImportPath: string | null = null
  ipcMain.handle(IPC.importThreadsFile, async () => {
    const w = getWindow()
    const opts: Electron.OpenDialogOptions = {
      properties: ['openFile'],
      filters: [{ name: 'AgentSwitch Chats', extensions: ['zip', 'json'] }]
    }
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths[0]) return null
    const preview = inspectThreadsImport(r.filePaths[0])
    previewedImportPath = preview.filePath
    return preview
  })
  ipcMain.handle(IPC.commitThreadsImport, (_e, request: CommitImportRequest) => {
    if (!request || typeof request.filePath !== 'string' || request.filePath !== previewedImportPath ||
        !Array.isArray(request.selectedThreadIds) || !request.selectedThreadIds.every((id) => typeof id === 'string') ||
        !request.projectMap || typeof request.projectMap !== 'object' || Array.isArray(request.projectMap)) {
      throw new Error('Invalid thread import request')
    }
    const knownProjects = new Set(chatStore.load().threads.map((thread) => thread.projectDir))
    const projectMap = Object.fromEntries(Object.entries(request.projectMap).filter(([, path]) =>
      typeof path === 'string' && (knownProjects.has(path) || isAllowedPath(path))))
    const result = commitThreadsImport({ ...request, projectMap }, { userData: app.getPath('userData') })
    previewedImportPath = null
    return result
  })
  ipcMain.handle(IPC.pathsExist, (_e, paths: unknown): Record<string, boolean> => {
    if (!Array.isArray(paths)) return {}
    return Object.fromEntries([...new Set(paths.slice(0, 200))].flatMap((path) =>
      typeof path === 'string' ? [[path, isAbsolute(path) && existsSync(path)]] : []))
  })
  ipcMain.handle(IPC.showInFolder, (_e, p: unknown) => {
    if (typeof p !== 'string' || !p.trim()) return
    const target = expandHome(p.trim())
    if (isAbsolute(target) && existsSync(target)) shell.showItemInFolder(target)
  })
  ipcMain.handle(IPC.appInfo, (): AppInfo => {
    const s = shellEnvStatus()
    return {
      userData: app.getPath('userData'),
      realHome,
      shellEnvSource: s.source,
      shellEnvError: s.error,
      path: getBaseEnv().PATH ?? '',
      electron: process.versions.electron,
      node: process.versions.node,
      nodeRuntime: cliNodeRuntime(findOnPath('node')),
      chrome: process.versions.chrome,
      version: app.getVersion(),
      arch: process.arch,
      osVersion: process.getSystemVersion(),
      claudeDirs: claudeDirs().map((n) => `~/${n}`)
    }
  })

  return { ptys, orchestrator, editorWatcher, broadcastAll: broadcast }
}
