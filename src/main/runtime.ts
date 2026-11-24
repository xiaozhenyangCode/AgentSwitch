import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { NodeRuntimeInfo } from '@shared/types'

/**
 * Bundled Node.js + npm fallback runtime for Macs without Node installed.
 *
 * - Read-only runtime lives inside the app bundle (`Contents/Resources/runtime` when packaged,
 *   or `build/runtime/mac-<arch>` in dev after `pnpm prepare:runtime`).
 * - Writable global npm installs go into `<userData>/runtime/npm-global`, so updating the
 *   app never wipes user-installed CLIs (`codex`, `reasonix`) and never touches the bundle.
 * - Both directories sit AFTER the user's own shell PATH and common Node managers, so machines
 *   with an existing Node/npm keep using theirs untouched.
 */

export interface BundledRuntime {
  root: string
  binDir: string
  nodePath: string
  npmPath: string
  npxPath: string
  version: string | null
}

export interface RuntimeResolveOptions {
  overrideDir?: string
  isPackaged?: boolean
  resourcesPath?: string
  appPath?: string
  platform?: string
  arch?: string
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

const safeUserData = (): string | null => {
  try {
    return typeof app?.getPath === 'function' ? app.getPath('userData') : null
  } catch {
    return null
  }
}

const safeIsPackaged = (): boolean => {
  try {
    return app?.isPackaged === true
  } catch {
    return false
  }
}

const safeAppPath = (): string | null => {
  try {
    return typeof app?.getAppPath === 'function' ? app.getAppPath() : null
  } catch {
    return null
  }
}

const realish = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

/** Resolves the bundled Node + npm runtime if present and intact; returns null otherwise. */
export function resolveBundledRuntime(opts: RuntimeResolveOptions = {}): BundledRuntime | null {
  const override = opts.overrideDir ?? process.env.AGENTSWITCH_BUNDLED_RUNTIME
  const platform = opts.platform ?? process.platform
  const arch = opts.arch ?? process.arch
  const osDir = platform === 'darwin' ? 'mac' : platform
  const isPackaged = opts.isPackaged ?? safeIsPackaged()

  const candidates: string[] = []
  if (override) candidates.push(resolve(override))
  else if (isPackaged) {
    const res = opts.resourcesPath ?? process.resourcesPath
    if (res) candidates.push(join(res, 'runtime'))
  } else {
    const appPath = opts.appPath ?? safeAppPath()
    if (appPath) candidates.push(join(appPath, 'build', 'runtime', `${osDir}-${arch}`))
  }

  for (const root of candidates) {
    const binDir = join(root, 'bin')
    const nodePath = join(binDir, 'node')
    const npmPath = join(binDir, 'npm')
    const npxPath = join(binDir, 'npx')
    if (!isFile(nodePath) || !isFile(npmPath)) continue
    let version: string | null = null
    try {
      const raw = readFileSync(join(root, '.version'), 'utf8').trim()
      if (raw) version = raw.replace(/^v/, '')
    } catch {
      /* optional marker */
    }
    return { root, binDir, nodePath, npmPath, npxPath, version }
  }
  return null
}

/** Persistent writable prefix for `npm install -g` when using the bundled npm. */
export function npmGlobalPrefix(userData = safeUserData()): string | null {
  return userData ? join(userData, 'runtime', 'npm-global') : null
}

export function npmGlobalBin(userData = safeUserData()): string | null {
  const prefix = npmGlobalPrefix(userData)
  return prefix ? join(prefix, 'bin') : null
}

export function npmCacheDir(userData = safeUserData()): string | null {
  return userData ? join(userData, 'runtime', 'npm-cache') : null
}

/**
 * Fallback bin directories appended AFTER the user's own PATH and common install locations:
 * 1. `<userData>/runtime/npm-global/bin` (if created) — CLIs installed via bundled npm
 * 2. `<runtime>/bin` (if bundled) — fallback `node` / `npm` / `npx`
 */
export function runtimeFallbackPaths(userData = safeUserData(), bundled = resolveBundledRuntime()): string[] {
  const out: string[] = []
  const globalBin = npmGlobalBin(userData)
  if (globalBin && isDir(globalBin)) out.push(globalBin)
  if (bundled && isDir(bundled.binDir)) out.push(bundled.binDir)
  return out
}

/** True when a resolved executable path points inside the bundled runtime's bin directory. */
export function isBundledTool(toolPath: string | null, bundled = resolveBundledRuntime()): boolean {
  if (!toolPath || !bundled) return false
  const dir = realish(bundled.binDir)
  const target = realish(toolPath)
  const raw = resolve(toolPath)
  const rawDir = resolve(bundled.binDir)
  return (
    target === dir ||
    target.startsWith(dir.endsWith(sep) ? dir : dir + sep) ||
    raw === rawDir ||
    raw.startsWith(rawDir.endsWith(sep) ? rawDir : rawDir + sep)
  )
}

/**
 * Prepares the writable npm prefix + cache under `userData` and returns the install env.
 * Keeps `HOME` (so `~/.npmrc` registry/auth/proxy settings still apply) and all proxy vars intact.
 */
export function bundledNpmInstallEnv(
  baseEnv: Record<string, string>,
  opts: { userData?: string | null; bundled?: BundledRuntime | null; createDirs?: boolean } = {}
): { env: Record<string, string>; prefix: string; injected: Record<string, string> } {
  const userData = opts.userData ?? safeUserData()
  const bundled = opts.bundled ?? resolveBundledRuntime()
  const prefix = npmGlobalPrefix(userData)
  const cache = npmCacheDir(userData)
  if (!prefix || !cache || !bundled) throw new Error('Bundled runtime is not available')

  const bin = join(prefix, 'bin')
  if (opts.createDirs !== false) {
    mkdirSync(bin, { recursive: true })
    mkdirSync(cache, { recursive: true })
  }

  const pathParts = new Set<string>([bin, bundled.binDir, ...(baseEnv.PATH ?? '').split(':').filter(Boolean)])
  const injected: Record<string, string> = {
    npm_config_prefix: prefix,
    npm_config_cache: cache
  }
  const env: Record<string, string> = {
    ...baseEnv,
    ...injected,
    PATH: [...pathParts].join(':')
  }
  return { env, prefix, injected }
}

/** Reports which Node.js runtime CLIs & MCP servers currently resolve to (zero process spawns). */
export function cliNodeRuntime(nodeOnPath: string | null, bundled = resolveBundledRuntime()): NodeRuntimeInfo {
  if (!nodeOnPath || !existsSync(nodeOnPath)) return { source: 'none', version: null, path: null }
  if (isBundledTool(nodeOnPath, bundled)) {
    return { source: 'bundled', version: bundled?.version ?? null, path: nodeOnPath }
  }
  return { source: 'system', version: null, path: nodeOnPath }
}
