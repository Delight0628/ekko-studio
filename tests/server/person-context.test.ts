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
  function longTurn(): ModelRequest {
    const messages: ModelRequest['messages']=[{role:'system',content:'Person instructions'},{role:'user',content:'Do not send anything; investigate only.'}]
    for(let i=0;i<12;i++) messages.push({role:'assistant',content:'',toolCalls:[{id:`t${i}`,name:'lookup',arguments:{}}]},
      {role:'tool',toolCallId:`t${i}`,content:`result ${i}: `+'evidence constraint detail '.repeat(250)})
    return {messages,tools:[{name:'lookup',parameters:{type:'object'}}],maxTokens:2048}
  }
  it('reuses persisted checkpoints across wrappers without compressing on small turns', async () => {
    const cache=new Map<string,string>(); const call={...input(),summaryCache:{get:(k:string)=>cache.get(k),set:(k:string,s:string)=>{cache.set(k,s)}}}
    const first=client(); await personBudgetedClient(first.port,call).create(longTurn())
    expect(cache.size).toBeGreaterThan(0)
    const second=client(); await personBudgetedClient(second.port,call).create(longTurn())
    expect(second.sent).toHaveLength(1)
    expect(second.sent[0].messages).toEqual(first.sent.at(-1)!.messages)
    expect(second.sent[0].messages).toContainEqual(longTurn().messages[1])
    expect(second.sent[0].messages.slice(-2)).toEqual(longTurn().messages.slice(-2))
    const small=client(); await personBudgetedClient(small.port,call).create({messages:[{role:'user',content:'hello'}]})
    expect(small.sent).toHaveLength(1)
  })
  it('invalidates checkpoint keys when source content or selected model changes', async () => {
    const cache=new Map<string,string>(); const call={...input(),summaryCache:{get:(k:string)=>cache.get(k),set:(k:string,s:string)=>{cache.set(k,s)}}}
    await personBudgetedClient(client().port,call).create(longTurn())
    const changed=longTurn(); changed.messages[3].content+=' Revoked permission.'
    const c=client(); await personBudgetedClient(c.port,call).create(changed)
    expect(c.sent.length).toBeGreaterThan(1)
    const other=client(); await personBudgetedClient(other.port,{...call,selection:{...call.selection,model:'other'}}).create(longTurn())
    expect(other.sent.length).toBeGreaterThan(1)
  })
  it('does not cache late summaries after cancellation', async () => {
    const c=client(), abort=new AbortController(), set=vi.fn()
    c.port.create=vi.fn(async()=>{abort.abort(new Error('cancelled'));return {content:'late summary'}})
    await expect(personBudgetedClient(c.port,{...input(),signal:abort.signal,summaryCache:{get:()=>undefined,set}}).create(longTurn())).rejects.toThrow('cancelled')
    expect(set).not.toHaveBeenCalled()
  })
  it('rejects an oversized newest tool batch without silently losing the current request', async () => {
    const c=client(), request=longTurn()
    request.messages.at(-1)!.content='huge current evidence '.repeat(20000)
    await expect(personBudgetedClient(c.port,input()).create(request)).rejects.toThrow('budget')
    expect(c.sent.every(r=>r.messages[0].content.startsWith('Summarize task context'))).toBe(true)
  })
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
