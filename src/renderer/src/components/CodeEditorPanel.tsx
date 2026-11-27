import { Fragment, useState, type PointerEvent } from 'react'
import { resolveFileTypeMeta } from '../lib/fileTypeMeta'
import { btnPrimary, btnSecondary } from '../lib/ui'
import { isTabDirty, type EditorTab, type PendingClosePrompt } from '../state/useCodeEditor'
import { t } from '../state/i18n'
import { FileTypeIcon } from './AttachmentBar'
import { CodeEditor } from './CodeEditor'
import { Modal } from './common'
import {
  IconAlert,
  IconCheck,
  IconChevronRight,
  IconExternal,
  IconFile,
  IconFolder,
  IconMaximize,
  IconMinimize,
  IconRefresh,
  IconX,
  Spinner
} from './icons'

const WIDTH_KEY = 'agentswitch.editorWidth'
const DEFAULT_W = 540
const MIN_W = 360
const MAX_W = 1100

const fmtBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`

function breadcrumbSegments(filePath: string, projectDir: string | null): string[] {
  const normFile = filePath.replace(/\\/g, '/')
  if (projectDir) {
    const normProj = projectDir.replace(/\\/g, '/').replace(/\/+$/, '')
    if (normFile.startsWith(normProj + '/')) {
      return normFile.slice(normProj.length + 1).split('/').filter(Boolean)
    }
  }
  const parts = normFile.split('/').filter(Boolean)
  if (parts.length <= 4) return parts
  return ['…', ...parts.slice(-3)]
}

const iconBtn =
  'no-drag grid h-7 w-7 shrink-0 place-items-center rounded-lg text-ink-3 transition-colors hover:bg-black/[0.06] hover:text-ink dark:hover:bg-white/[0.08] disabled:opacity-40'

export interface CodeEditorPanelProps {
  tabs: EditorTab[]
  activeTab: EditorTab | null
  projectDir: string | null
  maximized: boolean
  focusToken: number
  pendingClose: PendingClosePrompt | null
  onToggleMaximize: () => void
  onSelectTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  onClosePanel: () => void
  onChangeContent: (tabId: string, content: string) => void
  onSaveTab: (tabId: string, options?: { force?: boolean }) => void
  onReloadTab: (tabId: string) => void
  onDismissExternalChange: (tabId: string) => void
  onResolvePendingClose: (action: 'save' | 'discard' | 'cancel') => void
}

export function CodeEditorPanel({
  tabs,
  activeTab,
  projectDir,
  maximized,
  focusToken,
  pendingClose,
  onToggleMaximize,
  onSelectTab,
  onCloseTab,
  onClosePanel,
  onChangeContent,
  onSaveTab,
  onReloadTab,
  onDismissExternalChange,
  onResolvePendingClose
}: CodeEditorPanelProps) {
  const [width, setWidth] = useState(() =>
    Math.min(MAX_W, Math.max(MIN_W, Number(localStorage.getItem(WIDTH_KEY)) || DEFAULT_W))
  )

  const startDrag = (e: PointerEvent) => {
    if (maximized) return
    e.preventDefault()
    const x0 = e.clientX
    const w0 = width
    let w = w0
    const move = (ev: globalThis.PointerEvent) => {
      w = Math.min(MAX_W, Math.max(MIN_W, w0 + (x0 - ev.clientX)))
      setWidth(w)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
      localStorage.setItem(WIDTH_KEY, String(w))
    }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const dirty = activeTab ? isTabDirty(activeTab) : false
  const canExternalAction =
    !!activeTab &&
    activeTab.error?.code !== 'OUT_OF_BOUNDS' &&
    activeTab.error?.code !== 'NOT_FOUND'
  const crumbs = activeTab ? breadcrumbSegments(activeTab.realPath ?? activeTab.path, activeTab.workspaceDir ?? projectDir) : []

  const revealInFinder = () => {
    if (!activeTab) return
    void window.agentswitch.editor.revealInFinder({
      path: activeTab.path,
      workspaceDir: activeTab.workspaceDir ?? projectDir
    })
  }

  const openExternal = () => {
    if (!activeTab) return
    void window.agentswitch.editor.openExternal({
      path: activeTab.path,
      workspaceDir: activeTab.workspaceDir ?? projectDir
    })
  }

  return (
    <aside
      className={`relative flex h-full min-w-0 flex-col border-l border-hairline bg-surface ${maximized ? 'flex-1' : 'shrink-0'}`}
      style={maximized ? undefined : { width }}
    >
      {!maximized && (
        <div
          className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize transition-colors hover:bg-accent/25"
          onPointerDown={startDrag}
          onDoubleClick={() => {
            setWidth(DEFAULT_W)
            localStorage.setItem(WIDTH_KEY, String(DEFAULT_W))
          }}
          title={t('chg.resize')}
        />
      )}

      {/* Top Tab Bar + Action Controls */}
      <div className="drag flex h-11 shrink-0 items-center gap-1 border-b border-hairline bg-surface-2/80 pr-2 pl-1.5">
        <div className="no-drag flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overflow-y-hidden py-1">
          {tabs.map((tab) => {
            const selected = activeTab?.id === tab.id
            const tabDirty = isTabDirty(tab)
            const meta = resolveFileTypeMeta(tab.name)
            return (
              <div
                key={tab.id}
                title={tab.path}
                onMouseDown={(e) => {
                  if (e.button === 1) {
                    e.preventDefault()
                    onCloseTab(tab.id)
                  }
                }}
                className={`group flex h-8 max-w-[180px] shrink-0 items-center gap-1.5 rounded-lg pr-1 pl-2 text-[12px] transition-colors ${
                  selected
                    ? 'bg-surface font-medium text-ink shadow-[0_0_0_1px_var(--ring)]'
                    : 'text-ink-2 hover:bg-black/[0.04] hover:text-ink dark:hover:bg-white/[0.06]'
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelectTab(tab.id)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                >
                  <FileTypeIcon kind={meta.icon} size={13} className={`shrink-0 ${meta.color}`} />
                  <span className="truncate">{tab.name}</span>
                </button>
                {tabDirty && (
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent group-hover:hidden"
                    title={t('editor.unsaved')}
                  />
                )}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onCloseTab(tab.id)
                  }}
                  title={t('common.close')}
                  aria-label={t('common.close')}
                  className={`grid h-5 w-5 shrink-0 place-items-center rounded text-ink-3 transition-opacity hover:bg-black/[0.08] hover:text-ink dark:hover:bg-white/[0.12] ${
                    tabDirty
                      ? 'hidden group-hover:grid'
                      : selected
                        ? 'opacity-70 hover:opacity-100'
                        : 'opacity-0 group-hover:opacity-80 hover:!opacity-100'
                  }`}
                >
                  <IconX size={11} />
                </button>
              </div>
            )
          })}
        </div>

        <div className="no-drag flex shrink-0 items-center gap-0.5 border-l border-hairline pl-1.5">
          {activeTab?.status === 'ready' && (
            <button
              type="button"
              onClick={() => onSaveTab(activeTab.id)}
              disabled={activeTab.saving || (!dirty && !activeTab.conflictMtimeMs)}
              title={`${t('common.save')} (⌘S)`}
              className={`flex h-7 items-center gap-1 rounded-lg px-2 text-[12px] font-medium transition-colors ${
                dirty || activeTab.conflictMtimeMs
                  ? 'bg-accent text-white hover:bg-accent-hover disabled:opacity-50'
                  : 'text-ink-3 disabled:opacity-45'
              }`}
            >
              {activeTab.saving ? <Spinner size={12} /> : <IconCheck size={12} />}
              <span>{t('common.save')}</span>
            </button>
          )}
          {canExternalAction && (
            <>
              <button type="button" onClick={revealInFinder} className={iconBtn} title={t('common.showInFinder')} aria-label={t('common.showInFinder')}>
                <IconFolder size={14} />
              </button>
              <button type="button" onClick={openExternal} className={iconBtn} title={t('editor.openExternal')} aria-label={t('editor.openExternal')}>
                <IconExternal size={14} />
              </button>
            </>
          )}
          <button
            type="button"
            onClick={onToggleMaximize}
            className={iconBtn}
            title={t(maximized ? 'editor.restore' : 'editor.maximize')}
            aria-label={t(maximized ? 'editor.restore' : 'editor.maximize')}
          >
            {maximized ? <IconMinimize size={14} /> : <IconMaximize size={14} />}
          </button>
          <button type="button" onClick={onClosePanel} className={iconBtn} title={t('common.close')} aria-label={t('common.close')}>
            <IconX size={14} />
          </button>
        </div>
      </div>

      {/* Relative Path Breadcrumbs */}
      {activeTab && (
        <div className="flex h-7 shrink-0 items-center gap-1 border-b border-hairline bg-surface px-3 text-[11.5px] text-ink-3">
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden font-mono" title={activeTab.realPath ?? activeTab.path}>
            {crumbs.map((seg, i) => (
              <Fragment key={`${i}:${seg}`}>
                {i > 0 && <IconChevronRight size={10} className="shrink-0 opacity-55" />}
                <span className={`truncate ${i === crumbs.length - 1 ? 'text-ink-2 font-medium' : ''}`}>{seg}</span>
              </Fragment>
            ))}
          </div>
          {activeTab.status === 'ready' && (
            <div className="flex shrink-0 items-center gap-2 text-[11px] text-ink-3">
              <span className="uppercase">{activeTab.language}</span>
              <span>{activeTab.eol}</span>
            </div>
          )}
        </div>
      )}

      {/* Save Conflict Banner */}
      {activeTab?.conflictMtimeMs !== null && activeTab?.status === 'ready' && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-danger/25 bg-danger-soft px-3 py-2 text-[12px] text-danger">
          <IconAlert size={14} className="shrink-0" />
          <span className="min-w-0 flex-1 font-medium">{t('editor.conflictBanner')}</span>
          <button
            type="button"
            onClick={() => onReloadTab(activeTab.id)}
            className="rounded-md bg-surface px-2.5 py-1 text-[11.5px] font-medium text-ink shadow-[0_0_0_1px_var(--ring)] hover:bg-surface-2"
          >
            {t('editor.loadDisk')}
          </button>
          <button
            type="button"
            onClick={() => onSaveTab(activeTab.id, { force: true })}
            className="rounded-md bg-danger px-2.5 py-1 text-[11.5px] font-medium text-white hover:opacity-90"
          >
            {t('editor.forceOverwrite')}
          </button>
        </div>
      )}

      {/* External Modification / Deletion Banner */}
      {activeTab && activeTab.conflictMtimeMs === null && activeTab.externalChange && activeTab.status === 'ready' && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-warn/30 bg-warn-soft px-3 py-2 text-[12px] text-warn">
          <IconAlert size={14} className="shrink-0" />
          <span className="min-w-0 flex-1 font-medium">
            {t(activeTab.externalChange === 'deleted' ? 'editor.externalDeleted' : 'editor.externalModified')}
          </span>
          {activeTab.externalChange === 'modified' && (
            <button
              type="button"
              onClick={() => onReloadTab(activeTab.id)}
              className="flex items-center gap-1 rounded-md bg-surface px-2.5 py-1 text-[11.5px] font-medium text-ink shadow-[0_0_0_1px_var(--ring)] hover:bg-surface-2"
            >
              <IconRefresh size={11} />
              {t('editor.reload')}
            </button>
          )}
          <button
            type="button"
            onClick={() => onDismissExternalChange(activeTab.id)}
            className="rounded-md px-2 py-1 text-[11.5px] font-medium text-warn hover:bg-black/[0.06] dark:hover:bg-white/[0.08]"
          >
            {t('editor.keepMine')}
          </button>
        </div>
      )}

      {/* Main Editor Body */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {!activeTab ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-[13px] text-ink-3">
            <IconFile size={24} className="opacity-50" />
            <span>{t('editor.empty')}</span>
          </div>
        ) : activeTab.status === 'loading' ? (
          <div className="flex h-full items-center justify-center gap-2 text-[13px] text-ink-3">
            <Spinner size={16} />
            <span>{t('ext.loading')}</span>
          </div>
        ) : activeTab.status === 'error' ? (
          <EditorBlockedState
            tab={activeTab}
            canExternalAction={canExternalAction}
            onReveal={revealInFinder}
            onOpenExternal={openExternal}
          />
        ) : (
          <CodeEditor
            fileKey={activeTab.id}
            value={activeTab.content}
            language={activeTab.language}
            syncVersion={activeTab.syncVersion}
            focusToken={focusToken}
            onChange={(next) => onChangeContent(activeTab.id, next)}
            onSave={() => onSaveTab(activeTab.id)}
          />
        )}
      </div>

      {/* Unsaved Changes Confirmation Modal */}
      {pendingClose && (
        <Modal onClose={() => onResolvePendingClose('cancel')} width={420}>
          <div role="alertdialog" aria-label={t('editor.unsavedTitle')} className="space-y-4 p-6">
            <div className="space-y-1.5">
              <h2 className="text-[15px] font-semibold text-ink">{t('editor.unsavedTitle')}</h2>
              <p className="text-[13px] leading-relaxed text-ink-2">
                {pendingClose.names.length === 1
                  ? t('editor.unsavedSingle', { name: pendingClose.names[0] })
                  : t('editor.unsavedMulti', { n: pendingClose.names.length })}
              </p>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button type="button" className={btnSecondary} onClick={() => onResolvePendingClose('cancel')}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="h-9 rounded-xl px-3.5 text-[13px] font-medium text-danger transition-colors hover:bg-danger-soft"
                onClick={() => onResolvePendingClose('discard')}
              >
                {t('editor.discardChanges')}
              </button>
              <button type="button" autoFocus className={btnPrimary} onClick={() => onResolvePendingClose('save')}>
                {t('editor.saveAndClose')}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </aside>
  )
}

function EditorBlockedState({
  tab,
  canExternalAction,
  onReveal,
  onOpenExternal
}: {
  tab: EditorTab
  canExternalAction: boolean
  onReveal: () => void
  onOpenExternal: () => void
}) {
  const code = tab.error?.code
  const title =
    code === 'FILE_TOO_LARGE'
      ? t('editor.errTooLargeTitle')
      : code === 'BINARY_FILE'
        ? t('editor.errBinaryTitle')
        : code === 'OUT_OF_BOUNDS'
          ? t('editor.errOutOfBoundsTitle')
          : code === 'NOT_FOUND'
            ? t('editor.errNotFoundTitle')
            : t('editor.errGenericTitle')

  const desc =
    code === 'FILE_TOO_LARGE'
      ? t('editor.errTooLargeDesc', { size: tab.error?.size ? fmtBytes(tab.error.size) : '> 2 MB' })
      : code === 'BINARY_FILE'
        ? t('editor.errBinaryDesc')
        : code === 'OUT_OF_BOUNDS'
          ? t('editor.errOutOfBoundsDesc')
          : code === 'NOT_FOUND'
            ? t('editor.errNotFoundDesc')
            : tab.error?.message || t('editor.errGenericDesc')

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <div className="grid h-11 w-11 place-items-center rounded-2xl bg-fill text-ink-2">
        <IconFile size={22} />
      </div>
      <div className="max-w-[340px] space-y-1">
        <div className="text-[14px] font-semibold text-ink">{title}</div>
        <p className="text-[12.5px] leading-relaxed text-ink-3">{desc}</p>
      </div>
      {canExternalAction && (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          <button type="button" onClick={onOpenExternal} className={btnPrimary + ' flex items-center gap-1.5'}>
            <IconExternal size={13} />
            {t('editor.openExternal')}
          </button>
          <button type="button" onClick={onReveal} className={btnSecondary + ' flex items-center gap-1.5'}>
            <IconFolder size={13} />
            {t('common.showInFinder')}
          </button>
        </div>
      )}
    </div>
  )
}
