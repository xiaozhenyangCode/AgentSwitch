import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExtensionTranslator, cancelExtensionTranslation, startExtensionTranslation, type HttpTransport } from './extensionTranslator'

const mocks = vi.hoisted(() => ({ collect: vi.fn(), save: vi.fn(), fetch: vi.fn(), request: vi.fn(), curl: vi.fn() }))
vi.mock('electron', () => ({ net: { fetch: mocks.fetch, request: mocks.request } }))
vi.mock('node:child_process', () => ({ execFile: mocks.curl }))
vi.mock('./extensions', () => ({ collectUntranslatedDescriptions: mocks.collect }))
vi.mock('./extensionTranslationCache', () => ({ setCachedTranslations: mocks.save }))
vi.mock('./shellEnv', () => ({ getBaseEnv: () => ({}) }))

const reply = (payload: unknown) => ({ status: 200, text: JSON.stringify(payload) })
const form = (body: string | undefined) => new URLSearchParams(body)
const googleInputs = (body: string | undefined) => form(body).getAll('q')
const googleReply = (body: string | undefined) => reply(googleInputs(body).map((text) => [`G ${text}`, 'en']))
const bingReply = (body: string | undefined) => reply([{ translations: [{ text: `MS ${form(body).get('text')}` }] }])
const googleHost = 'clients5.google.com'
const bingOrigin = 'https://www.bing.com'
const bootstrap = (token = 'fixture-token', url = `${bingOrigin}/translator`) => ({
  status: 200, url, text: `<div data-iid="translator.test"></div><script>var x={IG:"TEST-IG"}; var params_AbusePreventionHelper = [1770000000000,"${token}",3600000];</script>`
})
const many = (count: number) => Array.from({ length: count }, (_, index) => `Description ${index}`)
const liveSignal = () => new AbortController().signal
const removeProxy = () => {
  for (const key of ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY']) vi.stubEnv(key, '')
}
const request = { profileId: 'codex-test', cwd: null, locale: 'ja' } as const

function mockBingPage(publish: (client: EventEmitter) => void) {
  const client = Object.assign(new EventEmitter(), {
    followRedirect: vi.fn(), abort: vi.fn(), end: () => queueMicrotask(() => publish(client))
  })
  mocks.request.mockReturnValueOnce(client)
  return client
}


afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

describe('Google translation', () => {
  it.each([
    ['zh-CN', 'zh-CN', 'zh-Hans'], ['zh-TW', 'zh-TW', 'zh-Hant'], ['ja', 'ja', 'ja'], ['en', 'en', 'en']
  ] as const)('sends %s as %s to Google and %s to Bing on fallback', async (locale, googleCode, microsoftCode) => {
    const transport = vi.fn<HttpTransport>().mockResolvedValueOnce({ status: 429, text: '' })
      .mockResolvedValueOnce(bootstrap()).mockImplementation(async ({ body }) => bingReply(body))
    const save = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await new ExtensionTranslator(transport, 0).translate(['source'], locale, liveSignal(), save, vi.fn())
    const [google, page, bing] = transport.mock.calls.map(([call]) => call)
    expect(new URL(google.url).searchParams.get('tl')).toBe(googleCode)
    expect(new URL(google.url).hostname).toBe(googleHost)
    expect(google).toMatchObject({ method: 'POST', timeoutMs: 12_000, headers: { 'User-Agent': expect.stringContaining('Chrome/') } })
    expect(page).toMatchObject({ method: 'GET', url: 'https://cn.bing.com/translator', followRedirects: true })
    expect(form(bing.body).get('to')).toBe(microsoftCode)
    expect(bing).toMatchObject({ method: 'POST', followRedirects: false, headers: {
      Origin: bingOrigin, Referer: `${bingOrigin}/translator`, 'User-Agent': expect.stringContaining('Edg/')
    } })
    expect(save).toHaveBeenCalledWith(new Map([['source', 'MS source']]))
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ provider: 'google', status: 429 }))
  })

  it('sends repeatable q fields and accepts translated strings and language pairs in the same batch', async () => {
    const src = ['A&B + 20% / ?', '画像処理\n手順']
    const transport = vi.fn<HttpTransport>().mockResolvedValueOnce(reply([['first', 'en'], 'second']))
    const save = vi.fn()
    await new ExtensionTranslator(transport, 0).translate(src, 'en', liveSignal(), save, vi.fn())
    const call = transport.mock.calls[0][0]
    expect(call.url).toContain('client=dict-chrome-ex&sl=auto&tl=en')
    expect(call.headers?.['Content-Type']).toBe('application/x-www-form-urlencoded;charset=UTF-8')
    expect(call.body).toContain('A%26B+%2B+20%25')
    expect(googleInputs(call.body)).toEqual(src)
    expect(save).toHaveBeenCalledWith(new Map([[src[0], 'first'], [src[1], 'second']]))
  })

  it('retries one item at a time on count mismatch or an empty item', async () => {
    for (const unexpected of [['one'], ['one', '', 'three']]) {
      const src = many(3)
      const transport = vi.fn<HttpTransport>().mockResolvedValueOnce(reply(unexpected))
        .mockImplementation(async ({ body }) => reply([`result ${googleInputs(body)[0]}`]))
      const save = vi.fn()
      await new ExtensionTranslator(transport, 0).translate(src, 'zh-CN', liveSignal(), save, vi.fn())
      expect(transport.mock.calls.map(([call]) => googleInputs(call.body))).toEqual([src, ...src.map((text) => [text])])
      expect(save).toHaveBeenCalledWith(new Map(src.map((text) => [text, `result ${text}`])))
    }
  })

  it('limits each batch to ten items and 1500 characters and splits long descriptions safely', async () => {
    const descriptions = [...many(12), ...many(8).map((text) => text.padEnd(600, 'x')), 'a'.repeat(2999) + '🙂']
    const transport = vi.fn<HttpTransport>(async ({ body }) => {
      const texts = googleInputs(body)
      expect(texts.length).toBeLessThanOrEqual(10)
      expect(texts.join('').length).toBeLessThanOrEqual(1500)
      expect(texts.join(' ')).not.toContain('�')
      return googleReply(body)
    })
    const save = vi.fn()
    await new ExtensionTranslator(transport, 0).translate(descriptions, 'ja', liveSignal(), save, vi.fn())
    expect(googleInputs(transport.mock.calls[0][0].body)).toHaveLength(10)
    expect(save.mock.calls.flatMap(([entries]) => [...entries.keys()])).toEqual(descriptions)
  })
})

describe('Bing fallback', () => {
  it('sends credentials only to the redirected Bing origin, reuses them, and stays on Bing for the run', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const transport = vi.fn<HttpTransport>(async ({ url, method, body }) => {
      if (url.includes(googleHost)) throw Object.assign(new Error('private URL'), { code: 'ETIMEDOUT' })
      if (method === 'GET') return bootstrap()
      const parsed = new URL(url)
      expect(parsed.origin).toBe(bingOrigin)
      expect(parsed.pathname).toBe('/ttranslatev3')
      expect(parsed.searchParams.get('IG')).toBe('TEST-IG')
      expect(parsed.searchParams.get('isVertical')).toBe('1')
      expect(form(body).get('token')).toBe('fixture-token')
      expect(form(body).get('key')).toBe('1770000000000')
      expect(form(body).get('fromLang')).toBe('auto-detect')
      expect(form(body).get('text')!.length).toBeLessThanOrEqual(1500)
      return bingReply(body)
    })
    const progress = vi.fn()
    const save = vi.fn()
    await new ExtensionTranslator(transport, 0).translate(many(22), 'ja', liveSignal(), save, progress)
    expect(transport.mock.calls.map(([call]) => new URL(call.url).hostname)).toEqual([googleHost, 'cn.bing.com', ...Array(3).fill('www.bing.com')])
    expect(transport.mock.calls.slice(2).map(([call]) => new URL(call.url).searchParams.get('IID')))
      .toEqual(['translator.test.1', 'translator.test.2', 'translator.test.3'])
    expect(save.mock.calls.map(([entries]) => entries.size)).toEqual([10, 10, 2])
    expect(progress.mock.lastCall?.[0]).toMatchObject({ done: 22, provider: 'microsoft', diagnostics: [{ provider: 'google', code: 'TIMEOUT' }] })
  })

  it.each(['https://bing.com.evil.example/translator', 'http://www.bing.com/translator', 'https://user:password@www.bing.com/translator', ''])(
    'rejects an unsafe Bing redirect %j before sending any credentials', async (url) => {
      const transport = vi.fn<HttpTransport>().mockResolvedValueOnce({ status: 429, text: '' }).mockResolvedValueOnce(bootstrap('token', url))
      await expect(new ExtensionTranslator(transport, 0).translate(['sample'], 'en', liveSignal(), vi.fn(), vi.fn()))
        .rejects.toMatchObject({ diagnostics: [{ provider: 'google', status: 429 }, { provider: 'microsoft', code: 'UNSAFE_REDIRECT' }] })
      expect(transport).toHaveBeenCalledTimes(2)
    }
  )

  it.each([401, 403])('refreshes credentials once on Bing statusCode %i and resets its sequence', async (statusCode) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const transport = vi.fn<HttpTransport>().mockResolvedValueOnce({ status: 503, text: '' }).mockResolvedValueOnce(bootstrap('old-token'))
      .mockResolvedValueOnce(reply({ statusCode })).mockResolvedValueOnce(bootstrap('new-token'))
      .mockImplementation(async ({ body }) => bingReply(body))
    await new ExtensionTranslator(transport, 0).translate(many(11), 'ja', liveSignal(), vi.fn(), vi.fn())
    const posts = transport.mock.calls.slice(1).map(([call]) => call).filter(({ method }) => method === 'POST')
    expect(posts.map(({ body }) => form(body).get('token'))).toEqual(['old-token', 'new-token', 'new-token'])
    expect(posts.map(({ url }) => new URL(url).searchParams.get('IID')))
      .toEqual(['translator.test.1', 'translator.test.1', 'translator.test.2'])
  })

  it('stops after a second auth rejection', async () => {
    const transport = vi.fn<HttpTransport>().mockResolvedValueOnce({ status: 429, text: '' })
      .mockImplementation(async ({ method }) => method === 'GET' ? bootstrap() : { status: 403, text: 'Forbidden' })
    await expect(new ExtensionTranslator(transport, 0).translate(['sample'], 'en', liveSignal(), vi.fn(), vi.fn()))
      .rejects.toMatchObject({ diagnostics: [{ provider: 'google', status: 429 }, { provider: 'microsoft', status: 403, bodySnippet: 'Forbidden' }] })
    expect(transport).toHaveBeenCalledTimes(5)
  })

  it('retries individually if Bing reorders anchors and preserves cache entry order', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const transport = vi.fn<HttpTransport>().mockResolvedValueOnce({ status: 503, text: '' }).mockResolvedValueOnce(bootstrap())
      .mockImplementationOnce(async ({ body }) => {
        const packed = form(body).get('text')!
        expect(packed.split(/\[===\d{12}===\]/)).toHaveLength(3)
        return reply([{ translations: [{ text: packed.split('\n').reverse().join('\n') }] }])
      })
      .mockImplementation(async ({ body }) => bingReply(body))
    const save = vi.fn()
    await new ExtensionTranslator(transport, 0).translate(many(3), 'zh-TW', liveSignal(), save, vi.fn())
    expect(transport.mock.calls.slice(3).map(([call]) => form(call.body).get('text'))).toEqual(many(3))
    expect(save).toHaveBeenCalledWith(new Map(many(3).map((text) => [text, `MS ${text}`])))
  })

  it('keeps saved batches on later failure and retains the initial Google diagnostic', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const transport = vi.fn<HttpTransport>()
      .mockResolvedValueOnce({ status: 429, text: '' }).mockResolvedValueOnce(bootstrap())
      .mockImplementationOnce(async ({ body }) => bingReply(body))
      .mockResolvedValue({ status: 500, text: 'Internal Server Error' })
    const save = vi.fn()
    await expect(new ExtensionTranslator(transport, 0).translate(many(11), 'ja', liveSignal(), save, vi.fn()))
      .rejects.toMatchObject({ diagnostics: [{ provider: 'google', status: 429 }, { provider: 'microsoft', status: 500 }] })
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0].size).toBe(10)
  })
})

describe('IPC results', () => {
  it('returns both safe diagnostics and logs them without printing provider secrets or echoed input', async () => {
    removeProxy()
    const print = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.collect.mockReturnValue(['Synthetic prompt to keep private'])
    mocks.fetch.mockResolvedValueOnce(new Response(
      '<html><title>Too Many Requests</title><script>const key="private-key";</script><p>token=private-token Synthetic prompt to keep private</p></html>',
      { status: 429 }
    ))
    mockBingPage((client) => client.emit('error', new Error('net::ERR_CONNECTION_REFUSED at https://user:password@private-proxy/test')))
    const publish = vi.fn()
    const result = await startExtensionTranslation(request, publish)
    const diagnostics = [
      { provider: 'google', status: 429, message: 'HTTP 429', bodySnippet: 'Too Many Requests' },
      { provider: 'microsoft', code: 'ECONNREFUSED', message: 'Connection was refused' }
    ]
    expect(result).toMatchObject({ status: 'error', error: 'translation-unavailable', diagnostics })
    expect(result.detail).toContain('Google: HTTP 429 / Microsoft: ECONNREFUSED')
    expect(publish.mock.lastCall?.[0]).toMatchObject({ status: 'error', detail: result.detail, diagnostics })
    expect(print).toHaveBeenCalledWith('[extensions] description translation failed', { locale: 'ja', done: 0, total: 1, diagnostics })
    expect(JSON.stringify([result, print.mock.calls])).not.toMatch(/private-key|private-token|user:password|Synthetic prompt/)
    expect(mocks.fetch.mock.calls.map(([, options]) => options.redirect)).toEqual(['error'])
    expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({ redirect: 'manual', credentials: 'omit' }))
  })

  it('uses the validated final URL when Electron fetch would lose it', async () => {
    removeProxy()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.fetch.mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockImplementationOnce(async (_url, { body }) => new Response(bingReply(body).text))
    const client = mockBingPage((request) => {
      request.emit('redirect', 302, 'GET', `${bingOrigin}/translator`)
      const response = Object.assign(new EventEmitter(), { statusCode: 200 })
      request.emit('response', response)
      response.emit('data', Buffer.from(bootstrap().text))
      response.emit('end')
      request.emit('close')
    })
    const save = vi.fn()
    await new ExtensionTranslator(undefined, 0).translate(['Source'], 'ja', liveSignal(), save, vi.fn())
    expect(client.followRedirect).toHaveBeenCalledOnce()
    expect(mocks.fetch.mock.calls[1][0]).toMatch(/^https:\/\/www\.bing\.com\/ttranslatev3/)
    expect(save).toHaveBeenCalledWith(new Map([['Source', 'MS Source']]))
  })

  it('aborts a redirect to a different domain before Electron follows it', async () => {
    removeProxy()
    mocks.fetch.mockResolvedValueOnce(new Response('', { status: 429 }))
    const client = mockBingPage((request) => request.emit('redirect', 302, 'GET', 'https://untrusted.example/translator'))
    await expect(new ExtensionTranslator(undefined, 0).translate(['Source'], 'ja', liveSignal(), vi.fn(), vi.fn()))
      .rejects.toMatchObject({ diagnostics: [{ provider: 'google', status: 429 }, { provider: 'microsoft', code: 'UNSAFE_REDIRECT' }] })
    expect(client.followRedirect).not.toHaveBeenCalled()
    expect(client.abort).toHaveBeenCalledOnce()
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
  })

  it.skipIf(process.platform === 'win32')('decodes the curl URL trailer and preserves its network error code', async () => {
    removeProxy()
    vi.stubEnv('HTTPS_PROXY', 'http://localhost:7890')
    mocks.curl.mockImplementation((_exe, args, _options, callback) => {
      queueMicrotask(() => {
        if (args.includes('GET')) callback(null, `${bootstrap().text}\n200\nhttps://www.bing.com/translator`, '')
        else if (args.at(-1).includes(googleHost)) callback(Object.assign(new Error('private-url'), { code: 28 }), '', 'private-stderr')
        else callback(null, 'Internal Server Error\n500\nhttps://www.bing.com/ttranslatev3', '')
      })
      return { stdin: { on: vi.fn(), end: vi.fn() } }
    })
    const translation = new ExtensionTranslator(undefined, 0).translate(['Sample'], 'ja', liveSignal(), vi.fn(), vi.fn())
    await expect(translation).rejects.toMatchObject({
      diagnostics: [{ provider: 'google', code: 'TIMEOUT' }, { provider: 'microsoft', status: 500 }]
    })
    await translation.catch((error) => expect(JSON.stringify(error.diagnostics)).not.toMatch(/private-url|private-stderr/))
    expect(mocks.curl.mock.calls[1][1]).toEqual(expect.arrayContaining(['--location', '--max-redirs', '3']))
    expect(mocks.curl.mock.calls[2][1].at(-1)).toMatch(/^https:\/\/www\.bing\.com\/ttranslatev3/)
  })

  it('enforces a single run and preserves the completed batch on cancellation', async () => {
    removeProxy()
    mocks.collect.mockReturnValueOnce(many(11)).mockReturnValueOnce([])
    mocks.fetch.mockImplementationOnce(async (_url, { body }) => new Response(googleReply(body).text))
    const publish = vi.fn()
    const first = startExtensionTranslation(request, (event) => {
      publish(event)
      if (event.translated) cancelExtensionTranslation()
    })
    const busy = await startExtensionTranslation(request, vi.fn())
    const cancelled = await first
    expect(busy).toMatchObject({ status: 'busy', runId: cancelled.runId })
    expect(cancelled).toMatchObject({ status: 'cancelled', translated: 10, total: 11 })
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    expect(mocks.save).toHaveBeenCalledTimes(1)
    expect(publish.mock.lastCall?.[0]).toMatchObject({ status: 'cancelled', translated: 10 })
    await expect(startExtensionTranslation(request, vi.fn())).resolves.toMatchObject({ status: 'noop' })
  })
})
