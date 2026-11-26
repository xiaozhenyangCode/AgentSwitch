import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') throw new Error('Icon generation requires macOS and Xcode with Icon Composer support.')

const build = fileURLToPath(new URL('../build/', import.meta.url))
const swiftSource = fileURLToPath(new URL('./render-icon.swift', import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'agentswitch-icons-'))
const run = (tool, args) => execFileSync(tool, args, { stdio: ['ignore', 'pipe', 'inherit'], timeout: 120_000 })
const slots = [
  [16, 1], [16, 2], [32, 1], [32, 2], [128, 1],
  [128, 2], [256, 1], [256, 2], [512, 1], [512, 2]
].map(([points, scale]) => ({
  name: `icon_${points}x${points}${scale === 2 ? '@2x' : ''}.png`,
  pixels: points * scale
}))

try {
  const catalog = join(work, 'Assets.car')
  run('xcrun', [
    'actool', join(build, 'AppIcon.icon'), '--compile', work,
    '--output-partial-info-plist', join(work, 'partial.plist'),
    '--app-icon', 'AppIcon', '--include-all-app-icons', '--enable-on-demand-resources', 'NO',
    '--target-device', 'mac', '--minimum-deployment-target', '13.0', '--platform', 'macosx'
  ])
  if (!statSync(catalog, { throwIfNoEntry: false })?.size) throw new Error('actool did not produce a non-empty Assets.car')

  const renderer = join(work, 'render-icon')
  run('xcrun', ['swiftc', '-parse-as-library', swiftSource, '-o', renderer])
  const fullBleed = join(work, 'full-bleed.png')
  const dock = join(work, 'icon.png')
  run(renderer, ['render', join(build, 'icon-fullbleed.svg'), fullBleed])
  run(renderer, ['render', join(build, 'icon.svg'), dock])

  const iconset = join(work, 'icon.iconset')
  mkdirSync(iconset)
  for (const { name, pixels } of slots) {
    run('sips', ['-z', String(pixels), String(pixels), fullBleed, '--out', join(iconset, name)])
  }
  const icns = join(work, 'icon.icns')
  run('iconutil', ['-c', 'icns', iconset, '-o', icns])
  const unpacked = join(work, 'unpacked.iconset')
  run('iconutil', ['-c', 'iconset', icns, '-o', unpacked])
  for (const { name, pixels } of slots) {
    const metadata = run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', join(unpacked, name)]).toString()
    if (!metadata.includes(`pixelWidth: ${pixels}\n`) || !metadata.includes(`pixelHeight: ${pixels}\n`)) {
      throw new Error(`ICNS is missing a valid ${pixels} × ${pixels} ${name}`)
    }
  }
  run(renderer, ['validate', join(unpacked, 'icon_512x512@2x.png'), dock])

  for (const file of [catalog, icns, dock]) copyFileSync(file, join(build, basename(file)))
  console.log('Generated and verified build/Assets.car, build/icon.icns (10 sizes), and build/icon.png.')
} finally {
  rmSync(work, { recursive: true, force: true })
}
