import { describe, expect, it } from 'vitest'
import { applyFileReference, insertFileReferenceAtCaret, matchFileTrigger } from './fileMention'

describe('project file references', () => {
  it('matches after whitespace or at a line start using textarea offsets', () => {
    expect(matchFileTrigger('#', 1)).toEqual({ start: 0, query: '' })
    expect(matchFileTrigger('看 #配置', 5)).toEqual({ start: 2, query: '配置' })
    expect(matchFileTrigger('line\n#ts', 8)).toEqual({ start: 5, query: 'ts' })
    expect(matchFileTrigger('line\n#\nnext', 6)).toEqual({ start: 5, query: '' })
    expect(matchFileTrigger('#@scope', 7)).toEqual({ start: 0, query: '@scope' })
    expect(matchFileTrigger('#test rest', 5)).toEqual({ start: 0, query: 'test' })
  })

  it.each(['## ', '### title', 'foo#bar', 'color:#fff', 'color: #c0ffee', '#fff', '# ', '#\t', '#\n', '#foo#bar'])(
    'ignores %j',
    (value) => expect(matchFileTrigger(value, value.length)).toBeNull()
  )

  it('closes before a space on a bare hash and inside an existing token', () => {
    expect(matchFileTrigger('# ', 1)).toBeNull()
    expect(matchFileTrigger('## ', 1)).toBeNull()
    expect(matchFileTrigger('#path/to/file', 5)).toBeNull()
    expect(matchFileTrigger('#' + 'x'.repeat(121), 122)).toBeNull()
  })

  it('replaces only the active query and places the caret after the reference', () => {
    const next = applyFileReference('see #idx\nthen run it', 4, 8, 'src/main/index.ts')
    expect(next).toEqual({ value: 'see #src/main/index.ts \nthen run it', caret: 23 })
    expect(matchFileTrigger(next.value, next.caret)).toBeNull()
  })

  it('quotes filenames containing whitespace or account mentions', () => {
    const path = 'docs/@Codex notes.md'
    const reference = '#`docs/@Codex notes.md` '
    expect(applyFileReference('#notes', 0, 6, path)).toEqual({ value: reference, caret: reference.length })
  })

  it('inserts an attachment into an existing sentence and preserves the suffix and caret', () => {
    const next = insertFileReferenceAtCaret('compare this with next', 8, 12, 'my screenshot.png')
    expect(next).toEqual({ value: 'compare #`my screenshot.png` with next', caret: 28 })
  })

  it('keeps consecutive # file references cleanly separated without duplicating an existing space', () => {
    const first = applyFileReference('#git', 0, 4, '.gitignore')
    expect(first).toEqual({ value: '#.gitignore ', caret: 12 })

    const second = applyFileReference(first.value + '#CON', first.caret, first.caret + 4, 'CONTRIBUTING.md')
    expect(second).toEqual({ value: '#.gitignore #CONTRIBUTING.md ', caret: 29 })

    const beforeSpace = applyFileReference('#git and more', 0, 4, '.gitignore')
    expect(beforeSpace).toEqual({ value: '#.gitignore and more', caret: 12 })
  })
})
