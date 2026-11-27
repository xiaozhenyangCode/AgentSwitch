export type EditorEol = 'LF' | 'CRLF'

export type EditorErrorCode =
  | 'OUT_OF_BOUNDS'
  | 'NOT_FOUND'
  | 'NOT_A_FILE'
  | 'FILE_TOO_LARGE'
  | 'BINARY_FILE'
  | 'CONFLICT'
  | 'IO_ERROR'

type EditorFailure = { ok: false; code: EditorErrorCode; message: string }

export type EditorReadRequest = { path: string; workspaceDir?: string | null }

export type EditorReadResult =
  | { ok: true; path: string; realPath: string; content: string; mtimeMs: number; size: number; eol: EditorEol; language: string }
  | (EditorFailure & { size?: number; realPath?: string })

export type EditorSaveRequest = {
  path: string
  workspaceDir?: string | null
  content: string
  expectedMtimeMs: number
  eol?: EditorEol
  force?: boolean
}

export type EditorSaveResult =
  | { ok: true; mtimeMs: number; size: number }
  | (EditorFailure & { currentMtimeMs?: number })

export type EditorWatchRequest = { path: string; workspaceDir?: string | null }
export type EditorActionResult = { ok: true } | EditorFailure

export type EditorFileChangedEvent = {
  path: string
  realPath: string
  mtimeMs: number
  size: number
  deleted?: boolean
}

export const EDITOR_MAX_BYTES = 2 * 1024 * 1024

const LANGUAGES_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'tsx',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'jsx',
  '.json': 'json', '.jsonc': 'json', '.md': 'markdown', '.mdx': 'markdown',
  '.markdown': 'markdown', '.css': 'css', '.scss': 'scss', '.sass': 'sass', '.less': 'less',
  '.html': 'html', '.htm': 'html', '.vue': 'vue', '.svelte': 'svelte',
  '.py': 'python', '.pyi': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java',
  '.kt': 'kotlin', '.kts': 'kotlin', '.swift': 'swift', '.c': 'c', '.h': 'c',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp', '.hxx': 'cpp',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.fish': 'shell',
  '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml', '.xml': 'xml', '.xsd': 'xml',
  '.plist': 'xml', '.svg': 'xml', '.ini': 'ini', '.cfg': 'ini', '.env': 'env',
  '.sql': 'sql', '.mk': 'makefile', '.rb': 'ruby', '.php': 'php', '.txt': 'plaintext'
}

const LANGUAGES_BY_FILENAME = new Map([
  ['.gitignore', 'plaintext'], ['.gitattributes', 'plaintext'], ['.dockerignore', 'plaintext'],
  ['.gitmodules', 'ini'], ['.editorconfig', 'ini'], ['.npmrc', 'ini'],
  ['.bashrc', 'shell'], ['.bash_profile', 'shell'], ['.zshrc', 'shell'], ['.zprofile', 'shell'],
  ['.env', 'env'], ['dockerfile', 'dockerfile'], ['containerfile', 'dockerfile'],
  ['makefile', 'makefile'], ['gnumakefile', 'makefile']
])

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.icns', '.tif', '.tiff',
  '.heic', '.heif', '.avif', '.psd', '.svgz',
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.tbz', '.xz', '.txz', '.zst', '.7z', '.rar',
  '.jar', '.war', '.dmg', '.iso', '.apk', '.ipa',
  '.pdf', '.doc', '.docx', '.docm', '.xls', '.xlsx', '.xlsm', '.ppt', '.pptx', '.pptm',
  '.odt', '.ods', '.odp', '.pages', '.numbers', '.key',
  '.mp3', '.wav', '.aac', '.m4a', '.flac', '.ogg', '.opus', '.aif', '.aiff',
  '.mp4', '.mov', '.m4v', '.mkv', '.avi', '.webm', '.wmv', '.mpeg', '.mpg',
  '.exe', '.dll', '.dylib', '.so', '.a', '.o', '.obj', '.node', '.class', '.wasm',
  '.bin', '.dat', '.pyc', '.db', '.sqlite', '.sqlite3',
  '.ttf', '.otf', '.woff', '.woff2', '.eot'
])

function fileName(filePath: string): string {
  return (filePath.split(/[/\\]/).pop() ?? '').toLowerCase()
}

function extension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot) : ''
}

export function detectEditorLanguage(filePath: string): string {
  const name = fileName(filePath)
  if (name.startsWith('.env.')) return 'env'
  if (name.startsWith('dockerfile.') || name.endsWith('.dockerfile')) return 'dockerfile'
  return LANGUAGES_BY_FILENAME.get(name) ?? LANGUAGES_BY_EXTENSION[extension(name)] ?? 'plaintext'
}

export function isKnownBinaryPath(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(extension(fileName(filePath)))
}
