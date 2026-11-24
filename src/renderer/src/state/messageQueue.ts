import type { AgentRef, MessageInput, QueuedMessage, Thread } from '@shared/chat'

export function enqueueMessage(
  queue: QueuedMessage[] | undefined,
  id: string,
  { text, attachments, driver, mentions, participants, projectDir, handoffTo }: MessageInput & { handoffTo?: AgentRef }
): QueuedMessage[] | undefined {
  if (handoffTo) return queue
  return [...(queue ?? []), {
    id,
    text,
    attachments: attachments.map((attachment) => ({ ...attachment })),
    driver: { ...driver },
    mentions: mentions.map((mention) => ({ ...mention })),
    participants: [...participants],
    projectDir
  }]
}

export function dequeueMessage(queue: QueuedMessage[] | undefined) {
  if (!queue?.length) return null
  const [message, ...remaining] = queue
  return { message, remaining }
}

export function shouldAutoSendQueued(
  thread: Thread,
  turnId: string,
  outcome: 'done' | 'error' | 'stopped'
): boolean {
  return outcome === 'done' && thread.activeTurn === turnId && !thread.pause && !thread.queueHold &&
    !!thread.queuedMessages?.length
}
