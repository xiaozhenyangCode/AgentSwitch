import type { Thread } from '@shared/chat'

export const SIDEBAR_THREAD_LIMIT = 5
const COLLAPSED_PROJECTS_KEY = 'agentswitch.sidebar.collapsedProjects.v1'

type SidebarThread = Pick<Thread, 'id' | 'title' | 'projectDir' | 'updatedAt' | 'pinned' | 'preview' | 'archived' | 'archivedAt'>

interface SidebarGroupOptions {
  activeThreadId: string | null
  expandedProjects: ReadonlySet<string>
  collapsedProjects: ReadonlySet<string>
  query: string
}

export function getSidebarGroups<T extends SidebarThread>(
  threads: readonly T[],
  { activeThreadId, expandedProjects, collapsedProjects, query }: SidebarGroupOptions
) {
  const q = query.trim().toLowerCase()
  const byProject = new Map<string, T[]>()
  const archivedThreads: T[] = []

  // The first thread encountered for each project sets its position in the sidebar.
  for (const thread of [...threads].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt)) {
    if (thread.preview) continue
    const dir = thread.projectDir ?? ''
    if (q && !thread.title.toLowerCase().includes(q) && !dir.toLowerCase().includes(q)) continue
    if (thread.archived) {
      archivedThreads.push(thread)
      continue
    }
    const group = byProject.get(dir)
    if (group) group.push(thread)
    else byProject.set(dir, [thread])
  }
  archivedThreads.sort((a, b) => (b.archivedAt ?? b.updatedAt) - (a.archivedAt ?? a.updatedAt))

  const groups = Array.from(byProject, ([dir, threads]) => {
    const collapsed = !q && collapsedProjects.has(dir)
    const extraThreadCount = q || collapsed ? 0 : Math.max(0, threads.length - SIDEBAR_THREAD_LIMIT)
    const expanded = extraThreadCount > 0 && expandedProjects.has(dir)
    let visibleThreads = collapsed ? [] : threads
    if (extraThreadCount > 0 && !expanded) {
      visibleThreads = threads.slice(0, SIDEBAR_THREAD_LIMIT)
      // Keep the selected chat visible within the limit, including after async restore.
      const selected = threads.find((thread, index) => index >= SIDEBAR_THREAD_LIMIT && thread.id === activeThreadId)
      if (selected) visibleThreads[SIDEBAR_THREAD_LIMIT - 1] = selected
    }
    return { dir, collapsed, expanded, extraThreadCount, visibleThreads }
  })

  return { groups, archivedThreads }
}

export function loadCollapsedProjects(): Set<string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(COLLAPSED_PROJECTS_KEY) ?? '[]')
    if (Array.isArray(saved)) return new Set(saved.filter((dir): dir is string => typeof dir === 'string'))
  } catch {
    // Start with all projects open if storage is unavailable or invalid.
  }
  return new Set()
}

export function saveCollapsedProjects(projects: ReadonlySet<string>): void {
  try {
    localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...projects]))
  } catch {
    // Keep the current sidebar usable when storage is unavailable.
  }
}
