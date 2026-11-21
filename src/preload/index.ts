import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC,
  type AppInfo,
  type EnvPreview,
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
    /** Removes the account from AgentMux; files on disk are kept. */
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
  sys: {
    copy: (text: string): Promise<void> => ipcRenderer.invoke(IPC.clipboardWrite, text),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC.openExternal, url),
    openPath: (p: string): Promise<void> => ipcRenderer.invoke(IPC.openPath, p),
    pickDirectory: (defaultPath?: string, title?: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC.pickDirectory, defaultPath, title),
    info: (): Promise<AppInfo> => ipcRenderer.invoke(IPC.appInfo)
  }
}

export type AgentMuxApi = typeof api

contextBridge.exposeInMainWorld('agentmux', api)
