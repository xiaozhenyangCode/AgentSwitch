import { describe, expect, it } from 'vitest'
import { codexTurnUsage, lastClaudeSessionCost, lastCodexTotals, runCost } from './usageDelta'

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
