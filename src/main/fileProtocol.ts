import { app, protocol } from 'electron'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, sep } from 'node:path'

/**
 * `agentmux-file://f/<base64url(absolute path)>` — read-only access to images inside
 * project folders the user picked (or AgentMux workspaces). Every request is checked:
 *   GET only · realpath must stay inside an allowed root (no `..` / symlink escape) ·
 *   image extensions only (no SVG: it can carry script) · size cap · nosniff.
 */

export const FILE_SCHEME = 'agentmux-file'
const MAX_BYTES = 25 * 1024 * 1024
const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

const rootsFile = (): string => join(app.getPath('userData'), 'allowed-roots.json')
let roots: string[] = []

/** Must run before app 'ready'. */
export function registerFileScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: FILE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }])
}

const inside = (p: string, root: string): boolean => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)

export function isAllowedPath(p: string): boolean {
  if (!isAbsolute(p)) return false
  try {
    const real = realpathSync(p)
    return roots.some((r) => inside(real, r))
  } catch {
    return false
  }
}

/** Adds a folder (resolved through symlinks) to the allowlist; persisted. */
export function allowRoot(dir: string): void {
  let real: string
  try {
    real = realpathSync(dir)
  } catch {
    return
  }
  if (real === '/' || roots.includes(real)) return
  roots.push(real)
  try {
    writeFileSync(rootsFile(), JSON.stringify(roots, null, 2))
  } catch (e) {
    console.warn('[file-protocol] persist roots failed', e)
  }
}

const reply = (status: number): Response => new Response(null, { status })

export function handleFileProtocol(): void {
  try {
    if (existsSync(rootsFile())) roots = (JSON.parse(readFileSync(rootsFile(), 'utf8')) as string[]).filter((r) => typeof r === 'string' && r !== '/')
  } catch {
    roots = []
  }
  protocol.handle(FILE_SCHEME, async (req) => {
    if (req.method !== 'GET') return reply(405)
    let p: string
    try {
      p = Buffer.from(new URL(req.url).pathname.slice(1), 'base64url').toString('utf8')
    } catch {
      return reply(400)
    }
    if (!isAbsolute(p) || p.includes('\0')) return reply(400)
    let real: string
    try {
      real = await realpath(p)
    } catch {
      return reply(404)
    }
    const mime = MIME[extname(real).toLowerCase()]
    if (!mime) return reply(415)
    if (!roots.some((r) => inside(real, r))) return reply(403)
    try {
      const st = await stat(real)
      if (!st.isFile()) return reply(404)
      if (st.size > MAX_BYTES) return reply(413)
      return new Response(await readFile(real), {
        headers: { 'content-type': mime, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' }
      })
    } catch {
      return reply(500)
    }
  })
}
