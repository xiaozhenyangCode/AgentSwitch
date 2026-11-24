import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bundledNpmInstallEnv,
  cliNodeRuntime,
  isBundledTool,
  npmGlobalBin,
  npmGlobalPrefix,
  resolveBundledRuntime,
  runtimeFallbackPaths
} from './runtime'

let dir: string

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => dir,
    getAppPath: () => dir
  }
}))

function createFakeRuntime(root: string, version = '22.23.5'): void {
  const bin = join(root, 'bin')
  const npmBin = join(root, 'lib', 'node_modules', 'npm', 'bin')
  mkdirSync(bin, { recursive: true })
  mkdirSync(npmBin, { recursive: true })
  writeFileSync(join(bin, 'node'), '#!/bin/sh\necho v' + version + '\n', { mode: 0o755 })
  writeFileSync(join(npmBin, 'npm-cli.js'), '#!/usr/bin/env node\n', { mode: 0o755 })
  writeFileSync(join(npmBin, 'npx-cli.js'), '#!/usr/bin/env node\n', { mode: 0o755 })
  symlinkSync('../lib/node_modules/npm/bin/npm-cli.js', join(bin, 'npm'))
  symlinkSync('../lib/node_modules/npm/bin/npx-cli.js', join(bin, 'npx'))
  writeFileSync(join(root, '.version'), `${version}\n`, 'utf8')
}

function createArchivedRuntime(root: string, version = '22.23.5'): void {
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'node'), '#!/bin/sh\necho v' + version + '\n', { mode: 0o755 })
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\necho 10.9.4\n', { mode: 0o755 })
  writeFileSync(join(bin, 'npx'), '#!/bin/sh\necho 10.9.4\n', { mode: 0o755 })
  writeFileSync(join(root, 'npm.tar.gz'), 'fake-tarball')
  writeFileSync(join(root, '.version'), `${version}\n`, 'utf8')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentswitch-runtime-test-'))
})

afterEach(() => {
  delete process.env.AGENTSWITCH_BUNDLED_RUNTIME
  delete process.env.AGENTSWITCH_CLEAN_PATH
  rmSync(dir, { recursive: true, force: true })
})

describe('bundled Node.js runtime', () => {
  it('resolves packaged and dev runtimes and returns null when incomplete', () => {
    expect(resolveBundledRuntime({ isPackaged: true, resourcesPath: dir })).toBeNull()

    const packaged = join(dir, 'packaged-res')
    createFakeRuntime(join(packaged, 'runtime'), '22.23.5')
    const found = resolveBundledRuntime({ isPackaged: true, resourcesPath: packaged })
    expect(found).toMatchObject({
      root: join(packaged, 'runtime'),
      binDir: join(packaged, 'runtime', 'bin'),
      version: '22.23.5'
    })

    const devApp = join(dir, 'dev-app')
    createFakeRuntime(join(devApp, 'build', 'runtime', 'mac-arm64'), '22.23.5')
    expect(resolveBundledRuntime({ isPackaged: false, appPath: devApp, platform: 'darwin', arch: 'arm64' })?.version).toBe('22.23.5')

    const broken = join(dir, 'broken')
    mkdirSync(join(broken, 'bin'), { recursive: true })
    writeFileSync(join(broken, 'bin', 'node'), '', { mode: 0o755 })
    expect(resolveBundledRuntime({ overrideDir: broken })).toBeNull()

    const missingPayload = join(dir, 'missing-payload')
    mkdirSync(join(missingPayload, 'bin'), { recursive: true })
    writeFileSync(join(missingPayload, 'bin', 'node'), '', { mode: 0o755 })
    writeFileSync(join(missingPayload, 'bin', 'npm'), '', { mode: 0o755 })
    writeFileSync(join(missingPayload, 'bin', 'npx'), '', { mode: 0o755 })
    expect(resolveBundledRuntime({ overrideDir: missingPayload })).toBeNull()

    const archived = join(dir, 'archived-rt')
    createArchivedRuntime(archived, '22.23.5')
    const foundArchived = resolveBundledRuntime({ overrideDir: archived })
    expect(foundArchived).toMatchObject({
      root: archived,
      binDir: join(archived, 'bin'),
      version: '22.23.5'
    })
    expect(isBundledTool(foundArchived!.npmPath, foundArchived)).toBe(true)
    expect(isBundledTool(foundArchived!.npxPath, foundArchived)).toBe(true)
  })

  it('orders fallback paths with npm-global/bin before bundled runtime/bin', () => {
    const rtDir = join(dir, 'rt')
    createFakeRuntime(rtDir)
    const bundled = resolveBundledRuntime({ overrideDir: rtDir })!
    const userData = join(dir, 'userdata')

    expect(runtimeFallbackPaths(userData, bundled)).toEqual([bundled.binDir])

    const globalBin = npmGlobalBin(userData)!
    mkdirSync(globalBin, { recursive: true })
    expect(runtimeFallbackPaths(userData, bundled)).toEqual([globalBin, bundled.binDir])
  })

  it('detects bundled vs system node executables including symlinks', () => {
    const rtDir = join(dir, 'rt')
    createFakeRuntime(rtDir)
    const bundled = resolveBundledRuntime({ overrideDir: rtDir })!
    const sysNode = join(dir, 'sys-node')
    writeFileSync(sysNode, '', { mode: 0o755 })

    expect(isBundledTool(bundled.nodePath, bundled)).toBe(true)
    expect(isBundledTool(bundled.npmPath, bundled)).toBe(true)
    expect(isBundledTool(sysNode, bundled)).toBe(false)

    expect(cliNodeRuntime(bundled.nodePath, bundled)).toEqual({ source: 'bundled', version: '22.23.5', path: bundled.nodePath })
    expect(cliNodeRuntime(sysNode, bundled)).toEqual({ source: 'system', version: null, path: sysNode })
    expect(cliNodeRuntime(null, bundled)).toEqual({ source: 'none', version: null, path: null })
  })

  it('prepares writable npm prefix/cache while preserving HOME (~/.npmrc) and proxy vars', () => {
    const rtDir = join(dir, 'rt')
    createFakeRuntime(rtDir)
    const bundled = resolveBundledRuntime({ overrideDir: rtDir })!
    const userData = join(dir, 'userdata')
    const base = {
      HOME: '/Users/example',
      PATH: '/usr/bin:/bin',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      HTTP_PROXY: 'http://127.0.0.1:7890',
      NO_PROXY: 'localhost,127.0.0.1'
    }

    const preview = bundledNpmInstallEnv(base, { userData, bundled, createDirs: false })
    expect(existsSync(preview.prefix)).toBe(false)
    expect(preview.env.HOME).toBe('/Users/example')
    expect(preview.env.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
    expect(preview.env.HTTP_PROXY).toBe('http://127.0.0.1:7890')
    expect(preview.env.NO_PROXY).toBe('localhost,127.0.0.1')
    expect(preview.env.npm_config_prefix).toBe(npmGlobalPrefix(userData))
    expect(preview.env.npm_config_cache).toBe(join(userData, 'runtime', 'npm-cache'))
    expect(preview.env.PATH.split(':').slice(0, 2)).toEqual([npmGlobalBin(userData), bundled.binDir])

    const prepared = bundledNpmInstallEnv(base, { userData, bundled })
    expect(existsSync(join(prepared.prefix, 'bin'))).toBe(true)
    expect(existsSync(prepared.env.npm_config_cache)).toBe(true)
  })

  it('integrates cleanly with shellEnv in clean-Mac mode and refreshes PATH after install', async () => {
    const rtDir = join(dir, 'rt')
    createFakeRuntime(rtDir)
    process.env.AGENTSWITCH_BUNDLED_RUNTIME = rtDir
    process.env.AGENTSWITCH_CLEAN_PATH = '1'

    vi.resetModules()
    const shellEnv = await import('./shellEnv')
    await shellEnv.initShellEnv(join(dir, 'shell-env.json'), () => {})

    expect(shellEnv.findOnPath('node')).toBe(join(rtDir, 'bin', 'node'))
    expect(shellEnv.findOnPath('npm')).toBe(join(rtDir, 'bin', 'npm'))
    expect(shellEnv.getBaseEnv().AGENTSWITCH_CLEAN_PATH).toBeUndefined()
    expect(shellEnv.getBaseEnv().AGENTSWITCH_BUNDLED_RUNTIME).toBeUndefined()

    const globalBin = npmGlobalBin(dir)!
    mkdirSync(globalBin, { recursive: true })
    writeFileSync(join(globalBin, 'codex'), '#!/usr/bin/env node\n', { mode: 0o755 })
    shellEnv.refreshRuntimePaths()
    expect(shellEnv.findOnPath('codex')).toBe(join(globalBin, 'codex'))
  })
})
