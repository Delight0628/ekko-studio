import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
describe('synthetic Codex acceptance MCP server', () => {
  it.each(['form', 'url', 'unsupported'])('roundtrips %s and remains side-effect free', async mode => {
    const child = spawn(process.execPath, [resolve('tests/fixtures/codex-interaction/server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const close = once(child, 'close')
    const messages:any[] = []; let buffer = ''
    child.stdout.on('data', chunk => {
      buffer += chunk
      let end
      while ((end = buffer.indexOf('\n')) >= 0) {
        messages.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1)
      }
    })
    const send = (message:object) => child.stdin.write(JSON.stringify({ jsonrpc:'2.0', ...message })+'\n')
    try {
      send({id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}})
      await expect.poll(()=>messages.find(m=>m.id===1)?.result?.serverInfo?.name).toBe('acceptance3506')
      send({id:2,method:'tools/call',params:{name:`acceptance_${mode}`,arguments:{}}})
      await expect.poll(()=>messages.find(m=>m.method==='elicitation/create')).toBeDefined()
      const request = messages.find(m=>m.method==='elicitation/create')
      expect(request.params.mode).toBe(mode==='url'?'url':'form')
      const result=mode==='form'?{action:'accept',content:{label:'WIN11_OK',count:7}}:{action:'cancel'}
      send({id:request.id,result})
      await expect.poll(()=>messages.find(m=>m.id===2)?.result?.content?.[0]?.text).toBe(JSON.stringify(result))
    } finally { child.stdin.end(); await close }
  })
})
