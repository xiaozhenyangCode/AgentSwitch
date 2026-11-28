import { describe, expect, it } from 'vitest'
import {
  clampFileTreeWidth, clampPanelHeight, clampPanelWidth, EDITOR_LAYOUT_STORAGE_KEY, loadEditorLayoutPrefs,
  resolveEditorSafeAreaTarget, resolveTrafficLightOwner, saveEditorLayoutPrefs, setEditorDockPosition, toggleEditorMaximized,
  type EditorDockPosition, type EditorFileTreePosition, type TrafficLightOwner
} from './editorLayout'

const cases: Array<[boolean, boolean, EditorDockPosition, TrafficLightOwner]> = [
  [true, false, 'maximized', 'sidebar'],
  [true, true, 'right', 'sidebar'],
  [true, true, 'left', 'sidebar'],
  [true, true, 'bottom', 'sidebar'],
  [true, true, 'maximized', 'editor'],
  [false, false, 'left', 'chat'],
  [false, true, 'right', 'chat'],
  [false, true, 'left', 'editor'],
  [false, true, 'bottom', 'chat'],
  [false, true, 'maximized', 'editor']
]

describe('resolveTrafficLightOwner', () => {
  it.each(cases)('sidebar=%s editor=%s dock=%s gives the safe area to %s', (sidebarOpen, editorOpen, dockPosition, expected) => {
    const placement = { sidebarOpen, editorOpen, dockPosition }
    expect(resolveTrafficLightOwner({ ...placement, platform: 'darwin', isFullScreen: false })).toBe(expected)
    expect(resolveTrafficLightOwner({ ...placement, platform: 'darwin', isFullScreen: true })).toBe('none')
    expect(resolveTrafficLightOwner({ ...placement, platform: 'win32', isFullScreen: false })).toBe('none')
    expect(resolveTrafficLightOwner({ ...placement, platform: 'linux', isFullScreen: false })).toBe('none')
  })
})

describe('resolveEditorSafeAreaTarget', () => {
  it.each(cases)('routes the safe area within the editor for sidebar=%s, editor=%s, dock=%s', (sidebarOpen, editorOpen, dockPosition, owner) => {
    for (const treeOpen of [false, true]) {
      for (const fileTreePosition of ['left', 'right'] as const satisfies readonly EditorFileTreePosition[]) {
        const placement = { treeOpen, fileTreePosition }
        const needsTrafficLightSafeArea = owner === 'editor'
        expect(resolveEditorSafeAreaTarget({ ...placement, needsTrafficLightSafeArea })).toBe(
          owner !== 'editor' ? 'none' : treeOpen && fileTreePosition === 'left' ? 'tree' : 'editor'
        )
        expect(resolveEditorSafeAreaTarget({ ...placement, needsTrafficLightSafeArea: false })).toBe('none')
      }
    }
  })
})

describe('workspace split sizes', () => {
  it.each([
    { clamp: clampPanelWidth, min: 300, max: 1100, defaultSize: 540, reserve: 360 },
    { clamp: clampPanelHeight, min: 200, max: 900, defaultSize: 340, reserve: 220 },
    { clamp: clampFileTreeWidth, min: 160, max: 360, defaultSize: 220, reserve: 180 }
  ])('clamps to [$min, $max] and reserves $reserve when space is limited', ({ clamp, min, max, defaultSize, reserve }) => {
    expect(clamp(-100)).toBe(min)
    expect(clamp(3000)).toBe(max)
    expect(clamp(NaN)).toBe(defaultSize)
    expect(clamp(Infinity)).toBe(defaultSize)
    expect(clamp(max, reserve + min + 15)).toBe(min + 15)
    expect(clamp(defaultSize, reserve + min - 15)).toBe(min - 15)
    expect(clamp(defaultSize, reserve - 10)).toBe(0)
  })
})

function makeStorage(entries: Record<string, string> = {}) {
  const values = new Map(Object.entries(entries))
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) }
  }
}

describe('editor layout preferences', () => {
  it.each(['left', 'right', 'bottom'] as const)('restores %s after maximizing', (dock) => {
    const prefs = setEditorDockPosition(loadEditorLayoutPrefs(makeStorage()), dock)
    const maximized = toggleEditorMaximized(prefs)
    expect(maximized).toMatchObject({ dockPosition: 'maximized', previousDockPosition: dock })
    expect(setEditorDockPosition(maximized, 'maximized')).toBe(maximized)
    expect(toggleEditorMaximized(maximized)).toEqual(prefs)
    expect(setEditorDockPosition(maximized, 'bottom').previousDockPosition).toBe('bottom')
  })

  it('round trips all layout preferences and restores the saved position after maximizing', () => {
    const storage = makeStorage()
    const prefs = {
      ...loadEditorLayoutPrefs(storage),
      dockPosition: 'maximized',
      previousDockPosition: 'bottom',
      fileTreePosition: 'right',
      fileTreeVisible: false,
      panelWidth: 630,
      panelHeight: 260,
      fileTreeWidth: 280
    } as const
    saveEditorLayoutPrefs(prefs, storage)
    expect(loadEditorLayoutPrefs(storage)).toEqual(prefs)
    expect(toggleEditorMaximized(loadEditorLayoutPrefs(storage)).dockPosition).toBe('bottom')
  })

  it('loads the old width only when the new key is absent', () => {
    const storage = makeStorage({ 'agentswitch.editorWidth': '620' })
    expect(loadEditorLayoutPrefs(storage).panelWidth).toBe(620)
    storage.setItem(EDITOR_LAYOUT_STORAGE_KEY, '{}')
    expect(loadEditorLayoutPrefs(storage).panelWidth).toBe(540)
  })

  it('handles malformed JSON, invalid fields and storage errors', () => {
    const defaults = loadEditorLayoutPrefs(makeStorage())
    expect(loadEditorLayoutPrefs(makeStorage({ [EDITOR_LAYOUT_STORAGE_KEY]: '{broken' }))).toEqual(defaults)
    expect(loadEditorLayoutPrefs(makeStorage({ [EDITOR_LAYOUT_STORAGE_KEY]: 'null' }))).toEqual(defaults)
    expect(loadEditorLayoutPrefs(makeStorage({ [EDITOR_LAYOUT_STORAGE_KEY]: JSON.stringify({
      dockPosition: 'top', previousDockPosition: 'maximized', fileTreePosition: 'bottom', fileTreeVisible: 0,
      panelWidth: 8, panelHeight: 1000, fileTreeWidth: '220'
    }) }))).toEqual({ ...defaults, panelWidth: 300, panelHeight: 900 })
    const fail = () => { throw new Error('unavailable') }
    const storage = { getItem: fail, setItem: fail }
    expect(loadEditorLayoutPrefs(storage)).toEqual(defaults)
    expect(() => saveEditorLayoutPrefs(defaults, storage)).not.toThrow()
  })
})
