import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

export interface EditorIndentInfo {
  kind: 'tabs' | 'spaces'
  size: number
}

/** Detects predominant indentation style (Spaces: 2/4 or Tabs) from document text. */
export function detectIndentInfo(content: string): EditorIndentInfo {
  let tabLines = 0
  let space2 = 0
  let space4 = 0
  let seen = 0
  const lines = content.split('\n')
  for (let i = 0; i < lines.length && seen < 120; i++) {
    const line = lines[i]
    if (!line || line.trim().length === 0) continue
    if (line[0] === '\t') {
      tabLines++
      seen++
      continue
    }
    const match = /^( +)\S/.exec(line)
    if (match) {
      const len = match[1].length
      seen++
      if (len === 2 || (len % 2 === 0 && len % 4 !== 0)) space2++
      else if (len % 4 === 0) space4++
    }
  }
  if (tabLines > space2 + space4 && tabLines > 0) return { kind: 'tabs', size: 4 }
  if (space4 > space2 * 1.5 && space2 === 0) return { kind: 'spaces', size: 4 }
  return { kind: 'spaces', size: 2 }
}

const lightHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword], color: '#af00db' },
  { tag: [t.controlKeyword, t.moduleKeyword], color: '#af00db' },
  { tag: [t.string, t.special(t.string), t.inserted], color: '#a31515' },
  { tag: [t.number, t.bool, t.null, t.atom], color: '#098658' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: '#6e7781', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#795e26' },
  { tag: [t.typeName, t.className, t.namespace], color: '#267f99' },
  { tag: [t.propertyName, t.attributeName], color: '#0451a5' },
  { tag: [t.tagName], color: '#800000' },
  { tag: [t.variableName, t.definition(t.variableName)], color: '#001080' },
  { tag: [t.regexp, t.escape], color: '#811f3f' },
  { tag: [t.heading], color: '#0451a5', fontWeight: '600' },
  { tag: [t.link, t.url], color: '#0066d6', textDecoration: 'underline' },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.strong], fontWeight: '600' },
  { tag: [t.deleted], color: '#cf222e' },
  { tag: [t.invalid], color: '#d70015', textDecoration: 'underline wavy' }
])

const darkHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword], color: '#c586c0' },
  { tag: [t.controlKeyword, t.moduleKeyword], color: '#c586c0' },
  { tag: [t.string, t.special(t.string), t.inserted], color: '#ce9178' },
  { tag: [t.number, t.bool, t.null, t.atom], color: '#b5cea8' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: '#7c8590', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#dcdcaa' },
  { tag: [t.typeName, t.className, t.namespace], color: '#4ec9b0' },
  { tag: [t.propertyName, t.attributeName], color: '#9cdcfe' },
  { tag: [t.tagName], color: '#569cd6' },
  { tag: [t.variableName, t.definition(t.variableName)], color: '#9cdcfe' },
  { tag: [t.regexp, t.escape], color: '#d16969' },
  { tag: [t.heading], color: '#64a8ff', fontWeight: '600' },
  { tag: [t.link, t.url], color: '#409cff', textDecoration: 'underline' },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.strong], fontWeight: '600' },
  { tag: [t.deleted], color: '#ff6961' },
  { tag: [t.invalid], color: '#ff6961', textDecoration: 'underline wavy' }
])

export function buildEditorThemeExtension(dark: boolean): Extension {
  const baseTheme = EditorView.theme(
    {
      '&': {
        height: '100%',
        backgroundColor: 'var(--surface)',
        color: 'var(--ink)',
        fontSize: '13px',
        fontFamily: 'var(--font-mono)'
      },
      '&.cm-focused': {
        outline: 'none'
      },
      '.cm-scroller': {
        overflow: 'auto',
        fontFamily: 'var(--font-mono)',
        lineHeight: '1.6',
        paddingTop: '8px',
        paddingBottom: '24px'
      },
      '.cm-content': {
        caretColor: 'var(--accent)',
        padding: '0 12px 0 4px'
      },
      '.cm-cursor, .cm-dropCursor': {
        borderLeftColor: 'var(--accent)',
        borderLeftWidth: '1.8px'
      },
      '.cm-gutters': {
        backgroundColor: 'var(--surface)',
        color: 'var(--ink-3)',
        borderRight: '1px solid var(--hairline)',
        paddingRight: '6px',
        userSelect: 'none'
      },
      '.cm-lineNumbers .cm-gutterElement': {
        minWidth: '38px',
        paddingLeft: '10px',
        paddingRight: '8px',
        fontSize: '11.5px'
      },
      '.cm-activeLine': {
        backgroundColor: dark ? 'rgba(255, 255, 255, 0.045)' : 'rgba(0, 0, 0, 0.03)'
      },
      '.cm-activeLineGutter': {
        backgroundColor: dark ? 'rgba(255, 255, 255, 0.055)' : 'rgba(0, 0, 0, 0.04)',
        color: 'var(--ink)'
      },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: dark ? 'rgba(10, 132, 255, 0.32)' : 'rgba(0, 122, 255, 0.2)'
      },
      '.cm-selectionMatch': {
        backgroundColor: dark ? 'rgba(255, 214, 10, 0.18)' : 'rgba(255, 193, 7, 0.28)',
        borderRadius: '2px'
      },
      '.cm-matchingBracket': {
        backgroundColor: dark ? 'rgba(10, 132, 255, 0.24)' : 'rgba(0, 122, 255, 0.16)',
        outline: dark ? '1px solid rgba(10, 132, 255, 0.45)' : '1px solid rgba(0, 122, 255, 0.35)',
        borderRadius: '2px'
      },
      '.cm-searchMatch': {
        backgroundColor: dark ? 'rgba(255, 159, 10, 0.28)' : 'rgba(255, 159, 10, 0.3)',
        borderRadius: '2px'
      },
      '.cm-searchMatch.cm-searchMatch-selected': {
        backgroundColor: dark ? 'rgba(10, 132, 255, 0.48)' : 'rgba(0, 122, 255, 0.35)'
      },
      '.cm-panels': {
        backgroundColor: 'var(--surface-2)',
        color: 'var(--ink)',
        borderColor: 'var(--hairline)',
        fontFamily: 'var(--font-sans)'
      },
      '.cm-panels.cm-panels-top': {
        borderBottom: '1px solid var(--hairline)'
      },
      '.cm-panels.cm-panels-bottom': {
        borderTop: '1px solid var(--hairline)'
      },
      '.cm-search': {
        padding: '6px 10px',
        fontSize: '12px',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '6px'
      },
      '.cm-search input.cm-textfield': {
        backgroundColor: 'var(--surface)',
        color: 'var(--ink)',
        border: '1px solid var(--hairline)',
        borderRadius: '6px',
        padding: '3px 8px',
        fontSize: '12px',
        outline: 'none'
      },
      '.cm-search input.cm-textfield:focus': {
        borderColor: 'var(--accent)'
      },
      '.cm-search button.cm-button': {
        backgroundImage: 'none',
        backgroundColor: 'var(--fill)',
        color: 'var(--ink)',
        border: '1px solid var(--hairline)',
        borderRadius: '6px',
        padding: '3px 8px',
        fontSize: '11.5px',
        cursor: 'default'
      },
      '.cm-search button.cm-button:hover': {
        backgroundColor: 'var(--fill-hover)'
      },
      '.cm-search label': {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        fontSize: '11.5px',
        color: 'var(--ink-2)'
      },
      '.cm-panel.cm-search [name=close]': {
        color: 'var(--ink-3)',
        top: '6px',
        right: '8px',
        cursor: 'default'
      },
      // @codemirror/merge unified & side-by-side diff highlights
      '.cm-changedLine': {
        backgroundColor: dark ? 'rgba(48, 209, 88, 0.14)' : 'rgba(26, 127, 69, 0.11)'
      },
      '.cm-changedText': {
        background: 'none',
        backgroundColor: dark ? 'rgba(48, 209, 88, 0.28)' : 'rgba(26, 127, 69, 0.22)',
        borderRadius: '2px'
      },
      '.cm-deletedChunk': {
        backgroundColor: dark ? 'rgba(255, 69, 58, 0.14)' : 'rgba(215, 0, 21, 0.09)',
        paddingLeft: '4px'
      },
      '.cm-deletedChunk .cm-deletedText': {
        background: 'none',
        backgroundColor: dark ? 'rgba(255, 69, 58, 0.30)' : 'rgba(215, 0, 21, 0.20)',
        borderRadius: '2px'
      },
      '.cm-merge-a .cm-changedLine': {
        backgroundColor: dark ? 'rgba(255, 69, 58, 0.14)' : 'rgba(215, 0, 21, 0.09)'
      },
      '.cm-merge-a .cm-changedText': {
        background: 'none',
        backgroundColor: dark ? 'rgba(255, 69, 58, 0.30)' : 'rgba(215, 0, 21, 0.20)'
      },
      '.cm-changeGutter': {
        width: '3px',
        padding: '0'
      },
      '.cm-changedLineGutter': {
        backgroundColor: dark ? 'rgba(48, 209, 88, 0.7)' : 'rgba(26, 127, 69, 0.65)'
      },
      '.cm-merge-a .cm-changedLineGutter': {
        backgroundColor: dark ? 'rgba(255, 69, 58, 0.75)' : 'rgba(215, 0, 21, 0.65)'
      },
      '.cm-collapsedLines': {
        background: dark ? 'rgba(255, 255, 255, 0.04)' : 'rgba(0, 0, 0, 0.035)',
        color: 'var(--ink-3)',
        borderTop: '1px solid var(--hairline)',
        borderBottom: '1px solid var(--hairline)',
        padding: '2px 12px',
        fontFamily: 'var(--font-sans)',
        fontSize: '11.5px',
        cursor: 'default'
      }
    },
    { dark }
  )
  return [baseTheme, syntaxHighlighting(dark ? darkHighlight : lightHighlight)]
}
