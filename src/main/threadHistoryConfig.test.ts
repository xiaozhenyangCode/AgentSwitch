import { existsSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { parse } from 'smol-toml'
import { describe, expect, it, vi } from 'vitest'
import type { ProfileKind } from '@shared/types'
import { agyTool, claudeAdapter, codexAdapter, type RunSpec } from './agentRunner'
import { t } from './i18n'
import { cleanupAllPersistentThreadHistory, removePersistentThreadHistory, threadHistoryArgs, upsertPersistentThreadHistory, type ThreadHistoryConfig } from './threadHistoryConfig'
import { loadThreadHistory } from './threadHistoryTools'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/fixture-user-data' }, safeStorage: {} }))

const spec: RunSpec = {
  cfg: {
    id: 'account-fixture', kind: 'claude', name: 'Test account', configDir: '/tmp/agentswitch-mcp-fixture', imported: false,
    runCommand: '', loginCommand: '', extraEnv: {}, defaultModel: '', autoApprove: 'edits', createdAt: 1
  },
  cwd: '/tmp/agentswitch-mcp-fixture', outDir: '/tmp/agentswitch-mcp-fixture', prompt: 'Current user message',
  model: null, system: null, images: [], resume: null
}
const config: ThreadHistoryConfig = {
  command: '/Applications/AgentSwitch App/Contents/MacOS/AgentSwitch',
  args: ['/Applications/AgentSwitch App/Contents/Resources/threadHistoryServer.js', '/tmp/chat with spaces.json', 'thread-id'],
  env: { ELECTRON_RUN_AS_NODE: '1' }
}

describe('thread history launch arguments', () => {
  it('does not add a server to the Claude or Codex adapters without an omitted history', () => {
    const claude = claudeAdapter(spec)
    const codex = codexAdapter(spec, spec.cwd, 0)
    expect(claude.args).not.toContain('--mcp-config')
    expect(claude.args).not.toContain('--allowedTools')
    expect(codex.args.some((arg) => arg.startsWith('mcp_servers.'))).toBe(false)
  })

  it('adds Claude configuration alongside the user’s normal servers and allows the two history tools', () => {
    for (const mode of ['edits', 'cli', 'full'] as const) {
      const args = claudeAdapter({ ...spec, cfg: { ...spec.cfg, autoApprove: mode }, threadHistory: config }).args
      expect(JSON.parse(args[args.indexOf('--mcp-config') + 1])).toEqual({ mcpServers: { agentswitch: config } })
      expect(args).not.toContain('--strict-mcp-config')
      const allowed = args.indexOf('--allowedTools')
      if (mode === 'full') expect(allowed).toBe(-1)
      else expect(args[allowed + 1].split(',')).toEqual(['mcp__agentswitch__read_thread', 'mcp__agentswitch__search_thread'])
    }
  })

  it('passes valid Codex CLI overrides for both new and resumed runs', () => {
    for (const resume of [null, 'session-1']) {
      const args = codexAdapter({ ...spec, resume, threadHistory: config }, spec.cwd, 0).args
      const overrides = args.filter((arg, index) => args[index - 1] === '-c' && arg.startsWith('mcp_servers.'))
      expect(parse(overrides.join('\n'))).toEqual({ mcp_servers: { agentswitch: { ...config, enabled: true } } })
    }
  })

  it.each<ProfileKind>(['gemini', 'reasonix'])('leaves %s configuration alone', (kind) => {
    expect(threadHistoryArgs(kind, config)).toEqual([])
  })
})

it('keeps private snapshot paths stable by account and thread and removes just the requested scope', () => {
  const messages = [{ id: 'm1', turnId: 'turn', profileId: null, speaker: '用户', time: 1, text: 'First' }]
  try {
    const { args } = upsertPersistentThreadHistory('account/a', 'thread/a', messages)
    const [, first] = args
    const [, accountPeer] = upsertPersistentThreadHistory('accounta', 'thread/a', []).args
    const [, threadPeer] = upsertPersistentThreadHistory('account/a', 'threada', []).args
    const root = dirname(dirname(dirname(first)))
    expect(new Set([first, accountPeer, threadPeer]).size).toBe(3)
    expect(statSync(root).mode & 0o777).toBe(0o700)
    expect(statSync(first).mode & 0o777).toBe(0o600)
    expect(args.slice(2)).toEqual(['thread/a', '--refresh'])
    const more = [...messages, { ...messages[0], id: 'm2', text: 'Second' }]
    expect(upsertPersistentThreadHistory('account/a', 'thread/a', more).args).toEqual(args)
    expect(loadThreadHistory(first, 'thread/a')).toEqual(more)
    expect(loadThreadHistory(accountPeer, 'thread/a')).toEqual([])
    expect(loadThreadHistory(threadPeer, 'threada')).toEqual([])

    removePersistentThreadHistory('thread/a')
    expect(existsSync(first)).toBe(false)
    expect(existsSync(accountPeer)).toBe(false)
    expect(existsSync(threadPeer)).toBe(true)
    cleanupAllPersistentThreadHistory()
    expect(existsSync(root)).toBe(false)
  } finally {
    cleanupAllPersistentThreadHistory()
  }
})

it.each(['read_thread', 'agentswitch__search_thread', 'mcp_agentswitch_read_thread'])('labels agy history activity %s', (name) => {
  expect(agyTool({ tool_name: name })).toMatchObject({ type: 'tool', target: t('main.threadHistory') })
  expect(agyTool({ tool_name: 'other__read_thread' })).not.toMatchObject({ target: t('main.threadHistory') })
})
