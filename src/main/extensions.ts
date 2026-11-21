import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { ExtSource, McpList, McpServer, McpState, McpTransport, ProfileId, SkillItem, SkillList } from '@shared/types'
import { expandHome, getConfig } from './profiles'
import { realHome } from './shellEnv'

/**
 * Read-only discovery of the skills / custom commands and MCP servers each CLI would load for an
 * account + project folder. Only local config files are parsed: no CLI is spawned and no model
 * is called. Anything missing yields an empty list; anything malformed is skipped and counted.
 *
 *   claude  <dir>/skills, <dir>/commands, enabled plugins, project .claude/{skills,commands};
 *           MCP from .claude.json (user + this project), project .mcp.json, enabled plugins
 *   codex   $CODEX_HOME/skills (.system = built-in), ~/.agents/skills, project .agents/skills,
 *           enabled plugins; MCP from config.toml [mcp_servers], project .codex/config.toml, plugins
 *   agy     ~/.gemini/config/skills, built-in skills, plugins, project .agents/skills;
 *           MCP from ~/.gemini/config/mcp_config.json and plugins
 */

interface Ctx {
  errors: number
}

// ---- small readers ---------------------------------------------------------------------

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}
const list = (dir: string): string[] => {
  try {
    return readdirSync(dir).filter((n) => n !== '.DS_Store')
  } catch {
    return []
  }
}

/** Parsed JSON, null when missing or empty; malformed files count as errors. */
function readJson(p: string, ctx: Ctx): any {
  let text: string
  try {
    text = readFileSync(p, 'utf8')
  } catch {
    return null
  }
  if (!text.trim()) return null
  try {
    return JSON.parse(text)
  } catch {
    ctx.errors++
    return null
  }
}

function readToml(p: string, ctx: Ctx): Record<string, any> | null {
  let text: string
  try {
    text = readFileSync(p, 'utf8')
  } catch {
    return null
  }
  if (!text.trim()) return null
  try {
    return parseToml(text) as Record<string, any>
  } catch {
    ctx.errors++
    return null
  }
}

/** First 16 KB: frontmatter always sits at the top. */
function readHead(p: string): string {
  let fd: number | null = null
  try {
    fd = openSync(p, 'r')
    const buf = Buffer.alloc(16 * 1024)
    const n = readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, n).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

const unquote = (v: string): string => {
  const s = v.trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    const inner = s.slice(1, -1)
    return s[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\n/g, ' ') : inner.replace(/''/g, "'")
  }
  return s
}

/**
 * Minimal YAML frontmatter reader for top-level scalar keys: plain / quoted values, folded and
 * literal block scalars (`>`, `>-`, `|`, `|-`) and indented continuation lines. Enough for
 * `name`, `description` and `user-invocable`.
 */
export function parseFrontmatter(text: string): Record<string, string> {
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  if (!src.startsWith('---\n')) return {}
  const end = src.indexOf('\n---', 4)
  if (end < 0) return {}
  const lines = src.slice(4, end).split('\n')
  const out: Record<string, string> = {}
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(lines[i])
    if (!m) continue
    const key = m[1]
    const rest = (m[2] ?? '').replace(/\s+#.*$/, '').trim()
    const cont: string[] = []
    while (i + 1 < lines.length && (lines[i + 1].trim() === '' || /^\s/.test(lines[i + 1]))) cont.push(lines[++i])
    const body = cont.map((l) => l.trim())
    let value: string
    if (/^[>|][+-]?$/.test(rest)) value = rest[0] === '|' ? body.join('\n').trim() : body.filter(Boolean).join(' ')
    else value = [unquote(rest), ...body.filter((l) => l && !l.startsWith('- '))].filter(Boolean).join(' ')
    out[key] = value.replace(/[ \t]+/g, ' ').trim()
  }
  return out
}

const shortDesc = (d: string | undefined): string => (d ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)

// ---- skills ----------------------------------------------------------------------------

type Push = (name: string, description: string, source: ExtSource, extra?: { plugin?: string; kind?: 'skill' | 'command' }) => void

/** `<dir>/<name>/SKILL.md`; dirs without one are searched one level deeper (e.g. Codex `.system`). */
function scanSkillDir(dir: string, push: Push, source: ExtSource, opts: { plugin?: string; depth?: number; skip?: (p: string) => boolean; sourceOf?: (sub: string) => ExtSource } = {}): void {
  for (const n of list(dir)) {
    const sub = join(dir, n)
    if (!isDir(sub)) continue
    const md = join(sub, 'SKILL.md')
    if (isFile(md)) {
      if (opts.skip?.(md)) continue
      const fm = parseFrontmatter(readHead(md))
      if (fm['user-invocable'] === 'false') continue
      push(fm.name || n, shortDesc(fm.description), opts.sourceOf?.(n) ?? source, { plugin: opts.plugin })
    } else if ((opts.depth ?? 1) > 0) {
      scanSkillDir(sub, push, opts.sourceOf?.(n) ?? source, { ...opts, depth: (opts.depth ?? 1) - 1, sourceOf: undefined })
    }
  }
}

/** Claude custom commands: `<dir>/**\/<name>.md`, the file name is the command. */
function scanCommandDir(dir: string, push: Push, source: ExtSource, plugin?: string, depth = 3): void {
  for (const n of list(dir)) {
    const p = join(dir, n)
    if (n.endsWith('.md') && isFile(p)) {
      const fm = parseFrontmatter(readHead(p))
      push(n.slice(0, -3), shortDesc(fm.description), source, { plugin, kind: 'command' })
    } else if (depth > 0 && isDir(p)) scanCommandDir(p, push, source, plugin, depth - 1)
  }
}

/** Project folders from `cwd` up to its git root (inclusive), never the home folder itself. */
function projectChain(cwd: string | null): string[] {
  if (!cwd || !isDir(cwd)) return []
  const out: string[] = []
  let d = resolve(cwd)
  for (let i = 0; i < 16; i++) {
    if (d === realHome || d === dirname(d)) break
    out.push(d)
    if (existsSync(join(d, '.git'))) break
    d = dirname(d)
  }
  // no git root found: only the project folder itself counts
  return out.length && existsSync(join(out[out.length - 1], '.git')) ? out : out.slice(0, 1)
}

const relPaths = (base: string, v: unknown, def: string): string[] => {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? [v] : []
  const paths = arr.filter((x): x is string => typeof x === 'string').map((x) => (isAbsolute(x) ? x : join(base, x)))
  return [...new Set([join(base, def), ...paths])]
}

// ---- MCP helpers ------------------------------------------------------------------------

function transportOf(v: any): McpTransport {
  const t = String(v?.type ?? v?.transport ?? '').toLowerCase()
  if (t.includes('sse')) return 'sse'
  if (t.includes('http')) return 'http'
  if (t === 'stdio') return 'stdio'
  if (v?.command) return 'stdio'
  if (v?.url || v?.serverUrl || v?.httpUrl) return 'http'
  return 'stdio'
}

/** `{ mcpServers: {...} }` or a bare map. */
const serverMap = (j: any): Record<string, any> => {
  const m = j && typeof j === 'object' ? (j.mcpServers && typeof j.mcpServers === 'object' ? j.mcpServers : j) : {}
  return Object.fromEntries(Object.entries(m).filter(([, v]) => v && typeof v === 'object'))
}

// ---- per CLI ------------------------------------------------------------------------------

interface Scan {
  skills: SkillItem[]
  mcp: McpServer[]
  configDir: string
  remoteNote: boolean
}

/**
 * Collects skills in priority order (first push of a name wins).
 * `display`: the name as the CLI shows it; `trigger`: the prompt token that invokes it.
 */
function collector(display: (name: string, plugin?: string) => string, trigger: (shown: string) => string) {
  const skills: SkillItem[] = []
  const seen = new Set<string>()
  const push: Push = (name, description, source, extra = {}) => {
    const shown = display(name, extra.plugin)
    if (!shown || seen.has(shown)) return
    seen.add(shown)
    skills.push({ name: shown, description, source, plugin: extra.plugin, kind: extra.kind ?? 'skill', insert: trigger(shown) })
  }
  return { skills, push }
}

function scanClaude(dir: string, cwd: string | null, ctx: Ctx): Scan {
  // plugin skills are namespaced: /plugin:skill
  const { skills, push } = collector(
    (name, plugin) => (plugin ? `${plugin}:${name}` : name),
    (n) => `/${n}`
  )
  const chain = projectChain(cwd)
  const root = cwd ? resolve(cwd) : null

  for (const p of chain) {
    scanSkillDir(join(p, '.claude', 'skills'), push, 'project')
    scanCommandDir(join(p, '.claude', 'commands'), push, 'project')
  }
  scanSkillDir(join(dir, 'skills'), push, 'global')
  scanCommandDir(join(dir, 'commands'), push, 'global')

  // plugins: installed + enabled (user settings, then project settings override)
  const settings = readJson(join(dir, 'settings.json'), ctx) ?? {}
  const projSettings = chain.length ? [readJson(join(chain[0], '.claude', 'settings.json'), ctx) ?? {}, readJson(join(chain[0], '.claude', 'settings.local.json'), ctx) ?? {}] : []
  const enabled: Record<string, unknown> = Object.assign({}, settings.enabledPlugins, ...projSettings.map((s) => s.enabledPlugins))
  const installed = readJson(join(dir, 'plugins', 'installed_plugins.json'), ctx)?.plugins ?? {}
  const plugins: { name: string; path: string; manifest: any }[] = []
  for (const [key, entries] of Object.entries<any>(installed)) {
    if (enabled[key] !== true || !Array.isArray(entries)) continue
    const entry = entries.find((e) => e?.scope === 'user' || !e?.scope) ?? entries.find((e) => root && e?.projectPath && resolve(String(e.projectPath)) === (chain[chain.length - 1] ?? root))
    const path = entry?.installPath
    if (typeof path !== 'string' || !isDir(path)) continue
    const manifest = readJson(join(path, '.claude-plugin', 'plugin.json'), ctx) ?? {}
    plugins.push({ name: String(manifest.name || key.split('@')[0]), path, manifest })
  }
  for (const pl of plugins) {
    for (const d of relPaths(pl.path, pl.manifest.skills, 'skills')) scanSkillDir(d, push, 'plugin', { plugin: pl.name })
    for (const d of relPaths(pl.path, pl.manifest.commands, 'commands')) scanCommandDir(d, push, 'plugin', pl.name)
  }

  // MCP
  const mcp: McpServer[] = []
  const globalFile = dir === join(realHome, '.claude') ? join(realHome, '.claude.json') : join(dir, '.claude.json')
  const g = readJson(globalFile, ctx) ?? {}
  const proj = (root && g.projects?.[root]) || {}
  const off = new Set<string>(Array.isArray(proj.disabledMcpServers) ? proj.disabledMcpServers : [])
  const add = (name: string, v: any, source: ExtSource, state: McpState, extra: Partial<McpServer> = {}) =>
    mcp.push({ name, source, transport: transportOf(v), state: off.has(name) ? 'off' : state, ...extra })
  for (const [n, v] of Object.entries(serverMap(readJson('/Library/Application Support/ClaudeCode/managed-mcp.json', ctx)))) add(n, v, 'global', 'on', { managed: true })
  for (const [n, v] of Object.entries(serverMap(g))) add(n, v, 'global', v.disabled ? 'off' : 'on')
  for (const [n, v] of Object.entries(serverMap(proj))) add(n, v, 'project', v.disabled ? 'off' : 'on', { local: true })
  const mcpJsonDir = chain.find((p) => isFile(join(p, '.mcp.json')))
  if (mcpJsonDir) {
    const allSettings = [settings, ...projSettings, proj]
    const approvedAll = allSettings.some((s) => s?.enableAllProjectMcpServers === true)
    const approved = new Set<string>(allSettings.flatMap((s) => (Array.isArray(s?.enabledMcpjsonServers) ? s.enabledMcpjsonServers : [])))
    const rejected = new Set<string>(allSettings.flatMap((s) => (Array.isArray(s?.disabledMcpjsonServers) ? s.disabledMcpjsonServers : [])))
    for (const [n, v] of Object.entries(serverMap(readJson(join(mcpJsonDir, '.mcp.json'), ctx)))) add(n, v, 'project', rejected.has(n) ? 'off' : approvedAll || approved.has(n) ? 'on' : 'pending')
  }
  for (const pl of plugins) {
    const files = [join(pl.path, '.mcp.json')]
    const m = pl.manifest.mcpServers
    if (typeof m === 'string') files.push(isAbsolute(m) ? m : join(pl.path, m))
    else if (m && typeof m === 'object') for (const [n, v] of Object.entries(serverMap(m))) add(n, v, 'plugin', 'on', { plugin: pl.name })
    for (const f of files) for (const [n, v] of Object.entries(serverMap(readJson(f, ctx)))) add(n, v, 'plugin', 'on', { plugin: pl.name })
  }
  return { skills, mcp, configDir: dir, remoteNote: g.claudeAiMcpEverConnected === true }
}

/** Newest version folder of a cached Codex plugin. */
function newestDir(base: string): string | null {
  let best: { p: string; t: number } | null = null
  for (const n of list(base)) {
    const p = join(base, n)
    if (!isFile(join(p, '.codex-plugin', 'plugin.json'))) continue
    let t = 0
    try {
      t = statSync(p).mtimeMs
    } catch {
      /* keep 0 */
    }
    if (!best || t > best.t) best = { p, t }
  }
  return best?.p ?? null
}

function scanCodex(dir: string, cwd: string | null, ctx: Ctx): Scan {
  // Codex triggers a skill when the prompt names it as `$name` (works in `codex exec`)
  const { skills, push } = collector(
    (name) => name,
    (n) => `$${n}`
  )
  const chain = projectChain(cwd)
  const cfg = readToml(join(dir, 'config.toml'), ctx) ?? {}
  const disabled = new Set<string>(
    (Array.isArray(cfg.skills?.config) ? cfg.skills.config : []).filter((c: any) => c?.enabled === false && typeof c.path === 'string').map((c: any) => resolve(expandHome(c.path)))
  )
  const skip = (md: string) => disabled.has(resolve(md)) || disabled.has(resolve(dirname(md)))
  for (const p of chain) scanSkillDir(join(p, '.agents', 'skills'), push, 'project', { skip })
  scanSkillDir(join(dir, 'skills'), push, 'global', { skip, sourceOf: (n) => (n === '.system' ? 'builtin' : 'global') })
  scanSkillDir(join(realHome, '.agents', 'skills'), push, 'global', { skip })

  const mcp: McpServer[] = []
  const add = (name: string, v: any, source: ExtSource, extra: Partial<McpServer> = {}) =>
    mcp.push({ name, source, transport: transportOf(v), state: v?.enabled === false || v?.disabled === true ? 'off' : 'on', ...extra })

  for (const [key, v] of Object.entries<any>(cfg.plugins ?? {})) {
    if (v?.enabled !== true) continue
    const [name, market] = key.split('@')
    if (!name || !market) continue
    const path = newestDir(join(dir, 'plugins', 'cache', market, name))
    if (!path) continue
    const manifest = readJson(join(path, '.codex-plugin', 'plugin.json'), ctx) ?? {}
    for (const d of relPaths(path, manifest.skills, 'skills')) scanSkillDir(d, push, 'plugin', { plugin: name, skip })
    const m = manifest.mcpServers
    const files = typeof m === 'string' ? [isAbsolute(m) ? m : join(path, m)] : [join(path, '.mcp.json')]
    if (m && typeof m === 'object') for (const [n, s] of Object.entries(serverMap(m))) add(n, s, 'plugin', { plugin: name })
    for (const f of files) for (const [n, s] of Object.entries(serverMap(readJson(f, ctx)))) add(n, s, 'plugin', { plugin: name })
  }
  for (const [n, v] of Object.entries<any>(cfg.mcp_servers ?? {})) if (v && typeof v === 'object') add(n, v, 'global')
  for (const p of chain) {
    const pc = readToml(join(p, '.codex', 'config.toml'), ctx)
    for (const [n, v] of Object.entries<any>(pc?.mcp_servers ?? {})) if (v && typeof v === 'object') add(n, v, 'project')
  }
  // project / global / plugin order in the list
  const rank: Record<ExtSource, number> = { project: 0, global: 1, plugin: 2, builtin: 3 }
  mcp.sort((a, b) => rank[a.source] - rank[b.source])
  return { skills, mcp, configDir: dir, remoteNote: false }
}

const AGY_ROOTS = ['.agents', '.agent', '_agents', '_agent']
const AGY_MANIFESTS = ['plugin.json', '.antigravity-plugin/plugin.json', '.gemini-plugin/plugin.json']

function scanAgy(home: string, cwd: string | null, ctx: Ctx): Scan {
  const { skills, push } = collector(
    (name) => name,
    (n) => `/${n}`
  )
  const chain = projectChain(cwd)
  const g = join(home, '.gemini')
  const mcp: McpServer[] = []
  const add = (name: string, v: any, source: ExtSource, extra: Partial<McpServer> = {}) =>
    mcp.push({ name, source, transport: transportOf(v), state: v?.disabled === true || v?.enabled === false ? 'off' : 'on', ...extra })

  const plugins: { name: string; path: string }[] = []
  const findPlugins = (dir: string) => {
    for (const n of list(dir)) {
      const p = join(dir, n)
      const mf = AGY_MANIFESTS.map((m) => join(p, m)).find(isFile)
      if (!mf) continue
      const manifest = readJson(mf, ctx) ?? {}
      if (manifest.enabled === false) continue
      plugins.push({ name: String(manifest.name || n), path: p })
    }
  }
  for (const p of chain)
    for (const r of AGY_ROOTS) {
      scanSkillDir(join(p, r, 'skills'), push, 'project')
      findPlugins(join(p, r, 'plugins'))
    }
  scanSkillDir(join(g, 'config', 'skills'), push, 'global')
  findPlugins(join(g, 'config', 'plugins'))
  for (const pl of plugins) {
    scanSkillDir(join(pl.path, 'skills'), push, 'plugin', { plugin: pl.name })
    for (const [n, v] of Object.entries(serverMap(readJson(join(pl.path, 'mcp_config.json'), ctx)))) add(n, v, 'plugin', { plugin: pl.name })
  }
  scanSkillDir(join(g, 'antigravity-cli', 'builtin', 'skills'), push, 'builtin')
  for (const [n, v] of Object.entries(serverMap(readJson(join(g, 'config', 'mcp_config.json'), ctx)))) add(n, v, 'global')
  mcp.sort((a, b) => Number(a.source === 'plugin') - Number(b.source === 'plugin'))
  return { skills, mcp, configDir: g, remoteNote: false }
}

// ---- public -------------------------------------------------------------------------------

const cache = new Map<string, { at: number; scan: Scan; errors: number }>()
const TTL = 15_000

function scan(id: ProfileId, cwd: string | null, refresh: boolean): { scan: Scan; errors: number } {
  const cfg = getConfig(id)
  const dir = expandHome(cfg.configDir)
  const key = `${id}|${dir}|${cwd ?? ''}`
  const hit = cache.get(key)
  if (hit && !refresh && Date.now() - hit.at < TTL) return hit
  const ctx: Ctx = { errors: 0 }
  let result: Scan
  try {
    result = cfg.kind === 'claude' ? scanClaude(dir, cwd, ctx) : cfg.kind === 'codex' ? scanCodex(dir, cwd, ctx) : scanAgy(dir, cwd, ctx)
  } catch (e) {
    console.warn('[extensions] scan failed', e)
    result = { skills: [], mcp: [], configDir: dir, remoteNote: false }
    ctx.errors++
  }
  const entry = { at: Date.now(), scan: result, errors: ctx.errors }
  cache.set(key, entry)
  return entry
}

const tilde = (p: string): string => (p === realHome ? '~' : p.startsWith(realHome + '/') ? '~' + p.slice(realHome.length) : p)

const SOURCE_RANK: Record<ExtSource, number> = { project: 0, global: 1, plugin: 2, builtin: 3 }

export function listSkills(id: ProfileId, cwd: string | null, refresh = false): SkillList {
  const { scan: s, errors } = scan(id, cwd, refresh)
  const items = [...s.skills].sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || a.name.localeCompare(b.name))
  return { items, errors }
}

export function listMcp(id: ProfileId, cwd: string | null, refresh = false): McpList {
  const { scan: s, errors } = scan(id, cwd, refresh)
  return { servers: s.mcp, configDir: tilde(s.configDir), project: cwd ? tilde(cwd) : null, errors, remoteNote: s.remoteNote }
}
