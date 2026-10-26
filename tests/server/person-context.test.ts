import { describe, expect, it, vi } from 'vitest'
import { personBudgetedClient } from '../../packages/server/src/bootstrap/person-model-context'
import type { PersonModelCall } from '../../packages/server/src/modules/studio/public/person-runtime'
import type { ModelClient, ModelRequest } from '../../packages/ekko-agent/src/model/types'
const input = (): PersonModelCall => ({ selection: { runtime:'ekko',mode:'scoped',profile:'default',provider:'test',model:'model' }, messages:[],tools:[],systemPrompt:'Person',contextTokens:8000,maxSteps:8,signal:new AbortController().signal })
function client() {
  const sent: ModelRequest[] = []
  return { sent, port: { provider:'test',requestStyle:'chat_completions',capabilities:{maxInputTokens:8000,streaming:true,tools:true,vision:false},
    create:vi.fn(async (request: ModelRequest) => { sent.push(request); return {content:'Summary of established user goal; no authorization added'} }),
    stream: async function*(request: ModelRequest) { sent.push(request); yield {type:'done',response:{content:'done'}} },
  } as unknown as ModelClient }
}
describe('Person provider request budget', () => {
  it('checks every request, strips native continuation, and checks tools as well as messages', async () => {
    const c = client(); const call=input(); call.beforeRequest=vi.fn()
    const wrapped=personBudgetedClient(c.port,call)
    await wrapped.create({messages:[{role:'user',content:'hello'}],context:{native:'unbounded'} as any})
    for await (const _ of wrapped.stream({messages:[{role:'user',content:'next'}],context:{native:'again'} as any})) { /* consume */ }
    expect(c.sent).toHaveLength(2);expect(c.sent.every(r=>r.context===undefined)).toBe(true);expect(call.beforeRequest).toHaveBeenCalledTimes(2)
    await expect(wrapped.create({messages:[{role:'user',content:'hello'}],tools:[{name:'large',description:'many different tokens '.repeat(10000)}]})).rejects.toThrow('budget')
    expect(c.sent).toHaveLength(2)
  })
  it('compresses older history while preserving complete tool-call/result pairs', async () => {
    const c=client(); const wrapped=personBudgetedClient(c.port,input())
    const messages: ModelRequest['messages']=[{role:'system',content:'Person role'}]
    for(let i=0;i<20;i++) messages.push({role:'user',content:'prior user requirement detail '.repeat(70)},{role:'assistant',content:'prior assistant result evidence '.repeat(70)})
    messages.push({role:'user',content:'Current request'},{role:'assistant',content:'',toolCalls:[{id:'t1',name:'lookup',arguments:'{}'}]},{role:'tool',content:'bounded result',toolCallId:'t1'})
    await wrapped.create({messages})
    const last=c.sent.at(-1)!
    expect(c.sent.length).toBeGreaterThan(1)
    expect(last.messages.slice(-3)).toEqual(messages.slice(-3))
    expect(last.messages[0]).toEqual(messages[0])
    expect(last.messages.length).toBeLessThan(messages.length)
  })
  it('fails closed on cancellation and never sends an oversized current tool result', async () => {
    const c=client();const call=input();const abort=new AbortController();call.signal=abort.signal
    abort.abort(new Error('revoked'));await expect(personBudgetedClient(c.port,call).create({messages:[{role:'user',content:'hello'}]})).rejects.toThrow('revoked')
    expect(c.sent).toEqual([])
    await expect(personBudgetedClient(c.port,input()).create({messages:[{role:'user',content:'latest '.repeat(20000)}]})).rejects.toThrow('budget')
    expect(c.sent).toEqual([])
  })
})
