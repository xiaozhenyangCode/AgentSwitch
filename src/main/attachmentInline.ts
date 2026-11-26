import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { formatInlineCodePath } from '@shared/fileReferences'
import { getProviderCapabilities } from '@shared/providerCapabilities'
import type { ResolvedRunAttachment } from '@shared/types'
import type { RunSpec } from './agentRunner'

export function inlineTextAttachments(
  prompt: string, attachments: readonly ResolvedRunAttachment[],
  { maxFileBytes = 64 * 1024, maxTotalBytes = 256 * 1024 } = {}
): string {
  let remaining = maxTotalBytes
  const blocks: string[] = []
  for (const att of attachments) {
    if (att.isImage || !isAbsolute(att.absPath)) continue
    if (remaining <= 0) {
      blocks.push('[附件内容已截断，达到总读取上限]')
      break
    }
    let fd: number | undefined
    try {
      fd = openSync(att.absPath, constants.O_RDONLY | constants.O_NONBLOCK)
      const stat = fstatSync(fd)
      if (!stat.isFile()) continue
      const data = Buffer.alloc(Math.min(stat.size, maxFileBytes, remaining))
      let offset = 0
      while (offset < data.length) {
        const read = readSync(fd, data, offset, data.length - offset, offset)
        if (!read) break
        offset += read
      }
      if (!offset || data.subarray(0, Math.min(offset, 8192)).includes(0)) continue
      const truncated = offset < stat.size
      const content = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, offset), { stream: truncated })
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content)) continue
      let longest = 2
      for (const run of content.matchAll(/`+/g)) longest = Math.max(longest, run[0].length)
      const fence = '`'.repeat(longest + 1)
      remaining -= offset
      const note = truncated ? '（内容已截断）' : ''
      blocks.push('附件内容 ' + formatInlineCodePath(att.promptPath) + note + '\n' + fence + 'text\n' + content + '\n' + fence)
    } catch {
      /* Missing, unreadable and binary files already have their paths in the prompt. */
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }
  return blocks.length ? [prompt, ...blocks].filter(Boolean).join('\n\n') : prompt
}

export function prepareAdapterPrompt(spec: Pick<RunSpec, 'cfg' | 'prompt' | 'attachments' | 'supportsFileTools' | 'ephemeralProbe'>): string {
  const supportsTools = spec.supportsFileTools ?? (!spec.ephemeralProbe && getProviderCapabilities(spec.cfg.kind).supportsFileTools)
  return !supportsTools && spec.attachments?.length ? inlineTextAttachments(spec.prompt, spec.attachments) : spec.prompt
}

export function promptIncludesPath(text: string, path: string): boolean {
  return !!path && (text.includes(path) || text.includes(formatInlineCodePath(path)))
}
