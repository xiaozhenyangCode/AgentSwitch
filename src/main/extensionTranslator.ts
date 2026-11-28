import { execFile } from 'node:child_process'
import { randomInt, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { net } from 'electron'
import type { Locale } from '@shared/i18n'
import type { ExtTranslateProgressEvent, ExtTranslateRequest, ExtTranslateResult, TranslationProvider, TranslationProviderDiagnostic } from '@shared/types'
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
  followRedirects?: boolean
  timeoutMs: number
  signal: AbortSignal
}

interface HttpResponse {
  status: number
  text: string
  url?: string
}

export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>

const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const EDGE_UA = `${CHROME_UA} Edg/131.0.0.0`
const FORM = 'application/x-www-form-urlencoded;charset=UTF-8'
const BING_PAGE = 'https://cn.bing.com/translator'
const TIMEOUT_MS = 12_000

class TranslationRequestError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number, readonly bodySnippet?: string) {
    super(message)
  }
}

// Provider error pages can echo descriptions, credentials or request URLs. Retain only known public error phrases.
function safeBodySnippet(body: string): string | undefined {
  const plain = body.slice(0, 8192)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
  const phrases = plain.match(/\b(?:sorry\.{0,3}|too many requests|unusual traffic|rate limit exceeded|service unavailable|internal server error|bad gateway|gateway timeout|payload too large|request[- ]uri too long|uri too long|forbidden|access denied|unauthorized|bad request|not found|invalid request|invalid credentials)\b\.{0,3}/gi)
  return phrases?.map((value) => value.trim()).filter((value, i, values) => values.indexOf(value) === i).join(' · ').slice(0, 120) || undefined
}

function httpError(status: number, body: string): TranslationRequestError {
  return new TranslationRequestError(`HTTP ${status}`, undefined, status, safeBodySnippet(body))
}

const NETWORK_MESSAGES: Record<string, string> = {
  TIMEOUT: 'Request timed out',
  ENOTFOUND: 'Could not resolve the translation service',
  EPROXYDNS: 'Could not resolve the configured proxy',
  ECONNREFUSED: 'Connection was refused',
  ECONNFAILED: 'Could not connect to the translation service or proxy',
  ECONNRESET: 'Connection was reset',
  ENETUNREACH: 'Network is unreachable',
  TLS_ERROR: 'Secure connection failed',
  REDIRECT_LIMIT: 'Too many redirects',
  INVALID_HTTP_RESPONSE: 'Invalid HTTP response',
  NETWORK_ERROR: 'Network request failed'
}

const CURL_CODES: Record<number, string> = { 5: 'EPROXYDNS', 6: 'ENOTFOUND', 7: 'ECONNFAILED', 28: 'TIMEOUT', 35: 'TLS_ERROR', 47: 'REDIRECT_LIMIT', 56: 'ECONNRESET', 60: 'TLS_ERROR' }
const CHROMIUM_CODES: Record<string, string> = {
  ERR_NAME_NOT_RESOLVED: 'ENOTFOUND', ERR_TIMED_OUT: 'TIMEOUT', ERR_CONNECTION_TIMED_OUT: 'TIMEOUT',
  ERR_CONNECTION_REFUSED: 'ECONNREFUSED', ERR_CONNECTION_FAILED: 'ECONNFAILED',
  ERR_PROXY_CONNECTION_FAILED: 'ECONNFAILED', ERR_TUNNEL_CONNECTION_FAILED: 'ECONNFAILED',
  ERR_CONNECTION_RESET: 'ECONNRESET', ERR_INTERNET_DISCONNECTED: 'ENETUNREACH', ERR_ADDRESS_UNREACHABLE: 'ENETUNREACH',
  ERR_TOO_MANY_REDIRECTS: 'REDIRECT_LIMIT', ERR_SSL_PROTOCOL_ERROR: 'TLS_ERROR'
}

function networkError(error: unknown, timedOut = false, curlStderr = ''): TranslationRequestError {
  if (error instanceof TranslationRequestError) return error
  const err = error as { code?: string | number; name?: string; message?: string; cause?: { code?: string } } | null
  const raw = err?.cause?.code ?? err?.code
  const chromium = typeof err?.message === 'string' ? /\bnet::(ERR_[A-Z_]+)\b/.exec(err.message)?.[1] : undefined
  let code = typeof raw === 'number' ? CURL_CODES[raw] : raw
  if (raw === 7 && /connection refused/i.test(curlStderr)) code = 'ECONNREFUSED'
  if (chromium) code = CHROMIUM_CODES[chromium] ?? (/^ERR_CERT_/.test(chromium) ? 'TLS_ERROR' : undefined)
  if (typeof code === 'string' && /^ERR_/.test(code)) code = CHROMIUM_CODES[code]
  if (timedOut || err?.name === 'TimeoutError' || code === 'ETIMEDOUT') code = 'TIMEOUT'
  if (!code || !Object.hasOwn(NETWORK_MESSAGES, code)) code = 'NETWORK_ERROR'
  return new TranslationRequestError(NETWORK_MESSAGES[code], code)
}

function bingEndpoint(url: string): URL {
  const endpoint = URL.parse(url)
  if (!endpoint || endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.port ||
      (endpoint.hostname !== 'bing.com' && !endpoint.hostname.endsWith('.bing.com'))) {
    throw new TranslationRequestError('Bing redirected outside its HTTPS domain', 'UNSAFE_REDIRECT')
  }
  return endpoint
}

/** net.fetch does not reliably expose Response.url. Track Bing's redirect targets before following. */
function fetchBingPage(url: string, headers: HttpRequest['headers'], signal: AbortSignal): Promise<HttpResponse> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    let current = bingEndpoint(url)
    let redirects = 0
    const request = net.request({ url: current.href, method: 'GET', credentials: 'omit', redirect: 'manual', headers })
    const abort = () => {
      reject(signal.reason)
      request.abort()
    }
    signal.addEventListener('abort', abort, { once: true })
    request.once('close', () => signal.removeEventListener('abort', abort))
    request.on('redirect', (_status, _method, nextUrl) => {
      try {
        if (++redirects > 3) throw networkError({ code: 'REDIRECT_LIMIT' })
        current = bingEndpoint(nextUrl)
        request.followRedirect()
      } catch (error) {
        reject(error)
        request.abort()
      }
    })
    request.once('error', reject)
    request.once('response', (response) => {
      const body: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 12 * 1024 * 1024) {
          reject(networkError({ code: 'INVALID_HTTP_RESPONSE' }))
          request.abort()
        } else body.push(chunk)
      })
      response.once('error', reject)
      response.once('end', () => resolve({ status: response.statusCode, text: Buffer.concat(body).toString('utf8'), url: current.href }))
    })
    request.end()
  })
}

const httpTransport: HttpTransport = async ({ url, method, headers, body, timeoutMs, signal, followRedirects }) => {
  const timeout = AbortSignal.timeout(timeoutMs)
  const requestSignal = AbortSignal.any([signal, timeout])
  let env = { ...process.env }
  try {
    env = { ...getBaseEnv(), ...env }
  } catch {
    // The login shell may still be initializing.
  }
  const proxy = env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY || env.all_proxy || env.ALL_PROXY
  try {
    if (proxy && process.platform !== 'win32') {
      // Keep form data, including short-lived Bing credentials, out of argv.
      const config = Object.entries(headers ?? {}).map(([key, value]) => `header = ${JSON.stringify(`${key}: ${value}`)}`)
      if (body !== undefined) config.push(`data-binary = ${JSON.stringify(body)}`)
      return await new Promise<HttpResponse>((resolve, reject) => {
        const child = execFile('/usr/bin/curl', [
          '--disable', '--silent', '--show-error', '--compressed', '--max-time', String(timeoutMs / 1000),
          '--proto', '=https', '--request', method,
          ...(followRedirects ? ['--location', '--max-redirs', '3', '--proto-redir', '=https'] : []),
          '--write-out', '\n%{http_code}\n%{url_effective}', '--config', '-', url
        ], { env: { ...env, https_proxy: proxy }, signal: requestSignal, maxBuffer: 12 * 1024 * 1024 }, (error, stdout, stderr) => {
          if (error) {
            const proxyStatus = /(?:CONNECT tunnel failed, response |Received HTTP code )([45]\d\d)/i.exec(stderr)?.[1]
            return reject(proxyStatus ? httpError(Number(proxyStatus), '') : networkError(error, timeout.aborted, stderr))
          }
          const trailer = /\n(\d{3})\n([^\r\n]+)$/.exec(stdout)
          if (!trailer) return reject(networkError({ code: 'INVALID_HTTP_RESPONSE' }))
          resolve({ status: Number(trailer[1]), text: stdout.slice(0, trailer.index), url: trailer[2] })
        })
        // The process callback has the real curl exit code even if stdin closes early.
        child.stdin?.on('error', () => {})
        child.stdin?.end(config.join('\n'))
      })
    }

    if (followRedirects) return await fetchBingPage(url, headers, requestSignal)
    const response = await net.fetch(url, { method, headers, body, signal: requestSignal, credentials: 'omit', redirect: 'error' })
    return { status: response.status, text: await response.text(), url: response.url }
  } catch (error) {
    signal.throwIfAborted()
    throw networkError(error, timeout.aborted)
  }
}

const MAX_BATCH_ITEMS = 10
const MAX_BATCH_CHARS = 1500
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

function unpackBing(text: string, anchors: string[]): string[] | undefined {
  const parts = text.split(/\[===([0-9]{12})===\]/)
  const markers = parts.filter((_, index) => index % 2 === 1)
  if (markers.length !== anchors.length || markers.some((marker, index) => marker !== anchors[index])) return
  const translations = parts.filter((_, index) => index % 2 === 0).map((part) => part.trim())
  if (!nonemptyStrings(translations) || translations.some((part) => anchors.some((anchor) => part.includes(anchor)))) return
  return translations
}

type Progress = Pick<ExtTranslateResult, 'done' | 'translated' | 'provider' | 'detail' | 'diagnostics'>

function providerDiagnostic(provider: TranslationProvider, error: unknown): TranslationProviderDiagnostic {
  const failure = networkError(error)
  const { code, status, bodySnippet, message } = failure
  return { provider, ...(status !== undefined && { status }), ...(code && { code }), message, ...(bodySnippet && { bodySnippet }) }
}

function summarize(diagnostics: TranslationProviderDiagnostic[]): string {
  return diagnostics.map(({ provider, status, code, message }) =>
    `${provider === 'google' ? 'Google' : 'Microsoft'}: ${status ? `HTTP ${status}` : code ? `${code} · ${message}` : message}`).join(' / ')
}

class ProvidersUnavailableError extends Error {
  constructor(readonly diagnostics: TranslationProviderDiagnostic[]) {
    super(summarize(diagnostics))
  }
}

function parseResponse(text: string, message: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new TranslationRequestError(message, 'INVALID_JSON')
  }
}

interface BingCredentials {
  origin: string
  ig: string
  iid: string
  key: string
  token: string
  expires: number
  seq: number
}

function bingCredentials(response: HttpResponse): BingCredentials {
  const endpoint = bingEndpoint(response.url ?? '')
  const ig = /\bIG\s*:\s*"([\w-]+)"/.exec(response.text)?.[1]
  const iid = /\bdata-iid="([\w.-]+)"/.exec(response.text)?.[1]
  const params = /\bparams_AbusePreventionHelper\s*=\s*(\[[^\]\r\n]{1,8192}\])/.exec(response.text)?.[1]
  const values = params ? parseResponse(params, 'Bing returned invalid translator page settings') : undefined
  if (!ig || !iid || !Array.isArray(values)) {
    throw new TranslationRequestError('Bing translator page is missing session settings', 'BING_SESSION')
  }
  const [key, token, ttl] = values
  if (!((typeof key === 'number' && Number.isSafeInteger(key)) || (typeof key === 'string' && /^\d+$/.test(key))) ||
      typeof token !== 'string' || !token.trim() || typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) {
    throw new TranslationRequestError('Bing returned invalid translator session settings', 'BING_SESSION')
  }
  return { origin: endpoint.origin, ig, iid, key: String(key), token, expires: Date.now() + Math.min(ttl, 3_600_000) - 60_000, seq: 0 }
}

function packBing(texts: string[]): { text: string; anchors: string[] } {
  let base: number
  do {
    base = randomInt(100_000_000_000, 999_999_999_900)
  } while (texts.some((text) => text.includes(String(base).slice(0, 10))))
  const anchors = texts.slice(1).map((_, index) => String(base + index))
  const text = texts.map((item, index) => index ? `\n[===${anchors[index - 1]}===]\n${item}` : item).join('')
  return { text, anchors }
}

export class ExtensionTranslator {
  private bingSession?: BingCredentials

  constructor(private readonly transport: HttpTransport = httpTransport, private readonly intervalMs = 200) {}

  private async request(signal: AbortSignal, request: Omit<HttpRequest, 'signal' | 'timeoutMs'>): Promise<HttpResponse> {
    signal.throwIfAborted()
    const response = await this.transport({ ...request, signal, timeoutMs: TIMEOUT_MS })
    signal.throwIfAborted()
    if (response.status < 200 || response.status >= 300) throw httpError(response.status, response.text)
    return response
  }

  private async google(texts: string[], locale: Locale, signal: AbortSignal): Promise<unknown[]> {
    const form = new URLSearchParams()
    for (const text of texts) form.append('q', text)
    const response = await this.request(signal, {
      method: 'POST',
      url: `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=${GOOGLE_LANGUAGE[locale]}`,
      headers: { 'User-Agent': CHROME_UA, 'Content-Type': FORM },
      body: form.toString()
    })
    const data = parseResponse(response.text, 'Google returned invalid translation JSON')
    if (!Array.isArray(data)) throw new TranslationRequestError('Google returned an unexpected translation response', 'GOOGLE_RESPONSE')
    return data.map((item) => Array.isArray(item) ? item[0] : item)
  }

  private async googleBatch(texts: string[], locale: Locale, signal: AbortSignal): Promise<string[]> {
    const translated = await this.google(texts, locale, signal)
    if (translated.length === texts.length && nonemptyStrings(translated)) return translated
    if (texts.length === 1) throw new TranslationRequestError('Google returned an empty or mismatched translation', 'GOOGLE_RESPONSE')

    const result: string[] = []
    for (const text of texts) result.push((await this.googleBatch([text], locale, signal))[0])
    return result
  }

  private async getBingSession(signal: AbortSignal): Promise<BingCredentials> {
    if (this.bingSession && this.bingSession.expires > Date.now()) return this.bingSession
    const response = await this.request(signal, {
      method: 'GET', url: BING_PAGE, followRedirects: true,
      headers: { 'User-Agent': EDGE_UA, 'Accept-Language': 'en-US,en;q=0.9' }
    })
    return this.bingSession = bingCredentials(response)
  }

  private async bing(text: string, locale: Locale, signal: AbortSignal, retry = true): Promise<string> {
    try {
      const session = await this.getBingSession(signal)
      const { origin, ig, iid, key, token } = session
      const seq = ++session.seq
      const query = new URLSearchParams({ isVertical: '1', IG: ig, IID: `${iid}.${seq}` })
      const response = await this.request(signal, {
        method: 'POST', url: `${origin}/ttranslatev3?${query}`, followRedirects: false,
        headers: { 'User-Agent': EDGE_UA, 'Content-Type': FORM, Origin: origin, Referer: `${origin}/translator` },
        body: new URLSearchParams({ fromLang: 'auto-detect', text, to: MICROSOFT_LANGUAGE[locale], token, key }).toString()
      })
      const data = parseResponse(response.text, 'Bing returned invalid translation JSON')
      for (const item of Array.isArray(data) ? data : [data]) {
        const status = Number(item?.statusCode)
        if (Number.isInteger(status) && status >= 400 && status <= 599) throw httpError(status, response.text)
      }
      const translated = Array.isArray(data) && data[0]?.translations?.[0]?.text
      if (typeof translated !== 'string' || !translated.trim()) {
        throw new TranslationRequestError('Bing returned an empty or unexpected translation', 'BING_RESPONSE')
      }
      return translated
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof TranslationRequestError && (error.status === 401 || error.status === 403)) {
        this.bingSession = undefined
        if (retry) return this.bing(text, locale, signal, false)
      }
      throw error
    }
  }

  private async microsoftBatch(texts: string[], locale: Locale, signal: AbortSignal): Promise<string[]> {
    if (texts.length === 1) return [await this.bing(texts[0], locale, signal)]
    const { text, anchors } = packBing(texts)
    const unpacked = unpackBing(await this.bing(text, locale, signal), anchors)
    if (unpacked) return unpacked

    const result: string[] = []
    for (const item of texts) result.push(await this.bing(item, locale, signal))
    return result
  }

  async translate(
    descriptions: string[],
    locale: Locale,
    signal: AbortSignal,
    save: (entries: ReadonlyMap<string, string>) => void,
    onProgress: (progress: Progress) => void
  ): Promise<void> {
    let provider: TranslationProvider = 'google'
    let googleFailure: TranslationProviderDiagnostic | undefined
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
        } catch (error) {
          signal.throwIfAborted()
          googleFailure = providerDiagnostic('google', error)
          provider = 'microsoft'
          translated = await this.translateWithFallback(texts, locale, signal, googleFailure)
          console.warn('[extensions] using Microsoft description translation for this run', googleFailure)
        }
      } else {
        translated = await this.translateWithFallback(texts, locale, signal, googleFailure)
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
      const diagnostics = googleFailure ? [googleFailure] : undefined
      onProgress({ done, translated: done, provider, ...(diagnostics && { diagnostics, detail: summarize(diagnostics) }) })
    }
  }

  private async translateWithFallback(texts: string[], locale: Locale, signal: AbortSignal, googleFailure?: TranslationProviderDiagnostic) {
    try {
      return await this.microsoftBatch(texts, locale, signal)
    } catch (error) {
      signal.throwIfAborted()
      throw new ProvidersUnavailableError([
        ...(googleFailure ? [googleFailure] : []), providerDiagnostic('microsoft', error)
      ])
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
    if (result.status === 'error') {
      result.error = error instanceof TranslationCacheWriteError ? 'cache-write' : 'translation-unavailable'
      if (error instanceof ProvidersUnavailableError) {
        result.diagnostics = error.diagnostics
        result.detail = error.message
      }
      const { done, total, diagnostics } = result
      console.error('[extensions] description translation failed', { locale, done, total, diagnostics })
    }
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
