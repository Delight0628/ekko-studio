const readline = require('node:readline')
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6XcAAAAASUVORK5CYII='
let capture = 0
const tools = ['list_apps', 'list_windows', 'get_window_state', 'get_desktop_state', 'click', 'type_text', 'check_permissions', 'set_config', 'kill_app']
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', line => {
  if (!line.trim()) return
  const message = JSON.parse(line)
  if (message.id === undefined) return
  const send = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n')
  if (message.method === 'initialize') return send({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-cua', version: '0.26.1' } })
  if (message.method === 'tools/list') {
    const names = message.params?.cursor ? tools.slice(4) : tools.slice(0, 4)
    return send({ tools: names.map(name => ({ name, description: `Fixture ${name}`, inputSchema: {
      type: 'object', properties: { pid: { type: 'integer' }, session: { type: 'string' }, delivery_mode: { type: 'string' } },
    } })), ...(!message.params?.cursor ? { nextCursor: 'page2' } : {}) })
  }
  if (message.method !== 'tools/call') return send({})
  const { name, arguments: args } = message.params
  if (args.text === '__hang__') return
  const value = { name, args, pid: process.pid, capture }
  if (name === 'check_permissions') Object.assign(value, { accessibility: true, screen_recording: true })
  if (name === 'get_window_state' || name === 'get_desktop_state') {
    capture++
    Object.assign(value, { capture, snapshot_id: `s${String(capture).padStart(8, '0')}`, elements: [{ element_token: `s${String(capture).padStart(8, '0')}:1`, role: 'button', label: 'Fixture' }] })
    return send({ content: [{ type: 'text', text: JSON.stringify(value) }, ...(args.include_screenshot === false ? [] : [{ type: 'image', mimeType: 'image/png', data: png }])], structuredContent: value })
  }
  if (name === 'click' && args.element_token !== `s${String(capture).padStart(8, '0')}:1`) return send({ isError: true, content: [{ type: 'text', text: 'stale snapshot; capture again' }], structuredContent: { ok: false } })
  return send({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value })
})
rl.on('close', () => process.exit(0))
