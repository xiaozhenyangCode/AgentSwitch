// node-pty's spawn-helper must stay executable inside app.asar.unpacked, or every pty spawn
// fails with "posix_spawnp failed". Also verify the bundled Node/npm runtime permissions.
const { chmodSync, existsSync, readdirSync } = require('node:fs')
const { join } = require('node:path')

exports.default = async function afterPack(ctx) {
  const app = join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`)
  const resources = join(app, 'Contents', 'Resources')
  const pty = join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty')
  const helpers = [join(pty, 'build', 'Release', 'spawn-helper')]
  const prebuilds = join(pty, 'prebuilds')
  if (existsSync(prebuilds)) for (const d of readdirSync(prebuilds)) helpers.push(join(prebuilds, d, 'spawn-helper'))
  for (const h of helpers) if (existsSync(h)) chmodSync(h, 0o755)

  const runtime = join(resources, 'runtime')
  const nodeBin = join(runtime, 'bin', 'node')
  const npmCli = join(runtime, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const npxCli = join(runtime, 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js')
  if (!existsSync(nodeBin) || !existsSync(npmCli) || !existsSync(npxCli)) {
    throw new Error(`[afterPack] Bundled Node runtime incomplete at ${runtime}. Run "pnpm prepare:runtime" first.`)
  }
  chmodSync(nodeBin, 0o755)
  chmodSync(npmCli, 0o755)
  chmodSync(npxCli, 0o755)
}
