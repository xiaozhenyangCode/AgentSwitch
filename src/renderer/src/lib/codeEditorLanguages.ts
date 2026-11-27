import type { Extension } from '@codemirror/state'
import { cpp } from '@codemirror/lang-cpp'
import { css } from '@codemirror/lang-css'
import { go } from '@codemirror/lang-go'
import { html } from '@codemirror/lang-html'
import { java } from '@codemirror/lang-java'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { sql } from '@codemirror/lang-sql'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/lang-yaml'

/** Maps a canonical language id from `detectEditorLanguage` to a CodeMirror 6 extension. */
export function resolveCodeMirrorLanguage(language: string): Extension {
  switch (language) {
    case 'typescript':
      return javascript({ typescript: true })
    case 'tsx':
      return javascript({ typescript: true, jsx: true })
    case 'javascript':
      return javascript()
    case 'jsx':
      return javascript({ jsx: true })
    case 'json':
      return json()
    case 'markdown':
      return markdown()
    case 'html':
    case 'vue':
    case 'svelte':
      return html()
    case 'css':
    case 'scss':
    case 'sass':
    case 'less':
      return css()
    case 'python':
      return python()
    case 'rust':
      return rust()
    case 'go':
      return go()
    case 'java':
    case 'kotlin':
      return java()
    case 'c':
    case 'cpp':
      return cpp()
    case 'sql':
      return sql()
    case 'xml':
      return xml()
    case 'yaml':
      return yaml()
    default:
      return []
  }
}
