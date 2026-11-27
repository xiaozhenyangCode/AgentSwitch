import { describe, expect, it } from 'vitest'
import { detectIndentInfo } from './codeEditorTheme'
import {
  applyAcceptDiskVersion,
  applyKeepMineSaved,
  enterConflictDiff,
  exitDiffState,
  toggleUnsavedDiffState,
  type EditorDiffSnapshot
} from './editorDiffState'

function sampleTab(overrides: Partial<EditorDiffSnapshot> = {}): EditorDiffSnapshot {
  return {
    status: 'ready',
    content: 'my unsaved edits\n',
    savedContent: 'original\n',
    mtimeMs: 1000,
    size: 9,
    syncVersion: 1,
    externalChange: 'modified',
    conflictMtimeMs: 2000,
    diffMode: 'none',
    diskContent: null,
    ...overrides
  }
}

describe('editorDiffState', () => {
  it('enters conflict diff, exits cleanly, and applies accept-disk decision', () => {
    const tab = sampleTab()
    const inDiff = enterConflictDiff(tab, 'ai disk edit\n')
    expect(inDiff.diffMode).toBe('conflict')
    expect(inDiff.diskContent).toBe('ai disk edit\n')

    const exited = exitDiffState(inDiff)
    expect(exited.diffMode).toBe('none')
    expect(exited.diskContent).toBeNull()
    expect(exited.content).toBe('my unsaved edits\n')
    expect(exited.conflictMtimeMs).toBe(2000)

    const accepted = applyAcceptDiskVersion(inDiff, {
      content: 'ai disk edit\n',
      mtimeMs: 2500,
      size: 13
    })
    expect(accepted).toMatchObject({
      content: 'ai disk edit\n',
      savedContent: 'ai disk edit\n',
      mtimeMs: 2500,
      size: 13,
      syncVersion: 2,
      externalChange: null,
      conflictMtimeMs: null,
      diffMode: 'none',
      diskContent: null
    })
  })

  it('applies keep-mine overwrite save decision and clears conflict/diff state', () => {
    const inDiff = enterConflictDiff(sampleTab(), 'ai disk edit\n')
    const saved = applyKeepMineSaved(inDiff, {
      content: 'my unsaved edits\n',
      mtimeMs: 3000,
      size: 17
    })
    expect(saved).toMatchObject({
      content: 'my unsaved edits\n',
      savedContent: 'my unsaved edits\n',
      mtimeMs: 3000,
      size: 17,
      externalChange: null,
      conflictMtimeMs: null,
      diffMode: 'none',
      diskContent: null
    })
  })

  it('toggles unsaved diff preview only when buffer is dirty', () => {
    const clean = sampleTab({ content: 'same\n', savedContent: 'same\n', externalChange: null, conflictMtimeMs: null })
    expect(toggleUnsavedDiffState(clean).diffMode).toBe('none')

    const dirty = sampleTab({ externalChange: null, conflictMtimeMs: null })
    const opened = toggleUnsavedDiffState(dirty)
    expect(opened.diffMode).toBe('unsaved')
    expect(toggleUnsavedDiffState(opened).diffMode).toBe('none')
  })
})

describe('detectIndentInfo', () => {
  it('detects 2-space, 4-space, and tab indentation', () => {
    expect(detectIndentInfo('function a() {\n  return 1\n}\n')).toEqual({ kind: 'spaces', size: 2 })
    expect(detectIndentInfo('def foo():\n    return 1\n    x = 2\n')).toEqual({ kind: 'spaces', size: 4 })
    expect(detectIndentInfo('func main() {\n\tfmt.Println()\n\treturn\n}\n')).toEqual({ kind: 'tabs', size: 4 })
  })
})
