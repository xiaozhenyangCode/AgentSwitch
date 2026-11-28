import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { LOCALES, type Locale } from '@shared/i18n'

export interface TranslationCacheEntry {
  text: string
  lastUsedAt: number
}

export interface TranslationCacheFile {
  version: 1
  locales: Partial<Record<Locale, Record<string, TranslationCacheEntry>>>
}

const HOUR = 60 * 60 * 1000
const MAX_AGE = 90 * 24 * HOUR
const MAX_ENTRIES = 5000

export const hashDescription = (raw: string): string => createHash('sha256').update(raw.trim()).digest('hex')

export function pruneCache(data: TranslationCacheFile, now: number): void {
  const retained: { bucket: Record<string, TranslationCacheEntry>; hash: string; lastUsedAt: number }[] = []
  for (const bucket of Object.values(data.locales)) {
    if (!bucket) continue
    for (const [hash, entry] of Object.entries(bucket)) {
      if (now - entry.lastUsedAt > MAX_AGE) delete bucket[hash]
      else retained.push({ bucket, hash, lastUsedAt: entry.lastUsedAt })
    }
  }
  if (retained.length > MAX_ENTRIES) {
    retained.sort((a, b) => a.lastUsedAt - b.lastUsedAt)
    for (const { bucket, hash } of retained.slice(0, retained.length - MAX_ENTRIES)) delete bucket[hash]
  }
}

export class ExtensionTranslationCache {
  private data: TranslationCacheFile = { version: 1, locales: {} }
  private readonly persistedUses = new Map<TranslationCacheEntry, number>()
  private dirty = false
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly path: string) {
    try {
      const stored = JSON.parse(readFileSync(path, 'utf8')) as TranslationCacheFile
      if (stored?.version !== 1) return
      for (const locale of LOCALES) {
        const entries = Object.entries(stored.locales?.[locale] ?? {}).filter(
          ([hash, entry]) => /^[a-f0-9]{64}$/.test(hash) && typeof entry?.text === 'string' && entry.text.trim() && Number.isFinite(entry.lastUsedAt)
        )
        this.data.locales[locale] = Object.fromEntries(entries)
        for (const [, entry] of entries) this.persistedUses.set(entry, entry.lastUsedAt)
      }
    } catch {
      // Missing or unreadable cache: the original descriptions are still available.
    }
  }

  getCachedTranslation(locale: Locale, raw: string, now = Date.now()): string | undefined {
    const entry = this.data.locales[locale]?.[hashDescription(raw)]
    if (!entry || now - entry.lastUsedAt > MAX_AGE) return
    entry.lastUsedAt = Math.max(entry.lastUsedAt, now)
    if (now - (this.persistedUses.get(entry) ?? 0) >= HOUR) this.dirty = true
    if (this.dirty && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined
        try {
          this.flushTranslationCache()
        } catch {
          console.warn('[extensions] Could not save translation cache timestamps')
        }
      }, 10_000)
      this.timer.unref()
    }
    return entry.text
  }

  setCachedTranslations(locale: Locale, entries: Iterable<readonly [string, string]>, now = Date.now()): void {
    const bucket = (this.data.locales[locale] ??= {})
    const previous = { ...bucket }
    for (const [raw, text] of entries) {
      if (raw.trim() && text.trim()) bucket[hashDescription(raw)] = { text: text.trim(), lastUsedAt: now }
    }
    this.dirty = true
    try {
      this.flushTranslationCache(now)
    } catch (error) {
      this.data.locales[locale] = previous
      throw error
    }
  }

  flushTranslationCache(now = Date.now()): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (!this.dirty) return
    const next: TranslationCacheFile = { version: 1, locales: {} }
    for (const locale of LOCALES) {
      const bucket = this.data.locales[locale]
      if (bucket) next.locales[locale] = { ...bucket }
    }
    pruneCache(next, now)
    const tmp = `${this.path}.${randomUUID()}.tmp`
    mkdirSync(dirname(this.path), { recursive: true })
    try {
      writeFileSync(tmp, JSON.stringify(next), { mode: 0o600, flag: 'wx' })
      renameSync(tmp, this.path)
    } finally {
      rmSync(tmp, { force: true })
    }
    this.data = next
    this.persistedUses.clear()
    for (const bucket of Object.values(next.locales)) {
      for (const entry of Object.values(bucket)) this.persistedUses.set(entry, entry.lastUsedAt)
    }
    this.dirty = false
  }
}

let cache: ExtensionTranslationCache | undefined
const userCache = () => (cache ??= new ExtensionTranslationCache(join(app.getPath('userData'), 'extension-translations.json')))
export const getCachedTranslation = (locale: Locale, raw: string, now?: number) => userCache().getCachedTranslation(locale, raw, now)
export const setCachedTranslations = (locale: Locale, entries: Iterable<readonly [string, string]>, now?: number) =>
  userCache().setCachedTranslations(locale, entries, now)
export const flushTranslationCache = () => cache?.flushTranslationCache()

const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u
const SIMPLIFIED = /[简体语说读写译软设发开关长级数导览仓储档与务为实测检构优处调线网选项获动转认后并应据这个让请帮传联旧乐听见边书对齐结闭虑产扩码执编终环录页资帐权启历错误载击换]/gu
const TRADITIONAL = /[簡體語說讀寫譯軟設發開關長級數導覽倉儲檔與務為實測檢構優處調線網選項獲動轉認後併並應據這個讓請幫傳聯舊樂聽見邊書對齊結閉慮產擴碼執編終環錄頁資帳權啟歷錯誤載擊換]/gu

export function needsTranslation(raw: string, locale: Locale): boolean {
  const text = raw.trim().replace(/(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>]+/gi, '')
  if (!/\p{L}/u.test(text)) return false
  const kana = KANA.test(text)
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0
  if (locale === 'en') return kana || han > 0 || /[^\p{Script=Latin}\P{L}]/u.test(text)
  if (locale === 'ja') return !kana
  if (kana || han < 2 || han / (text.match(/\p{L}/gu)?.length ?? 1) < 0.25) return true
  const simplified = text.match(SIMPLIFIED)?.length ?? 0
  const traditional = text.match(TRADITIONAL)?.length ?? 0
  return locale === 'zh-CN' ? traditional > simplified : simplified > traditional
}
