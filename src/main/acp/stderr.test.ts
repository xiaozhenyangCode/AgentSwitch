import { userInfo } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { sanitize, StderrTail } from './stderr'

describe('ACP log redaction', () => {
  it('redacts both HOMEs, auth headers, login URLs, and token formats', () => {
    const realHome = userInfo().homedir
    const home = realHome + '/isolated'
    const raw = [
      home + '/a\0', realHome + '/b', 'https://accounts.google.com/login?secret=y',
      'Bearer opaque-access-token', 'Authorization: Basic dGVzdA==', 'x-api-key: opaque-api-key',
      'sk-12345678', 'ghp_dontlogme', 'xoxb-dont-log-me', 'ya29.google-token', 'AIzaGoogleKey',
      '{"Authorization":"Basic XXXXXX","x-api-key":"opaque-other-key"}'
    ].join('\n')
    expect(sanitize(raw, home)).toBe([
      '~/a', '~/b', '[sign-in-url]', 'Bearer [redacted]', 'Authorization: Basic [redacted]', 'x-api-key: [redacted]',
      '[redacted]', '[redacted]', '[redacted]', '[redacted]', '[redacted]',
      '{"Authorization":"Basic [redacted]","x-api-key":"[redacted]"}'
    ].join('\n'))
  })

  it('redacts across chunk boundaries before logging, and retains a 4 KiB UTF-8 tail', () => {
    const log = vi.fn()
    const stderr = new StderrTail('/isolated', log)
    stderr.push(Buffer.from('Authorization: Bear'))
    stderr.push(Buffer.from('er very-secret\n'))
    expect(log).toHaveBeenCalledExactlyOnceWith('Authorization: Bearer [redacted]\n')
    stderr.push(Buffer.from('x'.repeat(40_000) + '\n' + '界'.repeat(2000) + '\nlast'))
    stderr.end()
    expect(Buffer.byteLength(stderr.tail)).toBeLessThanOrEqual(4096)
    expect(stderr.tail).not.toContain('\ufffd')
    expect(stderr.tail.endsWith('\nlast')).toBe(true)
    expect(log.mock.calls.every(([line]) => Buffer.byteLength(line) <= 32 * 1024 + 1)).toBe(true)
  })
})
