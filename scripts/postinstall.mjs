// Ensures native bits are ready for Electron after `pnpm install`:
// 1. Electron binary downloaded (pnpm may skip/interrupt electron's own install script)
// 2. node-pty rebuilt against Electron's ABI
// 3. node-pty spawn-helper is executable (prebuilds ship it without +x -> "posix_spawnp failed")
import { execSync } from 'node:child_process'
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const run = (cmd) => execSync(cmd, { stdio: 'inherit' })

const electronDir = dirname(require.resolve('electron/package.json'))
if (!existsSync(join(electronDir, 'path.txt'))) {
  console.log('[postinstall] downloading Electron binary...')
  // Electron's installer downloads with Node's built-in fetch, which ignores HTTP(S)_PROXY
  // unless NODE_USE_ENV_PROXY=1 (Node 24+; older Node ignores the flag). Without it, a
  // proxy-only network fails with "fetch failed".
  const proxied = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some((k) => process.env[k])
  execSync(`node "${join(electronDir, 'install.js')}"`, {
    stdio: 'inherit',
    env: proxied ? { NODE_USE_ENV_PROXY: '1', ...process.env } : process.env
  })
}

console.log('[postinstall] rebuilding node-pty for Electron...')
run('electron-rebuild -f -w node-pty')

const ptyDir = dirname(require.resolve('node-pty/package.json'))
const helpers = [join(ptyDir, 'build', 'Release', 'spawn-helper')]
const prebuilds = join(ptyDir, 'prebuilds')
if (existsSync(prebuilds)) {
  for (const d of readdirSync(prebuilds)) helpers.push(join(prebuilds, d, 'spawn-helper'))
}
for (const h of helpers) {
  if (existsSync(h)) chmodSync(h, 0o755)
}
console.log('[postinstall] done')
