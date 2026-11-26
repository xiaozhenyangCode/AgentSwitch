import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRef, AssistantMessage, Attachment, Message, Thread, UserMessage } from '@shared/chat'
import { findMatchingOutputFile, resolveOutputFileCandidates } from '@shared/fileResolve'
import { EXPORT_MAX_FILE_BYTES, LEGACY_BUNDLE_FORMAT, type ThreadBundle } from '@shared/transfer'
import { allowRoot, attachmentsDir, handleFileProtocol, isAllowedPath } from './fileProtocol'
import { commitThreadsImport, exportThreadsArchive, inspectThreadsImport } from './threadTransfer'
import { createZipBuffer, extractZipEntry, readZipEntries } from './zipArchive'

let root: string
let appData: string
const { protocolHandle } = vi.hoisted(() => ({ protocolHandle: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: () => appData },
  protocol: { handle: protocolHandle }
}))

const driver: AgentRef = { profileId: 'codex', name: 'Codex', kind: 'codex', model: null }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0YsAAAAASUVORK5CYII=', 'base64')
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>'
const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

function write(path: string, bytes: string | Buffer): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes)
  return path
}

function thread(id: string, projectDir: string | null, messages: Message[]): Thread {
  return {
    id, title: id, projectDir, workdir: projectDir, messages, participants: ['codex'],
    driver: { profileId: 'codex', model: null }, activeTurn: null, pause: null, createdAt: 1, updatedAt: 2
  }
}

function attachment(path: string, name = basename(path)): Attachment {
  return { id: name, name, path, size: 0, isImage: /\.png$/i.test(name), thumb: null }
}

function user(attachments: Attachment[]): UserMessage {
  return { role: 'user', id: 'user', turnId: 'turn', text: 'Make an asset', createdAt: 1, attachments, driver, mentions: [] }
}

function assistant(outputs: string[], content = 'Done'): AssistantMessage {
  return {
    role: 'assistant', id: 'assistant', turnId: 'turn', agent: driver, actualModel: null, dispatchedBy: null,
    status: 'done', content, activity: [], thinking: null, usage: null, others: [], outputs, error: null,
    notices: [], review: false, retry: 0, verdict: null, startedAt: 1, endedAt: 2
  }
}

function bundle(...threads: Thread[]): ThreadBundle {
  return {
    format: LEGACY_BUNDLE_FORMAT, version: 1, exportedAt: 3,
    threads: threads.map((thread) => ({
      thread, projectName: thread.projectDir ? basename(thread.projectDir) : null,
      sourceProjectDir: thread.projectDir, sourceWorkdir: thread.workdir, driverKind: 'codex'
    }))
  }
}

function exportBundle(data: ThreadBundle, filePath = join(root, 'chats.zip')) {
  return exportThreadsArchive(data, filePath, { userData: appData, appVersion: '0.1.6' })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentswitch-thread-transfer-'))
  appData = join(root, 'sender')
  mkdirSync(appData)
  protocolHandle.mockClear()
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('portable thread ZIP transfers', () => {
  it('moves attachments and outputs across machines, resolves project files first, and unpacks only the selected chat', async () => {
    const projectA = join(root, 'computer-a', 'Example')
    const projectB = join(root, 'computer-b', 'renamed')
    const screenshot = write(join(appData, 'staging', 'screenshot.PNG'), png)
    const image = write(join(projectA, 'assets', 'world.png'), png)
    const vector = write(join(projectA, 'assets', 'line art.svg'), svg)
    const code = write(join(projectA, 'src', 'scene.gd'), 'extends Node')
    const privateOutput = write(join(projectA, '.agentswitch', 'outputs', 'turn', 'detailed.svg'), svg + '\n')
    const privateBinary = write(join(projectA, '.agentswitch', 'outputs', 'turn', 'asset.bin'), 'requested output')
    const doc = write(join(projectA, '.agentswitch', 'runs', 'turn', 'attachments', 'notes.txt'), 'restored staged document')
    const upload = write(join(projectA, '.godot', 'upload.bin'), 'explicit upload from cache directory')
    const ignored = write(join(projectA, 'ignored.png'), 'ignored output')
    const engine = write(join(projectA, '.godot', 'scene.ctex'), 'generated engine cache')
    const localCache = write(join(projectA, 'scene.png.import'), 'generated engine index')
    const unselected = write(join(appData, 'staging', 'other.txt'), 'only referenced by another chat')
    write(join(projectA, '.gitignore'), 'ignored.png\n.agentswitch/\n')

    const content = ['![world](assets/world.png)', '![drawing](assets/line%20art.svg)', '![result](' + privateOutput + ')'].join('\n')
    const a = thread('a', projectA, [
      user([attachment(screenshot), attachment(join(appData, 'staging', basename(doc))), attachment(upload)]),
      assistant([image, code, privateOutput, privateBinary, ignored, engine, localCache], content)
    ])
    const path = join(root, 'chats.bundle')
    const manifest = exportBundle(bundle(a, thread('b', null, [user([attachment(unselected)])])), path)
    expect(manifest).toMatchObject({ schemaVersion: 2, appVersion: '0.1.6', exportedAt: 3,
      projects: [{ name: 'Example', sourceProjectDir: projectA }, { name: null, sourceProjectDir: null }],
      attachments: { packedCount: 7, skippedCount: 0 } })

    renameSync(projectA, projectA + '-offline')
    renameSync(appData, appData + '-offline')
    appData = join(root, 'computer-b', 'AgentSwitch')
    const preview = inspectThreadsImport(path)
    expect(preview.kind).toBe('zip')
    expect(preview.bundle.version).toBe(2)
    expect(existsSync(attachmentsDir())).toBe(false)
    const [userA, assistantA] = preview.bundle.threads[0].thread.messages as [UserMessage, AssistantMessage]
    expect(assistantA.outputs).toEqual([image, code, privateOutput, privateBinary])
    expect(userA.attachments[0].bundlePath).toBe('attachments/' + sha(png) + '.png')
    expect(assistantA.outputFiles?.find((ref) => ref.path === image)?.bundlePath).toBe(userA.attachments[0].bundlePath)
    expect(assistantA.outputFiles?.find((ref) => ref.path === vector)).toMatchObject({
      source: 'workspace-file', relativePath: 'assets/line art.svg', mimeType: 'image/svg+xml', inlineOnly: true
    })
    expect(assistantA.outputFiles?.find((ref) => ref.path === privateOutput)).toMatchObject({
      source: 'chat-attachment', relativePath: '.agentswitch/outputs/turn/detailed.svg'
    })
    expect(assistantA.outputFiles?.find((ref) => ref.path === code)?.bundlePath).toBeUndefined()

    const withoutProject = commitThreadsImport({ filePath: path, selectedThreadIds: ['a'], projectMap: {} }, { userData: appData })
    const imported = withoutProject.threads[0].thread
    expect(imported.projectDir).toBeNull()
    expect(imported.sourceProjectDir).toBe(projectA)
    const [userB, assistantB] = imported.messages as [UserMessage, AssistantMessage]
    expect(userB.attachments.map((value) => readFileSync(value.path!))).toEqual([
      png, Buffer.from('restored staged document'), Buffer.from('explicit upload from cache directory')
    ])
    expect(userB.attachments.every((value) => isAllowedPath(value.path!))).toBe(true)
    const fallback = findMatchingOutputFile('assets/line%20art.svg', null, null, assistantB.outputFiles, imported.sourceProjectDir)
    expect(readFileSync(resolveOutputFileCandidates(fallback!, null)[0], 'utf8')).toBe(svg)
    const relocated = findMatchingOutputFile(privateOutput, null, null, assistantB.outputFiles, null)
    expect(relocated).toMatchObject({ sourcePath: privateOutput, source: 'chat-attachment' })
    expect(readFileSync(relocated!.path, 'utf8')).toBe(svg + '\n')
    expect(readdirSync(attachmentsDir())).toHaveLength(6)
    expect(existsSync(join(attachmentsDir(), sha('only referenced by another chat') + '.txt'))).toBe(false)

    const imageB = write(join(projectB, 'assets', 'world.png'), 'locally replaced image')
    const codeB = write(join(projectB, 'src', 'scene.gd'), 'locally updated code')
    const withProject = commitThreadsImport({ filePath: path, selectedThreadIds: ['a'], projectMap: { Example: projectB } },
      { userData: appData }).threads[0].thread
    expect(withProject).toMatchObject({ projectDir: projectB, sourceProjectDir: projectA, sourceProjectName: 'Example' })
    const mapped = withProject.messages[1] as AssistantMessage
    expect(mapped.outputs).toEqual([imageB, codeB, relocated!.path, join(attachmentsDir(), sha('requested output') + '.bin')])
    const mappedImage = mapped.outputFiles?.find((ref) => ref.path === imageB)
    expect(resolveOutputFileCandidates(mappedImage!, projectB)).toEqual([imageB, userB.attachments[0].path])
    expect(isAllowedPath(codeB)).toBe(true)
    expect(readdirSync(attachmentsDir())).toHaveLength(6)

    handleFileProtocol()
    const route = protocolHandle.mock.calls[0][1] as (request: Request) => Promise<Response>
    const url = (file: string) => 'agentswitch-file://f/' + Buffer.from(file).toString('base64url')
    const response = await route(new Request(url(fallback!.fallbackPath!)))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/svg+xml')
    expect(await response.text()).toBe(svg)
    const shot = await route(new Request(url(userB.attachments[0].path!)))
    expect(shot.status).toBe(200)
    expect(Buffer.from(await shot.arrayBuffer())).toEqual(png)

    const reexport = join(root, 'reexport.zip')
    exportBundle(bundle(withProject), reexport)
    const reexported = inspectThreadsImport(reexport).bundle.threads[0].thread.messages[1] as AssistantMessage
    expect(reexported.outputFiles?.find((ref) => ref.relativePath === 'assets/line art.svg')?.bundlePath)
      .toBe('attachments/' + sha(svg) + '.svg')
  })

  it('records missing and oversized files while retaining their metadata and deduplicates across different suffixes', () => {
    const tooLarge = write(join(appData, 'too-large.png'), '')
    truncateSync(tooLarge, EXPORT_MAX_FILE_BYTES + 1)
    const missing = join(appData, 'missing.txt')
    const note = write(join(appData, 'alias.txt'), png)
    const image = write(join(appData, 'screenshot.PNG'), png)
    const input = bundle(thread('a', null, [user([attachment(tooLarge), attachment(missing), attachment(note), attachment(image)])]))
    const result = exportBundle(input)
    expect(result.attachments).toMatchObject({ packedCount: 1, skippedCount: 2,
      skipped: [{ reason: 'too-large', name: 'too-large.png' }, { reason: 'missing', name: 'missing.txt' }] })
    const preview = inspectThreadsImport(join(root, 'chats.zip'))
    const attachments = (preview.bundle.threads[0].thread.messages[0] as UserMessage).attachments
    expect(attachments[0]).toMatchObject({ name: 'too-large.png', size: EXPORT_MAX_FILE_BYTES + 1, skippedReason: 'too-large' })
    expect(attachments[0].bundlePath).toBeUndefined()
    expect(attachments[2].bundlePath).toBe('attachments/' + sha(png) + '.png')
    expect(attachments[2].bundlePath).toBe(attachments[3].bundlePath)
    expect(input.threads[0].thread.messages[0]).toEqual(user([attachment(tooLarge), attachment(missing), attachment(note), attachment(image)]))
  })

  it('loads standalone v1 JSON and rebuilds output metadata using the mapped project', () => {
    const project = join(root, 'local')
    const code = write(join(project, 'src', 'demo.ts'), 'local copy')
    const oldProject = '/old/Example'
    const filePath = write(join(root, 'legacy.json'), JSON.stringify(bundle(thread('old', oldProject, [
      assistant([oldProject + '/src/demo.ts'], '![old image](render.svg)')
    ]))))
    expect(inspectThreadsImport(filePath)).toMatchObject({ kind: 'json', manifest: null, bundle: { version: 1 } })
    const [item] = commitThreadsImport({ filePath, selectedThreadIds: ['old'], projectMap: { Example: project } }, { userData: appData }).threads
    const reply = item.thread.messages[0] as AssistantMessage
    expect(reply.outputs).toEqual([code])
    expect(reply.outputFiles).toMatchObject([
      { path: code, sourcePath: oldProject + '/src/demo.ts', source: 'workspace-file', relativePath: 'src/demo.ts' },
      { path: join(project, 'render.svg'), inlineOnly: true, relativePath: 'render.svg' }
    ])
    expect(readdirSync(attachmentsDir())).toEqual([])
  })
})

describe('import boundaries', () => {
  function fixture(path = join(root, 'chats.zip')) {
    const asset = write(join(appData, 'screenshot.png'), png)
    exportBundle(bundle(thread('a', null, [user([attachment(asset)])])), path)
    const zip = readFileSync(path)
    const files = readZipEntries(zip).map((entry) => ({ name: entry.name, data: extractZipEntry(zip, entry) }))
    return { path, zip, files, assetName: 'attachments/' + sha(png) + '.png' }
  }

  it('rejects traversal anywhere in the ZIP directory during the read-only preview', () => {
    const { path, zip, assetName } = fixture()
    const prefix = Buffer.from(assetName)
    for (let offset = zip.indexOf(prefix); offset !== -1; offset = zip.indexOf(prefix, offset + prefix.length)) {
      zip.write('../', offset, 'ascii')
    }
    writeFileSync(path, zip)
    expect(() => inspectThreadsImport(path)).toThrow(/Unsafe ZIP entry path/)
    expect(existsSync(attachmentsDir())).toBe(false)
  })

  it('leaves attachment payloads compressed during preview and rejects CRC or hash mismatches during commit', () => {
    const { path, zip, files, assetName } = fixture()
    const entry = readZipEntries(zip).find((value) => value.name === assetName)!
    const req = { filePath: path, selectedThreadIds: ['a'], projectMap: {} }
    zip[entry.dataOffset] ^= 1
    writeFileSync(path, zip)
    expect(inspectThreadsImport(path).bundle.threads).toHaveLength(1)
    expect(() => commitThreadsImport(req, { userData: appData })).toThrow(/CRC-32/)
    writeFileSync(path, createZipBuffer(files.map((file) => file.name === assetName ? { ...file, data: Buffer.from('wrong bytes') } : file)))
    expect(() => commitThreadsImport(req, { userData: appData })).toThrow(/SHA-256/)
    expect(readdirSync(attachmentsDir())).toEqual([])
  })

  it('rejects traversal references in the JSON and existing symlinks at the attachment destination', () => {
    const { path, zip, files, assetName } = fixture()
    const unsafe = createZipBuffer(files.map((file) => file.name === 'data.json'
      ? { ...file, data: Buffer.from(file.data.toString().replace(assetName, 'attachments/../outside.png')) }
      : file))
    writeFileSync(path, unsafe)
    const req = { filePath: path, selectedThreadIds: ['a'], projectMap: {} }
    expect(() => commitThreadsImport(req, { userData: appData })).toThrow(/Unsafe ZIP entry path/)
    writeFileSync(path, zip)
    const outside = write(join(root, 'outside.png'), 'untouched')
    symlinkSync(outside, join(attachmentsDir(), basename(assetName)))
    expect(() => commitThreadsImport(req, { userData: appData })).toThrow(/Unsafe existing ZIP destination/)
    expect(readFileSync(outside, 'utf8')).toBe('untouched')
  })

  it('enables the app attachment root on startup and packs only files authorized by the IPC caller', () => {
    handleFileProtocol()
    const allowed = write(join(attachmentsDir(), 'sample.txt'), 'already imported')
    const unapproved = write(join(root, 'unapproved.txt'), 'outside the allowlist')
    expect(isAllowedPath(allowed)).toBe(true)
    expect(isAllowedPath(unapproved)).toBe(false)
    const picked = join(root, 'picked')
    const pickedFile = write(join(picked, 'file.txt'), 'picked folder contents')
    allowRoot(picked)
    const dest = join(root, 'chats.zip')
    const data = bundle(thread('a', null, [user([attachment(allowed), attachment(unapproved), attachment(pickedFile)])]))
    const manifest = exportThreadsArchive(data, dest, { userData: appData, appVersion: 'test', canReadFile: isAllowedPath })
    expect(manifest.attachments).toMatchObject({ packedCount: 2, skipped: [{ name: 'unapproved.txt', reason: 'unreadable' }] })
  })
})
