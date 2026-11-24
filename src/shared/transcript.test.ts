import { describe, expect, it } from 'vitest'
import { numberTranscript, reportedContextWindow, unseenTranscript, type TranscriptEntry } from './transcript'

const u = (text: string): TranscriptEntry => ({ id: text, turnId: text, profileId: null, speaker: '用户', time: 1, text })
const a = (id: string, text: string): TranscriptEntry => ({ id: text, turnId: text, profileId: id, speaker: id, time: 2, text })

describe('unseenTranscript', () => {
  const entries = [u('q1'), a('claude-1', 'r1'), u('q2'), a('codex-1', 'r2'), u('q3'), a('codex-1', 'r3')]

  it('gives a fresh session the whole recap', () => {
    expect(unseenTranscript(entries, 'claude-1', false)).toEqual(entries)
  })
  it('gives a resumed session only what came after its own last reply', () => {
    expect(unseenTranscript(entries, 'claude-1', true)).toEqual(entries.slice(2))
  })
  it('sends nothing to the account that answered last', () => {
    expect(unseenTranscript(entries, 'codex-1', true)).toEqual([])
  })
  it('keeps everything when the account never replied within the recap', () => {
    expect(unseenTranscript(entries, 'gemini-1', true)).toEqual(entries)
  })
})

it('preserves message numbers after applying the resume cutoff and skips placeholders', () => {
  const entries = numberTranscript([u('q1'), a('claude-1', 'r1'), u('q2'), { ...a('claude-1', 'placeholder'), replied: false }])
  expect(unseenTranscript(entries, 'claude-1', true).map((entry) => entry.number)).toEqual([3, 4])
})

it('uses context windows reported by the matching model and account', () => {
  const entries = [
    { ...a('codex-1', 'r1'), model: 'small:high', actualModel: 'small-v1', contextWindow: 32_000 },
    { ...a('codex-1', 'r2'), model: 'big', contextWindow: 100_000 },
    { ...a('codex-2', 'r3'), model: 'small', contextWindow: 24_000 }
  ]
  expect(reportedContextWindow(entries, 'codex-1', 'small:low', 'codex')).toBe(32_000)
  expect(reportedContextWindow(entries, 'codex-1', 'small-v1', 'codex')).toBe(32_000)
  expect(reportedContextWindow(entries, 'codex-1', 'unknown', 'codex')).toBeUndefined()
})
