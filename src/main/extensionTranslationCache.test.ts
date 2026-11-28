import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { translate } from '@shared/i18n'
import { ExtensionTranslationCache, hashDescription, needsTranslation, setCachedTranslations, type TranslationCacheFile } from './extensionTranslationCache'
import { collectUntranslatedDescriptions, extOverview, extractDescriptions, listSkills, parseFrontmatter, parseLocalizedFrontmatter } from './extensions'

const fixture = vi.hoisted(() => ({ data: '', home: '' }))
vi.mock('electron', () => ({ app: { getPath: () => fixture.data, getPreferredSystemLanguages: () => ['en'] } }))
vi.mock('./profiles', () => ({
  expandHome: (dir: string) => dir,
  getConfig: (id: string) => ({ kind: id === 'gemini-test' ? 'gemini' : 'codex', configDir: fixture.home })
}))
const root = mkdtempSync(join(tmpdir(), 'agentswitch-extension-translation-'))
fixture.home = join(root, 'home')
fixture.data = join(root, 'userData')
afterAll(() => rmSync(root, { recursive: true, force: true }))

function put(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

describe('extension metadata', () => {
  it('parses YAML maps and flat keys without changing the scalar reader for command names', () => {
    const frontmatter = '\uFEFF---\r\nname: keep-name\r\ndescription: { en: "Original # text", zh-CN: 简体, ja: 日本語 }\r\ndescription_zh-tw: >-\r\n  繁體中文\r\n  說明\r\nuser-invocable: false\r\n---\r\nBody'
    expect(parseLocalizedFrontmatter(frontmatter)).toEqual({
      fields: parseFrontmatter(frontmatter),
      labels: {},
      descriptions: {
        description: 'Original # text',
        nativeDescriptions: { en: 'Original # text', 'zh-CN': '简体', 'zh-TW': '繁體中文 說明', ja: '日本語' }
      }
    })
    expect(parseFrontmatter(frontmatter).name).toBe('keep-name')
    expect(parseFrontmatter(frontmatter)['user-invocable']).toBe('false')
    expect(parseLocalizedFrontmatter('---\ndescription:\n  en: Original\n  ja: 日本語\n---').descriptions.nativeDescriptions?.ja).toBe('日本語')
  })

  it('parses JSON and TOML description maps, including regional and generic aliases', () => {
    expect(extractDescriptions(JSON.parse('{"description":"Original","description_zh":"通用","description_zh_cn":"简体","description_en":"English"}'))).toEqual({
      description: 'Original', nativeDescriptions: { 'zh-CN': '简体', en: 'English' }
    })
    expect(extractDescriptions(parseToml('description = { default = "Default", ja = "日本語", zh_TW = "繁體" }'))).toEqual({
      description: 'Default', nativeDescriptions: { 'zh-TW': '繁體', ja: '日本語' }
    })
    expect(extractDescriptions({ description: ['unexpected', 'array'] })).toEqual({ description: '', nativeDescriptions: {} })
    expect(parseLocalizedFrontmatter('---\ndescription: |\n  First line\n  second line\n---').descriptions.description).toBe('First line second line')
  })

  it('does not mark hasTranslations when a native description equals the raw text', () => {
    const cwd = join(root, 'same-text')
    put(join(cwd, '.agents', 'skills', 'en-only', 'SKILL.md'), '---\nname: en-only\ndescription:\n  en: Keep original English\n  zh-CN: 保持原始英文\n---\n')
    const enList = listSkills('codex-test', cwd, true, 'en')
    const enItem = enList.items.find((item) => item.name === 'en-only')
    expect(enItem).toMatchObject({ description: 'Keep original English', translatedDescription: 'Keep original English', translationSource: 'frontmatter' })
    expect(enList.untranslatedCount).toBe(0)
    expect(enList.hasTranslations).toBe(false)
    const zhList = listSkills('codex-test', cwd, false, 'zh-CN')
    expect(zhList.hasTranslations).toBe(true)
    expect(zhList.items.find((item) => item.name === 'en-only')?.translatedDescription).toBe('保持原始英文')
  })

  it('deduplicates across skills, agents and plugins, reuses hashes, and sees edited descriptions', () => {
    const cwd = join(root, 'project')
    const raw = 'Use this workflow to inspect the workspace. ' + 'More details. '.repeat(25).trim()
    const skillPath = join(cwd, '.agents', 'skills', 'fixture-adopt', 'SKILL.md')
    const pluginRoot = join(fixture.home, 'plugins', 'cache', 'test', 'same-description', '1')
    put(skillPath, `---\nname: fixture-adopt\ndescription: ${raw}\ndescription_ja: 作業領域を点検\n---\n`)
    put(join(fixture.home, 'agents', 'workspace.toml'), `description = "${raw}"\n`)
    put(join(pluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({ description: raw }))

    expect(collectUntranslatedDescriptions('codex-test', cwd, 'zh-TW').filter((item) => item === raw)).toEqual([raw])
    const before = extOverview('codex-test', cwd, true, 'zh-TW')
    const first = before.skills.find((item) => item.name === 'fixture-adopt')
    expect(first).toMatchObject({ description: raw, insert: '$fixture-adopt' })
    expect(first).not.toHaveProperty('nativeDescriptions')
    expect(extOverview('codex-test', cwd, false, 'ja').skills.find((item) => item.name === 'fixture-adopt'))
      .toMatchObject({ translatedDescription: '作業領域を点検', translationSource: 'frontmatter' })

    setCachedTranslations('zh-TW', [[raw, '檢查工作區']])
    const translated = extOverview('codex-test', cwd, false, 'zh-TW')
    expect(translated.untranslatedCount).toBe(before.untranslatedCount! - 1)
    expect(translated.hasTranslations).toBe(true)
    expect(translated.plugins.find((item) => item.name === 'same-description')).toMatchObject({
      translatedDescription: '檢查工作區', translationSource: 'cache'
    })
    const edited = raw + ' New version.'
    put(skillPath, `---\nname: fixture-adopt\ndescription: ${edited}\n---\n`)
    const skills = listSkills('codex-test', cwd, true, 'zh-TW')
    expect(skills.items.find((item) => item.name === 'fixture-adopt')).toMatchObject({ description: edited, insert: '$fixture-adopt' })
    expect(skills.items.find((item) => item.name === 'fixture-adopt')).not.toHaveProperty('translatedDescription')
    expect(extOverview('codex-test', cwd, false, 'zh-TW').untranslatedCount).toBe(translated.untranslatedCount! + 1)
    expect(collectUntranslatedDescriptions('codex-test', cwd, 'zh-TW')).toContain(edited)
  })

  it('prefers author translations to static entries and confines the dictionary to built-in commands', () => {
    const builtin = join(fixture.home, '.gemini', 'antigravity-cli', 'builtin', 'skills')
    put(join(builtin, 'help', 'SKILL.md'), '---\nname: help\ndescription: Help from the CLI\ndescription_ja: 作者からのヘルプ\n---\n')
    put(join(builtin, 'review', 'SKILL.md'), '---\nname: review\ndescription: Review from the CLI\n---\n')
    const items = listSkills('gemini-test', null, true, 'ja').items
    expect(items.find((item) => item.name === 'help')).toMatchObject({ translatedDescription: '作者からのヘルプ', translationSource: 'frontmatter' })
    expect(items.find((item) => item.name === 'review')).toMatchObject({
      insert: '/review', translatedDescription: translate('ja', 'ext.builtin.review'), translationSource: 'builtin'
    })

    const cwd = join(root, 'custom')
    put(join(cwd, '.agents', 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Custom review workflow\n---\n')
    expect(listSkills('codex-test', cwd, true, 'ja').items.find((item) => item.name === 'review'))
      .not.toHaveProperty('translatedDescription')
  })
})

describe('translation cache', () => {
  const day = 86_400_000

  it('isolates locales, keys by trimmed raw text and debounces timestamp updates', () => {
    vi.useFakeTimers()
    try {
      const now = 120 * day
      vi.setSystemTime(now)
      const path = join(root, 'throttle', 'cache.json')
      const cache = new ExtensionTranslationCache(path)
      cache.setCachedTranslations('ja', [['  Same text  ', '同じ文章']])
      expect(cache.getCachedTranslation('ja', 'Same text', now + 1000)).toBe('同じ文章')
      expect(cache.getCachedTranslation('zh-CN', 'Same text')).toBeUndefined()
      expect(cache.getCachedTranslation('ja', 'Same text!')).toBeUndefined()
      const lastUsed = () => JSON.parse(readFileSync(path, 'utf8')).locales.ja[hashDescription('Same text')].lastUsedAt
      vi.advanceTimersByTime(20_000)
      expect(lastUsed()).toBe(now)
      vi.setSystemTime(now + day)
      cache.getCachedTranslation('ja', 'Same text')
      vi.advanceTimersByTime(9999)
      expect(lastUsed()).toBe(now)
      vi.advanceTimersByTime(1)
      expect(lastUsed()).toBe(now + day)
    } finally {
      vi.useRealTimers()
    }
  })

  it('prunes expired and least-recently-used entries across locales when atomically saving', () => {
    const path = join(root, 'pruning', 'cache.json')
    const now = 120 * day
    const data: TranslationCacheFile = { version: 1, locales: {
      ja: Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [hashDescription(`item ${i}`), { text: '翻訳', lastUsedAt: now - day + i }])),
      'zh-CN': {
        [hashDescription('expired')]: { text: '过期', lastUsedAt: now - 91 * day },
        [hashDescription('recently used')]: { text: '正在使用', lastUsedAt: now - 89 * day }
      }
    } }
    put(path, JSON.stringify(data))
    const cache = new ExtensionTranslationCache(path)
    expect(cache.getCachedTranslation('zh-CN', 'expired', now)).toBeUndefined()
    expect(cache.getCachedTranslation('zh-CN', 'recently used', now)).toBe('正在使用')
    cache.setCachedTranslations('en', [['翻訳', 'Translation']], now)
    const saved: TranslationCacheFile = JSON.parse(readFileSync(path, 'utf8'))
    expect(Object.values(saved.locales).reduce((total, bucket) => total + Object.keys(bucket).length, 0)).toBe(5000)
    expect(saved.locales.ja?.[hashDescription('item 0')]).toBeUndefined()
    expect(saved.locales.ja?.[hashDescription('item 1')]).toBeUndefined()
    expect(saved.locales.ja?.[hashDescription('item 2')]).toBeDefined()
    expect(saved.locales['zh-CN']?.[hashDescription('expired')]).toBeUndefined()
    expect(saved.locales['zh-CN']?.[hashDescription('recently used')]?.lastUsedAt).toBe(now)
    expect(readdirSync(dirname(path))).toEqual(['cache.json'])
    expect(new ExtensionTranslationCache(path).getCachedTranslation('en', '翻訳', now)).toBe('Translation')
  })

  it.each([
    ['en', 'English workflow for AgentSwitch', false],
    ['en', '日本語の説明', true],
    ['en', '中文说明', true],
    ['ja', 'コードを確認する', false],
    ['ja', '中文說明', true],
    ['zh-CN', '检查文件和配置说明', false],
    ['zh-CN', '檢查檔案和設定說明', true],
    ['zh-TW', '檢查檔案和設定說明', false],
    ['zh-TW', '检查文件和配置说明', true],
    ['zh-TW', 'https://example.com/path', false],
    ['ja', ' … → 47 ', false],
    ['en', '', false]
  ] as const)('classifies %s text %j', (locale, raw, pending) => {
    expect(needsTranslation(raw, locale)).toBe(pending)
  })
})
