import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import {
  IPC,
  KINDS,
  installSessionId,
  kindOfInstallSession,
  type AppInfo,
  type KindConfig,
  type KindState,
  type ProfileConfig,
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
  buildInstallSpec,
  buildSpawnSpec,
  cliVersion,
  envPreview,
  expandHome,
  getConfig,
  getKindConfig,
  getState,
  hasProfile,
  isLoggedIn,
  kindBinaryPath,
  listConfigs,
  loginSignature,
  removeProfile,
  resetKindConfig,
  resetProfile,
  updateKindConfig,
  updateProfile
} from './profiles'
import { PtyManager } from './ptyManager'
import { getBaseEnv, realHome, shellEnvStatus } from './shellEnv'

const assertId = (x: unknown): ProfileId => {
  if (!hasProfile(x)) throw new Error(`unknown account: ${String(x)}`)
  return x
}
const assertKind = (x: unknown): ProfileKind => {
  if (!KINDS.includes(x as ProfileKind)) throw new Error(`bad kind ${String(x)}`)
  return x as ProfileKind
}
const isSessionId = (x: unknown): x is SessionId => hasProfile(x) || (typeof x === 'string' && kindOfInstallSession(x) !== null)
const PROFILE_MODES: PtyMode[] = ['login', 'run', 'test', 'shell']

const LOGIN_POLL_MS = 1200
/** After success, give the CLI a moment to finish writing before killing its TUI. */
const LOGIN_KILL_DELAY_MS = 1500

export function registerIpc(getWindow: () => BrowserWindow | null): {
  ptys: PtyManager
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
      return getState(cfg, k.binaryPath, ptys.sessionMode(cfg.id), ptys.isRateLimited(cfg.id), k.installing)
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

  const sessionLabel = (id: SessionId): string => {
    const k = kindOfInstallSession(id)
    if (k) return `安装 ${KIND_LABEL[k]}`
    return hasProfile(id) ? getConfig(id).name : id
  }

  const ptys = new PtyManager({
    onData: (e) => send(IPC.ptyData, e),
    onExit: (e) => send(IPC.ptyExit, e),
    onUrl: (e) => send(IPC.ptyUrl, e),
    onStateChange: () => broadcast()
  })

  // ---- login success watcher ----------------------------------------------------
  const loginWatchers = new Map<ProfileId, NodeJS.Timeout>()
  const stopWatch = (id: ProfileId): void => {
    const t = loginWatchers.get(id)
    if (t) clearInterval(t)
    loginWatchers.delete(id)
  }
  const watchLogin = (id: ProfileId): void => {
    stopWatch(id)
    const before = loginSignature(id)
    const timer = setInterval(() => {
      if (!hasProfile(id) || ptys.sessionMode(id) !== 'login') return stopWatch(id)
      if (loginSignature(id) !== before && isLoggedIn(id)) {
        stopWatch(id)
        send(IPC.loginSuccess, { profileId: id })
        setTimeout(() => {
          if (ptys.sessionMode(id) === 'login') ptys.kill(id)
          broadcast()
        }, LOGIN_KILL_DELAY_MS)
      }
    }, LOGIN_POLL_MS)
    loginWatchers.set(id, timer)
  }

  // ---- accounts -------------------------------------------------------------------
  ipcMain.handle(IPC.stateGet, () => snapshot())
  ipcMain.handle(IPC.profilesAdd, (_e, kind: unknown, name?: string) => {
    const p = addProfile(assertKind(kind), name)
    broadcast()
    return p.id
  })
  ipcMain.handle(IPC.profilesUpdate, (_e, id: unknown, patch: Partial<ProfileConfig>) => {
    updateProfile(assertId(id), patch)
    broadcast()
  })
  ipcMain.handle(IPC.profilesReset, (_e, id: unknown) => {
    resetProfile(assertId(id))
    broadcast()
  })
  ipcMain.handle(IPC.profilesRemove, (_e, id: unknown) => {
    const pid = assertId(id)
    stopWatch(pid)
    ptys.forget(pid)
    removeProfile(pid) // config only; never deletes files on disk
    broadcast()
  })
  ipcMain.handle(IPC.profilesEnvPreview, (_e, id: unknown, mode: PtyMode) => envPreview(assertId(id), mode))

  // ---- CLIs -----------------------------------------------------------------------
  ipcMain.handle(IPC.kindsUpdate, (_e, kind: unknown, patch: Partial<KindConfig>) => {
    updateKindConfig(assertKind(kind), patch)
    broadcast()
  })
  ipcMain.handle(IPC.kindsReset, (_e, kind: unknown) => {
    resetKindConfig(assertKind(kind))
    broadcast()
  })
  ipcMain.handle(IPC.cliVersion, (_e, kind: unknown) => cliVersion(assertKind(kind)))
  /** Silent install in the `install:<kind>` session (real HOME); never touches account sessions. */
  ipcMain.handle(IPC.cliInstall, (_e, kind: unknown, update = false): SessionId => {
    const k = assertKind(kind)
    const sid = installSessionId(k)
    ptys.start(sid, 'install', buildInstallSpec(k, update === true), 120, 32)
    return sid
  })

  // ---- pty --------------------------------------------------------------------------
  ipcMain.handle(IPC.ptyStart, (_e, req: StartPtyRequest): SessionId => {
    const id = assertId(req.profileId)
    if (!PROFILE_MODES.includes(req.mode)) throw new Error(`bad mode ${req.mode}`)
    if (req.mode === 'test' && !req.command?.trim()) throw new Error('test mode needs a command')
    ptys.start(id, req.mode, buildSpawnSpec(id, req.mode, req.command), req.cols, req.rows)
    if (req.mode === 'login') watchLogin(id)
    return id
  })
  ipcMain.on(IPC.ptyWrite, (_e, id: unknown, data: string) => isSessionId(id) && ptys.write(id, data))
  ipcMain.on(IPC.ptyResize, (_e, id: unknown, cols: number, rows: number) => isSessionId(id) && ptys.resize(id, cols, rows))
  ipcMain.handle(IPC.ptyKill, (_e, id: unknown) => {
    if (isSessionId(id)) ptys.kill(id)
  })
  ipcMain.handle(IPC.ptyBuffer, (_e, id: unknown) => ptys.getBuffer(typeof id === 'string' ? id : ''))
  ipcMain.handle(IPC.ptySessions, () => ptys.list(sessionLabel))

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
      buttonLabel: '选择',
      properties: ['openDirectory', 'createDirectory', 'showHiddenFiles'],
      defaultPath: defaultPath ? expandHome(defaultPath) : realHome
    }
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? null : r.filePaths[0]
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
      node: process.versions.node
    }
  })

  return { ptys, broadcastAll: broadcast }
}
