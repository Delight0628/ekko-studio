// Synthetic, local-only stdio MCP server. No filesystem writes, network, or credentials.
import { createInterface } from 'node:readline'
let sequence = 0
const pending = new Map()
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const tools = ['form', 'url', 'unsupported'].map(mode => ({
  name: `acceptance_${mode}`,
  description: `PR3506 synthetic ${mode} interaction test. Call once; no secrets or real OAuth.`,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}))
createInterface({ input: process.stdin }).on('line', line => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.method === 'initialize') {
    send({ id: message.id, result: { protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: 'acceptance3506', version: '1.0.0' } } })
  } else if (message.method === 'tools/list') {
    send({ id: message.id, result: { tools } })
  } else if (message.method === 'ping') {
    send({ id: message.id, result: {} })
  } else if (message.method === 'tools/call') {
    const name = message.params?.name
    if (!tools.some(tool => tool.name === name)) {
      send({ id: message.id, error: { code: -32602, message: 'Unknown synthetic tool' } }); return
    }
    const id = `synthetic-${++sequence}`
    pending.set(id, message.id)
    const params = name === 'acceptance_url'
      ? { mode: 'url', message: 'Synthetic consent only. Deny this request; do not open the URL.',
          url: 'https://example.invalid/pr3506', elicitationId: id }
      : { mode: 'form', message: 'Synthetic form: submit label WIN11_OK and count 7. Never enter secrets.',
          requestedSchema: { type: 'object', properties: {
            label: { type: 'string' }, count: { type: 'integer' },
            ...(name === 'acceptance_unsupported' ? { nested: { type: 'object', properties: {} } } : {}),
          }, required: ['label', 'count'], additionalProperties: false } }
    send({ id, method: 'elicitation/create', params })
  } else if (pending.has(message.id)) {
    const id = pending.get(message.id)
    pending.delete(message.id)
    send({ id, result: { content: [{ type: 'text', text: JSON.stringify(message.result || message.error) }] } })
  } else if (message.id != null && message.method && !message.method.startsWith('notifications/')) {
    send({ id: message.id, error: { code: -32601, message: 'Unsupported fixture method' } })
  }
})
