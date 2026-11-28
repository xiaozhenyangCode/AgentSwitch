import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { extOverview, formatRepoPackName, inferExtPack, listSkills, openExtFile, parseLocalizedFrontmatter, parseSkillLock, readExtDetail } from './extensions'

const fixture = vi.hoisted(() => ({ root: '', home: '', config: '' }))
vi.mock('electron', () => ({ app: { getPath: () => fixture.root } }))
vi.mock('./profiles', () => ({
  expandHome: (dir: string) => dir,
  getConfig: (id: string) => ({ kind: id === 'claude-test' ? 'claude' : 'codex', configDir: join(fixture.config, id) })
}))
vi.mock('./shellEnv', () => ({ get realHome() { return fixture.home } }))

fixture.root = mkdtempSync(join(tmpdir(), 'agentswitch-extension-packs-'))
fixture.home = join(fixture.root, 'home')
fixture.config = join(fixture.root, 'accounts')
const claude = join(fixture.config, 'claude-test')
const codex = join(fixture.config, 'codex-test')
afterAll(() => rmSync(fixture.root, { force: true, recursive: true }))

function write(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

function markdown(name: string, extra = ''): string {
  return `---\nname: ${name}\ndescription: Does ${name}\n${extra}---\n# ${name}\n`
}

function link(path: string, target: string): void {
  mkdirSync(dirname(path), { recursive: true })
  symlinkSync(target, path)
}

describe('extension pack membership', () => {
  it('uses plugin, builtin and project identity before global repository or directory fallback', () => {
    const repo = { source: 'Owner/Workflow-Library', pluginName: 'quality' }
    expect(inferExtPack({ source: 'project', plugin: 'Superpowers', category: 'Review' }, '/work/Frost', repo))
      .toEqual({ packId: 'plugin:superpowers', packName: 'Superpowers', packKind: 'plugin', category: 'Review' })
    expect(inferExtPack({ source: 'builtin' })).toEqual({ packId: 'builtin', packKind: 'builtin' })
    expect(inferExtPack({ source: 'project', tags: ['JP'] }, '/work/Frost', repo))
      .toEqual({ packId: 'project:/work/Frost', packName: 'Frost', packKind: 'project', category: 'quality', tags: ['JP'] })
    expect(inferExtPack({ source: 'global', packName: 'LocalTools' }, undefined, repo))
      .toEqual({ packId: 'repo:owner/workflow-library', packName: 'Workflow-Library', packKind: 'plugin', category: 'quality' })
    expect(inferExtPack({ source: 'global', packName: 'LocalTools' }))
      .toEqual({ packId: 'global:dir:localtools', packName: 'LocalTools', packKind: 'global' })
    expect(inferExtPack({ source: 'global' })).toEqual({ packId: 'global:personal', packKind: 'global' })
    expect(formatRepoPackName('remotion-dev/skills')).toBe('remotion-dev/skills')
  })

  it('validates repository records and normalizes a terminal .git suffix', () => {
    const lock = parseSkillLock({ skills: {
      useful: { source: 'owner/library.git', sourceType: 'github', pluginName: ' lint ' },
      'bad/path': { source: 'owner/library' },
      local: { source: '../../private', sourceType: 'local' },
      missing: {},
      unsupported: { source: 'owner/other', sourceType: 'local' }
    } })
    expect([...lock]).toEqual([['useful', { source: 'owner/library', pluginName: 'lint' }]])
    expect(parseSkillLock({ skills: [] }).size).toBe(0)
  })

  it('parses optional categories and normalizes, deduplicates and limits tags', () => {
    expect(parseLocalizedFrontmatter(markdown('α', 'category: 画像\ngroup: redundant\ntags: [ai, 翻訳, ai, 4, false, a, b, c, d, e, f, g]\n')).labels)
      .toEqual({ category: '画像', tags: ['ai', '翻訳', 'a', 'b', 'c', 'd', 'e', 'f'] })
    expect(parseLocalizedFrontmatter(markdown('beta', 'group: Publishing\ntags: "test, review, test"\n')).labels)
      .toEqual({ category: 'Publishing', tags: ['test', 'review'] })
  })

  it('combines symlink aliases of the same repository and separates project, plugin, directory and personal packs', () => {
    const root = join(fixture.root, 'Snowbound')
    const nested = join(root, 'src')
    mkdirSync(join(root, '.git'), { recursive: true })
    mkdirSync(nested, { recursive: true })
    const global = join(fixture.home, '.agents', 'skills')
    for (const name of ['first', 'second']) {
      write(join(global, name, 'SKILL.md'), markdown(`workflow-${name}`))
      link(join(claude, 'skills', `alias-${name}`), join(global, name))
    }
    write(join(fixture.home, '.agents', '.skill-lock.json'), JSON.stringify({ skills: {
      first: { source: 'owner/skills', pluginName: 'checks', sourceType: 'github' },
      second: { source: 'owner/skills', sourceType: 'github' }
    } }))
    write(join(claude, 'skills', 'personal', 'SKILL.md'), markdown('personal'))
    write(join(claude, 'skills', 'MyLibrary', 'nested', 'SKILL.md'), markdown('nested'))
    write(join(root, '.claude', 'skills', 'Editing', 'patch', 'SKILL.md'), markdown('patch'))
    write(join(nested, '.claude', 'commands', 'local.md'), markdown('local'))
    write(join(root, '.claude', 'skills', 'local-lock', 'SKILL.md'), markdown('local-lock'))
    write(join(root, 'skills-lock.json'), JSON.stringify({ skills: { 'local-lock': { source: 'owner/library', pluginName: 'Project tools' } } }))
    write(join(root, '.claude', 'agents', 'analysis', 'reviewer.md'), markdown('reviewer', 'tags: [レビュー]\n'))
    const plugin = join(fixture.root, 'plugin')
    write(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'Fixture' }))
    write(join(plugin, 'skills', 'Formatting', 'format', 'SKILL.md'), markdown('format'))
    write(join(claude, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'fixture@test': [{ installPath: plugin }] } }))
    write(join(claude, 'settings.json'), JSON.stringify({ enabledPlugins: { 'fixture@test': true } }))
    write(join(codex, 'skills', '.system', 'built', 'SKILL.md'), markdown('built'))

    const overview = extOverview('claude-test', nested, true, 'en')
    const skills = new Map(overview.skills.map((item) => [item.name, item]))
    for (const name of ['workflow-first', 'workflow-second']) {
      expect(skills.get(name)).toMatchObject({ packId: 'repo:owner/skills', packName: 'owner/skills', packKind: 'plugin' })
    }
    expect(skills.get('workflow-first')?.category).toBe('checks')
    expect(skills.get('personal')?.packId).toBe('global:personal')
    expect(skills.get('nested')).toMatchObject({ packId: 'global:dir:mylibrary', packName: 'MyLibrary' })
    expect(skills.get('patch')).toMatchObject({ packId: `project:${root}`, packName: 'Snowbound', category: 'Editing', insert: '/patch' })
    expect(skills.get('local')?.packId).toBe(`project:${root}`)
    expect(skills.get('local-lock')).toMatchObject({ packId: `project:${root}`, category: 'Project tools' })
    expect(skills.get('Fixture:format')).toMatchObject({ packId: 'plugin:fixture', category: 'Formatting', insert: '/Fixture:format' })
    expect(overview.agents[0]).toMatchObject({ packId: `project:${root}`, category: 'analysis', tags: ['レビュー'] })
    expect(listSkills('codex-test', null, true, 'en').items.find((item) => item.name === 'built')?.packId).toBe('builtin')
  })
})

describe('extension detail authorization', () => {
  it('rejects unlisted paths, directories and a symlink retargeted after discovery', () => {
    const outside = write(join(fixture.root, 'unlisted.md'), '# unlisted')
    const skillDir = join(claude, 'skills', 'linked')
    const original = write(join(fixture.root, 'source.md'), markdown('linked'))
    const alias = join(skillDir, 'SKILL.md')
    link(alias, original)
    listSkills('claude-test', null, true, 'en')
    expect(() => readExtDetail(outside)).toThrow('not available')
    expect(() => readExtDetail(skillDir)).toThrow('not available')
    expect(openExtFile(alias)).toBe(realpathSync(original))
    expect(readExtDetail(alias).body).toBe('# linked\n')
    rmSync(alias)
    link(alias, outside)
    expect(() => readExtDetail(alias)).toThrow('not available')
    expect(() => openExtFile(alias)).toThrow('not available')
  })

  it('returns the full on-demand body up to 128 KiB and never splits a UTF-8 character', () => {
    const head = '\uFEFF---\r\nname: long\r\ndescription: Long doc\r\n---\r\n'
    const sizeLimit = 128 * 1024
    const contents = head + 'a'.repeat(sizeLimit - Buffer.byteLength(head) - 2) + '文字 Beyond the limit'
    const path = write(join(claude, 'skills', 'long', 'SKILL.md'), contents)
    expect(() => readExtDetail(path)).toThrow('not available')
    listSkills('claude-test', null, true, 'en')
    const result = readExtDetail(path)
    expect(result).toMatchObject({ path, display: path, bytes: Buffer.byteLength(contents), truncated: true })
    expect(result.raw.startsWith(head)).toBe(true)
    expect(result.body).toBe(contents.slice(head.length, contents.indexOf('文')))
    expect(Buffer.byteLength(result.raw)).toBe(sizeLimit - 2)
  })
})
