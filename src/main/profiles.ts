import { app } from 'electron'
import { execFile, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  KINDS,
  type EnvPreview,
  type KindConfig,
  type ProfileConfig,
  type ProfileId,
  type ProfileKind,
  type ProfileState,
  type ProfileStatus,
  type PtyMode
} from '@shared/types'
import { findOnPath, getBaseEnv, realHome, strippedVarNames } from './shellEnv'
import { loadStore, saveStore, type StoreData } from './store'
import { t } from './i18n'

const SHELL = '/bin/zsh'

/** Files from the real HOME that get symlinked into an isolated HOME (gemini). */
const HOME_LINKS = ['.gitconfig', '.npmrc', '.ssh']

export const KIND_LABEL: Record<ProfileKind, string> = { claude: 'Claude', gemini: 'Gemini', codex: 'Codex' }

export const KIND_DEFAULTS: Record<ProfileKind, Omit<KindConfig, 'kind'>> = {
  // claude --model accepts aliases for the latest model of a family (verified via `claude --help`)
  claude: {
    binary: 'claude',
    installCommand: 'curl -fsSL https://claude.ai/install.sh | bash',
    updateCommand: 'claude update',
    models: ['opus', 'sonnet', 'fable', 'haiku']
  },
  // Gemini = Google Antigravity CLI (`agy`). Static fallback measured with `agy models` (2026-11-21);
  // the live list is fetched per account (src/main/models.ts).
  gemini: {
    binary: 'agy',
    installCommand: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    updateCommand: 'agy update',
    // agy bakes reasoning effort into the id; the UI folds these into one row per base model
    models: ['gemini-4-neon', 'gemini-4-argon', 'gemini-4-hydrogen', 'gemini-3.8-flash'].flatMap((b) => ['low', 'medium', 'high'].map((e) => `${b}-${e}`))
  },
  // codex -m/--model. Static fallback measured from `codex debug models` (2026-11-21).
  codex: {
    binary: 'codex',
    installCommand: 'npm install -g @openai/codex',
    updateCommand: 'npm install -g @openai/codex@latest',
    models: ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-sol', 'gpt-6-luna']
  }
}

const COMMAND_DEFAULTS: Record<ProfileKind, Pick<ProfileConfig, 'loginCommand' | 'runCommand'>> = {
  // `claude auth login` prints the OAuth URL straight away; `claude /login` opens the TUI,
  // which first asks for a theme and a login method, so it stalls until someone answers.
  claude: { loginCommand: 'claude auth login', runCommand: 'claude' },
  // agy has no login subcommand: the interactive TUI prompts for sign-in (or `/login`).
  gemini: { loginCommand: 'agy', runCommand: 'agy' },
  codex: { loginCommand: 'codex login', runCommand: 'codex' }
}

export function expandHome(p: string): string {
  if (p === '~') return realHome
  if (p.startsWith('~/')) return join(realHome, p.slice(2))
  return resolve(p)
}

const managedDir = (id: ProfileId, kind: ProfileKind): string =>
  join(app.getPath('userData'), 'profiles', id, ...(kind === 'gemini' ? ['home'] : []))

const newId = (kind: ProfileKind): ProfileId => `${kind}-${randomBytes(3).toString('hex')}`

// ---- store ---------------------------------------------------------------------

let store: StoreData = { version: 2, profiles: [], kinds: {} }

const persist = (): void => saveStore(store)

/**
 * First launch: import only setups that already exist on this Mac.
 * Imported accounts point at the user's own dirs; AgentSwitch never deletes them.
 */
function detectExisting(): ProfileConfig[] {
  const out: ProfileConfig[] = []
  const now = Date.now()
  const add = (kind: ProfileKind, configDir: string, name: string) =>
    out.push({
      id: newId(kind),
      name,
      kind,
      configDir,
      imported: true,
      ...COMMAND_DEFAULTS[kind],
      extraEnv: {},
      defaultModel: '',
      autoApprove: 'cli',
      createdAt: now + out.length
    })

  const h = (p: string) => join(realHome, p)
  claudeDirs().forEach((name, i) => add('claude', `~/${name}`, defaultName('claude', i + 1)))
  if (hasAgySetup(realHome)) add('gemini', '~', defaultName('gemini', 1))
  if (existsSync(h('.codex/auth.json')) || existsSync(h('.codex/config.toml'))) add('codex', '~/.codex', defaultName('codex', 1))
  return out
}

/**
 * Claude config dirs in the home folder: `~/.claude` plus extra ones people create for a second
 * account (`~/.claude2`, `~/.claude-work`, ...), recognised by Claude's own files inside.
 * Nothing is hard-coded beyond the `.claude` prefix.
 */
export function claudeDirs(): string[] {
  let names: string[]
  try {
    names = readdirSync(realHome)
  } catch {
    return []
  }
  const looksLikeClaude = (dir: string) =>
    ['settings.json', '.claude.json', '.credentials.json', 'projects', 'history.jsonl'].some((f) => existsSync(join(dir, f)))
  return names
    .filter((n) => /^\.claude([0-9]+|[-_][\w-]+)?$/.test(n))
    .filter((n) => {
      const p = join(realHome, n)
      try {
        return statSync(p).isDirectory() && (n === '.claude' || looksLikeClaude(p))
      } catch {
        return false
      }
    })
    .sort((a, b) => (a === '.claude' ? -1 : b === '.claude' ? 1 : a.localeCompare(b, undefined, { numeric: true })))
}

/** agy (Antigravity CLI) already used with this HOME: signed in, or has CLI state. */
const hasAgySetup = (home: string): boolean =>
  agyKeychainItem(home) !== null || existsSync(join(home, '.gemini', 'antigravity-cli'))

const MIGRATIONS = ['agy-import', 'claude-auth-login']

/** true when this run created the account store (a brand-new install). */
export let firstRun = false

export function initProfiles(): void {
  const loaded = loadStore()
  if (!loaded) {
    firstRun = true
    store = { version: 2, profiles: detectExisting(), kinds: {}, migrations: [...MIGRATIONS] }
    persist()
    return
  }
  store = loaded
  const done = new Set(store.migrations ?? [])
  if (!done.has('agy-import')) {
    // Gemini switched from `gemini` to Antigravity `agy`: fix old default commands,
    // and import the existing ~/.gemini agy setup once if no Gemini account exists yet.
    for (const p of store.profiles)
      if (p.kind === 'gemini') {
        if (p.loginCommand === 'gemini') p.loginCommand = 'agy'
        if (p.runCommand === 'gemini') p.runCommand = 'agy'
      }
    if (store.kinds.gemini?.binary === 'gemini') delete store.kinds.gemini.binary
    if (!store.profiles.some((p) => p.kind === 'gemini') && hasAgySetup(realHome)) {
      const used = new Set(store.profiles.map((p) => p.name))
      store.profiles.push({
        id: newId('gemini'),
        name: used.has(defaultName('gemini', 1)) ? suggestName('gemini') : defaultName('gemini', 1),
        kind: 'gemini',
        configDir: '~',
        imported: true,
        ...COMMAND_DEFAULTS.gemini,
        extraEnv: {},
        defaultModel: '',
        autoApprove: 'cli',
        createdAt: Date.now()
      })
    }
    done.add('agy-import')
  }
  if (!done.has('claude-auth-login')) {
    // Only rewrite the old default; a custom login command stays as the user set it.
    for (const p of store.profiles) if (p.kind === 'claude' && p.loginCommand === 'claude /login') p.loginCommand = COMMAND_DEFAULTS.claude.loginCommand
    done.add('claude-auth-login')
  }
  store.migrations = [...done]
  persist()
}

const withDefaults = (p: ProfileConfig): ProfileConfig => ({
  ...p,
  defaultModel: p.defaultModel ?? '',
  autoApprove: p.autoApprove === 'full' || p.autoApprove === 'edits' ? p.autoApprove : 'cli',
  extraEnv: { ...p.extraEnv }
})

export const listConfigs = (): ProfileConfig[] => store.profiles.map(withDefaults)

export function hasProfile(id: unknown): id is ProfileId {
  return typeof id === 'string' && store.profiles.some((p) => p.id === id)
}

export function getConfig(id: ProfileId): ProfileConfig {
  const p = store.profiles.find((x) => x.id === id)
  if (!p) throw new Error(`unknown account: ${id}`)
  return withDefaults(p)
}

export function getKindConfig(kind: ProfileKind): KindConfig {
  return { kind, ...KIND_DEFAULTS[kind], ...(store.kinds[kind] ?? {}) }
}

/**
 * CLI args selecting a sub-model. All three CLIs accept `--model <id>`
 * (claude: alias or full name; codex: -m/--model; agy: --model). '' -> CLI default.
 * Phase 2: appended to run commands for each turn.
 */
export const modelArgs = (model: string | null | undefined): string[] => (model?.trim() ? ['--model', model.trim()] : [])

export function updateKindConfig(kind: ProfileKind, patch: Partial<KindConfig>): KindConfig {
  const { kind: _k, ...rest } = patch
  if (rest.models) rest.models = [...new Set(rest.models.map((m) => m.trim()).filter(Boolean))]
  store.kinds[kind] = { ...(store.kinds[kind] ?? {}), ...rest }
  persist()
  return getKindConfig(kind)
}

export function resetKindConfig(kind: ProfileKind): KindConfig {
  delete store.kinds[kind]
  persist()
  return getKindConfig(kind)
}

/** "<Kind> 账号 N" in the UI language. */
const defaultName = (kind: ProfileKind, n: number): string => t('acct.defaultName', { kind: KIND_LABEL[kind], n })

/** Next free "<Kind> 账号 N" name. */
function suggestName(kind: ProfileKind): string {
  const used = new Set(store.profiles.map((p) => p.name))
  for (let n = 1; ; n++) {
    const name = defaultName(kind, n)
    if (!used.has(name)) return name
  }
}

export function addProfile(kind: ProfileKind, name?: string): ProfileConfig {
  if (!KINDS.includes(kind)) throw new Error(`bad kind ${kind}`)
  const id = newId(kind)
  const p: ProfileConfig = {
    id,
    name: name?.trim() || suggestName(kind),
    kind,
    configDir: managedDir(id, kind),
    imported: false,
    ...COMMAND_DEFAULTS[kind],
    extraEnv: {},
    defaultModel: '',
    autoApprove: 'cli',
    createdAt: Date.now()
  }
  store.profiles.push(p)
  persist()
  return getConfig(id)
}

export function updateProfile(id: ProfileId, patch: Partial<ProfileConfig>): ProfileConfig {
  const i = store.profiles.findIndex((p) => p.id === id)
  if (i < 0) throw new Error(`unknown account: ${id}`)
  const { id: _i, kind: _k, imported: _m, createdAt: _c, ...rest } = patch
  if (rest.name !== undefined) rest.name = rest.name.trim() || store.profiles[i].name
  if (rest.defaultModel !== undefined) rest.defaultModel = rest.defaultModel.trim()
  if (rest.autoApprove !== undefined && rest.autoApprove !== 'full' && rest.autoApprove !== 'edits') rest.autoApprove = 'cli'
  store.profiles[i] = { ...store.profiles[i], ...rest }
  persist()
  return getConfig(id)
}

/** Restores default commands / env (keeps name and directory). */
export function resetProfile(id: ProfileId): ProfileConfig {
  const p = getConfig(id)
  return updateProfile(id, { ...COMMAND_DEFAULTS[p.kind], extraEnv: {} })
}

/** Removes the account from AgentSwitch only. Files on disk (incl. ~/.claude etc.) are left untouched. */
export function removeProfile(id: ProfileId): void {
  store.profiles = store.profiles.filter((p) => p.id !== id)
  persist()
}

// ---- detection -----------------------------------------------------------------

/** PATH lookup without spawning a shell. */
export function which(bin: string, pathVar: string): string | null {
  if (bin.includes('/')) {
    try {
      accessSync(bin, constants.X_OK)
      return bin
    } catch {
      return null
    }
  }
  for (const dir of pathVar.split(':')) {
    if (!dir) continue
    const p = join(dir, bin)
    try {
      accessSync(p, constants.X_OK)
      return p
    } catch {
      /* next */
    }
  }
  return null
}

export const kindBinaryPath = (kind: ProfileKind): string | null =>
  which(getKindConfig(kind).binary, getBaseEnv().PATH ?? '')

const isSystemClaudeDir = (dir: string): boolean => dir === join(realHome, '.claude')

function readJson(p: string): any {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/**
 * agy keeps its OAuth token in the macOS keychain (service `gemini`, account `antigravity`).
 * The keychain search list is resolved from $HOME, so an isolated HOME has its own (initially
 * empty) list and never sees or overwrites the real login keychain item.
 * Returns the item's modification date (metadata only; the secret is never read), or null.
 * Cached briefly: state snapshots are rebuilt often.
 */
const keychainCache = new Map<string, { at: number; value: string | null }>()
function agyKeychainItem(home: string): string | null {
  const hit = keychainCache.get(home)
  if (hit && Date.now() - hit.at < 1000) return hit.value
  const r = spawnSync('/usr/bin/security', ['find-generic-password', '-s', 'gemini', '-a', 'antigravity'], {
    env: { HOME: home, PATH: '/usr/bin:/bin', USER: process.env.USER ?? '' },
    encoding: 'utf8',
    timeout: 3000
  })
  const value = r.status === 0 ? (r.stdout.match(/"mdat"<timedate>=([^\n]*)/)?.[1]?.trim() ?? 'present') : null
  keychainCache.set(home, { at: Date.now(), value })
  return value
}

/**
 * When the keychain is unavailable (e.g. isolated HOME) agy falls back to file storage.
 * The exact file isn't documented, so look for token-like files under ~/.gemini (depth 2).
 */
function agyTokenFiles(home: string): string[] {
  const root = join(home, '.gemini')
  const out: string[] = []
  const walk = (dir: string, depth: number) => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const n of names) {
      const p = join(dir, n)
      if (/token|credential|keyring|secret|oauth/i.test(n)) out.push(p)
      else if (depth > 0 && n !== 'conversations' && n !== 'log' && n !== 'skills' && n !== 'plugins') {
        try {
          if (statSync(p).isDirectory()) walk(p, depth - 1)
        } catch {
          /* ignore */
        }
      }
    }
  }
  walk(root, 2)
  return out.sort()
}

/** Best-effort "has this account completed OAuth" check, by kind. */
function detectLoggedIn(cfg: ProfileConfig, dir: string): boolean {
  switch (cfg.kind) {
    case 'claude': {
      // Default dir keeps its global config at ~/.claude.json; custom CLAUDE_CONFIG_DIR at <dir>/.claude.json.
      const globalJson = isSystemClaudeDir(dir) ? join(realHome, '.claude.json') : join(dir, '.claude.json')
      const j = readJson(globalJson)
      if (j && (j.oauthAccount || j.primaryApiKey)) return true
      return existsSync(join(dir, '.credentials.json'))
    }
    case 'gemini':
      // dir is the HOME agy runs with (real HOME for the imported account)
      return agyKeychainItem(dir) !== null || agyTokenFiles(dir).length > 0
    case 'codex':
      return existsSync(join(dir, 'auth.json'))
  }
}

export function isLoggedIn(id: ProfileId): boolean {
  const cfg = getConfig(id)
  return detectLoggedIn(cfg, expandHome(cfg.configDir))
}

/**
 * Fingerprint of the credential files a login writes. A login session is considered
 * successful when this changes AND the account reads as logged in, so re-logging an
 * already-logged-in account (account switch) is detected too.
 */
export function loginSignature(id: ProfileId): string {
  const cfg = getConfig(id)
  const dir = expandHome(cfg.configDir)
  const stamp = (p: string): string => {
    try {
      const st = statSync(p)
      return `${p}:${st.mtimeMs}:${st.size}`
    } catch {
      return `${p}:-`
    }
  }
  switch (cfg.kind) {
    case 'claude': {
      const globalJson = isSystemClaudeDir(dir) ? join(realHome, '.claude.json') : join(dir, '.claude.json')
      // .claude.json is rewritten constantly (usage counters); only the account block matters.
      const acct = readJson(globalJson)?.oauthAccount ?? null
      return JSON.stringify(acct) + '|' + stamp(join(dir, '.credentials.json'))
    }
    case 'gemini':
      keychainCache.delete(dir)
      return [
        `kc:${agyKeychainItem(dir) ?? '-'}`,
        stamp(join(dir, '.gemini', 'antigravity-cli', 'jetski_state.pbtxt')),
        ...agyTokenFiles(dir).map(stamp)
      ].join('|')
    case 'codex':
      return stamp(join(dir, 'auth.json'))
  }
}

/** `<bin> --version` with the base env; null if missing/failed. */
export function cliVersion(kind: ProfileKind): Promise<string | null> {
  const env = getBaseEnv()
  const bin = kindBinaryPath(kind)
  if (!bin) return Promise.resolve(null)
  return new Promise((res) => {
    execFile(bin, ['--version'], { env, timeout: 8000 }, (err, stdout) => {
      if (err) return res(null)
      const line = stdout.trim().split('\n')[0] ?? ''
      res(line.match(/\d+\.\d+\.\d+[\w.-]*/)?.[0] ?? (line.slice(0, 40) || null))
    })
  })
}

// ---- spawning ------------------------------------------------------------------

const ISOLATED_KEYCHAIN = 'agentswitch.keychain-db'
const ISOLATED_KEYCHAIN_LINK = 'login.keychain-db'
const ISOLATED_KEYCHAIN_PASS = '.passphrase'

/**
 * Ensures an isolated macOS HOME has its own unlocked default keychain so `agy` can store and
 * refresh its OAuth token without triggering macOS's "A keychain cannot be found" alert.
 *
 * macOS Security.framework resolves `$HOME/Library/Keychains/login.keychain-db` automatically
 * without touching `com.apple.security.plist`. Because `securityd` treats a file literally named
 * `login.keychain-db` specially and rejects `unlock-keychain -p` for it (exit 51), we create
 * `agentswitch.keychain-db` and point `login.keychain-db` at it via a relative symlink.
 */
export function ensureIsolatedKeychain(dir: string): void {
  if (process.platform !== 'darwin' || dir === realHome) return
  const kcDir = join(dir, 'Library', 'Keychains')
  const kcPath = join(kcDir, ISOLATED_KEYCHAIN)
  const loginLink = join(kcDir, ISOLATED_KEYCHAIN_LINK)
  const passPath = join(kcDir, ISOLATED_KEYCHAIN_PASS)
  const env = { HOME: dir, PATH: '/usr/bin:/bin', USER: process.env.USER ?? '' }

  let loginStat: ReturnType<typeof lstatSync> | null = null
  try {
    loginStat = lstatSync(loginLink)
  } catch {
    /* not present */
  }
  // If a regular (non-symlink) login.keychain-db already exists here, leave it untouched.
  if (loginStat && !loginStat.isSymbolicLink() && !existsSync(kcPath)) return

  try {
    mkdirSync(kcDir, { recursive: true, mode: 0o700 })
    let pw = ''
    if (existsSync(passPath)) {
      pw = readFileSync(passPath, 'utf8').trim()
    }
    if (!existsSync(kcPath)) {
      if (!pw) {
        pw = randomBytes(24).toString('hex')
        writeFileSync(passPath, pw + '\n', { mode: 0o600 })
      }
      const created = spawnSync('/usr/bin/security', ['create-keychain', '-p', pw, kcPath], { env, encoding: 'utf8', timeout: 5000 })
      if (created.status !== 0 || !existsSync(kcPath)) {
        console.warn(`[profiles] create-keychain failed for ${kcPath}:`, created.stderr?.trim() || created.error)
        return
      }
      // Disable auto-lock timeout and lock-on-sleep so background refreshes stay unlocked.
      spawnSync('/usr/bin/security', ['set-keychain-settings', kcPath], { env, encoding: 'utf8', timeout: 5000 })
    }
    if (!loginStat) {
      symlinkSync(ISOLATED_KEYCHAIN, loginLink)
    } else if (loginStat.isSymbolicLink() && !existsSync(loginLink)) {
      unlinkSync(loginLink)
      symlinkSync(ISOLATED_KEYCHAIN, loginLink)
    }
    if (pw) {
      const unlocked = spawnSync('/usr/bin/security', ['unlock-keychain', '-p', pw, kcPath], { env, encoding: 'utf8', timeout: 5000 })
      if (unlocked.status !== 0) {
        console.warn(`[profiles] unlock-keychain failed for ${kcPath}:`, unlocked.stderr?.trim() || unlocked.error)
      }
    }
  } catch (e) {
    console.warn(`[profiles] ensureIsolatedKeychain failed for ${dir}`, e)
  }
}

/** Ensures the isolation dir exists. Never touches existing dirs/symlinks (e.g. ~/.claude2/projects). */
export function prepareProfileDir(cfg: ProfileConfig): string {
  const dir = expandHome(cfg.configDir)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  if (cfg.kind === 'gemini' && dir !== realHome) {
    for (const name of HOME_LINKS) {
      const src = join(realHome, name)
      const dst = join(dir, name)
      if (!existsSync(src)) continue // missing (or dangling link) in real HOME -> skip silently
      try {
        lstatSync(dst)
        continue // already present (file, dir or link) -> leave untouched
      } catch {
        /* not present */
      }
      try {
        symlinkSync(src, dst)
      } catch (e) {
        console.warn(`[profiles] symlink ${dst} -> ${src} failed`, e)
      }
    }
    ensureIsolatedKeychain(dir)
  }
  return dir
}

/** Env vars injected on top of the base login env for isolated modes. */
function isolationEnv(cfg: ProfileConfig, dir: string): Record<string, string> {
  const env: Record<string, string> = {}
  switch (cfg.kind) {
    case 'claude':
      if (!isSystemClaudeDir(dir)) env.CLAUDE_CONFIG_DIR = dir
      break
    case 'gemini':
      if (dir !== realHome) env.HOME = dir
      break
    case 'codex':
      env.CODEX_HOME = dir
      break
  }
  env.AGENTSWITCH_PROFILE = cfg.id
  return { ...env, ...cfg.extraEnv }
}

export interface SpawnSpec {
  shell: string
  args: string[]
  env: Record<string, string>
  cwd: string
  injected: Record<string, string>
}

export function installCommand(kind: ProfileKind, update = false): string {
  const k = getKindConfig(kind)
  return (update && k.updateCommand.trim()) || k.installCommand
}

const NODE_TOOLS = ['npm', 'npx', 'pnpm', 'yarn', 'bun', 'node']

/**
 * A package-manager install (e.g. `npm install -g ...`) needs that tool on PATH. Returns the
 * missing tool's name, or null when the command can run.
 */
export function missingInstallTool(kind: ProfileKind, update = false): string | null {
  const first = installCommand(kind, update).trim().split(/\s+/)[0] ?? ''
  if (!NODE_TOOLS.includes(first)) return null
  return findOnPath(first) ? null : first
}

/** Install: real HOME + login shell so installers write to the user's global prefix / PATH. */
export function buildInstallSpec(kind: ProfileKind, update = false): SpawnSpec {
  const cmd = installCommand(kind, update)
  return { shell: SHELL, args: ['-ilc', cmd], env: getBaseEnv(), cwd: realHome, injected: {} }
}

export function buildSpawnSpec(id: ProfileId, mode: Exclude<PtyMode, 'install'>, command?: string, prepare = true): SpawnSpec {
  const cfg = getConfig(id)
  const base = getBaseEnv()
  const dir = prepare ? prepareProfileDir(cfg) : expandHome(cfg.configDir)
  const injected = isolationEnv(cfg, dir)
  const env = { ...base, ...injected }
  const cwd = realHome
  if (mode === 'shell') return { shell: SHELL, args: ['-i'], env, cwd, injected }
  const cmd = command ?? (mode === 'login' ? cfg.loginCommand : mode === 'run' ? cfg.runCommand : 'echo "no command"')
  // Non-login, no rc files: PATH already resolved from the real login shell,
  // and an isolated HOME must not pick up a half-working ~/.zshrc.
  return { shell: SHELL, args: ['-fc', cmd], env, cwd, injected }
}

export function envPreview(id: ProfileId, mode: PtyMode): EnvPreview {
  const s = mode === 'install' ? buildInstallSpec(getConfig(id).kind) : buildSpawnSpec(id, mode, undefined, false)
  return { injected: s.injected, removed: strippedVarNames(), shell: s.shell, args: s.args, cwd: s.cwd }
}

/**
 * Canonical session-storage key for an account (`${kind}:${realpath(sessionsDir)}`).
 * Two accounts of the same CLI vendor with the same key (e.g. symlinked `projects/`,
 * `sessions/`, or `conversations/`) can natively `--resume` each other's sessions.
 */
export function sessionStoreKeyOf(cfg: ProfileConfig): string {
  const dir = expandHome(cfg.configDir)
  const sub =
    cfg.kind === 'claude'
      ? join(dir, 'projects')
      : cfg.kind === 'codex'
        ? join(dir, 'sessions')
        : join(dir, '.gemini', 'antigravity-cli', 'conversations')
  let real: string
  try {
    real = realpathSync(sub)
  } catch {
    real = resolve(sub)
  }
  return `${cfg.kind}:${real}`
}

export function getState(
  cfg: ProfileConfig,
  binaryPath: string | null,
  sessionMode: PtyMode | null,
  rateLimited: boolean,
  installing: boolean
): ProfileState {
  const dir = expandHome(cfg.configDir)
  const loggedIn = binaryPath ? detectLoggedIn(cfg, dir) : false
  let status: ProfileStatus
  if (sessionMode) status = 'running'
  else if (!binaryPath) status = 'uninstalled'
  else if (rateLimited) status = 'rate_limited'
  else if (!loggedIn) status = 'not_logged_in'
  else status = 'idle'
  return { ...cfg, status, binaryPath, loggedIn, resolvedConfigDir: dir, sessionStoreKey: sessionStoreKeyOf(cfg), sessionMode, installing }
}
