export type FileTypeCategory =
  | 'image'
  | 'markdown'
  | 'document'
  | 'pdf'
  | 'code'
  | 'script'
  | 'config'
  | 'spreadsheet'
  | 'archive'
  | 'file'

export type FileTypeIconKind =
  | 'image'
  | 'document'
  | 'pdf'
  | 'code'
  | 'terminal'
  | 'config'
  | 'table'
  | 'archive'
  | 'file'

export interface FileTypeMeta {
  category: FileTypeCategory
  /** Compact uppercase badge text for card preview (empty string for extensionless generic files). */
  label: string
  /** Semantic text color class tuned for both light and dark modes. */
  color: string
  icon: FileTypeIconKind
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp', 'ico', 'heic'])
const MARKDOWN_EXTS = new Set(['md', 'mdx'])
const DOC_EXTS = new Set(['txt', 'rtf', 'doc', 'docx'])
const SHEET_EXTS = new Set(['csv', 'tsv', 'xlsx', 'xls'])
const ARCHIVE_EXTS = new Set(['zip', 'tar', 'gz', 'tgz', '7z', 'rar'])
const SCRIPT_EXTS = new Set(['sh', 'zsh', 'bash'])

const CODE_EXT_COLORS: Record<string, string> = {
  ts: 'text-blue-600 dark:text-blue-400',
  tsx: 'text-blue-600 dark:text-blue-400',
  js: 'text-amber-600 dark:text-amber-400',
  jsx: 'text-amber-600 dark:text-amber-400',
  mjs: 'text-amber-600 dark:text-amber-400',
  cjs: 'text-amber-600 dark:text-amber-400',
  vue: 'text-emerald-600 dark:text-emerald-400',
  svelte: 'text-orange-600 dark:text-orange-400',
  html: 'text-orange-600 dark:text-orange-400',
  css: 'text-purple-600 dark:text-purple-400',
  scss: 'text-pink-600 dark:text-pink-400',
  less: 'text-indigo-600 dark:text-indigo-400',
  py: 'text-sky-600 dark:text-sky-400',
  go: 'text-cyan-600 dark:text-cyan-400',
  rs: 'text-orange-600 dark:text-orange-400',
  java: 'text-amber-600 dark:text-amber-400',
  kt: 'text-purple-600 dark:text-purple-400',
  swift: 'text-orange-600 dark:text-orange-400',
  c: 'text-indigo-600 dark:text-indigo-400',
  cpp: 'text-indigo-600 dark:text-indigo-400',
  h: 'text-indigo-600 dark:text-indigo-400',
  rb: 'text-rose-600 dark:text-rose-400',
  php: 'text-indigo-600 dark:text-indigo-400'
}

const CONFIG_EXT_COLORS: Record<string, string> = {
  json: 'text-amber-600 dark:text-amber-400',
  jsonc: 'text-amber-600 dark:text-amber-400',
  yaml: 'text-cyan-600 dark:text-cyan-400',
  yml: 'text-cyan-600 dark:text-cyan-400',
  toml: 'text-orange-600 dark:text-orange-400',
  xml: 'text-cyan-600 dark:text-cyan-400',
  ini: 'text-amber-600 dark:text-amber-400',
  env: 'text-amber-600 dark:text-amber-400'
}

const MAX_FALLBACK_LABEL_LEN = 5

function extractBaseName(fileName: string): string {
  const trimmed = fileName.trim()
  if (!trimmed) return ''
  const parts = trimmed.split(/[/\\]/)
  return parts[parts.length - 1] ?? ''
}

function extractExtension(baseName: string): string {
  if (!baseName) return ''
  const dot = baseName.lastIndexOf('.')
  if (dot <= 0 || dot === baseName.length - 1) return ''
  return baseName.slice(dot + 1).toLowerCase()
}

function matchSpecialFile(lowerBase: string): FileTypeMeta | null {
  if (lowerBase === '.gitignore' || lowerBase === '.gitattributes' || lowerBase === '.gitmodules') {
    return { category: 'config', label: 'GIT', color: 'text-orange-600 dark:text-orange-400', icon: 'config' }
  }
  if (lowerBase === '.npmrc' || lowerBase === '.nvmrc') {
    return { category: 'config', label: 'NPM', color: 'text-orange-600 dark:text-orange-400', icon: 'config' }
  }
  if (lowerBase === '.eslintrc' || lowerBase.startsWith('.eslintrc.')) {
    return { category: 'config', label: 'LINT', color: 'text-purple-600 dark:text-purple-400', icon: 'config' }
  }
  if (lowerBase === '.env' || lowerBase.startsWith('.env.')) {
    return { category: 'config', label: 'ENV', color: 'text-amber-600 dark:text-amber-400', icon: 'config' }
  }
  if (lowerBase === 'dockerfile' || lowerBase.startsWith('dockerfile.')) {
    return { category: 'config', label: 'DOCKER', color: 'text-cyan-600 dark:text-cyan-400', icon: 'config' }
  }
  if (lowerBase === 'makefile' || lowerBase === 'gnumakefile') {
    return { category: 'script', label: 'MAKE', color: 'text-amber-600 dark:text-amber-400', icon: 'terminal' }
  }
  return null
}

/** Resolves semantic category, badge label, color, and icon key from filename and optional MIME type. */
export function resolveFileTypeMeta(fileName: string, mimeType?: string): FileTypeMeta {
  const base = extractBaseName(fileName)
  const lowerBase = base.toLowerCase()
  const ext = extractExtension(base)
  const mime = (mimeType ?? '').trim().toLowerCase()

  const special = matchSpecialFile(lowerBase)
  if (special) return special

  if (IMAGE_EXTS.has(ext) || mime.startsWith('image/')) {
    return {
      category: 'image',
      label: ext ? ext.slice(0, MAX_FALLBACK_LABEL_LEN).toUpperCase() : 'IMG',
      color: 'text-emerald-600 dark:text-emerald-400',
      icon: 'image'
    }
  }

  if (ext === 'pdf' || mime === 'application/pdf') {
    return {
      category: 'pdf',
      label: 'PDF',
      color: 'text-red-600 dark:text-red-400',
      icon: 'pdf'
    }
  }

  if (MARKDOWN_EXTS.has(ext)) {
    return {
      category: 'markdown',
      label: ext.toUpperCase(),
      color: 'text-blue-600 dark:text-blue-400',
      icon: 'document'
    }
  }

  if (DOC_EXTS.has(ext)) {
    return {
      category: 'document',
      label: ext.toUpperCase(),
      color: 'text-blue-600 dark:text-blue-400',
      icon: 'document'
    }
  }

  if (ext in CODE_EXT_COLORS) {
    return {
      category: 'code',
      label: ext.toUpperCase(),
      color: CODE_EXT_COLORS[ext],
      icon: 'code'
    }
  }

  if (SCRIPT_EXTS.has(ext)) {
    return {
      category: 'script',
      label: ext.toUpperCase(),
      color: 'text-emerald-600 dark:text-emerald-400',
      icon: 'terminal'
    }
  }

  if (ext in CONFIG_EXT_COLORS) {
    return {
      category: 'config',
      label: ext.toUpperCase(),
      color: CONFIG_EXT_COLORS[ext],
      icon: 'config'
    }
  }

  if (SHEET_EXTS.has(ext)) {
    return {
      category: 'spreadsheet',
      label: ext.toUpperCase(),
      color: 'text-emerald-600 dark:text-emerald-400',
      icon: 'table'
    }
  }

  if (ARCHIVE_EXTS.has(ext)) {
    return {
      category: 'archive',
      label: ext.toUpperCase(),
      color: 'text-stone-600 dark:text-stone-400',
      icon: 'archive'
    }
  }

  if (ext) {
    return {
      category: 'file',
      label: ext.slice(0, MAX_FALLBACK_LABEL_LEN).toUpperCase(),
      color: 'text-ink-2',
      icon: 'file'
    }
  }

  return {
    category: 'file',
    label: '',
    color: 'text-ink-2',
    icon: 'file'
  }
}
