import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import { join } from 'node:path'
import { initProfiles } from './profiles'
import { registerIpc } from './ipc'
import { initShellEnv } from './shellEnv'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1080,
    minHeight: 640,
    // Transparent so the sidebar's native vibrancy shows through; the main canvas paints itself.
    backgroundColor: '#00000000',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 19 },
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => (mainWindow = null))

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
  // Light mode for now; switching to 'system' later lets vibrancy + CSS tokens follow macOS.
  nativeTheme.themeSource = 'light'
  let broadcastAll = (): void => {}
  await initShellEnv(join(app.getPath('userData'), 'shell-env.json'), () => broadcastAll())
  initProfiles()
  const ipc = registerIpc(() => mainWindow)
  const ptys = ipc.ptys
  broadcastAll = ipc.broadcastAll
  app.on('before-quit', () => ptys.killAll())

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
