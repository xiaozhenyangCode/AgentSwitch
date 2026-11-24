import { isAbsolute } from 'node:path'
import { createInterface } from 'node:readline'
import { createThreadHistoryReader, readThreadPage, searchThread, threadTools } from './threadHistoryTools'

const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const [path, threadId, mode] = process.argv.slice(2)
if (!path || !isAbsolute(path) || !threadId) throw new Error('Expected an absolute history path and a conversation ID')

const readHistory = createThreadHistoryReader(path, threadId)
const snapshot = mode === '--refresh' ? undefined : readHistory()
const send = (message: object) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return send({ id: null, error: { code: -32700, message: 'Parse error' } })
  }
  if (request?.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return send({ id: request?.id ?? null, error: { code: -32600, message: 'Invalid request' } })
  }
  const { id, method, params } = request
  if (id === undefined) return
  const reply = (result: object) => send({ id, result })
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: versions.includes(params?.protocolVersion) ? params.protocolVersion : versions[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'agentswitch', version: '1.0.0' }
      })
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: threadTools })
    case 'tools/call': {
      try {
        const tool = params?.name
        if (tool !== 'read_thread' && tool !== 'search_thread') return send({ id, error: { code: -32602, message: 'Unknown tool' } })
        const history = snapshot ?? readHistory()
        const result = tool === 'read_thread' ? readThreadPage(history, params.arguments) : searchThread(history, params.arguments)
        return reply({ content: [{ type: 'text', text: JSON.stringify(result) }] })
      } catch (error) {
        return reply({ isError: true, content: [{ type: 'text', text: (error as Error).message }] })
      }
    }
    default:
      return send({ id, error: { code: -32601, message: 'Method not found' } })
  }
})
