import { useEffect, useRef } from 'react'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting
} from '@codemirror/language'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { tags as t } from '@lezer/highlight'
import { resolveCodeMirrorLanguage } from '../lib/codeEditorLanguages'
import { useTheme } from '../state/theme'

export interface CodeEditorProps {
  /** Unique key per open file; changing it resets EditorState (independent undo history). */
  fileKey: string
  value: string
  language: string
  /** Increment to replace document content from disk (e.g. silent reload / conflict reload). */
  syncVersion: number
  /** Increment to request focusing the editor (e.g. clicking an already-open tab). */
  focusToken?: number
  readOnly?: boolean
  onChange: (nextValue: string) => void
  onSave?: () => void
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

function buildThemeExtension(dark: boolean): Extension {
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
      }
    },
    { dark }
  )
  return [baseTheme, syntaxHighlighting(dark ? darkHighlight : lightHighlight)]
}

export function CodeEditor({
  fileKey,
  value,
  language,
  syncVersion,
  focusToken = 0,
  readOnly = false,
  onChange,
  onSave
}: CodeEditorProps) {
  const { dark } = useTheme()
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const themeCompartment = useRef(new Compartment())
  const languageCompartment = useRef(new Compartment())
  const readOnlyCompartment = useRef(new Compartment())
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  const initialValueRef = useRef(value)
  const lastSyncRef = useRef({ fileKey, syncVersion })
  const darkRef = useRef(dark)
  const languageRef = useRef(language)
  const readOnlyRef = useRef(readOnly)

  onChangeRef.current = onChange
  onSaveRef.current = onSave
  initialValueRef.current = value
  darkRef.current = dark
  languageRef.current = language
  readOnlyRef.current = readOnly

  // Create or reset EditorView when switching files so each file has an isolated undo history.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const state = EditorState.create({
      doc: initialValueRef.current,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        indentOnInput(),
        bracketMatching(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true }),
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              onSaveRef.current?.()
              return true
            }
          },
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          indentWithTab
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString())
          }
        }),
        languageCompartment.current.of(resolveCodeMirrorLanguage(languageRef.current)),
        themeCompartment.current.of(buildThemeExtension(darkRef.current)),
        readOnlyCompartment.current.of(EditorState.readOnly.of(readOnlyRef.current))
      ]
    })

    const view = new EditorView({ state, parent: host })
    viewRef.current = view
    lastSyncRef.current = { fileKey, syncVersion }

    const raf = requestAnimationFrame(() => {
      if (viewRef.current === view) view.focus()
    })

    return () => {
      cancelAnimationFrame(raf)
      view.destroy()
      if (viewRef.current === view) viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileKey])

  // Sync theme live without rebuilding the EditorView or disturbing cursor / undo stack.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: themeCompartment.current.reconfigure(buildThemeExtension(dark)) })
  }, [dark])

  // Sync language extension if detected language changes.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: languageCompartment.current.reconfigure(resolveCodeMirrorLanguage(language)) })
  }, [language])

  // Sync readOnly state.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: readOnlyCompartment.current.reconfigure(EditorState.readOnly.of(readOnly)) })
  }, [readOnly])

  // Apply external reload (silent refresh or explicit reload after conflict) in place.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (lastSyncRef.current.fileKey === fileKey && lastSyncRef.current.syncVersion === syncVersion) return
    lastSyncRef.current = { fileKey, syncVersion }
    const current = view.state.doc.toString()
    if (current === value) return
    const anchor = Math.min(view.state.selection.main.anchor, value.length)
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      selection: { anchor }
    })
  }, [fileKey, syncVersion, value])

  // Focus editor when explicitly requested (e.g. re-opening an already active file).
  useEffect(() => {
    if (!focusToken) return
    const view = viewRef.current
    if (!view) return
    const raf = requestAnimationFrame(() => view.focus())
    return () => cancelAnimationFrame(raf)
  }, [focusToken])

  return (
    <div
      ref={hostRef}
      className="cm-agentswitch-host h-full w-full min-h-0 overflow-hidden select-text"
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
          event.preventDefault()
          event.stopPropagation()
          onSaveRef.current?.()
        }
      }}
    />
  )
}
