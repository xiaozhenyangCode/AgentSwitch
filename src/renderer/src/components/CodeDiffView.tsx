import { useEffect, useRef, useState } from 'react'
import { EditorState } from '@codemirror/state'
import { selectAll } from '@codemirror/commands'
import { search, searchKeymap } from '@codemirror/search'
import { drawSelection, EditorView, highlightSpecialChars, keymap, lineNumbers } from '@codemirror/view'
import { MergeView, unifiedMergeView } from '@codemirror/merge'
import { resolveCodeMirrorLanguage } from '../lib/codeEditorLanguages'
import { buildEditorThemeExtension } from '../lib/codeEditorTheme'
import { useTheme } from '../state/theme'
import { t } from '../state/i18n'
import { Spinner } from './icons'

export interface CodeDiffViewProps {
  mode: 'conflict' | 'unsaved'
  original: string
  modified: string
  language: string
  saving?: boolean
  onAcceptDisk?: () => void
  onKeepMineAndSave?: () => void
  onExit: () => void
}

export function CodeDiffView({
  mode,
  original,
  modified,
  language,
  saving = false,
  onAcceptDisk,
  onKeepMineAndSave,
  onExit
}: CodeDiffViewProps) {
  const { dark } = useTheme()
  const [layout, setLayout] = useState<'unified' | 'split'>('unified')
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const shared = [
      lineNumbers(),
      highlightSpecialChars(),
      drawSelection(),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.contentAttributes.of({ tabindex: '0' }),
      search({ top: true }),
      keymap.of([{ key: 'Mod-a', run: selectAll, preventDefault: true }, ...searchKeymap]),
      resolveCodeMirrorLanguage(language),
      buildEditorThemeExtension(dark)
    ]

    if (layout === 'unified') {
      const view = new EditorView({
        parent: host,
        state: EditorState.create({
          doc: modified,
          extensions: [
            ...shared,
            unifiedMergeView({
              original,
              highlightChanges: true,
              gutter: true,
              mergeControls: false,
              collapseUnchanged: { margin: 3, minSize: 4 }
            })
          ]
        })
      })
      return () => view.destroy()
    }

    const merge = new MergeView({
      parent: host,
      a: { doc: original, extensions: shared },
      b: { doc: modified, extensions: shared },
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: { margin: 3, minSize: 4 }
    })
    return () => merge.destroy()
  }, [layout, original, modified, language, dark])

  const originalLabel = mode === 'conflict' ? t('editor.diffDiskLabel') : t('editor.diffSavedLabel')
  const modifiedLabel = t('editor.diffCurrentLabel')

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      {/* Diff Header Bar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline bg-surface-2/85 px-3 py-1.5 text-[12px]">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded bg-danger-soft px-1.5 py-0.5 text-[11px] font-medium text-danger">
            − {originalLabel}
          </span>
          <span className="text-ink-3">/</span>
          <span className="inline-flex items-center gap-1 rounded bg-ok-soft px-1.5 py-0.5 text-[11px] font-medium text-ok">
            + {modifiedLabel}
          </span>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <div className="flex items-center rounded-md bg-fill p-0.5 text-[11px]">
            <button
              type="button"
              onClick={() => setLayout('unified')}
              className={`rounded px-2 py-0.5 font-medium transition-colors ${
                layout === 'unified' ? 'bg-surface text-ink shadow-xs' : 'text-ink-3 hover:text-ink'
              }`}
            >
              {t('editor.diffUnified')}
            </button>
            <button
              type="button"
              onClick={() => setLayout('split')}
              className={`rounded px-2 py-0.5 font-medium transition-colors ${
                layout === 'split' ? 'bg-surface text-ink shadow-xs' : 'text-ink-3 hover:text-ink'
              }`}
            >
              {t('editor.diffSplit')}
            </button>
          </div>

          {mode === 'conflict' && onAcceptDisk && (
            <button
              type="button"
              disabled={saving}
              onClick={onAcceptDisk}
              className="rounded-md bg-surface px-2.5 py-1 text-[11.5px] font-medium text-ink shadow-[0_0_0_1px_var(--ring)] hover:bg-surface-2 disabled:opacity-50"
            >
              {t('editor.acceptDisk')}
            </button>
          )}
          {mode === 'conflict' && onKeepMineAndSave && (
            <button
              type="button"
              disabled={saving}
              onClick={onKeepMineAndSave}
              className="inline-flex items-center gap-1 rounded-md bg-danger px-2.5 py-1 text-[11.5px] font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {saving && <Spinner size={11} />}
              {t('editor.keepMineAndSave')}
            </button>
          )}
          <button
            type="button"
            onClick={onExit}
            className="rounded-md px-2 py-1 text-[11.5px] font-medium text-ink-2 hover:bg-black/[0.06] hover:text-ink dark:hover:bg-white/[0.08]"
          >
            {t('editor.exitDiff')}
          </button>
        </div>
      </div>

      {/* Column labels for side-by-side layout */}
      {layout === 'split' && (
        <div className="grid shrink-0 grid-cols-2 border-b border-hairline bg-surface-2/40 text-[11px] font-medium text-ink-3">
          <div className="truncate border-r border-hairline px-3 py-1">{originalLabel}</div>
          <div className="truncate px-3 py-1">{modifiedLabel}</div>
        </div>
      )}

      {/* Diff Editor Host */}
      <div
        ref={hostRef}
        className="cm-agentswitch-host cm-agentswitch-diff min-h-0 flex-1 overflow-hidden select-text"
      />
    </div>
  )
}
