import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs'
import { isTranscriptEntry, toTranscript, type TranscriptEntry } from '@shared/transcript'
import { parseThread } from './chatStore'

const PAGE_MESSAGES = 40
const PAGE_CHARS = 60_000
const SEARCH_MATCHES = 40

export const THREAD_HISTORY_FORMAT = 'agentswitch-thread-history'

export const threadTools = [
  {
    name: 'read_thread',
    description: '读取当前对话指定序号范围内的原文和时间（Unix 毫秒）。若返回 next，将其作为下一次调用的参数。',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'integer', minimum: 1 },
        to: { type: 'integer', minimum: 1 },
        offset: { type: 'integer', minimum: 0, description: '仅在 next 提供此值时传入。' }
      },
      required: ['from', 'to'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'search_thread',
    description: '按关键词在当前对话中查找消息序号及片段。用 read_thread 读取原文。',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', minLength: 1, maxLength: 256 }, from: { type: 'integer', minimum: 1 } },
      required: ['query'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }
] as const

export function isThreadHistoryToolName(name: unknown): boolean {
  return typeof name === 'string' && /^(?:(?:mcp__)?agentswitch(?:__|[:./])|mcp_agentswitch_)?(?:read_thread|search_thread)$/.test(name)
}

export function createThreadHistoryReader(path: string, threadId: string): () => TranscriptEntry[] {
  let cached: { signature: string; history: TranscriptEntry[] } | undefined
  return () => {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile()) throw new Error('Expected a regular history file')
      const signature = `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`
      if (cached?.signature === signature) return cached.history
      const data = JSON.parse(readFileSync(fd, 'utf8'))
      if (data?.id !== threadId) throw new Error('History belongs to a different conversation')
      let history: TranscriptEntry[]
      if (data.format === THREAD_HISTORY_FORMAT) {
        if (!Array.isArray(data.messages) || !data.messages.every(isTranscriptEntry)) throw new Error('Invalid history')
        history = data.messages
      } else {
        history = toTranscript(parseThread(data).messages)
      }
      cached = { signature, history }
      return history
    } finally {
      closeSync(fd)
    }
  }
}

export function loadThreadHistory(path: string, threadId: string): TranscriptEntry[] {
  return createThreadHistoryReader(path, threadId)()
}

function argObject(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error('参数不正确。此工具只读取当前对话。')
  }
  return value as Record<string, unknown>
}

function index(value: unknown, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error('请输入有效的消息序号或位置。')
  return value
}

export function readThreadPage(history: TranscriptEntry[], input: unknown) {
  const args = argObject(input, ['from', 'to', 'offset'])
  const from = index(args.from, 1)
  const to = index(args.to, from)
  let offset = args.offset === undefined ? 0 : index(args.offset, 0)
  const last = Math.min(to, history.length)
  const messages = []
  let remaining = PAGE_CHARS
  let number = from
  for (; number <= last && messages.length < PAGE_MESSAGES && remaining > 0; number++) {
    const entry = history[number - 1]
    const body = entry.text + (entry.details ?? '')
    if (offset > body.length || (offset > 0 && /[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(body.slice(offset - 1, offset + 1)))) {
      throw new Error('消息位置超出范围。')
    }
    if (!offset && messages.length && body.length > remaining) break
    let end = Math.min(body.length, offset + remaining)
    // Keep a surrogate pair together across text pages.
    if (end < body.length && /[\uDC00-\uDFFF]/.test(body[end])) end--
    if (end <= offset && end < body.length) break
    messages.push({
      number, speaker: entry.speaker, role: entry.profileId === null ? 'user' : 'assistant', time: entry.time,
      text: entry.text.slice(offset, end),
      ...(entry.details && end > entry.text.length
        ? { details: entry.details.slice(Math.max(0, offset - entry.text.length), end - entry.text.length) }
        : {})
    })
    if (end < body.length) {
      offset = end
      break
    }
    remaining -= end - offset
    offset = 0
  }
  const next = number <= last ? { from: number, to, ...(offset ? { offset } : {}) } : null
  return { messages, next }
}

export function searchThread(history: TranscriptEntry[], input: unknown) {
  const args = argObject(input, ['query', 'from'])
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  if (!query || query.length > 256) throw new Error('请输入有效的搜索关键词。')
  const from = args.from === undefined ? 1 : index(args.from, 1)
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu')
  const matches = []
  let number = from
  for (; number <= history.length && matches.length < SEARCH_MATCHES; number++) {
    const entry = history[number - 1]
    const body = entry.details ? entry.text + '\n' + entry.details : entry.text
    const match = pattern.exec(body)
    if (!match) continue
    const start = Math.max(0, match.index - 60)
    matches.push({ number, speaker: entry.speaker, snippet: body.slice(start, match.index + match[0].length + 60) })
  }
  return { matches, next: number <= history.length ? { query, from: number } : null }
}
