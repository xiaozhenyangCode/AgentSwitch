import type { Activity, AgentRef, Message, UserMessage } from '../state/chat'
import { modelLabel } from './models'

/**
 * DEMO ONLY: fabricates a plausible multi-model exchange so the conversation UI can be
 * judged before the real CLI engine exists. Delete when Phase 2 lands.
 */

export interface PlannedReply {
  agent: AgentRef
  dispatchedBy: AgentRef | null
  activity: Activity[]
  markdown: string
}

/** Mock images are referenced as `mock-image://<seed>` and drawn as SVG by the renderer. */
export function mockImageUrl(src: string): string | null {
  const m = /^mock-image:\/\/(\d+)/.exec(src)
  if (!m) return null
  const seed = Number(m[1])
  // last digit = item index: 0 ice (cyan hexagon), 1 fire (orange drop), 2 leaf (green), 3 orb
  const k = seed % 10
  const h1 = ([188, 22, 128, 262][k % 4] + Math.floor(seed / 10) * 9) % 360
  const h2 = (h1 + 40) % 360
  const shapes = [
    '<path d="M128 52l58 34v68l-58 34-58-34V86z" fill="white" fill-opacity=".92"/><path d="M128 52v136M70 86l116 68M186 86L70 154" stroke="url(#g)" stroke-width="6" stroke-opacity=".5"/>',
    '<path d="M128 46c26 40 52 62 52 96a52 52 0 0 1-104 0c0-34 26-56 52-96z" fill="white" fill-opacity=".92"/>',
    '<path d="M76 168c0-66 40-104 104-112-6 64-44 106-104 112z" fill="white" fill-opacity=".92"/><path d="M76 168l70-78" stroke="url(#g)" stroke-width="7" stroke-linecap="round"/>',
    '<circle cx="128" cy="128" r="62" fill="white" fill-opacity=".9"/><circle cx="128" cy="128" r="34" fill="url(#g)"/>'
  ]
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 256 256"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h1},85%,64%)"/><stop offset="1" stop-color="hsl(${h2},80%,46%)"/></linearGradient></defs><rect width="256" height="256" rx="56" fill="url(#g)"/>${shapes[k % shapes.length]}</svg>`
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg)
}

type TaskType = 'prompt' | 'image' | 'review' | 'code' | 'general'

const detect = (t: string): TaskType =>
  /验收|审核|审查|检查|复核|评审|review/i.test(t)
    ? 'review'
    : /提示词|prompt|文案|描述/i.test(t)
      ? 'prompt'
      : /图|画|image|素材|icon|图标|插画|海报/i.test(t)
        ? 'image'
        : /代码|函数|bug|修复|测试|实现|重构|脚本|报错/i.test(t)
          ? 'code'
          : 'general'

const ITEMS = [
  { id: 'ice-crystal', name: '冰晶', prompt: 'a faceted ice crystal gem, soft cyan glow, glossy highlights, centered, game item icon, transparent background' },
  { id: 'fire-drop', name: '火焰宝石', prompt: 'a teardrop-shaped fire gem, warm orange gradient, inner glow, centered, game item icon, transparent background' },
  { id: 'leaf-charm', name: '叶片护符', prompt: 'a stylized green leaf charm, smooth gradient, subtle rim light, centered, game item icon, transparent background' }
]

const tag = (a: AgentRef) => `**${a.name}**`
const PUNCT = /^[\s，,。、；;]+|[\s，,。、；;]+$/g
const clean = (t: string) =>
  t.replace(PUNCT, '').replace(/^(然后|再|并且|最后|接着)?(让|由|请)?/, '').replace(/(然后|再|并且|最后|接着)?(让|由|请)?$/, '').replace(PUNCT, '')

/** Splits "@A 写提示词，然后让 @B 出图" into per-mention tasks. */
function tasksOf(user: UserMessage): { ref: AgentRef; task: string }[] {
  const marks = user.mentions
    .map((ref) => {
      const i = user.text.indexOf('@' + ref.name)
      return { ref, i, end: i < 0 ? -1 : i + ref.name.length + 1 }
    })
    .filter((m) => m.i >= 0)
    .sort((a, b) => a.i - b.i)
  return marks.map((m, k) => {
    let rest = user.text.slice(m.end, k + 1 < marks.length ? marks[k + 1].i : undefined)
    rest = rest.replace(/^\([^)]*\)/, '')
    return { ref: m.ref, task: clean(rest) || '协助完成任务' }
  })
}

export function mockConversation(user: UserMessage, history: Message[]): PlannedReply[] {
  const driver = user.driver
  const refs = user.attachments.filter((a) => a.isImage)
  const readAttach: Activity[] = user.attachments.map((a) => ({ type: 'read', target: a.path ?? a.name }))
  const turn = history.filter((m) => m.role === 'user').length + 1
  const tasks = tasksOf(user)
  const others = tasks.filter((t) => t.ref.profileId !== driver.profileId)

  // ---- single speaker
  if (!others.length) {
    const own = tasks.find((t) => t.ref.profileId === driver.profileId)?.task ?? user.text.replace(/@\S+(\s*账号\s*\d+)?(\([^)]*\))?/g, '').trim()
    return [{ agent: driver, dispatchedBy: null, ...single(detect(own), own, refs.map((r) => r.name), readAttach, turn) }]
  }

  // ---- driver plans, then each mentioned account speaks in order, then driver wraps up
  const ownTask = tasks.find((t) => t.ref.profileId === driver.profileId)?.task
  const out: PlannedReply[] = []
  const planRows = tasks.map((t, i) => `| ${i + 1} | ${t.ref.profileId === driver.profileId ? '我' : tag(t.ref)} · ${modelLabel(t.ref.model)} | ${t.task} |`).join('\n')
  const writesPrompts = !!ownTask && detect(ownTask) === 'prompt'
  out.push({
    agent: driver,
    dispatchedBy: null,
    activity: [...readAttach, { type: 'read', target: 'assets/' }, ...(writesPrompts ? [{ type: 'write' as const, target: '.agentmux/prompts.json' }] : [])],
    markdown: `收到，这个任务我来拆解和调度${refs.length ? `，参考图 ${refs.map((r) => `\`${r.name}\``).join('、')} 已读取` : ''}：

| 步骤 | 执行者 | 任务 |
| --- | --- | --- |
${planRows}
${
  writesPrompts
    ? `
先完成我这一步，**${ITEMS.length} 条图像提示词**如下（已写入 \`.agentmux/prompts.json\`）：

${ITEMS.map((it, i) => `${i + 1}. **${it.name}**\n   \`\`\`text\n   ${it.prompt}\n   \`\`\``).join('\n')}
`
    : ''
}
接下来交给 ${others.map((o) => tag(o.ref)).join(' → ')}。`
  })

  const images: { file: string; seed: number; name: string }[] = []
  for (const t of others) {
    const type = detect(t.task)
    if (type === 'image') {
      ITEMS.forEach((it, i) => images.push({ file: `assets/generated/${it.id}.png`, seed: turn * 10 + i, name: it.name }))
      out.push({
        agent: t.ref,
        dispatchedBy: driver,
        activity: [
          { type: 'read', target: '.agentmux/prompts.json' },
          ...images.map((im) => ({ type: 'write' as const, target: im.file })),
          { type: 'run', target: 'pngquant --skip-if-larger assets/generated/*.png' }
        ],
        markdown: `按 ${tag(driver)} 给的提示词生成了 ${images.length} 张图，均为 512 × 512、透明背景：

${images.map((im) => `![${im.name}](mock-image://${im.seed})`).join(' ')}

| 文件 | 大小 | 备注 |
| --- | --- | --- |
${images.map((im, i) => `| \`${im.file}\` | ${[38, 41, 35][i % 3]} KB | ${['高光略强', '边缘干净', '对比度适中'][i % 3]} |`).join('\n')}

已压缩，路径可以直接在项目里引用。`
      })
    } else if (type === 'review') {
      const files = images.length ? images : ITEMS.map((it, i) => ({ file: `assets/generated/${it.id}.png`, seed: i, name: it.name }))
      out.push({
        agent: t.ref,
        dispatchedBy: driver,
        activity: files.map((f) => ({ type: 'read' as const, target: f.file })),
        markdown: `我逐张检查了 ${files.length} 个产出：

| 文件 | 尺寸 | 透明背景 | 风格一致 | 结论 |
| --- | --- | --- | --- | --- |
${files.map((f, i) => `| \`${f.file.split('/').pop()}\` | ✅ | ✅ | ${i === 0 ? '⚠️ 高光偏亮' : '✅'} | ${i === 0 ? '建议微调' : '通过'} |`).join('\n')}

**修改意见**
- \`${files[0].file.split('/').pop()}\` 的高光比另外两张亮约 15%，放在一起会抢视觉焦点，建议降低高光强度
- 命名符合 \`kebab-case\` 规范，无需调整

\`\`\`json
{ "status": "PASS", "reason": "3 张均符合规格，1 张建议微调高光（非阻塞）" }
\`\`\``
      })
    } else {
      out.push({ agent: t.ref, dispatchedBy: driver, ...single(type, t.task, [], [], turn) })
    }
  }

  out.push({
    agent: driver,
    dispatchedBy: null,
    activity: [],
    markdown: `**汇总**：${others.map((o) => `${tag(o.ref)} 已完成「${o.task}」`).join('；')}。${
      images.length ? `\n\n产出在 \`assets/generated/\`。需要按验收意见再调一版的话，直接说“按意见重做第 1 张”即可。` : ''
    }`
  })
  return out
}

function single(type: TaskType, task: string, refNames: string[], readAttach: Activity[], turn: number): { activity: Activity[]; markdown: string } {
  const brief = task.length > 24 ? task.slice(0, 24) + '…' : task || '这个任务'
  if (type === 'image') {
    const seeds = [turn * 10, turn * 10 + 1, turn * 10 + 2]
    return {
      activity: [...readAttach, ...ITEMS.map((it) => ({ type: 'write' as const, target: `assets/generated/${it.id}.png` }))],
      markdown: `${refNames.length ? `参考了 ${refNames.map((n) => `\`${n}\``).join('、')}，` : ''}按「${brief}」生成了 3 张候选：

${seeds.map((s, i) => `![${ITEMS[i].name}](mock-image://${s})`).join(' ')}

都已保存到 \`assets/generated/\`，背景透明。选一张作为基准，我可以继续统一风格。`
    }
  }
  if (type === 'prompt')
    return {
      activity: [...readAttach],
      markdown: `按「${brief}」写了 3 条提示词：\n\n${ITEMS.map((it, i) => `${i + 1}. **${it.name}**：\`${it.prompt}\``).join('\n')}`
    }
  if (type === 'code')
    return {
      activity: [...readAttach, { type: 'search', target: 'loadConfig' }, { type: 'read', target: 'src/config/loader.ts' }, { type: 'run', target: 'pnpm test' }, { type: 'write', target: 'src/config/loader.ts' }],
      markdown: `问题出在 \`loadConfig\` 读取失败时直接抛出，调用方没有兜底。

\`\`\`ts
export async function loadConfig(path: string): Promise<Config> {
  try {
    return { ...DEFAULTS, ...JSON.parse(await readFile(path, 'utf8')) }
  } catch (err) {
    console.warn(\`[config] fallback to defaults: \${(err as Error).message}\`)
    return DEFAULTS
  }
}
\`\`\`

\`\`\`bash
pnpm test --filter config
# ✓ 3 passed
\`\`\``
    }
  if (type === 'review')
    return {
      activity: [...readAttach, { type: 'run', target: 'git diff --stat HEAD~1' }],
      markdown: `看了最近的改动，整体没问题，两点建议：\n\n1. 错误处理分散在多个调用点，建议统一出口\n2. 新增逻辑缺少空输入的测试`
    }
  return {
    activity: [...readAttach, { type: 'read', target: 'package.json' }, { type: 'read', target: 'README.md' }],
    markdown: `关于「${brief}」，建议分三步：

## 1. 摸清现状
- 列出入口文件和主要模块
- 用 \`git log --oneline -20\` 看最近的改动方向

## 2. 拆分任务
| 优先级 | 任务 |
| --- | --- |
| 高 | 梳理目录结构与模块职责 |
| 中 | 补齐文档与示例 |

## 3. 逐项落地
每完成一项提交一次，方便回滚。`
  }
}
