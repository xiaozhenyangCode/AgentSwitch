import { Fragment, createElement, useSyncExternalStore, type ReactNode } from 'react'
import { translate, type I18nState, type LanguagePref, type Locale, type MsgKey, type Vars } from '@shared/i18n'

/**
 * UI language, owned by the main process (settings.json) and read synchronously at startup so
 * the first paint is already in the right language. A change re-mounts the app shell (App.tsx
 * keys it by locale), so plain `t()` calls everywhere pick up the new language.
 */

let state: I18nState = window.agentswitch.i18n.get()
const listeners = new Set<() => void>()

function apply(s: I18nState): void {
  state = s
  document.documentElement.lang = s.locale
  listeners.forEach((l) => l())
}
apply(state)
window.agentswitch.i18n.onChanged(apply)

export const t = (key: MsgKey, vars?: Vars): string => translate(state.locale, key, vars)
export const currentLocale = (): Locale => state.locale

/** Like t(), but placeholders may be React nodes (bold names, avatars, links). */
export function tNode(key: MsgKey, vars: Record<string, ReactNode>): ReactNode {
  const parts = translate(state.locale, key).split(/(\{\w+\})/)
  return createElement(
    Fragment,
    null,
    ...parts.map((p, i) => {
      const m = /^\{(\w+)\}$/.exec(p)
      return createElement(Fragment, { key: i }, m && m[1] in vars ? vars[m[1]] : p)
    })
  )
}

export async function setLanguage(pref: LanguagePref): Promise<void> {
  apply(await window.agentswitch.i18n.set(pref))
}

export function useI18n(): I18nState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => state
  )
}

/** 12 秒 · 3 分 5 秒 */
export const fmtDuration = (ms: number): string =>
  ms < 60_000 ? t('time.seconds', { n: Math.max(1, Math.round(ms / 1000)) }) : t('time.minSec', { m: Math.floor(ms / 60_000), s: Math.round((ms % 60_000) / 1000) })

/** 刚刚 · 3 分钟前 · 2 小时前 · 5 天前 */
export function fmtAgo(ts: number): string {
  const s = (Date.now() - ts) / 1000
  if (s < 60) return t('time.justNow')
  if (s < 3600) return t('time.minutesAgo', { n: Math.floor(s / 60) })
  if (s < 86400) return t('time.hoursAgo', { n: Math.floor(s / 3600) })
  return t('time.daysAgo', { n: Math.floor(s / 86400) })
}
