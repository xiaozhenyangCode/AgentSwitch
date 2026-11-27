import { describe, expect, it } from 'vitest'
import {
  loadWorkspaceEditorState,
  loadWorkspaceTreeOpen,
  MAX_PERSISTED_WORKSPACES,
  readWorkspaceEditorStore,
  resolveRestoredWorkspaceTabs,
  saveWorkspaceEditorState,
  WORKSPACE_EDITOR_STORAGE_KEY,
  type StorageLike
} from './editorPersistence'

function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) }
  }
}

describe('editorPersistence', () => {
  it('saves, loads, and deduplicates workspace tab state', () => {
    const storage = createMemoryStorage()
    saveWorkspaceEditorState('/proj/a/', {
      tabs: ['/proj/a/src/index.ts', '/proj/a/package.json', '/proj/a/src/index.ts'],
      activePath: '/proj/a/package.json',
      open: true,
      width: 620,
      treeWidth: 230
    }, storage, 1000)

    const loaded = loadWorkspaceEditorState('/proj/a', storage)
    expect(loaded).toEqual({
      tabs: ['/proj/a/src/index.ts', '/proj/a/package.json'],
      activePath: '/proj/a/package.json',
      open: true,
      width: 620,
      treeWidth: 230,
      updatedAt: 1000
    })
  })

  it('skips deleted files during restore and closes panel when no files remain', () => {
    const saved = {
      tabs: ['/proj/a/deleted.ts', '/proj/a/kept.ts'],
      activePath: '/proj/a/deleted.ts',
      open: true,
      updatedAt: 1000
    }
    expect(resolveRestoredWorkspaceTabs(saved, {
      '/proj/a/deleted.ts': false,
      '/proj/a/kept.ts': true
    })).toEqual({
      tabs: ['/proj/a/kept.ts'],
      activePath: '/proj/a/kept.ts',
      open: true
    })

    expect(resolveRestoredWorkspaceTabs(saved, {
      '/proj/a/deleted.ts': false,
      '/proj/a/kept.ts': false
    })).toEqual({
      tabs: [],
      activePath: null,
      open: false
    })
  })

  it('defaults the tree to open and persists each workspace folding preference without tabs', () => {
    const storage = createMemoryStorage()
    expect(loadWorkspaceTreeOpen('/proj/a', storage)).toBe(true)
    saveWorkspaceEditorState('/proj/a', { treeOpen: false, open: true }, storage)
    saveWorkspaceEditorState('/proj/b', { width: 650 }, storage)
    saveWorkspaceEditorState('/proj/a', { tabs: [] }, storage)

    expect(loadWorkspaceTreeOpen('/proj/a', storage)).toBe(false)
    expect(loadWorkspaceTreeOpen('/proj/b', storage)).toBe(true)
    expect(resolveRestoredWorkspaceTabs(loadWorkspaceEditorState('/proj/a', storage), {})).toEqual({
      tabs: [], activePath: null, open: true
    })

    saveWorkspaceEditorState('/proj/a', { treeOpen: true }, storage)
    expect(loadWorkspaceTreeOpen('/proj/a', storage)).toBe(true)
  })

  it('enforces LRU cap across workspaces and survives corrupt storage', () => {
    const storage = createMemoryStorage()
    for (let i = 0; i < MAX_PERSISTED_WORKSPACES + 5; i++) {
      saveWorkspaceEditorState(`/proj/${i}`, {
        tabs: [`/proj/${i}/a.ts`],
        activePath: `/proj/${i}/a.ts`,
        open: true
      }, storage, 1000 + i)
    }
    const store = readWorkspaceEditorStore(storage)
    expect(Object.keys(store)).toHaveLength(MAX_PERSISTED_WORKSPACES)
    expect(loadWorkspaceEditorState('/proj/0', storage)).toBeNull()
    expect(loadWorkspaceEditorState(`/proj/${MAX_PERSISTED_WORKSPACES + 4}`, storage)).not.toBeNull()

    storage.setItem(WORKSPACE_EDITOR_STORAGE_KEY, '{broken json')
    expect(readWorkspaceEditorStore(storage)).toEqual({})
  })
})
