import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { clipLogLine, JsonRpc, JsonRpcError, type RpcRequestHandler } from './jsonrpc'

function pair(handler?: RpcRequestHandler) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const log = vi.fn()
  const notify = vi.fn()
  const client = new JsonRpc(stdin, stdout, log, handler, notify)
  const sent: unknown[] = []
  stdin.on('data', (chunk: Buffer) => sent.push(JSON.parse(chunk.toString())))
  const send = (message: object) => stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
  return { client, send, sent, stdout, log, notify }
}

describe('NDJSON JSON-RPC', () => {
  it('joins half-lines, logs plain stdout, and matches responses by id', async () => {
    const { client, send, sent, stdout, log, notify } = pair()
    const first = client.request('first', {}, 1000)
    const second = client.request('second', { key: 'value' }, 1000)
    client.notify('client/notice', { x: 1 })
    expect(sent).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'first', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'second', params: { key: 'value' } },
      { jsonrpc: '2.0', method: 'client/notice', params: { x: 1 } }
    ])
    stdout.write('plain stdout\n{"jsonrpc":"2.0","method":"sess')
    expect(notify).not.toHaveBeenCalled()
    stdout.write('ion/update","params":{"id":"s"}}\n{"jsonrpc":"2.0","id":2')
    stdout.write(',"result":22}\n')
    send({ id: 1, result: 11 })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('plain stdout'))
    expect(notify).toHaveBeenCalledWith('session/update', { id: 's' })
    await expect(second).resolves.toBe(22)
    await expect(first).resolves.toBe(11)
  })

  it('rejects with the error payload and ignores a response that arrives after timeout', async () => {
    const { client, send } = pair()
    const error = client.request('error', {}, 1000)
    send({ id: 1, error: { code: -32000, message: 'rejected', data: { detail: true } } })
    await expect(error).rejects.toMatchObject({ code: -32000, message: 'rejected', data: { detail: true } })
    await expect(client.request('slow', {}, 1)).rejects.toThrow('slow timed out')
    const next = client.request('next', {}, 1000)
    send({ id: 2, result: 'old' })
    send({ id: 3, result: 'new' })
    await expect(next).resolves.toBe('new')
  })

  it('responds to asynchronous agent requests and reports unknown methods', async () => {
    const { send, sent } = pair(async (method, params) => {
      await Promise.resolve()
      if (method === 'session/request_permission') return params
      throw new JsonRpcError(-32601, 'Method not found')
    })
    send({ id: 'a', method: 'session/request_permission', params: { outcome: 'allowed' } })
    send({ id: 'b', method: 'unknown' })
    await vi.waitFor(() => expect(sent).toEqual([
      { jsonrpc: '2.0', id: 'a', result: { outcome: 'allowed' } },
      { jsonrpc: '2.0', id: 'b', error: { code: -32601, message: 'Method not found' } }
    ]))
    const noHandler = pair()
    noHandler.send({ id: 7, method: 'unknown' })
    expect(noHandler.sent).toEqual([{ jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'Method not found' } }])
  })

  it('rejects every pending and subsequent request with the same close reason', async () => {
    const { client } = pair()
    const cause = new Error('process exited')
    const pending = [client.request('one', {}, 1000), client.request('two', {})]
    client.close(cause)
    for (const promise of [...pending, client.request('three', {})]) await expect(promise).rejects.toBe(cause)
  })
})

describe('protocol log lines', () => {
  it('keeps short lines and clips long ones without leaving a partial token at the cut', () => {
    expect(clipLogLine('{"a":1}')).toBe('{"a":1}')
    const line = `{"data":"${'A'.repeat(7_000_000)}","tail":"ok"}`
    const out = clipLogLine(line)
    expect(out.length).toBeLessThan(8 * 1024)
    expect(out).toContain('chars omitted')
    expect(out).not.toMatch(/A{20}/)
    expect(out.endsWith('"tail":"ok"}')).toBe(true)
  })
})
