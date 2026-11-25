import { execFile, execFileSync, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {} }))
vi.mock('node:child_process', async (load) => {
  const actual = await load<typeof import('node:child_process')>()
  return { ...actual, execFile: vi.fn(actual.execFile), spawn: vi.fn(actual.spawn) }
})
vi.mock('node:fs', async (load) => {
  const actual = await load<typeof import('node:fs')>()
  return {
    ...actual, readdir: vi.fn(actual.readdir), readdirSync: vi.fn(actual.readdirSync),
    realpathSync: vi.fn(actual.realpathSync), statSync: vi.fn(actual.statSync)
  }
})
vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof import('node:fs/promises')>()
  return { ...actual, realpath: vi.fn(actual.realpath), stat: vi.fn(actual.stat) }
})

const directories: string[] = []
const project = () => {
  const path = fs.mkdtempSync(join(tmpdir(), 'agentswitch-files-'))
  directories.push(path)
  return path
}
const file = (cwd: string, path: string, data = '') => {
  const target = join(cwd, path)
  fs.mkdirSync(dirname(target), { recursive: true })
  fs.writeFileSync(target, data)
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', [
  '-c', 'user.name=File Search Tests', '-c', 'user.email=files@example.test', ...args
], { cwd, encoding: 'utf8' }).trimEnd()

let search: typeof import('./fileSearch').searchProjectFiles
let invalidate: typeof import('./fileSearch').invalidateFileIndex
let startup: { processes: number; reads: number; timers: number }

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'setImmediate'] })
  try {
    const module = await import('./fileSearch')
    search = module.searchProjectFiles
    invalidate = module.invalidateFileIndex
    startup = {
      processes: vi.mocked(execFile).mock.calls.length + vi.mocked(spawn).mock.calls.length,
      reads: [fs.readdir, fs.readdirSync, fs.realpathSync, fs.statSync, realpath, stat]
        .reduce((count, method) => count + vi.mocked(method).mock.calls.length, 0),
      timers: vi.getTimerCount()
    }
  } finally {
    vi.useRealTimers()
  }
})

afterEach(() => {
  invalidate()
  vi.clearAllMocks()
  for (const path of directories.splice(0)) fs.rmSync(path, { recursive: true, force: true })
})

describe('project file search', () => {
  it('leaves the filesystem, subprocesses and timers idle on import', () => {
    expect(startup).toEqual({ processes: 0, reads: 0, timers: 0 })
  })

  it('lists Git records relative to cwd, preserving names and prioritizing worktree changes', async () => {
    const cwd = project()
    git(cwd, 'init', '-q')
    file(cwd, 'outside.ts')
    file(cwd, 'app/alpha.ts')
    file(cwd, 'app/deleted.ts')
    file(cwd, 'app/deep/zeta.ts')
    file(cwd, 'app/deep/line\nbreak-配置.ts')
    file(cwd, 'app/.gitignore', '*.tmp\n')
    file(cwd, 'app/deep/.gitignore', 'secret.txt\n')
    git(cwd, 'add', '.')
    const tree = git(cwd, 'write-tree')
    const baseline = git(cwd, 'commit-tree', tree, '-m', 'Search fixture')
    git(cwd, 'update-ref', 'HEAD', baseline)

    fs.unlinkSync(join(cwd, 'app/deleted.ts'))
    file(cwd, 'app/deep/zeta.ts', 'worktree edit')
    file(cwd, 'app/deep/line\nbreak-配置.ts', 'staged edit')
    git(cwd, 'add', '--', 'app/deep/line\nbreak-配置.ts')
    file(cwd, 'app/second file.ts')
    file(cwd, 'app/deep/secret.txt')
    file(cwd, 'app/out.tmp')

    const result = await search({ cwd: join(cwd, 'app'), query: '' })
    expect(result.truncated).toBe(false)
    expect(result.items.map(({ relPath }) => relPath)).toEqual([
      'second file.ts', 'deep/line\nbreak-配置.ts', 'deep/zeta.ts', '.gitignore', 'alpha.ts', 'deep/.gitignore'
    ])
    expect(result.items[2]).toEqual({ name: 'zeta.ts', dir: 'deep', relPath: 'deep/zeta.ts', indexes: [] })
    expect(fs.readdir).not.toHaveBeenCalled()
  })

  it('applies layered .gitignore rules and never enters pruned directories', async () => {
    const cwd = project()
    file(cwd, '.gitignore', '*.tmp\nblocked/\nsrc/*.txt\nsrc/reopened/*\nsrc/reopened/restored/deny.md\n')
    file(cwd, 'src/.gitignore', '!keep.txt\n/secret.md\n!reopened/restored/\n')
    const pruned = ['node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', '.next', '.nuxt',
      '.cache', 'coverage', 'target', 'vendor', 'Pods', '.venv', 'venv', '__pycache__', '.gradle', 'blocked']
    for (const dir of pruned) file(cwd, 'src/' + dir + '/nested/hidden.ts')
    file(cwd, 'src/keep.txt')
    file(cwd, 'src/drop.txt')
    file(cwd, 'src/secret.md')
    file(cwd, 'src/output.tmp')
    file(cwd, 'src/nested/secret.md')
    file(cwd, 'src/reopened/blocked/hidden.ts')
    file(cwd, 'src/reopened/restored/keep.md')
    file(cwd, 'src/reopened/restored/deny.md')
    file(cwd, 'src/[draft]/.gitignore', 'local.md\n')
    file(cwd, 'src/[draft]/deep/local.md')
    file(cwd, 'src/[draft]/deep/keep.md')
    file(cwd, 'index.ts')

    const result = await search({ cwd, query: '' })
    expect(result.items.map(({ relPath }) => relPath)).toEqual([
      '.gitignore', 'index.ts', 'src/.gitignore', 'src/keep.txt', 'src/[draft]/.gitignore',
      'src/nested/secret.md', 'src/[draft]/deep/keep.md', 'src/reopened/restored/keep.md'
    ])
    const dirsRead = vi.mocked(fs.readdir).mock.calls.map(([path]) => resolve(String(path)))
    const root = fs.realpathSync(cwd)
    expect(dirsRead.sort()).toEqual([root, join(root, 'src'), join(root, 'src/[draft]'),
      join(root, 'src/[draft]/deep'), join(root, 'src/nested'), join(root, 'src/reopened'), join(root, 'src/reopened/restored')])
  })

  it('caps the non-Git index at 50,000 even when all files are in one directory', async () => {
    const cwd = project()
    const entries = Array.from({ length: 50_001 }, (_, i) => ({
      name: i === 50_000 ? 'UniqueOverflowSentinel.js' : 'settings-' + i + '.tsx',
      isFile: () => true
    }))
    const virtualRead = (length: number) => vi.mocked(fs.readdir).mockImplementationOnce((...args) => {
      // The mock receives fdir's string Dirent overload.
      const done = args.at(-1) as unknown as (error: null, dirents: typeof entries) => void
      queueMicrotask(() => done(null, entries.slice(0, length)))
    })
    virtualRead(50_000)
    expect(await search({ cwd, query: '' })).toMatchObject({ truncated: false })
    virtualRead(50_001)
    expect(await search({ cwd, query: 'UniqueOverflowSentinel', refresh: true })).toEqual({ items: [], truncated: true })
    const lastIncluded = await search({ cwd, query: 'settings-49999.tsx' })
    expect(lastIncluded.items[0].name).toBe('settings-49999.tsx')
  })

  it('matches basenames, orders best matches first, copies highlights, and limits results', async () => {
    const cwd = project()
    for (let i = 0; i < 24; i++) file(cwd, 'folder-' + i + '/FileSearch.test.ts')
    file(cwd, 'src/FileSearch.ts')
    file(cwd, 'NeedleDirectory/index.ts')
    const result = await search({ cwd, query: 'fs.ts' })
    expect(result.items).toHaveLength(20)
    expect(result.items[0]).toEqual({
      name: 'FileSearch.ts', dir: 'src', relPath: 'src/FileSearch.ts', indexes: [0, 4, 10, 11, 12]
    })
    expect(structuredClone(result)).toEqual(result)
    expect((await search({ cwd, query: 'NeedleDirectory' })).items).toEqual([])
    expect((await search({ cwd, query: '', limit: 0 })).items).toHaveLength(1)
    expect((await search({ cwd, query: 'fs.ts', limit: 100 })).items).toHaveLength(25)
  })

  it('coalesces canonical paths and rebuilds after TTL, manual refresh, or invalidation', async () => {
    const cwd = project()
    const alias = join(project(), 'alias')
    fs.symlinkSync(cwd, alias, 'dir')
    file(cwd, 'first.ts')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0)
    try {
      const requests = [cwd, alias, cwd + '/.'].map((dir) => search({ cwd: dir, query: '' }))
      expect((await Promise.all(requests)).map(({ items }) => items[0].name)).toEqual(['first.ts', 'first.ts', 'first.ts'])
      expect(fs.readdir).toHaveBeenCalledTimes(1)

      file(cwd, 'second.ts')
      clock.mockReturnValue(29_999)
      expect((await search({ cwd, query: '' })).items).toHaveLength(1)
      clock.mockReturnValue(30_000)
      expect((await search({ cwd, query: '' })).items).toHaveLength(2)
      expect(fs.readdir).toHaveBeenCalledTimes(2)

      file(cwd, 'third.ts')
      expect((await search({ cwd, query: '', refresh: true })).items).toHaveLength(3)
      file(cwd, 'fourth.ts')
      invalidate(alias)
      expect((await search({ cwd, query: '' })).items).toHaveLength(4)
      expect(fs.readdir).toHaveBeenCalledTimes(4)
    } finally {
      clock.mockRestore()
    }
  })

  it('validates the directory before crawling and recovers from an invalidated project', async () => {
    const cwd = project()
    file(cwd, 'ordinary.txt')
    await expect(search({ cwd: '.', query: '' })).rejects.toThrow('Invalid file search request')
    await expect(search({ cwd: join(cwd, 'missing'), query: '' })).rejects.toThrow('Project directory is unavailable')
    await expect(search({ cwd: join(cwd, 'ordinary.txt'), query: '' })).rejects.toThrow('Project directory is unavailable')
    expect((await search({ cwd, query: '' })).items[0].name).toBe('ordinary.txt')
    fs.rmSync(cwd, { recursive: true })
    await expect(search({ cwd, query: '' })).rejects.toThrow('Project directory is unavailable')
  })

  it('searches 10,000 indexed file names in under 5 ms in a typical warm query', async () => {
    const cwd = project()
    const names = ['WorkbenchPage', 'ProjectConfig', 'FileSearch', 'CheckpointStore', 'ComposerState',
      'GitStatus', 'SessionHistory', 'ModelSettings', 'AccountPicker', 'ActivityRow', 'ThreadArchive', 'PromptEditor']
    const groups = Array.from({ length: 100 }, (_, i) => join(cwd, 'package-' + i))
    for (const group of groups) {
      fs.mkdirSync(group)
      for (let i = 0; i < 100; i++) fs.writeFileSync(join(group, names[i % names.length] + i + '.tsx'), '')
    }
    await search({ cwd, query: '' })
    for (const query of ['c', 'cp', 'pcs']) await search({ cwd, query })
    const samples: number[] = []
    for (const query of ['wkp', 'fsearch', 'gs', 'acp', 'th', 'tarc', 'gstat', 'pedit', 'cms', 'wpage', 'projc']) {
      const start = performance.now()
      const result = await search({ cwd, query })
      samples.push(performance.now() - start)
      expect(result.items).not.toHaveLength(0)
    }
    samples.sort((a, b) => a - b)
    const median = samples[Math.floor(samples.length / 2)]
    console.info('File search (10,000 files, 11 warm queries): median ' + median.toFixed(2)
      + ' ms, max ' + samples.at(-1)!.toFixed(2) + ' ms')
    expect(median).toBeLessThan(5)
  }, 20_000)
})
