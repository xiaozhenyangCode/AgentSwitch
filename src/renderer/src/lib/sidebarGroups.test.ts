import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Thread } from '@shared/chat'
import { getSidebarGroups, loadCollapsedProjects, saveCollapsedProjects } from './sidebarGroups'

const projectDir = '/projects/AgentSwitch'
const defaults = {
  activeThreadId: null,
  expandedProjects: new Set<string>(),
  collapsedProjects: new Set<string>(),
  query: ''
}

function thread(id: string, updatedAt: number, fields: Partial<Thread> = {}) {
  return { id, title: `Chat ${id}`, projectDir, updatedAt, ...fields }
}

function recentThreads(count: number) {
  return Array.from({ length: count }, (_, index) => thread(String(index + 1), count - index))
}

describe('sidebar project groups', () => {
  it('keeps pinned chats first and orders projects by the first chat in each group', () => {
    const threads = [
      thread('newer unpinned project', 40, { projectDir: '/projects/newer' }),
      thread('old pin', 5, { pinned: true }),
      thread('older unpinned project', 20, { projectDir: '/projects/older' }),
      thread('latest chat', 50),
      thread('new pin', 10, { pinned: true }),
      thread('older chat', 30)
    ]

    const { groups } = getSidebarGroups(threads, defaults)

    expect(groups.map((group) => group.dir)).toEqual([projectDir, '/projects/newer', '/projects/older'])
    expect(groups[0].visibleThreads.map((chat) => chat.id)).toEqual(['new pin', 'old pin', 'latest chat', 'older chat'])
  })

  it('limits each project to five chats and reports the remaining count', () => {
    const threads = recentThreads(8)
    const { groups: [group] } = getSidebarGroups(threads, defaults)

    expect(group.visibleThreads).toEqual(threads.slice(0, 5))
    expect(group.extraThreadCount).toBe(3)
    expect(group.expanded).toBe(false)
  })

  it.each([1, 5])('shows all %i chats without an expand action', (count) => {
    const threads = recentThreads(count)
    const { groups: [group] } = getSidebarGroups(threads, defaults)

    expect(group.visibleThreads).toEqual(threads)
    expect(group.extraThreadCount).toBe(0)
  })

  it('expands and reduces the list without losing an older selected chat', () => {
    const threads = recentThreads(6)
    const options = { ...defaults, activeThreadId: '6' }
    const expandedProjects = new Set([projectDir])

    const { groups: [open] } = getSidebarGroups(threads, { ...options, expandedProjects })
    expect(open.expanded).toBe(true)
    expect(open.visibleThreads).toEqual(threads)

    expandedProjects.delete(projectDir)
    const { groups: [closed] } = getSidebarGroups(threads, { ...options, expandedProjects })
    expect(closed.expanded).toBe(false)
    expect(closed.extraThreadCount).toBe(1)
    expect(closed.visibleThreads.map((chat) => chat.id)).toEqual(['1', '2', '3', '4', '6'])
  })

  it('shows the older selected chat as soon as asynchronously loaded chats arrive', () => {
    const options = { ...defaults, activeThreadId: '7' }
    expect(getSidebarGroups([], options).groups).toEqual([])

    const { groups: [group] } = getSidebarGroups(recentThreads(8), options)
    expect(group.visibleThreads.map((chat) => chat.id)).toEqual(['1', '2', '3', '4', '7'])
  })

  it('shows every matching chat during search and restores the collapsed project afterwards', () => {
    const matches = recentThreads(7)
    const threads = [
      ...matches,
      thread('other', 10, { title: 'Planning' }),
      thread('another project', 11, { projectDir: '/projects/other', title: 'Planning' })
    ]
    const options = {
      ...defaults,
      activeThreadId: '7',
      expandedProjects: new Set([projectDir]),
      collapsedProjects: new Set([projectDir])
    }

    const { groups } = getSidebarGroups(threads, { ...options, query: '  CHAT  ' })
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ collapsed: false, extraThreadCount: 0, visibleThreads: matches })
    expect(getSidebarGroups(threads, { ...options, query: ' agentswitch ' }).groups[0].visibleThreads).toHaveLength(8)
    expect(getSidebarGroups(threads, { ...options, query: '   ' }).groups.find((group) => group.dir === projectDir))
      .toMatchObject({ collapsed: true, expanded: false, extraThreadCount: 0, visibleThreads: [] })
    expect(options.collapsedProjects).toEqual(new Set([projectDir]))
  })

  it('keeps the no-project group separate and preserves the existing archive order', () => {
    const threads = [
      thread('preview', 100, { preview: true }),
      thread('older archive', 60, { archived: true, archivedAt: 61 }),
      thread('recent archive', 70, { archived: true }),
      thread('no project', 31, { projectDir: null }),
      thread('empty path', 30, { projectDir: '' }),
      thread('underscore path', 20, { projectDir: '_' })
    ]

    const { groups, archivedThreads } = getSidebarGroups(threads, { ...defaults, collapsedProjects: new Set(['']) })

    expect(groups.map((group) => [group.dir, group.collapsed])).toEqual([['', true], ['_', false]])
    expect(archivedThreads.map((chat) => chat.id)).toEqual(['recent archive', 'older archive'])
  })
})

describe('collapsed project preferences', () => {
  const key = 'agentswitch.sidebar.collapsedProjects.v1'
  afterEach(() => vi.unstubAllGlobals())

  it('writes and reloads collapsed paths including the empty project key', () => {
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (name: string) => storage.get(name) ?? null,
      setItem: (name: string, value: string) => storage.set(name, value)
    })

    expect(loadCollapsedProjects()).toEqual(new Set())
    saveCollapsedProjects(new Set([projectDir, '']))
    expect(storage.get(key)).toBe(JSON.stringify([projectDir, '']))
    expect(loadCollapsedProjects()).toEqual(new Set([projectDir, '']))
    saveCollapsedProjects(new Set(['']))
    expect(loadCollapsedProjects()).toEqual(new Set(['']))
  })

  it.each([
    ['invalid JSON', []],
    ['{}', []],
    ['null', []],
    ['"project"', []],
    ['["",42,"/projects/example",null,{},"/projects/example"]', ['', '/projects/example']]
  ] as const)('handles invalid saved data %s', (saved, expected) => {
    vi.stubGlobal('localStorage', { getItem: () => saved })

    expect(loadCollapsedProjects()).toEqual(new Set(expected))
  })

  it('handles storage read and write failures', () => {
    const unavailable = () => { throw new Error('Storage unavailable') }
    vi.stubGlobal('localStorage', { getItem: unavailable, setItem: unavailable })

    expect(loadCollapsedProjects()).toEqual(new Set())
    expect(() => saveCollapsedProjects(new Set([projectDir]))).not.toThrow()
  })
})
