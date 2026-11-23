import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { I18nState, LanguagePref } from '@shared/i18n'
import {
  IPC,
  type ProfileConnect,
  type AppInfo,
  type FileChanges,
  type DeleteThreadRequest,
  type ThemeMode,
  type MenuCommand,
  type McpList,
  type ExtOverview,
  type AttachmentText,
  type ExtFileText,
  type RuleTarget,
  type OnboardingState,
  type SkillList,
  type ThemeState,
  type DeleteThreadResult,
  type ChatEvent,
  type PendingPermissionEntry,
  type ModelList,
  type RunRequest,
  type EnvPreview,
  type HistoryEntry,
  type UsageSnapshot,
  type HistoryStat,
  type HistoryThread,
  type KindConfig,
  type LoginSuccessEvent,
  type ProfileConfig,
  type ProfileId,
  type ProfileKind,
  type PtyBuffer,
  type PtyDataEvent,
  type PtyExitEvent,
  type PtyMode,
  type PtyUrlEvent,
  type SessionId,
  type SessionInfo,
  type Snapshot,
  type StartPtyRequest
} from '@shared/types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  state: {
    get: (): Promise<Snapshot> => ipcRenderer.invoke(IPC.stateGet),
    onChanged: (cb: (s: Snapshot) => void) => subscribe(IPC.stateChanged, cb)
  },
  profiles: {
    /** Returns the new account id. */
    add: (kind: ProfileKind, name?: string, connect?: ProfileConnect): Promise<ProfileId> =>
      ipcRenderer.invoke(IPC.profilesAdd, kind, name, connect),
    reasonixCanImport: (): Promise<boolean> => ipcRenderer.invoke(IPC.reasonixCanImport),
    /** Replaces an API-key account's key (stored encrypted in the main process). */
    setKey: (id: ProfileId, key: string): Promise<void> => ipcRenderer.invoke(IPC.profilesSetKey, id, key),
    update: (id: ProfileId, patch: Partial<ProfileConfig>): Promise<void> => ipcRenderer.invoke(IPC.profilesUpdate, id, patch),
    reset: (id: ProfileId): Promise<void> => ipcRenderer.invoke(IPC.profilesReset, id),
    /** Removes the account from AgentSwitch; files on disk are kept. */
    remove: (id: ProfileId): Promise<void> => ipcRenderer.invoke(IPC.profilesRemove, id),
    envPreview: (id: ProfileId, mode: PtyMode): Promise<EnvPreview> => ipcRenderer.invoke(IPC.profilesEnvPreview, id, mode),
    onLoginSuccess: (cb: (e: LoginSuccessEvent) => void) => subscribe(IPC.loginSuccess, cb)
  },
  cli: {
    update: (kind: ProfileKind, patch: Partial<KindConfig>): Promise<void> => ipcRenderer.invoke(IPC.kindsUpdate, kind, patch),
    reset: (kind: ProfileKind): Promise<void> => ipcRenderer.invoke(IPC.kindsReset, kind),
    version: (kind: ProfileKind): Promise<string | null> => ipcRenderer.invoke(IPC.cliVersion, kind),
    /** update=true runs the CLI's update command instead of the installer. */
    install: (kind: ProfileKind, update = false): Promise<SessionId> => ipcRenderer.invoke(IPC.cliInstall, kind, update)
  },
  pty: {
    start: (req: StartPtyRequest): Promise<SessionId> => ipcRenderer.invoke(IPC.ptyStart, req),
    shell: (cwd: string | null, cols: number, rows: number): Promise<SessionId> => ipcRenderer.invoke(IPC.ptyShell, cwd, cols, rows),
    write: (id: SessionId, data: string): void => ipcRenderer.send(IPC.ptyWrite, id, data),
    resize: (id: SessionId, cols: number, rows: number): void => ipcRenderer.send(IPC.ptyResize, id, cols, rows),
    kill: (id: SessionId): Promise<void> => ipcRenderer.invoke(IPC.ptyKill, id),
    buffer: (id: SessionId): Promise<PtyBuffer> => ipcRenderer.invoke(IPC.ptyBuffer, id),
    sessions: (): Promise<SessionInfo[]> => ipcRenderer.invoke(IPC.ptySessions),
    forget: (id: SessionId): Promise<void> => ipcRenderer.invoke(IPC.ptyForget, id),
    onData: (cb: (e: PtyDataEvent) => void) => subscribe(IPC.ptyData, cb),
    onExit: (cb: (e: PtyExitEvent) => void) => subscribe(IPC.ptyExit, cb),
    onUrl: (cb: (e: PtyUrlEvent) => void) => subscribe(IPC.ptyUrl, cb)
  },
  models: {
    list: (id: ProfileId, refresh = false): Promise<ModelList> => ipcRenderer.invoke(IPC.modelsList, id, refresh)
  },
  chat: {
    send: (req: RunRequest): Promise<void> => ipcRenderer.invoke(IPC.chatSend, req),
    stop: (threadId: string): Promise<void> => ipcRenderer.invoke(IPC.chatStop, threadId),
    /** Turns the main process is still running (after a window reload). */
    active: (): Promise<{ threadId: string; turnId: string; running: string[] }[]> => ipcRenderer.invoke(IPC.chatActive),
    permissionReply: (requestId: string, optionId: string | null): Promise<boolean> => ipcRenderer.invoke(IPC.chatPermissionReply, requestId, optionId),
    pendingPermissions: (): Promise<PendingPermissionEntry[]> => ipcRenderer.invoke(IPC.chatPendingPermissions),
    resume: (threadId: string, turnId: string, action: 'retry' | 'skip' | 'stop'): Promise<void> =>
      ipcRenderer.invoke(IPC.chatResume, threadId, turnId, action),
    onEvent: (cb: (e: ChatEvent) => void) => subscribe(IPC.chatEvent, cb),
    /** Writes a handoff document (exported transcript); returns its absolute path. */
    exportHandoff: (threadId: string, turnId: string, projectDir: string | null, markdown: string): Promise<string> =>
      ipcRenderer.invoke(IPC.chatExportHandoff, threadId, turnId, projectDir, markdown),
    deleteThread: (req: DeleteThreadRequest): Promise<DeleteThreadResult> => ipcRenderer.invoke(IPC.chatDeleteThread, req)
  },
  usage: {
    get: (): Promise<UsageSnapshot> => ipcRenderer.invoke(IPC.usageGet),
    /** probe=true sends one tiny haiku message per claude account to pull fresh quota (uses quota). */
    refresh: (probe = false): Promise<UsageSnapshot> => ipcRenderer.invoke(IPC.usageRefresh, probe),
    onChanged: (cb: (s: UsageSnapshot) => void) => subscribe(IPC.usageChanged, cb)
  },
  history: {
    list: (force = false): Promise<HistoryEntry[]> => ipcRenderer.invoke(IPC.historyList, force),
    open: (key: string): Promise<HistoryThread & { cwdExists: boolean }> => ipcRenderer.invoke(IPC.historyOpen, key),
    /** Links an AgentSwitch thread to the native session so the same account resumes it. */
    import: (threadId: string, profileId: ProfileId, nativeId: string): Promise<void> => ipcRenderer.invoke(IPC.historyImport, threadId, profileId, nativeId),
    stat: (key: string): Promise<HistoryStat | null> => ipcRenderer.invoke(IPC.historyStat, key),
    /** Moves one CLI session's files to the Trash. */
    trash: (key: string): Promise<DeleteThreadResult> => ipcRenderer.invoke(IPC.historyTrash, key)
  },
  attach: {
    /** Writes an in-memory file (e.g. pasted image) to disk; returns its absolute path. */
    stage: (name: string, data: ArrayBuffer): Promise<string> => ipcRenderer.invoke(IPC.attachStage, name, data),
    /** Text preview of an attached file (allow-listed, 64 KB). */
    read: (path: string): Promise<AttachmentText> => ipcRenderer.invoke(IPC.attachRead, path)
  },
  theme: {
    /** Sync on purpose: applied before the first paint. */
    get: (): ThemeState => ipcRenderer.sendSync(IPC.themeGetSync),
    set: (mode: ThemeMode): Promise<ThemeState> => ipcRenderer.invoke(IPC.themeSet, mode),
    onChanged: (cb: (s: ThemeState) => void): (() => void) => {
      const h = (_e: IpcRendererEvent, s: ThemeState) => cb(s)
      ipcRenderer.on(IPC.themeChanged, h)
      return () => ipcRenderer.removeListener(IPC.themeChanged, h)
    }
  },
  i18n: {
    /** Sync on purpose: the first render already uses the right language. */
    get: (): I18nState => ipcRenderer.sendSync(IPC.i18nGetSync),
    set: (pref: LanguagePref): Promise<I18nState> => ipcRenderer.invoke(IPC.i18nSet, pref),
    onChanged: (cb: (s: I18nState) => void) => subscribe(IPC.i18nChanged, cb)
  },
  /** Native menu bar commands (About, Settings…, New Chat, Search). */
  onMenu: (cb: (cmd: MenuCommand) => void) => subscribe(IPC.menuCommand, cb),
  /** Skills / MCP servers an account would load in a project (read from local config files). */
  ext: {
    skills: (id: ProfileId, cwd: string | null, refresh = false): Promise<SkillList> => ipcRenderer.invoke(IPC.extSkills, id, cwd, refresh),
    mcp: (id: ProfileId, cwd: string | null, refresh = false): Promise<McpList> => ipcRenderer.invoke(IPC.extMcp, id, cwd, refresh),
    overview: (id: ProfileId, cwd: string | null, refresh = false): Promise<ExtOverview> => ipcRenderer.invoke(IPC.extOverview, id, cwd, refresh),
    /** Only files listed by a scan (64 KB max). */
    read: (path: string): Promise<ExtFileText> => ipcRenderer.invoke(IPC.extRead, path),
    reveal: (path: string): Promise<void> => ipcRenderer.invoke(IPC.extReveal, path),
    prepareRule: (id: ProfileId, cwd: string | null, scope: 'global' | 'project'): Promise<RuleTarget> =>
      ipcRenderer.invoke(IPC.extPrepareRule, id, cwd, scope),
    writeRule: (path: string, content: string): Promise<{ bytes: number; lines: number }> =>
      ipcRenderer.invoke(IPC.extWriteRule, path, content),
    pins: (): Promise<Partial<Record<ProfileKind, string[]>>> => ipcRenderer.invoke(IPC.extPinsGet),
    setPins: (kind: ProfileKind, names: string[]): Promise<void> => ipcRenderer.invoke(IPC.extPinsSet, kind, names)
  },
  onboarding: {
    get: (): Promise<OnboardingState> => ipcRenderer.invoke(IPC.onboardingGet),
    set: (completed: boolean): Promise<void> => ipcRenderer.invoke(IPC.onboardingSet, completed)
  },
  git: {
    /** Changed files of a project folder (read-only git status / diff). */
    changes: (dir: string): Promise<FileChanges> => ipcRenderer.invoke(IPC.gitChanges, dir)
  },
  sys: {
    copy: (text: string): Promise<void> => ipcRenderer.invoke(IPC.clipboardWrite, text),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC.openExternal, url),
    openPath: (p: string): Promise<void> => ipcRenderer.invoke(IPC.openPath, p),
    pickDirectory: (defaultPath?: string, title?: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC.pickDirectory, defaultPath, title),
    info: (): Promise<AppInfo> => ipcRenderer.invoke(IPC.appInfo),
    /** Picks a thread's project folder (and allow-lists it for image previews). */
    pickProject: (defaultPath?: string): Promise<string | null> => ipcRenderer.invoke(IPC.pickProject, defaultPath),
    showInFolder: (p: string): Promise<void> => ipcRenderer.invoke(IPC.showInFolder, p),
    /** Opens AgentSwitch's userData folder in Finder (outside the file allowlist on purpose). */
    showDataDir: (): Promise<void> => ipcRenderer.invoke(IPC.showDataDir),
    exportThreadsFile: (defaultName: string, content: string): Promise<{ path: string } | null> =>
      ipcRenderer.invoke(IPC.exportThreadsFile, defaultName, content),
    importThreadsFile: (): Promise<{ path: string; text: string } | null> =>
      ipcRenderer.invoke(IPC.importThreadsFile),
    /** Absolute path of a File picked/dropped in the renderer ('' for in-memory files). */
    pathForFile: (file: File): string => webUtils.getPathForFile(file)
  }
}

export type AgentSwitchApi = typeof api

contextBridge.exposeInMainWorld('agentswitch', api)
