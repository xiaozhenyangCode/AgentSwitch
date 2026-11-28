import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExtensionTranslator, GOOGLE_LANGUAGE, MICROSOFT_LANGUAGE, cancelExtensionTranslation, startExtensionTranslation, type HttpTransport } from './extensionTranslator'

const mocks = vi.hoisted(() => ({ collect: vi.fn(), save: vi.fn(), fetch: vi.fn() }))
vi.mock('electron', () => ({ net: { fetch: mocks.fetch } }))
vi.mock('./extensions', () => ({ collectUntranslatedDescriptions: mocks.collect }))
vi.mock('./extensionTranslationCache', () => ({ setCachedTranslations: mocks.save }))
vi.mock('./shellEnv', () => ({ getBaseEnv: () => ({}) }))

const reply = (payload: unknown) => ({ status: 200, text: JSON.stringify(payload) })
const microsoft = (body: string) => reply(JSON.parse(body).map(({ Text }: { Text: string }) => ({ translations: [{ text: `MS ${Text}` }] })))
const google = (text: string) => reply([[[text]]])
const input = (body: string) => new URLSearchParams(body).get('q')!
const many = (count: number) => Array.from({ length: count }, (_, index) => `Description ${index}`)
const liveSignal = () => new AbortController().signal

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetAllMocks()
})

describe('ExtensionTranslator', () => {
  it.each([
    ['zh-CN', 'zh-CN', 'zh-Hans'], ['zh-TW', 'zh-TW', 'zh-Hant'], ['ja', 'ja', 'ja'], ['en', 'en', 'en']
  ] as const)('maps %s to the provider language codes', async (locale, googleCode, microsoftCode) => {
    expect(GOOGLE_LANGUAGE[locale]).toBe(googleCode)
    expect(MICROSOFT_LANGUAGE[locale]).toBe(microsoftCode)
    const transport = vi.fn<HttpTransport>().mockResolvedValueOnce({ status: 429, text: '' })
      .mockResolvedValueOnce({ status: 200, text: 'fixture-token' })
      .mockResolvedValueOnce(microsoft('[{"Text":"source"}]'))
    const save = vi.fn()
    await new ExtensionTranslator(transport, 0).translate(['source'], locale, liveSignal(), save, vi.fn())
    const requests = transport.mock.calls.map(([call]) => new URL(call.url))
    expect(requests[0].searchParams.get('tl')).toBe(googleCode)
    expect(requests[2].searchParams.get('to')).toBe(microsoftCode)
    expect(save).toHaveBeenCalledWith(new Map([['source', 'MS source']]))
  })

  it('falls back after a network failure and uses Microsoft for the rest of the run', async () => {
    const transport = vi.fn<HttpTransport>(async (request) => {
      if (request.url.includes('googleapis')) throw new Error('Timed out')
      if (request.method === 'GET') return { status: 200, text: 'fixture-token' }
      expect(request.headers?.Authorization).toBe('Bearer fixture-token')
      return microsoft(request.body!)
    })
    const save = vi.fn()
    const progress = vi.fn()
    await new ExtensionTranslator(transport, 0).translate(many(52), 'ja', liveSignal(), save, progress)
    expect(transport.mock.calls.map(([request]) => new URL(request.url).hostname)).toEqual([
      'translate.googleapis.com', 'edge.microsoft.com', ...Array(3).fill('api-edge.cognitive.microsofttranslator.com')
    ])
    expect(save.mock.calls.map(([entries]) => entries.size)).toEqual([25, 25, 2])
    expect(progress.mock.calls.map(([event]) => event.done)).toEqual([25, 50, 52])
  })

  it('refreshes a rejected Microsoft token once and reuses the new one for later batches', async () => {
    const transport = vi.fn<HttpTransport>().mockResolvedValueOnce({ status: 503, text: '' })
      .mockResolvedValueOnce({ status: 200, text: 'old-token' }).mockResolvedValueOnce({ status: 401, text: '' })
      .mockResolvedValueOnce({ status: 200, text: 'new-token' })
      .mockImplementation(async ({ body }) => microsoft(body!))
    await new ExtensionTranslator(transport, 0).translate(many(26), 'ja', liveSignal(), vi.fn(), vi.fn())
    const posts = transport.mock.calls.slice(1).map(([request]) => request.headers?.Authorization).filter(Boolean)
    expect(posts).toEqual(['Bearer old-token', 'Bearer new-token', 'Bearer new-token'])
  })

  it('packs up to 25 items and includes anchor overhead in the 3000-character limit', async () => {
    const descriptions = [...many(26), ...many(8).map((text) => text.padEnd(1000, 'x')), 'a'.repeat(5999) + '🙂']
    const transport = vi.fn<HttpTransport>(async ({ body }) => {
      const packed = input(body!)
      expect(packed.length).toBeLessThanOrEqual(3000)
      expect(packed).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
      expect(packed.split(/\[===\d{12}===\]/).length).toBeLessThanOrEqual(25)
      return google(packed.toUpperCase())
    })
    const save = vi.fn()
    await new ExtensionTranslator(transport, 0).translate(descriptions, 'ja', liveSignal(), save, vi.fn())
    expect(input(transport.mock.calls[0][0].body!).split(/\[===\d{12}===\]/)).toHaveLength(25)
    expect(save.mock.calls.flatMap(([entries]) => [...entries.keys()])).toEqual(descriptions)
  })

  it('retries the batch one item at a time when Google loses or reorders anchors', async () => {
    const transport = vi.fn<HttpTransport>()
      .mockImplementationOnce(async ({ body }) => {
        const packed = input(body!)
        return google(packed.split('\n').reverse().join('\n'))
      })
      .mockImplementation(async ({ body }) => google(`Result ${input(body!)}`))
    const save = vi.fn()
    await new ExtensionTranslator(transport, 0).translate(many(3), 'zh-CN', liveSignal(), save, vi.fn())
    expect(transport.mock.calls.slice(1).map(([request]) => input(request.body!))).toEqual(many(3))
    expect(save).toHaveBeenCalledWith(new Map(many(3).map((text) => [text, `Result ${text}`])))
  })

  it('keeps saved batches when both providers fail later', async () => {
    const transport = vi.fn<HttpTransport>()
      .mockImplementationOnce(async ({ body }) => google(input(body!)))
      .mockResolvedValue({ status: 503, text: '' })
    const save = vi.fn()
    await expect(new ExtensionTranslator(transport, 0).translate(many(26), 'ja', liveSignal(), save, vi.fn())).rejects.toThrow()
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0].size).toBe(25)
  })

  it('enforces a single active IPC run, aborts its requests, and preserves completed batches', async () => {
    for (const proxy of ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY']) vi.stubEnv(proxy, '')
    mocks.collect.mockReturnValueOnce(many(26)).mockReturnValueOnce([])
    mocks.fetch.mockImplementationOnce(async (_url, { body }) => new Response(google(input(body)).text))
    const request = { profileId: 'codex-test', cwd: null, locale: 'ja' } as const
    const publish = vi.fn()
    const first = startExtensionTranslation(request, (event) => {
      publish(event)
      if (event.translated) cancelExtensionTranslation()
    })
    const busy = await startExtensionTranslation(request, vi.fn())
    const cancelled = await first
    expect(busy).toMatchObject({ status: 'busy', runId: cancelled.runId })
    expect(cancelled).toMatchObject({ status: 'cancelled', translated: 25, total: 26 })
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    expect(mocks.save).toHaveBeenCalledTimes(1)
    expect(publish.mock.lastCall?.[0]).toMatchObject({ status: 'cancelled', translated: 25 })
    await expect(startExtensionTranslation(request, vi.fn())).resolves.toMatchObject({ status: 'noop' })
  })
})
