import { describe, expect, it, vi } from 'vitest'
import { claudeAdapter, type RunSpec } from './agentRunner'
import { codexTurnUsage, estimateTextTokens, lastClaudeSessionCost, lastCodexTotals, MessageUsage, runCost } from './usageDelta'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/fixture-user-data' }, safeStorage: {} }))

describe('claude context usage', () => {
  it.each(['finished', 'stopped'])('keeps root context when a child reports usage last (%s)', (status) => {
    const spec: RunSpec = {
      cfg: {
        id: 'claude-test', kind: 'claude', name: 'Test', configDir: '/tmp/claude-fixture',
        imported: false, runCommand: '', loginCommand: '', extraEnv: {}, defaultModel: '', autoApprove: 'edits', createdAt: 0
      },
      cwd: '/tmp', outDir: '/tmp', model: null, prompt: 'Message', system: null, images: [], resume: null
    }
    const adapter = claudeAdapter(spec)
    const emit = vi.fn()
    adapter.onLine({ type: 'assistant', parent_tool_use_id: null, message: {
      id: 'root', usage: { input_tokens: 100, cache_read_input_tokens: 200, output_tokens: 20 }
    } }, emit)
    adapter.onLine({ type: 'assistant', parent_tool_use_id: 'child-tool', message: {
      id: 'child', usage: { input_tokens: 10, output_tokens: 3 }
    } }, emit)

    if (status === 'finished') adapter.onLine({ type: 'result', subtype: 'success', usage: { input_tokens: 110, output_tokens: 23 } }, emit)
    else adapter.finish?.(emit)
    const usageEvents = emit.mock.calls.map(([e]) => e).filter((e) => e.t === 'usage')
    expect(usageEvents).toEqual([
      { t: 'usage', usage: expect.objectContaining({ input: 110, output: 23, context: 320 }) }
    ])
  })
})

describe('claude session cost', () => {
  const cs = (v: number) => JSON.stringify({ type: 'cost-state', sessionId: 's', totalCostUSD: v, modelUsage: {} })
  it('reads the last cost-state of the session log', () => {
    const text = [cs(0.0056), '{"type":"assistant","message":{}}', cs(0.00705), '{"type":"user"}'].join('\n')
    expect(lastClaudeSessionCost(text)).toBe(0.00705)
  })
  it('ignores a line cut by the tail window and missing records', () => {
    expect(lastClaudeSessionCost('{"type":"cost-state","totalCostUSD":0.0')).toBeNull()
    expect(lastClaudeSessionCost('{"type":"user"}')).toBeNull()
  })
  it('turns the cumulative total into the run cost', () => {
    expect(runCost(0.00904, 0.00864)).toBeCloseTo(0.0004, 8)
    expect(runCost(0.0056, null)).toBe(0.0056)
    // the CLI started over (older CLI, compacted or new session): the total is this run's
    expect(runCost(0.002, 0.009)).toBe(0.002)
    expect(runCost(undefined, 0.009)).toBeUndefined()
  })
})

describe('codex turn usage', () => {
  const tc = (input: number, cached: number, out: number) =>
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: out, reasoning_output_tokens: 0 }, last_token_usage: { input_tokens: 1 } } } })
  it('reads the last running total of the rollout', () => {
    const text = [tc(100, 10, 5), tc(21548, 14976, 5), '{"type":"turn_context"}'].join('\n')
    expect(lastCodexTotals(text)).toEqual({ input_tokens: 21548, cached_input_tokens: 14976, output_tokens: 5, reasoning_output_tokens: 0 })
    expect(lastCodexTotals('{"type":"event_msg","payload":{"type":"token_count","info":null}}')).toBeNull()
  })
  it('subtracts the running total from before the turn (exec resume reports session totals)', () => {
    const before = { input_tokens: 21548, cached_input_tokens: 14976, output_tokens: 5, reasoning_output_tokens: 0 }
    const after = { input_tokens: 43228, cached_input_tokens: 36352, cache_write_input_tokens: 0, output_tokens: 11, reasoning_output_tokens: 0 }
    expect(codexTurnUsage(after, before)).toEqual({ input: 21680 - 21376, output: 6, cacheRead: 21376, cacheWrite: undefined, reasoning: 0 })
  })
  it('keeps a fresh thread as reported, and never goes negative', () => {
    const u = { input_tokens: 21548, cached_input_tokens: 14976, output_tokens: 5 }
    expect(codexTurnUsage(u, null)).toEqual({ input: 6572, output: 5, cacheRead: 14976, cacheWrite: undefined, reasoning: undefined })
    expect(codexTurnUsage(u, { input_tokens: 99999, cached_input_tokens: 99999, output_tokens: 999 })).toEqual(codexTurnUsage(u, null))
  })
})

describe('message usage fallback (run stopped before its final report)', () => {
  it('keeps one usage per API message, taking the latest counts of repeated reports', () => {
    const acc = new MessageUsage()
    acc.add('m1', { input_tokens: 2, cache_read_input_tokens: 9000, cache_creation_input_tokens: 300, output_tokens: 1 }) // message_start
    acc.add('m1', { output_tokens: 120 }) // message_delta
    acc.add('m1', { input_tokens: 2, cache_read_input_tokens: 9000, cache_creation_input_tokens: 300, output_tokens: 40 }) // assistant block (partial count)
    acc.add('m2', { input_tokens: 3, cache_read_input_tokens: 9400, output_tokens: 15, output_tokens_details: { thinking_tokens: 5 } })
    expect(acc.total()).toEqual({ input: 5, output: 135, cacheRead: 18400, cacheWrite: 300, reasoning: 5 })
  })
  it('is empty until a message reports usage', () => {
    const acc = new MessageUsage()
    acc.add(null, { output_tokens: 5 })
    expect(acc.total()).toBeNull()
  })
})

describe('output of a message cut off mid-stream', () => {
  it('estimates tokens from streamed text (calibrated on claude: ~1.25/CJK char, ~3.2 chars per token otherwise)', () => {
    expect(estimateTextTokens('黄河'.repeat(100))).toBe(250)
    expect(estimateTextTokens('a'.repeat(320))).toBe(100)
  })
  it('uses the streamed estimate only while it exceeds the reported output', () => {
    const acc = new MessageUsage()
    acc.add('m1', { input_tokens: 2, cache_read_input_tokens: 9000, output_tokens: 1 }) // message_start, then killed
    acc.stream('m1', 300)
    acc.thinking('m1', 120)
    acc.thinking('m1', 100) // estimates only grow
    expect(acc.total()).toEqual({ input: 2, output: 420, cacheRead: 9000, cacheWrite: 0, reasoning: 120 })
    acc.add('m1', { output_tokens: 500, output_tokens_details: { thinking_tokens: 90 } }) // the real count arrived
    expect(acc.total()).toEqual({ input: 2, output: 500, cacheRead: 9000, cacheWrite: 0, reasoning: 90 })
  })
  it('drops the estimate once the message finished', () => {
    const acc = new MessageUsage()
    acc.add('m1', { input_tokens: 2, output_tokens: 1 })
    acc.stream('m1', 300)
    acc.add('m1', { output_tokens: 280 })
    acc.final('m1')
    acc.stream('m1', 50)
    expect(acc.total()).toEqual({ input: 2, output: 280, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
  })
})
