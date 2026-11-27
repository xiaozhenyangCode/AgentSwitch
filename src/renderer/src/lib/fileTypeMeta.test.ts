import { describe, expect, it } from 'vitest'
import { resolveFileTypeMeta } from './fileTypeMeta'

describe('resolveFileTypeMeta', () => {
  it('recognizes common image extensions and image MIME types', () => {
    expect(resolveFileTypeMeta('screenshot.png')).toMatchObject({ category: 'image', label: 'PNG', icon: 'image' })
    expect(resolveFileTypeMeta('photo.HEIC')).toMatchObject({ category: 'image', label: 'HEIC', icon: 'image' })
    expect(resolveFileTypeMeta('clipboard-image', 'image/webp')).toMatchObject({ category: 'image', label: 'IMG', icon: 'image' })
  })

  it('recognizes markdown, document, and pdf files', () => {
    expect(resolveFileTypeMeta('CONTRIBUTING.md')).toMatchObject({ category: 'markdown', label: 'MD', icon: 'document' })
    expect(resolveFileTypeMeta('notes.txt')).toMatchObject({ category: 'document', label: 'TXT', icon: 'document' })
    expect(resolveFileTypeMeta('spec.pdf')).toMatchObject({ category: 'pdf', label: 'PDF', icon: 'pdf' })
    expect(resolveFileTypeMeta('download', 'application/pdf')).toMatchObject({ category: 'pdf', label: 'PDF', icon: 'pdf' })
  })

  it('recognizes frontend, backend, and shell script files', () => {
    expect(resolveFileTypeMeta('src/renderer/App.tsx')).toMatchObject({ category: 'code', label: 'TSX', icon: 'code' })
    expect(resolveFileTypeMeta('index.js')).toMatchObject({ category: 'code', label: 'JS', icon: 'code' })
    expect(resolveFileTypeMeta('theme.scss')).toMatchObject({ category: 'code', label: 'SCSS', icon: 'code' })
    expect(resolveFileTypeMeta('main.py')).toMatchObject({ category: 'code', label: 'PY', icon: 'code' })
    expect(resolveFileTypeMeta('server.go')).toMatchObject({ category: 'code', label: 'GO', icon: 'code' })
    expect(resolveFileTypeMeta('lib.rs')).toMatchObject({ category: 'code', label: 'RS', icon: 'code' })
    expect(resolveFileTypeMeta('deploy.sh')).toMatchObject({ category: 'script', label: 'SH', icon: 'terminal' })
  })

  it('recognizes config extensions and special dotfiles / extensionless build files', () => {
    expect(resolveFileTypeMeta('package.json')).toMatchObject({ category: 'config', label: 'JSON', icon: 'config' })
    expect(resolveFileTypeMeta('config.yaml')).toMatchObject({ category: 'config', label: 'YAML', icon: 'config' })
    expect(resolveFileTypeMeta('.gitignore')).toMatchObject({ category: 'config', label: 'GIT', icon: 'config' })
    expect(resolveFileTypeMeta('.npmrc')).toMatchObject({ category: 'config', label: 'NPM', icon: 'config' })
    expect(resolveFileTypeMeta('.eslintrc.json')).toMatchObject({ category: 'config', label: 'LINT', icon: 'config' })
    expect(resolveFileTypeMeta('.env.local')).toMatchObject({ category: 'config', label: 'ENV', icon: 'config' })
    expect(resolveFileTypeMeta('Dockerfile')).toMatchObject({ category: 'config', label: 'DOCKER', icon: 'config' })
    expect(resolveFileTypeMeta('Makefile')).toMatchObject({ category: 'script', label: 'MAKE', icon: 'terminal' })
  })

  it('recognizes spreadsheet and archive files', () => {
    expect(resolveFileTypeMeta('metrics.csv')).toMatchObject({ category: 'spreadsheet', label: 'CSV', icon: 'table' })
    expect(resolveFileTypeMeta('report.xlsx')).toMatchObject({ category: 'spreadsheet', label: 'XLSX', icon: 'table' })
    expect(resolveFileTypeMeta('bundle.tar.gz')).toMatchObject({ category: 'archive', label: 'GZ', icon: 'archive' })
    expect(resolveFileTypeMeta('export.zip')).toMatchObject({ category: 'archive', label: 'ZIP', icon: 'archive' })
  })

  it('falls back cleanly for unknown extensions and extensionless files', () => {
    expect(resolveFileTypeMeta('schema.sql')).toMatchObject({ category: 'file', label: 'SQL', icon: 'file' })
    expect(resolveFileTypeMeta('debug.log')).toMatchObject({ category: 'file', label: 'LOG', icon: 'file' })
    expect(resolveFileTypeMeta('yarn.lock')).toMatchObject({ category: 'file', label: 'LOCK', icon: 'file' })
    expect(resolveFileTypeMeta('data.superlongext')).toMatchObject({ category: 'file', label: 'SUPER', icon: 'file' })
    expect(resolveFileTypeMeta('LICENSE')).toMatchObject({ category: 'file', label: '', icon: 'file' })
  })
})
