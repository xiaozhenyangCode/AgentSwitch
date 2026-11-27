import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { KINDS, type HistoryEntry, type ProfileKind, type ThemeMode } from '@shared/types'
import { LOCALES, LOCALE_NAMES, translate, type LanguagePref, type MsgKey } from '@shared/i18n'
import { useApp, type SettingsSection } from '../state/AppContext'
import { setLanguage, t, useI18n } from '../state/i18n'
import { setThemeMode, useTheme } from '../state/theme'
import { openOnboarding } from '../state/onboarding'
import { sendKeys, setSetting, useSettings, type SendKey } from '../state/settings'
import { KIND_META, accountBadge, isReady } from '../lib/ui'
import { BrandMark, KindAvatar, Segmented } from './common'
import { ExtensionsSettingsView } from './Extensions'
import { ExportThreadsDialog, ImportThreadsDialog, todayStamp } from './ThreadTransferDialog'
import { TransferProgressModal } from './TransferProgressModal'
import { SheetCloseButton, WorkspaceSheetModal } from './WorkspaceSheetModal'
import { applyThreadImport, buildThreadBundleAsync, persistThreadImport, useChatStatus, type ImportConflictMode } from '../state/chat'
import type { CommitImportRequest, ImportPreviewResult, TransferImportResult, TransferProgressEvent, TransferType } from '@shared/transfer'
import {
  IconAuto,
  IconCheck,
  IconCopy,
  IconDatabase,
  IconExternal,
  IconFolder,
  IconGauge,
  IconInfo,
  IconKeyboard,
  IconMoon,
  IconPuzzle,
  IconRefresh,
  IconSearch,
  IconSliders,
  IconSun,
  IconTerminal,
  IconX,
  Spinner
} from './icons'

const WEBSITE = 'https://agentswitch.app'
const GITHUB_REPO = 'https://github.com/yitian-builds/AgentSwitch'
const LICENSE_URL = `${GITHUB_REPO}/blob/main/LICENSE`

const SECTIONS: { id: SettingsSection; Icon: (p: { size?: number }) => ReactElement }[] = [
  { id: 'general', Icon: IconSliders },
  { id: 'appearance', Icon: IconSun },
  { id: 'usage', Icon: IconGauge },
  { id: 'extensions', Icon: IconPuzzle },
  { id: 'data', Icon: IconDatabase },
  { id: 'developer', Icon: IconTerminal },
  { id: 'shortcuts', Icon: IconKeyboard },
  { id: 'about', Icon: IconInfo }
]


// ---- searchable items ------------------------------------------------------------------------

/**
 * One real setting. The search index covers its title, hint and option labels in every UI
 * language, plus hand-picked synonyms, so "dark", "暗黑" or "主题" all find the theme.
 */
interface Item {
  id: string
  section: SettingsSection
  title: MsgKey
  hint?: MsgKey
  /** More text to search (option labels, row labels). */
  keys?: MsgKey[]
  /** Synonyms in any language. */
  words?: string
  /** Title shown above the card (blocks whose card has no title row of its own). */
  heading?: boolean
  Body: (p: { title: ReactNode; onOpen?: () => void }) => ReactElement
}

const ITEMS: Item[] = [
  {
    id: 'extensions',
    section: 'extensions',
    title: 'set.extensions',
    hint: 'set.extensionsHint',
    keys: ['ext.tab.skills', 'ext.tab.agents', 'ext.tab.plugins', 'ext.tab.mcp', 'ext.tab.context'],
    words: 'skills agents plugins mcp rules hooks 技能 拓展 扩展 擴充 能力 插件 外掛 规则 規則 钩子 掛鉤 スキル エージェント プラグイン ルール フック',
    Body: ({ title, onOpen }) => (
      <button type="button" className="w-full px-4 py-3 text-left hover:bg-fill" onClick={onOpen}>
        <span className="block text-[13.5px] text-ink">{title}</span>
        <span className="mt-0.5 block text-[12px] leading-relaxed text-ink-3">{t('set.extensionsHint')}</span>
      </button>
    )
  },
  {
    id: 'language',
    section: 'general',
    title: 'set.language',
    hint: 'set.languageHint',
    keys: ['set.langSystem'],
    words: 'language locale lang 语言 語言 言語 english chinese japanese 中文 英文 日文 日本語 繁體 简体 i18n',
    Body: LanguageRow
  },
  {
    id: 'sendKey',
    section: 'general',
    title: 'set.sendKey',
    keys: ['set.sendEnter', 'set.sendMod'],
    words: 'send enter return newline 回车 换行 发送 送信 改行 cmd ⌘ shift keyboard',
    Body: SendKeyRow
  },
  {
    id: 'defaultDriver',
    section: 'general',
    title: 'set.defaultDriver',
    hint: 'set.defaultDriverHint',
    keys: ['set.followCurrent'],
    words: 'default account model driver 默认 账号 模型 主控 アカウント モデル new chat 新对话',
    Body: DefaultDriverRow
  },
  {
    id: 'onboarding',
    section: 'general',
    title: 'set.onboarding',
    hint: 'set.onboardingHint',
    keys: ['set.onboardingOpen'],
    words: 'onboarding guide wizard setup install login 引导 向导 安装 登录 ガイド セットアップ',
    Body: OnboardingRow
  },
  {
    id: 'theme',
    section: 'appearance',
    title: 'set.theme',
    hint: 'set.themeHint',
    keys: ['set.themeSystem', 'set.themeLight', 'set.themeDark'],
    words: 'theme dark light mode appearance night 暗黑 黑暗 深色 浅色 主题 外观 夜间 ダーク ライト テーマ 外観',
    Body: ThemeBlock
  },
  {
    id: 'probe',
    section: 'usage',
    title: 'set.probe',
    hint: 'set.probeHint',
    words: 'haiku quota limit probe refresh claude 额度 限额 刷新 探测 クォータ 制限 5h 7d',
    Body: ProbeRow
  },
  {
    id: 'threshold',
    section: 'usage',
    title: 'set.threshold',
    hint: 'set.thresholdHint',
    words: 'threshold warning alert quota limit 阈值 预警 提醒 额度 限额 しきい値 警告 70% 80% 90%',
    Body: ThresholdRow
  },
  {
    id: 'transfer',
    section: 'data',
    title: 'set.transfer',
    hint: 'set.transferHint',
    keys: ['set.exportChats', 'set.importChats'],
    words: 'export import backup migrate sync transfer threads chats json 导出 导入 备份 迁移 同步 对话 エクスポート インポート 移行',
    Body: TransferBlock
  },
  {
    id: 'dataDir',
    section: 'data',
    title: 'set.dataDir',
    hint: 'set.dataDirHint',
    keys: ['common.showInFinder'],
    words: 'finder folder directory data storage userdata path 数据 目录 文件夹 存储 路径 フォルダ データ',
    Body: DataDirBlock
  },
  {
    id: 'history',
    section: 'data',
    title: 'set.historyIndex',
    hint: 'set.historyHint',
    keys: ['set.rescan'],
    words: 'history index rescan scan sessions cli 历史 索引 扫描 会话 履歴 スキャン',
    Body: HistoryBlock
  },
  {
    id: 'debugTerminal',
    section: 'developer',
    title: 'set.debugTerminal',
    hint: 'set.debugTerminalHint',
    words: 'developer debug terminal shell log console drawer pty 开发者 调试 终端 日志 控制台 抽屉 開発者 デバッグ ターミナル ログ >_',
    Body: DebugTerminalRow
  },
  {
    id: 'gitTools',
    section: 'developer',
    title: 'set.gitTools',
    hint: 'set.gitToolsHint',
    words: 'git branch commit stage 开发者 分支 暂存 提交 開発者 ブランチ コミット ステージ',
    Body: GitToolsRow
  },
  {
    id: 'scApp',
    section: 'shortcuts',
    title: 'set.scGroupApp',
    keys: ['set.scNewChat', 'set.scSearch', 'set.scSettings', 'set.scQuit'],
    words: 'shortcut shortcuts keyboard hotkey keys 快捷键 热键 ショートカット キー cmd ⌘',
    heading: true,
    Body: AppShortcuts
  },
  {
    id: 'scCompose',
    section: 'shortcuts',
    title: 'set.scGroupCompose',
    keys: ['set.scSend', 'set.scNewline', 'set.scMention', 'set.scMentionNav', 'set.scMentionSub', 'set.scMentionPick', 'set.scEsc'],
    words: 'shortcut shortcuts keyboard hotkey keys mention 快捷键 热键 ショートカット キー enter esc @',
    heading: true,
    Body: ComposeShortcuts
  },
  {
    id: 'about',
    section: 'about',
    title: 'set.about',
    hint: 'about.tagline',
    keys: ['about.env', 'about.copyEnv', 'about.website', 'about.source', 'about.license'],
    words: 'about version website electron chromium node macos environment license agpl gpl github source copyright 关于 版本 官网 环境 协议 许可 开源 授權 原始碼 バージョン 情報 ライセンス ソース',
    Body: AboutRow
  }
]

/** Cards per section: ids that share one card. */
const LAYOUT: Record<Exclude<SettingsSection, 'about' | 'extensions'>, string[][]> = {
  general: [['language'], ['sendKey', 'defaultDriver'], ['onboarding']],
  appearance: [['theme']],
  usage: [['probe', 'threshold']],
  data: [['transfer'], ['dataDir'], ['history']],
  developer: [['debugTerminal', 'gitTools']],
  shortcuts: [['scApp'], ['scCompose']]
}

const byId = new Map(ITEMS.map((i) => [i.id, i]))
const SECTION_KEY = { general: 'set.general', appearance: 'set.appearance', usage: 'set.usage', extensions: 'set.extensions', data: 'set.data', developer: 'set.developer', shortcuts: 'set.shortcuts', about: 'set.about' } as const

let index: Map<string, string> | null = null
/** Lower-cased search text per item, in every language (built once). */
function searchIndex(): Map<string, string> {
  if (index) return index
  index = new Map(
    ITEMS.map((it) => {
      const keys: MsgKey[] = [it.title, ...(it.hint ? [it.hint] : []), ...(it.keys ?? []), SECTION_KEY[it.section]]
      const text = LOCALES.flatMap((l) => keys.map((k) => translate(l, k))).join(' \n ') + ' ' + (it.words ?? '')
      return [it.id, text.toLowerCase()]
    })
  )
  return index
}

const tokens = (q: string): string[] => q.toLowerCase().split(/\s+/).filter(Boolean)

const esc = (w: string): string => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Latin words match from the start of a word ("esc" is not "rescan"); CJK anywhere. */
const matcher = (w: string): ((text: string) => boolean) => {
  if (!/^[a-z0-9]/.test(w)) return (text) => text.includes(w)
  const re = new RegExp(`(^|[^a-z0-9])${esc(w)}`)
  return (text) => re.test(text)
}

function searchItems(q: string): Item[] {
  const tests = tokens(q).map(matcher)
  if (!tests.length) return []
  const idx = searchIndex()
  return ITEMS.filter((it) => tests.every((test) => test(idx.get(it.id)!)))
}

/** Marks the query words in a title (case-insensitive). */
function highlight(text: string, q: string): ReactNode {
  const tk = tokens(q).filter((w) => text.toLowerCase().includes(w))
  if (!tk.length) return text
  const re = new RegExp(`(${tk.map(esc).join('|')})`, 'gi')
  return text.split(re).map((part, i) =>
    i % 2 ? (
      <mark key={i} className="rounded-[3px] bg-accent/15 px-px text-inherit">
        {part}
      </mark>
    ) : (
      part
    )
  )
}

// ---- dialog ------------------------------------------------------------------------------------------

/**
 * Settings as a centred sheet over the current page (which stays as it is: scroll position,
 * drafts). Opens with ⌘, / the sidebar / the app menu; closes with ×, Esc or a click outside.
 */
export function SettingsDialog() {
  const { settingsOpen, settingsSection: section, openSettings, closeSettings, confirmState } = useApp()
  const [q, setQ] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const query = q.trim()
  const hits = useMemo(() => (query ? searchItems(query) : []), [query])
  const searching = !!query

  const clearSearch = () => {
    setQ('')
    input.current?.focus()
  }
  const onEsc = () => {
    if (q) clearSearch()
    else closeSettings()
  }

  useEffect(() => {
    if (!settingsOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (confirmState) return // a dialog on top owns the keyboard
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        input.current?.focus()
        input.current?.select()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [settingsOpen, confirmState])

  const count = (id: SettingsSection) => hits.filter((h) => h.section === id).length
  const go = (id: SettingsSection) => {
    setQ('')
    openSettings(id)
  }

  return (
    <SettingsTransfer>
    <WorkspaceSheetModal
      open={settingsOpen}
      onClose={closeSettings}
      onEsc={onEsc}
      onExited={() => setQ('')}
      ariaLabel={t('set.title')}
      bodyClassName="overflow-hidden"
    >
      <aside className="flex w-[min(224px,30%)] shrink-0 flex-col border-r border-hairline bg-surface-2/70">
        <div className="shrink-0 px-3 pt-3.5 pb-2.5">
          <div className="flex h-8 items-center gap-1.5 rounded-lg bg-surface px-2.5 shadow-[0_0_0_1px_var(--ring)] focus-within:shadow-[0_0_0_1px_var(--accent),0_0_0_3px_color-mix(in_srgb,var(--accent)_22%,transparent)]">
            <IconSearch size={14} className="shrink-0 text-ink-3" />
            <input
              ref={input}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('set.searchPlaceholder')}
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
            />
            {q && (
              <button onClick={clearSearch} title={t('set.searchClear')} className="-mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-ink-3 hover:bg-black/[0.06] hover:text-ink">
                <IconX size={11} />
              </button>
            )}
          </div>
        </div>
        <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2.5 pb-3">
          {SECTIONS.map(({ id, Icon }) => {
            const n = searching ? count(id) : 0
            const active = !searching && section === id
            return (
              <button
                key={id}
                onClick={() => go(id)}
                aria-current={active ? 'true' : undefined}
                className={`flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors ${
                  active ? 'bg-accent font-medium text-white' : searching && !n ? 'text-ink-3/70 hover:bg-black/[0.04]' : 'text-ink hover:bg-black/[0.04]'
                }`}
              >
                <Icon size={15} />
                <span className="min-w-0 flex-1 truncate">{t(SECTION_KEY[id])}</span>
                {n > 0 && <span className="rounded-full bg-accent/12 px-1.5 text-[11px] leading-[18px] font-medium text-accent tabular-nums">{n}</span>}
              </button>
            )
          })}
        </nav>
      </aside>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-hairline pr-3 pl-7">
          <h1 className="min-w-0 flex-1 truncate text-[17px] font-semibold tracking-tight text-ink">
            {searching ? t('set.searchResults') : t(SECTION_KEY[section])}
            {searching && hits.length > 0 && <span className="ml-2 text-[13px] font-normal text-ink-3">{t('set.searchCount', { n: hits.length })}</span>}
          </h1>
          <SheetCloseButton onClick={closeSettings} label={t('set.close')} />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[760px] px-7 py-6">
            {searching ? <Results hits={hits} query={query} onClear={clearSearch} onOpen={go} /> : <Section id={section} />}
          </div>
        </div>
      </section>
    </WorkspaceSheetModal>
    </SettingsTransfer>
  )
}

function Section({ id }: { id: SettingsSection }) {
  if (id === 'about') return <About />
  if (id === 'extensions') return <ExtensionsSettingsView />
  return (
    <>
      {LAYOUT[id].map((ids) => {
        const items = ids.map((x) => byId.get(x)!)
        const heading = items[0].heading ? <div className="mb-2 px-1 text-[12px] font-medium text-ink-3">{t(items[0].title)}</div> : null
        return (
          <div key={ids.join()}>
            {heading}
            <Group>
              {items.map((it) => (
                <it.Body key={it.id} title={t(it.title)} />
              ))}
            </Group>
          </div>
        )
      })}
      {id === 'shortcuts' && <p className="px-1 text-[12px] text-ink-3">{t('set.scHint')}</p>}
    </>
  )
}

/** Hits grouped by section; every control works right here. */
function Results({ hits, query, onClear, onOpen }: { hits: Item[]; query: string; onClear: () => void; onOpen: (s: SettingsSection) => void }) {
  if (!hits.length)
    return (
      <div className="flex flex-col items-center pt-20 text-center">
        <IconSearch size={26} className="text-ink-3/60" />
        <div className="mt-3 text-[14px] font-medium text-ink">{t('set.searchEmpty')}</div>
        <div className="mt-1 max-w-[340px] text-[12.5px] leading-relaxed text-ink-3">{t('set.searchEmptyHint')}</div>
        <button className={btn + ' mt-4'} onClick={onClear}>
          {t('set.searchClear')}
        </button>
      </div>
    )
  return (
    <>
      {SECTIONS.filter(({ id }) => hits.some((h) => h.section === id)).map(({ id, Icon }) => (
        <div key={id} className="mb-1">
          <button onClick={() => onOpen(id)} className="mb-2 flex items-center gap-1.5 px-1 text-[12px] font-medium text-ink-3 hover:text-ink" title={t(SECTION_KEY[id])}>
            <Icon size={13} /> {t(SECTION_KEY[id])}
          </button>
          {hits
            .filter((h) => h.section === id)
            .map((it) => (
              <div key={it.id}>
                {it.heading && <div className="mb-1.5 px-1 text-[12px] text-ink-2">{highlight(t(it.title), query)}</div>}
                <Group>
                  <it.Body title={highlight(t(it.title), query)} onOpen={() => onOpen(id)} />
                </Group>
              </div>
            ))}
        </div>
      ))}
    </>
  )
}

// ---- building blocks ------------------------------------------------------------------------

const Group = ({ children }: { children: ReactNode }) => (
  <div className="mb-5 divide-y divide-black/[0.06] overflow-hidden rounded-xl border border-black/[0.07] bg-surface-2 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">{children}</div>
)

function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex min-h-[52px] items-center gap-6 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] text-ink">{label}</div>
        {hint && <div className="mt-0.5 text-[12px] leading-relaxed text-ink-3">{hint}</div>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  )
}

const selectCls =
  'h-7 max-w-[300px] shrink-0 rounded-md bg-fill pr-7 pl-2.5 text-[13px] text-ink outline-none focus:ring-2 focus:ring-accent/30 appearance-none bg-[length:10px] bg-[right_9px_center] bg-no-repeat'
const chevron = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6' fill='none' stroke='%238e8e93' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m1 1 4 4 4-4'/%3E%3C/svg%3E")`

function Select<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <select className={selectCls} style={{ backgroundImage: chevron }} value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      role="switch"
      aria-label={label}
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`relative h-[22px] w-[38px] rounded-full transition-colors duration-200 ${on ? 'bg-accent' : 'bg-black/[0.12]'}`}
    >
      <span className={`absolute top-[2px] left-[2px] h-[18px] w-[18px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.25)] transition-transform duration-200 ${on ? 'translate-x-4' : ''}`} />
    </button>
  )
}

const btn =
  'inline-flex h-7 items-center gap-1.5 rounded-md bg-fill px-2.5 text-[12.5px] font-medium text-ink transition-colors hover:bg-fill-hover disabled:opacity-60'

const Kbd = ({ children }: { children: string }) => (
  <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded-md bg-fill px-1.5 font-sans text-[12px] font-medium text-ink-2 shadow-[inset_0_-1px_0_var(--ring)]">{children}</kbd>
)

// ---- items ------------------------------------------------------------------------------------

function LanguageRow({ title }: { title: ReactNode }) {
  const { pref } = useI18n()
  return (
    <Row label={title} hint={t('set.languageHint')}>
      <Select<LanguagePref>
        value={pref}
        onChange={(v) => void setLanguage(v)}
        options={[{ value: 'system', label: t('set.langSystem') }, ...LOCALES.map((l) => ({ value: l, label: LOCALE_NAMES[l] }))]}
      />
    </Row>
  )
}

function SendKeyRow({ title }: { title: ReactNode }) {
  const { sendKey } = useSettings()
  return (
    <Row label={title}>
      <Select<SendKey>
        value={sendKey}
        onChange={(v) => setSetting('sendKey', v)}
        options={(['enter', 'mod-enter'] as SendKey[]).map((k) => ({ value: k, label: k === 'enter' ? t('set.sendEnter') : t('set.sendMod') }))}
      />
    </Row>
  )
}

function DefaultDriverRow({ title }: { title: ReactNode }) {
  const { defaultDriver } = useSettings()
  const { profiles } = useApp()
  return (
    <Row label={title} hint={t('set.defaultDriverHint')}>
      <Select<string>
        value={defaultDriver && profiles.some((p) => p.id === defaultDriver) ? defaultDriver : ''}
        onChange={(v) => setSetting('defaultDriver', v || null)}
        options={[{ value: '', label: t('set.followCurrent') }, ...profiles.map((p) => ({ value: p.id, label: isReady(p) ? p.name : `${p.name} (${accountBadge(p).label})` }))]}
      />
    </Row>
  )
}

function OnboardingRow({ title }: { title: ReactNode }) {
  const { closeSettings } = useApp()
  return (
    <Row label={title} hint={t('set.onboardingHint')}>
      <button
        className={btn}
        onClick={() => {
          closeSettings()
          openOnboarding()
        }}
      >
        {t('set.onboardingOpen')}
      </button>
    </Row>
  )
}

const THEMES: { mode: ThemeMode; key: 'set.themeSystem' | 'set.themeLight' | 'set.themeDark'; Icon: (p: { size?: number }) => ReactElement }[] = [
  { mode: 'system', key: 'set.themeSystem', Icon: IconAuto },
  { mode: 'light', key: 'set.themeLight', Icon: IconSun },
  { mode: 'dark', key: 'set.themeDark', Icon: IconMoon }
]

/** Miniature window used as a theme card thumbnail. */
function ThemeThumb({ mode }: { mode: ThemeMode }) {
  const pane = (dark: boolean) => (
    <div className={`flex h-full flex-1 ${dark ? 'bg-[#1c1c1e]' : 'bg-[#f5f5f7]'}`}>
      <div className={`w-[30%] ${dark ? 'bg-[#161618]' : 'bg-[#e8e8ed]'}`} />
      <div className="flex-1 p-1.5">
        <div className={`h-1.5 w-3/4 rounded-full ${dark ? 'bg-white/25' : 'bg-black/15'}`} />
        <div className={`mt-1 h-1.5 w-1/2 rounded-full ${dark ? 'bg-white/15' : 'bg-black/10'}`} />
        <div className="mt-2 ml-auto h-2.5 w-1/2 rounded-full bg-[#0a84ff]" />
      </div>
    </div>
  )
  return <div className="flex aspect-[2.3] min-h-14 w-full overflow-hidden rounded-lg shadow-[0_0_0_1px_var(--ring)]">{mode === 'system' ? [pane(false), pane(true)] : pane(mode === 'dark')}</div>
}

function ThemeBlock({ title }: { title: ReactNode }) {
  const { mode } = useTheme()
  return (
    <div className="px-4 py-4">
      <div className="text-[13.5px] text-ink">{title}</div>
      <div className="mt-0.5 text-[12px] text-ink-3">{t('set.themeHint')}</div>
      <div className="mt-4 grid grid-cols-3 gap-4" role="radiogroup" aria-label={t('set.theme')}>
        {THEMES.map(({ mode: m, key, Icon }) => (
          <button key={m} role="radio" aria-checked={mode === m} title={t(key)} onClick={() => void setThemeMode(m)} className="group flex flex-col items-center gap-2">
            <div className={`w-full rounded-[11px] p-[3px] transition-shadow ${mode === m ? 'shadow-[0_0_0_2.5px_var(--accent)]' : 'group-hover:shadow-[0_0_0_2px_var(--ring)]'}`}>
              <ThemeThumb mode={m} />
            </div>
            <span className={`flex items-center gap-1 text-[12.5px] ${mode === m ? 'font-medium text-ink' : 'text-ink-2'}`}>
              <Icon size={13} /> {t(key)}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

function ProbeRow({ title }: { title: ReactNode }) {
  const { probeClaude } = useSettings()
  return (
    <Row label={title} hint={t('set.probeHint')}>
      <Toggle on={probeClaude} onChange={(v) => setSetting('probeClaude', v)} />
    </Row>
  )
}

function DebugTerminalRow({ title }: { title: ReactNode }) {
  const { showDebugTerminal } = useSettings()
  const { drawer, closeDrawer } = useApp()
  return (
    <Row label={title} hint={t('set.debugTerminalHint')}>
      <Toggle
        on={showDebugTerminal}
        onChange={(v) => {
          setSetting('showDebugTerminal', v)
          if (!v && drawer.open) closeDrawer()
        }}
      />
    </Row>
  )
}

function GitToolsRow({ title }: { title: ReactNode }) {
  const { showGitTools } = useSettings()
  return (
    <Row label={title} hint={t('set.gitToolsHint')}>
      <Toggle on={showGitTools} onChange={(v) => setSetting('showGitTools', v)} label={t('set.gitTools')} />
    </Row>
  )
}

function ThresholdRow({ title }: { title: ReactNode }) {
  const { quotaWarn } = useSettings()
  return (
    <Row label={title} hint={t('set.thresholdHint')}>
      <Segmented value={String(quotaWarn)} onChange={(v) => setSetting('quotaWarn', Number(v) as 70 | 80 | 90)} options={['70', '80', '90'].map((v) => ({ value: v, label: `${v}%` }))} />
    </Row>
  )
}

const TransferActions = createContext<{ openExport: () => void; openImport: () => void; busy: boolean } | null>(null)

function TransferBlock({ title }: { title: ReactNode }) {
  const actions = useContext(TransferActions)
  const chatStatus = useChatStatus()
  const disabled = !actions || actions.busy || chatStatus === 'loading' || chatStatus === 'loadFailed'
  return (
    <Row label={title} hint={t('set.transferHint')}>
      <div className="flex items-center gap-2">
        <button className={btn} disabled={disabled} onClick={actions?.openExport}>
          {t('set.exportChats')}
        </button>
        <button className={btn} disabled={disabled} onClick={actions?.openImport}>
          {t('set.importChats')}
        </button>
      </div>
    </Row>
  )
}

type TransferRequest = {
  type: TransferType
  id?: string
  onPreparing?: (id: string) => Promise<void>
}

const transferError = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')

function SettingsTransfer({ children }: { children: ReactNode }) {
  const { profiles } = useApp()
  const [exportOpen, setExportOpen] = useState(false)
  const [preview, setPreview] = useState<ImportPreviewResult | null>(null)
  const [progress, setProgress] = useState<TransferProgressEvent | null>(null)
  const [busy, setBusy] = useState(false)
  const request = useRef<TransferRequest | null>(null)

  const fail = (active: TransferRequest, error: unknown) => {
    setProgress((previous) => ({
      transferId: active.id ?? '', type: active.type, phase: 'error',
      current: previous?.current ?? 0, total: previous?.total ?? 0, percent: previous?.percent ?? 0,
      error: previous?.phase === 'error' ? previous.error : transferError(error)
    }))
  }

  useEffect(() => window.agentswitch.sys.onTransferProgress((event) => {
    const active = request.current
    if (!active || active.type !== event.type || (active.id && active.id !== event.transferId)) return
    active.id = event.transferId
    if (active.type === 'export') setExportOpen(false)
    setProgress(event)
    if (event.phase === 'preparing' && active.onPreparing) {
      const prepare = active.onPreparing
      active.onPreparing = undefined
      void prepare(event.transferId).catch((error) => {
        if (request.current === active) fail(active, error)
      })
    }
  }), [])

  const runTransfer = async (active: TransferRequest, work: () => Promise<void>) => {
    if (request.current) return
    request.current = active
    setBusy(true)
    try {
      await work()
    } catch (error) {
      if (active.type === 'export') setExportOpen(false)
      fail(active, error)
    } finally {
      request.current = null
      setBusy(false)
    }
  }

  const runExport = (selected: Set<string>) => {
    const active: TransferRequest = {
      type: 'export',
      onPreparing: async (id) => {
        try {
          const bundle = await buildThreadBundleAsync(selected, profiles)
          await window.agentswitch.sys.provideThreadExportBundle(id, { bundle })
        } catch (error) {
          await window.agentswitch.sys.provideThreadExportBundle(id, { error: transferError(error) })
        }
      }
    }
    return runTransfer(active, async () => {
      const result = await window.agentswitch.sys.exportThreadsFile(`AgentSwitch-chats-${todayStamp()}.zip`)
      if (!result) return
      setExportOpen(false)
      setProgress({
        transferId: active.id ?? '', type: 'export', phase: 'success',
        current: result.exportedCount, total: result.exportedCount, percent: 100, result
      })
    })
  }

  const openImport = () => runTransfer({ type: 'import' }, async () => {
    const picked = await window.agentswitch.sys.importThreadsFile()
    if (!picked) return
    setProgress(null)
    setPreview(picked)
  })

  const runImport = (input: CommitImportRequest, conflictMode: ImportConflictMode, selectedCount: number) => {
    const total = preview?.bundle.threads.length ?? selectedCount
    return runTransfer({ type: 'import' }, async () => {
      setPreview(null)
      setProgress({ transferId: '', type: 'import', phase: 'validating', current: 0, total: selectedCount, percent: 0 })
      const { threads, transferId } = await window.agentswitch.sys.commitThreadsImport(input)
      let result: TransferImportResult
      try {
        const { added, replaced } = applyThreadImport(threads, profiles, conflictMode)
        await persistThreadImport()
        result = {
          filePath: input.filePath, importedCount: threads.length, addedCount: added,
          replacedCount: replaced, skippedCount: total - selectedCount
        }
      } catch (error) {
        await window.agentswitch.sys.finishThreadImport(transferId, { error: transferError(error) }).catch(() => undefined)
        throw error
      }
      await window.agentswitch.sys.finishThreadImport(transferId, { result })
      setProgress({
        transferId, type: 'import', phase: 'success', current: threads.length, total: threads.length, percent: 100, result
      })
    })
  }

  return (
    <TransferActions.Provider value={{ openExport: () => setExportOpen(true), openImport, busy }}>
      {children}
      {exportOpen && <ExportThreadsDialog busy={busy} onClose={() => setExportOpen(false)} onExport={runExport} />}
      {preview && <ImportThreadsDialog preview={preview} onClose={() => setPreview(null)} onImport={runImport} />}
      {progress && <TransferProgressModal progress={progress} onClose={() => setProgress(null)} />}
    </TransferActions.Provider>
  )
}

function DataDirBlock({ title }: { title: ReactNode }) {
  const { info } = useApp()
  return (
    <>
      <Row label={title} hint={t('set.dataDirHint')}>
        <button className={btn} disabled={!info} onClick={() => void window.agentswitch.sys.showDataDir()}>
          <IconFolder size={14} /> {t('common.showInFinder')}
        </button>
      </Row>
      <div className="truncate px-4 py-2.5 font-mono text-[12px] text-ink-2 select-text" title={info?.userData}>
        {info?.userData ?? '…'}
      </div>
    </>
  )
}

function HistoryBlock({ title }: { title: ReactNode }) {
  const { toast } = useApp()
  const [items, setItems] = useState<HistoryEntry[] | null>(null)
  const [scanning, setScanning] = useState(false)
  useEffect(() => {
    void window.agentswitch.history.list(false).then(setItems)
  }, [])
  const rescan = async () => {
    setScanning(true)
    try {
      const list = await window.agentswitch.history.list(true)
      setItems(list)
      toast({ kind: 'success', title: t('set.rescanned', { n: list.length }) })
    } finally {
      setScanning(false)
    }
  }
  const count = (k: ProfileKind) => items?.filter((e) => e.kind === k).length ?? 0
  return (
    <>
        <Row label={title} hint={t('set.historyHint')}>
          <button className={btn} disabled={scanning} onClick={() => void rescan()}>
            {scanning ? <Spinner size={12} /> : <IconRefresh size={13} />} {scanning ? t('set.scanning') : t('set.rescan')}
          </button>
        </Row>
        <div className="grid grid-cols-3 divide-x divide-black/[0.06]">
          {KINDS.map((k) => (
            <div key={k} className="flex items-center gap-2.5 px-4 py-3">
              <KindAvatar kind={k} size={22} />
              <div className="min-w-0">
                <div className="truncate text-[12px] text-ink-3">{KIND_META[k].cli}</div>
                <div className="text-[15px] font-semibold text-ink tabular-nums">{items ? count(k) : '—'}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="px-4 py-2 text-[12px] text-ink-3 tabular-nums">{items ? t('set.historyTotal', { n: items.length }) : t('hist.scanning')}</div>
    </>
  )
}

function ShortcutRow({ label, keys }: { label: string; keys: string[] }) {
  return (
    <Row label={label}>
      {keys.map((x) => (
        <Kbd key={x}>{x}</Kbd>
      ))}
    </Row>
  )
}

function AppShortcuts() {
  return (
    <>
      <ShortcutRow label={t('set.scNewChat')} keys={['⌘', 'N']} />
      <ShortcutRow label={t('set.scSearch')} keys={['⌘', 'K']} />
      <ShortcutRow label={t('set.scToggleSidebar')} keys={['⌘', '\\']} />
      <ShortcutRow label={t('set.scSettings')} keys={['⌘', ',']} />
      <ShortcutRow label={t('set.scQuit')} keys={['⌘', 'Q']} />
    </>
  )
}

function ComposeShortcuts() {
  const { sendKey } = useSettings()
  const k = sendKeys(sendKey)
  return (
    <>
      <ShortcutRow label={t('set.scSend')} keys={k.send === '⌘↩' ? ['⌘', '↩'] : ['↩']} />
      <ShortcutRow label={t('set.scNewline')} keys={k.newline === '⇧↩' ? ['⇧', '↩'] : ['↩']} />
      <ShortcutRow label={t('set.scMention')} keys={['@']} />
      <ShortcutRow label={t('set.scMentionNav')} keys={['↑', '↓']} />
      <ShortcutRow label={t('set.scMentionSub')} keys={['→', '←']} />
      <ShortcutRow label={t('set.scMentionPick')} keys={['↩', 'Tab']} />
      <ShortcutRow label={t('set.scEsc')} keys={['Esc']} />
    </>
  )
}

/** Search hit for the About page: version, and a way there. */
function AboutRow({ title }: { title: ReactNode }) {
  const { info, openSettings } = useApp()
  return (
    <Row label={title} hint={info ? `AgentSwitch · ${t('about.version', { v: info.version })}` : undefined}>
      <button className={btn} onClick={() => openSettings('about')}>
        {t('set.aboutOpen')}
      </button>
    </Row>
  )
}

function About() {
  const { info, cliVersions: versions, toast } = useApp()
  const [copied, setCopied] = useState(false)
  const cliText = (k: ProfileKind) => (versions[k] === undefined ? t('about.checking') : versions[k] ? `v${versions[k]!.replace(/^v/, '')}` : t('about.notInstalled'))
  const nodeRuntimeText = info
    ? info.nodeRuntime.source === 'bundled'
      ? info.nodeRuntime.version
        ? t('about.nodeBundledVer', { v: info.nodeRuntime.version })
        : t('about.nodeBundled')
      : info.nodeRuntime.source === 'system'
        ? t('about.nodeSystem', { path: info.nodeRuntime.path ?? '' })
        : t('about.notInstalled')
    : ''
  const rows: [string, string][] = info
    ? [
        ['AgentSwitch', info.version],
        ['macOS', `${info.osVersion} (${info.arch})`],
        ['Electron', info.electron],
        ['Chromium', info.chrome],
        ['Node.js', info.node],
        [t('about.cliNode'), nodeRuntimeText],
        ...KINDS.map((k): [string, string] => [KIND_META[k].cli, cliText(k)])
      ]
    : []
  const copy = async () => {
    await window.agentswitch.sys.copy(rows.map(([a, b]) => `${a}: ${b}`).join('\n'))
    setCopied(true)
    toast({ kind: 'success', title: t('about.envCopied') })
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="pt-2">
      <div className="flex flex-col items-center text-center">
        <BrandMark size={72} />
        <div className="mt-4 text-[22px] font-semibold tracking-tight text-ink">AgentSwitch</div>
        <div className="mt-1 text-[13px] text-ink-3 tabular-nums">{info ? t('about.version', { v: info.version }) : ''}</div>
        <div className="mt-2 max-w-[420px] text-[13px] leading-relaxed text-ink-2">{t('about.tagline')}</div>
        <div className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5">
          <button className="inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:text-accent-hover" onClick={() => void window.agentswitch.sys.openExternal(WEBSITE)}>
            {t('about.website')} agentswitch.app <IconExternal size={13} />
          </button>
          <button className="inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:text-accent-hover" onClick={() => void window.agentswitch.sys.openExternal(GITHUB_REPO)}>
            {t('about.source')} <IconExternal size={13} />
          </button>
        </div>
      </div>
      <div className="mt-8 overflow-hidden rounded-xl border border-black/[0.07] bg-surface-2 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
        <div className="flex h-10 items-center border-b border-black/[0.06] pr-2 pl-4">
          <span className="flex-1 text-[12.5px] font-medium text-ink-2">{t('about.env')}</span>
          <button className={btn + ' h-6 bg-transparent px-2 text-ink-2 hover:bg-fill'} onClick={() => void copy()} disabled={!info}>
            {copied ? <IconCheck size={13} className="text-ok" /> : <IconCopy size={13} />} {t('about.copyEnv')}
          </button>
        </div>
        <div className="divide-y divide-black/[0.05]">
          {rows.map(([a, b], i) => (
            <div key={a} className="flex h-9 items-center px-4 text-[12.5px]">
              <span className="flex flex-1 items-center gap-2 text-ink-3">
                {i >= rows.length - KINDS.length && <KindAvatar kind={KINDS[i - (rows.length - KINDS.length)]} size={16} />}
                {a}
              </span>
              <span className="font-mono text-[12px] text-ink select-text">{b}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-2 px-1 text-[12px] text-ink-3">
        <span>© 2026 yitian_builds</span>
        <button
          className="inline-flex items-center gap-1 text-ink-2 underline-offset-2 hover:text-ink hover:underline"
          onClick={() => void window.agentswitch.sys.openExternal(LICENSE_URL)}
        >
          {t('about.license')} <IconExternal size={12} />
        </button>
      </div>
    </div>
  )
}
