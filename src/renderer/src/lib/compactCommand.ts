import type { Message, Thread } from '@shared/chat'
import type { ProfileId, ProfileKind, SkillItem } from '@shared/types'

export const COMPACT_COMMAND_NAME = 'compact'
export const COMPACT_COMMAND_INSERT = '/compact'

/** True when the input is solely the built-in `/compact` (or full-width `／compact`) command. */
export function isCompactCommand(text: string): boolean {
  return /^[/／]compact$/i.test(text.trim())
}

/** True when a CLI skill/command collides with AgentSwitch's built-in `/compact`. */
export function isCliCompactCommand(item: Pick<SkillItem, 'name' | 'insert'>): boolean {
  return item.name.trim().toLowerCase() === COMPACT_COMMAND_NAME || item.insert.trim().toLowerCase() === COMPACT_COMMAND_INSERT
}

export function makeCompactSlashItem(description: string): SkillItem {
  return {
    name: COMPACT_COMMAND_NAME,
    description,
    source: 'builtin',
    packId: 'builtin',
    packKind: 'builtin',
    kind: 'command',
    insert: COMPACT_COMMAND_INSERT
  }
}

/**
 * Merges AgentSwitch's built-in `/compact` command with CLI skills for the `/` menu:
 * - Removes any CLI-native `/compact` entry so the built-in action is never duplicated.
 * - With an empty query, places pinned CLI skills first, then `/compact`, then the rest.
 * - With a query, delegates filtering to `filter` and prioritizes exact/prefix match on `/compact`.
 */
export function mergeSlashCommands(
  cliItems: SkillItem[],
  builtinItems: SkillItem[],
  query: string,
  pinned: string[],
  filter: (items: SkillItem[], q: string) => SkillItem[],
  pinSort: (items: SkillItem[], pins: string[]) => SkillItem[]
): SkillItem[] {
  const dedupedCli = cliItems.filter((it) => !isCliCompactCommand(it))
  const q = query.trim()
  if (!q) {
    const sorted = pinSort(dedupedCli, pinned)
    const pinSet = new Set(pinned)
    const pinnedPart = sorted.filter((it) => pinSet.has(it.name))
    const restPart = sorted.filter((it) => !pinSet.has(it.name))
    return [...pinnedPart, ...builtinItems, ...restPart]
  }
  const matchedBuiltins = filter(builtinItems, q)
  const matchedCli = filter(dedupedCli, q)
  return [...matchedBuiltins, ...matchedCli]
}

export interface ContextState {
  userTurns: number
  lastTokens: number
  lastId: string
  model: string | null
  reportedWindow: number
  /** Whether the lead account currently holds an uncompacted active session in this thread. */
  hasActiveSession: boolean
  /** When the lead account's latest reply with a reported context finished (0 if unknown). */
  lastEndedAt: number
}

export const CTX_WARN_RATIO = 0.7
export const CTX_REDISPLAY_TURNS = 10
export const CTX_COST_TOKENS = 180_000
export const CTX_COST_REDISPLAY_TURNS = 5

/**
 * Idle time after which the provider's prompt cache is likely gone. Measured on agy (Gemini 4
 * implicit cache): a resumed turn misses outright ~10% of the time after 1–5 min idle and ~34% past
 * 5 min, and each miss re-bills the whole context. Kinds without data stay unset (never warned).
 */
export const CACHE_COLD_GAP_MS: Partial<Record<ProfileKind, number>> = { gemini: 5 * 60_000 }
/** Below this, a cold resume costs about as much as a fresh session's ~28k system prefix. */
export const CACHE_COLD_MIN_TOKENS = 150_000

/** Ephemeral per-visit dismissal state: resets whenever the user switches away and returns. */
export interface ContextNoticeDismissal {
  threadId: string
  warnAt?: number
  cost?: { messageId: string; userTurns: number }
  /** Reply id whose cold-cache warning was dismissed; a later reply can warn again. */
  cold?: string
}

/** Idle milliseconds when resuming now would most likely re-read the full context uncached, else null. */
export function cacheColdGap(params: { kind?: ProfileKind | null; lastEndedAt: number; lastTokens: number; now: number }): number | null {
  const limit = params.kind ? CACHE_COLD_GAP_MS[params.kind] : undefined
  if (!limit || !params.lastEndedAt || params.lastTokens < CACHE_COLD_MIN_TOKENS) return null
  const gap = params.now - params.lastEndedAt
  return gap >= limit ? gap : null
}

/**
 * Decides which context notice banner (if any) to display for the active thread.
 * Dismissals are scoped to the current visit (`dismissed.threadId === threadId`) so switching to
 * another thread and coming back shows the notice again while context remains above threshold.
 */
export function computeContextNotice(params: {
  threadId: string
  lastTokens: number
  lastId: string
  window: number
  userTurns: number
  dismissed: ContextNoticeDismissal | null
  compactedMessageId?: string | null
  /** Lead account kind and wall clock, for the cold-cache warning. */
  kind?: ProfileKind | null
  lastEndedAt?: number
  now?: number
}): 'cold' | 'long' | 'costly' | null {
  const active = params.dismissed?.threadId === params.threadId ? params.dismissed : null
  // A cold resume re-bills the entire context at once, so it outranks the gradual long/costly notices.
  const compacted = !!params.compactedMessageId && params.lastId === params.compactedMessageId
  if (!compacted && active?.cold !== params.lastId && params.now !== undefined
    && cacheColdGap({ kind: params.kind, lastEndedAt: params.lastEndedAt ?? 0, lastTokens: params.lastTokens, now: params.now }) !== null) {
    return 'cold'
  }
  const overLong = params.window > 0 && params.lastTokens >= params.window * CTX_WARN_RATIO
  if (overLong) {
    const hidden = active?.warnAt !== undefined && params.userTurns < active.warnAt + CTX_REDISPLAY_TURNS
    return hidden ? null : 'long'
  }
  if (params.lastTokens >= CTX_COST_TOKENS) {
    if (params.compactedMessageId && params.lastId === params.compactedMessageId) return null
    const cost = active?.cost
    const hidden =
      !!cost &&
      (params.lastId === cost.messageId || params.userTurns < cost.userTurns + CTX_COST_REDISPLAY_TURNS)
    return hidden ? null : 'costly'
  }
  return null
}

/**
 * Computes the lead account's active context stats since the latest compact divider (or carried
 * history boundary), driving both the toolbar compact button and the long/costly context notices.
 */
export function computeContextState(
  messages: Message[],
  driverId: ProfileId | null | undefined,
  carriedMessageCount = 0,
  imported?: Thread['imported'],
  preview?: boolean
): ContextState {
  let lastCompactIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'system' && m.kind === 'compact' && (!m.profileIds || (!!driverId && m.profileIds.includes(driverId)))) {
      lastCompactIdx = i
      break
    }
  }
  const activeStart = Math.max(carriedMessageCount, lastCompactIdx + 1)
  let userTurns = 0
  let lastTokens = 0
  let lastId = ''
  let model: string | null = null
  let reportedWindow = 0
  let lastEndedAt = 0
  let hasActiveSession = lastCompactIdx < 0 && !!driverId && !!imported && !preview && imported.profileId === driverId

  for (let i = carriedMessageCount; i < messages.length; i++) {
    const m = messages[i]
    if (m.role === 'user' && m.kind !== 'handoff') userTurns++
    if (i >= activeStart && m.role === 'assistant' && m.agent.profileId === driverId) {
      if (m.status !== 'queued' && m.startedAt) hasActiveSession = true
      if (m.usage?.context) {
        lastTokens = m.usage.context
        lastId = m.id
        model = m.actualModel ?? m.agent.model
        reportedWindow = m.usage.contextWindow ?? 0
        lastEndedAt = m.endedAt ?? 0
      }
    }
  }

  return { userTurns, lastTokens, lastId, model, reportedWindow, hasActiveSession, lastEndedAt }
}
