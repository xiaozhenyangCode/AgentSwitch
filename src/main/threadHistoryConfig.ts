import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptEntry } from '@shared/transcript'
import type { ProfileKind } from '@shared/types'
import { THREAD_HISTORY_FORMAT, threadTools } from './threadHistoryTools'

export interface ThreadHistoryConfig {
  command: string
  args: string[]
  env: { ELECTRON_RUN_AS_NODE: '1' }
}

function historyConfig(path: string, threadId: string, refresh = false): ThreadHistoryConfig {
  return {
    command: process.execPath,
    args: [join(__dirname, 'threadHistoryServer.js'), path, threadId, ...(refresh ? ['--refresh'] : [])],
    env: { ELECTRON_RUN_AS_NODE: '1' }
  }
}

export function createThreadHistory(threadId: string, messages: TranscriptEntry[]) {
  const dir = mkdtempSync(join(tmpdir(), 'agentswitch-history-'))
  const dispose = () => rmSync(dir, { recursive: true, force: true })
  const path = join(dir, 'history.json')
  try {
    // Use the exact history behind the prompt, including any merged CLI messages and unsaved UI edits.
    writeFileSync(path, JSON.stringify({ format: THREAD_HISTORY_FORMAT, id: threadId, messages }), { flag: 'wx', mode: 0o600 })
  } catch (error) {
    dispose()
    throw error
  }
  return { config: historyConfig(path, threadId), dispose }
}

let persistentRoot: string | undefined
const pathKey = (id: string): string => createHash('sha256').update(id, 'utf16le').digest('hex')

/** A native ACP session keeps its MCP arguments across turns and process restarts. */
export function upsertPersistentThreadHistory(accountId: string, threadId: string, messages: TranscriptEntry[]): ThreadHistoryConfig {
  persistentRoot ??= mkdtempSync(join(tmpdir(), 'agentswitch-acp-history-'))
  const dir = join(persistentRoot, pathKey(threadId), pathKey(accountId))
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, 'history.json')
  const temp = join(dir, `history-${randomUUID()}.tmp`)
  try {
    writeFileSync(temp, JSON.stringify({ format: THREAD_HISTORY_FORMAT, id: threadId, messages }), { flag: 'wx', mode: 0o600 })
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
  return historyConfig(path, threadId, true)
}

export function removePersistentThreadHistory(threadId: string): void {
  if (persistentRoot) rmSync(join(persistentRoot, pathKey(threadId)), { recursive: true, force: true })
}

export function cleanupAllPersistentThreadHistory(): void {
  if (!persistentRoot) return
  rmSync(persistentRoot, { recursive: true, force: true })
  persistentRoot = undefined
}

export function threadHistoryArgs(kind: ProfileKind, config?: ThreadHistoryConfig, bypassPermissions = false): string[] {
  if (!config) return []
  if (kind === 'claude') {
    const allowed = threadTools.map(({ name }) => `mcp__agentswitch__${name}`)
    return [
      '--mcp-config', JSON.stringify({ mcpServers: { agentswitch: config } }),
      ...(bypassPermissions ? [] : ['--allowedTools', allowed.join(',')])
    ]
  }
  if (kind === 'codex') {
    const key = 'mcp_servers.agentswitch'
    return [
      '-c', `${key}.command=${JSON.stringify(config.command)}`,
      '-c', `${key}.args=${JSON.stringify(config.args)}`,
      '-c', `${key}.env.ELECTRON_RUN_AS_NODE="1"`,
      '-c', `${key}.enabled=true`
    ]
  }
  return []
}
