import { describe, expect, it } from 'vitest'
import { applyConflictChoice, inspectGitConflicts, parseGitConflicts } from './gitConflicts'

const twoWay = (left: string, right: string, nl = '\n') =>
  ['<<<<<<< HEAD', left, '=======', right, '>>>>>>> topic'].join(nl) + nl

describe('Git conflict blocks', () => {
  it('reports line numbers, labels and exact content for standard two-way blocks', () => {
    const text = 'header\n' + twoWay('保留', '追加') + 'footer\n'
    expect(parseGitConflicts(text)).toEqual([{
      index: 0, startLine: 2, endLine: 6, currentLabel: 'HEAD', incomingLabel: 'topic',
      current: '保留\n', incoming: '追加\n'
    }])
    expect(applyConflictChoice(text, 0, 'current')).toBe('header\n保留\nfooter\n')
    expect(applyConflictChoice(text, 0, 'incoming')).toBe('header\n追加\nfooter\n')
    const both = applyConflictChoice(text, 'all', 'both')
    expect(both).toBe('header\n保留\n追加\nfooter\n')
    expect(parseGitConflicts(both)).toEqual([])
  })

  it('shows the diff3 base without including it in the chosen result and preserves a BOM and CRLF', () => {
    const text = '\uFEFF' + ['<<<<<<< HEAD', 'ours', '||||||| parent', 'original', '=======', 'theirs', '>>>>>>> topic', 'tail', ''].join('\r\n')
    expect(parseGitConflicts(text)).toMatchObject([{ base: 'original\r\n', current: 'ours\r\n', incoming: 'theirs\r\n' }])
    expect(applyConflictChoice(text, 'all', 'both')).toBe('\uFEFFours\r\ntheirs\r\ntail\r\n')
  })

  it('updates only the requested block and handles empty sides and mixed source line endings', () => {
    const first = twoWay('first ours', 'first theirs', '\r\n')
    const second = '<<<<<<< HEAD\n=======\nsecond theirs\n>>>>>>> topic\n'
    const text = first + 'gap\r\n' + second
    expect(parseGitConflicts(text).map(({ index, startLine }) => [index, startLine])).toEqual([[0, 1], [1, 7]])
    expect(applyConflictChoice(text, 1, 'current')).toBe(first + 'gap\r\n')
    expect(applyConflictChoice(text, 0, 'incoming')).toBe('first theirs\r\ngap\r\n' + second)
    expect(applyConflictChoice(text, 'all', 'incoming')).toBe('first theirs\r\ngap\r\nsecond theirs\n')
    expect(() => applyConflictChoice(text, 2, 'incoming')).toThrow(/no longer exists/)
  })

  it('preserves missing final newlines and leaves surrounding text byte-for-byte identical', () => {
    const text = 'before\r\n' + twoWay('one', 'two', '\r\n').slice(0, -2)
    expect(applyConflictChoice(text, 'all', 'incoming')).toBe('before\r\ntwo')
    expect(applyConflictChoice(text, 'all', 'both')).toBe('before\r\none\r\ntwo')
    expect(applyConflictChoice(twoWay('one', 'two') + 'after', 'all', 'current')).toBe('one\nafter')
    expect(applyConflictChoice('header\n<<<<<<< HEAD\n=======\nincoming\n>>>>>>> topic', 0, 'current')).toBe('header')
  })

  it('detects malformed and nested marker sequences without treating ordinary separator lines as conflicts', () => {
    expect(inspectGitConflicts('Title\n=======\nText')).toEqual({ hunks: [], malformed: false })
    for (const text of ['<<<<<<< HEAD\nours\n', '>>>>>>> orphan\n', twoWay(twoWay('nested', 'incoming'), 'theirs')]) {
      expect(inspectGitConflicts(text).malformed).toBe(true)
      expect(() => applyConflictChoice(text, 'all', 'incoming')).toThrow(/incomplete or nested/)
    }
  })
})
