import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptEntry } from '@shared/transcript'
import type { ProfileKind } from '@shared/types'
import { getProviderCapabilities } from '@shared/providerCapabilities'
import { THREAD_HISTORY_FORMAT, threadTools } from './threadHistoryTools'

export interface ThreadHistoryConfig {
  command: string
  args: string[]
  env: { ELECTRON_RUN_AS_NODE: '1' }
}

export const supportsThreadHistory = (kind: ProfileKind): boolean => getProviderCapabilities(kind).supportsMcpTempInjection

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
  const config: ThreadHistoryConfig = {
    command: process.execPath,
    args: [join(__dirname, 'threadHistoryServer.js'), path, threadId],
    env: { ELECTRON_RUN_AS_NODE: '1' }
  }
  return { config, dispose }
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
