import { describe, expect, it } from 'vitest'
import { LEGACY_BUNDLE_FORMAT, parseThreadBundle, TRANSFER_SCHEMA_VERSION } from './transfer'

describe('parseThreadBundle', () => {
  it('reads the legacy JSON format and tolerates incomplete entries', () => {
    const thread = { id: 'chat', projectDir: 'C:\\Repos\\Example', messages: [] }
    const bundle = parseThreadBundle(JSON.stringify({
      format: LEGACY_BUNDLE_FORMAT, version: 1, exportedAt: '123',
      threads: [null, { thread: { id: 'invalid' } }, { thread, driverKind: 'unknown' }]
    }))
    expect(bundle).toEqual({
      format: LEGACY_BUNDLE_FORMAT, version: 1, exportedAt: 123,
      threads: [{ thread, projectName: 'Example', sourceProjectDir: thread.projectDir, driverKind: null }]
    })
  })

  it('preserves v2 message and workspace metadata', () => {
    const thread = {
      id: 'chat', projectDir: null, sourceProjectDir: '/old/Example',
      messages: [{ role: 'assistant', outputFiles: [{ path: '/old/Example/a.svg', relativePath: 'a.svg' }] }]
    }
    const bundle = parseThreadBundle(JSON.stringify({
      format: LEGACY_BUNDLE_FORMAT, version: TRANSFER_SCHEMA_VERSION, exportedAt: 123,
      threads: [{ thread, sourceProjectDir: '/old/Example', sourceWorkdir: '/old/Example/run', driverKind: 'codex' }]
    }))
    expect(bundle.threads).toEqual([{
      thread, projectName: 'Example', sourceProjectDir: '/old/Example', sourceWorkdir: '/old/Example/run', driverKind: 'codex'
    }])
  })

  it('rejects unsupported versions and malformed bundle envelopes', () => {
    for (const raw of ['null', '{}', '{"format":"other","version":1,"threads":[]}',
      '{"format":"agentswitch-threads","version":3,"threads":[]}', '{"format":"agentswitch-threads","version":2,"threads":{}}']) {
      expect(() => parseThreadBundle(raw)).toThrow(/invalid bundle/)
    }
  })
})
