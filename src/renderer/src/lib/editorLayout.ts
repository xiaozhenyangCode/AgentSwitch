export type EditorDockPosition = 'right' | 'left' | 'bottom' | 'maximized'
export type EditorNonMaximizedDock = Exclude<EditorDockPosition, 'maximized'>
export type EditorFileTreePosition = 'left' | 'right'
export type EditorSafeAreaTarget = 'none' | 'tree' | 'editor'
export type TrafficLightOwner = 'none' | 'sidebar' | 'editor' | 'chat'

export interface EditorLayoutPrefs {
  dockPosition: EditorDockPosition
  previousDockPosition: EditorNonMaximizedDock
  fileTreePosition: EditorFileTreePosition
  fileTreeVisible: boolean
  panelWidth: number
  panelHeight: number
  fileTreeWidth: number
}

export const EDITOR_LAYOUT_STORAGE_KEY = 'agentswitch.editorLayout.v1'
export const EDITOR_PANEL_MIN_W = 300
export const EDITOR_PANEL_DEFAULT_W = 540
export const EDITOR_PANEL_MAX_W = 1100
export const EDITOR_PANEL_MIN_H = 200
export const EDITOR_PANEL_DEFAULT_H = 340
export const EDITOR_PANEL_MAX_H = 900
export const EDITOR_CHAT_MIN_W = 360
export const EDITOR_CHAT_MIN_H = 220
export const EDITOR_TREE_MIN_W = 160
export const EDITOR_TREE_DEFAULT_W = 220
export const EDITOR_TREE_MAX_W = 360
export const EDITOR_CODE_MIN_W = 180
export const TRAFFIC_LIGHT_SAFE_LEFT_PX = 84

export function resolveTrafficLightOwner({
  platform, isFullScreen, sidebarOpen, editorOpen, dockPosition
}: {
  platform: string
  isFullScreen: boolean
  sidebarOpen: boolean
  editorOpen: boolean
  dockPosition: EditorDockPosition
}): TrafficLightOwner {
  if (platform !== 'darwin' || isFullScreen) return 'none'
  if (editorOpen && dockPosition === 'maximized') return 'editor'
  if (sidebarOpen) return 'sidebar'
  if (editorOpen && dockPosition === 'left') return 'editor'
  return 'chat'
}

export function resolveEditorSafeAreaTarget({
  needsTrafficLightSafeArea, treeOpen, fileTreePosition
}: {
  needsTrafficLightSafeArea: boolean
  treeOpen: boolean
  fileTreePosition: EditorFileTreePosition
}): EditorSafeAreaTarget {
  if (!needsTrafficLightSafeArea) return 'none'
  return treeOpen && fileTreePosition === 'left' ? 'tree' : 'editor'
}

function clampSize(raw: number, min: number, max: number, fallback: number, total: number | undefined, reserve: number): number {
  const cap = total !== undefined && Number.isFinite(total)
    ? Math.min(max, Math.max(0, total - reserve))
    : max
  // On a constrained window the neighboring pane takes priority over the preferred minimum.
  return Math.min(cap, Math.max(min, Number.isFinite(raw) ? raw : fallback))
}

export function clampPanelWidth(raw: number, containerWidth?: number): number {
  return clampSize(raw, EDITOR_PANEL_MIN_W, EDITOR_PANEL_MAX_W, EDITOR_PANEL_DEFAULT_W, containerWidth, EDITOR_CHAT_MIN_W)
}

export function clampPanelHeight(raw: number, containerHeight?: number): number {
  return clampSize(raw, EDITOR_PANEL_MIN_H, EDITOR_PANEL_MAX_H, EDITOR_PANEL_DEFAULT_H, containerHeight, EDITOR_CHAT_MIN_H)
}

export function clampFileTreeWidth(raw: number, panelWidth?: number): number {
  return clampSize(raw, EDITOR_TREE_MIN_W, EDITOR_TREE_MAX_W, EDITOR_TREE_DEFAULT_W, panelWidth, EDITOR_CODE_MIN_W)
}

function isNonMaximizedDock(value: unknown): value is EditorNonMaximizedDock {
  return value === 'right' || value === 'left' || value === 'bottom'
}

export function setEditorDockPosition(prefs: EditorLayoutPrefs, next: EditorDockPosition): EditorLayoutPrefs {
  if (prefs.dockPosition === next) return prefs
  if (next !== 'maximized') return { ...prefs, dockPosition: next, previousDockPosition: next }
  const previousDockPosition = prefs.dockPosition === 'maximized' ? prefs.previousDockPosition : prefs.dockPosition
  return { ...prefs, dockPosition: next, previousDockPosition }
}

export function toggleEditorMaximized(prefs: EditorLayoutPrefs): EditorLayoutPrefs {
  return setEditorDockPosition(prefs, prefs.dockPosition === 'maximized' ? prefs.previousDockPosition : 'maximized')
}

type LayoutStorage = Pick<Storage, 'getItem' | 'setItem'>

export function loadEditorLayoutPrefs(storage?: LayoutStorage): EditorLayoutPrefs {
  let saved: Partial<EditorLayoutPrefs> = {}
  let legacyWidth = NaN
  try {
    const source = storage ?? globalThis.localStorage
    const raw = source?.getItem(EDITOR_LAYOUT_STORAGE_KEY)
    if (raw != null) {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') saved = parsed
    } else {
      const rawWidth = source?.getItem('agentswitch.editorWidth')
      if (rawWidth?.trim()) legacyWidth = Number(rawWidth)
    }
  } catch {
    // The layout remains usable when storage is unavailable or malformed.
  }

  const dockPosition = saved.dockPosition === 'maximized' || isNonMaximizedDock(saved.dockPosition)
    ? saved.dockPosition : 'right'
  return {
    dockPosition,
    previousDockPosition: isNonMaximizedDock(saved.previousDockPosition)
      ? saved.previousDockPosition : dockPosition === 'maximized' ? 'right' : dockPosition,
    fileTreePosition: saved.fileTreePosition === 'right' ? 'right' : 'left',
    fileTreeVisible: typeof saved.fileTreeVisible === 'boolean' ? saved.fileTreeVisible : true,
    panelWidth: clampPanelWidth(saved.panelWidth ?? legacyWidth),
    panelHeight: clampPanelHeight(saved.panelHeight ?? EDITOR_PANEL_DEFAULT_H),
    fileTreeWidth: clampFileTreeWidth(saved.fileTreeWidth ?? EDITOR_TREE_DEFAULT_W)
  }
}

export function saveEditorLayoutPrefs(prefs: EditorLayoutPrefs, storage?: LayoutStorage): void {
  try {
    (storage ?? globalThis.localStorage)?.setItem(EDITOR_LAYOUT_STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // A storage failure should not interrupt layout changes.
  }
}
