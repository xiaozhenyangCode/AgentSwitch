import type { AssistantMessage, Message, UserMessage } from './chat'
import { attachmentRefLabel, serializePromptWithAttachments } from './fileReferences'
import { splitSpec } from './modelSpec'
import type { ProfileId, ProfileKind } from './types'

export interface TranscriptEntry {
  id: string
  turnId: string
  profileId: ProfileId | null
  speaker: string
  time: number | null
  text: string
  details?: string
  driverId?: ProfileId
  model?: string | null
  actualModel?: string | null
  contextWindow?: number
  replied?: boolean
}

export function transcriptEntry(message: UserMessage | AssistantMessage): TranscriptEntry {
  const { id, turnId } = message
  if (message.role === 'user') {
    const quoteLine = message.quote?.excerpt ? `引用（${message.quote.author}）：${message.quote.excerpt}` : ''
    const attLine = message.attachments.length ? `附件：${message.attachments.map((a) => a.name).join('、')}` : ''
    const details = [quoteLine, attLine].filter(Boolean).join('\n')
    const text = message.text.includes('#') ? serializePromptWithAttachments(message.text, message.attachments.flatMap((att) => {
      const absPath = att.path ?? att.fallbackPath
      const workspace = att.source === 'workspace-file' && !!att.relativePath
      const promptPath = workspace ? att.relativePath : absPath
      return promptPath ? [{
        name: att.name, absPath: absPath ?? promptPath, promptPath, refLabel: attachmentRefLabel(att), relativePath: att.relativePath,
        scope: workspace ? 'workspace' : 'external', isImage: att.isImage
      }] : []
    })).body : message.text
    return {
      id, turnId, profileId: null, speaker: '用户', time: message.createdAt, text,
      driverId: message.kind === 'handoff' ? undefined : message.driver.profileId,
      details: details || undefined
    }
  }
  const details = [
    message.verdict && `审核结论：${message.verdict.status} ${message.verdict.reason}`,
    message.outputs.length && `产出文件：${message.outputs.join('、')}`,
    message.error && `报错：${message.error}`
  ].filter(Boolean).join('\n')
  return {
    id, turnId, profileId: message.agent.profileId, speaker: message.agent.name, time: message.startedAt, text: message.content,
    details: details || undefined, model: message.agent.model, actualModel: message.actualModel,
    contextWindow: message.usage?.contextWindow, replied: message.status === 'done' || !!message.content.trim()
  }
}

/** Converts chat messages to model-visible transcript entries (skips UI-only system dividers). */
export function toTranscript(messages: Message[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = []
  for (const m of messages) if (m.role !== 'system') out.push(transcriptEntry(m))
  return out
}

/** Validate history received over IPC and from the per-run snapshot. */
export function isTranscriptEntry(value: unknown): value is TranscriptEntry {
  const entry = value as Partial<TranscriptEntry> | null
  return !!entry && typeof entry.id === 'string' && typeof entry.turnId === 'string' &&
    (entry.profileId === null || typeof entry.profileId === 'string') && typeof entry.speaker === 'string' &&
    (entry.time === null || Number.isFinite(entry.time)) && typeof entry.text === 'string' &&
    (entry.details === undefined || typeof entry.details === 'string') &&
    (entry.driverId === undefined || typeof entry.driverId === 'string') &&
    (entry.model == null || typeof entry.model === 'string') &&
    (entry.actualModel == null || typeof entry.actualModel === 'string') &&
    (entry.contextWindow === undefined || Number.isFinite(entry.contextWindow)) &&
    (entry.replied === undefined || typeof entry.replied === 'boolean')
}

export type NumberedEntry = TranscriptEntry & { number: number }

export const numberTranscript = (entries: TranscriptEntry[]): NumberedEntry[] =>
  entries.map((entry, index) => ({ ...entry, number: index + 1 }))

/** Resuming only needs the messages after the account's last reply. */
export function unseenTranscript<T extends Pick<TranscriptEntry, 'profileId' | 'replied'>>(entries: T[], profileId: ProfileId, resuming: boolean): T[] {
  if (!resuming) return entries
  for (let i = entries.length - 1; i >= 0; i--)
    if (entries[i].profileId === profileId && entries[i].replied !== false) return entries.slice(i + 1)
  return entries
}

export const historyModel = (spec: string | null | undefined, kind: ProfileKind): string | null =>
  splitSpec(spec, kind).model

export function reportedContextWindow(entries: TranscriptEntry[], profileId: ProfileId, model: string | null, kind: ProfileKind): number | undefined {
  const target = historyModel(model, kind)
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry.profileId === profileId && entry.contextWindow && entry.contextWindow > 0 &&
        (target === historyModel(entry.model, kind) || (target && target === historyModel(entry.actualModel, kind)))) {
      return entry.contextWindow
    }
  }
  return undefined
}
