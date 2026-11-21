import { useEffect, useState, type ReactNode } from 'react'
import type { EnvPreview, ProfileConfig, ProfileState, PtyMode } from '@shared/types'
import { KIND_META, btnGhost, btnPrimary, btnSecondary, inputCls } from '../lib/ui'
import { KindAvatar, Modal, Segmented } from './common'
import { IconFolder, IconX } from './icons'

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

const DIR_HINT = {
  claude: '作为 CLAUDE_CONFIG_DIR 注入（选 ~/.claude 时不注入，沿用系统默认）',
  gemini: '作为隔离的 HOME 注入；会自动链接真实 HOME 下的 .gitconfig / .npmrc / .ssh',
  codex: '作为 CODEX_HOME 注入'
} as const

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
  const [form, setForm] = useState<ProfileConfig>(profile)
  const [envText, setEnvText] = useState(envToText(profile.extraEnv))
  const [preview, setPreview] = useState<EnvPreview | null>(null)
  const [previewMode, setPreviewMode] = useState<PtyMode>('login')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void window.agentmux.profiles.envPreview(profile.id, previewMode).then(setPreview)
  }, [profile.id, previewMode, profile])

  const isolated = `${userData}/profiles/${profile.id}${profile.kind === 'gemini' ? '/home' : ''}`
  const presets: { label: string; value: string }[] = [
    { label: 'AgentMux 独立目录', value: isolated },
    ...(profile.kind === 'claude'
      ? [
          { label: '~/.claude', value: '~/.claude' },
          { label: '~/.claude2', value: '~/.claude2' }
        ]
      : profile.kind === 'codex'
        ? [{ label: '~/.codex', value: '~/.codex' }]
        : [{ label: '真实 HOME（~）', value: '~' }])
  ]

  const set = <K extends keyof ProfileConfig>(k: K, v: ProfileConfig[K]) => setForm((f) => ({ ...f, [k]: v }))

  const save = async () => {
    try {
      await window.agentmux.profiles.update(profile.id, {
        name: form.name,
        configDir: form.configDir,
        loginCommand: form.loginCommand,
        runCommand: form.runCommand,
        extraEnv: textToEnv(envText)
      })
      setPreview(await window.agentmux.profiles.envPreview(profile.id, previewMode))
      setError(null)
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } catch (e) {
      setError(String(e))
    }
  }

  const reset = async () => {
    await window.agentmux.profiles.reset(profile.id)
    const p = (await window.agentmux.state.get()).profiles.find((x) => x.id === profile.id)
    if (p) {
      setForm(p)
      setEnvText(envToText(p.extraEnv))
    }
  }

  const pick = async () => {
    const dir = await window.agentmux.sys.pickDirectory(form.configDir, '选择配置目录')
    if (dir) set('configDir', dir)
  }

  const mono = inputCls + ' font-mono text-[13px]'

  return (
    <Modal onClose={onClose} width={640}>
      <div className="flex items-center gap-3.5 border-b border-hairline px-7 py-5">
        <KindAvatar kind={profile.kind} size={36} />
        <div className="flex-1">
          <div className="text-[17px] font-semibold text-ink">{profile.name}</div>
          <div className="text-[13px] text-ink-2">账号设置 · {KIND_META[profile.kind].cli}{profile.imported ? ' · 已导入的本机配置' : ''}</div>
        </div>
        <button className="rounded-full p-1.5 text-ink-3 hover:bg-fill hover:text-ink" onClick={onClose}>
          <IconX size={16} />
        </button>
      </div>

      <div className="space-y-5 px-7 py-6">
        <Field label="账号名称">
          <input className={inputCls} value={form.name} onChange={(e) => set('name', e.target.value)} />
        </Field>

        <Field label="配置目录" hint={DIR_HINT[profile.kind]}>
          <div className="flex gap-2">
            <input className={mono} value={form.configDir} onChange={(e) => set('configDir', e.target.value)} />
            <button className={btnSecondary + ' shrink-0'} onClick={() => void pick()}>
              选择…
            </button>
            <button className={btnGhost + ' shrink-0'} onClick={() => void window.agentmux.sys.openPath(profile.resolvedConfigDir)} title="在 Finder 中显示">
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

        <div className="grid grid-cols-2 gap-4">
          <Field label="登录命令">
            <input className={mono} value={form.loginCommand} onChange={(e) => set('loginCommand', e.target.value)} />
          </Field>
          <Field label="运行命令">
            <input className={mono} value={form.runCommand} onChange={(e) => set('runCommand', e.target.value)} />
          </Field>
        </div>
        <Field label="额外环境变量" hint="每行一个 KEY=VALUE，例如代理设置">
          <textarea
            className={mono + ' h-24 resize-y py-2 leading-relaxed'}
            value={envText}
            onChange={(e) => setEnvText(e.target.value)}
            placeholder={'HTTPS_PROXY=http://127.0.0.1:7890'}
          />
        </Field>

        <div className="rounded-xl bg-fill p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[13px] font-medium text-ink">生效环境预览</span>
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
                : '（不注入变量，使用真实 HOME 与登录 Shell 环境）'}
            </pre>
          )}
        </div>

        {error && <div className="text-[13px] text-[#C2352B]">{error}</div>}
      </div>

      <div className="flex items-center justify-between border-t border-hairline px-7 py-4">
        <div className="flex gap-1">
          <button className={btnGhost + ' text-[#D70015] hover:bg-[#FDECEC] hover:text-[#D70015]'} onClick={onDelete}>
            删除账号
          </button>
          <button className={btnGhost} onClick={() => void reset()} title="恢复默认的登录 / 运行命令与环境变量">
            恢复默认命令
          </button>
        </div>
        <div className="flex gap-2.5">
          <button className={btnSecondary} onClick={onClose}>
            关闭
          </button>
          <button className={btnPrimary + ' min-w-20'} onClick={() => void save()}>
            {saved ? '已保存' : '保存'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
