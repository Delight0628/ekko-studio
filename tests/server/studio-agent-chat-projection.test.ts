import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { AgentExecutionStore } from '../../packages/server/src/modules/studio/repositories/agent-execution-store'
import { AgentChatProjection } from '../../packages/server/src/modules/studio/repositories/agent-chat-projection'
import { PluginEventStore } from '../../packages/server/src/modules/studio/repositories/plugin-event-store'
import type { AgentOutputEvent, AgentProviderRef } from '../../packages/studio-plugin-sdk/src'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0)) close() })
const provider: AgentProviderRef = { kind: 'plugin', pluginId: 'test.chat', version: '1.0.0', generation: 'first' }
const input = { content: [{ type: 'text' as const, text: 'hello' }] }

function setup() {
  const db = new DatabaseSync(':memory:')
  cleanup.push(() => db.close())
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, profile TEXT NOT NULL, studio_user_id TEXT, source TEXT NOT NULL,
    agent TEXT NOT NULL DEFAULT 'test.chat/agent', agent_native_session_id TEXT NOT NULL DEFAULT '',
    message_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0, last_active INTEGER DEFAULT 0, ended_at INTEGER, end_reason TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
    reasoning TEXT, tool_calls TEXT, tool_call_id TEXT, tool_name TEXT, run_marker TEXT, timestamp INTEGER, finish_reason TEXT);`)
  for (const id of ['a', 'b', 'old']) db.prepare("INSERT INTO sessions (id, profile, studio_user_id, source) VALUES (?, 'one', '7', 'coding_agent')").run(id)
  const projection = new AgentChatProjection(db), store = new AgentExecutionStore(db, projection)
  const instance = store.createInstance({ agentTypeId: 'test.chat/agent', profileId: 'one', ownerId: '7', mode: 'global', config: {} })
  projection.attach('a', instance); projection.attach('b', instance)
  const accept = (sessionId: string, key: string) => store.accept(instance, provider, input, key, undefined, { kind: 'chat', sessionId }).run
  const start = (sessionId: string, key: string) => { const run = accept(sessionId, key); store.transition(run.id, ['accepted'], 'running'); return run }
  const messages = (sessionId: string) => db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY id').all(sessionId)
  const session = (sessionId: string) => db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId)!
  return { db, store, projection, instance, accept, start, messages, session }
}

it('writes one user message and updates the same assistant rows across deltas, snapshots, reasoning and retry', () => {
  const f = setup(), run = f.start('a', 'request')
  expect(f.accept('a', 'request').id).toBe(run.id)
  expect(f.messages('a')).toMatchObject([{ role: 'user', content: 'hello', run_marker: run.id }])
  const output: AgentOutputEvent[] = [
    { type: 'reasoning.delta', producerSequence: 0, messageId: 'm', text: 'Think ' },
    { type: 'message.delta', producerSequence: 1, messageId: 'm', text: 'hel' },
    { type: 'message.delta', producerSequence: 2, messageId: 'm', text: 'lo' },
    { type: 'reasoning.delta', producerSequence: 3, messageId: 'm', text: 'carefully' },
    { type: 'message.snapshot', producerSequence: 4, messageId: 'm', text: 'final text' },
  ]
  for (const event of output) f.store.appendOutput(run.id, event)
  expect(f.messages('a')).toMatchObject([{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'final text', reasoning: 'Think carefully', run_marker: run.id }])
  expect(f.session('a').message_count).toBe(2)
  expect(f.store.output(run.id)).toHaveLength(5)
  expect(() => f.store.appendOutput(run.id, output[4])).toThrow()
  expect(f.messages('a')).toHaveLength(2)
})

it('projects existing tool-call/result fields, preserves unknown usage, and finishes once without another history write', () => {
  const f = setup(), run = f.start('a', 'request')
  f.store.appendOutput(run.id, { type: 'tool.started', producerSequence: 0, callId: 'call', name: 'search', data: { query: 'fixture' } })
  f.store.appendOutput(run.id, { type: 'tool.completed', producerSequence: 1, callId: 'call', name: 'search', data: { answer: 'found' } })
  expect(f.messages('a')).toMatchObject([{ role: 'user' }, { role: 'assistant' }, { role: 'tool', tool_call_id: 'call', tool_name: 'search', content: '{"answer":"found"}' }])
  expect(JSON.parse(String(f.messages('a')[1].tool_calls))).toEqual([{ id: 'call', type: 'function', function: { name: 'search', arguments: '{"query":"fixture"}' } }])
  expect(f.session('a')).toMatchObject({ message_count: 3, tool_call_count: 1 })
  expect(f.store.state.usage(run.id)).toEqual([])
  f.store.finish(run.id, 'completed', null, { native: 'native-session' })
  expect(f.store.finish(run.id, 'completed', null)).toEqual([])
  expect(f.messages('a')).toHaveLength(3)
  expect(f.session('a')).toMatchObject({ end_reason: 'completed', ended_at: expect.any(Number) })
  expect(new PluginEventStore(f.db).read('one')).toHaveLength(1)
})

it('keeps equal native message and tool identities separate between chats and Runs', () => {
  const f = setup(), a = f.start('a', 'a1'), b = f.start('b', 'b1')
  for (const [run, text] of [[a, 'private a'], [b, 'private b']] as const) {
    f.store.appendOutput(run.id, { type: 'message.snapshot', producerSequence: 0, messageId: 'same-native-id', text })
  }
  const again = f.start('a', 'a2')
  f.store.appendOutput(again.id, { type: 'message.snapshot', producerSequence: 0, messageId: 'same-native-id', text: 'next a' })
  expect(f.messages('a').map(row => row.content)).toEqual(['hello', 'private a', 'hello', 'next a'])
  expect(f.messages('b').map(row => row.content)).toEqual(['hello', 'private b'])
  expect(new Set([...f.messages('a'), ...f.messages('b')].map(row => row.id)).size).toBe(6)
})

it('rolls back both the canonical output and transcript when a history write fails', () => {
  const f = setup(), run = f.start('a', 'request')
  f.db.exec("CREATE TRIGGER fail_message BEFORE UPDATE OF content ON messages WHEN NEW.content='write failure' BEGIN SELECT RAISE(ABORT, 'fixture transcript failure'); END")
  expect(() => f.store.appendOutput(run.id, { type: 'message.delta', producerSequence: 0, messageId: 'm', text: 'write failure' })).toThrow('fixture transcript failure')
  expect(f.store.output(run.id)).toEqual([])
  expect(f.messages('a')).toHaveLength(1)
  expect(f.db.prepare('SELECT count(*) AS count FROM studio_agent_chat_messages').get()?.count).toBe(1)
  f.store.finish(run.id, 'failed', 'INTERNAL')
  expect(f.store.get(run.id)?.status).toBe('failed')
  expect(f.session('a').message_count).toBe(1)
})

it('rejects old history and mismatched bindings before accepting a Run or user message', () => {
  const f = setup()
  f.db.prepare("INSERT INTO messages (session_id, role, content) VALUES ('old', 'assistant', 'existing history')").run()
  expect(() => f.projection.attach('old', f.instance)).toThrow(expect.objectContaining({ code: 'CAPABILITY_UNSUPPORTED' }))
  expect(() => f.accept('old', 'request')).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  expect(f.db.prepare('SELECT count(*) AS count FROM studio_agent_runs').get()?.count).toBe(0)
  expect(f.db.prepare('SELECT count(*) AS count FROM studio_agent_conversations').get()?.count).toBe(0)
  expect(f.messages('old')).toMatchObject([{ role: 'assistant', content: 'existing history' }])
  const other = f.store.createInstance({ ...f.instance, config: {}, agentTypeId: 'test.chat/agent' })
  expect(() => f.projection.attach('a', other)).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
})

it('rejects an empty imported transcript that still references an existing native conversation', () => {
  const f = setup()
  f.db.prepare("UPDATE sessions SET agent_native_session_id='existing-native' WHERE id='old'").run()
  expect(() => f.projection.attach('old', f.instance)).toThrow(expect.objectContaining({ code: 'CAPABILITY_UNSUPPORTED' }))
  expect(f.projection.binding('old')).toBeUndefined()
})

it('rolls back Run admission and its input message when the transcript insert fails', () => {
  const f = setup()
  f.db.exec("CREATE TRIGGER fail_input AFTER INSERT ON messages BEGIN SELECT RAISE(ABORT, 'fixture input failure'); END")
  expect(() => f.accept('a', 'request')).toThrow('fixture input failure')
  for (const table of ['studio_agent_runs', 'studio_agent_conversations', 'studio_agent_run_targets', 'studio_agent_run_admissions', 'studio_agent_chat_messages', 'messages']) {
    expect(f.db.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count).toBe(0)
  }
  f.db.exec('DROP TRIGGER fail_input')
  expect(f.accept('a', 'request').sessionId).toBe('a')
  expect(f.messages('a')).toHaveLength(1)
})

it.each([['hermes', 'cli', 'hermes'], ['ekko-agent', 'builtin_agent', 'ekko']] as const)('preserves the builtin identity for %s when attaching an owned empty chat', (agent, source, module) => {
  const f = setup(), instance = f.store.createInstance({ agentTypeId: agent, profileId: 'one', ownerId: '7', config: {}, mode: 'global' })
  f.db.prepare('UPDATE sessions SET agent=?, source=? WHERE id=?').run(agent, source, 'old')
  f.projection.attach('old', instance, source)
  const run = f.store.accept(instance, { kind: 'builtin', module, implementationVersion: 'test' }, input, 'builtin', undefined, { kind: 'chat', sessionId: 'old' }).run
  expect(f.projection.binding('old')?.source).toBe(source)
  expect(f.session('old')).toMatchObject({ agent, source })
  expect(f.messages('old')).toMatchObject([{ role: 'user', content: 'hello', run_marker: run.id }])
})

it.each(['delete', 'transfer', 'retype', 'reprofile', 'resurface'])('ends the canonical Run without writing into an unavailable chat after %s', action => {
  const f = setup(), run = f.start('a', 'request')
  if (action === 'delete') f.db.prepare("DELETE FROM sessions WHERE id='a'").run()
  else if (action === 'transfer') f.db.prepare("UPDATE sessions SET studio_user_id='8' WHERE id='a'").run()
  else if (action === 'retype') f.db.prepare("UPDATE sessions SET agent='other-agent' WHERE id='a'").run()
  else if (action === 'reprofile') f.db.prepare("UPDATE sessions SET profile='other-profile' WHERE id='a'").run()
  else f.db.prepare("UPDATE sessions SET source='group_chat' WHERE id='a'").run()
  expect(() => f.store.appendOutput(run.id, { type: 'message.delta', producerSequence: 0, messageId: 'm', text: 'late private output' })).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  f.store.finish(run.id, 'failed', 'FORBIDDEN')
  expect(f.store.get(run.id)?.status).toBe('failed')
  expect(f.messages('a')).toHaveLength(1)
  if (action !== 'delete') expect(f.session('a').ended_at).toBeNull()
})
