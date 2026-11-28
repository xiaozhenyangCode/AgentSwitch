import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { joinPosixRelative } from '@shared/fileResolve'
import type { FileSearchItem } from '@shared/types'
import { useEscape } from '../lib/escStack'
import { resolveFileTypeMeta } from '../lib/fileTypeMeta'
import { t } from '../state/i18n'
import { FileTypeIcon } from './AttachmentBar'
import { IconSearch, Spinner } from './icons'

function highlightMatches(name: string, indexes: number[]): ReactNode {
  if (!indexes.length) return name
  const parts: ReactNode[] = []
  let offset = 0
  for (let i = 0; i < indexes.length;) {
    const start = indexes[i++]
    let end = start + 1
    while (indexes[i] === end) {
      i++
      end++
    }
    if (start > offset) parts.push(name.slice(offset, start))
    parts.push(<span key={start} className="font-semibold text-accent">{name.slice(start, end)}</span>)
    offset = end
  }
  parts.push(name.slice(offset))
  return parts
}

export function QuickOpenModal({
  projectDir,
  onSelect,
  onClose
}: {
  projectDir: string | null
  onSelect: (absPath: string) => void
  onClose: () => void
}) {
  useEscape(onClose)
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<FileSearchItem[]>([])
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const activeRowRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!projectDir) {
      setItems([])
      setLoading(false)
      setFailed(false)
      return
    }
    let cancelled = false
    setLoading(true)
    const run = () => {
      void window.agentswitch.files.search({ cwd: projectDir, query, limit: 30 }).then(
        (res) => {
          if (cancelled) return
          setItems(res.items)
          setActive(0)
          setFailed(false)
          setLoading(false)
        },
        () => {
          if (cancelled) return
          setItems([])
          setFailed(true)
          setLoading(false)
        }
      )
    }
    const timer = query ? setTimeout(run, 30) : undefined
    if (!query) run()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [projectDir, query])

  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [active, items])

  const pick = (item: FileSearchItem | undefined) => {
    if (!item || !projectDir) return
    const abs = joinPosixRelative(projectDir, item.relPath, { literalPosix: true })
    if (!abs) return
    onSelect(abs)
    onClose()
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center bg-(--scrim-soft) px-4 pt-[12vh]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-label={t('editor.quickOpenTitle')}
        className="flex max-h-[60vh] w-[540px] max-w-full flex-col overflow-hidden rounded-lg border border-editor-hairline bg-editor-elevated shadow-[0_24px_64px_rgba(0,0,0,0.24)]"
      >
        <div className="flex items-center gap-2.5 border-b border-editor-hairline px-3.5 py-2.5">
          <IconSearch size={15} className="shrink-0 text-ink-3" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((i) => (items.length ? (i + 1) % items.length : 0))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((i) => (items.length ? (i - 1 + items.length) % items.length : 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                pick(items[active])
              }
            }}
            placeholder={projectDir ? t('editor.quickOpenPlaceholder') : t('wb.fileSearchNoProject')}
            disabled={!projectDir}
            className="min-w-0 flex-1 bg-transparent text-[13.5px] text-ink outline-none placeholder:text-ink-3"
          />
          {loading && <Spinner size={13} className="text-ink-3" />}
          <kbd className="rounded-md bg-fill px-1.5 py-0.5 font-mono text-[10.5px] text-ink-3">ESC</kbd>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {!projectDir ? (
            <div className="px-3 py-6 text-center text-[13px] text-ink-3">{t('wb.fileSearchNoProject')}</div>
          ) : failed ? (
            <div className="px-3 py-6 text-center text-[13px] text-ink-3">{t('wb.fileSearchError')}</div>
          ) : !items.length && !loading ? (
            <div className="px-3 py-6 text-center text-[13px] text-ink-3">{t('wb.fileSearchEmpty')}</div>
          ) : (
            items.map((item, idx) => {
              const meta = resolveFileTypeMeta(item.name)
              const selected = idx === active
              return (
                <button
                  key={item.relPath}
                  ref={selected ? activeRowRef : undefined}
                  type="button"
                  onMouseMove={() => idx !== active && setActive(idx)}
                  onClick={() => pick(item)}
                  className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors ${
                    selected ? 'bg-accent/12' : 'hover:bg-fill/70'
                  }`}
                >
                  <FileTypeIcon kind={meta.icon} size={15} className={`shrink-0 ${meta.color}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[13px] leading-5 text-ink">
                      {highlightMatches(item.name, item.indexes)}
                    </span>
                    {item.dir && (
                      <span className="block truncate font-mono text-[11.5px] leading-4 text-ink-3">{item.dir}</span>
                    )}
                  </span>
                </button>
              )
            })
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
