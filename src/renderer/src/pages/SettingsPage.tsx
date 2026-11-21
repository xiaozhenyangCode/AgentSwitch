import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { KINDS, type HistoryEntry, type ProfileKind, type ThemeMode } from '@shared/types'
import { LOCALES, LOCALE_NAMES, type LanguagePref } from '@shared/i18n'
import { useApp, type SettingsSection } from '../state/AppContext'
import { setLanguage, t, useI18n } from '../state/i18n'
import { setThemeMode, useTheme } from '../state/theme'
import { openOnboarding } from '../state/onboarding'
import { sendKeys, setSetting, useSettings, type SendKey } from '../state/settings'
import { KIND_META, isReady } from '../lib/ui'
import { BrandMark, KindAvatar, Segmented } from '../components/common'
import { IconAuto, IconCheck, IconCopy, IconDatabase, IconExternal, IconFolder, IconGauge, IconInfo, IconKeyboard, IconMoon, IconRefresh, IconSliders, IconSun, Spinner } from '../components/icons'

const WEBSITE = 'https://agentswitch.app'

const SECTIONS: { id: SettingsSection; Icon: (p: { size?: number }) => ReactElement }[] = [
  { id: 'general', Icon: IconSliders },
  { id: 'appearance', Icon: IconSun },
  { id: 'usage', Icon: IconGauge },
  { id: 'data', Icon: IconDatabase },
  { id: 'shortcuts', Icon: IconKeyboard },
  { id: 'about', Icon: IconInfo }
]
const SECTION_LABEL = (id: SettingsSection): string =>
  t(({ general: 'set.general', appearance: 'set.appearance', usage: 'set.usage', data: 'set.data', shortcuts: 'set.shortcuts', about: 'set.about' } as const)[id])

/** macOS System Settings style: section list on the left, grouped cards on the right. */
export function SettingsPage() {
  const { settingsSection: section, openSettings } = useApp()
  return (
    <div className="flex h-full">
      <aside className="flex w-[210px] shrink-0 flex-col border-r border-black/[0.06]">
        <div className="drag h-14 shrink-0" />
        <div className="px-5 pb-3 text-[20px] font-semibold tracking-tight text-ink">{t('set.title')}</div>
        <div className="space-y-0.5 px-3">
          {SECTIONS.map(({ id, Icon }) => (
            <button
              key={id}
              onClick={() => openSettings(id)}
              className={`flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13.5px] transition-colors ${
                section === id ? 'bg-accent font-medium text-white' : 'text-ink hover:bg-black/[0.04]'
              }`}
            >
              <Icon size={15} />
              {SECTION_LABEL(id)}
            </button>
          ))}
        </div>
      </aside>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="drag h-14" />
        <div className="mx-auto max-w-[640px] px-10 pb-16">
          {section !== 'about' && <h1 className="mb-5 text-[22px] font-semibold tracking-tight text-ink">{SECTION_LABEL(section)}</h1>}
          {section === 'general' && <General />}
          {section === 'appearance' && <Appearance />}
          {section === 'usage' && <UsageSettings />}
          {section === 'data' && <DataStorage />}
          {section === 'shortcuts' && <Shortcuts />}
          {section === 'about' && <About />}
        </div>
      </div>
    </div>
  )
}

// ---- building blocks ------------------------------------------------------------------------

const Group = ({ children }: { children: ReactNode }) => (
  <div className="mb-5 divide-y divide-black/[0.06] overflow-hidden rounded-xl border border-black/[0.07] bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.03)]">{children}</div>
)

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children?: ReactNode }) {
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

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
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

// ---- sections ---------------------------------------------------------------------------------

function General() {
  const { pref } = useI18n()
  const { sendKey, defaultDriver } = useSettings()
  const { profiles } = useApp()
  const keys = (k: SendKey) => (k === 'enter' ? t('set.sendEnter') : t('set.sendMod'))
  return (
    <>
      <Group>
        <Row label={t('set.language')} hint={t('set.languageHint')}>
          <Select<LanguagePref>
            value={pref}
            onChange={(v) => void setLanguage(v)}
            options={[{ value: 'system', label: t('set.langSystem') }, ...LOCALES.map((l) => ({ value: l, label: LOCALE_NAMES[l] }))]}
          />
        </Row>
      </Group>
      <Group>
        <Row label={t('set.sendKey')}>
          <Select<SendKey>
            value={sendKey}
            onChange={(v) => setSetting('sendKey', v)}
            options={(['enter', 'mod-enter'] as SendKey[]).map((k) => ({ value: k, label: keys(k) }))}
          />
        </Row>
        <Row label={t('set.defaultDriver')} hint={t('set.defaultDriverHint')}>
          <Select<string>
            value={defaultDriver && profiles.some((p) => p.id === defaultDriver) ? defaultDriver : ''}
            onChange={(v) => setSetting('defaultDriver', v || null)}
            options={[
              { value: '', label: t('set.followCurrent') },
              ...profiles.map((p) => ({ value: p.id, label: isReady(p) ? p.name : `${p.name} (${t('status.notLoggedIn')})` }))
            ]}
          />
        </Row>
      </Group>
      <Group>
        <Row label={t('set.onboarding')} hint={t('set.onboardingHint')}>
          <button className={btn} onClick={openOnboarding}>
            {t('set.onboardingOpen')}
          </button>
        </Row>
      </Group>
    </>
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
  return <div className="flex h-[58px] w-full overflow-hidden rounded-lg shadow-[0_0_0_1px_var(--ring)]">{mode === 'system' ? [pane(false), pane(true)] : pane(mode === 'dark')}</div>
}

function Appearance() {
  const { mode } = useTheme()
  return (
    <Group>
      <div className="px-4 py-4">
        <div className="text-[13.5px] text-ink">{t('set.theme')}</div>
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
    </Group>
  )
}

function UsageSettings() {
  const { probeClaude, quotaWarn } = useSettings()
  return (
    <Group>
      <Row label={t('set.probe')} hint={t('set.probeHint')}>
        <Toggle on={probeClaude} onChange={(v) => setSetting('probeClaude', v)} />
      </Row>
      <Row label={t('set.threshold')} hint={t('set.thresholdHint')}>
        <Segmented
          value={String(quotaWarn)}
          onChange={(v) => setSetting('quotaWarn', Number(v) as 70 | 80 | 90)}
          options={['70', '80', '90'].map((v) => ({ value: v, label: `${v}%` }))}
        />
      </Row>
    </Group>
  )
}

function DataStorage() {
  const { info, toast } = useApp()
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
      <Group>
        <Row label={t('set.dataDir')} hint={t('set.dataDirHint')}>
          <button className={btn} disabled={!info} onClick={() => void window.agentswitch.sys.showDataDir()}>
            <IconFolder size={14} /> {t('common.showInFinder')}
          </button>
        </Row>
        <div className="truncate px-4 py-2.5 font-mono text-[12px] text-ink-2 select-text" title={info?.userData}>
          {info?.userData ?? '…'}
        </div>
      </Group>
      <Group>
        <Row label={t('set.historyIndex')} hint={t('set.historyHint')}>
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
      </Group>
    </>
  )
}

function Shortcuts() {
  const { sendKey } = useSettings()
  const k = sendKeys(sendKey)
  const row = (label: string, ...keys: string[]) => (
    <Row key={label} label={label}>
      {keys.map((x) => (
        <Kbd key={x}>{x}</Kbd>
      ))}
    </Row>
  )
  return (
    <>
      <div className="mb-2 px-1 text-[12px] font-medium text-ink-3">{t('set.scGroupApp')}</div>
      <Group>
        {row(t('set.scNewChat'), '⌘', 'N')}
        {row(t('set.scSearch'), '⌘', 'K')}
        {row(t('set.scSettings'), '⌘', ',')}
        {row(t('set.scQuit'), '⌘', 'Q')}
      </Group>
      <div className="mb-2 px-1 text-[12px] font-medium text-ink-3">{t('set.scGroupCompose')}</div>
      <Group>
        {row(t('set.scSend'), ...(k.send === '⌘↩' ? ['⌘', '↩'] : ['↩']))}
        {row(t('set.scNewline'), ...(k.newline === '⇧↩' ? ['⇧', '↩'] : ['↩']))}
        {row(t('set.scMention'), '@')}
        {row(t('set.scMentionNav'), '↑', '↓')}
        {row(t('set.scMentionSub'), '→', '←')}
        {row(t('set.scMentionPick'), '↩', 'Tab')}
        {row(t('set.scEsc'), 'Esc')}
      </Group>
      <p className="px-1 text-[12px] text-ink-3">{t('set.scHint')}</p>
    </>
  )
}

function About() {
  const { info, kindState, toast } = useApp()
  const [versions, setVersions] = useState<Partial<Record<ProfileKind, string | null>>>({})
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    for (const k of KINDS) {
      if (!kindState(k)?.binaryPath) setVersions((v) => ({ ...v, [k]: null }))
      else void window.agentswitch.cli.version(k).then((ver) => setVersions((v) => ({ ...v, [k]: ver })))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const cliText = (k: ProfileKind) => (versions[k] === undefined ? t('about.checking') : versions[k] ? `v${versions[k]!.replace(/^v/, '')}` : t('about.notInstalled'))
  const rows: [string, string][] = info
    ? [
        ['AgentSwitch', info.version],
        ['macOS', `${info.osVersion} (${info.arch})`],
        ['Electron', info.electron],
        ['Chromium', info.chrome],
        ['Node.js', info.node],
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
    <div className="pt-6">
      <div className="flex flex-col items-center text-center">
        <BrandMark size={72} />
        <div className="mt-4 text-[22px] font-semibold tracking-tight text-ink">AgentSwitch</div>
        <div className="mt-1 text-[13px] text-ink-3 tabular-nums">{info ? t('about.version', { v: info.version }) : ''}</div>
        <div className="mt-2 max-w-[420px] text-[13px] leading-relaxed text-ink-2">{t('about.tagline')}</div>
        <button className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:text-accent-hover" onClick={() => void window.agentswitch.sys.openExternal(WEBSITE)}>
          {t('about.website')} agentswitch.app <IconExternal size={13} />
        </button>
      </div>
      <div className="mt-8 overflow-hidden rounded-xl border border-black/[0.07] bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
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
    </div>
  )
}
