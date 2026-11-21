import { app } from 'electron'
import { cpSync, existsSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

/**
 * AgentSwitch was called AgentMux. Everything here keeps data from that name working:
 * the old userData folder, the old project run folder and the old image protocol.
 */

/**
 * Development / testing: AGENTSWITCH_USER_DATA points userData at a scratch folder (with
 * AGENTSWITCH_HOME this simulates a brand-new Mac). No AgentMux migration happens then.
 */
const testUserData = process.env.AGENTSWITCH_USER_DATA
if (testUserData) app.setPath('userData', testUserData)

/** userData of the AgentMux era (left in place after migration, never deleted). */
export const LEGACY_USER_DATA = join(app.getPath('appData'), 'agentmux')
/** Project run folder of the AgentMux era (old runs / outputs / handoffs stay readable). */
export const LEGACY_PROJECT_DIR = '.agentmux'
export const LEGACY_FILE_SCHEME = 'agentmux-file'

/** Chromium caches and per-process files: rebuilt on demand, never copied. */
const SKIP = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'GPUPersistentCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GraphiteDawnCache',
  'ShaderCache',
  'Crashpad',
  'blob_storage',
  'DevToolsActivePort',
  'SingletonLock',
  'SingletonSocket',
  'SingletonCookie',
  // private workspaces stay where they are: CLI sessions are keyed by their path (see threadCwd)
  'workspaces',
  'usage-probe'
])

const same = (a: string, b: string): boolean => {
  try {
    return realpathSync(a).toLowerCase() === realpathSync(b).toLowerCase()
  } catch {
    return a.toLowerCase() === b.toLowerCase()
  }
}

/**
 * One-time copy of the AgentMux userData (accounts, threads, chat history in Local Storage,
 * usage stats, quota and model caches) into the AgentSwitch userData. Runs before the app is
 * ready, only while the new folder has no config.json yet. The old folder is kept.
 */
export function migrateUserData(): void {
  const dst = app.getPath('userData')
  const src = LEGACY_USER_DATA
  if (testUserData) return
  if (existsSync(join(dst, 'config.json')) || !existsSync(join(src, 'config.json')) || same(src, dst)) return
  try {
    // config.json last: an interrupted copy is retried on the next start
    const names = readdirSync(src).sort((a, b) => Number(a === 'config.json') - Number(b === 'config.json'))
    for (const name of names) {
      if (SKIP.has(name) || name.startsWith('Singleton')) continue
      const to = join(dst, name)
      if (existsSync(to)) continue
      cpSync(join(src, name), to, { recursive: true, verbatimSymlinks: true, errorOnExist: false, force: false })
    }
    console.log(`[migrate] copied AgentMux data from ${src} to ${dst}`)
  } catch (e) {
    console.error('[migrate] userData migration failed', e)
  }
}

// runs on import: index.ts imports this module first, before anything reads userData (usage.ts loads at import)
migrateUserData()
