#!/usr/bin/env node
/**
 * Downloads, verifies (SHA-256), trims, and stages a standalone Node.js + npm LTS runtime
 * into `build/runtime/mac-<arch>/` for bundling into `AgentSwitch.app/Contents/Resources/runtime`.
 *
 * Cached under `.cache/node-runtime/` so repeated `pnpm dist` builds do not re-download.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NODE_VERSION = '22.23.5'
const CHECKSUMS = {
  'darwin-arm64': 'e7131995759b61a0170b646010d2ad35a5d37b4cb0d471f3e8317eac6f742f3d',
  'darwin-x64': 'c53383238206b9ae4db23c5d8a63645e2e753bec8ab51a49cc81939aa64e9422'
}

const args = process.argv.slice(2)
const argValue = (flag, fallback) => {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const arch = argValue('--arch', process.arch)
const platform = argValue('--platform', process.platform)
const force = args.includes('--force')

if (platform !== 'darwin') {
  console.log(`[prepare-runtime] Skipping non-macOS platform: ${platform}`)
  process.exit(0)
}

const key = `${platform}-${arch}`
const expectedSha = CHECKSUMS[key]
if (!expectedSha) {
  console.error(`[prepare-runtime] Unsupported target: ${key} (supported: ${Object.keys(CHECKSUMS).join(', ')})`)
  process.exit(1)
}

const tarballName = `node-v${NODE_VERSION}-${key}.tar.gz`
const downloadUrl = `https://nodejs.org/dist/v${NODE_VERSION}/${tarballName}`
const cacheDir = join(ROOT, '.cache', 'node-runtime')
const tarballPath = join(cacheDir, tarballName)
// electron-builder's `${os}` resolves to `mac` on macOS.
const outDir = join(ROOT, 'build', 'runtime', `mac-${arch}`)
const versionMarker = join(outDir, '.version')

async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

function alreadyPrepared() {
  if (force || !existsSync(versionMarker)) return false
  if (readFileSync(versionMarker, 'utf8').trim() !== NODE_VERSION) return false
  return existsSync(join(outDir, 'bin', 'node')) && existsSync(join(outDir, 'bin', 'npm')) && existsSync(join(outDir, 'bin', 'npx'))
}

async function ensureTarball() {
  mkdirSync(cacheDir, { recursive: true })
  if (existsSync(tarballPath)) {
    const actual = await sha256(tarballPath)
    if (actual === expectedSha) return
    console.warn(`[prepare-runtime] Cached tarball checksum mismatch, re-downloading ${tarballName}`)
    rmSync(tarballPath, { force: true })
  }
  const tmp = `${tarballPath}.tmp`
  rmSync(tmp, { force: true })
  console.log(`[prepare-runtime] Downloading ${downloadUrl} ...`)
  execFileSync('curl', ['-fsSL', '--retry', '3', '--retry-delay', '2', '-o', tmp, downloadUrl], { stdio: 'inherit' })
  const actual = await sha256(tmp)
  if (actual !== expectedSha) {
    rmSync(tmp, { force: true })
    throw new Error(`SHA-256 mismatch for ${tarballName}: expected ${expectedSha}, got ${actual}`)
  }
  renameSync(tmp, tarballPath)
}

function trimRuntime(dir) {
  const remove = [
    'include',
    'share',
    'CHANGELOG.md',
    'README.md',
    join('bin', 'corepack'),
    join('lib', 'node_modules', 'corepack'),
    join('lib', 'node_modules', 'npm', 'docs'),
    join('lib', 'node_modules', 'npm', 'man')
  ]
  for (const rel of remove) rmSync(join(dir, rel), { recursive: true, force: true })
}

async function main() {
  if (alreadyPrepared()) {
    console.log(`[prepare-runtime] Node v${NODE_VERSION} (${key}) already staged at ${outDir}`)
    return
  }

  await ensureTarball()

  const stageParent = join(ROOT, 'build', 'runtime')
  mkdirSync(stageParent, { recursive: true })
  const stage = join(stageParent, `.stage-mac-${arch}-${process.pid}`)
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })

  try {
    console.log(`[prepare-runtime] Extracting ${tarballName} ...`)
    execFileSync('tar', ['-xzf', tarballPath, '-C', stage, '--strip-components=1'], { stdio: 'inherit' })
    trimRuntime(stage)

    chmodSync(join(stage, 'bin', 'node'), 0o755)
    chmodSync(join(stage, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), 0o755)
    chmodSync(join(stage, 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'), 0o755)
    writeFileSync(join(stage, '.version'), `${NODE_VERSION}\n`, 'utf8')

    // Self-check on matching host architecture
    if (arch === process.arch) {
      const nodeVer = execFileSync(join(stage, 'bin', 'node'), ['-v'], { encoding: 'utf8' }).trim()
      if (nodeVer !== `v${NODE_VERSION}`) throw new Error(`Unexpected bundled node version: ${nodeVer}`)
      const npmVer = execFileSync(join(stage, 'bin', 'npm'), ['-v'], {
        encoding: 'utf8',
        env: { PATH: `${join(stage, 'bin')}:/usr/bin:/bin` }
      }).trim()
      console.log(`[prepare-runtime] Verified bundled runtime: node ${nodeVer}, npm v${npmVer}`)
    }

    rmSync(outDir, { recursive: true, force: true })
    renameSync(stage, outDir)
    console.log(`[prepare-runtime] Staged at ${outDir}`)
  } catch (err) {
    rmSync(stage, { recursive: true, force: true })
    throw err
  }
}

main().catch((err) => {
  console.error('[prepare-runtime] Failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
