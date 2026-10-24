import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentChatProjection } from '../../packages/server/src/modules/studio/repositories/agent-chat-projection'
import { AgentChatStore } from '../../packages/server/src/modules/studio/repositories/agent-chat-store'
import { AgentExecutionStore } from '../../packages/server/src/modules/studio/repositories/agent-execution-store'
import { SESSIONS_SCHEMA, MESSAGES_SCHEMA } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { AgentChats, type AgentChatSessionCreation } from '../../packages/server/src/modules/studio/services/agents/chats'
import { AgentCoordinator } from '../../packages/server/src/modules/studio/services/agents/coordinator'
import { AgentRegistry } from '../../packages/server/src/modules/studio/services/agents/registry'
import { AgentRunAdmission } from '../../packages/server/src/modules/studio/services/agents/admission'
import { PluginHookRegistry } from '../../packages/server/src/modules/studio/services/events/plugin-hooks'
import { PluginEventBus } from '../../packages/server/src/modules/studio/services/events/plugin-events'
import { createExecutionContext } from '../../packages/server/src/modules/studio/services/context/execution'
import { StudioError, type ExecutionScope } from '../../packages/studio-plugin-sdk/src'
import { AgentChatDelivery } from '../../packages/server/src/modules/studio/services/chat-run/agent-delivery'

const scope: ExecutionScope = { scopeId: 'app', principal: { kind: 'user', id: '7' }, profileId: 'one', surface: 'api', traceId: 'trace' }
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })

function setup(interactions?: ConstructorParameters<typeof AgentChats>[0]['interactions']) {
  const db = new DatabaseSync(':memory:')
  for (const [table, columns] of [['sessions', SESSIONS_SCHEMA], ['messages', MESSAGES_SCHEMA]] as const) db.exec(`CREATE TABLE ${table} (${Object.entries(columns).map(([name, sql]) => `${name} ${sql}`).join(', ')})`)
  const projection = new AgentChatProjection(db), executions = new AgentExecutionStore(db, projection), store = new AgentChatStore(db)
  const registry = new AgentRegistry(), events = new PluginEventBus(), hooks = new PluginHookRegistry(), logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  let allowed = true, failCreation = false
  let held: ReturnType<typeof Promise.withResolvers<void>> | undefined
  const authorize = () => { if (!allowed) throw new StudioError('FORBIDDEN', 'Access revoked') }
  const factory = vi.fn(async () => ({ run: async () => {
    const result = (held?.promise ?? Promise.resolve()).then(() => ({ status: 'completed' as const }))
    return { events: (async function* () {
      yield { type: 'message.delta' as const, producerSequence: 0, messageId: 'm', text: 'Native answer' }
      await result
    })(), result, cancel: async () => { held?.resolve() } }
  }, dispose: async () => {} }))
  const registration = registry.stage('one', { kind: 'plugin', pluginId: 'test.chats', version: '1.0.0', generation: 'first' }, ['test.chats/agent'])
  registration.register({ id: 'test.chats/agent', name: 'Owned Agent fixture', configSchema: { type: 'object', properties: { cwd: { type: 'string' }, model: { type: 'string' } } },
    capabilities: { text: true, modes: ['global'] }, create: factory })
  registration.commit()
  const context = (current: ExecutionScope, signal: AbortSignal) => createExecutionContext(current, signal, logger, {
    authorize: async () => authorize(), sessions: { get: async () => null }, agents: { list: async profile => registry.list(profile) },
  })
  const coordinator = new AgentCoordinator({ store: executions, registry, events, logger, context, authorize,
    authorizeChat: (scope, instance, sessionId) => chats.authorizeRunTarget(scope, instance, sessionId) })
  const instance = coordinator.createInstance(scope, { agentTypeId: 'test.chats/agent', config: { cwd: '/owned-workspace', model: 'native-model' }, mode: 'global' })
  const createSession = vi.fn((input: AgentChatSessionCreation) => {
    db.prepare(`INSERT INTO sessions (id, profile, source, agent, agent_mode, user_id, studio_user_id, workspace, model, started_at, last_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.id, input.profile, input.source, input.agent, input.agent_mode,
      input.user_id, input.studio_user_id, input.workspace ?? null, input.model ?? '', 1, 1)
    if (failCreation) throw new Error('fixture session failure')
  })
  const chats = new AgentChats({ store, projection, executions, coordinator, admission: new AgentRunAdmission(coordinator, hooks, context), registry, authorize, createSession, interactions })
  cleanup.push(async () => { await coordinator.close(); chats.close(); events.close(); db.close() })
  const create = (key = 'create') => chats.create(scope, instance.id, { revision: 1, idempotencyKey: key })
  return { db, chats, store, projection, executions, coordinator, instance, registration, factory, createSession, create,
    revoke() { allowed = false }, fail() { failCreation = true }, recover() { failCreation = false },
    hold() { held = Promise.withResolvers<void>() }, release() { held?.resolve(); held = undefined } }
}

it('creates one owned chat and binding without starting the native Agent, including an identical retry', () => {
  const f = setup(), receipt = f.create()
  expect(f.create()).toEqual(receipt)
  expect(f.createSession).toHaveBeenCalledOnce()
  expect(f.factory).not.toHaveBeenCalled()
  expect(f.db.prepare('SELECT * FROM sessions').all()).toMatchObject([{ id: receipt.sessionId, profile: 'one', source: 'coding_agent',
    agent: f.instance.agentTypeId, agent_mode: 'global', studio_user_id: '7', user_id: '7', workspace: '/owned-workspace', model: 'native-model' }])
  expect(f.chats.isBound(receipt.sessionId)).toBe(true)
  expect(f.chats.ownedBinding(scope, receipt.sessionId).instance.id).toBe(f.instance.id)
})

it('returns an existing receipt after provider removal but rejects a new chat with an unavailable provider', async () => {
  const f = setup(), receipt = f.create()
  await f.registration.dispose()
  expect(f.create()).toEqual(receipt)
  expect(() => f.create('new-key')).toThrow(expect.objectContaining({ code: 'RUNTIME_UNAVAILABLE' }))
  expect(f.createSession).toHaveBeenCalledOnce()
})

it('rolls back the receipt, session and binding if session creation fails, allowing the original key to retry', () => {
  const f = setup()
  f.fail()
  expect(f.create).toThrow('fixture session failure')
  for (const table of ['sessions', 'studio_agent_chat_creations', 'studio_agent_chat_bindings']) expect(f.db.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count).toBe(0)
  f.recover()
  expect(f.create().sessionId).toEqual(expect.any(String))
  expect(f.db.prepare('SELECT count(*) AS count FROM sessions').get()?.count).toBe(1)
})

it('never accepts owner, target, configuration or scope overrides in chat creation', () => {
  const f = setup()
  for (const value of [{ revision: 0, idempotencyKey: 'key' }, { revision: 1, idempotencyKey: '' }, { revision: 1, idempotencyKey: 'key', ownerId: '8' }]) {
    expect(() => f.chats.create(scope, f.instance.id, value as never)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  }
  for (const extra of [{ sessionId: 'other' }, { runId: 'other' }, { workspaceId: 'other' }]) {
    expect(() => f.chats.create({ ...scope, ...extra }, f.instance.id, { revision: 1, idempotencyKey: 'key' })).toThrow(expect.objectContaining({ code: 'CAPABILITY_UNSUPPORTED' }))
  }
  expect(() => f.chats.create({ ...scope, principal: { kind: 'service', id: '7' } }, f.instance.id, { revision: 1, idempotencyKey: 'key' })).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  expect(f.createSession).not.toHaveBeenCalled()
})

it('keeps creation keys and owned bindings within owner/profile and checks the current instance revision', () => {
  const f = setup(), receipt = f.create()
  expect(() => f.chats.create(scope, f.instance.id, { revision: 2, idempotencyKey: 'create' })).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
  expect(() => f.chats.create(scope, f.instance.id, { revision: 2, idempotencyKey: 'new-key' })).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
  for (const current of [{ ...scope, profileId: 'two' }, { ...scope, principal: { kind: 'user' as const, id: '8' } }]) {
    expect(() => f.chats.ownedBinding(current, receipt.sessionId)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
    expect(() => f.chats.create(current, f.instance.id, { revision: 1, idempotencyKey: 'create' })).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
  }
  expect(() => f.chats.ownedBinding({ ...scope, sessionId: 'other' }, receipt.sessionId)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  f.revoke()
  expect(f.create).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  expect(() => f.chats.ownedBinding(scope, receipt.sessionId)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
})

it('executes through canonical admission and commits exactly one input and answer per Run', async () => {
  const f = setup(), chat = f.create(), input = { content: [{ type: 'text' as const, text: 'User text' }] }, signal = new AbortController().signal
  const first = await f.chats.start(scope, chat.sessionId, input, 'run-key', signal)
  await f.coordinator.wait(first.id)
  expect((await f.chats.start(scope, chat.sessionId, input, 'run-key', signal)).id).toBe(first.id)
  expect(f.factory).toHaveBeenCalledOnce()
  expect(f.db.prepare('SELECT role, content, run_marker FROM messages ORDER BY id').all()).toEqual([
    { role: 'user', content: 'User text', run_marker: first.id }, { role: 'assistant', content: 'Native answer', run_marker: first.id },
  ])
  const other = f.create('other-chat')
  await expect(f.chats.cancel(scope, other.sessionId, first.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
})

it('keeps queued input durable and materializes it after the previous Run transcript', async () => {
  const f = setup(), chat = f.create(), signal = new AbortController().signal
  f.hold()
  const first = await f.chats.start(scope, chat.sessionId, { content: [{ type: 'text', text: 'First input' }] }, 'first', signal)
  await vi.waitFor(() => expect(f.executions.output(first.id)).toHaveLength(1))
  const second = await f.chats.start(scope, chat.sessionId, { content: [{ type: 'text', text: 'Queued input' }] }, 'second', signal)
  expect(second.status).toBe('queued')
  expect(f.executions.originalInput(second.id)?.content).toEqual([{ type: 'text', text: 'Queued input' }])
  expect(f.db.prepare('SELECT role, content FROM messages ORDER BY id').all()).toEqual([
    { role: 'user', content: 'First input' }, { role: 'assistant', content: 'Native answer' },
  ])
  f.release()
  await f.coordinator.wait(second.id)
  expect(f.db.prepare('SELECT role, content FROM messages ORDER BY id').all()).toEqual([
    { role: 'user', content: 'First input' }, { role: 'assistant', content: 'Native answer' },
    { role: 'user', content: 'Queued input' }, { role: 'assistant', content: 'Native answer' },
  ])
})

it('binds one interactive context to the exact canonical Run and settles it after completion', async () => {
  const finish = vi.fn(), active: Array<() => boolean> = []
  const begin = vi.fn((_session: string, _profile: string, _run: string, isActive: () => boolean) => {
    active.push(isActive)
    return { contextId: 'context-for-run', instructions: 'Current turn instructions', finish }
  })
  const f = setup({ begin }), chat = f.create(), signal = new AbortController()
  f.hold()
  const run = await f.chats.start(scope, chat.sessionId, { content: [{ type: 'text', text: 'Work' }] }, 'run', new AbortController().signal)
  const current = { ...scope, sessionId: chat.sessionId }
  const binding = f.chats.beginNativeTurn(current, f.instance, run.id, signal.signal)
  expect(binding).toMatchObject({ contextId: 'context-for-run', sessionId: chat.sessionId, interactive: true })
  expect(f.chats.beginNativeTurn(current, f.instance, run.id, signal.signal)).toBe(binding)
  expect(begin).toHaveBeenCalledOnce()
  expect(begin.mock.calls[0].slice(0, 3)).toEqual([chat.sessionId, 'one', run.id])
  expect(active[0]()).toBe(true)
  f.release()
  await f.coordinator.wait(run.id)
  expect(active[0]()).toBe(false)
  signal.abort()
  await vi.waitFor(() => expect(finish).toHaveBeenCalledWith('ended'))
})

it('waits for native cancellation before settling a task card and never enables interactive goals for an event origin', async () => {
  const finish = vi.fn(), begin = vi.fn(() => ({ contextId: 'background-context', instructions: 'Plan only', finish }))
  const f = setup({ begin }), chat = f.create(), signal = new AbortController()
  f.hold()
  const run = await f.chats.start({ ...scope, surface: 'event' }, chat.sessionId, { content: [{ type: 'text', text: 'Background work' }] }, 'run', new AbortController().signal)
  expect(f.chats.beginNativeTurn({ ...scope, sessionId: chat.sessionId, surface: 'event' }, f.instance, run.id, signal.signal).interactive).toBe(false)
  expect(begin.mock.calls[0][4]).toBe(false)
  signal.abort()
  await Promise.resolve()
  expect(finish).not.toHaveBeenCalled()
  await f.chats.cancel(scope, chat.sessionId, run.id)
  await vi.waitFor(() => expect(finish).toHaveBeenCalledWith('interrupted'))
})

it('delivers committed rows in Run order with stable ids and queue identity, including cancellation before dispatch', async () => {
  const f = setup(), chat = f.create(), emitted: Array<{ event: string; data: Record<string, any> }> = []
  const delivery = new AgentChatDelivery({ chats: f.chats, emit: (_session, event, data) => emitted.push({ event, data }), activity: vi.fn(), onError: vi.fn() })
  f.hold()
  const first = await f.chats.start(scope, chat.sessionId, { content: [{ type: 'text', text: 'First' }] }, 'first', new AbortController().signal)
  delivery.follow(scope, chat.sessionId, first.id, 'first')
  const second = await f.chats.start(scope, chat.sessionId, { content: [{ type: 'text', text: 'Second' }] }, 'second', new AbortController().signal)
  delivery.follow(scope, chat.sessionId, second.id, 'second')
  await f.chats.cancel(scope, chat.sessionId, second.id)
  delivery.publishQueue(scope, chat.sessionId)
  expect(emitted.filter(item => item.event === 'run.queued').at(-1)?.data.queue_length).toBe(0)
  await vi.waitFor(() => expect(emitted.some(item => item.event === 'message.persisted')).toBe(true))
  f.release()
  await delivery.idle(chat.sessionId)
  expect(emitted.filter(item => ['run.started', 'run.completed', 'abort.completed'].includes(item.event)).map(item => [item.event, item.data.queue_id]))
    .toEqual([['run.started', 'first'], ['run.completed', 'first'], ['abort.completed', 'second']])
  const rows = emitted.filter(item => item.event === 'message.persisted').flatMap(item => item.data.messages)
  expect(rows).toMatchObject([{ role: 'user', content: 'First', run_marker: first.id }, { role: 'assistant', content: 'Native answer', run_marker: first.id }])
  expect(new Set(rows.map(row => row.id)).size).toBe(2)
  delivery.close()
})

it('drains the output cursor after terminal status before emitting completion and rechecks ownership before delivery', async () => {
  const f = setup(), chat = f.create(), emitted = vi.fn(), onError = vi.fn()
  const delivery = new AgentChatDelivery({ chats: f.chats, emit: emitted, activity: vi.fn(), onError })
  f.hold()
  const run = await f.chats.start(scope, chat.sessionId, { content: [{ type: 'text', text: 'One' }] }, 'one', new AbortController().signal)
  await vi.waitFor(() => expect(f.executions.output(run.id).length).toBe(1))
  for (let i = 1; i <= 210; i++) f.executions.appendOutput(run.id, { type: 'message.delta', producerSequence: i, messageId: 'm', text: '.' })
  f.release(); await f.chats.wait(run.id)
  delivery.follow(scope, chat.sessionId, run.id, 'one')
  await delivery.idle(chat.sessionId)
  expect(emitted.mock.calls.filter(call => call[1] === 'message.persisted').at(-1)?.[2]).toMatchObject({ producer_sequence: 210, messages: [{ content: 'Native answer' + '.'.repeat(210) }] })
  expect(emitted.mock.calls.at(-1)?.[1]).toBe('run.completed')
  f.revoke()
  expect(() => delivery.follow(scope, chat.sessionId, run.id, 'one')).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  expect(onError).not.toHaveBeenCalled()
  delivery.close()
})
