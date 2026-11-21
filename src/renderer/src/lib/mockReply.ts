import { plainExcerpt, type Activity, type Message, type UserMessage } from '../state/chat'

/**
 * DEMO ONLY: fabricates a plausible streamed reply so the conversation UI can be judged
 * before real CLI output is wired in. Delete when the CLI streaming lands.
 */

const OPENER: Record<string, string> = {
  claude: '好的，我先看了一下相关上下文。',
  codex: '直接上结果。',
  gemini: '我检查了相关内容，结论如下。'
}

const brief = (t: string, n = 24) => (t.length > n ? t.slice(0, n) + '…' : t) || '这个任务'

/** Mock images are referenced as `mock-image://<seed>` and drawn as SVG by the renderer. */
export function mockImageUrl(src: string): string | null {
  const m = /^mock-image:\/\/(\d+)/.exec(src)
  if (!m) return null
  const seed = Number(m[1])
  const h1 = (seed * 67) % 360
  const h2 = (h1 + 40) % 360
  const shapes = [
    '<circle cx="128" cy="128" r="62" fill="white" fill-opacity=".9"/><circle cx="128" cy="128" r="34" fill="url(#g)"/>',
    '<rect x="70" y="70" width="116" height="116" rx="30" fill="white" fill-opacity=".9" transform="rotate(45 128 128)"/>',
    '<path d="M128 56l20 46 50 4-38 33 12 49-44-27-44 27 12-49-38-33 50-4z" fill="white" fill-opacity=".92"/>',
    '<path d="M128 196s-64-38-64-84a36 36 0 0 1 64-22 36 36 0 0 1 64 22c0 46-64 84-64 84z" fill="white" fill-opacity=".92"/>'
  ]
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h1},85%,62%)"/><stop offset="1" stop-color="hsl(${h2},80%,48%)"/></linearGradient></defs><rect width="256" height="256" rx="48" fill="url(#g)"/>${shapes[seed % shapes.length]}</svg>`
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg)
}

export function mockReply(user: UserMessage, history: Message[]): { activity: Activity[]; markdown: string } {
  const kind = user.to.kind
  const text = user.text
  const images = user.attachments.filter((a) => a.isImage)
  const files = user.attachments.filter((a) => !a.isImage)
  const readAttach: Activity[] = user.attachments.map((a) => ({ type: 'read', target: a.path ?? a.name }))
  const opener = OPENER[kind]
  const turn = history.filter((m) => m.role === 'assistant').length + 1

  // ---- handoff: review another model's answer
  if (user.handoff) {
    const h = user.handoff
    return {
      activity: [...readAttach, { type: 'read', target: `${h.from.name} 的回复` }],
      markdown: `${opener}我读了 **${h.from.name}** 上一轮的回复，针对你的问题「${brief(text)}」补充如下：

> ${plainExcerpt(h.excerpt).slice(0, 120)}…

### 同意的部分
- 整体思路没问题，拆分方式清晰
- 关键路径上的文件定位准确

### 建议调整
1. 边界情况没有覆盖：空输入、超长输入需要单独处理
2. 错误信息建议统一走一个出口，便于日志检索
3. 可以把重复逻辑抽成一个小函数：

\`\`\`ts
export function safeParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}
\`\`\`

需要的话我可以直接按这些建议改一版。`
    }
  }

  // ---- image generation
  if (/图|画|image|素材|logo|icon|图标|插画|海报|头像/i.test(text) || images.length) {
    const seeds = [turn * 3, turn * 3 + 1, turn * 3 + 2]
    return {
      activity: [
        ...readAttach,
        ...seeds.map((s, i) => ({ type: 'write' as const, target: `assets/generated/candidate-${turn}-${i + 1}.png` })),
        ...(seeds.length ? [{ type: 'run' as const, target: 'optimize-png assets/generated/*.png' }] : [])
      ],
      markdown: `${opener}${images.length ? `参考了你给的 ${images.map((a) => `\`${a.name}\``).join('、')}，` : ''}按「${brief(text)}」生成了 3 张候选：

![候选 1](mock-image://${seeds[0]}) ![候选 2](mock-image://${seeds[1]}) ![候选 3](mock-image://${seeds[2]})

| 文件 | 尺寸 | 说明 |
| --- | --- | --- |
| \`candidate-${turn}-1.png\` | 512 × 512 | 圆形主体，对比度最高 |
| \`candidate-${turn}-2.png\` | 512 × 512 | 菱形主体，适合小尺寸 |
| \`candidate-${turn}-3.png\` | 512 × 512 | 星形主体，辨识度强 |

都已保存到 \`assets/generated/\`，背景透明。想要统一风格的话，可以告诉我选哪一张作为基准继续出图。`
    }
  }

  // ---- code task
  if (/代码|函数|bug|修复|测试|test|实现|重构|脚本|script|报错|接口/i.test(text) || files.length) {
    return {
      activity: [
        ...readAttach,
        { type: 'search', target: 'parseConfig' },
        { type: 'read', target: 'src/config/loader.ts' },
        { type: 'read', target: 'src/config/loader.test.ts' },
        { type: 'run', target: 'pnpm test --filter config' },
        { type: 'write', target: 'src/config/loader.ts' }
      ],
      markdown: `${opener}问题出在 \`loadConfig\` 读取失败时直接抛出，调用方没有兜底，导致「${brief(text)}」里提到的异常。

**改动**（\`src/config/loader.ts\`）：

\`\`\`ts
import { readFile } from 'node:fs/promises'

export interface Config {
  name: string
  retries: number
}

const DEFAULTS: Config = { name: 'app', retries: 3 }

export async function loadConfig(path: string): Promise<Config> {
  try {
    const raw = await readFile(path, 'utf8')
    return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch (err) {
    console.warn(\`[config] fallback to defaults: \${(err as Error).message}\`)
    return DEFAULTS
  }
}
\`\`\`

**验证**：

\`\`\`bash
pnpm test --filter config
# ✓ loads valid file (4 ms)
# ✓ falls back to defaults on missing file (2 ms)
# ✓ falls back to defaults on invalid JSON (1 ms)
\`\`\`

- [x] 补充了 2 个失败场景的测试
- [x] 现有用例全部通过
- [ ] 建议后续给 \`retries\` 加上范围校验`
    }
  }

  // ---- general
  return {
    activity: [...readAttach, { type: 'read', target: 'package.json' }, { type: 'read', target: 'README.md' }, { type: 'search', target: 'TODO' }],
    markdown: `${opener}关于「${brief(text)}」，我的建议分三步：

## 1. 先摸清现状
- 列出入口文件和主要模块，确认依赖关系
- 用 \`git log --oneline -20\` 看最近的改动方向

## 2. 拆分任务
| 优先级 | 任务 | 预估 |
| --- | --- | --- |
| 高 | 梳理目录结构与模块职责 | 0.5 天 |
| 中 | 补齐缺失的文档与示例 | 1 天 |
| 低 | 清理过期的 TODO | 0.5 天 |

## 3. 逐项落地
每完成一项就提交一次，方便回滚：

\`\`\`bash
git checkout -b chore/cleanup
git commit -am "docs: describe module layout"
\`\`\`

> 如果想让另一个模型复核这份计划，可以点下方的「转交给其他模型…」。`
  }
}
