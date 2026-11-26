import { describe, expect, it } from 'vitest'
import type { OutputFileRef } from './chat'
import {
  deriveRelativePath, extractMarkdownImageTargets, findMatchingOutputFile, isPreviewableImagePath,
  joinPosixRelative, mimeTypeForPath, resolveOutputFileCandidates, toPosixPath
} from './fileResolve'

describe('portable paths', () => {
  it('derives POSIX paths at directory boundaries, including Windows drives and shares', () => {
    expect(toPosixPath('C:\\project\\img.png')).toBe('C:/project/img.png')
    expect(deriveRelativePath('/a/proj/ui/img.png', '/a/proj/')).toBe('ui/img.png')
    expect(deriveRelativePath('/a/proj2/img.png', '/a/proj')).toBeNull()
    expect(deriveRelativePath('/a/proj/../img.png', '/a/proj')).toBeNull()
    expect(deriveRelativePath('/a/proj', '/a/proj')).toBeNull()
    expect(deriveRelativePath('/photo.png', '/')).toBe('photo.png')
    expect(deriveRelativePath('C:\\Project\\assets\\img.png', 'c:\\project')).toBe('assets/img.png')
    expect(deriveRelativePath('\\\\Host\\Share\\img.png', '//host/share')).toBe('img.png')
  })

  it('rejects rooted and escaping paths while allowing paths that stay inside the project', () => {
    expect(joinPosixRelative('/b/project/', './images/sub/../figure.png')).toBe('/b/project/images/figure.png')
    expect(joinPosixRelative('D:\\project', 'images/figure.png')).toBe('D:/project/images/figure.png')
    for (const unsafe of ['../outside', 'images/../../outside', '..\\outside', '/outside', 'C:outside', 'C:\\outside', '//server/share', 'a\0b', '.']) {
      expect(joinPosixRelative('/b/project', unsafe)).toBeNull()
    }
    expect(joinPosixRelative('D:\\project', '.. /outside')).toBeNull()
    expect(joinPosixRelative('D:\\project', 'file.txt:stream')).toBeNull()
  })

  it('identifies supported image formats and preserves useful MIME types for attachment metadata', () => {
    for (const ext of ['PNG', 'jpg', 'jpeg', 'webp', 'gif', 'svg']) expect(isPreviewableImagePath('image.' + ext)).toBe(true)
    expect(isPreviewableImagePath('image.png/draft')).toBe(false)
    expect(isPreviewableImagePath('image.bmp')).toBe(false)
    expect(mimeTypeForPath('/project/render.SVG')).toBe('image/svg+xml')
    expect(mimeTypeForPath('/project/notes.pdf')).toBe('application/pdf')
    expect(mimeTypeForPath('/project/data.custom')).toBe('application/octet-stream')
  })
})

describe('Markdown image metadata', () => {
  it('extracts local inline destinations including spaces, titles, escapes and balanced parentheses', () => {
    const markdown = [
      '![chart](assets/plot.png "chart title") ![photo](<assets/a b.png>)',
      '![](assets/chart(v2).svg) ![](assets/plot\\(2\\).png) ![](assets/plot.png)',
      '![](file:///old/project/logo.svg) ![](C:\\project\\misc.gif) ![](~/fig.webp)',
      '![](https://example.test/remote.png) ![](//example.test/remote.png) ![](data:image/png;base64,abc)',
      '![](blob:remote) ![](agentswitch-file://f/encoded) \\![](escaped.png)',
      '\x60![](inline-code.png)\x60', '\x60\x60\x60md', '![](fenced.png)', '\x60\x60\x60',
      '~~~md', '![](tilde-fenced.png)', '~~~', '![chart [v2]](after.png)', '![invalid](a.png other)'
    ].join('\n')
    expect(extractMarkdownImageTargets(markdown)).toEqual([
      'assets/plot.png', 'assets/a b.png', 'assets/chart(v2).svg', 'assets/plot(2).png',
      'file:///old/project/logo.svg', 'C:\\project\\misc.gif', '~/fig.webp', 'after.png'
    ])
  })

  const image: OutputFileRef = {
    path: '/new/workspace/images/my plot.svg', name: 'my plot.svg', source: 'workspace-file',
    relativePath: 'images/my plot.svg', fallbackPath: '/app/attachments/plot.svg'
  }
  const attachment: OutputFileRef = { path: '/home/user/paste.png', name: 'paste.png', source: 'chat-attachment' }

  it('matches original project URLs, new paths, and home-relative attachments without matching other projects', () => {
    const refs = [image, attachment]
    const find = (src: string) => findMatchingOutputFile(src, '/new/workspace', '/home/user', refs, '/old/workspace')
    expect(find('images/my%20plot.svg')).toBe(image)
    expect(find('file:///old/workspace/images/my%20plot.svg#fragment')).toBe(image)
    expect(find('/new/workspace/images/my plot.svg')).toBe(image)
    expect(find('~/paste.png')).toBe(attachment)
    expect(find('/old/workspace-other/images/my plot.svg')).toBeUndefined()
    expect(find('https://example.test/images/my%20plot.svg')).toBeUndefined()
  })

  it('uses project first and bundled fallback second for workspace files, and keeps attachment paths independent', () => {
    expect(resolveOutputFileCandidates(image, '/b/workspace')).toEqual(['/b/workspace/images/my plot.svg', image.fallbackPath])
    expect(resolveOutputFileCandidates(image, null)).toEqual([image.fallbackPath])
    expect(resolveOutputFileCandidates({ ...image, relativePath: '../escape.svg' }, '/b/workspace')).toEqual([image.fallbackPath])
    expect(resolveOutputFileCandidates({ ...image, relativePath: undefined, fallbackPath: undefined }, '/b/workspace')).toEqual([])
    expect(resolveOutputFileCandidates({ ...attachment, fallbackPath: '/another/paste.png' }, '/b/workspace'))
      .toEqual(['/home/user/paste.png', '/another/paste.png'])
    expect(resolveOutputFileCandidates({ ...attachment, fallbackPath: attachment.path }, null)).toEqual([attachment.path])
  })
})
