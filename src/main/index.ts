import './legacy' // first: migrates AgentMux userData before other modules read it
import { app, BrowserWindow, dialog, nativeImage, screen, shell } from 'electron'
import { CHAT_CLOSE_EVENT } from '@shared/chat'
import { IPC } from '@shared/types'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readSettings, writeSettings } from './appSettings'
import { initProfiles } from './profiles'
import { registerIpc } from './ipc'
import type { EditorFileWatcher } from './editorFiles'
import { initShellEnv } from './shellEnv'
import { handleFileProtocol, registerFileScheme } from './fileProtocol'
import { initTheme } from './theme'
import { initI18n, t } from './i18n'
import { buildMenu } from './menu'
import { agyAcpPool } from './acp/pool'
import { permissions } from './acp/permissions'
import { cleanupAllPersistentThreadHistory } from './threadHistoryConfig'
import { getActiveTransferType } from './threadTransfer'

registerFileScheme()

const DEFAULT_WIDTH = 1360
const DEFAULT_HEIGHT = 880
const MIN_WIDTH = 1080
const MIN_HEIGHT = 640

interface SavedWindowBounds {
  x?: number
  y?: number
  width: number
  height: number
  maximized?: boolean
  fullScreen?: boolean
}

function loadWindowBounds(): SavedWindowBounds {
  const raw = readSettings().windowBounds as Partial<SavedWindowBounds> | undefined
  if (!raw || typeof raw !== 'object') return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }
  const width = typeof raw.width === 'number' && Number.isFinite(raw.width) ? Math.max(MIN_WIDTH, Math.round(raw.width)) : DEFAULT_WIDTH
  const height = typeof raw.height === 'number' && Number.isFinite(raw.height) ? Math.max(MIN_HEIGHT, Math.round(raw.height)) : DEFAULT_HEIGHT
  const out: SavedWindowBounds = {
    width,
    height,
    maximized: raw.maximized === true,
    fullScreen: raw.fullScreen === true
  }
  if (typeof raw.x === 'number' && Number.isFinite(raw.x) && typeof raw.y === 'number' && Number.isFinite(raw.y)) {
    const x = Math.round(raw.x)
    const y = Math.round(raw.y)
    // Ensure at least a reachable portion of the window sits on a currently connected display.
    const visible = screen.getAllDisplays().some(({ workArea: wa }) => {
      const overlapX = Math.min(x + width, wa.x + wa.width) - Math.max(x, wa.x)
      const overlapY = Math.min(y + height, wa.y + wa.height) - Math.max(y, wa.y)
      return overlapX >= 100 && overlapY >= 60 && y >= wa.y - 20
    })
    if (visible) {
      out.x = x
      out.y = y
    }
  }
  return out
}

function trackWindowBounds(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null
  const save = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (win.isDestroyed()) return
    const b = win.getNormalBounds()
    const payload: SavedWindowBounds = {
      x: b.x,
      y: b.y,
      width: Math.max(MIN_WIDTH, b.width),
      height: Math.max(MIN_HEIGHT, b.height),
      maximized: win.isMaximized(),
      fullScreen: win.isFullScreen()
    }
    writeSettings({ windowBounds: payload })
  }
  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(save, 300)
  }
  win.on('resize', schedule)
  win.on('move', schedule)
  win.on('maximize', save)
  win.on('unmaximize', save)
  win.on('enter-full-screen', save)
  win.on('leave-full-screen', save)
  win.on('close', save)
}

let mainWindow: BrowserWindow | null = null
let quitRequested = false

let showingTransferWarning = false

function blockCloseForTransfer(win: BrowserWindow | null): boolean {
  const type = getActiveTransferType()
  if (!type) return false
  quitRequested = false
  if (!showingTransferWarning) {
    showingTransferWarning = true
    const options: Electron.MessageBoxOptions = {
      type: 'info',
      message: t(type === 'export' ? 'xfer.blockCloseExport' : 'xfer.blockCloseImport')
    }
    const warning = win && !win.isDestroyed() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)
    void warning.catch((error) => console.warn('[threadTransfer] close warning failed', error)).finally(() => {
      showingTransferWarning = false
    })
  }
  return true
}

function trackChatClose(win: BrowserWindow): void {
  let checking = false
  win.on('close', (event) => {
    event.preventDefault()
    if (blockCloseForTransfer(win) || checking) return
    checking = true
    void finishClose(win).catch((error) => console.error('[chatStore] close check failed', error)).finally(() => {
      checking = false
      quitRequested = false
    })
  })
}

const CLOSE_PING_MS = 3000
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function finishClose(win: BrowserWindow): Promise<void> {
  const contents = win.webContents
  // A hung renderer never answers the save check below, which would leave the window unclosable.
  // Ping first with a deadline; the check itself has none, as it waits on the renderer's own dialog.
  const responsive = contents.isCrashed() || (await Promise.race([contents.executeJavaScript('1').then(() => true, () => false), delay(CLOSE_PING_MS).then(() => false)]))
  if (win.isDestroyed()) return
  if (!responsive) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      message: t('chat.closeUnresponsive'),
      buttons: [t('common.cancel'), t('chat.closeAnyway')],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    if (response !== 1 || win.isDestroyed() || blockCloseForTransfer(win)) return
    win.destroy()
    app.quit()
    return
  }
  // Ask before unloading so the renderer stays available while the user decides.
  let decision: unknown = contents.isCrashed() ? 'saved' : await contents.executeJavaScript(`
    new Promise((resolve) => {
      const event = new CustomEvent(${JSON.stringify(CHAT_CLOSE_EVENT)}, { cancelable: true, detail: resolve })
      if (window.dispatchEvent(event)) resolve('saved')
    })
  `).catch(() => null)
  if (win.isDestroyed() || decision === 'cancelled') return
  if (decision !== 'saved' && decision !== 'discarded') {
    // The main process can still offer a choice if it lost the renderer during the check.
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      message: t('chat.closeUnsaved'),
      buttons: [t('common.cancel'), t('chat.closeAnyway')],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    if (response !== 1 || win.isDestroyed()) return
    decision = 'discarded'
  }

  if (blockCloseForTransfer(win)) return
  // Skip a second unload check after the write or explicit confirmation.
  win.destroy()
  if (quitRequested || decision === 'discarded') app.quit()
}

function createWindow(editorWatcher: EditorFileWatcher): void {
  const saved = loadWindowBounds()
  mainWindow = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    ...(saved.x !== undefined && saved.y !== undefined ? { x: saved.x, y: saved.y } : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    // Transparent so the sidebar's native vibrancy shows through; the main canvas paints itself.
    backgroundColor: '#00000000',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 19 },
    ...(saved.fullScreen ? { fullscreen: true } : {}),
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      // agents keep streaming while the window is hidden; don't throttle renderer timers
      backgroundThrottling: false,
      nodeIntegration: false,
      sandbox: false
    }
  })

  const win = mainWindow
  const sendFullScreen = () => win.webContents.send(IPC.windowFullScreenChanged, win.isFullScreen())
  win.on('enter-full-screen', sendFullScreen)
  win.on('leave-full-screen', sendFullScreen)

  trackWindowBounds(mainWindow)
  trackChatClose(mainWindow)

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (saved.maximized && !saved.fullScreen) mainWindow.maximize()
    mainWindow.show()
    if (saved.fullScreen && !mainWindow.isFullScreen()) mainWindow.setFullScreen(true)
  })
  mainWindow.on('closed', () => {
    editorWatcher.unwatchAll()
    mainWindow = null
  })

  // Never navigate the app window; external links go to the default browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && !app.isPackaged) {
    const devIcon = join(__dirname, '../../build/icon.png')
    if (existsSync(devIcon)) app.dock?.setIcon(nativeImage.createFromPath(devIcon))
  }
  // appearance (system / light / dark): window chrome, vibrancy and menus follow nativeTheme
  initTheme()
  // UI language (system / pinned): the menu is rebuilt when it changes
  initI18n(() => buildMenu(() => mainWindow))
  buildMenu(() => mainWindow)
  let broadcastAll = (): void => {}
  await initShellEnv(join(app.getPath('userData'), 'shell-env.json'), () => broadcastAll())
  initProfiles()
  handleFileProtocol()
  const ipc = registerIpc(() => mainWindow)
  const ptys = ipc.ptys
  broadcastAll = ipc.broadcastAll
  // A window can veto quitting while it still has unsaved chats.
  app.on('will-quit', () => {
    ipc.editorWatcher.unwatchAll()
    ipc.orchestrator.stopAll()
    permissions.cancelAll(() => true)
    ptys.killAll()
    queueMicrotask(() => {
      agyAcpPool.shutdownAll()
      try {
        cleanupAllPersistentThreadHistory()
      } catch (error) {
        console.warn('[thread history] cleanup failed', error)
      }
    })
  })

  createWindow(ipc.editorWatcher)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(ipc.editorWatcher)
  })
})

app.on('before-quit', (event) => {
  if (blockCloseForTransfer(mainWindow)) {
    event.preventDefault()
    return
  }
  if (!mainWindow || mainWindow.isDestroyed()) return
  event.preventDefault()
  quitRequested = true
  mainWindow.close()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
