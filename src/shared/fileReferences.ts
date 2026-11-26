import type { Attachment } from './chat'
import { deriveRelativePath, joinPosixRelative, normalizedFilePathKey } from './fileResolve'
import { markdownCodeSpans } from './mentions'
import type { ResolvedRunAttachment } from './types'

type AttachmentLabel = Pick<Attachment, 'name' | 'relativePath' | 'refLabel' | 'source'>
type AttachmentPath = Pick<Attachment, 'path' | 'relativePath' | 'id'>
export const COMPOSER_ATTACHMENT_LIMIT = 24

export function formatInlineCodePath(path: string): string {
  const value = /[\x00-\x1f\x7f]/.test(path) ? JSON.stringify(path) : path
  const longest = Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length))
  const fence = '`'.repeat(longest + 1)
  const padding = longest || (/^ | $/.test(value) && /[^ ]/.test(value)) ? ' ' : ''
  return fence + padding + value + padding + fence
}

export function formatComposerFileRef(label: string): string {
  return '#' + (/[\s#@＠"'`\\\x00-\x1f\x7f]/u.test(label) ? formatInlineCodePath(label) : label)
}

export function attachmentRefLabel(att: AttachmentLabel): string {
  // Workspace files use the relative path unless that label is already owned by another card.
  return att.refLabel || (att.source === 'workspace-file' && att.relativePath) || att.name
}

export function attachmentDedupKey(att: AttachmentPath, projectDir?: string | null): string {
  const path = att.path || (projectDir && att.relativePath && joinPosixRelative(projectDir, att.relativePath, { literalPosix: true }))
  return path ? 'path:' + normalizedFilePathKey(path) : 'id:' + att.id
}

export function mergeAttachments(existing: Attachment[], incoming: Attachment[], projectDir: string | null, maxCount = COMPOSER_ATTACHMENT_LIMIT) {
  const next = [...existing]
  const resolved: Attachment[] = []
  const keys = new Map(next.map((att, index) => [attachmentDedupKey(att, projectDir), index]))
  const labels = new Set(next.map(attachmentRefLabel))
  for (const att of incoming) {
    const key = attachmentDedupKey(att, projectDir)
    const local = att.path ? deriveRelativePath(att.path, projectDir) ?? undefined : undefined
    const priorIndex = keys.get(key)
    if (priorIndex !== undefined) {
      const prior = next[priorIndex]
      const relativePath = local ?? (att.source === 'workspace-file' ? att.relativePath : undefined)
      const merged: Attachment = {
        ...prior,
        thumb: prior.thumb ?? att.thumb,
        size: prior.size || att.size,
        isImage: prior.isImage || att.isImage,
        ...(relativePath && { relativePath, source: 'workspace-file' })
      }
      if (attachmentRefLabel(merged) !== attachmentRefLabel(prior)) merged.refLabel = attachmentRefLabel(prior)
      next[priorIndex] = merged
      resolved.push(merged)
      continue
    }
    if (next.length >= maxCount) continue
    const relativePath = local ?? att.relativePath
    const source = local ? 'workspace-file' : att.source ?? 'chat-attachment'
    let label = attachmentRefLabel({ ...att, source, relativePath })
    if (labels.has(label)) {
      const folder = (path: string) => normalizedFilePathKey(path).split('/').slice(0, -1).join('/')
      const parent = att.path && folder(att.path).split('/').at(-1)
      const inSameFolder = parent && next.some((item) => item.name === att.name && item.path &&
        folder(item.path) === folder(att.path!))
      if (source === 'chat-attachment' && parent && !inSameFolder && !labels.has(parent + '/' + att.name)) {
        label = parent + '/' + att.name
      } else {
        const dot = label.lastIndexOf('.')
        const split = dot > label.lastIndexOf('/') + 1 ? dot : label.length
        const stem = label.slice(0, split)
        const ext = label.slice(split)
        let count = 2
        do { label = stem + '-' + count++ + ext } while (labels.has(label))
      }
    }
    const item: Attachment = {
      ...att, source, relativePath: relativePath || undefined,
      refLabel: source === 'workspace-file' && label === relativePath ? undefined : label
    }
    keys.set(key, next.length)
    labels.add(label)
    next.push(item)
    resolved.push(item)
  }
  return { next, resolved }
}

export interface FileReferenceSpan {
  start: number
  end: number
  raw: string
  index: number
}

/** Code spans protect standalone examples. A hash immediately before a code span quotes a label. */
export function scanFileReferences(text: string, items: readonly AttachmentLabel[]): FileReferenceSpan[] {
  if (!items.length || !text.includes('#')) return []
  const labels = new Map<string, number | null>()
  const aliases = new Map<string, number | null>()
  const add = (map: Map<string, number | null>, label: string, index: number) => {
    const prior = map.get(label)
    map.set(label, prior !== undefined && prior !== index ? null : index)
  }
  items.forEach((item, index) => {
    add(labels, attachmentRefLabel(item), index)
    if (item.relativePath) add(aliases, item.relativePath, index)
    add(aliases, item.name, index)
  })
  const lookup = (label: string) => labels.has(label) ? labels.get(label) : aliases.get(label)
  const code = markdownCodeSpans(text)
  const spans: FileReferenceSpan[] = []
  const word = /[^\s#`]+/y
  let codeIndex = 0
  for (let start = text.indexOf('#'); start >= 0;) {
    while (code[codeIndex]?.end <= start) codeIndex++
    const span = code[codeIndex]
    if (span && span.start <= start) {
      start = text.indexOf('#', span.end)
      continue
    }
    let end = start + 1
    let index: number | null | undefined
    if (start === 0 || /\s/u.test(text[start - 1])) {
      if (span?.start === end && span.delimiter) {
        end = span.end
        let label = text.slice(span.start + span.delimiter, end - span.delimiter)
        if (label.startsWith(' ') && label.endsWith(' ') && /[^ ]/.test(label)) label = label.slice(1, -1)
        index = lookup(label)
        if (index === undefined && label.startsWith('"')) {
          try {
            const decoded: unknown = JSON.parse(label)
            if (typeof decoded === 'string') index = lookup(decoded)
          } catch { /* A literal quote in a path is valid too. */ }
        }
      } else {
        word.lastIndex = end
        const match = word.exec(text)
        if (match) {
          let label = match[0]
          index = lookup(label)
          while (index === undefined && /[.,;:!?()[\]{}，。；：！？、）】》”’]$/u.test(label)) {
            label = label.slice(0, -1)
            index = lookup(label)
          }
          end += label.length
        }
      }
    }
    if (typeof index === 'number') spans.push({ start, end, raw: text.slice(start, end), index })
    start = text.indexOf('#', end)
  }
  return spans
}

export function removeFileReferences(text: string, target: Attachment, allItems: readonly Attachment[] = [target]): string {
  const removals: { start: number; end: number }[] = []
  for (const span of scanFileReferences(text, allItems)) {
    if (allItems[span.index].id !== target.id) continue
    let { start, end } = span
    while (/[ \t]/.test(text[start - 1] ?? '')) start--
    while (/[ \t]/.test(text[end] ?? '')) end++
    const last = removals.at(-1)
    if (last && start <= last.end) last.end = end
    else removals.push({ start, end })
  }
  for (const { start, end } of removals.reverse()) {
    const left = text[start - 1]
    const right = text[end]
    const space = left && right && !/[\r\n]/.test(left) && !/[\r\n.,;:!?，。；：！？、)\]]/.test(right) ? ' ' : ''
    text = text.slice(0, start) + space + text.slice(end)
  }
  return text
}

export function serializePromptWithAttachments(rawText: string, attachments: readonly ResolvedRunAttachment[]) {
  let body = ''
  let after = 0
  const referenced = new Set<string>()
  const labels = attachments.map((att) => ({ ...att, source: att.scope === 'workspace' ? 'workspace-file' as const : 'chat-attachment' as const }))
  for (const { start, end, index } of scanFileReferences(rawText, labels)) {
    body += rawText.slice(after, start) + formatInlineCodePath(attachments[index].promptPath)
    referenced.add(attachments[index].promptPath)
    after = end
  }
  body += rawText.slice(after)
  const listed = new Set(referenced)
  const unreferenced = attachments.filter((att) => !listed.has(att.promptPath) && !!listed.add(att.promptPath))
  const text = unreferenced.length
    ? [body.trimEnd(), '附带文件：\n' + unreferenced.map((att) => '- ' + formatInlineCodePath(att.promptPath)).join('\n')].filter(Boolean).join('\n\n')
    : body
  return { text, body, referencedCount: referenced.size, unreferenced }
}
