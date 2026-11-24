import { mkdtempSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TranscriptEntry } from '@shared/transcript'
import { createThreadHistoryReader, loadThreadHistory, readThreadPage, searchThread, THREAD_HISTORY_FORMAT } from './threadHistoryTools'

const entry = (n: number, text = `消息 ${n}`): TranscriptEntry => ({
  id: `m${n}`, turnId: 'turn', profileId: n % 2 ? null : 'codex',
  speaker: n % 2 ? '用户' : 'Codex', time: n * 1000, text
})
const history = Array.from({ length: 43 }, (_, i) => entry(i + 1))

describe('thread history tools', () => {
  it('preserves original text, speaker, timestamp and absolute message number', () => {
    const page = readThreadPage([entry(1, '  用户任务\n'), { ...entry(2), details: '产出文件：test.txt' }], { from: 1, to: 2 })
    expect(page).toEqual({
      messages: [
        { number: 1, speaker: '用户', role: 'user', time: 1000, text: '  用户任务\n' },
        { number: 2, speaker: 'Codex', role: 'assistant', time: 2000, text: '消息 2', details: '产出文件：test.txt' }
      ],
      next: null
    })
  })

  it('limits the page to 40 messages and rejects attempts to select another file or conversation', () => {
    const first = readThreadPage(history, { from: 1, to: 999 })
    expect(first.messages).toHaveLength(40)
    expect(first.next).toEqual({ from: 41, to: 999 })
    expect(readThreadPage(history, first.next).messages.map((m) => m.number)).toEqual([41, 42, 43])
    for (const extra of [{ threadId: 'other' }, { path: '/tmp/other.json' }]) {
      expect(() => readThreadPage(history, { from: 1, to: 3, ...extra })).toThrow()
      expect(() => searchThread(history, { query: '消息', ...extra })).toThrow()
    }
    expect(() => readThreadPage(history, { from: 2, to: 1 })).toThrow()
    expect(() => readThreadPage(history, { from: 1.5, to: 3 })).toThrow()
  })

  it('paginates a single long message without losing text or breaking a surrogate pair', () => {
    const text = 'a'.repeat(59_999) + '😀中'
    const messages = [entry(1, text), entry(2)]
    const first = readThreadPage(messages, { from: 1, to: 2 })
    expect(first.next).toEqual({ from: 1, to: 2, offset: 59_999 })
    const second = readThreadPage(messages, first.next)
    expect(first.messages[0].text + second.messages[0].text).toBe(text)
    expect(second.messages[1].number).toBe(2)
    expect(second.next).toBeNull()
  })

  it('searches case-insensitive literal keywords in the same thread', () => {
    expect(searchThread([entry(1, 'prefix FILE+.md suffix'), entry(2, 'Fileee.md')], { query: 'file+.MD' }))
      .toEqual({ matches: [{ number: 1, speaker: '用户', snippet: 'prefix FILE+.md suffix' }], next: null })
    expect(searchThread(history, { query: '消息' }).next).toEqual({ query: '消息', from: 41 })
  })

  it('loads snapshots or saved chats only for the fixed ID and refuses symlinks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentswitch-history-test-'))
    try {
      const file = join(dir, 'thread.json')
      writeFileSync(file, JSON.stringify({ id: 'one', format: THREAD_HISTORY_FORMAT, messages: history }))
      expect(loadThreadHistory(file, 'one')).toEqual(history)
      expect(() => loadThreadHistory(file, 'another')).toThrow('different conversation')
      const link = join(dir, 'other.json')
      symlinkSync(file, link)
      expect(() => loadThreadHistory(link, 'one')).toThrow()

      const saved = join(dir, 'saved.json')
      writeFileSync(saved, JSON.stringify({
        id: 'saved', title: 'Saved', messages: [{ id: 'u1', turnId: 'turn', role: 'user', driver: { profileId: null }, text: 'From disk', createdAt: 100 }]
      }))
      expect(loadThreadHistory(saved, 'saved')[0]).toMatchObject({ id: 'u1', text: 'From disk', time: 100, driverId: null })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reopens each call, reuses unchanged data, and rejects removed or replaced unsafe snapshots', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentswitch-history-reader-'))
    const file = join(dir, 'history.json')
    const temp = join(dir, 'next.json')
    const snapshot = (id: string, messages: TranscriptEntry[]) => JSON.stringify({ id, format: THREAD_HISTORY_FORMAT, messages })
    const stamp = new Date('2026-01-01T00:00:00.000Z')
    try {
      writeFileSync(file, snapshot('thread', [entry(1, 'old')]))
      utimesSync(file, stamp, stamp)
      const read = createThreadHistoryReader(file, 'thread')
      const first = read()
      expect(read()).toBe(first)

      // Same size and mtime. The atomic replacement gives the file a new inode.
      writeFileSync(temp, snapshot('thread', [entry(1, 'new')]))
      utimesSync(temp, stamp, stamp)
      const original = statSync(file)
      renameSync(temp, file)
      const replaced = statSync(file)
      expect(replaced.size).toBe(original.size)
      expect(replaced.mtimeMs).toBe(original.mtimeMs)
      expect(replaced.ino).not.toBe(original.ino)
      expect(readThreadPage(read(), { from: 1, to: 1 }).messages[0].text).toBe('new')

      writeFileSync(temp, snapshot('thread', [entry(1), entry(2)]))
      renameSync(temp, file)
      expect(read()).toEqual([entry(1), entry(2)])
      rmSync(file)
      expect(read).toThrow()
      writeFileSync(temp, snapshot('other-id', [entry(1)]))
      symlinkSync(temp, file)
      expect(read).toThrow()
      rmSync(file)
      renameSync(temp, file)
      expect(read).toThrow('different conversation')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
