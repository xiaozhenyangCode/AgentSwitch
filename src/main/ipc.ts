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
  claudeDirs,
  cliVersion,
  envPreview,
  expandHome,
  getConfig,
  getKindConfig,
  firstRun,
  getState,
  hasProfile,
  installCommand,
  missingInstallTool,
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
import { listMcp, listSkills } from './extensions'
import { readSettings, writeSettings } from './appSettings'
import { t } from './i18n'
import { PtyManager } from './ptyManager'
import { Orchestrator, importSession, threadCwd } from './orchestrator'
import { cwdExists, listHistory, openHistory, writeHandoff } from './history'
import { deleteThreadData } from './threadDelete'
import { onUsageChange, refreshUsage, snapshot as usageSnapshot, startUsage } from './usage'
import { forgetModels, listModels } from './models'
import { allowRoot, isAllowedPath } from './fileProtocol'
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { OnboardingState, RunRequest } from '@shared/types'
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

const STAGE_MAX = 50 * 1024 * 1024

export function registerIpc(getWindow: () => BrowserWindow | null): {
  ptys: PtyManager
  orchestrator: Orchestrator
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

  const sessionLabel = (id: SessionId): string => {
    const k = kindOfInstallSession(id)
    if (k) return t('main.installSession', { name: KIND_LABEL[k] })
    if (id.startsWith('run:')) {
      const pid = id.slice(4)
      return t('main.runSession', { name: hasProfile(pid) ? getConfig(pid).name : pid })
    }
    return hasProfile(id) ? getConfig(id).name : id
  }

  const ptys = new PtyManager({
    onData: (e) => send(IPC.ptyData, e),
    onExit: (e) => send(IPC.ptyExit, e),
    onUrl: (e) => send(IPC.ptyUrl, e),
    onStateChange: () => broadcast()
  })

  const orchestrator = new Orchestrator(
    (e) => send(IPC.chatEvent, e),
    (pid, text) => ptys.log(`run:${pid}`, text),
    () => broadcast()
  )

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
    ptys.forget(`run:${pid}`)
    forgetModels(pid)
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
    const tool = missingInstallTool(k, update === true)
    if (tool) throw new Error(t('main.needNode', { tool, cmd: installCommand(k, update === true) }))
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

  // ---- models / chat ------------------------------------------------------------------
  ipcMain.handle(IPC.modelsList, (_e, id: unknown, refresh?: boolean) => listModels(assertId(id), refresh === true))
  ipcMain.handle(IPC.chatSend, (_e, req: RunRequest) => {
    if (!req || typeof req.threadId !== 'string' || typeof req.turnId !== 'string' || typeof req.text !== 'string') throw new Error('bad request')
    orchestrator.start({
      threadId: req.threadId,
      turnId: req.turnId,
      projectDir: typeof req.projectDir === 'string' ? req.projectDir : null,
      text: req.text,
      attachments: Array.isArray(req.attachments) ? req.attachments.filter((a) => a && typeof a.path === 'string') : [],
      driver: { profileId: assertId(req.driver?.profileId), model: req.driver?.model || null },
      mentions: (Array.isArray(req.mentions) ? req.mentions : []).filter((m) => hasProfile(m?.profileId)).map((m) => ({ profileId: m.profileId, model: m.model || null })),
      participants: (Array.isArray(req.participants) ? req.participants : []).filter((p) => hasProfile(p)),
      transcript: typeof req.transcript === 'string' ? req.transcript.slice(-12000) : '',
      mode: req.mode === 'handoff' ? 'handoff' : 'chat',
      handoffTo: hasProfile(req.handoffTo) ? req.handoffTo : undefined,
      handoffDoc: typeof req.handoffDoc === 'string' && isAbsolute(req.handoffDoc) ? req.handoffDoc : null,
      allowMissingProject: req.allowMissingProject === true
    })
  })
  ipcMain.handle(IPC.chatExportHandoff, (_e, threadId: unknown, turnId: unknown, projectDir: unknown, markdown: unknown) => {
    if (typeof threadId !== 'string' || typeof turnId !== 'string' || typeof markdown !== 'string') throw new Error('bad request')
    const cwd = threadCwd(threadId, typeof projectDir === 'string' ? projectDir : null)
    allowRoot(cwd)
    return writeHandoff(cwd, turnId, markdown)
  })

  ipcMain.handle(IPC.chatDeleteThread, (_e, req: unknown) => {
    const r = req as Record<string, unknown> | null
    if (!r || typeof r.threadId !== 'string') throw new Error('bad request')
    return deleteThreadData({
      threadId: r.threadId,
      projectDir: typeof r.projectDir === 'string' ? r.projectDir : null,
      turnIds: Array.isArray(r.turnIds) ? r.turnIds.filter((t): t is string => typeof t === 'string') : [],
      purgeCli: r.purgeCli === true
    })
  })

  // ---- usage & quota ------------------------------------------------------------------------
  onUsageChange((s) => send(IPC.usageChanged, s))
  startUsage()
  ipcMain.handle(IPC.usageGet, () => usageSnapshot())
  ipcMain.handle(IPC.usageRefresh, (_e, probe?: boolean) => refreshUsage(probe === true))

  // ---- local CLI history (read-only) ------------------------------------------------------
  ipcMain.handle(IPC.historyList, (_e, force?: boolean) => listHistory(force === true))
  ipcMain.handle(IPC.historyOpen, async (_e, key: unknown) => {
    if (typeof key !== 'string') throw new Error('bad key')
    const h = await openHistory(key)
    if (h.entry.cwd && cwdExists(h.entry.cwd)) allowRoot(h.entry.cwd)
    return { ...h, cwdExists: !!h.entry.cwd && cwdExists(h.entry.cwd) }
  })
  ipcMain.handle(IPC.historyImport, (_e, threadId: unknown, profileId: unknown, nativeId: unknown) => {
    if (typeof threadId === 'string' && typeof nativeId === 'string' && hasProfile(profileId)) importSession(threadId, profileId, nativeId)
  })
  ipcMain.handle(IPC.chatStop, (_e, threadId: unknown) => typeof threadId === 'string' && orchestrator.stop(threadId))
  ipcMain.handle(IPC.chatResume, (_e, threadId: unknown, turnId: unknown, action: unknown) => {
    if (typeof threadId === 'string' && typeof turnId === 'string' && (action === 'retry' || action === 'skip' || action === 'stop'))
      orchestrator.resume(threadId, turnId, action)
  })
  /** Pasted (in-memory) attachments get a real file so CLIs can read them. */
  const stageDir = join(app.getPath('userData'), 'staging')
  try {
    // housekeeping: drop staged files older than 3 days
    for (const f of readdirSync(stageDir)) {
      const p = join(stageDir, f)
      if (Date.now() - statSync(p).mtimeMs > 3 * 86400_000) rmSync(p, { force: true })
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
    return p
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

  // ---- onboarding ------------------------------------------------------------------------
  ipcMain.handle(IPC.onboardingGet, (): OnboardingState => ({ completed: readSettings().onboardingCompleted === true, firstRun }))
  ipcMain.handle(IPC.onboardingSet, (_e, done: unknown) => writeSettings({ onboardingCompleted: done === true }))

  ipcMain.handle(IPC.showDataDir, () => shell.showItemInFolder(app.getPath('userData')))
  ipcMain.handle(IPC.showInFolder, (_e, p: unknown) => {
    if (typeof p === 'string' && isAllowedPath(p)) shell.showItemInFolder(p)
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
      chrome: process.versions.chrome,
      version: app.getVersion(),
      arch: process.arch,
      osVersion: process.getSystemVersion(),
      claudeDirs: claudeDirs().map((n) => `~/${n}`)
    }
  })

  return { ptys, orchestrator, broadcastAll: broadcast }
}
