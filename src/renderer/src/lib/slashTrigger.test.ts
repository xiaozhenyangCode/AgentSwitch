import { describe, expect, it } from 'vitest'
import type { SkillItem } from '@shared/types'
import { makeCompactSlashItem } from './compactCommand'
import { buildQuickSkillsView, groupQuickSkills, matchSlashTrigger } from './slashTrigger'

describe('matchSlashTrigger', () => {
  it.each([
    ['/', 1, 0, ''],
    ['／', 1, 0, ''],
    ['say /br', 7, 4, 'br'],
    ['say\n／br', 7, 4, 'br'],
    ['/br next', 3, 0, 'br']
  ] as const)('matches %j at %i', (value, caret, start, query) => {
    expect(matchSlashTrigger(value, caret)).toEqual({ start, query })
  })

  it.each([
    'https://agentswitch.app', 'http://localhost:3000', 'src/app.ts', 'src/foo/bar.ts',
    './a', 'a/b', '/foo/bar', 'a／b', '/br\n', '/' + 'a'.repeat(49)
  ])('ignores %j', (value) => {
    expect(matchSlashTrigger(value, value.length)).toBeNull()
  })

  it('requires a valid caret at the end of the token', () => {
    expect(matchSlashTrigger('/brainstorm', 3)).toBeNull()
    expect(matchSlashTrigger('/foo/bar', 4)).toBeNull()
    expect(matchSlashTrigger('/', 0)).toBeNull()
    expect(matchSlashTrigger('/', 2)).toBeNull()
  })
})

const skill = (name: string, source: SkillItem['source'], description = ''): SkillItem => ({
  name, source, description, kind: 'skill', insert: `/${name}`
})
const compact = makeCompactSlashItem('Summarize the conversation')

describe('groupQuickSkills', () => {
  it('honors pin order and sorts the remaining skills by source and name', () => {
    const cli = [
      skill('global', 'global'), skill('zeta', 'project'), skill('alpha', 'project'),
      skill('shared', 'plugin'), skill('local', 'project'), skill('beta', 'global')
    ]
    const grouped = groupQuickSkills(cli, [compact], ' ', ['shared', 'missing', 'local'])
    expect(grouped.pinned.map((item) => item.name)).toEqual(['shared', 'local'])
    expect(grouped.all.map((item) => item.name)).toEqual(['alpha', 'zeta', 'beta', 'global', 'compact'])
    expect(grouped.flat).toEqual([...grouped.pinned, ...grouped.all])
  })

  it('uses the built-in compact entry when a CLI command collides by name or token', () => {
    const cli = [skill('Compact', 'global'), { ...skill('shorten', 'project'), insert: '/compact' }]
    expect(groupQuickSkills(cli, [compact], '', ['compact'])).toEqual({ pinned: [compact], all: [], flat: [compact] })
    expect(groupQuickSkills(cli, [compact], 'comp', [])).toEqual({ pinned: [], all: [compact], flat: [compact] })
  })

  it('flattens search results by match quality, with project skills winning ties', () => {
    const description = skill('ideas', 'project', 'Helps brainstorm plans')
    const word = skill('team-brainstorm', 'project')
    const global = skill('brainstorm', 'global')
    const project = skill('brainstorm-plan', 'project')
    const matches = [project, global, word, description]
    expect(groupQuickSkills([description, word, global, project], [], ' BRAIN ', [description.name])).toEqual({
      pinned: [], all: matches, flat: matches
    })
    expect(groupQuickSkills(matches, [], 'unmatched', []).flat).toEqual([])
  })
})

describe('multilingual search', () => {
  it.each(['图像 enhance', '影像 處理', '画像 変換', 'image enhance', 'raster 画像'])('matches %j without rewriting the trigger', (query) => {
    const item = {
      ...skill('raster-tools', 'plugin', 'Enhance and convert an image'),
      translatedDescription: '图像处理 · 影像處理 · 画像を変換'
    }
    const { flat } = groupQuickSkills([item], [], query, [])
    expect(flat).toEqual([item])
    expect(flat[0].insert).toBe('/raster-tools')
  })

  it('supports an inline phrase without swallowing a trailing space or newline', () => {
    expect(matchSlashTrigger('say /影像 處理', 10, true)).toEqual({ start: 4, query: '影像 處理' })
    expect(matchSlashTrigger('/影像 ', 4, true)).toBeNull()
    expect(matchSlashTrigger('/影像\n處理', 6, true)).toBeNull()
  })
})


describe('buildQuickSkillsView', () => {
  const project = { ...skill('snow-control', 'project'), packId: 'project:/work/Snow', packKind: 'project', packName: 'Snowbound' } as const
  const plugin = { ...skill('pixel-editor', 'global'), packId: 'repo:studio/pixel', packKind: 'plugin', packName: 'PixelKit',
    category: 'グラフィック', tags: ['圖層'], translatedDescription: '优化像素精灵' } as const
  const personal = skill('my-notes', 'global')
  const starred = { ...plugin, name: 'pixel-brush', insert: '/pixel-brush' }
  const cli: SkillItem[] = [personal, project, { ...plugin, tags: [...plugin.tags] }, { ...starred, tags: [...starred.tags] }]

  it('orders packs, keeps pinned commands first and counts all members in library filters', () => {
    const view = buildQuickSkillsView(cli, [compact], { query: '', pinned: ['pixel-brush', 'snow-control'] })
    expect(view.sections.map(({ pack }) => pack.id)).toEqual(['pinned', 'repo:studio/pixel', 'global:personal', 'builtin'])
    expect(view.flat.map((entry) => entry.insert)).toEqual(['/pixel-brush', '/snow-control', '/pixel-editor', '/my-notes', '/compact'])
    expect(view.packs.map(({ id, count }) => [id, count])).toEqual([
      ['all', 5], ['pinned', 2], ['project:/work/Snow', 1], ['repo:studio/pixel', 2], ['global:personal', 1], ['builtin', 1]
    ])
    expect(buildQuickSkillsView(cli, [compact], { query: '', pinned: [] }).sections.map(({ pack }) => pack.kind)).toEqual(['project', 'plugin', 'global', 'builtin'])
  })

  it('filters by pack and excludes collapsed rows from keyboard order', () => {
    const options = { query: '', pinned: ['pixel-brush'], packFilter: 'repo:studio/pixel' }
    const open = buildQuickSkillsView(cli, [compact], options)
    expect(open.flat.map((item) => item.insert)).toEqual(['/pixel-brush', '/pixel-editor'])
    const collapsed = buildQuickSkillsView(cli, [compact], { ...options, collapsedPacks: new Set([options.packFilter]) })
    expect(collapsed.sections[0].expanded).toBe(false)
    expect(collapsed.flat).toEqual([])
    expect(buildQuickSkillsView(cli, [compact], { ...options, packFilter: 'pinned' }).flat.map((item) => item.name)).toEqual(['pixel-brush'])
  })

  it('automatically expands matching packs and searches names and metadata across languages', () => {
    const options = { query: 'pixelkit グラフィック 圖層 精灵', pinned: [], collapsedPacks: new Set(['repo:studio/pixel']) }
    const view = buildQuickSkillsView(cli, [compact], options)
    expect(view.sections[0].expanded).toBe(true)
    expect(view.flat.map((item) => item.name)).toEqual(['pixel-brush', 'pixel-editor'])
    expect(buildQuickSkillsView(cli, [compact], { ...options, query: '個人全域', locale: 'zh-TW' }).flat).toEqual([personal])
    expect(buildQuickSkillsView(cli, [compact], { ...options, query: 'pixel', packFilter: 'project:/work/Snow' }).flat).toEqual([])
    const nameFirst = { ...skill('pixel', 'global'), description: 'Name match' }
    expect(buildQuickSkillsView([...cli, nameFirst], [compact], { ...options, query: 'pixel' }).flat[0]).toBe(nameFirst)
  })
})
