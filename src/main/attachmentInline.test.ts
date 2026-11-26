import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProfileConfig, ResolvedRunAttachment } from '@shared/types'
import { agyAdapter, claudeAdapter, codexAdapter, type RunSpec } from './agentRunner'
import { inlineTextAttachments, prepareAdapterPrompt } from './attachmentInline'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/agentswitch-attachment-fixtures' }, safeStorage: {} }))

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agentswitch-attachment-inline-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function file(name: string, data: string | Buffer, isImage = false): ResolvedRunAttachment {
  const path = join(dir, name)
  writeFileSync(path, data)
  return { absPath: path, promptPath: name, name, scope: 'workspace', relativePath: name, refLabel: name, isImage }
}

const cfg: ProfileConfig = {
  id: 'fixture', name: 'Fixture', kind: 'claude', configDir: '/tmp/nonexistent-agent-config',
  imported: false, loginCommand: '', runCommand: '', extraEnv: {}, defaultModel: '', autoApprove: 'full', createdAt: 0
}

describe('attachment payloads', () => {
  it('inlines UTF-8 text only for adapters without tools and chooses a safe fence', () => {
    const notes = file('notes.txt', 'text\n```\n@end\n```')
    const base = { cfg, prompt: 'See `notes.txt`', attachments: [notes] }
    expect(prepareAdapterPrompt(base)).toBe(base.prompt)
    expect(prepareAdapterPrompt({ ...base, supportsFileTools: true })).toBe(base.prompt)
    expect(prepareAdapterPrompt({ ...base, supportsFileTools: false }))
      .toBe('See `notes.txt`\n\n附件内容 `notes.txt`\n````text\ntext\n```\n@end\n```\n````')
  })

  it('limits each file and the total without splitting UTF-8 characters', () => {
    const a = file('a.txt', 'hello abcdefghijklmnopqrstuvwxyz')
    const b = file('b.txt', '你好世界')
    const c = file('c.txt', 'SHOULD_NOT_BE_READ')
    const text = inlineTextAttachments('Prompt', [a, b, c], { maxFileBytes: 7, maxTotalBytes: 11 })
    expect(text).toContain('`a.txt`（内容已截断）\n```text\nhello a')
    expect(text).toContain('`b.txt`（内容已截断）\n```text\n你\n')
    expect(text).toContain('达到总读取上限')
    expect(text).not.toContain('SHOULD_NOT_BE_READ')
    expect(text).not.toContain('\ufffd')
  })

  it('skips images, binary and missing files and directories', () => {
    const png = file('picture.png', 'HIDDEN_IMAGE', true)
    const binary = file('sample.bin', Buffer.from([0, 100, 1]))
    const bytes = file('invalid-utf8.txt', Buffer.from([0xff, 0xfe, 0xd4]))
    expect(inlineTextAttachments('User', [png, binary, bytes, { ...bytes, absPath: dir }, { ...bytes, absPath: join(dir, 'missing') }])).toBe('User')
  })

  it('preserves path prompts for Claude and agy print and forwards all images through Codex -i', () => {
    const a = file('reference.png', '', true)
    const b = file('screen capture.jpg', '', true)
    const spec: RunSpec = {
      cfg, cwd: dir, outDir: dir, model: null, resume: null, system: null,
      prompt: 'Compare `reference.png` with `' + b.absPath + '`', images: [a.absPath, b.absPath], attachments: [a, b]
    }
    expect(claudeAdapter(spec).stdin).toBe(spec.prompt)
    const codex = codexAdapter({ ...spec, cfg: { ...cfg, kind: 'codex' } }, dir, 0)
    expect(codex.stdin).toBe(spec.prompt)
    expect(codex.args.flatMap((arg, index) => arg === '-i' ? [codex.args[index + 1]] : [])).toEqual(spec.images)
    expect(agyAdapter({ ...spec, cfg: { ...cfg, kind: 'gemini' } }).args.at(-1)).toBe(spec.prompt)
  })
})
