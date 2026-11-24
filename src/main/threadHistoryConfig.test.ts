import { parse } from 'smol-toml'
import { describe, expect, it, vi } from 'vitest'
import type { ProfileKind } from '@shared/types'
import { claudeAdapter, codexAdapter, type RunSpec } from './agentRunner'
import { threadHistoryArgs, type ThreadHistoryConfig } from './threadHistoryConfig'

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
