import { execFile } from 'node:child_process'
import { randomInt, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { net } from 'electron'
import type { Locale } from '@shared/i18n'
import type { ExtTranslateProgressEvent, ExtTranslateRequest, ExtTranslateResult, TranslationProvider } from '@shared/types'
import { getBaseEnv } from './shellEnv'
import { i18nState } from './i18n'
import { collectUntranslatedDescriptions } from './extensions'
import { setCachedTranslations } from './extensionTranslationCache'

export const GOOGLE_LANGUAGE: Record<Locale, string> = { 'zh-CN': 'zh-CN', 'zh-TW': 'zh-TW', ja: 'ja', en: 'en' }
export const MICROSOFT_LANGUAGE: Record<Locale, string> = { 'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant', ja: 'ja', en: 'en' }

interface HttpRequest {
  url: string
  method: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  timeoutMs: number
  signal: AbortSignal
}

interface HttpResponse {
  status: number
  text: string
}

export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>

const httpTransport: HttpTransport = async ({ url, method, headers, body, timeoutMs, signal }) => {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
  let env = { ...process.env }
  try {
    env = { ...getBaseEnv(), ...env }
  } catch {
    // Login-shell environment may still be initializing.
  }
  const proxy = env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY || env.all_proxy || env.ALL_PROXY
  if (proxy && process.platform !== 'win32') {
    // Supply headers and body over stdin so descriptions and the bearer token stay out of argv.
    const config = Object.entries(headers ?? {}).map(([key, value]) => `header = ${JSON.stringify(`${key}: ${value}`)}`)
    if (body !== undefined) config.push(`data-binary = ${JSON.stringify(body)}`)
    return new Promise((resolve, reject) => {
      const child = execFile('/usr/bin/curl', [
        '--disable', '--silent', '--show-error', '--compressed', '--max-time', String(timeoutMs / 1000),
        '--request', method, '--write-out', '\n%{http_code}', '--config', '-', url
      ], { env: { ...env, https_proxy: proxy }, signal: requestSignal, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
        if (error) return reject(new Error('Translation request failed'))
        const split = stdout.lastIndexOf('\n')
        const status = Number(split >= 0 ? stdout.slice(split + 1).trim() : '') || 0
        resolve({ status, text: split >= 0 ? stdout.slice(0, split) : stdout })
      })
      child.stdin?.on('error', reject)
      child.stdin?.end(config.join('\n'))
    })
  }

  const response = await net.fetch(url, { method, headers, body, signal: requestSignal, credentials: 'omit', redirect: 'error' })
  return { status: response.status, text: await response.text() }
}

class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`Translation request returned HTTP ${status}`)
  }
}

const MAX_BATCH_ITEMS = 25
const MAX_BATCH_CHARS = 3000
const ANCHOR_LENGTH = 22

interface DescriptionPart {
  raw: string
  text: string
  last: boolean
}

function* splitDescription(raw: string): Generator<DescriptionPart> {
  let remaining = raw
  while (remaining.length > MAX_BATCH_CHARS) {
    const window = remaining.slice(0, MAX_BATCH_CHARS)
    const boundary = Math.max(window.lastIndexOf(' '), window.lastIndexOf('\n'))
    let end = boundary >= MAX_BATCH_CHARS / 2 ? boundary : MAX_BATCH_CHARS
    if (/[\uD800-\uDBFF]/.test(remaining[end - 1])) end--
    yield { raw, text: remaining.slice(0, end), last: false }
    remaining = remaining.slice(end).trimStart()
  }
  if (remaining) yield { raw, text: remaining, last: true }
}

function* batches(descriptions: string[]): Generator<DescriptionPart[]> {
  let batch: DescriptionPart[] = []
  let chars = 0
  for (const raw of descriptions) {
    for (const part of splitDescription(raw)) {
      if (batch.length === MAX_BATCH_ITEMS || chars + ANCHOR_LENGTH + part.text.length > MAX_BATCH_CHARS) {
        if (batch.length) yield batch
        batch = []
        chars = 0
      }
      chars += (batch.length ? ANCHOR_LENGTH : 0) + part.text.length
      batch.push(part)
    }
  }
  if (batch.length) yield batch
}

const nonemptyStrings = (values: unknown[]): values is string[] => values.every((value) => typeof value === 'string' && !!value.trim())

function unpackGoogle(text: string, anchors: string[]): string[] | undefined {
  const parts = text.split(/\[===([0-9]{12})===\]/)
  const markers = parts.filter((_, index) => index % 2 === 1)
  if (markers.length !== anchors.length || markers.some((marker, index) => marker !== anchors[index])) return
  const translations = parts.filter((_, index) => index % 2 === 0).map((part) => part.trim())
  if (!nonemptyStrings(translations) || translations.some((part) => anchors.some((anchor) => part.includes(anchor)))) return
  return translations
}

type Progress = Pick<ExtTranslateResult, 'done' | 'translated' | 'provider'>

export class ExtensionTranslator {
  private token?: { value: string; expires: number }

  constructor(private readonly transport: HttpTransport = httpTransport, private readonly intervalMs = 200) {}

  private async request(signal: AbortSignal, request: Omit<HttpRequest, 'signal' | 'timeoutMs'>): Promise<string> {
    signal.throwIfAborted()
    const { status, text } = await this.transport({ ...request, signal, timeoutMs: 8000 })
    signal.throwIfAborted()
    if (status < 200 || status >= 300) throw new HttpStatusError(status)
    return text
  }

  private async google(text: string, locale: Locale, signal: AbortSignal): Promise<string> {
    const response = await this.request(signal, {
      method: 'POST',
      url: `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${GOOGLE_LANGUAGE[locale]}&dt=t`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ q: text }).toString()
    })
    const segments: unknown = JSON.parse(response)?.[0]
    if (!Array.isArray(segments) || !segments.length || segments.some((segment) => !Array.isArray(segment) || typeof segment[0] !== 'string')) {
      throw new Error('Invalid Google translation response')
    }
    const translated = segments.map((segment) => segment[0]).join('').trim()
    if (!translated) throw new Error('Empty Google translation response')
    return translated
  }

  private async googleBatch(texts: string[], locale: Locale, signal: AbortSignal): Promise<string[]> {
    if (texts.length === 1) return [await this.google(texts[0], locale, signal)]

    let base: number
    do {
      base = randomInt(100_000_000_000, 999_999_999_900)
    } while (texts.some((text) => text.includes(String(base).slice(0, 10))))
    const anchors = texts.slice(1).map((_, index) => String(base + index))
    const packed = texts.map((text, index) => index ? `\n[===${anchors[index - 1]}===]\n${text}` : text).join('')
    const unpacked = unpackGoogle(await this.google(packed, locale, signal), anchors)
    if (unpacked) return unpacked

    const translated: string[] = []
    for (const text of texts) translated.push(await this.google(text, locale, signal))
    return translated
  }

  private async microsoftToken(signal: AbortSignal): Promise<string> {
    if (this.token && this.token.expires > Date.now()) return this.token.value
    const value = (await this.request(signal, { method: 'GET', url: 'https://edge.microsoft.com/translate/auth' })).trim()
    if (!/^[\w.-]+$/.test(value)) throw new Error('Invalid Microsoft translation token')
    let expires = Date.now() + 8 * 60_000
    try {
      const payload = JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString('utf8'))
      if (typeof payload.exp === 'number' && Number.isFinite(payload.exp)) expires = payload.exp * 1000 - 60_000
    } catch {
      // Opaque tokens use the conservative lifetime above.
    }
    this.token = { value, expires }
    return value
  }

  private async microsoftBatch(texts: string[], locale: Locale, signal: AbortSignal, retry = true): Promise<string[]> {
    const token = await this.microsoftToken(signal)
    try {
      const response = await this.request(signal, {
        method: 'POST',
        url: `https://api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0&to=${MICROSOFT_LANGUAGE[locale]}`,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(texts.map((Text) => ({ Text })))
      })
      const items: unknown = JSON.parse(response)
      const translated = Array.isArray(items) ? items.map((item) => item?.translations?.[0]?.text) : []
      if (translated.length !== texts.length || !nonemptyStrings(translated)) throw new Error('Invalid Microsoft translation response')
      return translated
    } catch (error) {
      if (error instanceof HttpStatusError && (error.status === 401 || error.status === 403)) {
        this.token = undefined
        if (retry) return this.microsoftBatch(texts, locale, signal, false)
      }
      throw error
    }
  }

  async translate(
    descriptions: string[],
    locale: Locale,
    signal: AbortSignal,
    save: (entries: ReadonlyMap<string, string>) => void,
    onProgress: (progress: Progress) => void
  ): Promise<void> {
    let provider: TranslationProvider = 'google'
    let done = 0
    let partial: string[] = []
    for (const batch of batches(descriptions)) {
      if (done || partial.length) {
        if (this.intervalMs) await delay(this.intervalMs, undefined, { signal })
      }
      const texts = batch.map(({ text }) => text)
      let translated: string[]
      if (provider === 'google') {
        try {
          translated = await this.googleBatch(texts, locale, signal)
        } catch {
          signal.throwIfAborted()
          translated = await this.microsoftBatch(texts, locale, signal)
          provider = 'microsoft'
        }
      } else {
        translated = await this.microsoftBatch(texts, locale, signal)
      }
      signal.throwIfAborted()
      const completed = new Map<string, string>()
      batch.forEach(({ raw, last }, index) => {
        partial.push(translated[index].trim())
        if (last) {
          completed.set(raw, partial.join(' '))
          partial = []
        }
      })
      if (completed.size) save(completed)
      done += completed.size
      onProgress({ done, translated: done, provider })
    }
  }
}

const translator = new ExtensionTranslator()
let active: { controller: AbortController; result: ExtTranslateResult } | undefined

export async function startExtensionTranslation(
  request: ExtTranslateRequest,
  publish: (event: ExtTranslateProgressEvent) => void
): Promise<ExtTranslateResult> {
  const locale = request.locale ?? i18nState().locale
  if (active) return { ...active.result, status: 'busy' }
  const result: ExtTranslateResult = { runId: randomUUID(), locale, status: 'noop', done: 0, total: 0, translated: 0 }
  const controller = new AbortController()
  active = { controller, result }

  const emit = (status: ExtTranslateProgressEvent['status']) => publish({ ...result, status, profileId: request.profileId })
  try {
    const pending = collectUntranslatedDescriptions(request.profileId, request.cwd, locale)
    result.total = pending.length
    if (!result.total) return result
    emit('running')
    await translator.translate(pending, locale, controller.signal, (entries) => {
      try {
        setCachedTranslations(locale, entries)
      } catch {
        throw new TranslationCacheWriteError()
      }
    }, (progress) => {
      Object.assign(result, progress)
      emit('running')
    })
    result.status = 'done'
  } catch (error) {
    result.status = controller.signal.aborted ? 'cancelled' : 'error'
    if (result.status === 'error') result.error = error instanceof TranslationCacheWriteError ? 'cache-write' : 'translation-unavailable'
  } finally {
    active = undefined
  }
  emit(result.status)
  return result
}

class TranslationCacheWriteError extends Error {}

export function cancelExtensionTranslation(): void {
  active?.controller.abort()
}
