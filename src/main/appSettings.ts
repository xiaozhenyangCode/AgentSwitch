import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** userData/settings.json: small app-wide flags (UI language, onboarding). Merged on write. */
const file = (): string => join(app.getPath('userData'), 'settings.json')

export function readSettings(): Record<string, unknown> {
  try {
    const j = JSON.parse(readFileSync(file(), 'utf8'))
    return j && typeof j === 'object' ? j : {}
  } catch {
    return {}
  }
}

export function writeSettings(patch: Record<string, unknown>): void {
  try {
    writeFileSync(file(), JSON.stringify({ ...readSettings(), ...patch }, null, 2))
  } catch (err) {
    console.error('[settings] save failed', err)
  }
}
