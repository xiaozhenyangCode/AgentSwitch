import { TONE } from './ui'
import type { ProfileKind } from '@shared/types'

/** UI-side description of a workflow template (Phase 2 engine will consume the same shape). */
export interface WorkflowNodeDef {
  id: string
  title: string
  description: string
  /** CLI kinds allowed to execute this node, in order of preference. */
  kinds: ProfileKind[]
  inputs: string[]
  outputs: string[]
  /** Approval node: returns { status: PASS | REJECT, reason }. */
  review?: { rejectTo: string; maxRetries: number }
}

export interface WorkflowTemplate {
  id: string
  name: string
  description: string
  nodes: WorkflowNodeDef[]
}

export type NodeRunStatus = 'waiting' | 'running' | 'passed' | 'rejected'

export const NODE_STATUS_META: Record<NodeRunStatus, { label: string; cls: string; dot: string }> = {
  waiting: { label: '等待', ...TONE.gray },
  running: { label: '执行中', ...TONE.blue },
  passed: { label: '已通过', ...TONE.green },
  rejected: { label: '已打回', ...TONE.red }
}

export const TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'match3-assets',
    name: '三消素材全自动流水线',
    description: '自动为每个三消元素撰写提示词、批量生成图片素材并保存到项目，最后由另一个模型把关质量。',
    nodes: [
      {
        id: 'prompt',
        title: '生成提示词',
        description: '根据项目风格与关卡需求，批量生成每个三消元素的图像提示词',
        kinds: ['claude', 'gemini', 'codex'],
        inputs: ['.workflow/task.json'],
        outputs: ['.workflow/prompts.json']
      },
      {
        id: 'assets',
        title: '生成素材并落盘',
        description: '按提示词逐个生成图片，写入项目素材目录',
        kinds: ['codex', 'claude', 'gemini'],
        inputs: ['.workflow/prompts.json'],
        outputs: ['assets/match3/*.png']
      },
      {
        id: 'review',
        title: '视觉与规范审批',
        description: '检查尺寸、透明背景、风格一致性与命名规范，输出 PASS / REJECT',
        kinds: ['gemini', 'claude'],
        inputs: ['assets/match3/*.png'],
        outputs: ['.workflow/review.json'],
        review: { rejectTo: 'assets', maxRetries: 3 }
      }
    ]
  }
]
