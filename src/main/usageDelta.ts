import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Usage } from '@shared/types'

/**
 * Per-run usage from CLIs that report session totals.
 *
 * Measured (claude 2.x -p, codex 0.171 exec): on a resumed session
 *  - claude `result.total_cost_usd` (and `modelUsage`) is the session's cumulative cost; `result.usage` is per run.
 *  - codex `turn.completed.usage` is the session's cumulative `total_token_usage`.
 * Summing them per run counts every earlier turn again, so the run's share is total minus the total before it.
 */

/** Last `size` bytes of a file as text (session logs can be large; the totals are near the end). */
export function readTail(path: string, size = 512 * 1024): string {
  const fd = openSync(path, 'r')
  try {
    const total = statSync(path).size
    const len = Math.min(total, size)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, total - len)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function lastLine<T>(text: string, needle: string, pick: (d: any) => T | null): T | null {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes(needle)) continue
    try {
      const v = pick(JSON.parse(lines[i]))
      if (v !== null) return v
    } catch {
      /* a line cut by the tail window */
    }
  }
  return null
}

// ---- claude ----------------------------------------------------------------------------------

/** Session cost the CLI persisted after its last run (`cost-state` record). */
export const lastClaudeSessionCost = (text: string): number | null =>
  lastLine(text, '"cost-state"', (d) => (d?.type === 'cost-state' && typeof d.totalCostUSD === 'number' && isFinite(d.totalCostUSD) ? d.totalCostUSD : null))

/** `<CLAUDE_CONFIG_DIR>/projects/<encoded cwd>/<session>.jsonl` (scanned: the cwd encoding is the CLI's business). */
export function claudeSessionLog(configDir: string, session: string): string | null {
  const root = join(configDir, 'projects')
  let dirs: string[] = []
  try {
    dirs = readdirSync(root)
  } catch {
    return null
  }
  for (const d of dirs) {
    const f = join(root, d, `${session}.jsonl`)
    if (existsSync(f)) return f
  }
  return null
}

/** Cumulative cost of a claude session before the next run (null: unknown / new session). */
export function claudeCostBefore(configDir: string, session: string | null): number | null {
  if (!session) return null
  try {
    const f = claudeSessionLog(configDir, session)
    return f ? lastClaudeSessionCost(readTail(f)) : null
  } catch {
    return null
  }
}

/** This run's cost from the CLI's cumulative total. A total below the previous one means the CLI started over. */
export function runCost(total: number | undefined, before: number | null): number | undefined {
  if (typeof total !== 'number' || !isFinite(total)) return undefined
  if (before === null || total < before) return total
  return Math.max(0, total - before)
}

// ---- codex -----------------------------------------------------------------------------------

export interface CodexTotals {
  input_tokens?: number
  cached_input_tokens?: number
  cache_write_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
}

/** Running totals of the rollout's last `token_count` event. */
export const lastCodexTotals = (text: string): CodexTotals | null =>
  lastLine(text, '"token_count"', (d) => {
    const t = d?.payload?.info?.total_token_usage
    return t && typeof t === 'object' ? (t as CodexTotals) : null
  })

export function codexTotalsBefore(rollout: string | null): CodexTotals | null {
  if (!rollout) return null
  try {
    return lastCodexTotals(readTail(rollout))
  } catch {
    return null
  }
}

const num = (v: unknown): number => (typeof v === 'number' && isFinite(v) && v > 0 ? v : 0)

/**
 * This turn's usage from `turn.completed.usage` (session totals) minus the totals before the turn.
 * Codex `input_tokens` includes the cached part; Usage.input is uncached only.
 */
export function codexTurnUsage(after: CodexTotals, before: CodexTotals | null): Usage {
  // a total below the previous one: codex started counting over, the report is this turn's own
  const base = before && num(after.input_tokens) >= num(before.input_tokens) && num(after.output_tokens) >= num(before.output_tokens) ? before : null
  const d = (k: keyof CodexTotals): number => Math.max(0, num(after[k]) - num(base?.[k]))
  const input = d('input_tokens')
  const cached = Math.min(d('cached_input_tokens'), input)
  const cacheWrite = d('cache_write_input_tokens')
  return {
    input: input - cached,
    output: d('output_tokens'),
    cacheRead: cached || undefined,
    cacheWrite: cacheWrite || undefined,
    reasoning: after.reasoning_output_tokens === undefined ? undefined : d('reasoning_output_tokens')
  }
}
