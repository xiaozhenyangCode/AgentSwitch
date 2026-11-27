import { lstatSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import ignore from 'ignore'

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}

const CACHE_DIRS = [
  '.git', '.svn', '.hg', '.godot', '.import', '.mono', 'node_modules', 'dist', 'build', 'out',
  '.next', '.nuxt', '.svelte-kit', '.output', '.cache', '.turbo', '.parcel-cache', '.vite', '.gradle',
  '.idea', 'coverage', 'target', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache',
  '.ruff_cache', 'Pods', 'DerivedData', '.agentmux', '.agentswitch/runs', '.agentswitch/handoffs'
]
const ALWAYS_SKIP_FILES = ['.DS_Store', 'Thumbs.db', '*.tmp']
const CACHE_FILES = [
  '*.import', '*_cache*', '*.cache', '*.bin', '*.tsbuildinfo', '*.pyc', '*.pyo', '*.class',
  '*.o', '*.obj', '*.temp', '*.swp', '*.swo', 'desktop.ini', '*.ctex', '*.s3tc', '*.bptc'
]
const posixRelative = (root: string, path: string): string => relative(root, path).split(sep).join('/')

function readRules(file: string): string {
  try {
    return lstatSync(file).isFile() ? readFileSync(file, 'utf8') : ''
  } catch {
    return ''
  }
}

function findRepository(project: string): { root: string; exclude: string } {
  for (let dir = project; ; dir = dirname(dir)) {
    const marker = join(dir, '.git')
    try {
      const entry = lstatSync(marker)
      if (entry.isDirectory()) return { root: dir, exclude: readRules(join(marker, 'info', 'exclude')) }
      const gitdir = /^gitdir:\s*(.+)$/i.exec(readRules(marker).trim())?.[1]
      if (gitdir) {
        const worktreeGitDir = resolve(dir, gitdir)
        const common = readRules(join(worktreeGitDir, 'commondir')).trim()
        const gitDir = common ? resolve(worktreeGitDir, common) : worktreeGitDir
        return { root: dir, exclude: readRules(join(gitDir, 'info', 'exclude')) }
      }
    } catch {
      // Keep looking for the enclosing worktree.
    }
    if (dirname(dir) === dir) return { root: project, exclude: '' }
  }
}

/** Rebase a directory's rules for a matcher that takes repository-relative paths. */
function scopeRules(dir: string, text: string): string[] {
  const prefix = '/' + dir.replace(/[\\*?[\]]/g, '\\$&') + '/'
  const patterns: string[] = []
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue
    const negation = line.startsWith('!') ? '!' : ''
    const pattern = line.slice(negation.length)
    const trimmed = pattern.replace(/ +$/, '')
    if (!trimmed || trimmed === '/') continue
    const anywhere = !trimmed.replace(/\/$/, '').includes('/')
    patterns.push(negation + prefix + (anywhere ? '**/' : '') + pattern.replace(/^\//, ''))
  }
  return patterns
}

export function createOutputFilter(projectDir: string | null, opts?: { allowDirs?: string[] }) {
  const project = projectDir ? resolve(projectDir) : null
  const allowed = (opts?.allowDirs ?? []).map((dir) => resolve(project ?? '.', dir))
  const caches = ignore().add([...CACHE_DIRS.map((dir) => dir + '/'), ...ALWAYS_SKIP_FILES, ...CACHE_FILES])
  const allowedNoise = ignore().add(ALWAYS_SKIP_FILES)
  const repo = project ? findRepository(project) : null
  const scopes = new Map<string, ReturnType<typeof ignore>>()
  if (repo) {
    scopes.set(repo.root, ignore({ ignorecase: false }).add(repo.exclude).add(readRules(join(repo.root, '.gitignore'))))
  }

  function matcherFor(dir: string, root: string): ReturnType<typeof ignore> {
    const cached = scopes.get(dir)
    if (cached) return cached
    const parent = matcherFor(dirname(dir), root)
    const rel = posixRelative(root, dir)
    const rules = parent.ignores(rel + '/') ? '' : readRules(join(dir, '.gitignore'))
    const matcher = rules ? ignore({ ignorecase: false }).add(parent).add(scopeRules(rel, rules)) : parent
    scopes.set(dir, matcher)
    return matcher
  }

  function shouldIgnore(path: string, directory: boolean): boolean {
    const abs = resolve(project ?? '.', path)
    if (directory && allowed.some((dir) => isInside(abs, dir))) return false
    const allowedDir = allowed.find((dir) => isInside(dir, abs))
    if (allowedDir) {
      const rel = posixRelative(allowedDir, abs)
      return !directory && !!rel && allowedNoise.ignores(rel.split('/').pop()!)
    }
    const base = project && isInside(project, abs) ? project : parse(abs).root
    const rel = posixRelative(base, abs)
    if (!rel) return false
    const suffix = directory ? '/' : ''
    if (caches.ignores(rel + suffix)) return true
    return !!repo && isInside(repo.root, abs) && abs !== repo.root &&
      matcherFor(dirname(abs), repo.root).ignores(posixRelative(repo.root, abs) + suffix)
  }

  return {
    shouldSkipDir: (path: string): boolean => shouldIgnore(path, true),
    shouldIgnoreFile: (path: string): boolean => shouldIgnore(path, false)
  }
}
