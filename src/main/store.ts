import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { KindConfig, ProfileConfig, ProfileKind } from '@shared/types'

export interface StoreData {
  version: 2
  /** Accounts, in display order. */
  profiles: ProfileConfig[]
  /** Per-CLI overrides (binary / install command). */
  kinds: Partial<Record<ProfileKind, Partial<KindConfig>>>
  /** One-off migrations already applied (e.g. 'agy-import'). */
  migrations?: string[]
}

export const configPath = (): string => join(app.getPath('userData'), 'config.json')

/** Returns null when there is no usable v2 config yet (first launch, or a pre-v2 file). */
export function loadStore(): StoreData | null {
  const p = configPath()
  if (!existsSync(p)) return null
  try {
    const data = JSON.parse(readFileSync(p, 'utf8'))
    if (data?.version !== 2 || !Array.isArray(data.profiles)) return null
    return { version: 2, profiles: data.profiles, kinds: data.kinds ?? {}, migrations: data.migrations ?? [] }
  } catch (e) {
    console.error('[store] failed to parse config.json', e)
    return null
  }
}

export function saveStore(data: StoreData): void {
  const p = configPath()
  mkdirSync(dirname(p), { recursive: true })
  const tmp = p + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  renameSync(tmp, p)
}
