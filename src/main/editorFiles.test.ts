import { mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, symlink, truncate, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EDITOR_MAX_BYTES, detectEditorLanguage, isKnownBinaryPath, type EditorEol, type EditorFileChangedEvent } from '@shared/editor'
import { EditorFileWatcher, readEditorFile, resolveAuthorizedEditorPath, saveEditorFile } from './editorFiles'
import { allowFile, allowRoot, isAllowedEditorAttachment, isAllowedEditorWorkspace } from './fileProtocol'

vi.mock('electron', () => ({ app: { getPath: () => scratch } }))
vi.mock('node:fs/promises', async (load) => {
  const fs = await load<typeof import('node:fs/promises')>()
  return { ...fs, open: vi.fn(fs.open), rename: vi.fn(fs.rename) }
})

let scratch: string
let workspaceDir: string
const watchers: EditorFileWatcher[] = []

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'agentswitch-editor-')))
  workspaceDir = join(scratch, 'workspace')
  await mkdir(workspaceDir)
})

afterEach(async () => {
  for (const watcher of watchers.splice(0)) watcher.unwatchAll()
  vi.clearAllMocks()
  await rm(scratch, { recursive: true, force: true })
})

async function fixture(name: string, data: string | Buffer = 'before\n'): Promise<string> {
  const path = join(workspaceDir, name)
  await writeFile(path, data)
  return path
}

describe('editor authorization', () => {
  it('rejects traversal, sibling prefixes, and escaping symlinks', async () => {
    const sibling = join(scratch, 'workspace-other')
    await mkdir(sibling)
    const outside = join(sibling, 'outside.txt')
    await writeFile(outside, 'outside')
    const link = join(workspaceDir, 'link.txt')
    await symlink(outside, link)
    for (const path of [`${workspaceDir}/../workspace-other/outside.txt`, outside, link]) {
      expect(await readEditorFile({ path, workspaceDir })).toMatchObject({ ok: false, code: 'OUT_OF_BOUNDS' })
      expect(await saveEditorFile({ path, workspaceDir, force: true, content: 'overwrite', expectedMtimeMs: 0 }))
        .toMatchObject({ ok: false, code: 'OUT_OF_BOUNDS' })
    }
    expect(await readFile(outside, 'utf8')).toBe('outside')
  })

  it('accepts files in a canonicalized workspace and explicitly allowed external files', async () => {
    const path = await fixture('inside.txt')
    const alias = join(scratch, 'project-alias')
    await symlink(workspaceDir, alias, 'dir')
    const aliasPath = join(alias, 'inside.txt')
    expect(await readEditorFile({ path: aliasPath, workspaceDir: alias })).toMatchObject({
      ok: true, path: aliasPath, realPath: path, content: 'before\n'
    })

    const outside = join(scratch, 'attached.txt')
    await writeFile(outside, 'attachment')
    const isExtraAllowed = vi.fn((realPath: string) => realPath === outside)
    expect(await readEditorFile({ path: outside, workspaceDir }, { isExtraAllowed })).toMatchObject({
      ok: true, realPath: outside, content: 'attachment'
    })
    expect(isExtraAllowed).toHaveBeenCalledWith(outside)
  })

  it('separates workspace grants from attachment grants as the IPC does', async () => {
    const path = await fixture('inside.txt')
    const otherWorkspace = join(scratch, 'other')
    const attached = join(scratch, 'attached.txt')
    await mkdir(otherWorkspace)
    const otherFile = join(otherWorkspace, 'outside.txt')
    await writeFile(otherFile, 'outside')
    await writeFile(attached, 'attachment')
    allowRoot(workspaceDir)
    allowRoot(otherWorkspace)
    allowFile(attached)
    const opts = { isWorkspaceAllowed: isAllowedEditorWorkspace, isExtraAllowed: isAllowedEditorAttachment }

    expect(await readEditorFile({ path, workspaceDir }, opts)).toMatchObject({ ok: true })
    expect(await readEditorFile({ path: otherFile, workspaceDir }, opts)).toMatchObject({ code: 'OUT_OF_BOUNDS' })
    expect(await readEditorFile({ path, workspaceDir: scratch }, opts)).toMatchObject({ code: 'OUT_OF_BOUNDS' })
    expect(await readEditorFile({ path: attached }, opts)).toMatchObject({ ok: true })
  })

  it('rejects malformed paths, missing files, and non-files with typed errors', async () => {
    const invalid = [null, {}, 'relative.txt', `${workspaceDir}/null\0.txt`]
    for (const path of invalid) {
      expect(await resolveAuthorizedEditorPath(path as string, workspaceDir)).toMatchObject({ code: 'OUT_OF_BOUNDS' })
    }
    expect(await resolveAuthorizedEditorPath(workspaceDir, workspaceDir)).toMatchObject({ code: 'OUT_OF_BOUNDS' })
    expect(await readEditorFile({ path: join(workspaceDir, 'missing'), workspaceDir })).toMatchObject({ code: 'NOT_FOUND' })
    const dir = join(workspaceDir, 'nested')
    await mkdir(dir)
    expect(await readEditorFile({ path: dir, workspaceDir })).toMatchObject({ code: 'NOT_A_FILE' })
  })
})

describe('editor file reads and saves', () => {
  it('rejects files over 2 MB and accepts a file exactly at the limit', async () => {
    const path = await fixture('large.txt', 'a'.repeat(EDITOR_MAX_BYTES))
    expect(await readEditorFile({ path, workspaceDir })).toMatchObject({ ok: true, size: EDITOR_MAX_BYTES })
    await truncate(path, EDITOR_MAX_BYTES + 1)
    expect(await readEditorFile({ path, workspaceDir })).toMatchObject({
      ok: false, code: 'FILE_TOO_LARGE', realPath: path, size: EDITOR_MAX_BYTES + 1
    })
  })

  it.each([
    ['image.PNG', 'no null bytes'],
    ['extensionless', Buffer.from('x'.repeat(8191) + '\0')]
  ])('rejects binary content in %s even on a forced save', async (name, data) => {
    const path = await fixture(name, data)
    expect(await readEditorFile({ path, workspaceDir })).toMatchObject({ ok: false, code: 'BINARY_FILE', realPath: path })
    expect(await saveEditorFile({ path, workspaceDir, force: true, expectedMtimeMs: 0, content: 'text' }))
      .toMatchObject({ ok: false, code: 'BINARY_FILE' })
  })

  it('rejects a stale save, then allows explicit force', async () => {
    const path = await fixture('file.ts')
    const before = await stat(path)
    await writeFile(path, 'outside edit')
    const editedAt = new Date(before.mtimeMs + 2000)
    await utimes(path, editedAt, editedAt)
    const current = await stat(path)
    const request = { path, workspaceDir, expectedMtimeMs: before.mtimeMs, content: 'editor edit' }
    expect(await saveEditorFile(request)).toEqual({
      ok: false, code: 'CONFLICT', currentMtimeMs: current.mtimeMs, message: 'File modified on disk'
    })
    expect(await readFile(path, 'utf8')).toBe('outside edit')
    const saved = await saveEditorFile({ ...request, force: true })
    expect(saved).toEqual({ ok: true, mtimeMs: (await stat(path)).mtimeMs, size: 11 })
    expect(await readFile(path, 'utf8')).toBe('editor edit')
  })

  it.each<[EditorEol, string]>([['LF', '\n'], ['CRLF', '\r\n']])(
    'preserves %s and permission bits while replacing the file atomically',
    async (eol, newline) => {
      const path = join(workspaceDir, 'config.ts')
      const previous = `old${newline}lines${newline}`
      await writeFile(path, previous, { mode: 0o751 })
      const original = await open(path, 'r')
      try {
        const before = await readEditorFile({ path, workspaceDir })
        expect(before).toMatchObject({ ok: true, content: 'old\nlines\n', eol, language: 'typescript' })
        if (!before.ok) throw new Error(before.message)

        const content = 'new\r\n配置\n'
        const disk = `new${newline}配置${newline}`
        const result = await saveEditorFile({ path, workspaceDir, expectedMtimeMs: before.mtimeMs + 0.5, content, eol })
        const after = await stat(path)
        expect(result).toEqual({ ok: true, size: Buffer.byteLength(disk), mtimeMs: after.mtimeMs })
        expect(await readFile(path, 'utf8')).toBe(disk)
        expect(await original.readFile('utf8')).toBe(previous)
        expect(after.ino).not.toBe((await original.stat()).ino)
        expect(after.mode & 0o777).toBe(0o751)
        expect(await readdir(workspaceDir)).toEqual(['config.ts'])
      } finally {
        await original.close()
      }
    }
  )

  it('cleans up the temporary file when replacement fails', async () => {
    const path = await fixture('file.txt')
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('rename failed'), { code: 'EACCES' }))
    const result = await saveEditorFile({ path, workspaceDir, force: true, expectedMtimeMs: 0, content: 'replacement' })
    expect(result).toMatchObject({ ok: false, code: 'IO_ERROR' })
    expect(await readFile(path, 'utf8')).toBe('before\n')
    expect(await readdir(workspaceDir)).toEqual(['file.txt'])
  })

  it('allows only one concurrent save from the same baseline', async () => {
    const path = await fixture('file.txt', 'one\r\ntwo\r\n')
    const { mtimeMs: expectedMtimeMs } = await stat(path)
    const request = { path, workspaceDir, expectedMtimeMs }
    const results = await Promise.all([
      saveEditorFile({ ...request, content: 'first\n' }),
      saveEditorFile({ ...request, content: 'second\n' })
    ])
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, code: 'CONFLICT', message: 'File modified on disk', currentMtimeMs: (await stat(path)).mtimeMs }
    ])
    expect(await readFile(path, 'utf8')).toBe(results[0].ok ? 'first\r\n' : 'second\r\n')
  })

  it('rechecks the target after staging and cleans up when another writer wins', async () => {
    const path = await fixture('file.txt')
    const { open: openActual } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const before = await stat(path)
    vi.mocked(open).mockImplementationOnce(openActual).mockImplementationOnce(async (...args) => {
      await writeFile(path, 'outside edit during staging')
      return openActual(...args)
    })
    const result = await saveEditorFile({ path, workspaceDir, expectedMtimeMs: before.mtimeMs, content: 'replacement' })
    expect(result).toMatchObject({ ok: false, code: 'CONFLICT' })
    expect(await readFile(path, 'utf8')).toBe('outside edit during staging')
    expect(await readdir(workspaceDir)).toEqual(['file.txt'])
  })
})

describe('editor file watcher', () => {
  it('suppresses editor saves, watches atomic replacements and deletions, and stops on unwatch', async () => {
    const path = await fixture('watched.txt')
    const events: EditorFileChangedEvent[] = []
    const watcher = new EditorFileWatcher((event) => events.push(event))
    watchers.push(watcher)
    expect(watcher.watch(path, path)).toEqual({ ok: true })

    const result = await saveEditorFile({ path, workspaceDir, force: true, expectedMtimeMs: 0, content: 'own write' }, { watcher })
    expect(result).toMatchObject({ ok: true })
    await new Promise((resolve) => setTimeout(resolve, 450))
    expect(events).toEqual([])

    const replacement = await fixture('external.tmp', 'external rename')
    await rename(replacement, path)
    await vi.waitFor(() => expect(events).toHaveLength(1), { timeout: 2500 })
    expect(events[0]).toEqual({ path, realPath: path, mtimeMs: (await stat(path)).mtimeMs, size: 15 })

    await unlink(path)
    await vi.waitFor(() => expect(events).toHaveLength(2), { timeout: 2500 })
    expect(events[1]).toEqual({ path, realPath: path, mtimeMs: 0, size: 0, deleted: true })

    await writeFile(path, 'recreated')
    await vi.waitFor(() => expect(events).toHaveLength(3), { timeout: 2500 })
    expect(events[2]).toMatchObject({ path, size: 9 })

    watcher.unwatch(path)
    await writeFile(path, 'after unwatch')
    await new Promise((resolve) => setTimeout(resolve, 450))
    expect(events).toHaveLength(3)
  }, 10_000)
})

describe('editor language and binary detection', () => {
  it.each([
    ['src/main.TS', 'typescript'], ['foo.tsx', 'tsx'], ['foo.jsx', 'jsx'],
    ['C:\\workspace\\foo.mjs', 'javascript'], ['settings.jsonc', 'json'], ['guide.mdx', 'markdown'],
    ['style.scss', 'scss'], ['view.vue', 'vue'], ['view.svelte', 'svelte'],
    ['hello.py', 'python'], ['server.go', 'go'], ['lib.rs', 'rust'], ['main.kt', 'kotlin'],
    ['header.hpp', 'cpp'], ['settings.yml', 'yaml'], ['script.sql', 'sql'],
    ['.gitignore', 'plaintext'], ['.gitmodules', 'ini'], ['.env.local', 'env'], ['.zshrc', 'shell'],
    ['Dockerfile', 'dockerfile'], ['Dockerfile.dev', 'dockerfile'], ['Makefile', 'makefile'],
    ['README', 'plaintext'], ['x.unmapped', 'plaintext']
  ])('maps %s to %s', (path, language) => {
    expect(detectEditorLanguage(path)).toBe(language)
  })

  it('identifies common binary formats while allowing text formats', () => {
    for (const name of ['x.JPG', 'x.tar.gz', 'x.pdf', 'x.xlsx', 'x.mov', 'x.wasm', 'x.woff2']) {
      expect(isKnownBinaryPath(name)).toBe(true)
    }
    for (const name of ['.env', 'Makefile', 'x.json', 'x.svg', 'x.txt']) {
      expect(isKnownBinaryPath(name)).toBe(false)
    }
  })
})
