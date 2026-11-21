import { execFile } from 'node:child_process'
import { openSync, readSync, closeSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { FileChange, FileChanges } from '@shared/types'
import { getBaseEnv } from './shellEnv'
import { allowRoot } from './fileProtocol'

/** Read-only `git status` + `git diff` of a project folder for the 文件修改 panel. */

const MAX_FILES = 300
const MAX_DIFF = 200 * 1024 // per file
const MAX_TOTAL = 4 * 1024 * 1024 // whole `git diff` output
const MAX_UNTRACKED_READ = 256 * 1024
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

function env(): NodeJS.ProcessEnv {
  try {
    return getBaseEnv()
  } catch {
    return process.env
  }
}

function git(cwd: string, args: string[], maxBuffer = MAX_TOTAL): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      'git',
      ['-c', 'core.quotepath=off', '--no-optional-locks', ...args],
      {
        cwd,
        env: { ...env(), GIT_PAGER: 'cat', LC_ALL: 'C' },
        maxBuffer,
        timeout: 15_000
      },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    )
  )
}

const cut = (d: string): { diff: string; truncated: boolean } =>
  d.length > MAX_DIFF ? { diff: d.slice(0, MAX_DIFF) + '\n… (diff truncated)', truncated: true } : { diff: d, truncated: false }

/** Synthetic all-added diff for an untracked file. */
function untrackedDiff(abs: string, rel: string): { diff: string; added: number; binary: boolean; truncated: boolean } {
  let fd: number | null = null
  try {
    const size = statSync(abs).size
    const n = Math.min(size, MAX_UNTRACKED_READ)
    const buf = Buffer.alloc(n)
    fd = openSync(abs, 'r')
    readSync(fd, buf, 0, n, 0)
    if (buf.subarray(0, 8192).includes(0)) return { diff: '', added: 0, binary: true, truncated: false }
    const text = buf.toString('utf8')
    const lines = text.replace(/\n$/, '').split('\n')
    const added = text ? lines.length : 0
    const body = `--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${added} @@\n` + lines.map((l) => '+' + l).join('\n')
    const c = cut(body)
    return {
      diff: c.diff,
      added,
      binary: false,
      truncated: c.truncated || size > n
    }
  } catch {
    return { diff: '', added: 0, binary: false, truncated: false }
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/** Splits `git diff` output into per-file chunks keyed by the new (b/) path. */
function splitDiff(out: string): Map<string, string> {
  const map = new Map<string, string>()
  const parts = out.split(/^(?=diff --git )/m)
  for (const p of parts) {
    if (!p.startsWith('diff --git ')) continue
    const plus = /^\+\+\+ b\/(.+)$/m.exec(p)?.[1]
    const minus = /^--- a\/(.+)$/m.exec(p)?.[1]
    const head = /^diff --git a\/(.+?) b\/(.+)$/m.exec(p)
    const key = plus ?? head?.[2] ?? minus
    if (key) map.set(key, p.replace(/^diff --git .*\n(?:(?:index|similarity|rename|new file|deleted file|old mode|new mode).*\n)*/, ''))
  }
  return map
}

export async function gitChanges(dir: unknown): Promise<FileChanges> {
  const none: FileChanges = { repo: false, files: [], added: 0, removed: 0 }
  if (typeof dir !== 'string' || !isAbsolute(dir)) return none
  try {
    if (!statSync(dir).isDirectory()) return none
  } catch {
    return none
  }
  let root: string
  try {
    root = (await git(dir, ['rev-parse', '--show-toplevel'])).trim()
  } catch {
    return none
  }
  allowRoot(dir) // Finder / open for the listed files

  let base = 'HEAD'
  try {
    await git(root, ['rev-parse', '--verify', '-q', 'HEAD'])
  } catch {
    base = EMPTY_TREE // fresh repo with no commits
  }

  // only what lies under the chosen folder (it may be a subfolder of the repo)
  const scope = relative(root, dir) || '.'
  const [status, numstat, diffOut] = await Promise.all([
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', scope]),
    git(root, ['diff', base, '--numstat', '-z', '-M', '--', scope]).catch(() => ''),
    git(root, ['diff', base, '--no-color', '--no-ext-diff', '-M', '--', scope]).catch(() => '')
  ])

  // numstat -z: "add\tdel\tpath\0" or, for renames, "add\tdel\t\0old\0new\0"
  const stats = new Map<string, { a: number; d: number; bin: boolean }>()
  {
    const tok = numstat.split('\0')
    for (let i = 0; i < tok.length; i++) {
      const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(tok[i])
      if (!m) continue
      let p = m[3]
      if (!p) {
        p = tok[i + 2] ?? ''
        i += 2
      }
      stats.set(p, {
        a: m[1] === '-' ? 0 : +m[1],
        d: m[2] === '-' ? 0 : +m[2],
        bin: m[1] === '-'
      })
    }
  }
  const diffs = splitDiff(diffOut)

  const files: FileChange[] = []
  let total = 0
  const tok = status.split('\0')
  for (let i = 0; i < tok.length; i++) {
    const e = tok[i]
    if (e.length < 4) continue
    const xy = e.slice(0, 2)
    const p = e.slice(3)
    if (xy[0] === 'R' || xy[0] === 'C') i++ // next token is the old path
    total++
    if (files.length >= MAX_FILES) continue
    const abs = join(root, p)
    const rel = relative(dir, abs).split(sep).join('/')
    if (xy === '??') {
      const u = untrackedDiff(abs, rel)
      files.push({
        path: rel,
        abs,
        status: 'U',
        added: u.added,
        removed: 0,
        diff: u.diff,
        binary: u.binary,
        truncated: u.truncated
      })
      continue
    }
    const st: FileChange['status'] = xy.includes('D') ? 'D' : xy[0] === 'R' ? 'R' : xy.includes('A') ? 'A' : 'M'
    const s = stats.get(p)
    const c = cut(diffs.get(p) ?? '')
    files.push({
      path: rel,
      abs,
      status: st,
      added: s?.a ?? 0,
      removed: s?.d ?? 0,
      diff: c.diff,
      binary: s?.bin,
      truncated: c.truncated
    })
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  return {
    repo: true,
    files,
    added: files.reduce((n, f) => n + f.added, 0),
    removed: files.reduce((n, f) => n + f.removed, 0),
    ...(total > files.length ? { more: total - files.length } : {})
  }
}
