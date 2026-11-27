import { describe, expect, it } from 'vitest'
import { detectEditorLanguage } from '@shared/editor'
import { resolveCodeMirrorLanguage } from './codeEditorLanguages'

describe('resolveCodeMirrorLanguage', () => {
  it('returns language extensions for supported code and config languages', () => {
    const supported = [
      'src/app.ts',
      'src/App.tsx',
      'src/index.js',
      'src/Button.jsx',
      'package.json',
      'README.md',
      'index.html',
      'styles.css',
      'script.py',
      'main.rs',
      'main.go',
      'App.java',
      'main.cpp',
      'query.sql',
      'config.xml',
      'ci.yaml'
    ]
    for (const file of supported) {
      const lang = detectEditorLanguage(file)
      const ext = resolveCodeMirrorLanguage(lang)
      expect(Array.isArray(ext) && ext.length === 0).toBe(false)
    }
  })

  it('gracefully falls back to empty extension for plaintext and unmapped languages', () => {
    expect(resolveCodeMirrorLanguage('plaintext')).toEqual([])
    expect(resolveCodeMirrorLanguage(detectEditorLanguage('.gitignore'))).toEqual([])
    expect(resolveCodeMirrorLanguage(detectEditorLanguage('notes.txt'))).toEqual([])
    expect(resolveCodeMirrorLanguage('unknown-lang')).toEqual([])
  })
})
