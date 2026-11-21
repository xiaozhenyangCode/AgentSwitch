import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import {
  IPC,
  type AppInfo,
  type DeleteThreadRequest,
  type ThemeMode,
  type ThemeState,
  type DeleteThreadResult,
  type ChatEvent,
  type ModelList,
  type RunRequest,
  type EnvPreview,
  type HistoryEntry,
  type UsageSnapshot,
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
    add: (kind: ProfileKind, name?: string): Promise<ProfileId> => ipcRenderer.invoke(IPC.profilesAdd, kind, name),
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
    write: (id: SessionId, data: string): void => ipcRenderer.send(IPC.ptyWrite, id, data),
    resize: (id: SessionId, cols: number, rows: number): void => ipcRenderer.send(IPC.ptyResize, id, cols, rows),
    kill: (id: SessionId): Promise<void> => ipcRenderer.invoke(IPC.ptyKill, id),
    buffer: (id: SessionId): Promise<PtyBuffer> => ipcRenderer.invoke(IPC.ptyBuffer, id),
    sessions: (): Promise<SessionInfo[]> => ipcRenderer.invoke(IPC.ptySessions),
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
    import: (threadId: string, profileId: ProfileId, nativeId: string): Promise<void> => ipcRenderer.invoke(IPC.historyImport, threadId, profileId, nativeId)
  },
  attach: {
    /** Writes an in-memory file (e.g. pasted image) to disk; returns its absolute path. */
    stage: (name: string, data: ArrayBuffer): Promise<string> => ipcRenderer.invoke(IPC.attachStage, name, data)
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
    /** Absolute path of a File picked/dropped in the renderer ('' for in-memory files). */
    pathForFile: (file: File): string => webUtils.getPathForFile(file)
  }
}

export type AgentSwitchApi = typeof api

contextBridge.exposeInMainWorld('agentswitch', api)
