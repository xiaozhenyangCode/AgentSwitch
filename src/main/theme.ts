import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC, type ThemeMode, type ThemeState } from '@shared/types'

/**
 * Appearance: 'system' (default) follows macOS; 'light' / 'dark' pin it. nativeTheme.themeSource
 * drives the window chrome, vibrancy and native menus; the renderer toggles its `.dark` class
 * from the ThemeState broadcast on every change (incl. macOS switching appearance).
 */

const file = (): string => join(app.getPath('userData'), 'appearance.json')
const MODES: ThemeMode[] = ['system', 'light', 'dark']

function loadMode(): ThemeMode {
  try {
    const m = JSON.parse(readFileSync(file(), 'utf8'))?.themeMode
    return MODES.includes(m) ? m : 'system'
  } catch {
    return 'system'
  }
}

let mode: ThemeMode = 'system'
export const themeState = (): ThemeState => ({ mode, dark: nativeTheme.shouldUseDarkColors })

function broadcast(): void {
  const s = themeState()
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(IPC.themeChanged, s)
}

export function initTheme(): void {
  mode = loadMode()
  nativeTheme.themeSource = mode
  // macOS appearance changes (and themeSource changes that flip the effective appearance)
  nativeTheme.on('updated', broadcast)
  // sync: the renderer applies the class before its first paint (no light flash in dark mode)
  ipcMain.on(IPC.themeGetSync, (e) => {
    e.returnValue = themeState()
  })
  ipcMain.handle(IPC.themeSet, (_e, m: unknown) => {
    if (!MODES.includes(m as ThemeMode)) throw new Error('bad theme mode')
    mode = m as ThemeMode
    try {
      writeFileSync(file(), JSON.stringify({ themeMode: mode }, null, 2))
    } catch (err) {
      console.error('[theme] save failed', err)
    }
    nativeTheme.themeSource = mode
    // 'updated' only fires when the effective appearance flips (system dark -> dark does not)
    broadcast()
    return themeState()
  })
}
