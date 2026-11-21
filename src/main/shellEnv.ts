import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { userInfo } from 'node:os'

/**
 * GUI-launched Electron apps on macOS get a minimal PATH (/usr/bin:/bin:...),
 * so `node` / `pnpm` / `npm` / CLIs installed via nvm, Homebrew, ~/.local/bin are missing.
 * We run the user's own login shell (login + interactive) once and capture its env, then append
 * common install dirs that exist (Homebrew, ~/.local/bin, nvm / fnm / volta / bun ...), so CLIs
 * are found even when the shell rc is broken or slow.
 */

const MARK = '__AGENTSWITCH_ENV__'

/** Vars from the parent process we never pass down to child shells. */
const STRIP_PREFIXES = ['ELECTRON_', 'VITE_', 'CHROME_']
const STRIP_EXACT = [
  'NODE_ENV',
  'NODE_OPTIONS',
  // If AgentSwitch itself was started from inside a Claude Code / Codex session,
  // these would leak into every profile and break isolation.
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'XDG_CONFIG_HOME',
  'AGENTSWITCH_HOME',
  'AGENTSWITCH_USER_DATA'
]

/**
 * The user's home. AGENTSWITCH_HOME overrides it (development / testing only: together with
 * AGENTSWITCH_USER_DATA it simulates a brand-new Mac without touching the real one).
 */
export const realHome: string = process.env.AGENTSWITCH_HOME || userInfo().homedir

let baseEnv: Record<string, string> | null = null
let lastError: string | null = null

function sanitize(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue
    if (STRIP_EXACT.includes(k)) continue
    if (STRIP_PREFIXES.some((p) => k.startsWith(p))) continue
    out[k] = v
  }
  return out
}

export const strippedVarNames = (): string[] => [...STRIP_EXACT, ...STRIP_PREFIXES.map((p) => p + '*')]

/** The user's login shell (Directory Services), falling back to zsh (the macOS default). */
function loginShell(): string {
  let sh = ''
  try {
    sh = userInfo().shell ?? ''
  } catch {
    /* no passwd entry */
  }
  sh ||= process.env.SHELL ?? ''
  return sh && existsSync(sh) && /\/(zsh|bash|sh|fish|ksh|dash)$/.test(sh) ? sh : '/bin/zsh'
}

function captureLoginEnv(shell: string): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const script = `printf '${MARK}'; /usr/bin/env -0; printf '${MARK}'`
    // fish does not accept bundled flags
    const args = basename(shell) === 'fish' ? ['-l', '-i', '-c', script] : ['-ilc', script]
    execFile(
      shell,
      args,
      {
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, HOME: realHome, ZDOTDIR: undefined } as NodeJS.ProcessEnv
      },
      (err, stdout) => {
        const start = stdout?.indexOf(MARK) ?? -1
        const end = stdout?.lastIndexOf(MARK) ?? -1
        if (start < 0 || end <= start) {
          return reject(err ?? new Error('marker not found in zsh output'))
        }
        const body = stdout.slice(start + MARK.length, end)
        const env: Record<string, string> = {}
        for (const entry of body.split('\0')) {
          const i = entry.indexOf('=')
          if (i > 0) env[entry.slice(0, i)] = entry.slice(i + 1)
        }
        resolve(env)
      }
    )
  })
}

const SYSTEM_PATHS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** nvm: the `default` alias if it resolves, else the newest installed version. */
function nvmBin(): string | null {
  const root = join(realHome, '.nvm', 'versions', 'node')
  let versions: string[]
  try {
    versions = readdirSync(root).filter((v) => /^v\d+/.test(v))
  } catch {
    return null
  }
  if (!versions.length) return null
  const num = (v: string) => v.replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0)
  versions.sort((a, b) => {
    const x = num(a)
    const y = num(b)
    return y[0] - x[0] || y[1] - x[1] || y[2] - x[2]
  })
  let pick = versions[0]
  try {
    const alias = readFileSync(join(realHome, '.nvm', 'alias', 'default'), 'utf8').trim().replace(/^v/, '')
    const hit = alias && versions.find((v) => v === `v${alias}` || v.startsWith(`v${alias}.`))
    if (hit) pick = hit
  } catch {
    /* no default alias */
  }
  return join(root, pick, 'bin')
}

/**
 * Common install locations for node / npm / CLIs, in priority order. Only existing dirs are
 * appended after the login shell's PATH (the user's own order always wins).
 */
function extraPaths(): string[] {
  const h = (...p: string[]) => join(realHome, ...p)
  const list = [
    h('.local', 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    h('.claude', 'local'),
    h('.npm-global', 'bin'),
    h('.npm-packages', 'bin'),
    h('.volta', 'bin'),
    h('.bun', 'bin'),
    h('.fnm', 'aliases', 'default', 'bin'),
    h('Library', 'Application Support', 'fnm', 'aliases', 'default', 'bin'),
    h('.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
    nvmBin(),
    h('.asdf', 'shims'),
    h('.local', 'share', 'mise', 'shims'),
    h('Library', 'pnpm'),
    h('.yarn', 'bin'),
    '/opt/homebrew/opt/node/bin',
    '/usr/local/opt/node/bin'
  ]
  return list.filter((p): p is string => !!p && isDir(p))
}

function mergePath(...parts: (string | undefined)[]): string {
  const out = new Set<string>()
  for (const part of parts) for (const d of (part ?? '').split(':')) if (d) out.add(d)
  return [...out].join(':')
}

export type ShellEnvSource = 'login' | 'cache' | 'fallback'
let source: ShellEnvSource = 'fallback'

function applyEnv(env: Record<string, string>, src: ShellEnvSource): void {
  // Drop shell-session noise that should not be inherited verbatim.
  for (const k of ['SHLVL', '_', 'OLDPWD', 'PWD']) delete env[k]
  const next = sanitize({ ...process.env, ...env })
  next.PATH = mergePath(next.PATH, extraPaths().join(':'), SYSTEM_PATHS.join(':'))
  next.HOME = realHome
  next.TERM = 'xterm-256color'
  next.COLORTERM = 'truecolor'
  next.LANG = next.LANG || 'en_US.UTF-8'
  baseEnv = next
  source = src
  // Main process itself also benefits (e.g. if we ever spawn helpers directly).
  process.env.PATH = next.PATH
}

function applyFallback(): void {
  applyEnv(sanitize(process.env), 'fallback')
}

/**
 * A heavy ~/.zshrc can take many seconds (nvm, conda...). If a cached env from a previous
 * run exists we use it immediately and refresh in the background; otherwise we wait once.
 */
export async function initShellEnv(cacheFile: string, onRefreshed: () => void): Promise<void> {
  const refresh = async (): Promise<boolean> => {
    try {
      const sh = loginShell()
      const login = await captureLoginEnv(sh).catch((e) => (sh === '/bin/zsh' ? Promise.reject(e) : captureLoginEnv('/bin/zsh')))
      applyEnv(login, 'login')
      lastError = null
      mkdirSync(dirname(cacheFile), { recursive: true })
      writeFileSync(cacheFile, JSON.stringify(login), { mode: 0o600 })
      return true
    } catch (e) {
      lastError = e instanceof Error ? e.message.split('\n')[0] : String(e)
      return false
    }
  }

  let cached: Record<string, string> | null = null
  try {
    if (existsSync(cacheFile)) cached = JSON.parse(readFileSync(cacheFile, 'utf8'))
  } catch {
    cached = null
  }

  if (cached) {
    applyEnv(cached, 'cache')
    void refresh().then((ok) => ok && onRefreshed())
    return
  }
  if (!(await refresh())) applyFallback()
}

/** Copy of the user's login env (real HOME, full PATH, isolation vars stripped). */
export function getBaseEnv(): Record<string, string> {
  if (!baseEnv) throw new Error('initShellEnv() not called')
  return { ...baseEnv }
}

/** Finds an executable on the resolved PATH (null when missing). */
export function findOnPath(bin: string): string | null {
  const path = baseEnv?.PATH ?? process.env.PATH ?? ''
  for (const d of path.split(':')) {
    if (!d) continue
    const p = join(d, bin)
    try {
      if (statSync(p).isFile()) return p
    } catch {
      /* next */
    }
  }
  return null
}

export function shellEnvStatus(): { source: ShellEnvSource; error: string | null } {
  return { source, error: lastError }
}
