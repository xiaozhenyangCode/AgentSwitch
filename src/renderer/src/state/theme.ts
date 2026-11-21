import { useSyncExternalStore } from 'react'
import type { ThemeMode, ThemeState } from '@shared/types'

/**
 * Appearance in the renderer: the `.dark` class on <html> switches every CSS token.
 * Read synchronously on import (main.tsx imports this before rendering) so a dark start never
 * paints light first; macOS appearance changes and manual switches arrive via theme:changed.
 */
let state: ThemeState = (() => {
  try {
    return window.agentswitch.theme.get()
  } catch {
    return { mode: 'system' as ThemeMode, dark: matchMedia('(prefers-color-scheme: dark)').matches }
  }
})()
const listeners = new Set<() => void>()

function apply(s: ThemeState) {
  state = s
  const root = document.documentElement
  root.classList.toggle('dark', s.dark)
  root.style.colorScheme = s.dark ? 'dark' : 'light'
  listeners.forEach((l) => l())
}
apply(state)
window.agentswitch.theme.onChanged(apply)

export const setThemeMode = async (mode: ThemeMode) => apply(await window.agentswitch.theme.set(mode))
export const isDark = () => state.dark
export function useTheme(): ThemeState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => state
  )
}
