import { useEffect, useRef, useState } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
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
import { bracketMatching, indentOnInput } from '@codemirror/language'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import type { FileLineRange } from '@shared/fileReferences'
import { resolveCodeMirrorLanguage } from '../lib/codeEditorLanguages'
import { buildEditorThemeExtension } from '../lib/codeEditorTheme'
import { useTheme } from '../state/theme'

export type EditorSelectionRange = FileLineRange

export interface EditorCursorStatus {
  line: number
  col: number
  selectedLines: number
  selectedChars: number
}

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
  onReferenceToChat?: (selection: EditorSelectionRange | null) => void
  onCursorChange?: (status: EditorCursorStatus) => void
  addToChatLabel?: string
}

function selectedLines(state: EditorState): EditorSelectionRange | null {
  const { from, to, empty } = state.selection.main
  if (empty) return null
  const end = state.doc.lineAt(to)
  return {
    startLine: state.doc.lineAt(from).number,
    endLine: end.from === to ? state.doc.lineAt(to - 1).number : end.number
  }
}

function readCursorStatus(state: EditorState): EditorCursorStatus {
  const { head, from, to, empty } = state.selection.main
  const headLine = state.doc.lineAt(head)
  const col = head - headLine.from + 1
  if (empty) {
    return { line: headLine.number, col, selectedLines: 0, selectedChars: 0 }
  }
  const range = selectedLines(state)
  return {
    line: headLine.number,
    col,
    selectedLines: range ? range.endLine - range.startLine + 1 : 0,
    selectedChars: to - from
  }
}

export function CodeEditor({
  fileKey,
  value,
  language,
  syncVersion,
  focusToken = 0,
  readOnly = false,
  onChange,
  onSave,
  onReferenceToChat,
  onCursorChange,
  addToChatLabel
}: CodeEditorProps) {
  const { dark } = useTheme()
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const referenceButtonRef = useRef<HTMLButtonElement>(null)
  const referenceDismissed = useRef(false)
  const [referencePosition, setReferencePosition] = useState<{ left: number; top: number } | null>(null)
  const themeCompartment = useRef(new Compartment())
  const languageCompartment = useRef(new Compartment())
  const readOnlyCompartment = useRef(new Compartment())
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  const onReferenceRef = useRef(onReferenceToChat)
  const onCursorChangeRef = useRef(onCursorChange)
  const initialValueRef = useRef(value)
  const lastSyncRef = useRef({ fileKey, syncVersion })
  const darkRef = useRef(dark)
  const languageRef = useRef(language)
  const readOnlyRef = useRef(readOnly)

  onChangeRef.current = onChange
  onSaveRef.current = onSave
  onReferenceRef.current = onReferenceToChat
  onCursorChangeRef.current = onCursorChange
  initialValueRef.current = value
  darkRef.current = dark
  languageRef.current = language
  readOnlyRef.current = readOnly

  const hideReference = () => {
    referenceDismissed.current = true
    setReferencePosition(null)
  }

  const referenceToChat = (view: EditorView) => {
    const add = onReferenceRef.current
    if (!add || !view.hasFocus) return false
    hideReference()
    add(selectedLines(view.state))
    return true
  }

  // Create or reset EditorView when switching files so each file has an isolated undo history.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    referenceDismissed.current = false
    setReferencePosition(null)
    let measureFrame = 0

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
          { key: 'Mod-l', preventDefault: true, run: referenceToChat },
          { key: 'Mod-Shift-l', preventDefault: true, run: referenceToChat },
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
          if (update.selectionSet || update.docChanged) {
            onCursorChangeRef.current?.(readCursorStatus(update.state))
          }
          if (!onReferenceRef.current) return
          if (!(update.selectionSet || update.docChanged || update.geometryChanged || update.focusChanged)) return
          if (update.selectionSet || update.docChanged) referenceDismissed.current = false
          cancelAnimationFrame(measureFrame)
          measureFrame = requestAnimationFrame(() => {
            const { view } = update
            const selection = view.state.selection.main
            const button = referenceButtonRef.current
            if (referenceDismissed.current || !view.hasFocus || selection.empty || !button) {
              setReferencePosition(null)
              return
            }
            const { left, top, right, bottom } = host.getBoundingClientRect()
            const scroll = view.scrollDOM.getBoundingClientRect()
            const first = view.coordsAtPos(selection.from)
            const last = view.coordsAtPos(selection.to, -1)
            const gap = 6
            const maxLeft = right - left - button.offsetWidth - gap
            const above = first ? first.top - gap - button.offsetHeight : -Infinity
            const below = last ? last.bottom + gap : Infinity
            const fitsAbove = above >= Math.max(top, scroll.top) + gap && above + button.offsetHeight <= Math.min(bottom, scroll.bottom)
            const fitsBelow = below >= Math.max(top, scroll.top) && below + button.offsetHeight <= Math.min(bottom, scroll.bottom) - gap
            const edge = fitsAbove ? first : fitsBelow ? last : null
            setReferencePosition(edge && maxLeft >= gap ? {
              left: Math.max(gap, Math.min(maxLeft, edge.right - left - button.offsetWidth)),
              top: (fitsAbove ? above : below) - top
            } : null)
          })
        }),
        languageCompartment.current.of(resolveCodeMirrorLanguage(languageRef.current)),
        themeCompartment.current.of(buildEditorThemeExtension(darkRef.current)),
        readOnlyCompartment.current.of(EditorState.readOnly.of(readOnlyRef.current))
      ]
    })

    const view = new EditorView({ state, parent: host })
    viewRef.current = view
    lastSyncRef.current = { fileKey, syncVersion }
    onCursorChangeRef.current?.(readCursorStatus(view.state))

    const raf = requestAnimationFrame(() => {
      if (viewRef.current === view) view.focus()
    })

    return () => {
      cancelAnimationFrame(raf)
      cancelAnimationFrame(measureFrame)
      view.destroy()
      if (viewRef.current === view) viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileKey])

  // Sync theme live without rebuilding the EditorView or disturbing cursor / undo stack.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: themeCompartment.current.reconfigure(buildEditorThemeExtension(dark)) })
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
      className="cm-agentswitch-host relative h-full w-full min-h-0 overflow-hidden select-text"
      onScrollCapture={hideReference}
      onKeyDownCapture={(event) => {
        if (event.key !== 'Escape' || event.nativeEvent.isComposing || !referencePosition) return
        event.preventDefault()
        event.stopPropagation()
        hideReference()
      }}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.nativeEvent.isComposing) return
        const view = viewRef.current
        if (view && (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'l' && referenceToChat(view)) {
          event.preventDefault()
          event.stopPropagation()
        }
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
          event.preventDefault()
          event.stopPropagation()
          onSaveRef.current?.()
        }
      }}
    >
      {onReferenceToChat && (
        <button
          ref={referenceButtonRef}
          type="button"
          tabIndex={-1}
          aria-keyshortcuts="Meta+L Meta+Shift+L"
          className="absolute z-10 flex max-w-full items-center gap-2 whitespace-nowrap rounded-md border border-hairline bg-surface px-2 py-1 text-xs text-ink shadow-sm hover:bg-surface-2"
          style={referencePosition ?? { visibility: 'hidden', pointerEvents: 'none' }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (viewRef.current) referenceToChat(viewRef.current)
          }}
        >
          {addToChatLabel}
          <kbd className="text-ink-3" aria-hidden="true">⌘L</kbd>
        </button>
      )}
    </div>
  )
}
