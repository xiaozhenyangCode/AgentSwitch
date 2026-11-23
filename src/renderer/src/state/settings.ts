import { useSyncExternalStore } from 'react'
import type { ProfileId } from '@shared/types'

/**
 * Renderer preferences kept in localStorage (the language and the theme live in the main
 * process because the menu bar / window chrome need them too).
 */
export type SendKey = 'enter' | 'mod-enter'
export interface Settings {
  /** enter: Enter sends, Shift+Enter newline. mod-enter: ⌘+Enter sends, Enter newline. */
  sendKey: SendKey
  /** Driver preselected for new chats; null = keep the current chat's driver. */
  defaultDriver: ProfileId | null
  /** Refreshing usage also probes Claude quota with one tiny haiku request per account. */
  probeClaude: boolean
  /** Quota warning dot when a window of the driver reaches this percentage. */
  quotaWarn: 70 | 80 | 90
  /** Developer: the >_ button (built-in terminal + CLI debug log drawer) in the workbench toolbar. */
  showDebugTerminal: boolean
  /** Developer: branch chip + stage/commit tools for git projects; off = read-only changes panel. */
  showGitTools: boolean
}

const KEY = 'agentswitch.settings.v1'
const PROBE_KEY = 'agentswitch.usage.probe' // older home of probeClaude
const DEFAULTS: Settings = { sendKey: 'enter', defaultDriver: null, probeClaude: false, quotaWarn: 80, showDebugTerminal: false, showGitTools: false }

function load(): Settings {
  let saved: Partial<Settings> = {}
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {}
  } catch {
    /* keep defaults */
  }
  const s = { ...DEFAULTS, ...saved }
  if (saved.probeClaude === undefined) s.probeClaude = localStorage.getItem(PROBE_KEY) === '1'
  if (s.sendKey !== 'enter' && s.sendKey !== 'mod-enter') s.sendKey = 'enter'
  if (![70, 80, 90].includes(s.quotaWarn)) s.quotaWarn = 80
  s.showDebugTerminal = s.showDebugTerminal === true
  s.showGitTools = s.showGitTools === true
  return s
}

let settings = load()
const listeners = new Set<() => void>()

export const getSettings = (): Settings => settings
export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  settings = { ...settings, [key]: value }
  localStorage.setItem(KEY, JSON.stringify(settings))
  listeners.forEach((l) => l())
}
export function useSettings(): Settings {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => settings
  )
}

/** Key caps for the send / newline shortcuts under the current setting. */
export const sendKeys = (k: SendKey): { send: string; newline: string } => (k === 'enter' ? { send: '↩', newline: '⇧↩' } : { send: '⌘↩', newline: '↩' })
