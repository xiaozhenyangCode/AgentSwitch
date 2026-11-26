// node-pty's spawn-helper must stay executable inside app.asar.unpacked, or every pty spawn
// fails with "posix_spawnp failed". Also verify the bundled Node/npm runtime permissions.
const { chmodSync, existsSync, readdirSync, statSync } = require('node:fs')
const { join } = require('node:path')

exports.default = async function afterPack(ctx) {
  const app = join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`)
  const resources = join(app, 'Contents', 'Resources')
  for (const name of ['Assets.car', 'icon.icns']) {
    const icon = statSync(join(resources, name), { throwIfNoEntry: false })
    if (!icon?.isFile() || !icon.size) {
      throw new Error(`[afterPack] Missing packaged icon ${name}. Run "npm run build:icons" first.`)
    }
  }
  const pty = join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty')
  const helpers = [join(pty, 'build', 'Release', 'spawn-helper')]
  const prebuilds = join(pty, 'prebuilds')
  if (existsSync(prebuilds)) for (const d of readdirSync(prebuilds)) helpers.push(join(prebuilds, d, 'spawn-helper'))
  for (const h of helpers) if (existsSync(h)) chmodSync(h, 0o755)

  const runtime = join(resources, 'runtime')
  const nodeBin = join(runtime, 'bin', 'node')
  const npmBin = join(runtime, 'bin', 'npm')
  const npxBin = join(runtime, 'bin', 'npx')
  const npmArchive = join(runtime, 'npm.tar.gz')
  const npmCli = join(runtime, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const npxCli = join(runtime, 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js')
  const hasArchivedNpm = existsSync(npmArchive)
  const hasUnpackedNpm = existsSync(npmCli) && existsSync(npxCli)
  if (!existsSync(nodeBin) || !existsSync(npmBin) || !existsSync(npxBin) || (!hasArchivedNpm && !hasUnpackedNpm)) {
    throw new Error(`[afterPack] Bundled Node runtime incomplete at ${runtime}. Run "pnpm prepare:runtime" first.`)
  }
  chmodSync(nodeBin, 0o755)
  chmodSync(npmBin, 0o755)
  chmodSync(npxBin, 0o755)
  if (hasUnpackedNpm) {
    chmodSync(npmCli, 0o755)
    chmodSync(npxCli, 0o755)
  }
}
