import { describe, expect, it } from 'vitest'
import type { ExtOverview, SkillItem } from '@shared/types'
import { makeCompactSlashItem } from './compactCommand'
import {
  applyCapabilityInsert, buildCapabilityInsert, buildQuickCapabilitiesView, buildQuickSkillsView, cycleCapabilityTab, cycleQuickCapabilityTab,
  extensionPinKey, groupQuickSkills, matchSlashTrigger, scoreCapability, type ExtTabId, type QuickCapabilityTab, type QuickCapabilityItem
} from './slashTrigger'

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

const capabilityOverview: ExtOverview = {
  skills: [
    { ...skill('sprite', 'project', 'Generate assets'), packName: 'Snowbound', translatedDescription: '図像 メディア', tags: ['frame'] },
    { ...skill('lint', 'plugin', 'Run local checks'), plugin: 'Toolkit' },
    { ...skill('compact', 'global') }
  ],
  agents: [
    { name: 'reviewer', description: 'Review media', translatedDescription: '審查媒體', category: '品質', path: '/workspace/agents/photo.md',
      source: 'plugin', plugin: 'Toolkit', model: null, tools: null },
    { name: 'architect', description: 'Plan API', path: '/workspace/agents/arch.md', source: 'plugin', plugin: 'Toolkit', model: null, tools: null }
  ],
  plugins: [
    { name: 'Assets', key: 'assets@market', version: '1', enabled: true, source: 'plugin', marketplace: 'Market', description: 'Media tools',
      translatedDescription: '媒體工具', skills: [], agents: [], mcp: [], hooks: [], rules: [], path: '/fixtures/assets' }
  ],
  mcp: [{ name: 'image', source: 'global', transport: 'stdio', state: 'on', command: 'npx photo-helper' }],
  rules: [{ display: 'AGENTS.md', path: '/workspace/photo/AGENTS.md', scope: 'project', bytes: 100, lines: 5 }],
  hooks: [
    { event: 'PostToolUse', name: 'verify-assets', type: 'command', source: 'project', summary: 'Check photo metadata', file: '/workspace/config', matcher: 'Edit' }
  ],
  configDir: '/workspace', project: '/workspace', errors: 0, remoteNote: false, agentsDynamic: false
}

const firstSkill = { type: 'skills', item: capabilityOverview.skills[0] } as const
const firstAgent = { type: 'agents', item: capabilityOverview.agents[0] } as const
const firstPlugin = { type: 'plugins', item: capabilityOverview.plugins[0] } as const
const firstMcp = { type: 'mcp', item: capabilityOverview.mcp[0] } as const
const firstRule = { type: 'rules', item: capabilityOverview.rules[0] } as const
const firstHook = { type: 'hooks', item: capabilityOverview.hooks[0] } as const
const view = (tab: ExtTabId, query = '', options = {}) =>
  buildQuickCapabilitiesView(capabilityOverview, [compact], { tab, query, pinned: [], locale: 'zh-TW', ...options })

describe('quick capabilities', () => {
  it('counts every category independently of selected tab and omitted duplicate CLI compact', () => {
    expect(view('skills').tabCounts).toEqual({ skills: 3, agents: 2, plugins: 1, mcp: 1, context: 2 })
    expect(view('skills', 'photo').tabCounts).toEqual({ skills: 0, agents: 1, plugins: 0, mcp: 1, context: 2 })
    expect(view('plugins', '媒體').tabCounts).toEqual({ skills: 0, agents: 1, plugins: 1, mcp: 0, context: 0 })
    expect(view('agents', 'Toolkit 品質').flat).toEqual([firstAgent])
    expect(view('skills', 'Snowbound 図像 frame').flat).toEqual([firstSkill])
    expect(view('context', 'PostToolUse metadata').flat).toEqual([firstHook])
  })

  it('shows the library bar only for useful alternatives and maintains full counts while filtering', () => {
    expect(view('skills').showPackBar).toBe(true)
    expect(view('mcp').showPackBar).toBe(false)
    expect(view('context').showPackBar).toBe(false)
    expect(view('context').sections).toHaveLength(1)
    expect(view('mcp', '', { pinned: ['mcp:image'] }).showPackBar).toBe(false)
    expect(view('agents').showPackBar).toBe(false)
    expect(view('agents', '', { pinned: ['agent:Toolkit:reviewer'] }).showPackBar).toBe(true)
    const filtered = view('skills', '', { packFilter: 'plugin:toolkit' })
    expect(filtered.flat.map(extensionPinKey)).toEqual(['lint'])
    expect(filtered.tabCounts.skills).toBe(3)
    expect(view('agents', 'reviewer', { packFilter: 'pinned' }).flat).toEqual([firstAgent])
  })

  it('reuses old skill pin keys and orders every type under the favorites pack', () => {
    const pinned = ['sprite', 'agent:Toolkit:reviewer', 'plugin:assets@market', 'mcp:image', 'hook:PostToolUse:verify-assets', 'rule:AGENTS.md']
    const sample = [firstSkill, firstAgent, firstPlugin, firstMcp, firstHook, firstRule]
    expect(sample.map(extensionPinKey)).toEqual(pinned)
    for (const tab of ['skills', 'agents', 'plugins', 'mcp', 'context'] as const) {
      expect(view(tab, '', { pinned }).sections[0]?.pack.id).toBe('pinned')
    }
    expect(view('context', '', { pinned }).flat).toEqual([firstHook, firstRule])
    expect(view('agents', 'reviewer', { pinned }).sections[0]?.pack.id).toBe('pinned')
    expect(view('skills', '', { pinned, collapsedPacks: new Set(['pinned']) }).flat).not.toContainEqual(firstSkill)
    expect(view('skills', 'sprite', { pinned, collapsedPacks: new Set(['pinned']) }).flat).toEqual([firstSkill])
    expect(extensionPinKey({ type: 'hooks', item: { ...firstHook.item, name: undefined } })).toBe('hook:PostToolUse:Edit')
  })

  it('cycles forward and backward across all five tabs', () => {
    expect(cycleCapabilityTab('skills', -1)).toBe('context')
    expect(cycleCapabilityTab('context', 1)).toBe('skills')
    expect(cycleCapabilityTab('agents', 1)).toBe('plugins')
  })
})

describe('capability insertion', () => {
  it.each([
    ['zh-CN', '使用 reviewer 子代理：', '使用 reviewer 代理：', '使用 Assets 插件：', '使用 image MCP：', '遵循规则 AGENTS.md：', '关于 PostToolUse (verify-assets) 钩子：'],
    ['zh-TW', '使用 reviewer 子代理：', '使用 reviewer 代理：', '使用 Assets 外掛：', '使用 image MCP：', '遵循規則 AGENTS.md：', '關於 PostToolUse (verify-assets) 掛鉤：'],
    ['ja', 'reviewer サブエージェントを使って：', 'reviewer エージェントを使って：', 'Assets プラグインを使って：', 'image MCP を使って：', 'AGENTS.md のルールに従って：', 'PostToolUse (verify-assets) フックについて：'],
    ['en', 'Use the reviewer subagent: ', 'Use the reviewer agent: ', 'Use the Assets plugin: ', 'Use the image MCP: ', 'Follow rules in AGENTS.md: ', 'Regarding the PostToolUse (verify-assets) hook: ']
  ] as const)('builds the historical and new phrases in %s', (locale, agent, codexAgent, plugin, mcp, rule, hook) => {
    const entries: QuickCapabilityItem[] = [firstAgent, firstPlugin, firstMcp, firstRule, firstHook]
    expect(entries.map((entry) => buildCapabilityInsert(entry, 'claude', locale))).toEqual(
      [agent, plugin, mcp, rule, hook].map((text) => ({ text, appendSpace: false, isCompact: false }))
    )
    expect(buildCapabilityInsert(firstAgent, 'codex', locale).text).toBe(codexAgent)
    expect(buildCapabilityInsert(firstSkill, 'claude', locale)).toEqual({ text: '/sprite', appendSpace: true, isCompact: false })
    expect(buildCapabilityInsert({ type: 'skills', item: { ...firstSkill.item, insert: '$sprite' } }, 'codex', locale).text).toBe('$sprite')
    expect(buildCapabilityInsert({ type: 'skills', item: compact }, 'claude', locale).isCompact).toBe(true)
  })

  it('replaces the complete slash query and preserves surrounding text and caret', () => {
    const mcp = buildCapabilityInsert(firstMcp, 'claude', 'en')
    expect(applyCapabilityInsert('Plan /im next', 5, 8, mcp, false)).toEqual({
      value: 'Plan Use the image MCP: next', caret: 'Plan Use the image MCP:'.length
    })
    const rule = buildCapabilityInsert(firstRule, 'claude', 'zh-CN')
    expect(applyCapabilityInsert('／規則', 0, 3, rule, false)).toEqual({ value: '遵循规则 AGENTS.md：', caret: '遵循规则 AGENTS.md：'.length })
    const command = buildCapabilityInsert(firstSkill, 'claude', 'en')
    expect(applyCapabilityInsert('/sp', 0, 3, command, false)).toEqual({ value: '/sprite ', caret: 8 })
    expect(applyCapabilityInsert('Plan now', 4, 4, command, true)).toEqual({ value: 'Plan /sprite now', caret: 12 })
  })

  it('uses the matcher to identify unnamed hooks and preserves selected ranges in the picker', () => {
    const hook = buildCapabilityInsert({ type: 'hooks', item: { ...firstHook.item, name: undefined } }, 'claude', 'en')
    expect(hook.text).toBe('Regarding the PostToolUse · Edit hook: ')
    expect(applyCapabilityInsert('a selected text', 2, 10, hook, true).value).toBe('a Regarding the PostToolUse · Edit hook: text')
  })
})

describe('cross-category capability search', () => {
  const chrome = { ...firstMcp.item, name: 'chrome-devtools', command: 'npx chrome-devtools-mcp' }
  const snapshot: ExtOverview = { ...capabilityOverview, mcp: [...capabilityOverview.mcp, chrome] }
  const search = (tab: QuickCapabilityTab, query: string, tabLocked: boolean) =>
    buildQuickCapabilitiesView(snapshot, [compact], { tab, query, pinned: [], locale: 'zh-CN', tabLocked })

  it('starts with Skills, automatically searches all categories, and returns to Skills when cleared', () => {
    const browse = search('skills', '', false)
    expect(browse).toMatchObject({ effectiveTab: 'skills', fallbackAll: false, showTypeBadge: false, allCount: 10 })
    expect(browse.sections.length).toBeGreaterThan(0)
    const found = search('skills', 'chrome', false)
    expect(found).toMatchObject({ effectiveTab: 'all', fallbackAll: false, showPackBar: false, showTypeBadge: true, allCount: 1 })
    expect(found.tabCounts).toEqual({ skills: 0, agents: 0, plugins: 0, mcp: 1, context: 0 })
    expect(found.flat[0]).toEqual({ type: 'mcp', item: chrome })
    expect(found.sections).toEqual([])
    expect(search('skills', '', false)).toEqual(browse)
    expect(search('mcp', '', false).effectiveTab).toBe('mcp')
  })

  it('falls back only when the locked category is empty and another category has matches', () => {
    expect(search('skills', 'chrome', true)).toMatchObject({
      effectiveTab: 'skills', fallbackAll: true, allCount: 1, showPackBar: false, showTypeBadge: true,
      flat: [{ type: 'mcp', item: chrome }]
    })
    expect(search('mcp', 'chrome', true)).toMatchObject({ effectiveTab: 'mcp', fallbackAll: false, showTypeBadge: false })
    expect(search('skills', 'unmatched-string-z', true)).toMatchObject({ effectiveTab: 'skills', fallbackAll: false, allCount: 0, flat: [] })
    expect(search('all', '', true)).toMatchObject({ effectiveTab: 'all', fallbackAll: false, allCount: 10, showTypeBadge: true })
  })

  it.each([
    ['chrome', 0], ['chrome-devtools', 1], ['inspect/chrome-devtools', 2],
    ['antichrome', 3], ['c-h-r-o-m-e', 4], ['inspect-browser', 5], ['unrelated', -1]
  ])('scores %s in the right relevance tier', (name, score) => {
    const entry: QuickCapabilityItem = {
      type: 'mcp', item: { ...firstMcp.item, name, command: name === 'inspect-browser' ? 'open chrome' : 'npx tool' }
    }
    expect(scoreCapability(entry, 'ＣＨＲＯＭＥ', 'zh-CN')).toBe(score)
  })

  it('orders by relevance, then pin order, category and name, even with a stale pack filter', () => {
    const results = buildQuickCapabilitiesView({
      ...snapshot,
      skills: [skill('chrome', 'global'), skill('chrome-skill', 'global'), skill('pin-me', 'global', 'chrome')],
      agents: [{ ...firstAgent.item, name: 'chrome-agent' }],
      mcp: [chrome, { ...chrome, name: 'chrome-bridge' }, { ...chrome, name: 'chrome-pinned' }]
    }, [], {
      query: 'chrome', tab: 'skills', tabLocked: false, locale: 'en', packFilter: 'obsolete',
      pinned: ['pin-me', 'mcp:chrome-pinned', 'agent:Toolkit:chrome-agent']
    })
    expect(results.flat.map(extensionPinKey)).toEqual([
      'chrome', 'mcp:chrome-pinned', 'agent:Toolkit:chrome-agent', 'chrome-skill', 'mcp:chrome-bridge', 'mcp:chrome-devtools', 'pin-me'
    ])
    const translated = search('skills', '媒體', false)
    expect(translated.allCount).toBe(2)
    expect(translated.flat.map((entry) => entry.type)).toEqual(['agents', 'plugins'])
  })

  it('cycles from All into Skills and wraps backward into rules and hooks', () => {
    expect(cycleQuickCapabilityTab('all', 1)).toBe('skills')
    expect(cycleQuickCapabilityTab('all', -1)).toBe('context')
    expect(cycleQuickCapabilityTab('context', 1)).toBe('all')
  })

  it('replaces the full slash query with the selected MCP reference, preserving surrounding text', () => {
    const value = '先用 /chrome-devtools 查看页面'
    const caret = '先用 /chrome-devtools'.length
    const trigger = matchSlashTrigger(value, caret)!
    const selected = search('skills', trigger.query, false).flat[0]
    const inserted = buildCapabilityInsert(selected, 'claude', 'zh-CN')
    expect(applyCapabilityInsert(value, trigger.start, caret, inserted, false)).toEqual({
      value: '先用 使用 chrome-devtools MCP： 查看页面', caret: '先用 使用 chrome-devtools MCP：'.length
    })
  })
})
