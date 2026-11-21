import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { userInfo } from 'node:os'

/**
 * GUI-launched Electron apps on macOS get a minimal PATH (/usr/bin:/bin:...),
 * so `node` / `pnpm` / `npm` / CLIs installed via nvm, Homebrew, ~/.local/bin are missing.
 * We run the user's login+interactive zsh once and capture its env.
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
  'XDG_CONFIG_HOME'
]

export const realHome: string = userInfo().homedir

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

function captureLoginEnv(): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const shell = '/bin/zsh'
    execFile(
      shell,
      ['-ilc', `printf '${MARK}'; /usr/bin/env -0; printf '${MARK}'`],
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

const FALLBACK_PATHS = [
  `${realHome}/.local/bin`,
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin'
]

export type ShellEnvSource = 'login' | 'cache' | 'fallback'
let source: ShellEnvSource = 'fallback'

function applyEnv(env: Record<string, string>, src: ShellEnvSource): void {
  // Drop shell-session noise that should not be inherited verbatim.
  for (const k of ['SHLVL', '_', 'OLDPWD', 'PWD']) delete env[k]
  const next = sanitize({ ...process.env, ...env })
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
  const env = sanitize(process.env)
  const parts = new Set([...(env.PATH ?? '').split(':').filter(Boolean), ...FALLBACK_PATHS])
  env.PATH = [...parts].join(':')
  applyEnv(env, 'fallback')
}

/**
 * A heavy ~/.zshrc can take many seconds (nvm, conda...). If a cached env from a previous
 * run exists we use it immediately and refresh in the background; otherwise we wait once.
 */
export async function initShellEnv(cacheFile: string, onRefreshed: () => void): Promise<void> {
  const refresh = async (): Promise<boolean> => {
    try {
      const login = await captureLoginEnv()
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

export function shellEnvStatus(): { source: ShellEnvSource; error: string | null } {
  return { source, error: lastError }
}
