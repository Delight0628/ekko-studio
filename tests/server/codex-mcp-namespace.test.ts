import { describe, expect, it } from 'vitest'
import { responseToolNamespaces, responsesToOpenAiChat, openAiChatToResponses, anthropicMessageToResponses } from '../../packages/server/src/modules/coding-agents/protocol/adapters/responses'
import { openAiChatSseToResponsesEvents, anthropicMessagesSseToResponsesEvents } from '../../packages/server/src/modules/coding-agents/protocol/adapters/responses-stream'
const ns=(name:string,tool='acceptance_form')=>({type:'namespace',name,tools:[{type:'function',name:tool,parameters:{type:'object',properties:{}}}]})
const body={tools:[ns('mcp__acceptance3506')]}
const target={model:'test',toolNamespaces:responseToolNamespaces(body),annotateMcpToolNamespaces:true}
async function* bytes(frames:object[]){yield new TextEncoder().encode(frames.map(f=>'data: '+JSON.stringify(f)+'\n\n').join(''))}
describe('request-scoped external MCP namespaces',()=>{
 it('recovers tools from current, additional and deferred search definitions without global leakage',()=>{
  expect(target.toolNamespaces.get('acceptance_form')).toBe('mcp__acceptance3506')
  expect(responseToolNamespaces({additional_tools:[ns('mcp__other')]}).get('acceptance_form')).toBe('mcp__other')
  expect(responseToolNamespaces({input:[{type:'tool_search_output',tools:[ns('mcp__deferred')]}]}).get('acceptance_form')).toBe('mcp__deferred')
  expect(responseToolNamespaces({}).size).toBe(0)
 })
 it('does not choose a server for ambiguous names or collide with root tools',()=>{
  expect(responseToolNamespaces({tools:[ns('mcp__a'),ns('mcp__b')]}).has('acceptance_form')).toBe(false)
  expect(responseToolNamespaces({tools:[ns('mcp__a'),{type:'function',name:'acceptance_form'}]}).has('acceptance_form')).toBe(false)
 })
 it('preserves Chat and Anthropic nonstream call namespace',()=>{
  expect(responsesToOpenAiChat(body,target).tools[0].function.name).toBe('acceptance_form')
  const chat=openAiChatToResponses({choices:[{message:{tool_calls:[{id:'call',function:{name:'acceptance_form',arguments:'{}'}}]}}]},target)
  const anth=anthropicMessageToResponses({content:[{type:'tool_use',id:'call',name:'acceptance_form',input:{}}]},target)
  for(const response of [chat,anth])expect(response.output[0]).toMatchObject({name:'acceptance_form',namespace:'mcp__acceptance3506',arguments:'{}'})
 })
 it('annotates added, done and terminal Chat stream items consistently',async()=>{
  const events=[];for await(const e of openAiChatSseToResponsesEvents(bytes([{choices:[{delta:{tool_calls:[{index:0,id:'call',function:{name:'acceptance_form',arguments:'{'}}]}}]},{choices:[{delta:{tool_calls:[{index:0,function:{arguments:'}'}}]},finish_reason:'tool_calls'}]}]),target))events.push(e)
  const items=events.filter(e=>e.data.item?.type==='function_call').map(e=>e.data.item)
  items.push(...(events.find(e=>e.type==='response.completed')!.data.response as any).output)
  expect(items.length).toBeGreaterThanOrEqual(3)
  for(const item of items)expect(item).toMatchObject({name:'acceptance_form',namespace:'mcp__acceptance3506'})
 })
 it('annotates Anthropic tool_use stream items',async()=>{
  const events=[];for await(const e of anthropicMessagesSseToResponsesEvents(bytes([{type:'message_start',message:{id:'msg',usage:{input_tokens:1}}},{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'call',name:'acceptance_form',input:{}}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{}'}},{type:'content_block_stop',index:0},{type:'message_stop'}]),target))events.push(e)
  const items=events.filter(e=>e.data.item?.type==='function_call').map(e=>e.data.item)
  expect(items.length).toBeGreaterThan(0)
  for(const item of items)expect(item).toMatchObject({namespace:'mcp__acceptance3506'})
 })
})
