import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import { PluginStore } from '../../packages/server/src/modules/studio/repositories/plugin-store'
import { PluginHost } from '../../packages/server/src/modules/studio/services/plugins/host'
import { AgentRegistry } from '../../packages/server/src/modules/studio/services/agents/registry'
import { AgentCoordinator } from '../../packages/server/src/modules/studio/services/agents/coordinator'
import { startStudioAgentRun } from '../../packages/server/src/modules/studio/services/agents/start'
import { AgentExecutionStore } from '../../packages/server/src/modules/studio/repositories/agent-execution-store'
import { PluginEventStore } from '../../packages/server/src/modules/studio/repositories/plugin-event-store'
import { PluginEventBus } from '../../packages/server/src/modules/studio/services/events/plugin-events'
import { createExecutionContext, type ContextServices } from '../../packages/server/src/modules/studio/services/context/execution'
import { SYSTEM_CODING_PLUGINS } from '../../packages/server/src/modules/studio/contracts/system-plugins'
import { workerEnvironment } from '../../packages/server/src/modules/studio/services/plugins/worker'
import { PluginChatRunStore } from '../../packages/server/src/modules/studio/repositories/plugin-chat-run-store'
import { PluginChatRuns } from '../../packages/server/src/modules/studio/services/chat-run/plugin'
import type { DirectChatRunOptions } from '../../packages/server/src/modules/studio/services/chat-run/direct'
import type { AgentRunContext, ExecutionContext, ExecutionScope, PluginManifest } from '../../packages/studio-plugin-sdk/src'

let root: string, runner: string
const cleanup: Array<() => Promise<void>> = []
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'studio-plugin-tests-'))
  runner = join(root, 'runner.cjs')
  await build({ entryPoints: ['packages/studio-plugin-runner/src/main.ts'], bundle: true, platform: 'node', target: 'node24.22.1', format: 'cjs', outfile: runner, logLevel: 'silent' })
})
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

function setup(sessions: ContextServices['sessions'] = { get: async () => null }, chatFactory?: (db: DatabaseSync) => ContextServices['chat']) {
  const db = new DatabaseSync(':memory:')
  const chat = chatFactory?.(db)
  const store = new PluginStore(db), registry = new AgentRegistry(), events = new PluginEventBus(), eventStore = new PluginEventStore(db)
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const context = (scope: ExecutionScope, signal: AbortSignal): ExecutionContext => createExecutionContext(scope, signal, logger, {
    authorize: async () => {}, sessions, chat, agents: { list: async profile => registry.list(profile) },
    runs: {
      start: async (scope, input, signal) => startStudioAgentRun(scope, input, signal, coordinator),
      get: async (scope, id) => coordinator.get(scope, id), output: async (scope, id, after) => coordinator.output(scope, id, after),
      cancel: (scope, id) => coordinator.cancel(scope, id),
      interactions: async (scope, id) => coordinator.interactions(scope, id),
      respond: (scope, id, input) => coordinator.respond(scope, id, input),
      usage: async (scope, id) => coordinator.usage(scope, id),
    },
  })
  const ctx = (signal: AbortSignal) => createExecutionContext({
    scopeId: 'scope', principal: { id: '1', kind: 'user' }, profileId: 'default', surface: 'api', traceId: 'trace', runId: 'run',
  }, signal, logger, { authorize: async () => {}, sessions, agents: { list: async profile => registry.list(profile) } })
  const host = new PluginHost({ store, registry, events, runnerPath: runner, artifactsRoot: join(root, 'artifacts'), logger,
    eventContext: async (state, event, signal) => context({
      scopeId: 'event', principal: { kind: 'user', id: state.ownerId }, profileId: state.profileId, surface: 'event', traceId: event.correlationId,
      ...(event.subject.runId ? { runId: event.subject.runId } : {}), ...(event.subject.sessionId ? { sessionId: event.subject.sessionId } : {}),
    }, signal), acceptEvents: async batch => { for (const event of eventStore.append(batch)) events.publish(event) } })
  const coordinator: AgentCoordinator = new AgentCoordinator({ store: new AgentExecutionStore(db), registry, events, logger, authorize: () => {}, context })
  cleanup.push(async () => { await coordinator.close(); await host.close(); events.close(); db.close() })
  return { db, store, registry, events, logger, host, ctx, coordinator, eventStore }
}

describe('plugin worker integration', () => {
  it('keeps a real worker runtime across turns and routes persisted interaction responses and cancellation', async () => {
    const { host, coordinator } = setup()
    const directory = await mkdtemp(join(root, 'interactive-'))
    const manifest = { schemaVersion: 1, id: 'test.interactive', version: '1.0.0', engines: { studioSdk: '^0.1.0', rpc: 1 }, backend: 'index.cjs', activation: 'profile',
      contributes: { agents: ['test.interactive/agent'] }, requires: { capabilities: ['agents.register'] } }
    await writeFile(join(directory, 'studio-plugin.json'), JSON.stringify(manifest))
    await writeFile(join(directory, 'index.cjs'), `module.exports = { apply(plugin) {
      plugin.agents.register({ id: 'test.interactive/agent', name: 'Interactive', configSchema: {}, capabilities: { text: true, modes: ['scoped'], persistentSession: true, approvals: true },
        create: async () => { let turn = 0; return { dispose: async () => {}, run: async () => {
          turn++; let answer; const answered = new Promise(resolve => { answer = resolve });
          let complete; const result = new Promise(resolve => { complete = resolve });
          return { result, events: (async function* () {
            yield { type: 'interaction.requested', producerSequence: 1, requestId: 'approval', kind: 'approval', prompt: 'Proceed?', choices: [{ id: 'yes', label: 'Yes' }] };
            const response = await answered;
            if (response) {
              yield { type: 'message.delta', producerSequence: 2, messageId: 'answer', text: turn + ':' + response };
              yield { type: 'usage.reported', producerSequence: 3, modelCallId: 'call', model: 'fixture', mode: 'final', revision: 1, inputTokens: 4, outputTokens: 2 };
              complete({ status: 'completed' });
            }
          })(), respond: async input => answer(input.choiceId), cancel: async () => { answer(null); complete({ status: 'cancelled' }) } };
        } } }
      });
    } }`)
    await host.install(directory)
    await host.configure({ pluginId: manifest.id, profileId: 'default', ownerId: '1', enabled: true, config: {}, grants: manifest.requires.capabilities }, 0)
    const scope: ExecutionScope = { scopeId: 'api', principal: { kind: 'user', id: '1' }, profileId: 'default', surface: 'api', traceId: 'trace' }
    const instance = coordinator.createInstance(scope, { agentTypeId: 'test.interactive/agent', config: {}, mode: 'scoped' })
    for (const key of ['first', 'second']) {
      const run = coordinator.start(scope, instance.id, { content: [{ type: 'text', text: 'go' }] }, key)
      await vi.waitFor(() => expect(coordinator.get(scope, run.id).status).toBe('waiting_input'))
      const interaction = coordinator.interactions(scope, run.id)[0]
      const receipt = await coordinator.respond(scope, run.id, { interactionId: interaction.id, idempotencyKey: key, choiceId: 'yes' })
      expect(receipt).toEqual({ id: interaction.id, runId: run.id, status: 'resolved' })
      await coordinator.wait(run.id)
      expect(coordinator.get(scope, run.id).status).toBe('completed')
      expect(coordinator.output(scope, run.id, -1)[1]).toMatchObject({ text: key === 'first' ? '1:yes' : '2:yes' })
      expect(coordinator.usage(scope, run.id)).toMatchObject([{ inputTokens: 4, outputTokens: 2, final: true }])
    }
    const run = coordinator.start(scope, instance.id, { content: [{ type: 'text', text: 'stop' }] }, 'third')
    await vi.waitFor(() => expect(coordinator.get(scope, run.id).status).toBe('waiting_input'))
    await coordinator.cancel(scope, run.id); await coordinator.wait(run.id)
    expect(coordinator.get(scope, run.id).status).toBe('cancelled')
    expect(coordinator.interactions(scope, run.id)[0].status).toBe('interrupted')
  })

  it.each([true, false])('authorizes lifecycle SDK calls on every real worker request (granted: %s)', async granted => {
    const { host, coordinator, registry, logger, events, store } = setup()
    const registration = registry.stage('*', { kind: 'builtin', module: 'ekko', implementationVersion: 'test' }, ['ekko'])
    registration.register({ id: 'ekko', name: 'Fixture', configSchema: {}, capabilities: { text: true, modes: ['scoped'], clarifications: true }, create: async () => ({
      run: async () => {
        let end!: () => void
        const ended = new Promise<void>(resolve => { end = resolve })
        return { events: (async function* () { yield { type: 'interaction.requested' as const, producerSequence: 1, requestId: 'question', kind: 'clarification' as const, prompt: 'Private question', choices: [] }; await ended })(),
          result: ended.then(() => ({ status: 'cancelled' as const })), respond: async () => {}, cancel: async () => end() }
      }, dispose: async () => {},
    }) })
    registration.commit()
    const scope: ExecutionScope = { scopeId: 'api', principal: { kind: 'user', id: '1' }, profileId: 'default', surface: 'api', traceId: 'trace' }
    const instance = coordinator.createInstance(scope, { agentTypeId: 'ekko', config: {}, mode: 'scoped' })
    const run = coordinator.start(scope, instance.id, { content: [{ type: 'text', text: 'hello' }] }, 'one')
    await vi.waitFor(() => expect(coordinator.get(scope, run.id).status).toBe('waiting_input'))
    const directory = await mkdtemp(join(root, 'lifecycle-context-'))
    const manifest = { schemaVersion: 1, id: 'test.lifecycle', version: '1.0.0', engines: { studioSdk: '^0.1.0', rpc: 1 }, backend: 'index.cjs', activation: 'profile',
      contributes: { agents: [] }, configSchema: { type: 'object' }, requires: { capabilities: ['events.subscribe:plugin.ready', ...(granted ? ['runs.read', 'runs.respond', 'runs.cancel'] : [])] } }
    await writeFile(join(directory, 'studio-plugin.json'), JSON.stringify(manifest))
    await writeFile(join(directory, 'index.cjs'), `module.exports = { apply(plugin) { plugin.on('plugin.ready', async (_event, ctx) => {
      const results = [];
      for (const fn of [() => ctx.runs.interactions(plugin.config.runId), () => ctx.runs.usage(plugin.config.runId),
        () => ctx.runs.respond(plugin.config.runId, { interactionId: plugin.config.interactionId, idempotencyKey: 'answer', text: 'hello' }), () => ctx.runs.cancel(plugin.config.runId)]) {
        try { results.push(await fn()) } catch (error) { results.push(error.code) }
      }
      ctx.logger.info('lifecycle-results', { results });
    }) } }`)
    await host.install(directory)
    await host.configure({ pluginId: manifest.id, profileId: 'default', ownerId: '1', enabled: true, config: { runId: run.id, interactionId: coordinator.interactions(scope, run.id)[0].id }, grants: manifest.requires.capabilities }, 0)
    const outputs = () => logger.info.mock.calls.filter(call => call[0] === 'Plugin stdout')
      .flatMap(call => String((call[1] as { text: string }).text).trim().split('\n')).map(line => JSON.parse(line))
      .filter(line => line.message === 'lifecycle-results').map(line => line.data.results)
    await events.idle(); await vi.waitFor(() => expect(outputs()).toHaveLength(1))
    if (granted) {
      expect(outputs()[0][0][0]).toMatchObject({ prompt: 'Private question', status: 'pending' })
      expect(outputs()[0][1]).toEqual([])
      expect(outputs()[0][2]).toEqual({ id: coordinator.interactions(scope, run.id)[0].id, runId: run.id, status: 'resolved' })
      const current = store.profile(manifest.id, 'default')!
      store.saveProfile({ ...current, grants: ['events.subscribe:plugin.ready'] }, current.revision)
      events.publish({ schemaVersion: 1, id: 'revoked', type: 'plugin.ready', occurredAt: Date.now(), partitionKey: 'plugin', sequence: 2,
        subject: { profileId: 'default', pluginId: manifest.id }, data: { pluginId: manifest.id }, correlationId: 'trace' })
      await events.idle(); await vi.waitFor(() => expect(outputs()).toHaveLength(2))
      expect(outputs()[1]).toEqual(['FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN'])
    } else expect(outputs()[0]).toEqual(['FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN'])
  })

  it.each([true, false])('starts, queries and cancels chat through real worker RPC (granted: %s)', async granted => {
    let chat!: PluginChatRuns
    let options!: DirectChatRunOptions
    const start = vi.fn((_input, entry: DirectChatRunOptions) => {
      options = entry
      entry.onEvent('run.queued', {})
      return { dispose: vi.fn(), dropQueued: vi.fn(), cancel: async () => entry.onEvent('abort.completed', { synced: true }) }
    })
    const { host, store, events, logger } = setup(undefined, db => {
      chat = new PluginChatRuns({ store: new PluginChatRunStore(db), server: () => ({ startDirectRun: start }),
        authorize: (scope, id) => {
          if (scope.principal.id !== '1' || scope.profileId !== 'default' || id !== 'session') throw new Error('Invalid host scope')
          return { user: { id: 1, username: 'owner', role: 'user' }, session: {
            id, profile: 'default', studio_user_id: '1', source: 'coding_agent', agent: 'codex', model: 'model', provider: 'provider',
            workspace: null, api_mode: 'responses', reasoning_effort: 'high', agent_mode: 'scoped',
          } as any }
        } })
      return { start: async (s, r, signal) => chat.start(s, r, signal), get: async (s, id) => chat.get(s, id), cancel: (s, id) => chat.cancel(s, id) }
    })
    cleanup.push(async () => chat.close())
    const directory = await mkdtemp(join(root, 'chat-'))
    const manifest = { schemaVersion: 1, id: 'test.chat', version: '1.0.0', engines: { studioSdk: '^0.1.0', rpc: 1 }, backend: 'index.cjs', activation: 'profile',
      contributes: { agents: [] }, requires: { capabilities: ['events.subscribe:plugin.ready', ...(granted ? ['chat.start', 'chat.read', 'chat.cancel'] : [])] } }
    await writeFile(join(directory, 'studio-plugin.json'), JSON.stringify(manifest))
    await writeFile(join(directory, 'index.cjs'), `module.exports = { apply(plugin) {
      let id;
      plugin.on('plugin.ready', async (_event, ctx) => {
        const request = { sessionId: 'session', input: 'hello', idempotencyKey: 'worker-chat' };
        const results = [];
        const attempt = async fn => { try { results.push(await fn()) } catch (error) { results.push(error.code) } };
        await attempt(async () => (await ctx.chat.start({ ...request, principal: { id: 'other' } })).status);
        await attempt(async () => { const run = await ctx.chat.start(request); id = run.id; return run.status });
        await attempt(async () => (await ctx.chat.start(request)).id === id);
        await attempt(async () => (await ctx.chat.get(id || 'unavailable')).status);
        if (_event.data.generation !== 'finish') {
          ctx.logger.info('chat-results', { results }); return;
        }
        await attempt(async () => (await ctx.chat.cancel(id)).status);
        ctx.logger.info('chat-results', { results });
      });
    } }`)
    await host.install(directory)
    await host.configure({ pluginId: manifest.id, profileId: 'default', ownerId: '1', enabled: true, config: {}, grants: manifest.requires.capabilities }, 0)
    const output = () => logger.info.mock.calls.filter(call => call[0] === 'Plugin stdout')
      .flatMap(call => String((call[1] as { text: string }).text).trim().split('\n')).map(line => JSON.parse(line))
      .filter(line => line.message === 'chat-results').map(line => line.data.results)
    await events.idle()
    await vi.waitFor(() => expect(output()).toHaveLength(1))
    if (!granted) {
      expect(output()[0]).toEqual(['FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN'])
      expect(start).not.toHaveBeenCalled()
      return
    }
    expect(output()[0]).toEqual(['INVALID_ARGUMENT', 'queued', true, 'queued'])
    // The first event callback has ended and its worker scope has been released.
    expect(options.context!.signal.aborted).toBe(false)
    await options.reauthorize!()
    const publish = (id: string) => events.publish({ schemaVersion: 1, id, type: 'plugin.ready', occurredAt: Date.now(), partitionKey: 'plugin', sequence: 2,
      subject: { profileId: 'default', pluginId: manifest.id }, data: { pluginId: manifest.id, generation: 'finish' }, correlationId: 'trace' })
    publish('cancel')
    await events.idle()
    await vi.waitFor(() => expect(output()).toHaveLength(2))
    expect(output()[1]).toEqual(['INVALID_ARGUMENT', 'queued', true, 'queued', 'cancelled'])
    expect(start).toHaveBeenCalledOnce()
    const current = store.profile(manifest.id, 'default')!
    store.saveProfile({ ...current, grants: ['events.subscribe:plugin.ready'] }, current.revision)
    publish('revoked')
    await events.idle()
    await vi.waitFor(() => expect(output()).toHaveLength(3))
    expect(output()[2]).toEqual(['FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN'])
    expect(start).toHaveBeenCalledOnce()
  }, 20_000)

  it.each([true, false])('starts an independent run through real event-context RPC (granted: %s)', async granted => {
    const { host, store, coordinator, registry, events, logger } = setup()
    const factory = vi.fn(async () => ({ run: async () => ({
      events: (async function* () { yield { type: 'message.delta' as const, producerSequence: 1, messageId: 'answer', text: 'started' } })(),
      result: Promise.resolve({ status: 'completed' as const }), cancel: async () => {},
    }), dispose: async () => {} }))
    const registration = registry.stage('*', { kind: 'builtin', module: 'ekko', implementationVersion: 'fixture' }, ['ekko'])
    registration.register({ id: 'ekko', name: 'Fixture', configSchema: {}, capabilities: { text: true, modes: ['scoped'] }, create: factory })
    registration.commit()
    const scope: ExecutionScope = { scopeId: 'api', principal: { kind: 'user', id: '1' }, profileId: 'default', surface: 'api', traceId: 'trace' }
    const instance = coordinator.createInstance(scope, { agentTypeId: 'ekko', config: {}, mode: 'scoped' })
    const directory = await mkdtemp(join(root, 'start-'))
    const manifest = { schemaVersion: 1, id: 'test.start', version: '1.0.0', engines: { studioSdk: '^0.1.0', rpc: 1 }, backend: 'index.cjs', activation: 'profile',
      contributes: { agents: [] }, configSchema: { type: 'object' }, requires: { capabilities: ['events.subscribe:plugin.ready', ...(granted ? ['runs.start'] : [])] } }
    await writeFile(join(directory, 'studio-plugin.json'), JSON.stringify(manifest))
    await writeFile(join(directory, 'index.cjs'), `module.exports = { apply(plugin) {
      plugin.on('plugin.ready', async (_event, ctx) => {
        const request = { instanceId: plugin.config.instanceId, input: { content: [{ type: 'text', text: 'go' }] }, idempotencyKey: 'worker-request' };
        const results = [];
        for (const input of [{ ...request, principal: { id: 'other' } }, { ...request, instanceId: 'foreign' }, request, request]) {
          try { results.push((await ctx.runs.start(input)).id) } catch (error) { results.push(error.code) }
        }
        ctx.logger.info('start-results', { results });
      });
    } }`)
    await host.install(directory)
    await host.configure({ pluginId: manifest.id, profileId: 'default', ownerId: '1', enabled: true, config: { instanceId: instance.id }, grants: manifest.requires.capabilities }, 0)
    await events.idle()
    const output = () => logger.info.mock.calls.filter(call => call[0] === 'Plugin stdout')
      .flatMap(call => String((call[1] as { text: string }).text).trim().split('\n')).map(line => JSON.parse(line))
      .filter(line => line.message === 'start-results')
    await vi.waitFor(() => expect(output()).toHaveLength(1))
    const results = output()[0].data.results
    if (granted) {
      expect(results.slice(0, 2)).toEqual(['INVALID_ARGUMENT', 'NOT_FOUND'])
      expect(results[2]).toBe(results[3])
      await coordinator.wait(results[2])
      expect(coordinator.get(scope, results[2]).status).toBe('completed')
      expect(coordinator.output(scope, results[2], -1)).toMatchObject([{ text: 'started' }])
      expect(factory).toHaveBeenCalledOnce()
      const current = store.profile(manifest.id, 'default')!
      store.saveProfile({ ...current, grants: ['events.subscribe:plugin.ready'] }, current.revision)
      events.publish({ schemaVersion: 1, id: 'again', type: 'plugin.ready', occurredAt: Date.now(), partitionKey: 'plugin', sequence: 1,
        subject: { profileId: 'default', pluginId: manifest.id }, data: { pluginId: manifest.id }, correlationId: 'trace' })
      await events.idle()
      await vi.waitFor(() => expect(output()).toHaveLength(2))
      expect(output().at(-1).data.results).toEqual(['FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN'])
      expect(factory).toHaveBeenCalledOnce()
    } else {
      expect(results).toEqual(['FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN'])
      expect(factory).not.toHaveBeenCalled()
    }
  }, 20_000)

  it.each([true, false])('gates session removal through real worker RPC (granted: %s)', async granted => {
    const remove = vi.fn(async () => ({ deleted: true, native: { attempted: false, deleted: false, profileId: 'default' } }))
    const { host, registry, logger } = setup({ get: async () => null, remove })
    const directory = await mkdtemp(join(root, 'remove-'))
    const manifest = { schemaVersion: 1, id: 'test.remove', version: '1.0.0', engines: { studioSdk: '^0.1.0', rpc: 1 }, backend: 'index.cjs', activation: 'profile',
      contributes: { agents: ['test.remove/agent'] }, requires: { capabilities: ['agents.register', ...(granted ? ['sessions.remove'] : [])] } }
    await writeFile(join(directory, 'studio-plugin.json'), JSON.stringify(manifest))
    await writeFile(join(directory, 'index.cjs'), `module.exports = { apply(ctx) { ctx.agents.register({ id: 'test.remove/agent', name: 'Removal fixture', configSchema: {}, capabilities: { text: true, modes: ['scoped'] }, create: async () => ({
      run: async (_input, ctx) => {
        const results = []
        for (const id of ['foreign-session', 42, 'session']) {
          try { results.push(String((await ctx.sessions.remove(id)).deleted)) } catch (error) { results.push(error.code) }
        }
        return { events: (async function* () { yield { type: 'message.delta', messageId: 'answer', producerSequence: 1, text: results.join(':') } })(), result: Promise.resolve({ status: 'completed' }), cancel: async () => {} }
      }, dispose: async () => {}
    }) }) } }`)
    await host.install(directory)
    await host.configure({ pluginId: manifest.id, profileId: 'default', ownerId: '1', enabled: true, config: {}, grants: manifest.requires.capabilities }, 0)
    const resolved = registry.resolve('default', 'test.remove/agent')
    const controller = new AbortController()
    const runtime = await resolved.definition.create({ instanceId: 'instance', config: {}, configRevision: 1, mode: 'scoped' }, {
      provider: resolved.provider, runtimeSessionId: 'native', profileId: 'default', signal: controller.signal, logger,
    })
    const scope = { scopeId: 'scope', principal: { kind: 'user' as const, id: '1' }, profileId: 'default', sessionId: 'session', runId: 'run', runtimeSessionId: 'native', surface: 'api' as const, traceId: 'trace' }
    const ctx = createExecutionContext(scope, controller.signal, logger, { authorize: async () => {}, agents: { list: async () => [] }, sessions: { get: async () => null, remove } })
    const run = await runtime.run({ content: [{ type: 'text', text: 'remove' }] }, { ...ctx, scope })
    const output = []; for await (const event of run.events) output.push(event)
    expect(await run.result).toEqual({ status: 'completed' })
    expect(output).toMatchObject([{ text: granted ? 'FORBIDDEN:INVALID_ARGUMENT:true' : 'FORBIDDEN:FORBIDDEN:FORBIDDEN' }])
    expect(remove).toHaveBeenCalledTimes(granted ? 1 : 0)
    if (granted) expect(remove).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'default', principal: { kind: 'user', id: '1' } }), 'session', controller.signal)
    await runtime.dispose('test complete')
  }, 20_000)

  it('installs an independent plugin and executes its Agent through a real child process', async () => {
    const { host, registry, ctx, events, logger } = setup()
    const installation = await host.install(resolve('plugins/example-echo'))
    expect(installation.installationPolicy).toEqual({ kind: 'user', removable: true })
    await host.configure({ pluginId: installation.id, profileId: 'default', ownerId: '1', enabled: true, config: { prefix: 'Echo: ' }, grants: installation.manifest.requires.capabilities }, 0)
    const resolved = registry.resolve('default', 'example.echo/assistant')
    const controller = new AbortController()
    const runtime = await resolved.definition.create({ instanceId: 'instance', config: {}, configRevision: 1, mode: 'scoped' }, {
      provider: resolved.provider, runtimeSessionId: 'native', profileId: 'default', signal: controller.signal, logger,
    })
    const runCtx = { ...ctx(controller.signal), scope: { ...ctx(controller.signal).scope, runId: 'run', runtimeSessionId: 'native' } } as AgentRunContext
    const run = await runtime.run({ content: [{ type: 'text', text: 'hello' }] }, runCtx)
    const output = []
    for await (const event of run.events) output.push(event)
    expect(await run.result).toEqual({ status: 'completed' })
    expect(output).toEqual([{ type: 'message.delta', producerSequence: 1, messageId: 'answer', text: 'Echo: hello' }])
    events.publish({ schemaVersion: 1, id: 'done', type: 'run.completed', occurredAt: Date.now(), partitionKey: 'run', sequence: 1, subject: { profileId: 'default', runId: 'run' }, data: { runId: 'run' }, correlationId: 'trace' })
    await events.idle()
    expect(logger.info).toHaveBeenCalled()
    await expect(host.uninstall(installation.id)).rejects.toThrow('leases')
    await runtime.dispose('test complete')
    await host.uninstall(installation.id)
    expect(host.list()).toEqual([])
    expect(registry.list('default')).toEqual([])
  }, 20_000)

  it('rolls back registrations and reaps a worker when apply throws', async () => {
    const { host, registry, eventStore } = setup()
    const directory = await mkdtemp(join(root, 'broken-'))
    const manifest = { schemaVersion: 1, id: 'test.broken', version: '1.0.0', engines: { studioSdk: '^0.1.0', rpc: 1 }, backend: 'index.cjs', activation: 'profile', contributes: { agents: ['test.broken/agent'], events: { 'test.broken:staged': { type: 'object', additionalProperties: false } } }, requires: { capabilities: ['agents.register', 'events.emit:test.broken:staged'] } }
    await writeFile(join(directory, 'studio-plugin.json'), JSON.stringify(manifest))
    await writeFile(join(directory, 'index.cjs'), `module.exports = { async apply(ctx) {
      ctx.agents.register({ id: 'test.broken/agent', name: 'Staged Agent', configSchema: {}, capabilities: { text: true, modes: ['scoped'] }, create: async () => { throw new Error('not invoked') } })
      await ctx.emit('test.broken:staged', {})
      throw new Error('secret failure')
    } }`)
    await host.install(directory)
    await expect(host.configure({ pluginId: 'test.broken', profileId: 'default', ownerId: '1', enabled: true, config: {}, grants: manifest.requires.capabilities }, 0)).rejects.toThrow('Plugin operation failed')
    expect(registry.list('default')).toEqual([])
    expect(eventStore.read('default')).toEqual([])
  }, 20_000)

  it('protects all 14 reserved system identities before any deletion and preserves profile choices on registration', async () => {
    const { host, store } = setup()
    expect(SYSTEM_CODING_PLUGINS).toHaveLength(14)
    for (const plugin of SYSTEM_CODING_PLUGINS) {
      expect(() => host.uninstall(plugin.pluginId)).toThrow('System plugins')
      const manifest: PluginManifest = { schemaVersion: 1, id: plugin.pluginId, version: '1.0.0', engines: { studioSdk: '^0.1.0', rpc: 1 }, backend: 'index.cjs', activation: 'profile', contributes: { agents: [plugin.agentTypeId] }, requires: { capabilities: ['agents.register'] } }
      const input = { id: plugin.pluginId, manifest, generation: 'one', artifactPath: '/packaged/artifact' }
      store.registerSystem(input)
      store.saveProfile({ pluginId: plugin.pluginId, profileId: 'default', ownerId: '1', enabled: false, grants: [], config: {} }, 0)
      store.registerSystem(input)
      expect(store.get(plugin.pluginId)?.revision).toBe(1)
      expect(() => store.remove(plugin.pluginId)).toThrow('System plugins')
      expect(() => store.installUser(input)).toThrow('System plugins')
      expect(store.profile(plugin.pluginId, 'default')).toMatchObject({ enabled: false, revision: 1 })
    }
    expect(store.list()).toHaveLength(14)
  })

  it('does not inherit host credentials or application state into workers', () => {
    const env = workerEnvironment({ PATH: '/bin', HOME: '/user', AUTH_TOKEN: 'secret', OPENAI_API_KEY: 'secret', HERMES_WEB_UI_HOME: '/private', NODE_OPTIONS: '--inspect', ELECTRON_RUN_AS_NODE: '0' })
    expect(env).toEqual({ PATH: '/bin', HOME: '/user', NODE_ENV: 'production', ELECTRON_RUN_AS_NODE: '1' })
  })

  it('coordinates a real worker, persists one terminal event, and retains history after uninstall', async () => {
    const { host, coordinator, ctx, eventStore } = setup()
    const installation = await host.install(resolve('plugins/example-echo'))
    await host.configure({ pluginId: installation.id, profileId: 'default', ownerId: '1', enabled: true, config: { prefix: 'Echo: ' }, grants: installation.manifest.requires.capabilities }, 0)
    const { runId: _runId, ...scope } = ctx(new AbortController().signal).scope
    const instance = coordinator.createInstance(scope, { agentTypeId: 'example.echo/assistant', config: {}, mode: 'scoped' })
    const input = { content: [{ type: 'text' as const, text: 'persisted' }] }
    const run = coordinator.start(scope, instance.id, input, 'same-request')
    expect(coordinator.start(scope, instance.id, input, 'same-request').id).toBe(run.id)
    await coordinator.wait(run.id)
    expect(coordinator.get(scope, run.id).status).toBe('completed')
    expect(coordinator.output(scope, run.id, -1)).toEqual([{ type: 'message.delta', producerSequence: 1, messageId: 'answer', text: 'Echo: persisted' }])
    expect(eventStore.read('default').filter(row => row.event.type === 'run.completed')).toHaveLength(1)
    await host.uninstall(installation.id)
    expect(coordinator.get(scope, run.id).status).toBe('completed')
    expect(coordinator.start(scope, instance.id, input, 'same-request').id).toBe(run.id)
  }, 20_000)

  it('marks a worker crash interrupted and removes its registrations without replay', async () => {
    const { host, coordinator, ctx, registry } = setup()
    const directory = await mkdtemp(join(root, 'crashing-'))
    const manifest = { schemaVersion: 1, id: 'test.crash', version: '1.0.0', engines: { studioSdk: '^0.1.0', rpc: 1 }, backend: 'index.cjs', activation: 'profile', contributes: { agents: ['test.crash/agent'] }, requires: { capabilities: ['agents.register'] } }
    await writeFile(join(directory, 'studio-plugin.json'), JSON.stringify(manifest))
    await writeFile(join(directory, 'index.cjs'), `module.exports = { apply(ctx) { ctx.agents.register({ id: 'test.crash/agent', name: 'Crash fixture', configSchema: {}, capabilities: { text: true, modes: ['scoped'] }, create: async () => ({ run: async () => { process.exit(12) }, dispose: async () => {} }) }) } }`)
    await host.install(directory)
    await host.configure({ pluginId: 'test.crash', profileId: 'default', ownerId: '1', enabled: true, config: {}, grants: ['agents.register'] }, 0)
    const { runId: _runId, ...scope } = ctx(new AbortController().signal).scope
    const instance = coordinator.createInstance(scope, { agentTypeId: 'test.crash/agent', config: {}, mode: 'scoped' })
    const run = coordinator.start(scope, instance.id, { content: [{ type: 'text', text: 'go' }] }, 'crash-request')
    await coordinator.wait(run.id)
    expect(coordinator.get(scope, run.id).status).toBe('interrupted')
    await vi.waitFor(() => expect(registry.list('default')).toEqual([]))
  }, 20_000)

  it('exposes authorized run reads through the worker context and blocks fabricated run IDs', async () => {
    const { host, coordinator, ctx } = setup()
    const directory = await mkdtemp(join(root, 'context-'))
    const manifest = { schemaVersion: 1, id: 'test.context', version: '1.0.0', engines: { studioSdk: '^0.1.0', rpc: 1 }, backend: 'index.cjs', activation: 'profile', contributes: { agents: ['test.context/agent'] }, requires: { capabilities: ['agents.register', 'runs.read'] } }
    await writeFile(join(directory, 'studio-plugin.json'), JSON.stringify(manifest))
    await writeFile(join(directory, 'index.cjs'), `module.exports = { apply(ctx) { ctx.agents.register({ id: 'test.context/agent', name: 'Context fixture', configSchema: {}, capabilities: { text: true, modes: ['scoped'] }, create: async () => ({
      run: async (_input, ctx) => {
        const own = await ctx.runs.get(ctx.scope.runId)
        let denied = false
        try { await ctx.runs.get('fabricated') } catch (error) { denied = error.code === 'FORBIDDEN' }
        return { events: (async function* () { yield { type: 'message.delta', messageId: 'answer', producerSequence: 1, text: own.status + ':' + denied } })(), result: Promise.resolve({ status: 'completed' }), cancel: async () => {} }
      }, dispose: async () => {}
    }) }) } }`)
    await host.install(directory)
    await host.configure({ pluginId: manifest.id, profileId: 'default', ownerId: '1', enabled: true, config: {}, grants: manifest.requires.capabilities }, 0)
    const { runId: _runId, ...scope } = ctx(new AbortController().signal).scope
    const instance = coordinator.createInstance(scope, { agentTypeId: 'test.context/agent', config: {}, mode: 'scoped' })
    const run = coordinator.start(scope, instance.id, { content: [{ type: 'text', text: 'go' }] }, 'context-request')
    await coordinator.wait(run.id)
    expect(coordinator.get(scope, run.id).status).toBe('completed')
    expect(coordinator.output(scope, run.id, -1)).toMatchObject([{ text: 'running:true' }])
  }, 20_000)
})
