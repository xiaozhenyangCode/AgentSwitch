import type { ProfileId } from './types'

/** One recent chat message; `profileId` is the replying account (null: the user). */
export interface TranscriptEntry {
  profileId: ProfileId | null
  text: string
}

/** Character budget of the recap that goes into a prompt (newest entries win). */
export const TRANSCRIPT_CHARS = 12000

/** Keeps the newest entries that fit the budget (only a lone newest entry is cut, from the front). */
export function capTranscript(entries: TranscriptEntry[], max = TRANSCRIPT_CHARS): TranscriptEntry[] {
  const out: TranscriptEntry[] = []
  let left = max
  for (let i = entries.length - 1; i >= 0 && left > 0; i--) {
    const e = entries[i]
    if (e.text.length > left && out.length) break
    const text = e.text.length > left ? e.text.slice(-left) : e.text
    out.unshift({ profileId: e.profileId, text })
    left -= text.length + 1
  }
  return out
}

/**
 * The part of the recap the account has not seen yet.
 *
 * A resumed CLI session already holds everything up to the account's own last reply, so only what
 * came after it (other accounts' replies, earlier user messages it never answered) is new. Sending
 * the whole recap again would add it to the session history on every turn and re-bill it on every
 * later request. A fresh session (no native session yet) gets the whole recap.
 */
export function unseenTranscript(entries: TranscriptEntry[], profileId: ProfileId, resuming: boolean): TranscriptEntry[] {
  if (!resuming) return entries
  let last = -1
  for (let i = entries.length - 1; i >= 0; i--)
    if (entries[i].profileId === profileId) {
      last = i
      break
    }
  return entries.slice(last + 1)
}

export const transcriptText = (entries: TranscriptEntry[]): string =>
  entries
    .map((e) => e.text.trim())
    .filter(Boolean)
    .join('\n')
