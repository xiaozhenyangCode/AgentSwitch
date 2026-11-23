import { useApp } from '../state/AppContext'
import { useEffect, useState, type ReactNode } from 'react'
import type { EnvPreview, ProfileConfig, ProfileKind, ProfileState, PtyMode } from '@shared/types'
import { KIND_META, btnGhost, btnPrimary, btnSecondary, inputCls } from '../lib/ui'
import { Modal, ProfileAvatar, Segmented } from './common'
import { ChangeKeyModal } from './dialogs'
import { IconFolder, IconX } from './icons'
import { modelLabel, resolveSpec, withEffort } from '../lib/models'
import { EffortBar } from './EffortBar'
import { useModels } from '../state/models'
import { t } from '../state/i18n'

interface Props {
  profile: ProfileState
  userData: string
  onClose: () => void
  onDelete: () => void
}

const envToText = (env: Record<string, string>) =>
  Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')

function textToEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i > 0) env[t.slice(0, i).trim()] = t.slice(i + 1)
  }
  return env
}

const dirHint = (kind: ProfileKind): string => t(kind === 'claude' ? 'cfg.dirHintClaude' : kind === 'gemini' ? 'cfg.dirHintGemini' : 'cfg.dirHintCodex')

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[13px] font-medium text-ink">{label}</div>
      {children}
      {hint && <div className="mt-1.5 text-[12px] leading-relaxed text-ink-3">{hint}</div>}
    </div>
  )
}

export function ProfileConfigModal({ profile, userData, onClose, onDelete }: Props) {
  const { info } = useApp()
  const { list: models, loading: modelsLoading, refresh: refreshModels } = useModels(profile.id)
  const [form, setForm] = useState<ProfileConfig>(profile)
  const [envText, setEnvText] = useState(envToText(profile.extraEnv))
  const [preview, setPreview] = useState<EnvPreview | null>(null)
  const [previewMode, setPreviewMode] = useState<PtyMode>('login')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const conn = profile.apiKey
  const [modelsText, setModelsText] = useState((conn?.models ?? []).join('\n'))
  const [changingKey, setChangingKey] = useState(false)

  useEffect(() => {
    void window.agentswitch.profiles.envPreview(profile.id, previewMode).then(setPreview)
  }, [profile.id, previewMode, profile])

  const isolated = `${userData}/profiles/${profile.id}${profile.kind === 'gemini' ? '/home' : ''}`
  const presets: { label: string; value: string }[] = [
    { label: t('cfg.isolatedDir'), value: isolated },
    ...(profile.kind === 'claude'
      ? [...new Set(['~/.claude', ...(info?.claudeDirs ?? [])])].map((d) => ({ label: d, value: d }))
      : profile.kind === 'codex'
        ? [{ label: '~/.codex', value: '~/.codex' }]
        : [{ label: t('cfg.realHome'), value: '~' }])
  ]

  const defSpec = resolveSpec(form.defaultModel, profile.id)
  const set = <K extends keyof ProfileConfig>(k: K, v: ProfileConfig[K]) => setForm((f) => ({ ...f, [k]: v }))

  const save = async () => {
    try {
      await window.agentswitch.profiles.update(profile.id, {
        name: form.name,
        ...(conn
          ? conn.provider === 'custom'
            ? { apiKey: { ...conn, models: modelsText.split(/[,\n]/).map((m) => m.trim()).filter(Boolean) } }
            : {}
          : { configDir: form.configDir }),
        loginCommand: form.loginCommand,
        runCommand: form.runCommand,
        defaultModel: form.defaultModel ?? '',
        autoApprove: form.autoApprove === 'full' || form.autoApprove === 'edits' ? form.autoApprove : 'cli',
        extraEnv: textToEnv(envText)
      })
      setPreview(await window.agentswitch.profiles.envPreview(profile.id, previewMode))
      setError(null)
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } catch (e) {
      setError(String(e))
    }
  }

  const reset = async () => {
    await window.agentswitch.profiles.reset(profile.id)
    const p = (await window.agentswitch.state.get()).profiles.find((x) => x.id === profile.id)
    if (p) {
      setForm(p)
      setEnvText(envToText(p.extraEnv))
    }
  }

  const pick = async () => {
    const dir = await window.agentswitch.sys.pickDirectory(form.configDir, t('cfg.pickDir'))
    if (dir) set('configDir', dir)
  }

  const mono = inputCls + ' font-mono text-[13px]'

  return (
    <Modal onClose={onClose} width={640}>
      <div className="flex items-center gap-3.5 border-b border-hairline px-7 py-5">
        <ProfileAvatar profile={profile} size={36} />
        <div className="flex-1">
          <div className="text-[17px] font-semibold text-ink">{profile.name}</div>
          <div className="text-[13px] text-ink-2">{t('cfg.subtitle', { cli: KIND_META[profile.kind].cli })}{profile.imported ? t('cfg.imported') : ''}</div>
        </div>
        <button className="rounded-full p-1.5 text-ink-3 hover:bg-fill hover:text-ink" onClick={onClose}>
          <IconX size={16} />
        </button>
      </div>

      <div className="space-y-5 px-7 py-6">
        <Field label={t('add.name')}>
          <input className={inputCls} value={form.name} onChange={(e) => set('name', e.target.value)} />
        </Field>

        {conn && (
          <div className="space-y-4 rounded-xl bg-fill p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[13px] font-medium text-ink">{t('apikey.section')}</div>
                <div className="mt-0.5 text-[13px] text-ink-2">
                  {conn.provider === 'deepseek' ? t('add.conn.deepseek') : conn.provider === 'custom' ? t('add.conn.custom') : t(`add.conn.official.${profile.kind}`)}
                  {' · '}
                  {profile.loggedIn ? t('apikey.saved') : t('apikey.noKey')}
                </div>
              </div>
              <button className={btnSecondary} onClick={() => setChangingKey(true)}>
                {t('apikey.change')}
              </button>
            </div>
            {conn.baseUrl && (
              <Field label={t('apikey.baseUrl')}>
                <input className={mono} value={conn.baseUrl} readOnly />
              </Field>
            )}
            {conn.provider === 'custom' && (
              <Field label={t('apikey.models')} hint={t('apikey.modelsHint')}>
                <textarea className={mono + ' h-20 resize-y py-2 leading-relaxed'} value={modelsText} onChange={(e) => setModelsText(e.target.value)} spellCheck={false} />
              </Field>
            )}
          </div>
        )}

        {!conn && (
        <Field label={t('cfg.dir')} hint={dirHint(profile.kind)}>
          <div className="flex gap-2">
            <input className={mono} value={form.configDir} onChange={(e) => set('configDir', e.target.value)} />
            <button className={btnSecondary + ' shrink-0'} onClick={() => void pick()}>
              {t('common.chooseEllipsis')}
            </button>
            <button className={btnGhost + ' shrink-0'} onClick={() => void window.agentswitch.sys.openPath(profile.resolvedConfigDir)} title={t('common.showInFinder')}>
              <IconFolder size={16} />
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {presets.map((p) => (
              <button
                key={p.value}
                className={`h-7 rounded-full px-3 text-[12px] font-medium transition-colors ${
                  form.configDir === p.value ? 'bg-accent text-white' : 'bg-fill text-ink-2 hover:bg-fill-hover hover:text-ink'
                }`}
                onClick={() => set('configDir', p.value)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </Field>
        )}

        <Field
          label={t('cfg.defaultModel')}
          hint={t('cfg.defaultModelHint', { cli: KIND_META[profile.kind].cli })}
        >
          <input className={mono} value={form.defaultModel ?? ''} onChange={(e) => set('defaultModel', e.target.value)} placeholder={t('cfg.defaultModelPlaceholder')} />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {['', ...(models?.models ?? []).filter((m) => m.group === 'main').map((m) => m.id)].map((m) => (
              <button
                key={m || '_'}
                className={`h-7 rounded-full px-3 text-[12px] font-medium transition-colors ${
                  (defSpec.model ?? '') === m ? 'bg-accent text-white' : 'bg-fill text-ink-2 hover:bg-fill-hover hover:text-ink'
                }`}
                onClick={() => {
                  const opt = models?.models.find((x) => x.id === m) ?? null
                  set('defaultModel', m ? (withEffort(opt, m, defSpec.effort) ?? '') : '')
                }}
              >
                {m ? modelLabel(m, profile.id) : t('common.default')}
              </button>
            ))}
            <button className="h-7 rounded-full px-2.5 text-[12px] text-ink-3 hover:bg-fill hover:text-ink" onClick={refreshModels} disabled={modelsLoading} title={t('wb.refetchModels')}>
              {modelsLoading ? t('cfg.fetching') : t('cfg.refreshList')}
            </button>
          </div>
          {defSpec.opt?.efforts && defSpec.opt.efforts.length > 1 && (
            <div className="-mx-2 mt-3 w-[340px]">
              <EffortBar opt={defSpec.opt} effort={defSpec.effort} onChange={(e) => defSpec.model && set('defaultModel', withEffort(defSpec.opt, defSpec.model, e) ?? '')} />
            </div>
          )}
          {models?.error && <div className="mt-1.5 text-[12px] text-warn">{t('cfg.modelsFailed', { src: models.source === 'cache' ? t('cfg.lastCache') : t('cfg.builtin'), error: models.error })}</div>}
        </Field>

        <Field
          label={t('cfg.approval')}
          hint={
            form.autoApprove === 'cli'
              ? t('cfg.approvalCli')
              : form.autoApprove === 'full'
              ? t('cfg.approvalFull')
              : t('cfg.approvalEdits')
          }
        >
          <Segmented
            value={form.autoApprove === 'full' || form.autoApprove === 'edits' ? form.autoApprove : 'cli'}
            onChange={(v) => set('autoApprove', v)}
            options={[
              { value: 'cli', label: t('cfg.optCli') },
              { value: 'edits', label: t('cfg.optEdits') },
              { value: 'full', label: t('cfg.optFull') }
            ]}
          />
        </Field>

        {!conn && (
        <div className="grid grid-cols-2 gap-4">
          <Field label={t('cfg.loginCmd')}>
            <input className={mono} value={form.loginCommand} onChange={(e) => set('loginCommand', e.target.value)} />
          </Field>
          <Field label={t('cfg.runCmd')}>
            <input className={mono} value={form.runCommand} onChange={(e) => set('runCommand', e.target.value)} />
          </Field>
        </div>
        )}
        <Field label={t('cfg.extraEnv')} hint={t('cfg.extraEnvHint')}>
          <textarea
            className={mono + ' h-24 resize-y py-2 leading-relaxed'}
            value={envText}
            onChange={(e) => setEnvText(e.target.value)}
            placeholder={'HTTPS_PROXY=http://127.0.0.1:7890'}
          />
        </Field>

        <div className="rounded-xl bg-fill p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[13px] font-medium text-ink">{t('cfg.envPreview')}</span>
            <Segmented
              value={previewMode}
              onChange={setPreviewMode}
              options={(['install', 'login', 'run', 'shell'] as PtyMode[]).map((m) => ({ value: m, label: m }))}
            />
          </div>
          {preview && (
            <pre className="overflow-x-auto font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-ink-2 select-text">
              {`$ ${preview.shell} ${preview.args.map((a) => JSON.stringify(a)).join(' ')}\n`}
              {Object.keys(preview.injected).length
                ? Object.entries(preview.injected)
                    .map(([k, v]) => `+ ${k}=${v}`)
                    .join('\n')
                : t('cfg.noInject')}
            </pre>
          )}
        </div>

        {error && <div className="text-[13px] text-danger">{error}</div>}
      </div>

      <div className="flex items-center justify-between border-t border-hairline px-7 py-4">
        <div className="flex gap-1">
          <button className={btnGhost + ' text-danger hover:bg-danger-soft hover:text-danger'} onClick={onDelete}>
            {t('cfg.deleteAccount')}
          </button>
          <button className={btnGhost} onClick={() => void reset()} title={t('cfg.resetHint')}>
            {t('cfg.resetCmds')}
          </button>
        </div>
        <div className="flex gap-2.5">
          <button className={btnSecondary} onClick={onClose}>
            {t('common.close')}
          </button>
          <button className={btnPrimary + ' min-w-20'} onClick={() => void save()}>
            {saved ? t('common.saved') : t('common.save')}
          </button>
        </div>
      </div>
      {changingKey && <ChangeKeyModal profile={profile} onClose={() => setChangingKey(false)} />}
    </Modal>
  )
}
