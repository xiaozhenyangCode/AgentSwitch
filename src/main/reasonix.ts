import { randomBytes } from 'node:crypto'
import { constants, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { parse } from 'smol-toml'
import type { ReasonixModel } from '@shared/types'

interface ReasonixProvider {
  name: string
  models: string[]
  default?: string
  apiKeyEnv?: string
  efforts: Record<string, { supported: string[]; default?: string }>
}

interface ReasonixConfig {
  defaultModel: string
  providers: ReasonixProvider[]
}

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a TOML table')
  return value as Record<string, unknown>
}

const optionalString = (value: unknown): string | undefined => {
  if (value !== undefined && typeof value !== 'string') throw new Error('Expected a TOML string')
  return value
}

const strings = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.some((x) => typeof x !== 'string')) throw new Error('Expected a TOML string array')
  return value
}

export function parseReasonixConfig(text: string): ReasonixConfig | null {
  try {
    const raw = parse(text)
    const providers = raw.providers ?? []
    if (!Array.isArray(providers)) return null
    return {
      defaultModel: optionalString(raw.default_model) ?? '',
      providers: providers.map((entry) => {
        const p = record(entry)
        const name = optionalString(p.name)
        if (!name) throw new Error('Missing provider name')
        const efforts: ReasonixProvider['efforts'] = Object.fromEntries(
          Object.entries(record(p.model_overrides ?? {})).map(([model, value]) => {
            const override = record(value)
            return [model, {
              supported: strings(override.supported_efforts ?? []),
              default: optionalString(override.default_effort)
            }]
          })
        )
        return { name, models: strings(p.models ?? []), default: optionalString(p.default), apiKeyEnv: optionalString(p.api_key_env), efforts }
      })
    }
  } catch {
    return null
  }
}

export function readReasonixConfig(dir: string): ReasonixConfig | null {
  try {
    return parseReasonixConfig(readFileSync(join(dir, 'config.toml'), 'utf8'))
  } catch {
    return null
  }
}

function defaultProvider(cfg: ReasonixConfig): ReasonixProvider | undefined {
  return cfg.providers.find((p) => p.name === cfg.defaultModel) ?? cfg.providers.find((p) => p.models.includes(cfg.defaultModel))
}

export const keyEnvName = (cfg: ReasonixConfig | null): string | null => cfg ? defaultProvider(cfg)?.apiKeyEnv ?? null : null

export function reasonixDefaultModel(cfg: ReasonixConfig): string {
  const provider = defaultProvider(cfg)
  return provider?.name === cfg.defaultModel ? provider.default ?? provider.models[0] ?? '' : cfg.defaultModel
}

export const REASONIX_KEY_ENV = 'DEEPSEEK_API_KEY'
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

function envValue(text: string, name: string): string {
  let value = ''
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (match?.[1] !== name) continue
    const raw = match[2]
    const quoted = /^(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(?:#.*)?$/.exec(raw)
    value = quoted ? (quoted[1] ?? quoted[2] ?? '').replace(/\\(["\\])/g, '$1') : raw.split('#', 1)[0].trim()
  }
  return value
}

export const envHasValue = (text: string, name: string): boolean => !!envValue(text, name).trim()

function readManagedEnv(dir: string): string {
  return readFileSync(join(dir, '.env'), { encoding: 'utf8', flag: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK })
}

export function reasonixHasKey(dir: string, name: string, imported: boolean): boolean {
  try {
    if (imported) {
      // The external CLI owns imported keys. AgentSwitch checks file metadata only.
      const file = statSync(join(dir, '.env'))
      return file.isFile() && file.size > 0
    }
    return envHasValue(readManagedEnv(dir), name)
  } catch {
    return false
  }
}

export function reasonixRedactor(managedDir: string | null): (text: string) => string {
  let key = ''
  if (managedDir) {
    try {
      key = envValue(readManagedEnv(managedDir), REASONIX_KEY_ENV)
    } catch {
      // A missing file is reported by the CLI.
    }
  }
  const prefix = /\bsk[-][a-z0-9_-]+/gi
  const escaped = key ? JSON.stringify(key).slice(1, -1) : ''
  return (text) => (escaped ? text.replaceAll(key, '[redacted]').replaceAll(escaped, '[redacted]') : text).replace(prefix, '[redacted]')
}

export function renderConfigToml({ defaultModel, language }: { defaultModel: ReasonixModel; language: string }): string {
  return `config_version = 12
default_model = ${JSON.stringify(defaultModel)}
language = ${JSON.stringify(language)}

[[providers]]
name        = "deepseek"
kind        = "anthropic"
base_url    = "https://api.deepseek.com/anthropic"
models      = ["deepseek-flash", "deepseek-v4-pro"]
default     = "deepseek-flash"
api_key_env = "DEEPSEEK_API_KEY"
balance_url = "https://api.deepseek.com/user/balance"
context_window = 1000000
prices      = { "deepseek-flash" = { cache_hit = 0.003, input = 0.15, output = 0.6, currency = "$" }, "deepseek-v4-pro" = { cache_hit = 0.022, input = 0.66, output = 1.98, currency = "$" } }
billing_currency = "USD"
thinking    = "enabled"
vision_models = ["deepseek-flash"]
web_search  = true
model_overrides = { "deepseek-flash" = { supported_efforts = ["disabled", "low", "high", "max"], default_effort = "low", vision = true }, "deepseek-v4-pro" = { supported_efforts = ["disabled", "high", "max"], default_effort = "high" } }
`
}

function contained(root: string, child: string): boolean {
  const rel = relative(root, child)
  return !!rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}

export function managedReasonixPath(dir: string, profilesRoot: string, accountId?: string): string {
  const root = realpathSync(profilesRoot)
  const actual = realpathSync(dir)
  if (root !== join(realpathSync(dirname(profilesRoot)), basename(profilesRoot)) || !contained(root, actual))
    throw new Error('Invalid managed Reasonix directory')
  if (accountId !== undefined) {
    const expected = join(root, accountId)
    if (basename(accountId) !== accountId || !contained(root, expected) || (actual !== expected && !contained(expected, actual)))
      throw new Error('Invalid managed Reasonix account path')
  }
  return actual
}

export function writeEnvFile(dir: string, name: string, key: string, profilesRoot: string): void {
  if (!ENV_NAME.test(name) || !key.trim() || /[\r\n\0]/.test(key)) throw new Error('Invalid Reasonix credential')
  const path = managedReasonixPath(dir, profilesRoot)
  const tmp = join(path, `.env.${randomBytes(12).toString('hex')}.tmp`)
  const value = /^[A-Za-z0-9_.-]+$/.test(key) ? key : JSON.stringify(key)
  try {
    writeFileSync(tmp, `${name}=${value}\n`, { flag: 'wx', mode: 0o600 })
    renameSync(tmp, join(path, '.env'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
      try {
        unlinkSync(tmp)
      } catch {
        // There may be no temporary file to remove.
      }
    }
    throw e
  }
}

export function removeReasonixKey({ dir, profilesRoot, accountId, importedDir, imported }: {
  dir: string
  profilesRoot: string
  accountId: string
  importedDir: string
  imported: boolean
}): void {
  if (imported) return
  let actual: string
  let importedPath = importedDir
  try {
    actual = managedReasonixPath(dir, profilesRoot, accountId)
  } catch {
    return
  }
  try {
    importedPath = realpathSync(importedDir)
  } catch {
    // The external setup may not exist.
  }
  if (actual === importedPath || contained(importedPath, actual)) return
  try {
    unlinkSync(join(actual, '.env'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
}
