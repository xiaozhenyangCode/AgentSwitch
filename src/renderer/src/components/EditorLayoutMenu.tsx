import { useEffect, useRef, useState } from 'react'
import type { EditorDockPosition, EditorFileTreePosition } from '../lib/editorLayout'
import { useEscape } from '../lib/escStack'
import type { MsgKey } from '@shared/i18n'
import { t } from '../state/i18n'
import { IconCheck, IconDockBottom, IconDockLeft, IconDockRight, IconFolderTree, IconLayout, IconMaximize, IconX } from './icons'

const docks = [
  { value: 'left', label: 'editor.dockLeft', Icon: IconDockLeft },
  { value: 'right', label: 'editor.dockRight', Icon: IconDockRight },
  { value: 'bottom', label: 'editor.dockBottom', Icon: IconDockBottom },
  { value: 'maximized', label: 'editor.dockMaximized', Icon: IconMaximize }
] as const

const trees = [
  { value: 'left', label: 'editor.treeLeft', Icon: IconDockLeft },
  { value: 'right', label: 'editor.treeRight', Icon: IconDockRight },
  { value: 'hidden', label: 'editor.treeHide', Icon: IconX }
] as const

type TreePlacement = EditorFileTreePosition | 'hidden'

export function EditorLayoutMenu({ dockPosition, treePosition, onDock, onTree }: {
  dockPosition: EditorDockPosition
  treePosition: TreePlacement
  onDock: (value: EditorDockPosition) => void
  onTree: (value: TreePlacement) => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const close = () => {
    setOpen(false)
    trigger.current?.focus({ preventScroll: true })
  }

  useEscape(close, open)
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    window.addEventListener('pointerdown', outside)
    return () => window.removeEventListener('pointerdown', outside)
  }, [open])

  const option = (label: MsgKey, Icon: typeof IconLayout, selected: boolean, choose: () => void) => (
    <button key={label} type="button" aria-pressed={selected}
      className="no-drag flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-ink hover:bg-fill focus-visible:bg-fill"
      onClick={() => { choose(); close() }}>
      <Icon size={14} className="shrink-0 text-ink-3" />
      <span className="min-w-0 flex-1">{t(label)}</span>
      {selected && <IconCheck size={13} className="shrink-0 text-accent" />}
    </button>
  )

  return (
    <div ref={root} className="no-drag" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
    }}>
      <button ref={trigger} type="button" aria-expanded={open}
        aria-label={t('editor.layoutMenu')} title={t('editor.layoutMenu')}
        onClick={() => setOpen((value) => !value)}
        className={`no-drag grid size-[22px] shrink-0 place-items-center rounded-md text-ink-3 hover:bg-fill hover:text-ink ${open ? 'bg-fill' : ''}`}>
        <IconLayout size={15} />
      </button>
      {open && (
        <div className={`no-drag absolute right-1 z-30 w-[min(192px,calc(100%-8px))] overflow-y-auto rounded-lg border border-editor-hairline bg-editor-elevated p-1
          shadow-[0_8px_24px_rgba(0,0,0,0.16)] ${dockPosition === 'bottom'
            ? 'bottom-full mb-1 max-h-[200px]' : 'top-full mt-1 max-h-[min(300px,calc(100vh-64px))]'}`}>
          <div role="group" aria-label={t('editor.layoutPanelGroup')}>
            <div className="px-2 py-1 text-[11px] text-ink-3">{t('editor.layoutPanelGroup')}</div>
            {docks.map(({ value, label, Icon }) => option(label, Icon, value === dockPosition, () => onDock(value)))}
          </div>
          <div role="group" aria-label={t('editor.layoutTreeGroup')} className="mt-1 border-t border-editor-hairline pt-1">
            <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-ink-3">
              <IconFolderTree size={12} />{t('editor.layoutTreeGroup')}
            </div>
            {trees.map(({ value, label, Icon }) => option(label, Icon, value === treePosition, () => onTree(value)))}
          </div>
        </div>
      )}
    </div>
  )
}
