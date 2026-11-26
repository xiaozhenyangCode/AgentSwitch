import { formatComposerFileRef } from '@shared/fileReferences'

export interface FileTrigger {
  start: number
  query: string
}

export function matchFileTrigger(value: string, caret: number): FileTrigger | null {
  if (caret < 1 || caret > value.length) return null
  // Include the character before a maximum-length token so a sliced prefix cannot fake a boundary.
  const match = /(?:^|\s)#([^\s#]{0,120})$/u.exec(value.slice(Math.max(0, caret - 122), caret))
  if (!match) return null
  const query = match[1]
  const next = value[caret]
  if (next && (!/\s/u.test(next) || (!query && /[ \t]/.test(next)))) return null
  if (/^(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(query)) return null
  return { start: caret - query.length - 1, query }
}

export function applyFileReference(value: string, start: number, caret: number, label: string) {
  const reference = formatComposerFileRef(label) + ' '
  return { value: value.slice(0, start) + reference + value.slice(caret), caret: start + reference.length }
}

export function insertFileReferenceAtCaret(value: string, start: number, end: number, label: string) {
  const before = value.slice(0, start)
  const after = value.slice(end)
  const lead = before && !/\s$/u.test(before) ? ' ' : ''
  const tail = /^\s/u.test(after) ? '' : ' '
  const reference = lead + formatComposerFileRef(label) + tail
  return { value: before + reference + after, caret: start + reference.length }
}
