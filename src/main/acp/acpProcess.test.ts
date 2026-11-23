import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { startAcpProcess } from './acpProcess'

describe('ACP process', () => {
  it('negotiates capabilities and includes sanitized stderr when an active request loses its process', async () => {
    const script = `
      const { createInterface } = require('node:readline')
      createInterface({ input: process.stdin }).on('line', raw => {
        const { id, method, params } = JSON.parse(raw)
        if (method === 'initialize') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', id, result: {
              protocolVersion: params.protocolVersion,
              agentInfo: { version: 'test-agent' },
              agentCapabilities: params.clientCapabilities
            }
          }) + '\\n')
        } else {
          process.stderr.write('final diagnostic: Bearer test-credential', () => process.exit(7))
        }
      })
    `
    const onLog = vi.fn()
    const child = await startAcpProcess({
      bin: process.execPath, args: ['-e', script], cwd: tmpdir(), version: '0.1.1',
      env: { HOME: '/isolated-home' }, onLog
    })
    try {
      expect(child.initializeResult.agentCapabilities).toEqual({
        fs: { readTextFile: false, writeTextFile: false }, terminal: false
      })
      const pending = child.rpc.request('session/prompt', {})
      await expect(pending).rejects.toThrow(/code 7[\s\S]+final diagnostic: Bearer \[redacted\]/)
      await expect(child.exited).resolves.toContain('Bearer [redacted]')
      expect(child.alive).toBe(false)
      expect(onLog.mock.calls.flat().join('')).not.toContain('test-credential')
    } finally {
      child.terminate()
    }
  })
})
