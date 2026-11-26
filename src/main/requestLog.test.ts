import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, ProfileConfig } from '@shared/types'

const { state } = vi.hoisted(() => ({
  state: { userDataDir: '/tmp/agentswitch-reqlog-init' }
}))

vi.mock('electron', () => ({
  app: { getPath: () => state.userDataDir, getPreferredSystemLanguages: () => ['en'] },
  net: { fetch: vi.fn() },
  safeStorage: {}
}))

vi.mock('./legacy', () => ({
  LEGACY_PROJECT_DIR: '.agentmux',
  LEGACY_USER_DATA: '/tmp/agentswitch-nonexistent'
}))

import {
  closeRequestLogDb,
  computeCacheHitRate,
  computePerformanceMetrics,
  mapStatusCode,
  normalizeTokens,
  pruneRequestLogs,
  queryRequestLogs,
  recordRequestLog,
  resolveProviderLabel
} from './requestLog'
import { claudeAdapter, type RunSpec } from './agentRunner'

describe('requestLog pure helpers', () => {
  it('normalizes mutually exclusive token buckets and deducts cached reads when included in total input', () => {
    expect(
      normalizeTokens({
        totalInput: 100_000,
        cacheRead: 80_000,
        cacheWrite: 5_000,
        output: 1_200,
        inputIncludesCacheRead: true
      })
    ).toEqual({
      uncachedInputTokens: 20_000,
      outputTokens: 1_200,
      cacheReadTokens: 80_000,
      cacheWriteTokens: 5_000
    })

    // Never goes negative if cacheRead > totalInput
    expect(
      normalizeTokens({
        totalInput: 500,
        cacheRead: 1_000,
        output: 10,
        inputIncludesCacheRead: true
      }).uncachedInputTokens
    ).toBe(0)

    // Already-separated providers (e.g. Claude) keep uncachedInput as-is
    expect(
      normalizeTokens({
        uncachedInput: 1_500,
        cacheRead: 50_000,
        cacheWrite: 3_000,
        output: 400,
        inputIncludesCacheRead: false
      })
    ).toEqual({
      uncachedInputTokens: 1_500,
      outputTokens: 400,
      cacheReadTokens: 50_000,
      cacheWriteTokens: 3_000
    })
  })

  it('computes cache hit rate accurately and returns null on zero denominator', () => {
    expect(
      computeCacheHitRate({ uncachedInputTokens: 20_000, cacheReadTokens: 75_000, cacheWriteTokens: 5_000 })
    ).toBeCloseTo(0.75, 6)
    expect(
      computeCacheHitRate({ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
    ).toBeNull()
  })

  it('computes TTFT and tok/s with strict boundaries for short outputs, short intervals, and non-streaming', () => {
    // Normal streaming long output: 248 tokens over 2000ms -> 124 tok/s
    expect(
      computePerformanceMetrics({
        startedAt: 1000,
        firstTokenAt: 2600,
        endedAt: 4600,
        outputTokens: 248,
        streaming: true
      })
    ).toEqual({
      ttftMs: 1600,
      durationMs: 3600,
      tokensPerSecond: 124
    })

    // Short output (< 50 tokens): tok/s must be null, TTFT preserved
    expect(
      computePerformanceMetrics({
        startedAt: 1000,
        firstTokenAt: 1500,
        endedAt: 3500,
        outputTokens: 49,
        streaming: true
      })
    ).toEqual({
      ttftMs: 500,
      durationMs: 2500,
      tokensPerSecond: null
    })

    // Ultra-short generation interval (< 200ms): tok/s must be null
    expect(
      computePerformanceMetrics({
        startedAt: 1000,
        firstTokenAt: 1400,
        endedAt: 1550,
        outputTokens: 120,
        streaming: true
      })
    ).toEqual({
      ttftMs: 400,
      durationMs: 550,
      tokensPerSecond: null
    })

    // Non-streaming (e.g. Codex): TTFT and tok/s must be null, durationMs preserved
    expect(
      computePerformanceMetrics({
        startedAt: 1000,
        firstTokenAt: 1200,
        endedAt: 5000,
        outputTokens: 500,
        streaming: false
      })
    ).toEqual({
      ttftMs: null,
      durationMs: 4000,
      tokensPerSecond: null
    })
  })

  it('maps outcomes and error strings to unified HTTP-like status codes', () => {
    expect(mapStatusCode({ ok: true })).toBe(200)
    expect(mapStatusCode({ ok: false, stopped: true, error: 'rate limit' })).toBe(499)
    expect(mapStatusCode({ ok: false, rateLimited: true })).toBe(429)
    expect(mapStatusCode({ ok: false, error: 'HTTP 429 Too Many Requests' })).toBe(429)
    expect(mapStatusCode({ ok: false, error: 'RESOURCE_EXHAUSTED: quota exceeded' })).toBe(429)
    expect(mapStatusCode({ ok: false, error: '401 Unauthorized: invalid_api_key' })).toBe(401)
    expect(mapStatusCode({ ok: false, error: '403 Forbidden: permission denied' })).toBe(403)
    expect(mapStatusCode({ ok: false, error: 'Request timed out after 30s' })).toBe(408)
    expect(mapStatusCode({ ok: false, error: 'Unexpected crash' })).toBe(500)
  })

  it('resolves provider labels for built-in engines, DeepSeek, and custom endpoints', () => {
    expect(resolveProviderLabel({ kind: 'claude' })).toBe('Anthropic')
    expect(resolveProviderLabel({ kind: 'codex' })).toBe('OpenAI')
    expect(resolveProviderLabel({ kind: 'gemini' })).toBe('Google')
    expect(resolveProviderLabel({ kind: 'reasonix' })).toBe('DeepSeek')
    expect(resolveProviderLabel({ kind: 'claude', apiKey: { provider: 'deepseek' } })).toBe('DeepSeek')
    expect(resolveProviderLabel({ kind: 'claude', apiKey: { provider: 'custom', baseUrl: 'https://api.example.com/v1' } })).toBe('api.example.com')
  })
})

describe('requestLog SQLite persistence, pagination, filtering & pruning', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'agentswitch-reqlog-'))
    state.userDataDir = tempDir
    closeRequestLogDb()
  })

  afterEach(() => {
    closeRequestLogDb()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('persists unlisted model IDs and leaves their costs unset', () => {
    const profile = { accountId: 'agy-1', accountName: 'agy', engineKind: 'gemini', provider: 'Google', statusCode: 200 } as const
    const model = 'new-provider/Gemini-Next-v9-special'
    const entry = recordRequestLog({ ...profile, model, uncachedInputTokens: 100, outputTokens: 5 })
    expect(entry).toMatchObject({ model, costUsd: null })
    recordRequestLog({ ...profile, model: 'unknown' })
    const page = queryRequestLogs()
    expect(page.entries.map((row) => row.model)).toEqual(['', model])
    expect(page.availableModels).toEqual([model])
    expect(page.counts.models).toBe(1)
  })

  it('persists entries, filters by status/engine/model, and paginates newest-first', () => {
    const baseTs = Date.now() - 10_000
    const statuses = [200, 429, 401, 499, 500] as const
    statuses.forEach((statusCode, idx) => {
      recordRequestLog({
        id: `req-${idx}`,
        timestamp: baseTs + idx * 1000,
        accountId: idx % 2 === 0 ? 'acct-claude' : 'acct-codex',
        accountName: idx % 2 === 0 ? 'Claude Main' : 'Codex Pro',
        engineKind: idx % 2 === 0 ? 'claude' : 'codex',
        provider: idx % 2 === 0 ? 'Anthropic' : 'OpenAI',
        model: idx % 2 === 0 ? 'claude-sonnet-4-6' : 'gpt-5.3-codex',
        projectDir: '/tmp/demo',
        threadId: 'thread-1',
        runId: 'run-1',
        turnIndex: idx + 1,
        uncachedInputTokens: 1_000,
        outputTokens: 250,
        cacheReadTokens: 4_000,
        cacheWriteTokens: 500,
        startedAt: baseTs + idx * 1000 - 3000,
        firstTokenAt: baseTs + idx * 1000 - 2000,
        endedAt: baseTs + idx * 1000,
        streaming: idx % 2 === 0,
        statusCode,
        errorSummary: statusCode >= 400 ? `err ${statusCode}` : null,
        rawUsage: { input_tokens: 1_000, output_tokens: 250 }
      })
    })

    const all = queryRequestLogs({ limit: 2, offset: 0 })
    expect(all.total).toBe(5)
    expect(all.filteredTotal).toBe(5)
    expect(all.hasMore).toBe(true)
    expect(all.entries.map((e) => e.id)).toEqual(['req-4', 'req-3'])
    expect(all.counts).toEqual({
      total: 5,
      accounts: 2,
      models: 2,
      status2xx: 1,
      status429: 1,
      statusError: 4
    })
    expect(all.entries[0].rawUsage).toEqual({ input_tokens: 1_000, output_tokens: 250 })

    const page2 = queryRequestLogs({ limit: 2, offset: 2 })
    expect(page2.entries.map((e) => e.id)).toEqual(['req-2', 'req-1'])
    expect(page2.hasMore).toBe(true)

    const page3 = queryRequestLogs({ limit: 2, offset: 4 })
    expect(page3.entries.map((e) => e.id)).toEqual(['req-0'])
    expect(page3.hasMore).toBe(false)

    // Status filters
    expect(queryRequestLogs({ statusCode: '2xx' }).entries.map((e) => e.statusCode)).toEqual([200])
    expect(queryRequestLogs({ statusCode: '429' }).entries.map((e) => e.statusCode)).toEqual([429])
    expect(queryRequestLogs({ statusCode: '4xx5xx' }).entries.map((e) => e.statusCode)).toEqual([500, 499, 401, 429])
    expect(queryRequestLogs({ statusCode: 401 }).entries.map((e) => e.statusCode)).toEqual([401])
    expect(queryRequestLogs({ statusCode: 499 }).entries.map((e) => e.statusCode)).toEqual([499])

    // Engine & model filters
    expect(queryRequestLogs({ engineKind: 'codex' }).filteredTotal).toBe(2)
    expect(queryRequestLogs({ model: 'claude-sonnet-4-6' }).filteredTotal).toBe(3)
  })

  it('prunes records older than maxAgeMs and enforces maxRows capacity cap', () => {
    const now = Date.now()
    // 1 expired record (40 days old) + 5 fresh records
    recordRequestLog({
      id: 'old-req',
      timestamp: now - 40 * 86400_000,
      accountId: 'a1',
      accountName: 'A1',
      engineKind: 'claude',
      provider: 'Anthropic',
      model: 'claude-sonnet-4-6',
      statusCode: 200
    })
    for (let i = 0; i < 5; i++) {
      recordRequestLog({
        id: `fresh-${i}`,
        timestamp: now - (5 - i) * 1000,
        accountId: 'a1',
        accountName: 'A1',
        engineKind: 'claude',
        provider: 'Anthropic',
        model: 'claude-sonnet-4-6',
        statusCode: 200
      })
    }

    pruneRequestLogs({ maxAgeMs: 30 * 86400_000, maxRows: 3, now })
    const res = queryRequestLogs({ limit: 10 })
    expect(res.total).toBe(3)
    expect(res.entries.map((e) => e.id)).toEqual(['fresh-4', 'fresh-3', 'fresh-2'])
  })

  it('lets a Claude result name a request that omitted its model on the stream', () => {
    const cfg: ProfileConfig = {
      id: 'claude-fixture', name: 'Claude', kind: 'claude', configDir: tmpdir(), imported: false,
      loginCommand: 'claude', runCommand: 'claude', extraEnv: {}, defaultModel: '', autoApprove: 'edits', createdAt: 0
    }
    const adapter = claudeAdapter({ cfg, model: 'configured-model', system: null, prompt: 'Hi', cwd: tmpdir(), outDir: tmpdir(), images: [], resume: null })
    const emit = vi.fn()
    adapter.onLine({ type: 'stream_event', event: { type: 'message_start', message: { id: 'one', usage: { input_tokens: 20 } } } }, emit)
    adapter.onLine({ type: 'stream_event', event: { type: 'message_stop' } }, emit)
    adapter.onLine({ type: 'result', subtype: 'success', modelUsage: { 'provider/brand-new-model': {} } }, emit)
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ t: 'request_usage', model: 'provider/brand-new-model' }))
  })

  it('claudeAdapter emits one request_usage per LLM round-trip with growing cache hits', () => {
    const cfg: ProfileConfig = {
      id: 'claude-1',
      name: 'Claude',
      kind: 'claude',
      configDir: tempDir,
      imported: false,
      loginCommand: 'claude',
      runCommand: 'claude',
      extraEnv: {},
      defaultModel: 'claude-sonnet-4-6',
      autoApprove: 'full',
      createdAt: 0
    }
    const spec: RunSpec = {
      cfg,
      model: 'claude-sonnet-4-6',
      prompt: 'hi',
      system: null,
      cwd: tempDir,
      images: [],
      resume: null,
      outDir: tempDir
    }
    const adapter = claudeAdapter(spec, 1_000)
    const reqEvents: Extract<AgentEvent, { t: 'request_usage' }>[] = []
    const emit = (e: AgentEvent) => {
      if (e.t === 'request_usage') reqEvents.push(e)
    }

    // Round-trip 1 (tool call)
    adapter.onLine({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1', model: 'claude-sonnet-4-6', usage: { input_tokens: 1_000, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 2_000 } } } }, emit)
    adapter.onLine({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Checking...' } } }, emit)
    adapter.onLine({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 80 } } }, emit)
    adapter.onLine({ type: 'stream_event', event: { type: 'message_stop' } }, emit)
    adapter.onLine({ type: 'user', message: { content: [] } }, emit)

    // Round-trip 2 (final answer, cacheRead grew)
    adapter.onLine({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_2', model: 'claude-sonnet-4-6', usage: { input_tokens: 500, cache_read_input_tokens: 12_000, cache_creation_input_tokens: 0 } } } }, emit)
    adapter.onLine({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done!' } } }, emit)
    adapter.onLine({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 120 } } }, emit)
    adapter.onLine({ type: 'stream_event', event: { type: 'message_stop' } }, emit)

    expect(reqEvents).toHaveLength(2)
    expect(reqEvents[0]).toMatchObject({
      turnIndex: 1,
      streaming: true,
      usage: { input: 1_000, output: 80, cacheRead: 10_000, cacheWrite: 2_000 }
    })
    expect(reqEvents[0].firstTokenAt).not.toBeNull()
    expect(reqEvents[1]).toMatchObject({
      turnIndex: 2,
      streaming: true,
      usage: { input: 500, output: 120, cacheRead: 12_000 }
    })
  })
})
