import { app, protocol } from 'electron'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, parse, sep } from 'node:path'

/**
 * `agentswitch-file://f/<base64url(absolute path)>` — read-only access to images inside
 * project folders the user picked (or AgentSwitch workspaces). Every request is checked:
 *   GET only · realpath must stay inside an allowed root (no `..` / symlink escape) ·
 *   image extensions only · size cap · nosniff. SVG is served with a locked-down CSP
 *   (no script, no external loads) so markup inside it can't run or phone home.
 */

export const FILE_SCHEME = 'agentswitch-file'
const MAX_BYTES = 25 * 1024 * 1024
const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
}
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'"

const rootsFile = (): string => join(app.getPath('userData'), 'allowed-roots.json')
let roots: string[] = []
/** Single files the user attached to a message (they may live anywhere): previewable, not their folders. */
const filesFile = (): string => join(app.getPath('userData'), 'allowed-files.json')
let files: string[] = []
const FILES_MAX = 2000

export const attachmentsDir = (userData = app.getPath('userData')): string => join(userData, 'attachments')

export function ensureAttachmentsDir(userData?: string): string {
  const dir = attachmentsDir(userData)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (!lstatSync(dir).isDirectory()) throw new Error('Invalid attachment directory')
  return dir
}

/** Must run before app 'ready'. */
export function registerFileScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: FILE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }])
}

const inside = (p: string, root: string): boolean => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)

const allowedReal = (real: string): boolean => roots.some((r) => inside(real, r)) || files.includes(real)

export function isAllowedPath(p: string): boolean {
  if (!isAbsolute(p)) return false
  try {
    return allowedReal(realpathSync(p))
  } catch {
    return false
  }
}

/** The editor receives canonical paths and checks workspace grants separately from attachment grants. */
export function isAllowedEditorWorkspace(realDir: string): boolean {
  return roots.includes(realDir)
}

export function isAllowedEditorAttachment(realPath: string): boolean {
  if (files.includes(realPath)) return true
  try {
    const root = realpathSync(attachmentsDir())
    return roots.includes(root) && realPath !== root && inside(realPath, root)
  } catch {
    return false
  }
}

/** Allow-lists one attached file (resolved through symlinks); persisted, newest kept. */
export function allowFile(p: string): void {
  if (!isAbsolute(p)) return
  let real: string
  try {
    real = realpathSync(p)
  } catch {
    return
  }
  if (files.includes(real)) return
  files = [...files, real].slice(-FILES_MAX)
  try {
    writeFileSync(filesFile(), JSON.stringify(files, null, 2))
  } catch (e) {
    console.warn('[file-protocol] persist files failed', e)
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
  if (real === parse(real).root || roots.includes(real)) return
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
    roots = existsSync(rootsFile())
      ? (JSON.parse(readFileSync(rootsFile(), 'utf8')) as string[]).filter((r) =>
        typeof r === 'string' && isAbsolute(r) && r !== parse(r).root)
      : []
  } catch {
    roots = []
  }
  try {
    files = existsSync(filesFile())
      ? (JSON.parse(readFileSync(filesFile(), 'utf8')) as string[]).filter((f) => typeof f === 'string' && isAbsolute(f))
      : []
  } catch {
    files = []
  }
  try {
    allowRoot(ensureAttachmentsDir())
  } catch (error) {
    console.warn('[file-protocol] could not initialize attachments directory', error)
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
    if (!allowedReal(real)) return reply(403)
    try {
      const st = await stat(real)
      if (!st.isFile()) return reply(404)
      if (st.size > MAX_BYTES) return reply(413)
      const headers: Record<string, string> = { 'content-type': mime, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' }
      if (mime === 'image/svg+xml') headers['content-security-policy'] = SVG_CSP
      return new Response(await readFile(real), { headers })
    } catch {
      return reply(500)
    }
  })
}
