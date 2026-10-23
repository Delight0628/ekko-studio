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
import { AgentExecutionStore } from '../../packages/server/src/modules/studio/repositories/agent-execution-store'
import { PluginEventStore } from '../../packages/server/src/modules/studio/repositories/plugin-event-store'
import { PluginEventBus } from '../../packages/server/src/modules/studio/services/events/plugin-events'
import { createExecutionContext, type ContextServices } from '../../packages/server/src/modules/studio/services/context/execution'
import { SYSTEM_CODING_PLUGINS } from '../../packages/server/src/modules/studio/contracts/system-plugins'
import { workerEnvironment } from '../../packages/server/src/modules/studio/services/plugins/worker'
import type { AgentRunContext, PluginManifest } from '../../packages/studio-plugin-sdk/src'

let root: string, runner: string
const cleanup: Array<() => Promise<void>> = []
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'studio-plugin-tests-'))
  runner = join(root, 'runner.cjs')
  await build({ entryPoints: ['packages/studio-plugin-runner/src/main.ts'], bundle: true, platform: 'node', target: 'node23', format: 'cjs', outfile: runner, logLevel: 'silent' })
})
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

function setup(sessions: ContextServices['sessions'] = { get: async () => null }) {
  const db = new DatabaseSync(':memory:')
  const store = new PluginStore(db), registry = new AgentRegistry(), events = new PluginEventBus(), eventStore = new PluginEventStore(db)
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const ctx = (signal: AbortSignal) => createExecutionContext({
    scopeId: 'scope', principal: { id: '1', kind: 'user' }, profileId: 'default', surface: 'api', traceId: 'trace', runId: 'run',
  }, signal, logger, { authorize: async () => {}, sessions, agents: { list: async profile => registry.list(profile) } })
  const host = new PluginHost({ store, registry, events, runnerPath: runner, artifactsRoot: join(root, 'artifacts'), logger,
    eventContext: async (_state, _event, signal) => ctx(signal), acceptEvents: async batch => { for (const event of eventStore.append(batch)) events.publish(event) } })
  const coordinator = new AgentCoordinator({ store: new AgentExecutionStore(db), registry, events, logger, authorize: () => {},
    context: (scope, signal) => createExecutionContext(scope, signal, logger, { authorize: async () => {}, sessions, agents: { list: async profile => registry.list(profile) },
      runs: { get: async (scope, id) => coordinator.get(scope, id), output: async (scope, id, after) => coordinator.output(scope, id, after) } }) })
  cleanup.push(async () => { await coordinator.close(); await host.close(); events.close(); db.close() })
  return { db, store, registry, events, logger, host, ctx, coordinator, eventStore }
}

describe('plugin worker integration', () => {
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
    const scope = ctx(new AbortController().signal).scope
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
    const scope = ctx(new AbortController().signal).scope
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
    const scope = ctx(new AbortController().signal).scope
    const instance = coordinator.createInstance(scope, { agentTypeId: 'test.context/agent', config: {}, mode: 'scoped' })
    const run = coordinator.start(scope, instance.id, { content: [{ type: 'text', text: 'go' }] }, 'context-request')
    await coordinator.wait(run.id)
    expect(coordinator.get(scope, run.id).status).toBe('completed')
    expect(coordinator.output(scope, run.id, -1)).toMatchObject([{ text: 'running:true' }])
  }, 20_000)
})
