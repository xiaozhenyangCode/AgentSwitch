import { describe, expect, it } from 'vitest'
import type { SkillItem } from '@shared/types'
import { makeCompactSlashItem } from './compactCommand'
import { groupQuickSkills, matchSlashTrigger } from './slashTrigger'

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
