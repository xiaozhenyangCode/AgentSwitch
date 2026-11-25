import { describe, expect, it } from 'vitest'
import { applyFileReference, matchFileTrigger } from './fileMention'

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
    const reference = '#' + String.fromCharCode(96) + JSON.stringify(path) + String.fromCharCode(96) + ' '
    expect(applyFileReference('#notes', 0, 6, path)).toEqual({ value: reference, caret: reference.length })
  })
})
