import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { ProfileId, ProfileKind, ProfileState } from '@shared/types'
import { useApp } from '../state/AppContext'
import { TEMPLATES, NODE_STATUS_META, type NodeRunStatus, type WorkflowNodeDef, type WorkflowTemplate } from '../lib/workflow'
import { KIND_META, accountBadge, btnPrimary, isReady } from '../lib/ui'
import { KindAvatar, Pill, Segmented } from '../components/common'
import { IconAlert, IconArrowRight, IconChevronDown, IconClock, IconFolder, IconInfo, IconPlay, IconReturn } from '../components/icons'

const LS_KEY = 'agentmux.workflow.ui.v1'

interface UiState {
  projectDir: string | null
  templateId: string
  bindings: Record<string, Record<string, ProfileId>>
}

function loadUi(): UiState {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) ?? '')
    return { projectDir: v.projectDir ?? null, templateId: v.templateId ?? TEMPLATES[0].id, bindings: v.bindings ?? {} }
  } catch {
    return { projectDir: null, templateId: TEMPLATES[0].id, bindings: {} }
  }
}

const shortPath = (p: string) => p.replace(/^\/Users\/[^/]+/, '~')
const baseName = (p: string) => p.split('/').filter(Boolean).pop() ?? p

/** Accounts that may run a node, ordered by the node's kind preference then creation time. */
export const candidatesFor = (n: WorkflowNodeDef, profiles: ProfileState[]): ProfileState[] =>
  n.kinds.flatMap((k) => profiles.filter((p) => p.kind === k).sort((a, b) => a.createdAt - b.createdAt))

export function WorkflowsPage() {
  const { byId, navigate, toast, profiles, openAddAccount } = useApp()
  const [ui, setUi] = useState<UiState>(loadUi)
  useEffect(() => localStorage.setItem(LS_KEY, JSON.stringify(ui)), [ui])

  const template = TEMPLATES.find((t) => t.id === ui.templateId) ?? TEMPLATES[0]
  /** Saved choice if that account still exists, otherwise the best available candidate (or null). */
  const binding = (n: WorkflowNodeDef): ProfileId | null => {
    const cands = candidatesFor(n, profiles)
    const saved = ui.bindings[template.id]?.[n.id]
    if (saved && cands.some((c) => c.id === saved)) return saved
    return (cands.find(isReady) ?? cands[0])?.id ?? null
  }
  const setBinding = (nodeId: string, id: ProfileId) =>
    setUi((u) => ({ ...u, bindings: { ...u.bindings, [template.id]: { ...u.bindings[template.id], [nodeId]: id } } }))

  // Phase 2: driven by workflowEngine.ts. Until then every node is waiting.
  const nodeStatus = (_n: WorkflowNodeDef): NodeRunStatus => 'waiting'

  const missing = useMemo(() => {
    const seen = new Set<ProfileId>()
    const out: ProfileState[] = []
    for (const n of template.nodes) {
      const id = binding(n)
      const p = id ? byId(id) : undefined
      if (p && !isReady(p) && !seen.has(p.id)) {
        seen.add(p.id)
        out.push(p)
      }
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template, ui.bindings, profiles])
  /** Nodes with no account of any allowed kind. */
  const unassigned = template.nodes.filter((n) => binding(n) === null)
  const addFor = (n: WorkflowNodeDef, kind = n.kinds[0]) => openAddAccount(kind, (id) => setBinding(n.id, id))

  const pickProject = async () => {
    const dir = await window.agentmux.sys.pickDirectory(ui.projectDir ?? undefined, '选择目标项目文件夹')
    if (dir) setUi((u) => ({ ...u, projectDir: dir }))
  }

  const run = () => {
    if (!ui.projectDir)
      return toast({ kind: 'warn', title: '请先选择目标项目', desc: '工作流会在该文件夹中读写素材与任务数据。', action: { label: '选择文件夹', run: () => void pickProject() } })
    if (unassigned.length)
      return toast({
        kind: 'warn',
        title: '还有步骤没有可用账号',
        desc: unassigned.map((n) => `「${n.title}」需要 ${KIND_META[n.kinds[0]].name} 账号`).join('、'),
        action: { label: `添加 ${KIND_META[unassigned[0].kinds[0]].name} 账号`, run: () => addFor(unassigned[0]) }
      })
    if (missing.length)
      return toast({
        kind: 'warn',
        title: '还有账号未就绪',
        desc: missing.map((p) => `${p.name}：${accountBadge(p).label}`).join('、'),
        action: { label: '前往模型引擎', run: () => navigate('engines', missing[0].id) }
      })
    toast({ kind: 'info', title: '工作流引擎即将接入', desc: '串行执行与自动打回重试将在下一阶段开放。' })
  }

  const reviewNode = template.nodes.find((n) => n.review)
  const rejectTarget = reviewNode ? template.nodes.findIndex((n) => n.id === reviewNode.review!.rejectTo) : -1
  const reviewIndex = reviewNode ? template.nodes.indexOf(reviewNode) : -1

  return (
    <div className="flex h-full flex-col">
      {/* unified toolbar */}
      <div className="drag flex h-14 shrink-0 items-center gap-2.5 px-8">
        <button
          onClick={() => void pickProject()}
          className="flex h-9 max-w-[320px] min-w-0 items-center gap-2 rounded-full bg-white px-4 text-[14px] font-medium text-ink shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.04)] transition-colors hover:bg-[#FAFAFB]"
          title={ui.projectDir ? shortPath(ui.projectDir) : undefined}
        >
          <IconFolder size={16} className="shrink-0 text-accent" />
          <span className={`truncate ${ui.projectDir ? '' : 'text-ink-2'}`}>{ui.projectDir ? baseName(ui.projectDir) : '选择目标项目…'}</span>
        </button>

        <label className="relative flex h-9 items-center rounded-full bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.04)] transition-colors hover:bg-[#FAFAFB]">
          <IconWorkflowSmall />
          <select
            className="h-full appearance-none bg-transparent pr-9 pl-9 text-[14px] font-medium text-ink outline-none"
            value={template.id}
            onChange={(e) => setUi((u) => ({ ...u, templateId: e.target.value }))}
          >
            {TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <IconChevronDown size={15} className="pointer-events-none absolute right-3.5 text-ink-3" />
        </label>

        <div className="flex-1" />
        <button className={btnPrimary + ' h-9 px-5'} onClick={run}>
          <IconPlay size={12} /> 开始运行
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1040px] px-10 pt-6 pb-16">
          {unassigned.length > 0 && (
            <div className="mb-3 flex w-full items-center gap-3 rounded-2xl bg-[#FFF8EB] px-5 py-3.5 text-[#9A5B13] ring-1 ring-[#F5D08A]/50">
              <IconAlert size={18} className="shrink-0 text-[#E08A00]" />
              <span className="flex-1 text-[14px] leading-relaxed">
                {unassigned.map((n, i) => (
                  <Fragment key={n.id}>
                    {i > 0 && '；'}步骤「<span className="font-semibold">{n.title}</span>」还没有可用的 {KIND_META[n.kinds[0]].name} 账号
                  </Fragment>
                ))}
              </span>
              <button className="flex shrink-0 items-center gap-1 text-[14px] font-medium hover:text-[#7A4510]" onClick={() => addFor(unassigned[0])}>
                添加账号 <IconArrowRight size={15} />
              </button>
            </div>
          )}
          {missing.length > 0 && (
            <button
              onClick={() => navigate('engines', missing[0].id)}
              className="mb-3 flex w-full items-center gap-3 rounded-2xl bg-[#FFF8EB] px-5 py-3.5 text-left text-[#9A5B13] ring-1 ring-[#F5D08A]/50 transition-colors hover:bg-[#FFF4DF]"
            >
              <IconAlert size={18} className="shrink-0 text-[#E08A00]" />
              <span className="flex-1 text-[14px] leading-relaxed">
                {missing.map((p, i) => (
                  <Fragment key={p.id}>
                    {i > 0 && '、'}
                    <span className="font-semibold">{p.name}</span>
                    {p.status === 'uninstalled' ? ' 尚未安装' : ' 尚未登录'}
                  </Fragment>
                ))}
                ，工作流运行前需要先完成设置。
              </span>
              <span className="flex shrink-0 items-center gap-1 text-[14px] font-medium">
                前往设置 <IconArrowRight size={15} />
              </span>
            </button>
          )}

          {(missing.length > 0 || unassigned.length > 0) && <div className="h-4" />}
          <h1 className="text-[26px] leading-tight font-semibold tracking-tight text-ink">{template.name}</h1>
          <p className="mt-2 max-w-[720px] text-[14px] leading-relaxed text-ink-2">{template.description}</p>

          {/* pipeline: cards and connectors on one grid row, annotations on the next */}
          <div
            className="mt-8 grid items-stretch"
            style={{ gridTemplateColumns: template.nodes.map(() => 'minmax(0,1fr)').join(' 56px ') }}
          >
            {template.nodes.map((n, i) => (
              <Fragment key={n.id}>
                <NodeCard index={i} node={n} status={nodeStatus(n)} profileId={binding(n)} onBind={(id) => setBinding(n.id, id)} onAdd={(k) => addFor(n, k)} />
                {i < template.nodes.length - 1 && (
                  <div className="flex items-center justify-center text-ink-3">
                    <IconArrowRight size={20} strokeWidth={1.6} />
                  </div>
                )}
              </Fragment>
            ))}
            {reviewNode && rejectTarget >= 0 && reviewIndex === rejectTarget + 1 && (
              <div
                className="mt-3 flex items-center justify-center gap-1.5 text-[13px] text-ink-3"
                // spans the card before, the connector, and the review card -> centered under the connector
                style={{ gridColumn: `${rejectTarget * 2 + 1} / span 3` }}
              >
                <IconReturn size={14} />
                审批未通过时自动退回重做，最多 {reviewNode.review!.maxRetries} 次
              </div>
            )}
          </div>

          <RunPanel template={template} projectDir={ui.projectDir} nodeStatus={nodeStatus} binding={binding} />
        </div>
      </div>
    </div>
  )
}

const IconWorkflowSmall = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="pointer-events-none absolute left-3.5 text-accent">
    <rect x="3" y="3" width="6" height="6" rx="1.5" />
    <rect x="15" y="15" width="6" height="6" rx="1.5" />
    <path d="M9 6h4a3 3 0 0 1 3 3v6" />
  </svg>
)

function NodeCard({
  index,
  node,
  status,
  profileId,
  onBind,
  onAdd
}: {
  index: number
  node: WorkflowNodeDef
  status: NodeRunStatus
  profileId: ProfileId | null
  onBind: (id: ProfileId) => void
  onAdd: (kind: ProfileKind) => void
}) {
  const { profiles, byId, navigate } = useApp()
  const p = profileId ? byId(profileId) : undefined
  const ready = isReady(p)
  const options = candidatesFor(node, profiles)
  const badge = p ? accountBadge(p) : null
  const primaryKind = KIND_META[node.kinds[0]]

  return (
    <div className="card card-hover flex min-w-0 flex-col p-6">
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-fill text-[13px] font-semibold text-ink-2">{index + 1}</span>
        <Pill meta={NODE_STATUS_META[status]} />
        <div className="flex-1" />
        <DetailsPopover node={node} />
      </div>

      <div className="mt-4 text-[17px] leading-6 font-semibold text-ink">{node.title}</div>
      <div className="mt-1.5 text-[14px] leading-relaxed text-ink-2">{node.description}</div>

      <div className="mt-auto pt-6">
        {!p ? (
          <>
            <button
              onClick={() => onAdd(node.kinds[0])}
              className="flex h-14 w-full items-center gap-3 rounded-xl border border-dashed border-black/[0.12] px-3 text-left transition-colors hover:border-accent/50 hover:bg-accent/[0.03]"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-accent/10 text-[18px] leading-none text-accent">+</span>
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] leading-5 font-medium text-ink">添加 {primaryKind.name} 账号</span>
                <span className="block text-[12px] leading-4 text-ink-2">这一步还没有可用账号</span>
              </span>
            </button>
            <div className="mt-2 h-5 px-1 text-[13px] text-ink-3">
              {node.kinds.length > 1 && `也可使用 ${node.kinds.slice(1).map((k) => KIND_META[k].name).join(' / ')} 账号`}
            </div>
          </>
        ) : (
          <>
        <label className="group relative flex h-14 items-center gap-3 rounded-xl bg-fill px-3 transition-colors hover:bg-fill-hover">
          {p && <KindAvatar kind={p.kind} size={32} />}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] leading-5 font-medium text-ink">{p?.name ?? profileId}</div>
            {badge && (
              <div className="flex items-center gap-1.5 text-[12px] leading-4 text-ink-2">
                <span className={`h-1.5 w-1.5 rounded-full ${badge.dot}`} />
                {badge.label}
              </div>
            )}
          </div>
          <IconChevronDown size={16} className="text-ink-3" />
          <select
            className="absolute inset-0 cursor-default opacity-0"
            value={profileId ?? ''}
            onChange={(e) => {
              const v = e.target.value
              if (v.startsWith('__add__:')) onAdd(v.slice(8) as ProfileKind)
              else onBind(v)
            }}
            title="选择执行这一步的账号"
          >
            {node.kinds.map((k) => {
              const group = options.filter((o) => o.kind === k)
              return (
                <optgroup key={k} label={KIND_META[k].name}>
                  {group.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}（{accountBadge(o).label}）
                    </option>
                  ))}
                  <option value={`__add__:${k}`}>＋ 添加 {KIND_META[k].name} 账号…</option>
                </optgroup>
              )
            })}
          </select>
        </label>
        <div className="mt-2 flex h-5 items-center px-1 text-[13px]">
          {!ready && p ? (
            <button className="font-medium text-[#C27400] hover:text-[#9A5B13]" onClick={() => navigate('engines', p.id)}>
              {p.status === 'uninstalled' ? `安装 ${KIND_META[p.kind].cli}` : `登录 ${p.name}`} →
            </button>
          ) : (
            <span className="text-ink-3">由 {KIND_META[p.kind].name} 执行</span>
          )}
        </div>
          </>
        )}
      </div>
    </div>
  )
}

/** Inputs/outputs live behind a quiet "i" button instead of cluttering the card. */
function DetailsPopover({ node }: { node: WorkflowNodeDef }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex h-7 w-7 items-center justify-center rounded-full transition-colors ${open ? 'bg-fill text-ink' : 'text-ink-3 hover:bg-fill hover:text-ink-2'}`}
        title="输入与产出"
      >
        <IconInfo size={16} />
      </button>
      {open && (
        <div className="absolute top-9 right-0 z-20 w-72 rounded-xl bg-white p-4 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_12px_32px_rgba(0,0,0,0.14)]">
          {(
            [
              ['读取', node.inputs],
              ['产出', node.outputs]
            ] as const
          ).map(([label, files]) => (
            <div key={label} className="mb-3 last:mb-0">
              <div className="mb-1 text-[12px] font-medium text-ink-2">{label}</div>
              {files.map((f) => (
                <div key={f} className="font-mono text-[12px] leading-5 break-all text-ink select-text">
                  {f}
                </div>
              ))}
            </div>
          ))}
          {node.review && <div className="mt-3 border-t border-hairline pt-3 text-[12px] leading-relaxed text-ink-2">返回 {'{ status: PASS | REJECT, reason }'}</div>}
        </div>
      )}
    </div>
  )
}

function RunPanel({
  template,
  projectDir,
  nodeStatus,
  binding
}: {
  template: WorkflowTemplate
  projectDir: string | null
  nodeStatus: (n: WorkflowNodeDef) => NodeRunStatus
  binding: (n: WorkflowNodeDef) => ProfileId | null
}) {
  const { byId } = useApp()
  const [view, setView] = useState<'progress' | 'json'>('progress')
  const task = {
    workflow: template.id,
    project: projectDir ? shortPath(projectDir) : null,
    currentNode: null,
    retries: 0,
    status: 'idle'
  }

  return (
    <div className="card mt-10 p-6">
      <div className="flex items-center justify-between">
        <div className="text-[17px] font-semibold text-ink">运行</div>
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: 'progress', label: '运行进度' },
            { value: 'json', label: '任务数据' }
          ]}
        />
      </div>

      {view === 'progress' ? (
        <div className="mt-5">
          <div className="divide-y divide-hairline rounded-xl bg-fill/60">
            {template.nodes.map((n, i) => {
              const bid = binding(n)
              const p = bid ? byId(bid) : undefined
              return (
                <div key={n.id} className="flex h-14 items-center gap-3 px-4">
                  <span className="w-5 text-center text-[13px] font-semibold text-ink-3">{i + 1}</span>
                  <div className="flex-1 text-[14px] font-medium text-ink">{n.title}</div>
                  {p ? (
                    <span className="flex items-center gap-2 text-[13px] text-ink-2">
                      <KindAvatar kind={p.kind} size={20} />
                      {p.name}
                    </span>
                  ) : (
                    <span className="text-[13px] text-ink-3">未分配账号</span>
                  )}
                  <span className="w-[72px] text-right">
                    <Pill meta={NODE_STATUS_META[nodeStatus(n)]} size="sm" />
                  </span>
                </div>
              )
            })}
          </div>
          <div className="mt-4 flex items-center gap-2 text-[13px] text-ink-3">
            <IconClock size={15} />
            {projectDir ? '准备就绪后点击右上角「开始运行」，进度会实时显示在这里。' : '先选择目标项目，再点击「开始运行」。'}
          </div>
        </div>
      ) : (
        <div className="mt-5">
          <div className="mb-2 font-mono text-[12px] text-ink-3">.workflow/task.json</div>
          <pre className="overflow-x-auto rounded-xl bg-fill p-4 font-mono text-[13px] leading-relaxed text-ink select-text">
            {JSON.stringify(task, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}
