import { describe, expect, it } from 'vitest'
import { capTranscript, transcriptText, unseenTranscript, type TranscriptEntry } from './transcript'

const u = (text: string): TranscriptEntry => ({ profileId: null, text: `用户：${text}` })
const a = (id: string, text: string): TranscriptEntry => ({ profileId: id, text: `${id}：${text}` })

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

describe('capTranscript', () => {
  it('keeps the newest entries within the budget', () => {
    const out = capTranscript([u('a'.repeat(50)), u('b'.repeat(10)), a('x', 'c'.repeat(10))], 40)
    expect(out.map((e) => e.text)).toEqual(['用户：bbbbbbbbbb', 'x：cccccccccc'])
    expect(transcriptText(out).length).toBeLessThanOrEqual(40)
  })
  it('cuts the oldest kept entry from the front', () => {
    const out = capTranscript([u('0123456789')], 5)
    expect(out).toEqual([{ profileId: null, text: '56789' }])
  })
})
