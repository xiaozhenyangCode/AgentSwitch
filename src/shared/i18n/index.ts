import { zhCN } from './zh-CN'
import { en } from './en'
import { ja } from './ja'
import { zhTW } from './zh-TW'

/** UI languages. 'system' follows macOS (first preferred language we support, else English). */
export type Locale = 'zh-CN' | 'en' | 'ja' | 'zh-TW'
export type LanguagePref = 'system' | Locale
export const LOCALES: Locale[] = ['zh-CN', 'en', 'ja', 'zh-TW']
/** Each language's own name (shown untranslated in the picker). */
export const LOCALE_NAMES: Record<Locale, string> = { 'zh-CN': '简体中文', en: 'English', ja: '日本語', 'zh-TW': '繁體中文' }

export type MsgKey = keyof typeof zhCN
export type Dict = Record<MsgKey, string>
export type Vars = Record<string, string | number>

const DICTS: Record<Locale, Dict> = { 'zh-CN': zhCN, en, ja, 'zh-TW': zhTW }

export interface I18nState {
  pref: LanguagePref
  locale: Locale
}

export const isLanguagePref = (v: unknown): v is LanguagePref => v === 'system' || LOCALES.includes(v as Locale)

/** BCP-47 tags from the OS (e.g. zh-Hans-CN, zh-Hant-TW, ja-JP, en-US) -> a supported locale. */
export function matchLocale(tags: readonly string[]): Locale {
  for (const raw of tags) {
    const tag = raw.toLowerCase()
    if (tag.startsWith('zh')) return /hant|-tw|-hk|-mo/.test(tag) ? 'zh-TW' : 'zh-CN'
    if (tag.startsWith('ja')) return 'ja'
    if (tag.startsWith('en')) return 'en'
  }
  return 'en'
}

export const resolveLocale = (pref: LanguagePref, systemTags: readonly string[]): Locale => (pref === 'system' ? matchLocale(systemTags) : pref)

export function translate(locale: Locale, key: MsgKey, vars?: Vars): string {
  const s = DICTS[locale][key] ?? zhCN[key] ?? key
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s
}

/** Model labels carry a "(latest)" suffix in whichever language they were cached in. */
export const stripLatest = (label: string): string => label.replace(/\s*[（(](最新|latest|最新版)[)）]$/i, '')
