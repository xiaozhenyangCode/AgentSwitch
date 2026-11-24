import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, ProfileConfig, Usage } from '@shared/types'
import { agyAdapter, type RunSpec } from './agentRunner'
import { agyTurnUsage } from './usageDelta'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/fixture-user-data', getPreferredSystemLanguages: () => ['en'] }, safeStorage: {} }))
vi.mock('./legacy', () => ({ LEGACY_PROJECT_DIR: '.agentmux', LEGACY_USER_DATA: '/tmp/agentswitch-nonexistent' }))

// protobuf: varint and length-delimited fields
const varint = (n: number): number[] => {
  const out: number[] = []
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80)
    n = Math.floor(n / 128)
  }
  out.push(n)
  return out
}
const vField = (f: number, v: number): number[] => [...varint(f << 3), ...varint(v)]
const bField = (f: number, b: number[]): number[] => [...varint((f << 3) | 2), ...varint(b.length), ...b]
/** gen_metadata row: 1.4 = usage {2 uncached input, 3 output, 5 cache read, 9 thinking} */
const genRow = (input: number, output: number, cacheRead: number, thinking: number): Uint8Array =>
  Uint8Array.from(bField(1, bField(4, [...vField(2, input), ...vField(3, output), ...vField(5, cacheRead), ...vField(9, thinking)])))

describe('agy print usage', () => {
  let home: string
  let cfg: ProfileConfig
  const conv = 'conv-1'

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agentswitch-agy-print-'))
    const dir = join(home, '.gemini/antigravity-cli/conversations')
    mkdirSync(dir, { recursive: true })
    const db = new DatabaseSync(join(dir, `${conv}.db`))
    db.exec('create table gen_metadata(idx integer primary key, data blob)')
    // two earlier turns: 3 model calls
    const ins = db.prepare('insert into gen_metadata(idx, data) values (?, ?)')
    ins.run(0, genRow(25_000, 400, 0, 100))
    ins.run(1, genRow(3_000, 300, 25_000, 50))
    ins.run(2, genRow(2_000, 500, 28_000, 0))
    db.close()
    cfg = { id: 'gemini-print-test', kind: 'gemini', name: 'Gemini', configDir: home, imported: false,
      loginCommand: 'agy', runCommand: 'agy', extraEnv: {}, defaultModel: '', autoApprove: 'full', createdAt: 0 }
  })

  afterEach(() => rmSync(home, { recursive: true, force: true }))

  const spec = (resume: string | null): RunSpec => ({ cfg, cwd: home, outDir: home, prompt: 'hi', model: null, system: null, images: [], resume })

  function run(resume: string | null, lines: any[]): Usage {
    const adapter = agyAdapter(spec(resume), home)
    let usage: Usage = {}
    const emit = (e: AgentEvent) => {
      if (e.t === 'usage') usage = { ...usage, ...e.usage }
    }
    for (const l of lines) adapter.onLine(l, emit)
    adapter.finish?.(emit)
    return usage
  }

  const step = (i: number, input: number, cacheRead: number, output: number) => ({
    event: 'step_update',
    step_update: { step_type: 'agent_response', step_index: i, state: 'DONE', usage: { input_tokens: input, cache_read_tokens: cacheRead, output_tokens: output, thinking_tokens: 0 } }
  })

  it('reports a resumed run as the conversation total minus the total before it', () => {
    // this run: one call (1_000 in, 30_500 cached, 200 out); agy reports the conversation's running total
    const u = run(conv, [
      step(7, 1_000, 30_500, 200),
      { event: 'result', result: { status: 'SUCCESS', conversation_id: conv, usage: { input_tokens: 31_000, cache_read_tokens: 83_500, output_tokens: 1_400, thinking_tokens: 150 } } }
    ])
    expect(u).toMatchObject({ input: 1_000, cacheRead: 30_500, output: 200, reasoning: 0 })
    // context includes the cached prefix
    expect(u.context).toBe(1_000 + 30_500 + 200)
  })

  it('takes a new conversation report as is', () => {
    const u = run(null, [
      { event: 'init', conversation_id: 'fresh' },
      step(0, 20_000, 0, 300),
      { event: 'result', result: { status: 'SUCCESS', conversation_id: 'fresh', usage: { input_tokens: 20_000, output_tokens: 300, thinking_tokens: 10 } } }
    ])
    expect(u).toMatchObject({ input: 20_000, output: 300, reasoning: 10 })
    expect(u.cacheRead).toBeUndefined()
  })

  it('falls back to the finished steps when the conversation db cannot be read', () => {
    const u = run('missing-conv', [
      step(3, 500, 9_000, 120),
      step(4, 700, 9_500, 80),
      { event: 'result', result: { status: 'SUCCESS', usage: { input_tokens: 99_999, cache_read_tokens: 999_999, output_tokens: 9_999 } } }
    ])
    expect(u).toMatchObject({ input: 1_200, cacheRead: 18_500, output: 200 })
  })

  it('treats a total below the baseline as the run\'s own (agy counted over)', () => {
    expect(agyTurnUsage({ input_tokens: 100, output_tokens: 10, cache_read_tokens: 50 }, { input: 30_000, output: 1_200, cacheRead: 53_000, reasoning: 0 }, null))
      .toEqual({ input: 100, output: 10, cacheRead: 50, reasoning: 0 })
  })
})
