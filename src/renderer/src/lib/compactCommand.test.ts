import { describe, expect, it } from 'vitest'
import type { AssistantMessage, Message, SystemMessage, UserMessage } from '@shared/chat'
import type { SkillItem } from '@shared/types'
import {
  CACHE_COLD_GAP_MS,
  CACHE_COLD_MIN_TOKENS,
  cacheColdGap,
  COMPACT_COMMAND_INSERT,
  CTX_COST_REDISPLAY_TURNS,
  CTX_REDISPLAY_TURNS,
  computeContextNotice,
  computeContextState,
  isCliCompactCommand,
  isCompactCommand,
  makeCompactSlashItem,
  mergeSlashCommands
} from './compactCommand'

const simpleFilter = (items: SkillItem[], q: string) =>
  items.filter((it) => it.name.toLowerCase().includes(q.toLowerCase()) || it.description.toLowerCase().includes(q.toLowerCase()))
const simplePinSort = (items: SkillItem[], pins: string[]) => {
  const set = new Set(pins)
  return [...items.filter((it) => set.has(it.name)), ...items.filter((it) => !set.has(it.name))]
}

const userMsg = (id: string, text = 'hello'): UserMessage => ({
  role: 'user',
  id,
  turnId: `t-${id}`,
  text,
  attachments: [],
  driver: { profileId: 'a', name: 'A', kind: 'claude', model: null },
  mentions: [],
  createdAt: 1
})

const replyMsg = (id: string, profileId: string, context?: number, contextWindow?: number): AssistantMessage => ({
  role: 'assistant',
  id,
  turnId: `t-${id}`,
  agent: { profileId, name: profileId.toUpperCase(), kind: 'claude', model: 'sonnet' },
  actualModel: 'sonnet',
  dispatchedBy: null,
  status: 'done',
  content: 'reply',
  activity: [],
  thinking: null,
  usage: context ? { input: 100, output: 50, context, ...(contextWindow ? { contextWindow } : {}) } : null,
  others: [],
  outputs: [],
  error: null,
  notices: [],
  review: false,
  retry: 0,
  verdict: null,
  startedAt: 10,
  endedAt: 20
})

const compactDivider = (id: string, profileIds?: string[]): SystemMessage => ({
  role: 'system',
  id,
  turnId: '',
  kind: 'compact',
  ...(profileIds ? { profileIds } : {}),
  createdAt: 30
})

describe('compactCommand helpers', () => {
  it('recognizes standalone /compact (half-width and full-width) and ignores non-exact text', () => {
    expect(isCompactCommand('/compact')).toBe(true)
    expect(isCompactCommand('  /COMPACT  ')).toBe(true)
    expect(isCompactCommand('／compact')).toBe(true)
    expect(isCompactCommand('/compact extra')).toBe(false)
    expect(isCompactCommand('please /compact')).toBe(false)
    expect(isCompactCommand('/comp')).toBe(false)
    expect(isCompactCommand('compact')).toBe(false)
  })

  it('merges built-in /compact into slash menu, deduplicates CLI native /compact, and preserves pin priority', () => {
    const cli: SkillItem[] = [
      { name: 'compact', description: 'CLI native compact', source: 'builtin', kind: 'command', insert: '/compact' },
      { name: 'review', description: 'Code review', source: 'project', kind: 'skill', insert: '/review' },
      { name: 'commit', description: 'Git commit', source: 'global', kind: 'skill', insert: '/commit' }
    ]
    const builtins = [makeCompactSlashItem('AgentSwitch compact')]

    expect(isCliCompactCommand(cli[0])).toBe(true)
    expect(isCliCompactCommand(cli[1])).toBe(false)

    // Empty query: pinned CLI skill first, then built-in /compact, then remaining CLI skills (no duplicate /compact)
    const empty = mergeSlashCommands(cli, builtins, '', ['review'], simpleFilter, simplePinSort)
    expect(empty.map((x) => `${x.insert}:${x.description}`)).toEqual([
      '/review:Code review',
      `${COMPACT_COMMAND_INSERT}:AgentSwitch compact`,
      '/commit:Git commit'
    ])

    // Querying "com": built-in /compact leads and matches alongside /commit
    const queried = mergeSlashCommands(cli, builtins, 'com', [], simpleFilter, simplePinSort)
    expect(queried.map((x) => x.insert)).toEqual(['/compact', '/commit'])
    expect(queried[0].description).toBe('AgentSwitch compact')

    // Providers without CLI skills (e.g. Reasonix) still offer built-in /compact
    const noSkills = mergeSlashCommands([], builtins, '', [], simpleFilter, simplePinSort)
    expect(noSkills).toHaveLength(1)
    expect(noSkills[0].insert).toBe('/compact')
  })

  it('tracks active session and resets context stats across compact dividers per account', () => {
    // Empty chat: no active session
    expect(computeContextState([], 'a')).toMatchObject({ hasActiveSession: false, lastTokens: 0, userTurns: 0 })

    // After driver replies: active session + token count
    const base: Message[] = [userMsg('u1'), replyMsg('r1', 'a', 42_000, 200_000), userMsg('u2'), replyMsg('r2', 'b', 80_000)]
    expect(computeContextState(base, 'a')).toMatchObject({
      hasActiveSession: true,
      lastTokens: 42_000,
      reportedWindow: 200_000,
      lastId: 'r1',
      userTurns: 2
    })

    // After compacting account 'a': 'a' has no active session, while 'b' still does
    const afterCompactA: Message[] = [...base, compactDivider('c1', ['a'])]
    expect(computeContextState(afterCompactA, 'a')).toMatchObject({
      hasActiveSession: false,
      lastTokens: 0,
      lastId: '',
      userTurns: 2
    })
    expect(computeContextState(afterCompactA, 'b')).toMatchObject({
      hasActiveSession: true,
      lastTokens: 80_000,
      lastId: 'r2'
    })

    // After 'a' replies again post-compact: active session resumes with fresh tokens
    const afterNextReply: Message[] = [...afterCompactA, userMsg('u3'), replyMsg('r3', 'a', 18_000)]
    expect(computeContextState(afterNextReply, 'a')).toMatchObject({
      hasActiveSession: true,
      lastTokens: 18_000,
      lastId: 'r3',
      userTurns: 3
    })

    // Carried history without a new reply in this thread has no active native session yet
    expect(computeContextState(base, 'a', base.length)).toMatchObject({ hasActiveSession: false, lastTokens: 0 })

    // Imported active thread vs preview thread
    const imported = { key: 'k', profileId: 'a', kind: 'claude' as const, nativeId: 'n', importedAt: 1, notice: null }
    expect(computeContextState([], 'a', 0, imported, true).hasActiveSession).toBe(false)
    expect(computeContextState([], 'a', 0, imported, false).hasActiveSession).toBe(true)
    expect(computeContextState([compactDivider('c2', ['a'])], 'a', 0, imported, false).hasActiveSession).toBe(false)
  })

  it('shows context notices again after switching threads while respecting in-visit dismissals', () => {
    // 1M window at 190k tokens -> costly notice
    const costlyBase = { threadId: 't1', lastTokens: 190_000, lastId: 'm1', window: 1_000_000, userTurns: 6 }
    expect(computeContextNotice({ ...costlyBase, dismissed: null })).toBe('costly')

    // Dismissing hides it during the current visit (same reply or before redisplay turns)
    const dismissedCost = { threadId: 't1', cost: { messageId: 'm1', userTurns: 6 } }
    expect(computeContextNotice({ ...costlyBase, dismissed: dismissedCost })).toBe(null)
    expect(computeContextNotice({ ...costlyBase, lastId: 'm2', userTurns: 6 + CTX_COST_REDISPLAY_TURNS - 1, dismissed: dismissedCost })).toBe(null)
    expect(computeContextNotice({ ...costlyBase, lastId: 'm3', userTurns: 6 + CTX_COST_REDISPLAY_TURNS, dismissed: dismissedCost })).toBe('costly')

    // Switching away and returning resets dismissal (null or stale threadId) -> notice shows again
    expect(computeContextNotice({ ...costlyBase, dismissed: null })).toBe('costly')
    expect(computeContextNotice({ ...costlyBase, dismissed: { threadId: 't2', cost: { messageId: 'm1', userTurns: 6 } } })).toBe('costly')

    // Compacted fallback suppresses re-prompting for the exact same messageId
    expect(computeContextNotice({ ...costlyBase, dismissed: null, compactedMessageId: 'm1' })).toBe(null)

    // 200k window at 185k tokens (>= 70% AND >= 180k) -> long notice; dismissing does not fall through to costly
    const longBase = { threadId: 't1', lastTokens: 185_000, lastId: 'm4', window: 200_000, userTurns: 8 }
    expect(computeContextNotice({ ...longBase, dismissed: null })).toBe('long')
    const dismissedLong = { threadId: 't1', warnAt: 8 }
    expect(computeContextNotice({ ...longBase, dismissed: dismissedLong })).toBe(null)
    expect(computeContextNotice({ ...longBase, userTurns: 8 + CTX_REDISPLAY_TURNS - 1, dismissed: dismissedLong })).toBe(null)
    expect(computeContextNotice({ ...longBase, userTurns: 8 + CTX_REDISPLAY_TURNS, dismissed: dismissedLong })).toBe('long')
    // Switching back to t1 shows long notice again
    expect(computeContextNotice({ ...longBase, dismissed: { threadId: 't2', warnAt: 8 } })).toBe('long')
  })

  it('warns about a cold prompt cache only for large, long-idle sessions of measured kinds', () => {
    const gap = CACHE_COLD_GAP_MS.gemini!
    const base = { kind: 'gemini' as const, lastEndedAt: 1_000_000, lastTokens: CACHE_COLD_MIN_TOKENS }
    expect(cacheColdGap({ ...base, now: base.lastEndedAt + gap - 1 })).toBe(null)
    expect(cacheColdGap({ ...base, now: base.lastEndedAt + gap })).toBe(gap)
    expect(cacheColdGap({ ...base, lastTokens: CACHE_COLD_MIN_TOKENS - 1, now: base.lastEndedAt + gap })).toBe(null)
    expect(cacheColdGap({ ...base, lastEndedAt: 0, now: gap * 10 })).toBe(null)
    expect(cacheColdGap({ ...base, kind: 'claude', now: base.lastEndedAt + gap })).toBe(null)
    expect(cacheColdGap({ ...base, kind: null, now: base.lastEndedAt + gap })).toBe(null)
  })

  it('ranks the cold notice above long/costly, dismisses it per reply, and skips compacted sessions', () => {
    const gap = CACHE_COLD_GAP_MS.gemini!
    const cold = { threadId: 't1', lastTokens: 400_000, lastId: 'm1', window: 512_000, userTurns: 9, kind: 'gemini' as const, lastEndedAt: 1_000, now: 1_000 + gap }
    expect(computeContextNotice({ ...cold, dismissed: null })).toBe('cold')
    // Still warm: falls back to the long notice (400k >= 70% of 512k)
    expect(computeContextNotice({ ...cold, now: 1_000 + gap - 1, dismissed: null })).toBe('long')
    // Without a clock the cold check is off (e.g. session below threshold)
    expect(computeContextNotice({ ...cold, now: undefined, dismissed: null })).toBe('long')
    // Dismissing hides it for this reply only and shows the remaining notice
    expect(computeContextNotice({ ...cold, dismissed: { threadId: 't1', cold: 'm1' } })).toBe('long')
    expect(computeContextNotice({ ...cold, lastId: 'm2', dismissed: { threadId: 't1', cold: 'm1' } })).toBe('cold')
    expect(computeContextNotice({ ...cold, dismissed: { threadId: 't2', cold: 'm1' } })).toBe('cold')
    // A compacted session no longer resumes the cold context
    expect(computeContextNotice({ ...cold, dismissed: null, compactedMessageId: 'm1' })).toBe('long')
  })

  it('reports when the lead reply with context finished', () => {
    const a = { ...replyMsg('r1', 'a', 200_000), endedAt: 42 }
    const b = { ...replyMsg('r2', 'b', 300_000), endedAt: 99 }
    expect(computeContextState([userMsg('u1'), a, b], 'a').lastEndedAt).toBe(42)
    expect(computeContextState([userMsg('u1'), b], 'a').lastEndedAt).toBe(0)
  })
})
