import { app, BrowserWindow, ipcMain } from 'electron'
import { readSettings, writeSettings } from './appSettings'
import { IPC } from '@shared/types'
import { isLanguagePref, resolveLocale, translate, type I18nState, type LanguagePref, type Locale, type MsgKey, type Vars } from '@shared/i18n'

/**
 * UI language: 'system' (default) follows macOS's preferred languages; or a pinned locale.
 * Stored in userData/settings.json. The main process uses it for menus, dialogs and the
 * errors / notices it sends to the UI; the renderer reads it synchronously before first paint.
 */

const systemTags = (): string[] => {
  try {
    const tags = app.getPreferredSystemLanguages()
    if (tags.length) return tags
  } catch {
    /* not ready yet */
  }
  return [Intl.DateTimeFormat().resolvedOptions().locale]
}

let pref: LanguagePref = 'system'
let locale: Locale | null = null

const current = (): Locale => (locale ??= resolveLocale(pref, systemTags()))
export const i18nState = (): I18nState => ({ pref, locale: current() })
export const t = (key: MsgKey, vars?: Vars): string => translate(current(), key, vars)

export function initI18n(onChange: () => void): void {
  const saved = readSettings().language
  pref = isLanguagePref(saved) ? saved : 'system'
  locale = null
  ipcMain.on(IPC.i18nGetSync, (e) => {
    e.returnValue = i18nState()
  })
  ipcMain.handle(IPC.i18nSet, (_e, p: unknown) => {
    if (!isLanguagePref(p)) throw new Error('bad language')
    pref = p
    locale = null
    writeSettings({ language: pref })
    const s = i18nState()
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(IPC.i18nChanged, s)
    onChange()
    return s
  })
}
