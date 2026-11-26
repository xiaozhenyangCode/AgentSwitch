import { app } from 'electron'
import { execFile } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { parse as parseToml } from 'smol-toml'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ModelList, ModelOption, ProfileConfig, ProfileId } from '@shared/types'
import { cleanModelName, EFFORT_SUFFIX_RE, effortRank, joinSpec, splitSpec } from '@shared/modelSpec'
import { buildSpawnSpec, expandHome, getConfig, getKindConfig, hasProfile, isLoggedIn, KIND_DEFAULTS, kindBinaryPath } from './profiles'
import { getProviderCapabilities } from '@shared/providerCapabilities'
import { t } from './i18n'
import { displayModel } from './apiKey'
import { readReasonixConfig, reasonixDefaultModel } from './reasonix'

/**
 * Sub-model lists, per account (each account sees its own entitlements).
 *   claude: <CLAUDE_CONFIG_DIR>/cache/model-catalog/*-cc.json  (local, written by Claude Code)
 *   codex : $CODEX_HOME/models_cache.json, falling back to offline `codex debug models --bundled`
 *           (manual refresh queries live `codex debug models` with plugins/hooks/apps/MCP disabled)
 *   agy   : passive loads use cache/static only (`agy models` boots its full server and MCPs);
 *           explicit user refresh runs `agy models` only when already logged in
 * Fallback chain: live source -> AgentSwitch cache (userData/models-cache.json) -> static list.
 * The UI always keeps a free-text "custom model" input as the last resort.
 */

const TTL = 24 * 3600_000
const CMD_TIMEOUT = 30_000

type Cache = Record<ProfileId, ModelList>
const cachePath = (): string => join(app.getPath('userData'), 'models-cache.v2.json')

let cache: Cache | null = null
function loadCache(): Cache {
  if (cache) return cache
  try {
    const stored: unknown = JSON.parse(readFileSync(cachePath(), 'utf8'))
    cache = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored as Cache : {}
  } catch {
    cache = {}
  }
  return cache
}
function saveCache(): void {
  try {
    const p = cachePath()
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p + '.tmp', JSON.stringify(cache ?? {}, null, 2))
    renameSync(p + '.tmp', p)
  } catch {
    // The current catalog can still be used in memory on a read-only filesystem.
  }
}

const ALIAS_NAME: Record<string, string> = { opus: 'Opus', sonnet: 'Sonnet', fable: 'Fable', haiku: 'Haiku' }
const aliasLabel = (id: string): string | undefined => (ALIAS_NAME[id] ? t('model.latest', { name: ALIAS_NAME[id] }) : undefined)

function staticList(cfg: ProfileConfig): ModelOption[] {
  const ids = getKindConfig(cfg.kind).models
  if (cfg.kind === 'gemini') return collapseEfforts(ids.map((id) => ({ id, label: id, group: 'main' as const })))
  return ids.map((id) => ({ id, label: aliasLabel(id) ?? id, group: 'main' as const }))
}

/**
 * Folds `<base>-low|medium|high|xhigh` ids into one row per base model carrying `efforts`.
 * Order follows each base's first appearance; the label drops the trailing "(High)".
 */
function collapseEfforts(rows: ModelOption[]): ModelOption[] {
  const out: ModelOption[] = []
  const byBase = new Map<string, ModelOption>()
  for (const r of rows) {
    const m = EFFORT_SUFFIX_RE.exec(r.id)
    if (!m) {
      out.push(r)
      continue
    }
    const [, base, effort] = m
    let row = byBase.get(base)
    if (!row) {
      const label = r.label === r.id ? base : r.label.replace(/\s*[(（][^)）]*[)）]\s*$/, '').trim() || base
      row = { id: base, label, group: r.group, efforts: [] }
      byBase.set(base, row)
      out.push(row)
    }
    if (r.group === 'main') row.group = 'main'
    if (!row.efforts!.includes(effort)) row.efforts!.push(effort)
  }
  for (const r of byBase.values()) {
    r.efforts!.sort((a, b) => effortRank(a) - effortRank(b))
    r.defaultEffort = r.efforts!.includes('medium') ? 'medium' : r.efforts![0]
  }
  return out
}

function run(cfg: ProfileConfig, args: string[], extraEnv?: Record<string, string>): Promise<string> {
  const bin = kindBinaryPath(cfg.kind)
  if (!bin) return Promise.reject(new Error(t('main.cliMissing')))
  const { env } = buildSpawnSpec(cfg.id, 'run', undefined, false)
  const spawnEnv = extraEnv ? { ...env, ...extraEnv } : env
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { env: spawnEnv, cwd: tmpdir(), timeout: CMD_TIMEOUT, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim().split('\n').pop() || err.message)) : resolve(stdout)
    )
    child.stdin?.end()
  })
}

export const codexModelArgs = (refresh: boolean): string[] => [
  'debug',
  'models',
  ...(refresh ? [] : ['--bundled']),
  '--disable',
  'plugins',
  '--disable',
  'hooks',
  '--disable',
  'apps',
  '-c',
  'mcp_servers={}'
]

// ---- claude ---------------------------------------------------------------------------

export function claudeConfigDir(cfg: ProfileConfig): string {
  const dir = expandHome(cfg.extraEnv.CLAUDE_CONFIG_DIR || cfg.configDir)
  return dir === expandHome('~') ? join(dir, '.claude') : dir
}

function claudeCatalog(cfg: ProfileConfig): { models: ModelOption[]; fetchedAt: number; defaultModel?: string } | null {
  const dir = join(claudeConfigDir(cfg), 'cache', 'model-catalog')
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return null
  }
  type Row = { id: string; name?: string; short_name?: string; section?: string; default?: boolean; thinking?: { type?: string; effort_options?: { id: string }[] } }
  let best: { fetchedAt: number; models: Row[]; defaultModel?: string } | null = null
  for (const f of files) {
    if (!f.endsWith('-cc.json')) continue
    try {
      const d = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      const models = d?.catalog?.config?.models
      if (Array.isArray(models) && (!best || d.fetchedAt > best.fetchedAt)) {
        best = {
          models: models.filter((model): model is Row => typeof model?.id === 'string'),
          fetchedAt: Number(d.fetchedAt) || 0,
          defaultModel: cleanModelName(d.catalog.config.defaultModel ?? d.catalog.config.default_model) ?? undefined
        }
      }
    } catch {
      /* skip unreadable */
    }
  }
  if (!best) return null
  const efforts = (m: Row | undefined): Pick<ModelOption, 'efforts'> => {
    const ids = m?.thinking?.type === 'effort' ? (m.thinking.effort_options ?? []).map((o) => o.id).filter((x) => typeof x === 'string') : []
    return ids.length > 1 ? { efforts: ids } : {}
  }
  const listed: ModelOption[] = best.models
    .map((m) => ({ id: m.id, label: m.name || m.id, group: m.section === 'main' ? 'main' : 'more', ...efforts(m) }))
  // aliases inherit the efforts of the newest catalog row of the same family
  const aliases: ModelOption[] = ['opus', 'sonnet', 'fable', 'haiku'].map((id) => ({
    id,
    label: aliasLabel(id)!,
    group: 'main',
    ...efforts(best!.models.find((m) => (m.short_name ?? '').toLowerCase() === id || m.id.includes(`-${id}-`)))
  }))
  return { models: [...aliases, ...listed], fetchedAt: best.fetchedAt, defaultModel: best.defaultModel ?? best.models.find((m) => m.default)?.id }
}

// ---- codex ----------------------------------------------------------------------------

function parseCodex(json: string): ModelOption[] {
  const d = JSON.parse(json)
  const models: {
    slug: string
    display_name?: string
    visibility?: string
    priority?: number
    default_reasoning_level?: string
    supported_reasoning_levels?: { effort?: string }[]
  }[] = d?.models ?? []
  return models
    .filter((m) => m.slug && m.visibility === 'list')
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
    .map((m, i) => {
      const efforts = (m.supported_reasoning_levels ?? []).map((l) => l.effort).filter((e): e is string => typeof e === 'string')
      return {
        id: m.slug,
        label: m.display_name || m.slug,
        group: i < 6 ? 'main' : 'more',
        ...(efforts.length > 1 ? { efforts, defaultEffort: m.default_reasoning_level } : {})
      }
    })
}

function codexCacheFile(cfg: ProfileConfig): ModelOption[] | null {
  const f = join(codexConfigDir(cfg), 'models_cache.json')
  try {
    const list = parseCodex(readFileSync(f, 'utf8'))
    return list.length ? list : null
  } catch {
    return null
  }
}

// ---- agy ------------------------------------------------------------------------------

function parseAgy(out: string): ModelOption[] {
  const rows: ModelOption[] = out
    .split('\n')
    .map((l) => l.split('\t'))
    .filter((p) => p.length >= 2 && /^[\w.-]+$/.test(p[0].trim()))
    .map(([id, name]) => {
      const i = id.trim()
      // Gemini models first; third-party and internal orchestrators under 更多
      const main = /^gemini-/.test(i) && !/orchestrator/.test(i)
      return { id: i, label: name.trim() || i, group: main ? 'main' : 'more' }
    })
  return collapseEfforts(rows)
}

/** Real agy model id for a base + effort (agy bakes the effort into the id). */
export function agyModelId(id: ProfileId, model: string, effort: string | null): string {
  const row = loadCache()[id]?.models.find((m) => m.id === model)
  if (!row?.efforts?.length) {
    if (effort) return `${model}-${effort}`
    // list not cached yet: fall back to the built-in variants
    return getKindConfig('gemini').models.includes(`${model}-medium`) ? `${model}-medium` : model
  }
  const e = effort && row.efforts.includes(effort) ? effort : (row.defaultEffort ?? row.efforts[0])
  return `${model}-${e}`
}

function reasonixCatalog(cfg: ProfileConfig): Omit<ModelList, 'profileId'> {
  const config = readReasonixConfig(expandHome(cfg.configDir))
  const models = new Map<string, ModelOption>()
  for (const provider of config?.providers ?? []) {
    for (const id of provider.models) {
      if (models.has(id)) continue
      const effort = provider.efforts[id]
      const option: ModelOption = { id, label: id, group: 'main' }
      if (effort?.supported.length) {
        option.efforts = effort.supported
        option.defaultEffort = effort.default
      }
      models.set(id, option)
    }
  }
  const fetchedAt = Date.now()
  if (config && models.size) return { models: [...models.values()], defaultModel: reasonixDefaultModel(config), source: 'catalog', fetchedAt }
  return { models: KIND_DEFAULTS.reasonix.models.map((id) => ({ id, label: id, group: 'main' })), source: 'static', fetchedAt }
}

/** Reads model and reasoning effort from `<codexHome>/config.toml` (honouring active `profile`). */
export function readCodexConfig(codexHome: string): { model: string | null; effort: string | null } {
  try {
    const raw = readFileSync(join(codexHome, 'config.toml'), 'utf8')
    const doc = parseToml(raw) as Record<string, unknown>
    const profileName = typeof doc.profile === 'string' ? doc.profile.trim() : ''
    const profiles = doc.profiles && typeof doc.profiles === 'object' ? (doc.profiles as Record<string, unknown>) : null
    const activeProfile =
      profileName && profiles && profiles[profileName] && typeof profiles[profileName] === 'object'
        ? (profiles[profileName] as Record<string, unknown>)
        : null
    const model = cleanModelName(activeProfile?.model) ?? cleanModelName(doc.model)
    const effort =
      cleanModelName(activeProfile?.model_reasoning_effort ?? activeProfile?.reasoning_effort) ??
      cleanModelName(doc.model_reasoning_effort ?? doc.reasoning_effort)
    return { model, effort }
  } catch {
    return { model: null, effort: null }
  }
}

export function codexDefaultModel(): string {
  const configured = getKindConfig('codex').models.find((m) => cleanModelName(m))
  return configured ?? KIND_DEFAULTS.codex.models[0] ?? 'gpt-5-codex'
}

export const codexConfigDir = (cfg: ProfileConfig): string => expandHome(cfg.extraEnv.CODEX_HOME || cfg.configDir)
export const agyHome = (cfg: ProfileConfig): string => expandHome(cfg.extraEnv.HOME || cfg.configDir)

function readSettings(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

export function resolveEffectiveDefaultModel(cfg: ProfileConfig, catalogModels?: ModelOption[]): string | null {
  switch (cfg.kind) {
    case 'claude': {
      if (cfg.apiKey?.provider === 'deepseek' || cfg.apiKey?.provider === 'custom') {
        return cleanModelName(cfg.apiKey.models?.[0])
      }
      const configured = cleanModelName(cfg.extraEnv.ANTHROPIC_MODEL)
        ?? cleanModelName(readSettings(join(claudeConfigDir(cfg), 'settings.json'))?.model)
      const catalog = claudeCatalog(cfg)
      // Claude settings can point at a moving alias. Resolve it when the local catalog knows the family.
      const models = catalogModels ?? catalog?.models
      const concrete = (m: ModelOption): boolean => m.group === 'main' && !Object.hasOwn(ALIAS_NAME, m.id)
      if (configured) {
        return (Object.hasOwn(ALIAS_NAME, configured) ? models?.find((m) => concrete(m) && m.id.includes(`-${configured}-`))?.id : null) ?? configured
      }
      return catalog?.defaultModel ?? models?.find(concrete)?.id ?? null
    }
    case 'codex': {
      const config = readCodexConfig(codexConfigDir(cfg))
      const spec = splitSpec(config.model, 'codex')
      if (spec.model) return joinSpec(spec.model, spec.effort ?? config.effort)
      const first = codexCacheFile(cfg)?.[0] ?? catalogModels?.[0]
      return joinSpec(first?.id ?? codexDefaultModel(), config.effort ?? first?.defaultEffort ?? null)
    }
    case 'gemini': {
      const dir = join(agyHome(cfg), '.gemini')
      for (const path of [join(dir, 'antigravity-cli', 'settings.json'), join(dir, 'settings.json'), join(dir, 'config.json')]) {
        const settings = readSettings(path)
        const model = cleanModelName(settings?.model) ?? cleanModelName(settings?.defaultModel) ?? cleanModelName(settings?.selectedModel)
        if (model) return model
      }
      const main = (m: ModelOption): boolean => m.group === 'main'
      const first = catalogModels?.find(main) ?? staticList(cfg).find(main)
      if (!first) return null
      return first.defaultEffort ? `${first.id}-${first.defaultEffort}` : first.id
    }
    case 'reasonix': {
      const config = readReasonixConfig(expandHome(cfg.configDir))
      return (config ? cleanModelName(reasonixDefaultModel(config)) : null) ?? KIND_DEFAULTS.reasonix.models[0] ?? null
    }
  }
}

const effectiveDefaults = new Map<ProfileId, { model: string | null; at: number }>()

export function getEffectiveDefaultModel(id: ProfileId): string | null {
  if (!hasProfile(id)) return null
  const cached = effectiveDefaults.get(id)
  if (cached && Date.now() - cached.at < TTL) return cached.model
  const model = resolveEffectiveDefaultModel(getConfig(id), loadCache()[id]?.models)
  effectiveDefaults.set(id, { model, at: Date.now() })
  return model
}

export function resolveRunModel(cfg: ProfileConfig, runtime?: string | null, explicit?: string | null): string | null {
  return cleanModelName(runtime) ?? cleanModelName(explicit) ?? cleanModelName(cfg.defaultModel)
    ?? (hasProfile(cfg.id) ? getEffectiveDefaultModel(cfg.id) : resolveEffectiveDefaultModel(cfg))
}

// ---- public ----------------------------------------------------------------------------

async function fetchLive(cfg: ProfileConfig, refresh: boolean): Promise<Omit<ModelList, 'profileId'>> {
  switch (cfg.kind) {
    case 'claude': {
      if (cfg.apiKey?.provider === 'deepseek' || cfg.apiKey?.provider === 'custom') {
        const models: ModelOption[] = (cfg.apiKey.models ?? []).map((id) => ({ id, label: displayModel(id), group: 'main' }))
        return { models, source: 'catalog', fetchedAt: Date.now() }
      }
      const c = claudeCatalog(cfg)
      if (!c) throw new Error(t('main.noClaudeCatalog'))
      return { models: c.models, source: 'catalog', fetchedAt: c.fetchedAt || Date.now() }
    }
    case 'codex': {
      if (!refresh) {
        const local = codexCacheFile(cfg)
        if (local) return { models: local, source: 'catalog', fetchedAt: Date.now() }
      }
      const models = parseCodex(await run(cfg, codexModelArgs(refresh)))
      if (!models.length) throw new Error(t('main.codexNoModels'))
      return { models, source: 'command', fetchedAt: Date.now() }
    }
    case 'reasonix':
      return reasonixCatalog(cfg)
    case 'gemini': {
      if (!isLoggedIn(cfg.id)) throw new Error(t('main.agyNoModels'))
      const models = parseAgy(
        await run(cfg, ['models'], { AGY_CLI_DISABLE_AUTO_UPDATE: '1', SSH_CONNECTION: '1', SSH_TTY: '1' })
      )
      if (!models.length) throw new Error(t('main.agyNoModels'))
      return { models, source: 'command', fetchedAt: Date.now() }
    }
  }
}

const inflight = new Map<ProfileId, { request: Promise<ModelList>; refresh: boolean }>()

export function listModels(id: ProfileId, refresh = false): Promise<ModelList> {
  const cfg = getConfig(id)
  const caps = getProviderCapabilities(cfg.kind)
  const c = loadCache()
  const cached = c[id]
  const complete = (list: Omit<ModelList, 'profileId'>): ModelList => {
    const model = resolveEffectiveDefaultModel(cfg, list.source === 'static' ? undefined : list.models)
    effectiveDefaults.set(id, { model, at: Date.now() })
    return { ...list, profileId: id, defaultModel: model ?? undefined }
  }
  if (caps.modelListMode === 'direct-local') return fetchLive(cfg, refresh).then(complete)
  const fallback = (error?: string): Omit<ModelList, 'profileId'> =>
    cached && cached.source !== 'static'
      ? { ...cached, source: 'cache', error }
      : { models: staticList(cfg), source: 'static', fetchedAt: Date.now(), error }
  // Providers without passive model discovery never spawn a heavy language server unless explicitly refreshed.
  if (!refresh && !caps.supportsPassiveModelList) {
    return Promise.resolve(complete(cached && cached.source !== 'static' && Date.now() - cached.fetchedAt < TTL ? cached : fallback()))
  }
  if (!refresh && cached && caps.modelListMode === 'cached-ttl' && Date.now() - cached.fetchedAt < TTL && cached.source !== 'static') {
    return Promise.resolve(complete(cached))
  }
  const running = inflight.get(id)
  if (running && (!refresh || running.refresh)) return running.request
  const p = Promise.resolve().then(async (): Promise<ModelList> => {
    let live: Omit<ModelList, 'profileId'>
    try {
      live = await fetchLive(cfg, refresh)
    } catch (e) {
      live = fallback(e instanceof Error ? e.message : String(e))
    }
    if (inflight.get(id)?.request !== p) return listModels(id)
    const list = complete(live)
    if (list.source !== 'cache' && list.source !== 'static') {
      c[id] = list
      saveCache()
    }
    return list
  }).finally(() => {
    if (inflight.get(id)?.request === p) inflight.delete(id)
  })
  inflight.set(id, { request: p, refresh })
  return p
}

export function forgetModels(id: ProfileId): void {
  effectiveDefaults.delete(id)
  inflight.delete(id)
  const c = loadCache()
  if (c[id]) {
    delete c[id]
    saveCache()
  }
}
