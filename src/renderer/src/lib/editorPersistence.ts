export const WORKSPACE_EDITOR_STORAGE_KEY = 'agentswitch.editorWorkspaceState.v1'
export const MAX_PERSISTED_WORKSPACES = 20
export const MAX_PERSISTED_TABS = 24

export interface PersistedWorkspaceEditorState {
  tabs: string[]
  activePath: string | null
  open: boolean
  width?: number
  treeOpen?: boolean
  treeWidth?: number
  updatedAt: number
}

export type WorkspaceEditorStore = Record<string, PersistedWorkspaceEditorState>

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function normalizeWorkspaceKey(workspaceDir: string): string {
  return workspaceDir.replace(/\\/g, '/').replace(/\/+$/, '') || workspaceDir
}

function getDefaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

export function readWorkspaceEditorStore(storage: StorageLike | null = getDefaultStorage()): WorkspaceEditorStore {
  if (!storage) return {}
  try {
    const raw = storage.getItem(WORKSPACE_EDITOR_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const store: WorkspaceEditorStore = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const item = value as Partial<PersistedWorkspaceEditorState>
      const tabs = Array.isArray(item.tabs)
        ? [...new Set(item.tabs.filter((p): p is string => typeof p === 'string' && p.trim().length > 0))].slice(0, MAX_PERSISTED_TABS)
        : []
      const activePath = typeof item.activePath === 'string' && tabs.includes(item.activePath)
        ? item.activePath
        : tabs[0] ?? null
      store[key] = {
        tabs,
        activePath,
        open: item.open === true && tabs.length > 0,
        ...(typeof item.width === 'number' && Number.isFinite(item.width) && { width: item.width }),
        ...(typeof item.treeOpen === 'boolean' && { treeOpen: item.treeOpen }),
        ...(typeof item.treeWidth === 'number' && Number.isFinite(item.treeWidth) && { treeWidth: item.treeWidth }),
        updatedAt: typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) ? item.updatedAt : 0
      }
    }
    return store
  } catch {
    return {}
  }
}

export function loadWorkspaceEditorState(
  workspaceDir: string | null | undefined,
  storage: StorageLike | null = getDefaultStorage()
): PersistedWorkspaceEditorState | null {
  if (!workspaceDir) return null
  const store = readWorkspaceEditorStore(storage)
  return store[normalizeWorkspaceKey(workspaceDir)] ?? null
}

export function saveWorkspaceEditorState(
  workspaceDir: string | null | undefined,
  patch: Partial<Omit<PersistedWorkspaceEditorState, 'updatedAt'>>,
  storage: StorageLike | null = getDefaultStorage(),
  now = Date.now()
): void {
  if (!workspaceDir || !storage) return
  const key = normalizeWorkspaceKey(workspaceDir)
  const store = readWorkspaceEditorStore(storage)
  const prev = store[key]
  const tabs = patch.tabs !== undefined
    ? [...new Set(patch.tabs.filter((p) => typeof p === 'string' && p.trim().length > 0))].slice(0, MAX_PERSISTED_TABS)
    : prev?.tabs ?? []
  const candidateActive = patch.activePath !== undefined ? patch.activePath : prev?.activePath ?? null
  const activePath = candidateActive && tabs.includes(candidateActive) ? candidateActive : tabs[0] ?? null
  const open = (patch.open !== undefined ? patch.open : prev?.open ?? false) && tabs.length > 0

  store[key] = {
    tabs,
    activePath,
    open,
    ...(patch.width !== undefined ? { width: patch.width } : prev?.width !== undefined ? { width: prev.width } : {}),
    ...(patch.treeOpen !== undefined ? { treeOpen: patch.treeOpen } : prev?.treeOpen !== undefined ? { treeOpen: prev.treeOpen } : {}),
    ...(patch.treeWidth !== undefined ? { treeWidth: patch.treeWidth } : prev?.treeWidth !== undefined ? { treeWidth: prev.treeWidth } : {}),
    updatedAt: now
  }

  // Enforce LRU cap by updatedAt so storage never grows unbounded across workspaces.
  const entries = Object.entries(store)
  if (entries.length > MAX_PERSISTED_WORKSPACES) {
    entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    const pruned: WorkspaceEditorStore = {}
    for (const [k, v] of entries.slice(0, MAX_PERSISTED_WORKSPACES)) {
      pruned[k] = v
    }
    try {
      storage.setItem(WORKSPACE_EDITOR_STORAGE_KEY, JSON.stringify(pruned))
    } catch { /* Ignore quota errors */ }
    return
  }

  try {
    storage.setItem(WORKSPACE_EDITOR_STORAGE_KEY, JSON.stringify(store))
  } catch { /* Ignore quota errors */ }
}

/** Filters restored tabs to only those that still exist on disk and selects a valid active tab. */
export function resolveRestoredWorkspaceTabs(
  saved: PersistedWorkspaceEditorState | null,
  existingMap: Readonly<Record<string, boolean>>
): { tabs: string[]; activePath: string | null; open: boolean } {
  if (!saved || !saved.tabs.length) {
    return { tabs: [], activePath: null, open: false }
  }
  const tabs = saved.tabs.filter((path) => existingMap[path] === true)
  if (!tabs.length) {
    return { tabs: [], activePath: null, open: false }
  }
  const activePath = saved.activePath && tabs.includes(saved.activePath) ? saved.activePath : tabs[0]
  return { tabs, activePath, open: saved.open }
}
