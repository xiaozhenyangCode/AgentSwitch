import { app } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ModelList, ModelOption, ProfileConfig, ProfileId } from '@shared/types'
import { EFFORT_SUFFIX_RE, effortRank } from '@shared/modelSpec'
import { buildSpawnSpec, expandHome, getConfig, getKindConfig, kindBinaryPath } from './profiles'
import { realHome } from './shellEnv'

/**
 * Sub-model lists, per account (each account sees its own entitlements).
 *   claude: <CLAUDE_CONFIG_DIR>/cache/model-catalog/*-cc.json  (local, written by Claude Code)
 *   codex : $CODEX_HOME/models_cache.json, refreshed via `codex debug models`
 *   agy   : `agy models` (network; tab-separated "id\tname")
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
    cache = JSON.parse(readFileSync(cachePath(), 'utf8')) as Cache
  } catch {
    cache = {}
  }
  return cache
}
function saveCache(): void {
  const p = cachePath()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p + '.tmp', JSON.stringify(cache ?? {}, null, 2))
  renameSync(p + '.tmp', p)
}

const ALIAS_LABEL: Record<string, string> = { opus: 'Opus（最新）', sonnet: 'Sonnet（最新）', fable: 'Fable（最新）', haiku: 'Haiku（最新）' }

function staticList(cfg: ProfileConfig): ModelOption[] {
  const ids = getKindConfig(cfg.kind).models
  if (cfg.kind === 'gemini') return collapseEfforts(ids.map((id) => ({ id, label: id, group: 'main' as const })))
  return ids.map((id) => ({ id, label: ALIAS_LABEL[id] ?? id, group: 'main' as const }))
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

function run(cfg: ProfileConfig, args: string[]): Promise<string> {
  const bin = kindBinaryPath(cfg.kind)
  if (!bin) return Promise.reject(new Error('CLI 未安装'))
  const { env } = buildSpawnSpec(cfg.id, 'run')
  return new Promise((resolve, reject) =>
    execFile(bin, args, { env, cwd: realHome, timeout: CMD_TIMEOUT, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim().split('\n').pop() || err.message)) : resolve(stdout)
    )
  )
}

// ---- claude ---------------------------------------------------------------------------

function claudeCatalog(cfg: ProfileConfig): { models: ModelOption[]; fetchedAt: number } | null {
  const dir = join(expandHome(cfg.configDir), 'cache', 'model-catalog')
  if (!existsSync(dir)) return null
  type Row = { id: string; name?: string; short_name?: string; section?: string; thinking?: { type?: string; effort_options?: { id: string }[] } }
  let best: { fetchedAt: number; models: Row[] } | null = null
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('-cc.json')) continue
    try {
      const d = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      const models = d?.catalog?.config?.models
      if (Array.isArray(models) && (!best || d.fetchedAt > best.fetchedAt)) best = { fetchedAt: Number(d.fetchedAt) || 0, models }
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
    .filter((m) => typeof m.id === 'string')
    .map((m) => ({ id: m.id, label: m.name || m.id, group: m.section === 'main' ? 'main' : 'more', ...efforts(m) }))
  // aliases inherit the efforts of the newest catalog row of the same family
  const aliases: ModelOption[] = ['opus', 'sonnet', 'fable', 'haiku'].map((id) => ({
    id,
    label: ALIAS_LABEL[id],
    group: 'main',
    ...efforts(best!.models.find((m) => (m.short_name ?? '').toLowerCase() === id || m.id.includes(`-${id}-`)))
  }))
  return { models: [...aliases, ...listed], fetchedAt: best.fetchedAt }
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
  const f = join(expandHome(cfg.configDir), 'models_cache.json')
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

// ---- public ----------------------------------------------------------------------------

async function fetchLive(cfg: ProfileConfig, refresh: boolean): Promise<Omit<ModelList, 'profileId'>> {
  switch (cfg.kind) {
    case 'claude': {
      const c = claudeCatalog(cfg)
      if (!c) throw new Error('未找到 Claude 模型目录缓存（登录并运行一次 Claude Code 后生成）')
      return { models: c.models, source: 'catalog', fetchedAt: c.fetchedAt || Date.now() }
    }
    case 'codex': {
      if (!refresh) {
        const local = codexCacheFile(cfg)
        if (local) return { models: local, source: 'catalog', fetchedAt: Date.now() }
      }
      const models = parseCodex(await run(cfg, ['debug', 'models']))
      if (!models.length) throw new Error('codex debug models 没有返回模型')
      return { models, source: 'command', fetchedAt: Date.now() }
    }
    case 'gemini': {
      const models = parseAgy(await run(cfg, ['models']))
      if (!models.length) throw new Error('agy models 没有返回模型（账号可能未登录）')
      return { models, source: 'command', fetchedAt: Date.now() }
    }
  }
}

const inflight = new Map<ProfileId, Promise<ModelList>>()

export function listModels(id: ProfileId, refresh = false): Promise<ModelList> {
  const c = loadCache()
  const cached = c[id]
  // claude's catalog is a cheap local read: always re-read so new models appear promptly
  const kind = getConfig(id).kind
  if (!refresh && cached && kind !== 'claude' && Date.now() - cached.fetchedAt < TTL && cached.source !== 'static') return Promise.resolve(cached)
  const running = inflight.get(id)
  if (running) return running
  const p = (async (): Promise<ModelList> => {
    const cfg = getConfig(id)
    try {
      const live = await fetchLive(cfg, refresh)
      const list: ModelList = { profileId: id, ...live }
      c[id] = list
      saveCache()
      return list
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      if (cached && cached.source !== 'static') return { ...cached, source: 'cache', error }
      return { profileId: id, models: staticList(cfg), source: 'static', fetchedAt: Date.now(), error }
    } finally {
      inflight.delete(id)
    }
  })()
  inflight.set(id, p)
  return p
}

export function forgetModels(id: ProfileId): void {
  const c = loadCache()
  if (c[id]) {
    delete c[id]
    saveCache()
  }
}
