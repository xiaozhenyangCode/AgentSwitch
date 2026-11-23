import { t } from './i18n'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type {
  AgentItem,
  ExtFileText,
  ExtOverview,
  ExtSource,
  HookItem,
  McpList,
  McpServer,
  McpState,
  McpTransport,
  PluginItem,
  ProfileId,
  RuleFile,
  RuleScope,
  RuleTarget,
  SkillItem,
  SkillList
} from '@shared/types'
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
 *
 * The extensions panel adds agents (subagent definitions), rules (instruction files the CLI
 * loads) and hooks, plus every installed plugin with what it contributes. Disabled plugins are
 * listed there only: their contents never count as in effect.
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

type Push = (name: string, description: string, source: ExtSource, extra?: { plugin?: string; kind?: 'skill' | 'command'; path?: string }) => void

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
      push(fm.name || n, shortDesc(fm.description), opts.sourceOf?.(n) ?? source, { plugin: opts.plugin, path: md })
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
      push(n.slice(0, -3), shortDesc(fm.description), source, { plugin, kind: 'command', path: p })
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

/** Safe, redacted config details for an MCP server entry (no secret values). */
function mcpDetails(v: any, configPath?: string): Partial<McpServer> {
  const out: Partial<McpServer> = {}
  if (typeof v?.command === 'string' && v.command.trim()) {
    const args = Array.isArray(v.args) ? v.args.map((a: unknown) => String(a)) : []
    out.command = redactCommand([v.command, ...args].join(' '))
  } else if (Array.isArray(v?.command) && v.command.length) {
    out.command = redactCommand(v.command.map((a: unknown) => String(a)).join(' '))
  }
  const rawUrl = v?.url ?? v?.serverUrl ?? v?.httpUrl
  if (typeof rawUrl === 'string' && rawUrl.trim()) {
    out.url = redactCommand(rawUrl.trim())
  }
  if (typeof v?.cwd === 'string' && v.cwd.trim()) out.cwd = v.cwd.trim()
  if (v?.env && typeof v.env === 'object' && !Array.isArray(v.env)) {
    const keys = Object.keys(v.env)
    if (keys.length) out.envKeys = keys
  }
  if (v?.headers && typeof v.headers === 'object' && !Array.isArray(v.headers)) {
    const keys = Object.keys(v.headers)
    if (keys.length) out.headerKeys = keys
  }
  if (configPath && isFile(configPath)) {
    allow(configPath)
    out.configPath = configPath
  }
  return out
}

// ---- per CLI ------------------------------------------------------------------------------

interface Scan {
  skills: SkillItem[]
  mcp: McpServer[]
  agents: AgentItem[]
  plugins: PluginItem[]
  rules: RuleFile[]
  hooks: HookItem[]
  configDir: string
  remoteNote: boolean
  agentsDynamic: boolean
}

const emptyScan = (dir: string): Scan => ({ skills: [], mcp: [], agents: [], plugins: [], rules: [], hooks: [], configDir: dir, remoteNote: false, agentsDynamic: false })

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
    if (extra.path) allow(extra.path)
    skills.push({ name: shown, description, source, plugin: extra.plugin, kind: extra.kind ?? 'skill', insert: trigger(shown), ...(extra.path ? { path: extra.path } : {}) })
  }
  return { skills, push }
}

/** Records names only (what a plugin contains, enabled or not). */
const namesOf =
  (out: string[], forward?: Push): Push =>
  (name, description, source, extra) => {
    out.push(name)
    forward?.(name, description, source, extra)
  }

// ---- files the renderer may preview / reveal ----------------------------------------------

/** Only files a scan listed can be read or revealed (never an arbitrary path). */
const allowed = new Set<string>()
const allow = (p: string): void => {
  if (allowed.size > 50_000) allowed.clear()
  allowed.add(resolve(p))
}

/** Only global/project rule files (scanned or explicitly prepared) may be written from the UI. */
const editableRules = new Set<string>()
const allowWriteRule = (p: string): void => {
  if (editableRules.size > 5_000) editableRules.clear()
  editableRules.add(resolve(p))
}

const PREVIEW_MAX = 64 * 1024
const RULE_WRITE_MAX = 512 * 1024

export function readExtFile(path: string): ExtFileText {
  const p = resolve(path)
  if (!allowed.has(p) || !isFile(p)) throw new Error('not available')
  const bytes = statSync(p).size
  let fd: number | null = null
  try {
    fd = openSync(p, 'r')
    const buf = Buffer.alloc(Math.min(bytes, PREVIEW_MAX))
    const n = readSync(fd, buf, 0, buf.length, 0)
    return { text: buf.subarray(0, n).toString('utf8'), bytes, truncated: bytes > PREVIEW_MAX }
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

export const canRevealExtFile = (path: string): boolean => allowed.has(resolve(path)) && existsSync(resolve(path))

/** Resolves and allow-lists the canonical global or project rule file for an account. */
export function prepareRuleTarget(id: ProfileId, cwd: string | null, scope: 'global' | 'project'): RuleTarget {
  const cfg = getConfig(id)
  if (cfg.kind === 'reasonix') throw new Error(t('reasonix.extensionsUnavailable'))
  const dir = expandHome(cfg.configDir)
  let target: string
  if (scope === 'project') {
    if (!cwd || !isDir(cwd)) throw new Error('no project directory')
    const root = resolve(cwd)
    if (cfg.kind === 'claude') target = join(root, 'CLAUDE.md')
    else if (cfg.kind === 'codex') target = isFile(join(root, 'AGENTS.override.md')) ? join(root, 'AGENTS.override.md') : join(root, 'AGENTS.md')
    else target = join(root, 'GEMINI.md')
  } else {
    if (cfg.kind === 'claude') target = join(dir, 'CLAUDE.md')
    else if (cfg.kind === 'codex') target = isFile(join(dir, 'AGENTS.override.md')) ? join(dir, 'AGENTS.override.md') : join(dir, 'AGENTS.md')
    else target = join(dir, '.gemini', 'GEMINI.md')
  }
  const p = resolve(target)
  allowWriteRule(p)
  const exists = isFile(p)
  if (exists) allow(p)
  return { path: p, display: tilde(p), exists }
}

/** Saves an allow-listed global or project rule file and invalidates the scan cache. */
export function writeRuleFile(path: string, content: string): { bytes: number; lines: number } {
  const p = resolve(path)
  if (!editableRules.has(p)) throw new Error('not editable')
  if (Buffer.byteLength(content, 'utf8') > RULE_WRITE_MAX) throw new Error('rule file too large')
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content, 'utf8')
  allow(p)
  cache.clear()
  const bytes = Buffer.byteLength(content, 'utf8')
  const lines = content ? content.split('\n').length - (content.endsWith('\n') ? 1 : 0) : 0
  return { bytes, lines }
}

// ---- shared parsing ---------------------------------------------------------------------------

/** `<dir>/**\/*.md` (a few levels deep). */
function mdFiles(dir: string, depth = 2): string[] {
  const out: string[] = []
  for (const n of list(dir).sort()) {
    const p = join(dir, n)
    if (n.endsWith('.md') && isFile(p)) out.push(p)
    else if (depth > 0 && isDir(p)) out.push(...mdFiles(p, depth - 1))
  }
  return out
}

/** Files or folders named in a manifest field, plus a default folder. */
const manifestPaths = (base: string, v: unknown, def: string | null): string[] => {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? [v] : []
  const paths = arr.filter((x): x is string => typeof x === 'string').map((x) => (isAbsolute(x) ? x : join(base, x)))
  return [...new Set([...(def ? [join(base, def)] : []), ...paths])]
}

function agentFromMd(p: string, source: ExtSource, plugin?: string): AgentItem {
  const fm = parseFrontmatter(readHead(p))
  allow(p)
  return {
    name: fm.name || basename(p, '.md'),
    description: shortDesc(fm.description),
    source,
    ...(plugin ? { plugin } : {}),
    model: fm.model || null,
    tools: fm.tools ? fm.tools.slice(0, 200) : null,
    path: p
  }
}

/** Claude agent definitions in folders or listed files. */
function claudeAgents(paths: string[], source: ExtSource, plugin?: string): AgentItem[] {
  const out: AgentItem[] = []
  for (const p of paths) {
    if (isFile(p) && p.endsWith('.md')) out.push(agentFromMd(p, source, plugin))
    else for (const f of mdFiles(p)) out.push(agentFromMd(f, source, plugin))
  }
  return out
}

function ruleFile(p: string, scope: RuleScope, extra: Partial<RuleFile> = {}): RuleFile | null {
  let bytes = 0
  try {
    const st = statSync(p)
    if (!st.isFile()) return null
    bytes = st.size
  } catch {
    return null
  }
  let lines = 0
  if (bytes) {
    try {
      const text = bytes > 2 * 1024 * 1024 ? readHead(p) : readFileSync(p, 'utf8')
      lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
    } catch {
      /* unreadable: size only */
    }
  }
  allow(p)
  if (scope === 'global' || scope === 'project') allowWriteRule(p)
  return { path: p, display: tilde(p), scope, bytes, lines, ...extra }
}

const realKey = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

/**
 * Claude memory imports: `@path` lines (outside code fences) are loaded too. One level is
 * expanded; files already listed (or importing each other) appear once.
 */
function claudeImports(rule: RuleFile, seen: Set<string>): RuleFile[] {
  if (!rule.bytes || rule.bytes > 512 * 1024) return []
  let text = ''
  try {
    text = readFileSync(rule.path, 'utf8')
  } catch {
    return []
  }
  const out: RuleFile[] = []
  let fence = false
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence
    if (fence) continue
    for (const m of line.matchAll(/(?:^|\s)@((?:~\/|\.{1,2}\/|\/)?[\w.\-/]+)/g)) {
      const ref = m[1]
      if (!/[./]/.test(ref) || ref.endsWith('.')) continue // `@someone` is not a path
      const p = ref.startsWith('~/') ? join(realHome, ref.slice(2)) : isAbsolute(ref) ? ref : join(dirname(rule.path), ref)
      const key = realKey(p)
      if (seen.has(key)) continue
      const r = ruleFile(p, rule.scope, { importedBy: basename(rule.path) })
      if (!r) continue
      seen.add(key)
      out.push(r)
    }
  }
  return out
}

/** Adds rule files once each (symlinks to the same file count once). */
function ruleList() {
  const rules: RuleFile[] = []
  const seen = new Set<string>()
  const add = (p: string, scope: RuleScope, extra: Partial<RuleFile> = {}): RuleFile | null => {
    const key = realKey(p)
    if (seen.has(key)) return null
    const r = ruleFile(p, scope, extra)
    if (!r) return null
    seen.add(key)
    rules.push(r)
    return r
  }
  return { rules, seen, add }
}

// ---- hooks ----------------------------------------------------------------------------------

const SECRETISH = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_\-+/=]{24,}$/

/** A command line made safe to show: env assignments, tokens and URL queries are masked. */
export function redactCommand(cmd: string): string {
  return cmd
    .replace(/\s+/g, ' ')
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g, '$1=•••')
    .replace(/(--?[\w-]*(?:token|key|secret|password|auth)[\w-]*)(=|\s+)\S+/gi, '$1$2•••')
    .replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 •••')
    .replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, '$1')
    .split(' ')
    .map((w) => (SECRETISH.test(w.replace(/^["']|["']$/g, '')) ? '•••' : w))
    .join(' ')
    .trim()
}

const SCRIPT = /[\w.@~${}\-/]*?([\w.-]+\.(?:m?js|cjs|ts|sh|bash|zsh|py|rb|pl))\b/g

/** Short label for a hook command: the script it runs, else the redacted command (60 chars). */
export function commandSummary(cmd: string): string {
  const scripts = [...cmd.matchAll(SCRIPT)].map((m) => m[1])
  if (scripts.length) {
    const runner = /^\s*(node|bun|deno|python3?|bash|sh|zsh|ruby|npx|tsx)\b/.exec(cmd)?.[1]
    const script = scripts[scripts.length - 1]
    return runner && !cmd.includes('||') ? `${runner} ${script}` : script
  }
  const r = redactCommand(cmd)
  return r.length > 60 ? r.slice(0, 59) + '…' : r
}

function handlerSummary(h: any): { type: string; summary: string } {
  const type = String(h?.type ?? (h?.command ? 'command' : 'unknown'))
  if (type === 'mcp_tool') return { type, summary: [h.server, h.tool].filter(Boolean).join(' · ') || 'mcp_tool' }
  if (type === 'http' || h?.url) return { type, summary: String(h.url ?? '').replace(/^(https?:\/\/[^/?#]+).*$/, '$1') }
  if (type === 'prompt' || type === 'agent') return { type, summary: redactCommand(String(h.prompt ?? '')).slice(0, 60) }
  if (typeof h?.command === 'string') return { type, summary: commandSummary(h.command) }
  if (Array.isArray(h?.command)) return { type, summary: commandSummary(h.command.join(' ')) }
  return { type, summary: type }
}

/** A handler list: grouped `[{ matcher, hooks: [...] }]` or flat `[handler, ...]`. */
function eventHandlers(event: string, arr: unknown, base: Omit<HookItem, 'event' | 'type' | 'summary'>): HookItem[] {
  if (!Array.isArray(arr)) return []
  const out: HookItem[] = []
  for (const g of arr) {
    if (!g || typeof g !== 'object') continue
    const group = g as any
    const handlers = Array.isArray(group.hooks) ? group.hooks : [group]
    const matcher = typeof group.matcher === 'string' && group.matcher && group.matcher !== '*' ? group.matcher : undefined
    for (const h of handlers) if (h && typeof h === 'object') out.push({ event, ...(matcher ? { matcher } : {}), ...base, ...handlerSummary(h) })
  }
  return out
}

/** Claude / Codex shape: `{ hooks: { Event: [...] } }` or the bare event map. */
function eventMapHooks(j: any, base: Omit<HookItem, 'event' | 'type' | 'summary'>): HookItem[] {
  const map = j && typeof j === 'object' ? (j.hooks && typeof j.hooks === 'object' && !Array.isArray(j.hooks) ? j.hooks : j) : null
  if (!map) return []
  return Object.entries(map).flatMap(([event, arr]) => (/^[A-Z]/.test(event) ? eventHandlers(event, arr, base) : []))
}

/**
 * agy shape: named hooks `{ name: { enabled?, SessionStart: [...], PreToolUse: [...], ... } }`
 * (SessionStart / PreToolUse / PostToolUse / PreInvocation / PostInvocation / Stop).
 */
function agyHooks(j: any, base: Omit<HookItem, 'event' | 'type' | 'summary'>): HookItem[] {
  if (!j || typeof j !== 'object') return []
  const out: HookItem[] = []
  for (const [name, spec] of Object.entries<any>(j)) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) continue
    const off = spec.enabled === false
    for (const [event, arr] of Object.entries(spec)) {
      if (event === 'enabled' || !/^[A-Z]/.test(event)) continue
      out.push(...eventHandlers(event, arr, { ...base, name, ...(off ? { off: true } : {}) }))
    }
  }
  return out
}

/** Hook handlers a plugin manifest field / hooks file declares (Claude & Codex plugins). */
function pluginHooks(path: string, field: unknown, ctx: Ctx, base: Omit<HookItem, 'event' | 'type' | 'summary'>): HookItem[] {
  const out: HookItem[] = []
  if (field && typeof field === 'object' && !Array.isArray(field)) out.push(...eventMapHooks(field, base))
  for (const f of manifestPaths(path, typeof field === 'object' ? null : field, 'hooks/hooks.json')) if (f.endsWith('.json')) out.push(...eventMapHooks(readJson(f, ctx), { ...base, file: tilde(f) }))
  return out
}

const hookLabel = (h: HookItem): string => (h.matcher ? `${h.event} · ${h.matcher}` : h.event)

// ---- Claude ---------------------------------------------------------------------------------

const MANAGED = '/Library/Application Support/ClaudeCode'

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

  // plugins: installed; enabled by user settings, then project settings override
  const settings = readJson(join(dir, 'settings.json'), ctx) ?? {}
  const projFiles = chain.length ? [join(chain[0], '.claude', 'settings.json'), join(chain[0], '.claude', 'settings.local.json')] : []
  const projSettings = projFiles.map((f) => readJson(f, ctx) ?? {})
  const managed = readJson(join(MANAGED, 'managed-settings.json'), ctx) ?? {}
  const enabled: Record<string, unknown> = Object.assign({}, settings.enabledPlugins, ...projSettings.map((s) => s.enabledPlugins))
  const installed = readJson(join(dir, 'plugins', 'installed_plugins.json'), ctx)?.plugins ?? {}
  const plugins: PluginItem[] = []
  const active: { name: string; path: string; manifest: any }[] = []
  for (const [key, entries] of Object.entries<any>(installed)) {
    if (!Array.isArray(entries)) continue
    const entry = entries.find((e) => e?.scope === 'user' || !e?.scope) ?? entries.find((e) => root && e?.projectPath && resolve(String(e.projectPath)) === (chain[chain.length - 1] ?? root))
    const path = entry?.installPath
    if (typeof path !== 'string' || !isDir(path)) continue
    const manifest = readJson(join(path, '.claude-plugin', 'plugin.json'), ctx) ?? {}
    const name = String(manifest.name || key.split('@')[0])
    const on = enabled[key] === true
    const item: PluginItem = {
      name,
      key,
      version: String(entry.version ?? manifest.version ?? '') || null,
      description: shortDesc(manifest.description),
      enabled: on,
      source: entry?.scope === 'project' || entry?.scope === 'local' ? 'project' : 'global',
      marketplace: key.split('@')[1] ?? null,
      skills: [],
      agents: [],
      mcp: [],
      hooks: [],
      rules: [],
      path: tilde(path)
    }
    // contents are listed for every plugin; only enabled ones feed the lists below
    for (const d of relPaths(path, manifest.skills, 'skills')) scanSkillDir(d, namesOf(item.skills, on ? push : undefined), 'plugin', { plugin: name })
    for (const d of relPaths(path, manifest.commands, 'commands')) scanCommandDir(d, namesOf(item.skills, on ? push : undefined), 'plugin', name)
    item.agents = claudeAgents(manifestPaths(path, manifest.agents, 'agents'), 'plugin', name).map((a) => a.name)
    item.hooks = pluginHooks(path, manifest.hooks, ctx, { source: 'plugin', plugin: name, file: tilde(join(path, '.claude-plugin', 'plugin.json')) }).map(hookLabel)
    const files = [join(path, '.mcp.json')]
    const m = manifest.mcpServers
    if (typeof m === 'string') files.push(isAbsolute(m) ? m : join(path, m))
    item.mcp = [...new Set([...(m && typeof m === 'object' ? Object.keys(serverMap(m)) : []), ...files.flatMap((f) => Object.keys(serverMap(readJson(f, ctx))))])]
    plugins.push(item)
    if (on) active.push({ name, path, manifest })
  }

  // agents: project, then user, then plugins (first name wins, like skills)
  const agents: AgentItem[] = []
  const agentNames = new Set<string>()
  const addAgents = (list: AgentItem[]) => {
    for (const a of list) {
      const key = a.plugin ? `${a.plugin}:${a.name}` : a.name
      if (agentNames.has(key)) continue
      agentNames.add(key)
      agents.push(a)
    }
  }
  for (const p of chain) addAgents(claudeAgents([join(p, '.claude', 'agents')], 'project'))
  addAgents(claudeAgents([join(dir, 'agents')], 'global'))
  for (const pl of active) addAgents(claudeAgents(manifestPaths(pl.path, pl.manifest.agents, 'agents'), 'plugin', pl.name))

  // rules: managed, user, then project files from the repo root down to the folder
  const { rules, seen, add } = ruleList()
  add(join(MANAGED, 'CLAUDE.md'), 'managed')
  add(join(dir, 'CLAUDE.md'), 'global')
  for (const f of mdFiles(join(dir, 'rules'))) add(f, 'global')
  for (const p of [...chain].reverse()) {
    for (const f of ['CLAUDE.md', join('.claude', 'CLAUDE.md'), 'CLAUDE.local.md']) add(join(p, f), 'project')
    for (const f of mdFiles(join(p, '.claude', 'rules'))) add(f, 'project')
  }
  for (const r of [...rules]) rules.splice(rules.indexOf(r) + 1, 0, ...claudeImports(r, seen))

  // hooks: managed, user, project settings, enabled plugins
  const hooks: HookItem[] = []
  const allOff = [managed, settings, ...projSettings].some((s) => s?.disableAllHooks === true)
  hooks.push(...eventMapHooks(managed.hooks, { source: 'global', file: tilde(join(MANAGED, 'managed-settings.json')) }))
  hooks.push(...eventMapHooks(settings.hooks, { source: 'global', file: tilde(join(dir, 'settings.json')) }))
  projFiles.forEach((f, i) => hooks.push(...eventMapHooks(projSettings[i].hooks, { source: 'project', file: tilde(f) })))
  for (const pl of active) hooks.push(...pluginHooks(pl.path, pl.manifest.hooks, ctx, { source: 'plugin', plugin: pl.name, file: tilde(join(pl.path, '.claude-plugin', 'plugin.json')) }))
  if (allOff) for (const h of hooks) h.off = true

  // MCP
  const mcp: McpServer[] = []
  const globalFile = dir === join(realHome, '.claude') ? join(realHome, '.claude.json') : join(dir, '.claude.json')
  const g = readJson(globalFile, ctx) ?? {}
  const proj = (root && g.projects?.[root]) || {}
  const off = new Set<string>(Array.isArray(proj.disabledMcpServers) ? proj.disabledMcpServers : [])
  const addMcp = (name: string, v: any, source: ExtSource, state: McpState, extra: Partial<McpServer> = {}, configPath?: string) =>
    mcp.push({ name, source, transport: transportOf(v), state: off.has(name) ? 'off' : state, ...mcpDetails(v, configPath), ...extra })
  const managedMcpFile = join(MANAGED, 'managed-mcp.json')
  for (const [n, v] of Object.entries(serverMap(readJson(managedMcpFile, ctx)))) addMcp(n, v, 'global', 'on', { managed: true }, managedMcpFile)
  for (const [n, v] of Object.entries(serverMap(g))) addMcp(n, v, 'global', v.disabled ? 'off' : 'on', {}, globalFile)
  for (const [n, v] of Object.entries(serverMap(proj))) addMcp(n, v, 'project', v.disabled ? 'off' : 'on', { local: true }, globalFile)
  const mcpJsonDir = chain.find((p) => isFile(join(p, '.mcp.json')))
  if (mcpJsonDir) {
    const allSettings = [settings, ...projSettings, proj]
    const approvedAll = allSettings.some((s) => s?.enableAllProjectMcpServers === true)
    const approved = new Set<string>(allSettings.flatMap((s) => (Array.isArray(s?.enabledMcpjsonServers) ? s.enabledMcpjsonServers : [])))
    const rejected = new Set<string>(allSettings.flatMap((s) => (Array.isArray(s?.disabledMcpjsonServers) ? s.disabledMcpjsonServers : [])))
    const projMcpFile = join(mcpJsonDir, '.mcp.json')
    for (const [n, v] of Object.entries(serverMap(readJson(projMcpFile, ctx)))) addMcp(n, v, 'project', rejected.has(n) ? 'off' : approvedAll || approved.has(n) ? 'on' : 'pending', {}, projMcpFile)
  }
  for (const pl of active) {
    const files = [join(pl.path, '.mcp.json')]
    const m = pl.manifest.mcpServers
    if (typeof m === 'string') files.push(isAbsolute(m) ? m : join(pl.path, m))
    else if (m && typeof m === 'object') for (const [n, v] of Object.entries(serverMap(m))) addMcp(n, v, 'plugin', 'on', { plugin: pl.name }, join(pl.path, '.claude-plugin', 'plugin.json'))
    for (const f of files) for (const [n, v] of Object.entries(serverMap(readJson(f, ctx)))) addMcp(n, v, 'plugin', 'on', { plugin: pl.name }, f)
  }
  return { skills, mcp, agents, plugins, rules, hooks, configDir: dir, remoteNote: g.claudeAiMcpEverConnected === true, agentsDynamic: false }
}

// ---- Codex ----------------------------------------------------------------------------------

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

/** Codex agent roles: `[agents.<name>]` tables (with an optional role file) and agents/*.toml. */
function codexAgents(cfg: Record<string, any>, cfgDir: string, rolesDir: string, source: ExtSource, ctx: Ctx): AgentItem[] {
  const out: AgentItem[] = []
  const fromRole = (name: string, role: Record<string, any>, file: string, extra: Record<string, any> = {}) => {
    allow(file)
    out.push({
      name: String(role.name ?? name),
      description: shortDesc(String(extra.description ?? role.description ?? '')),
      source,
      model: typeof role.model === 'string' ? role.model : null,
      tools: null,
      path: file
    })
  }
  for (const [name, v] of Object.entries<any>(cfg.agents ?? {})) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue
    if (!v.description && !v.config_file) continue // e.g. [agents] max_threads settings
    const file = typeof v.config_file === 'string' ? (isAbsolute(expandHome(v.config_file)) ? expandHome(v.config_file) : join(cfgDir, v.config_file)) : join(cfgDir, 'config.toml')
    fromRole(name, (isFile(file) && file.endsWith('.toml') && !file.endsWith('config.toml') ? readToml(file, ctx) : null) ?? {}, file, v)
  }
  for (const n of list(rolesDir)) if (n.endsWith('.toml')) fromRole(n.slice(0, -5), readToml(join(rolesDir, n), ctx) ?? {}, join(rolesDir, n))
  return out
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
  const addMcp = (name: string, v: any, source: ExtSource, extra: Partial<McpServer> = {}, configPath?: string) =>
    mcp.push({ name, source, transport: transportOf(v), state: v?.enabled === false || v?.disabled === true ? 'off' : 'on', ...mcpDetails(v, configPath), ...extra })
  const hooksOn = cfg.features?.hooks !== false
  const hooks: HookItem[] = []

  // plugins: everything in the cache; enabled ones per config.toml [plugins."name@market"]
  const plugins: PluginItem[] = []
  const cacheDir = join(dir, 'plugins', 'cache')
  for (const market of list(cacheDir)) {
    for (const name of list(join(cacheDir, market))) {
      const path = newestDir(join(cacheDir, market, name))
      if (!path) continue
      const key = `${name}@${market}`
      const on = cfg.plugins?.[key]?.enabled === true
      const mfFile = join(path, '.codex-plugin', 'plugin.json')
      const manifest = readJson(mfFile, ctx) ?? {}
      const item: PluginItem = {
        name,
        key,
        version: String(manifest.version ?? basename(path)) || null,
        description: shortDesc(manifest.description),
        enabled: on,
        source: 'plugin',
        marketplace: market,
        skills: [],
        agents: [],
        mcp: [],
        hooks: [],
        rules: [],
        path: tilde(path)
      }
      for (const d of relPaths(path, manifest.skills, 'skills')) scanSkillDir(d, namesOf(item.skills, on ? push : undefined), 'plugin', { plugin: name, skip })
      const m = manifest.mcpServers
      const files = typeof m === 'string' ? [isAbsolute(m) ? m : join(path, m)] : [join(path, '.mcp.json')]
      const servers: [string, any, string][] = [
        ...(m && typeof m === 'object' ? Object.entries(serverMap(m)).map(([n, s]): [string, any, string] => [n, s, mfFile]) : []),
        ...files.flatMap((f) => Object.entries(serverMap(readJson(f, ctx))).map(([n, s]): [string, any, string] => [n, s, f]))
      ]
      item.mcp = [...new Set(servers.map(([n]) => n))]
      // plugin hooks may call MCP tools (type: mcp_tool) instead of shell commands
      const ph = pluginHooks(path, manifest.hooks, ctx, { source: 'plugin', plugin: name, file: tilde(mfFile) })
      item.hooks = ph.map(hookLabel)
      plugins.push(item)
      if (!on) continue
      for (const [n, s, f] of servers) addMcp(n, s, 'plugin', { plugin: name }, f)
      if (hooksOn) hooks.push(...ph)
    }
  }
  const codexCfgFile = join(dir, 'config.toml')
  for (const [n, v] of Object.entries<any>(cfg.mcp_servers ?? {})) if (v && typeof v === 'object') addMcp(n, v, 'global', {}, codexCfgFile)
  for (const p of chain) {
    const projCfgFile = join(p, '.codex', 'config.toml')
    const pc = readToml(projCfgFile, ctx)
    for (const [n, v] of Object.entries<any>(pc?.mcp_servers ?? {})) if (v && typeof v === 'object') addMcp(n, v, 'project', {}, projCfgFile)
  }
  // project / global / plugin order in the list
  const rank: Record<ExtSource, number> = { project: 0, global: 1, plugin: 2, builtin: 3 }
  mcp.sort((a, b) => rank[a.source] - rank[b.source])

  // agents
  const agents: AgentItem[] = []
  for (const p of chain) agents.push(...codexAgents(readToml(join(p, '.codex', 'config.toml'), ctx) ?? {}, join(p, '.codex'), join(p, '.codex', 'agents'), 'project', ctx))
  agents.push(...codexAgents(cfg, dir, join(dir, 'agents'), 'global', ctx))

  // rules: AGENTS.override.md else AGENTS.md (global), then repo root down to the folder
  const { rules, add } = ruleList()
  add(isFile(join(dir, 'AGENTS.override.md')) ? join(dir, 'AGENTS.override.md') : join(dir, 'AGENTS.md'), 'global')
  const fallbacks: string[] = Array.isArray(cfg.project_doc_fallback_filenames) ? cfg.project_doc_fallback_filenames.filter((x: unknown) => typeof x === 'string') : []
  const budget = typeof cfg.project_doc_max_bytes === 'number' ? cfg.project_doc_max_bytes : 32 * 1024
  let used = 0
  for (const p of [...chain].reverse()) {
    const name = ['AGENTS.override.md', 'AGENTS.md', ...fallbacks].find((n) => isFile(join(p, n)))
    if (!name) continue
    const r = add(join(p, name), 'project')
    if (!r) continue
    if (used + r.bytes > budget) r.truncated = true
    used += r.bytes
  }

  // hooks: hooks.json (global, project), [hooks] in config.toml, enabled plugins; notify
  if (hooksOn) {
    hooks.unshift(
      ...eventMapHooks(readJson(join(dir, 'hooks.json'), ctx), { source: 'global', file: tilde(join(dir, 'hooks.json')) }),
      ...eventMapHooks(cfg.hooks, { source: 'global', file: tilde(join(dir, 'config.toml')) }),
      ...chain.flatMap((p) => eventMapHooks(readJson(join(p, '.codex', 'hooks.json'), ctx), { source: 'project', file: tilde(join(p, '.codex', 'hooks.json')) }))
    )
  }
  const notify = Array.isArray(cfg.notify) ? cfg.notify.filter((x: unknown) => typeof x === 'string') : typeof cfg.notify === 'string' ? [cfg.notify] : []
  if (notify.length) hooks.push({ event: 'notify', source: 'global', type: 'notify', summary: basename(notify[0]), file: tilde(join(dir, 'config.toml')) })

  return { skills, mcp, agents, plugins, rules, hooks, configDir: dir, remoteNote: false, agentsDynamic: false }
}

// ---- agy ------------------------------------------------------------------------------------

const AGY_ROOTS = ['.agents', '.agent', '_agents', '_agent']
const AGY_MANIFESTS = ['plugin.json', '.antigravity-plugin/plugin.json', '.gemini-plugin/plugin.json']

function scanAgy(home: string, cwd: string | null, ctx: Ctx): Scan {
  const { skills, push } = collector(
    (name) => name,
    (n) => `/${n}`
  )
  const chain = projectChain(cwd)
  const g = join(home, '.gemini')
  const cfgRoot = join(g, 'config')
  const mcp: McpServer[] = []
  const addMcp = (name: string, v: any, source: ExtSource, extra: Partial<McpServer> = {}, configPath?: string) =>
    mcp.push({ name, source, transport: transportOf(v), state: v?.disabled === true || v?.enabled === false ? 'off' : 'on', ...mcpDetails(v, configPath), ...extra })
  const hooks: HookItem[] = []
  const { rules, add: addRule } = ruleList()

  const plugins: PluginItem[] = []
  const active: PluginItem[] = []
  const findPlugins = (dir: string, source: ExtSource) => {
    for (const n of list(dir)) {
      const p = join(dir, n)
      const mf = AGY_MANIFESTS.map((m) => join(p, m)).find(isFile)
      if (!mf) continue
      const manifest = readJson(mf, ctx) ?? {}
      const name = String(manifest.name || n)
      const on = manifest.enabled !== false
      const item: PluginItem = {
        name,
        key: name,
        version: manifest.version ? String(manifest.version) : null,
        description: shortDesc(manifest.description),
        enabled: on,
        source,
        marketplace: null,
        skills: [],
        agents: [],
        mcp: Object.keys(serverMap(readJson(join(p, 'mcp_config.json'), ctx))),
        hooks: agyHooks(readJson(join(p, 'hooks.json'), ctx), { source: 'plugin', plugin: name, file: tilde(join(p, 'hooks.json')) }).map(hookLabel),
        rules: mdFiles(join(p, 'rules'), 1).map((f) => basename(f)),
        path: tilde(p)
      }
      scanSkillDir(join(p, 'skills'), namesOf(item.skills), 'plugin', { plugin: name })
      plugins.push(item)
      if (on) active.push({ ...item, path: p })
    }
  }
  for (const p of chain) for (const r of AGY_ROOTS) findPlugins(join(p, r, 'plugins'), 'project')
  findPlugins(join(cfgRoot, 'plugins'), 'global')
  findPlugins(join(g, 'antigravity-cli', 'builtin', 'plugins'), 'builtin')

  for (const p of chain) for (const r of AGY_ROOTS) scanSkillDir(join(p, r, 'skills'), push, 'project')
  scanSkillDir(join(cfgRoot, 'skills'), push, 'global')
  for (const pl of active) {
    scanSkillDir(join(pl.path, 'skills'), push, 'plugin', { plugin: pl.name })
    const plMcpFile = join(pl.path, 'mcp_config.json')
    for (const [n, v] of Object.entries(serverMap(readJson(plMcpFile, ctx)))) addMcp(n, v, 'plugin', { plugin: pl.name }, plMcpFile)
  }
  scanSkillDir(join(g, 'antigravity-cli', 'builtin', 'skills'), push, 'builtin')
  const agyMcpFile = join(cfgRoot, 'mcp_config.json')
  for (const [n, v] of Object.entries(serverMap(readJson(agyMcpFile, ctx)))) addMcp(n, v, 'global', {}, agyMcpFile)
  mcp.sort((a, b) => Number(a.source === 'plugin') - Number(b.source === 'plugin'))

  // rules: global GEMINI.md and the customization root; project GEMINI.md / AGENTS.md and
  // <root>/.agents/rules from the repo root down; enabled plugins' rules/
  for (const f of [join(g, 'GEMINI.md'), join(cfgRoot, 'GEMINI.md'), join(cfgRoot, 'AGENTS.md'), ...mdFiles(join(cfgRoot, 'rules'))]) addRule(f, 'global')
  for (const p of [...chain].reverse()) {
    for (const n of ['GEMINI.md', 'AGENTS.md']) addRule(join(p, n), 'project')
    for (const r of AGY_ROOTS) for (const f of mdFiles(join(p, r, 'rules'))) addRule(f, 'project')
  }
  for (const pl of active) for (const f of mdFiles(join(pl.path, 'rules'), 1)) addRule(f, 'plugin', { plugin: pl.name })

  // hooks: named hooks in each customization root and enabled plugins
  hooks.push(...agyHooks(readJson(join(cfgRoot, 'hooks.json'), ctx), { source: 'global', file: tilde(join(cfgRoot, 'hooks.json')) }))
  for (const p of chain) for (const r of AGY_ROOTS) hooks.push(...agyHooks(readJson(join(p, r, 'hooks.json'), ctx), { source: 'project', file: tilde(join(p, r, 'hooks.json')) }))
  for (const pl of active)
    hooks.push(...agyHooks(readJson(join(pl.path, 'hooks.json'), ctx), { source: pl.source === 'builtin' ? 'builtin' : 'plugin', plugin: pl.name, file: tilde(join(pl.path, 'hooks.json')) }))

  return { skills, mcp, agents: [], plugins, rules, hooks, configDir: g, remoteNote: false, agentsDynamic: true }
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
    result = cfg.kind === 'claude' ? scanClaude(dir, cwd, ctx) : cfg.kind === 'codex' ? scanCodex(dir, cwd, ctx) : cfg.kind === 'gemini' ? scanAgy(dir, cwd, ctx) : emptyScan(dir)
  } catch (e) {
    console.warn('[extensions] scan failed', e)
    result = emptyScan(cfg.kind === 'gemini' ? join(dir, '.gemini') : dir)
    ctx.errors++
  }
  const entry = { at: Date.now(), scan: result, errors: ctx.errors }
  cache.set(key, entry)
  return entry
}

function tilde(p: string): string {
  return p === realHome ? '~' : p.startsWith(realHome + '/') ? '~' + p.slice(realHome.length) : p
}

const SOURCE_RANK: Record<ExtSource, number> = { project: 0, global: 1, plugin: 2, builtin: 3 }
const sortSkills = (s: SkillItem[]): SkillItem[] => [...s].sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || a.name.localeCompare(b.name))

export function listSkills(id: ProfileId, cwd: string | null, refresh = false): SkillList {
  const { scan: s, errors } = scan(id, cwd, refresh)
  return { items: sortSkills(s.skills), errors }
}

export function listMcp(id: ProfileId, cwd: string | null, refresh = false): McpList {
  const { scan: s, errors } = scan(id, cwd, refresh)
  return { servers: s.mcp, configDir: tilde(s.configDir), project: cwd ? tilde(cwd) : null, errors, remoteNote: s.remoteNote }
}

export function extOverview(id: ProfileId, cwd: string | null, refresh = false): ExtOverview {
  const { scan: s, errors } = scan(id, cwd, refresh)
  const pluginRank = (p: PluginItem) => (p.enabled ? 0 : 1)
  return {
    skills: sortSkills(s.skills),
    agents: [...s.agents].sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || a.name.localeCompare(b.name)),
    plugins: [...s.plugins].sort((a, b) => pluginRank(a) - pluginRank(b) || a.name.localeCompare(b.name)),
    mcp: s.mcp,
    rules: s.rules,
    hooks: s.hooks,
    configDir: tilde(s.configDir),
    project: cwd ? tilde(cwd) : null,
    errors,
    remoteNote: s.remoteNote,
    agentsDynamic: s.agentsDynamic
  }
}
