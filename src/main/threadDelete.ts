import { app, shell } from 'electron'
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, sep } from 'node:path'
import type { DeleteThreadRequest, DeleteThreadResult, ProfileConfig } from '@shared/types'
import { expandHome, getConfig, hasProfile } from './profiles'
import { agyConversationDb, deletedSessions, listHistory } from './history'

/**
 * Deleting a chat thread for real:
 *  - always: AgentMux's own data (threads/<id>.json, the private workspace, and this thread's
 *    .agentmux/{runs,outputs,handoffs} entries in the project);
 *  - AgentMux-created CLI sessions are remembered in deleted-sessions.json so they stay out of
 *    「本机历史」(imported sessions are the user's own and simply show up there again);
 *  - purgeCli: the native CLI session files are moved to the macOS Trash (recoverable).
 * Usage statistics are never touched.
 */

const userData = () => app.getPath('userData')
const safeId = (s: string) => s.replace(/[^\w-]/g, '')
const tombstoneFile = () => join(userData(), 'deleted-sessions.json')

function addTombstones(ids: string[]): void {
  if (!ids.length) return
  const all = deletedSessions()
  for (const id of ids) all.add(id)
  writeFileSync(tombstoneFile(), JSON.stringify([...all], null, 2))
}

const real = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}
/** p is strictly inside dir (after resolving symlinks such as ~/.claude2/projects). */
const inside = (p: string, dir: string): boolean => {
  const a = real(p)
  const b = real(dir)
  return a !== b && a.startsWith(b.endsWith(sep) ? b : b + sep)
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** Native files of one CLI session (never the config dir itself). */
function nativeFiles(cfg: ProfileConfig, sid: string): { root: string; files: string[] } {
  const home = expandHome(cfg.configDir)
  if (!sid || sid.length < 8 || /[/\\]/.test(sid)) return { root: home, files: [] }
  if (cfg.kind === 'claude') {
    const root = join(home, 'projects')
    const files: string[] = []
    for (const proj of listDir(root)) {
      const base = join(root, proj, sid)
      if (existsSync(base + '.jsonl')) files.push(base + '.jsonl')
      if (existsSync(base)) files.push(base) // tool-result / subagent folder
    }
    return { root, files }
  }
  if (cfg.kind === 'codex') {
    const files: string[] = []
    const walk = (dir: string, depth: number) => {
      for (const n of listDir(dir)) {
        const p = join(dir, n)
        if (n.endsWith('.jsonl') && n.includes(sid)) files.push(p)
        else if (depth > 0 && !n.includes('.')) walk(p, depth - 1)
      }
    }
    walk(join(home, 'sessions'), 3)
    walk(join(home, 'archived_sessions'), 1)
    return { root: home, files }
  }
  const db = agyConversationDb(cfg, sid)
  const root = join(db, '..', '..')
  const files = [db, db + '-wal', db + '-shm', join(root, 'brain', sid)].filter((p) => existsSync(p))
  return { root, files }
}

export async function deleteThreadData(req: DeleteThreadRequest): Promise<DeleteThreadResult> {
  const id = safeId(req.threadId)
  if (!id) throw new Error('bad thread id')
  const result: DeleteThreadResult = { removed: 0, trashed: [], failed: [] }
  const rm = (p: string) => {
    if (!existsSync(p)) return
    rmSync(p, { recursive: true, force: true })
    result.removed++
  }

  // 1. per-thread session map
  const mapFile = join(userData(), 'threads', `${id}.json`)
  let sessions: Record<string, string> = {}
  let imported = new Set<string>()
  try {
    const j = JSON.parse(readFileSync(mapFile, 'utf8'))
    sessions = j.sessions ?? {}
    imported = new Set(j.imported ?? [])
  } catch {
    /* thread never ran */
  }

  // 2. run artefacts: private workspace, or this thread's turns inside the project's .agentmux
  rm(join(userData(), 'workspaces', id))
  if (req.projectDir && isAbsolute(req.projectDir) && existsSync(req.projectDir) && statSync(req.projectDir).isDirectory()) {
    const base = join(req.projectDir, '.agentmux')
    for (const t of req.turnIds.map(safeId).filter(Boolean)) {
      rm(join(base, 'runs', t))
      rm(join(base, 'outputs', t))
      rm(join(base, 'handoffs', `${t}.md`))
    }
  }

  // 3. native CLI sessions
  const entries = Object.entries(sessions).filter(([, sid]) => typeof sid === 'string' && sid)
  if (req.purgeCli) {
    for (const [profileId, sid] of entries) {
      if (!hasProfile(profileId)) continue
      const { root, files } = nativeFiles(getConfig(profileId), sid)
      for (const f of files) {
        if (!inside(f, root)) continue
        try {
          await shell.trashItem(f)
          result.trashed.push(f)
        } catch {
          result.failed.push(f)
        }
      }
    }
    addTombstones(entries.map(([, sid]) => sid))
  } else {
    addTombstones(entries.filter(([, sid]) => !imported.has(sid)).map(([, sid]) => sid))
  }

  rm(mapFile)
  setImmediate(() => listHistory(true))
  return result
}
