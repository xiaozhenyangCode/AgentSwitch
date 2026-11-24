import type { NumberedEntry } from './transcript'

const DEFAULT_BUDGET = 16_000
const RESULT_BUDGET = 240
const encoder = new TextEncoder()

export const estimateTokens = (text: string): number => Math.ceil(encoder.encode(text).length / 3)

export const contextBudgetFor = (contextWindow?: number): number =>
  contextWindow && Number.isFinite(contextWindow) && contextWindow > 0
    ? Math.min(DEFAULT_BUDGET, Math.floor(contextWindow / 4))
    : DEFAULT_BUDGET

export interface ContextItem {
  number: number
  id: string
  text: string
  kind: 'full' | 'truncated' | 'result'
}

export interface OmittedRange {
  from: number
  to: number
}

export interface BudgetedContext {
  items: ContextItem[]
  omitted: OmittedRange[]
}

export const transcriptText = (entry: NumberedEntry): string =>
  `第 ${entry.number} 条 · ${entry.speaker}：${entry.text}${entry.details ? '\n' + entry.details : ''}`

function prefixWithin(text: string, tokens: number): string {
  const bytes = encoder.encode(text)
  let end = tokens * 3
  if (bytes.length <= end) return text
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  return new TextDecoder().decode(bytes.subarray(0, end))
}

function roundsOf(entries: NumberedEntry[]): NumberedEntry[][] {
  const rounds: NumberedEntry[][] = []
  for (const entry of entries) {
    if (!rounds.length || entry.profileId === null) rounds.push([])
    rounds[rounds.length - 1].push(entry)
  }
  return rounds
}

export function selectContext(entries: NumberedEntry[], budget: number, keepOriginal = true): BudgetedContext {
  const items = new Map<number, ContextItem>()
  let left = Math.max(0, Math.floor(budget))
  const cost = (text: string) => estimateTokens(text + '\n')
  const add = (entry: NumberedEntry, text: string, kind: ContextItem['kind']) => {
    items.set(entry.number, { number: entry.number, id: entry.id, text, kind })
    left -= cost(text)
  }
  const keep = (entry: NumberedEntry, text: string) => {
    if (cost(text) <= left) add(entry, text, 'full')
    else if (left > 1) add(entry, prefixWithin(text, left - 1), 'truncated')
  }

  const original = keepOriginal ? entries.find((entry) => entry.profileId === null) : undefined
  if (original) keep(original, transcriptText(original))

  const rounds = roundsOf(entries)
  const latest = rounds.pop()
  if (latest) {
    const question = latest[0].profileId === null ? latest.shift() : undefined
    const priority = latest.reverse()
    if (question) priority.unshift(question)
    for (const entry of priority) {
      if (items.has(entry.number)) continue
      const text = transcriptText(entry)
      const fits = cost(text) <= left
      keep(entry, text)
      if (!fits) break
    }
  }

  for (let i = rounds.length - 1; i >= 0 && left > 0; i--) {
    const round = rounds[i].filter((entry) => !items.has(entry.number))
    const texts = round.map(transcriptText)
    if (texts.reduce((total, text) => total + cost(text), 0) > left) break
    round.forEach((entry, index) => add(entry, texts[index], 'full'))
  }

  for (let i = entries.length - 1; i >= 0 && left > 1; i--) {
    const entry = entries[i]
    if (entry.profileId === null || !entry.details || items.has(entry.number)) continue
    const label = `第 ${entry.number} 条 · ${entry.speaker}（关键结果）：`
    const limit = Math.min(RESULT_BUDGET, left) - 1
    if (estimateTokens(label) >= limit) continue
    const result = label + entry.details
    add(entry, estimateTokens(result) <= limit ? result : prefixWithin(result, limit - 1) + '…', 'result')
  }

  const omitted: OmittedRange[] = []
  for (const entry of entries) {
    if (items.get(entry.number)?.kind === 'full') continue
    const last = omitted[omitted.length - 1]
    if (last?.to === entry.number - 1) last.to = entry.number
    else omitted.push({ from: entry.number, to: entry.number })
  }
  return { items: [...items.values()].sort((a, b) => a.number - b.number), omitted }
}

export function formatContext(context: BudgetedContext, readable: boolean): string {
  const lines = context.items.map((item) => item.kind === 'truncated'
    ? item.text + (readable ? '\n（已截断，可用 read_thread 读取全文）' : '\n（已截断）')
    : item.text)
  if (context.omitted.length) {
    const ranges = context.omitted.map(({ from, to }) => from === to ? `${from}` : `${from}–${to}`)
    lines.push(`以下消息的部分或全部内容已省略：第 ${ranges.join('、')} 条。`)
    if (readable) lines.push('需要时调用 read_thread，传入起止序号 from 和 to，读取本对话的原文。')
  }
  return lines.join('\n')
}

export function budgetedHandoff(entries: NumberedEntry[], budget: number, keepOriginal: boolean, toolsSupported: boolean) {
  let available = Math.max(0, Math.floor(budget))
  while (true) {
    const context = selectContext(entries, available, keepOriginal)
    const readable = toolsSupported && context.omitted.length > 0
    const text = formatContext(context, readable)
    const excess = estimateTokens(text) - budget
    if (excess <= 0) return { text, readable }
    if (available === 0) return { text: prefixWithin(text, Math.max(0, Math.floor(budget))), readable }
    // Omission notices also take space in the model's context.
    available = Math.max(0, available - excess)
  }
}
