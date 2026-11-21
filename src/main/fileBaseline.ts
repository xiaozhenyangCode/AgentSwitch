import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { LEGACY_PROJECT_DIR } from './legacy'
import { createTwoFilesPatch } from 'diff'
import { t } from './i18n'

/**
 * Text-content baseline of a project, taken before each step, so file changes reported by
 * CLIs that don't ship the edit itself (codex file_change, agy write_file/edit_file, plain
 * shell writes) can still be shown as a unified diff.
 *
 * Bounded: files ≤ 256 KB, ≤ 3000 files, ≤ 24 MB total; binary files are skipped.
 */

const MAX_FILE = 256 * 1024
const MAX_FILES = 3000
const MAX_TOTAL = 24 * 1024 * 1024
export const MAX_DIFF = 16 * 1024
const SKIP_DIRS = new Set(['.git', 'node_modules', '.agentswitch', LEGACY_PROJECT_DIR, 'dist', 'out', 'build', '.next', '.venv', 'venv', '__pycache__', '.cache', 'Pods', 'DerivedData', 'target'])
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|icns|pdf|zip|gz|tgz|bz2|xz|7z|rar|dmg|mp3|mp4|mov|wav|ogg|woff2?|ttf|otf|eot|so|dylib|dll|exe|bin|class|jar|o|a|pyc|sqlite|db|psd|ai|sketch|fig)$/i

const isText = (buf: Buffer): boolean => !buf.subarray(0, 8000).includes(0)

function readText(p: string): string | null {
  try {
    const st = statSync(p)
    if (!st.isFile() || st.size > MAX_FILE || BINARY_EXT.test(p)) return null
    const buf = readFileSync(p)
    return isText(buf) ? buf.toString('utf8') : null
  } catch {
    return null
  }
}

export class FileBaseline {
  private files = new Map<string, string>()
  /** Paths that existed at snapshot time (text or not) — new files diff against ''. */
  private existed = new Set<string>()

  constructor(private root: string) {
    let total = 0
    const walk = (dir: string, depth: number): void => {
      if (depth > 8) return
      let entries: import('node:fs').Dirent[]
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const p = join(dir, e.name)
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) walk(p, depth + 1)
          continue
        }
        if (!e.isFile()) continue
        this.existed.add(p)
        if (this.files.size >= MAX_FILES || total >= MAX_TOTAL) continue
        const t = readText(p)
        if (t === null) continue
        this.files.set(p, t)
        total += t.length
      }
    }
    walk(root, 0)
  }

  /**
   * Unified diff of `abs` against the baseline, then advances the baseline so a later edit
   * of the same file shows only its own change. null: binary / too large / not tracked.
   */
  diff(abs: string): string | null {
    const after = readText(abs)
    let before = this.files.get(abs)
    if (before === undefined) {
      if (this.existed.has(abs)) {
        // existed but wasn't captured (binary/large/cap): can't diff
        if (after !== null) this.files.set(abs, after)
        return null
      }
      before = ''
    }
    const now = after ?? ''
    if (before === now) return null
    this.files.set(abs, now)
    this.existed.add(abs)
    const name = relative(this.root, abs) || abs
    const patch = createTwoFilesPatch(before ? `a/${name}` : '/dev/null', after !== null ? `b/${name}` : '/dev/null', before, now, '', '', { context: 3 })
    // drop the "Index:/====" preamble jsdiff adds
    const body = patch.replace(/^(Index:[^\n]*\n)?=+\n/, '')
    return body.length > MAX_DIFF ? body.slice(0, MAX_DIFF) + '\n' + t('main.diffTruncated') + '\n' : body
  }

  /** Record the current content without producing a diff (the CLI shipped its own patch). */
  touch(abs: string): void {
    const t = readText(abs)
    if (t !== null) this.files.set(abs, t)
    this.existed.add(abs)
  }
}
