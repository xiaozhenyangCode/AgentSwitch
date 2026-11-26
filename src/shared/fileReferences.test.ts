import { describe, expect, it } from 'vitest'
import type { Attachment } from './chat'
import {
  attachmentDedupKey, attachmentRefLabel, formatComposerFileRef, formatInlineCodePath,
  mergeAttachments, removeFileReferences, scanFileReferences, serializePromptWithAttachments
} from './fileReferences'
import { maskCode } from './mentions'
import type { ResolvedRunAttachment } from './types'

function file(id: string, name: string, path: string, extra: Partial<Attachment> = {}): Attachment {
  return { id, name, path, isImage: false, thumb: null, size: 0, ...extra }
}

describe('attachment identity and file references', () => {
  it('merges an indexed workspace file and a dropped file, preserving identity and preview metadata', () => {
    const workspace = file('picked', 'shot.png', '/project/assets/shot.png',
      { source: 'workspace-file', relativePath: 'assets/shot.png', isImage: true })
    const dropped = file('dropped', 'shot.png', '/project/assets/nested/../shot.png',
      { thumb: 'thumbnail', size: 42, isImage: true })
    const result = mergeAttachments([workspace], [dropped], '/project')
    expect(result.next).toEqual([{ ...workspace, thumb: 'thumbnail', size: 42 }])
    expect(result.resolved).toEqual(result.next)
    expect(attachmentDedupKey(file('a', 'file', 'C:\\Repo\\file.txt')))
      .toBe(attachmentDedupKey(file('b', 'file', 'c:/repo/file.txt')))
    expect(attachmentDedupKey(file('a', 'file', '/repo/a\\b.txt')))
      .not.toBe(attachmentDedupKey(file('b', 'file', '/repo/a/b.txt')))
  })

  it('uses stable labels for same-name attachments and a colliding workspace file', () => {
    const first = file('first', 'image.png', '/stage/upload-a.png')
    const second = file('second', 'image.png', '/stage/upload-b.png')
    const third = file('third', 'image.png', '/downloads/image.png')
    const project = file('project', 'image.png', '/project/image.png')
    const { next } = mergeAttachments([], [first, second, third, project], '/project')
    expect(next.map(attachmentRefLabel)).toEqual(['image.png', 'image-2.png', 'downloads/image.png', 'image-3.png'])
    expect(next[3]).toMatchObject({ source: 'workspace-file', relativePath: 'image.png' })
    expect(mergeAttachments(next, [second, file('over', 'over', '/over')], '/project', 4).resolved.map((a) => a.id)).toEqual(['second'])
    const refs = '#image.png #image-2.png #downloads/image.png #image-3.png'
    expect(removeFileReferences(refs, next[1], next)).toBe('#image.png #downloads/image.png #image-3.png')
  })

  it('round-trips special names while protecting code and legacy JSON-quoted labels', () => {
    const a = file('a', 'my @Codex `spec`.md', '/tmp/spec.md')
    const b = file('b', 'line\nbreak.md', '/tmp/break.md')
    const c = file('c', 'note.md', '/tmp/note.md')
    const inline = formatComposerFileRef(a.name)
    expect(inline).toBe('#`` my @Codex `spec`.md ``')
    const escaped = formatComposerFileRef(b.name)
    const legacy = '#`' + JSON.stringify(a.name).replace(/`/g, '\\u0060') + '`'
    const text = [inline + '， ' + escaped, legacy, '`#note.md`', '~~~md', '#note.md', '~~~~',
      '````txt', '#note.md', '```', '#note.md', '````', '#note.md.'].join('\n')
    expect(scanFileReferences(text, [a, b, c]).map(({ raw, index }) => [raw, index]))
      .toEqual([[inline, 0], [escaped, 1], [legacy, 0], ['#note.md', 2]])
    expect(maskCode(inline)).toBe('#' + ' '.repeat(inline.length - 1))
    expect(formatInlineCodePath(' path ')).toBe('`  path  `')
  })

  it('removes all occurrences while keeping punctuation, line breaks and code examples', () => {
    const a = file('a', 'readme.md', '/tmp/readme.md')
    const text = 'See \t #readme.md  #readme.md , then continue.\n  #readme.md  \n`#readme.md` stays\n  unrelated  whitespace'
    expect(removeFileReferences(text, a)).toBe('See, then continue.\n\n`#readme.md` stays\n  unrelated  whitespace')
  })

  it('serializes matched occurrences in place and lists remaining paths exactly once', () => {
    const workspace: ResolvedRunAttachment = {
      name: 'my @spec.md', absPath: '/workspace/docs/my @spec.md', promptPath: 'docs/my @spec.md',
      relativePath: 'docs/my @spec.md', scope: 'workspace', refLabel: 'docs/my @spec.md', isImage: false
    }
    const screenshot: ResolvedRunAttachment = {
      name: 'image.png', absPath: '/archive/my capture.png', promptPath: '/archive/my capture.png',
      scope: 'external', refLabel: 'image.png', isImage: true
    }
    const docs = { ...screenshot, name: 'notes.txt', refLabel: 'notes.txt', promptPath: '/tmp/notes.txt', isImage: false }
    const raw = 'Compare ' + formatComposerFileRef(workspace.refLabel) + ' with #image.png. Again #image.png'
    expect(serializePromptWithAttachments(raw, [workspace, screenshot, docs, { ...docs, refLabel: 'duplicate.txt' }])).toMatchObject({
      text: 'Compare `docs/my @spec.md` with `/archive/my capture.png`. Again `/archive/my capture.png`\n\n附带文件：\n- `/tmp/notes.txt`',
      referencedCount: 2, unreferenced: [docs]
    })
    expect(serializePromptWithAttachments('', [docs]).text).toBe('附带文件：\n- `/tmp/notes.txt`')
  })
})
