import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createOutputFilter } from './outputFilter'

let root: string

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'agentswitch-output-filter-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('createOutputFilter', () => {
  it('applies cache rules to directories and direct file events', () => {
    const filter = createOutputFilter(root)
    for (const path of ['.godot', 'api/node_modules', 'app/.next', '.agentswitch/runs', '.agentswitch/handoffs']) {
      expect(filter.shouldSkipDir(path)).toBe(true)
      expect(filter.shouldIgnoreFile(path + '/nested/file.txt')).toBe(true)
    }
    for (const file of ['hero.png.import', 'shader_cache-v2.json', 'index.BIN', 'foo.ctex', 'nested/.DS_Store']) {
      expect(filter.shouldIgnoreFile(join(root, file))).toBe(true)
    }
    expect(filter.shouldIgnoreFile('src/scene.gd')).toBe(false)
    expect(filter.shouldIgnoreFile('dist-notes.txt')).toBe(false)
    expect(filter.shouldSkipDir('outline')).toBe(false)
  })

  it('combines repository excludes and scoped .gitignore rules with Git precedence', () => {
    const project = join(root, 'packages', 'project')
    write(join(root, '.git/info/exclude'), '*.excluded\n')
    write(join(root, '.gitignore'), '/packages/project/root-only/\n*.secret\n!keep.excluded\n')
    write(join(root, 'packages/.gitignore'), '*.intermediate\n/only-at-packages.txt\n')
    write(join(project, '.gitignore'), '!public.secret\n/local.txt\nhidden/\n')
    write(join(project, 'live/.gitignore'), '*.generated\n!visible.generated\n')
    write(join(project, 'hidden/.gitignore'), '!visible.secret\n')

    const filter = createOutputFilter(project)
    expect(filter.shouldIgnoreFile('notes.excluded')).toBe(true)
    expect(filter.shouldIgnoreFile('keep.excluded')).toBe(false)
    expect(filter.shouldIgnoreFile('settings.intermediate')).toBe(true)
    expect(filter.shouldIgnoreFile('only-at-packages.txt')).toBe(false)
    expect(filter.shouldSkipDir('root-only')).toBe(true)
    expect(filter.shouldIgnoreFile('secret.secret')).toBe(true)
    expect(filter.shouldIgnoreFile('public.secret')).toBe(false)
    expect(filter.shouldIgnoreFile('local.txt')).toBe(true)
    expect(filter.shouldIgnoreFile('other/local.txt')).toBe(false)
    expect(filter.shouldIgnoreFile('live/output.generated')).toBe(true)
    expect(filter.shouldIgnoreFile('live/visible.generated')).toBe(false)
    expect(filter.shouldIgnoreFile('hidden/visible.secret')).toBe(true)
  })

  it('reads a standalone project .gitignore and keeps only minimal noise filters in the allowed output directory', () => {
    write(join(root, '.gitignore'), '.agentswitch/\n*.ignored\n')
    const allowed = join(root, '.agentswitch/outputs/turn')
    const filter = createOutputFilter(root, { allowDirs: [allowed] })
    expect(filter.shouldIgnoreFile('nested/a.ignored')).toBe(true)
    expect(filter.shouldSkipDir('.agentswitch')).toBe(false)
    expect(filter.shouldSkipDir(allowed)).toBe(false)
    expect(filter.shouldSkipDir(join(allowed, 'out'))).toBe(false)
    expect(filter.shouldIgnoreFile(join(allowed, 'out/model.bin'))).toBe(false)
    expect(filter.shouldIgnoreFile(join(allowed, 'out/plot.ignored'))).toBe(false)
    expect(filter.shouldIgnoreFile(join(allowed, 'out/work.tmp'))).toBe(true)
    expect(filter.shouldIgnoreFile(join(allowed, 'Thumbs.db'))).toBe(true)
    expect(filter.shouldIgnoreFile(join(allowed, '.DS_Store'))).toBe(true)
    expect(filter.shouldIgnoreFile('.agentswitch/outputs/turn-other/photo.png')).toBe(true)
    expect(filter.shouldSkipDir('.agentswitch/runs')).toBe(true)
  })

  it('follows worktree gitdir and commondir markers to the shared repository exclude', () => {
    const worktree = join(root, 'checkout')
    write(join(worktree, '.git'), 'gitdir: ../common/worktrees/checkout\n')
    write(join(root, 'common/worktrees/checkout/commondir'), '../..\n')
    write(join(root, 'common/info/exclude'), 'exclude.txt\n')
    write(join(worktree, '.gitignore'), 'ignore.txt\n')

    const filter = createOutputFilter(worktree)
    expect(filter.shouldIgnoreFile('exclude.txt')).toBe(true)
    expect(filter.shouldIgnoreFile('ignore.txt')).toBe(true)
    expect(filter.shouldIgnoreFile('included.txt')).toBe(false)
  })

  it('applies built-in rules with no project and does not treat a project root name as a cache', () => {
    expect(createOutputFilter(null).shouldIgnoreFile(join(root, '.godot/index'))).toBe(true)
    const filter = createOutputFilter(join(root, 'build'))
    expect(filter.shouldIgnoreFile('src/code.ts')).toBe(false)
    expect(filter.shouldIgnoreFile('src/index.bin')).toBe(true)
  })
})
