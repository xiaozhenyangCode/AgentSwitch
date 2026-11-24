/**
 * Persistent text-only input history & ↑/↓ navigation state machine for the composer.
 * Pure & DOM-free so every boundary condition (empty input, first/last line, multiline middle
 * line, draft preservation, adjacent dedupe, cap) is unit-tested directly.
 */

export const INPUT_HISTORY_KEY = 'agentswitch.inputHistory.v1'
export const INPUT_HISTORY_MAX = 100

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface HistoryCursor {
  idx: number
  saved: string
}

export interface HistoryStepResult {
  handled: boolean
  cursor: HistoryCursor | null
  text?: string
}

const defaultStorage = (): StorageLike | null => (typeof localStorage !== 'undefined' ? localStorage : null)

export function loadInputHistory(storage: StorageLike | null = defaultStorage()): string[] {
  if (!storage) return []
  try {
    const arr = JSON.parse(storage.getItem(INPUT_HISTORY_KEY) ?? '[]')
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string' && x.length > 0) : []
  } catch {
    return []
  }
}

export function pushInputHistory(entry: string, storage: StorageLike | null = defaultStorage(), max = INPUT_HISTORY_MAX): string[] {
  const s = entry.trim()
  const arr = loadInputHistory(storage)
  if (!s) return arr
  if (arr[arr.length - 1] === s) return arr
  const next = [...arr, s].slice(-max)
  try {
    storage?.setItem(INPUT_HISTORY_KEY, JSON.stringify(next))
  } catch {
    /* ignore storage quota */
  }
  return next
}

/**
 * Computes the next composer state on `ArrowUp` / `ArrowDown`.
 *
 * Rules:
 * - Never intercepts when there is an active selection (`selectionStart !== selectionEnd`) or no history.
 * - Entering history via `ArrowUp` triggers only when input is empty OR cursor is on the first line.
 * - While browsing history (`cursor !== null`):
 *   - `ArrowUp` steps backward when on the first line (or when the recalled entry is still unedited).
 *   - `ArrowDown` steps forward when on the last line (or unedited); stepping past the newest entry
 *     restores the unsent `saved` draft and exits history mode (`cursor: null`).
 * - Middle lines of a multiline edit never intercept, preserving native caret navigation.
 */
export function stepInputHistory(opts: {
  key: 'ArrowUp' | 'ArrowDown'
  value: string
  selectionStart: number
  selectionEnd: number
  history: string[]
  cursor: HistoryCursor | null
}): HistoryStepResult {
  const { key, value, selectionStart, selectionEnd, history, cursor } = opts
  if (!history.length || selectionStart !== selectionEnd) return { handled: false, cursor }

  const browsingUnedited = cursor !== null && cursor.idx < history.length && value === history[cursor.idx]
  if (key === 'ArrowUp') {
    const onFirstLine = !value.slice(0, selectionStart).includes('\n')
    const canEnter = value.length === 0 || onFirstLine
    if (cursor === null) {
      if (!canEnter) return { handled: false, cursor }
      const idx = history.length - 1
      return { handled: true, cursor: { idx, saved: value }, text: history[idx] }
    }
    if (!browsingUnedited && !onFirstLine) return { handled: false, cursor }
    if (cursor.idx > 0) {
      const idx = cursor.idx - 1
      return { handled: true, cursor: { idx, saved: cursor.saved }, text: history[idx] }
    }
    // Already at oldest entry while browsing: consume key cleanly without losing cursor.
    return { handled: true, cursor }
  }

  // ArrowDown
  if (cursor === null) return { handled: false, cursor }
  const onLastLine = !value.slice(selectionEnd).includes('\n')
  if (!browsingUnedited && !onLastLine) return { handled: false, cursor }
  if (cursor.idx + 1 < history.length) {
    const idx = cursor.idx + 1
    return { handled: true, cursor: { idx, saved: cursor.saved }, text: history[idx] }
  }
  return { handled: true, cursor: null, text: cursor.saved }
}
