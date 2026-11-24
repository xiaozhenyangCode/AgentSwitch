import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { cleanTitle } from '@shared/markers'
import { expandHome } from '../profiles'
import type { ProfileConfig } from '@shared/types'
import { RATE_LIMIT_RE } from '../agentRunner'
import { agyConversationDb, withDb } from '../history'
import { t } from '../i18n'
import { sanitize } from './stderr'

const ERROR_MESSAGE = 17
const MAX_PAYLOAD = 16 * 1024

export interface AgyOutcome {
  error: string
  rateLimited: boolean
}

export function readAgyConversationTitle(cfg: ProfileConfig, id: string, home = expandHome(cfg.configDir)): string | null {
  if (!/^[\w-]+$/.test(id)) return null
  const dbPath = join(home, '.gemini', 'antigravity-cli', 'conversation_summaries.db')
  if (!existsSync(dbPath)) return null
  try {
    const row = withDb(dbPath, (db) => db.prepare('select title from conversation_summaries where conversation_id = ?').get(id) as { title?: unknown } | undefined)
    return cleanTitle(row?.title)
  } catch {
    return null
  }
}

export function agyOutcomeReader(cfg: ProfileConfig, id: string, onLog: (text: string) => void, home = expandHome(cfg.configDir)) {
  const path = /^[\w-]+$/.test(id) ? agyConversationDb({ ...cfg, configDir: home }, id) : null

  function read<T>(query: (db: DatabaseSync) => T): T | null {
    if (!path || !existsSync(path)) return null
    try {
      const result = withDb(path, query)
      if (result !== null) return result
    } catch {
      // The result still has a stop reason if the database is unavailable.
    }
    onLog(`[ACP] Could not read agy session steps (${id})\n`)
    return null
  }

  return {
    checkpoint(): number | null {
      if (!path) return null
      if (!existsSync(path)) return -1
      return read((db) => {
        const row = db.prepare('select max(idx) as idx from steps').get()
        return Number(row?.idx ?? -1)
      })
    },
    after(start: number | null): AgyOutcome | null {
      if (start === null) return null
      const last = read((db) => db.prepare('select step_type, substr(step_payload, 1, ?) as payload from steps where idx > ? order by idx desc limit 1').get(MAX_PAYLOAD, start) ?? {})
      if (last?.step_type !== ERROR_MESSAGE) return null
      const payload = last.payload instanceof Uint8Array ? Buffer.from(last.payload).toString('utf8') : String(last.payload ?? '')
      return interpretError(payload, home)
    }
  }
}

function interpretError(payload: string, home: string): AgyOutcome {
  const text = payload.replace(/[^\P{Cc}\n\t]/gu, ' ')
  if (/thinking\.signature:\s*Field required|Invalid `signature` in `thinking` block/i.test(text)) {
    return { error: t('main.acpThinkingHistory'), rateLimited: false }
  }

  const wide = /Error (\d{3}), Message: (.+?), Status: ([A-Z_]+|\d{3}[^,\n]*)/s.exec(text)
  const concise = /([A-Z_]+) \(code (\d{3})\): ([^\n]+)/.exec(text)
  const code = wide?.[1] ?? concise?.[2]
  const rateLimited = code === '429' || /\bHTTP\s+429\b|reason\s*:\s*QUOTA_EXHAUSTED|\bRESOURCE_EXHAUSTED\b/i.test(text) || RATE_LIMIT_RE.test(text)
  const readable = wide?.[0] ?? concise?.[0] ?? text.match(/[ -~\p{L}\p{N}]{4,}/gu)?.sort((a, b) => b.length - a.length)[0]
  const error = sanitize(readable ?? '', home).trim().slice(0, 2000) || t('main.acpUpstreamError')
  const reset = resetHint(text)
  return { error: reset ? `${error}\n${reset}` : error, rateLimited }
}

function resetHint(text: string): string | null {
  const stamp = /\bquotaResetTimeStamp:([^\s\]"',]+)/.exec(text)?.[1]
  if (stamp) {
    const instant = Date.parse(stamp)
    if (Number.isFinite(instant)) return t('main.acpResetAt', { time: new Date(instant).toISOString() })
  }

  const units: Record<string, number> = { h: 3600, m: 60, s: 1, ms: 1e-3, us: 1e-6, 'µs': 1e-6, 'μs': 1e-6, ns: 1e-9 }
  for (const field of ['quotaResetDelay', 'retryDelay']) {
    const duration = new RegExp(`\\b${field}:([^\\s\\]"',]+)`).exec(text)?.[1]
    if (!duration) continue
    const parts = [...duration.matchAll(/(\d+(?:\.\d+)?|\.\d+)(ms|us|µs|μs|ns|h|m|s)/g)]
    if (parts.map((p) => p[0]).join('') !== duration) continue
    const seconds = Math.ceil(parts.reduce((sum, [, amount, unit]) => sum + Number(amount) * units[unit], 0))
    if (!Number.isFinite(seconds)) continue
    return field === 'quotaResetDelay' ? t('main.acpResetDelay', { seconds }) : t('main.acpRetryDelay', { seconds })
  }
  return null
}
