export type EditorDiffMode = 'none' | 'conflict' | 'unsaved'

export interface EditorDiffSnapshot {
  status: 'loading' | 'ready' | 'image' | 'error'
  content: string
  savedContent: string
  mtimeMs: number
  size: number
  syncVersion: number
  externalChange: 'modified' | 'deleted' | null
  conflictMtimeMs: number | null
  diffMode: EditorDiffMode
  diskContent: string | null
}

/** Transitions tab state when opening conflict diff with freshly read disk content. */
export function enterConflictDiff<T extends EditorDiffSnapshot>(tab: T, diskContent: string): T {
  return {
    ...tab,
    diffMode: 'conflict',
    diskContent
  }
}

/** Toggles read-only unsaved-changes diff preview (only meaningful when buffer differs from savedContent). */
export function toggleUnsavedDiffState<T extends EditorDiffSnapshot>(tab: T): T {
  if (tab.diffMode === 'unsaved') {
    return { ...tab, diffMode: 'none' }
  }
  if (tab.status !== 'ready' || tab.content === tab.savedContent) {
    return tab
  }
  return { ...tab, diffMode: 'unsaved', diskContent: null }
}

/** Exits any active diff mode while keeping unsaved buffer & conflict banners intact. */
export function exitDiffState<T extends EditorDiffSnapshot>(tab: T): T {
  if (tab.diffMode === 'none' && tab.diskContent === null) return tab
  return { ...tab, diffMode: 'none', diskContent: null }
}

/** Applies the "Accept Disk Version" decision after reading latest disk file metadata. */
export function applyAcceptDiskVersion<T extends EditorDiffSnapshot>(
  tab: T,
  disk: { content: string; mtimeMs: number; size: number }
): T {
  return {
    ...tab,
    status: 'ready',
    content: disk.content,
    savedContent: disk.content,
    mtimeMs: disk.mtimeMs,
    size: disk.size,
    syncVersion: tab.syncVersion + 1,
    externalChange: null,
    conflictMtimeMs: null,
    diffMode: 'none',
    diskContent: null
  }
}

/** Applies the "Keep Mine & Overwrite Save" decision after a successful force-save. */
export function applyKeepMineSaved<T extends EditorDiffSnapshot>(
  tab: T,
  saved: { content: string; mtimeMs: number; size: number }
): T {
  return {
    ...tab,
    savedContent: saved.content,
    mtimeMs: saved.mtimeMs,
    size: saved.size,
    externalChange: null,
    conflictMtimeMs: null,
    diffMode: 'none',
    diskContent: null
  }
}
