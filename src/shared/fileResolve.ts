import type { AssistantMessage, OutputFileRef } from './chat'
import { maskCode } from './mentions'

export const toPosixPath = (path: string): string => path.replace(/\\/g, '/')

function absoluteRoot(path: string): string | undefined {
  return /^(?:[a-z]:\/|\/\/[^/]+\/[^/]+(?:\/|$)|\/)/i.exec(path)?.[0]
}

function appendSegments(parts: string[], path: string): boolean {
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) return false
      parts.pop()
    } else {
      parts.push(part)
    }
  }
  return true
}

function absolutePath(path: string): string | null {
  const posix = /^\/(?!\/)/.test(path) ? path : toPosixPath(path)
  const root = absoluteRoot(posix)
  const parts: string[] = []
  if (!root || posix.includes('\0') || !appendSegments(parts, posix.slice(root.length))) return null
  return root.replace(/\/?$/, '/') + parts.join('/')
}

const windowsPath = (path: string): boolean => /^[a-z]:\/|^\/\//i.test(path)
const pathKey = (path: string): string => windowsPath(path) ? path.toLowerCase() : path

export function normalizedFilePathKey(path: string): string {
  return pathKey(absolutePath(path) ?? path)
}

export function deriveRelativePath(absPath: string, projectDir: string | null | undefined): string | null {
  if (!projectDir) return null
  const target = absolutePath(absPath)
  const root = absolutePath(projectDir)
  if (!target || !root) return null
  const prefix = root.replace(/\/?$/, '/')
  return pathKey(target).startsWith(pathKey(prefix)) ? target.slice(prefix.length) || null : null
}

export function joinPosixRelative(rootDir: string, relativePath: string, { literalPosix = false } = {}): string | null {
  const root = absolutePath(rootDir)
  const rel = literalPosix && root && !windowsPath(root) ? relativePath : toPosixPath(relativePath)
  const parts: string[] = []
  if (!root || rel.startsWith('/') || /^[a-z]:/i.test(rel) || rel.includes('\0') ||
      !appendSegments(parts, rel) || !parts.length) return null
  if (windowsPath(root) && parts.some((part) => /[:<>"|?*\x00-\x1f]|[. ]$/.test(part))) return null
  return root.replace(/\/?$/, '/') + parts.join('/')
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml'
}

const FILE_MIME: Record<string, string> = {
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.json': 'application/json',
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.html': 'text/html',
  '.css': 'text/css', '.js': 'text/javascript', '.xml': 'application/xml',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
}

const extension = (path: string): string => (/\.[^./\\]+$/.exec(path)?.[0] ?? '').toLowerCase()
export const isPreviewableImagePath = (path: string): boolean => Object.hasOwn(IMAGE_MIME, extension(path))
export const mimeTypeForPath = (path: string): string => {
  const ext = extension(path)
  return IMAGE_MIME[ext] ?? FILE_MIME[ext] ?? 'application/octet-stream'
}

const drivePath = /^[a-z]:[\\/]/i
const fileUrl = /^file:\/\//i
const localTarget = (target: string): boolean =>
  !!target && !target.startsWith('//') && !target.startsWith('#') && !target.includes('\0') &&
  (drivePath.test(target) || fileUrl.test(target) || !/^[a-z][a-z\d+.-]*:/i.test(target))

function readImageTarget(markdown: string, start: number): { target: string; end: number } | null {
  if (markdown[start] === '<') {
    const match = /^<((?:\\.|[^<>\n\\])*)>/.exec(markdown.slice(start))
    return match ? { target: match[1], end: start + match[0].length } : null
  }
  let depth = 0
  let end = start
  for (; end < markdown.length; end++) {
    const char = markdown[end]
    if (/\s/.test(char)) break
    if (char === '\\' && /[\\()]/.test(markdown[end + 1] ?? '')) {
      end++
    } else if (char === '(') {
      depth++
    } else if (char === ')') {
      if (!depth) break
      depth--
    }
  }
  return depth === 0 ? { target: markdown.slice(start, end), end } : null
}

/** Local destinations from inline Markdown images, in first appearance order. */
export function extractMarkdownImageTargets(markdown: string): string[] {
  const text = maskCode(markdown.replace(/^ {0,3}(~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1~*[ \t]*$|(?![\s\S]))/gm,
    (block) => block.replace(/[^\n]/g, ' ')))
  const images = /!\[(?:\\.|[^[\]\\\n]|\[(?:\\.|[^[\]\\\n])*\])*\]\(\s*/g
  const targets = new Set<string>()
  for (const match of text.matchAll(images)) {
    const start = match.index
    let escapes = 0
    while (text[start - escapes - 1] === '\\') escapes++
    if (escapes % 2) continue
    const found = readImageTarget(text, start + match[0].length)
    if (!found || !/^(?:\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^)\\])*\)))?\s*\)/.test(text.slice(found.end))) continue
    const target = found.target.replace(/\\([!"#$%&'()*+,./:;<=>?@[\]^_\x60{|}~-])/g, '$1')
    if (localTarget(target)) targets.add(target)
  }
  return [...targets]
}

export function resolveOutputFileCandidates(ref: OutputFileRef, projectDir: string | null | undefined): string[] {
  const primary = ref.source === 'workspace-file'
    ? projectDir && ref.relativePath && joinPosixRelative(projectDir, ref.relativePath)
    : ref.path
  return [...new Set([primary, ref.fallbackPath].filter((path): path is string => !!path))]
}

/** Older messages only carry paths. Infer which ones can move with the project. */
export function outputRefsForMessage(
  message: Pick<AssistantMessage, 'outputs' | 'outputFiles'>, projectDir: string | null, sourceProjectDir?: string | null
): OutputFileRef[] {
  return message.outputFiles ?? message.outputs.flatMap((path) => {
    if (typeof path !== 'string' || !path) return []
    const relativePath = deriveRelativePath(path, projectDir) ?? deriveRelativePath(path, sourceProjectDir) ?? undefined
    return [{
      path,
      name: toPosixPath(path).split('/').pop() || path,
      relativePath,
      source: relativePath && !relativePath.startsWith('.agentswitch/outputs/') ? 'workspace-file' : 'chat-attachment'
    }]
  })
}

function markdownPath(src: string): string | null {
  if (!localTarget(src)) return null
  let path = src.split(/[?#]/, 1)[0]
  try { path = decodeURIComponent(path) } catch { /* Keep a literal percent if this is a raw path. */ }
  if (fileUrl.test(path)) {
    path = path.slice('file://'.length)
    path = path.replace(/^localhost(?=\/)/i, '')
    if (/^\/[a-z]:\//i.test(path)) path = path.slice(1)
    else if (!path.startsWith('/') && !drivePath.test(path)) path = '//' + path
  }
  return toPosixPath(path)
}

export function resolveMarkdownImagePath(
  src: string, baseDir: string | null | undefined, home: string | null | undefined
): string | null {
  const path = markdownPath(src)
  if (!path) return null
  const absolute = absolutePath(path)
  if (absolute) return absolute
  const fromHome = path.startsWith('~/')
  const root = fromHome ? home : baseDir
  return root ? absolutePath(root.replace(/[\\/]+$/, '') + '/' + (fromHome ? path.slice(2) : path)) : null
}

export function findMatchingOutputFile(
  src: string,
  baseDir: string | null | undefined,
  home: string | null | undefined,
  outputFiles: readonly OutputFileRef[] | undefined,
  sourceProjectDir?: string | null
): OutputFileRef | undefined {
  if (!outputFiles?.length) return undefined
  const path = markdownPath(src)
  if (!path) return undefined

  const absolute = absolutePath(path)
  const fromHome = path.startsWith('~/')
  const relative = !absolute && !fromHome ? joinPosixRelative('/', path)?.slice(1) : undefined
  const candidates = new Set<string>()
  for (const root of [baseDir, sourceProjectDir]) {
    const resolved = resolveMarkdownImagePath(src, root, home)
    if (resolved) candidates.add(pathKey(resolved))
  }
  const direct = outputFiles.find((file) => [file.path, file.sourcePath, file.fallbackPath].some((value) => {
    const normalized = value && absolutePath(value)
    return normalized ? candidates.has(pathKey(normalized)) : false
  }))
  if (direct) return direct

  const relatives = absolute ? [deriveRelativePath(absolute, baseDir), deriveRelativePath(absolute, sourceProjectDir)] : [relative]
  return outputFiles.find((file) => file.relativePath && relatives.includes(toPosixPath(file.relativePath)))
}
