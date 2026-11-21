// node-pty's spawn-helper must stay executable inside app.asar.unpacked, or every pty spawn
// fails with "posix_spawnp failed".
const { chmodSync, existsSync, readdirSync } = require('node:fs')
const { join } = require('node:path')

exports.default = async function afterPack(ctx) {
  const app = join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`)
  const pty = join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'node-pty')
  const helpers = [join(pty, 'build', 'Release', 'spawn-helper')]
  const prebuilds = join(pty, 'prebuilds')
  if (existsSync(prebuilds)) for (const d of readdirSync(prebuilds)) helpers.push(join(prebuilds, d, 'spawn-helper'))
  for (const h of helpers) if (existsSync(h)) chmodSync(h, 0o755)
}
