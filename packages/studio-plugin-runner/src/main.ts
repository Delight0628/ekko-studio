import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { RpcPeer, type RpcFrame } from '../../studio-plugin-sdk/src/rpc'
import {
  StudioError, STUDIO_PLUGIN_RPC_VERSION,
  type AgentTypeDefinition, type AgentRuntime, type AgentRuntimeContext, type AgentRunHandle,
  type AgentRunContext, type ExecutionContext, type ExecutionScope, type PluginIdentity,
  type JsonObject, type JsonValue, type PluginContext, type StudioPlugin, type Disposer,
  type ScopedLogger, type RuntimeCreateInput, type AgentRunInput, type AgentProviderRef, type EventEnvelope,
} from '../../studio-plugin-sdk/src'

const peer = new RpcPeer({ send: frame => new Promise((resolve, reject) => {
  if (!process.connected || !process.send) { reject(new StudioError('PLUGIN_UNAVAILABLE', 'Host disconnected')); return }
  process.send(frame, error => error ? reject(error) : resolve())
}) })
const definitions = new Map<string, AgentTypeDefinition>()
const runtimes = new Map<string, { runtime: AgentRuntime; controller: AbortController }>()
const runs = new Map<string, { handle: AgentRunHandle; controller: AbortController }>()
const callbacks = new Map<string, { type: string; once: boolean; handler: (event: EventEnvelope, ctx: ExecutionContext) => void | Promise<void> }>()
const disposers: Disposer[] = []
let identity: PluginIdentity | undefined
let active = false
let activated = false

const object = (value: JsonValue): JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StudioError('INVALID_ARGUMENT', 'Expected object')
  return value
}
const string = (value: JsonValue | undefined): string => {
  if (typeof value !== 'string') throw new StudioError('INVALID_ARGUMENT', 'Expected string')
  return value
}
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue
const logger: ScopedLogger = {
  info: (message, data) => console.info(JSON.stringify({ level: 'info', message, data })),
  warn: (message, data) => console.warn(JSON.stringify({ level: 'warn', message, data })),
  error: (message, data) => console.error(JSON.stringify({ level: 'error', message, data })),
}

function executionContext(scope: ExecutionScope, scopeHandle: string, signal: AbortSignal): ExecutionContext {
  const call = async (method: string, args: JsonValue) => {
    if (signal.aborted) throw new StudioError('CANCELLED', 'Scope ended')
    return peer.request('context.call', { scopeHandle, method, args })
  }
  return {
    scope: Object.freeze({ ...scope, principal: Object.freeze({ ...scope.principal }) }), signal, logger,
    chat: {
      start: async input => await call('chat.start', json(input)) as unknown as Awaited<ReturnType<ExecutionContext['chat']['start']>>,
      get: async id => await call('chat.get', { id }) as unknown as Awaited<ReturnType<ExecutionContext['chat']['get']>>,
      cancel: async id => await call('chat.cancel', { id }) as unknown as Awaited<ReturnType<ExecutionContext['chat']['cancel']>>,
    },
    sessions: {
      get: async id => await call('sessions.get', { id }) as unknown as Awaited<ReturnType<ExecutionContext['sessions']['get']>>,
      remove: async id => await call('sessions.remove', { id }) as unknown as Awaited<ReturnType<ExecutionContext['sessions']['remove']>>,
    },
    agents: { list: async () => await call('agents.list', {}) as unknown as Awaited<ReturnType<ExecutionContext['agents']['list']>> },
    runs: {
      start: async input => await call('runs.start', json(input)) as unknown as Awaited<ReturnType<ExecutionContext['runs']['start']>>,
      get: async id => await call('runs.get', { id }) as unknown as Awaited<ReturnType<ExecutionContext['runs']['get']>>,
      output: async (id, after = -1) => await call('runs.output', { id, after }) as unknown as Awaited<ReturnType<ExecutionContext['runs']['output']>>,
      cancel: async id => await call('runs.cancel', { id }) as unknown as Awaited<ReturnType<ExecutionContext['runs']['cancel']>>,
      interactions: async id => await call('runs.interactions', { id }) as unknown as Awaited<ReturnType<ExecutionContext['runs']['interactions']>>,
      respond: async (id, input) => await call('runs.respond', { id, input: json(input) }) as unknown as Awaited<ReturnType<ExecutionContext['runs']['respond']>>,
      usage: async id => await call('runs.usage', { id }) as unknown as Awaited<ReturnType<ExecutionContext['runs']['usage']>>,
    },
  }
}

peer.handle('activate', async value => {
  if (activated) throw new StudioError('REGISTRATION_CONFLICT', 'Worker already activated')
  activated = true
  const params = object(value)
  if (params.rpc !== STUDIO_PLUGIN_RPC_VERSION) throw new StudioError('PLUGIN_VERSION_INCOMPATIBLE', 'RPC version mismatch')
  identity = object(params.identity) as unknown as PluginIdentity
  const registerDisposer = (dispose: Disposer): Disposer => {
    let result: Promise<void> | undefined
    const once = () => result ??= Promise.resolve().then(dispose)
    disposers.push(once)
    return once
  }
  const subscribe = (type: string, handler: unknown, once: boolean): Disposer => {
    if (active || typeof handler !== 'function') throw new StudioError('INVALID_ARGUMENT', 'Subscribe during plugin activation')
    const id = randomUUID()
    callbacks.set(id, { type, handler: handler as (event: EventEnvelope, ctx: ExecutionContext) => void | Promise<void>, once })
    return registerDisposer(async () => {
      callbacks.delete(id)
      if (active) await peer.request('subscription.remove', { id })
    })
  }
  const ctx: PluginContext = {
    plugin: Object.freeze(identity), config: Object.freeze(object(params.config)), logger,
    agents: { register: definition => {
      if (active || definitions.has(definition.id)) throw new StudioError('REGISTRATION_CONFLICT', 'Agent already registered or activation ended')
      definitions.set(definition.id, definition)
      return registerDisposer(async () => {
        definitions.delete(definition.id)
        if (active) await peer.request('agent.remove', { id: definition.id })
      })
    } },
    lifecycle: { onDispose: registerDisposer },
    on: (type, handler) => subscribe(type, handler, false),
    once: (type, handler) => subscribe(type, handler, true),
    emit: async (type, data) => object(await peer.request('event.emit', { type, data })) as unknown as { id: string },
  }
  const imported = await import(pathToFileURL(string(params.entry)).href)
  const plugin = (imported.default || imported) as StudioPlugin
  if (typeof plugin.apply !== 'function') throw new StudioError('INVALID_ARGUMENT', 'Plugin must export apply(ctx)')
  await plugin.apply(ctx)
  active = true
  return json({
    rpc: STUDIO_PLUGIN_RPC_VERSION,
    agents: [...definitions.values()].map(({ create: _create, ...definition }) => definition),
    subscriptions: [...callbacks].map(([id, { type, once }]) => ({ id, type, once })),
  })
})

peer.handle('runtime.create', async value => {
  const params = object(value)
  const definition = definitions.get(string(params.agentTypeId))
  if (!active || !definition || !identity) throw new StudioError('RUNTIME_UNAVAILABLE', 'Agent is unavailable')
  const id = string(params.runtimeSessionId)
  if (runtimes.has(id)) throw new StudioError('REGISTRATION_CONFLICT', 'Runtime already exists')
  const controller = new AbortController()
  const provider: AgentProviderRef = { kind: 'plugin', pluginId: identity.id, generation: identity.generation, version: identity.version }
  const ctx: AgentRuntimeContext = { provider, profileId: identity.profileId, runtimeSessionId: id, logger, signal: controller.signal }
  const runtime = await definition.create(object(params.input) as unknown as RuntimeCreateInput, ctx)
  runtimes.set(id, { runtime, controller })
  return null
})

peer.handle('run.start', async value => {
  const params = object(value)
  const runtime = runtimes.get(string(params.runtimeSessionId))
  if (!runtime) throw new StudioError('RUNTIME_UNAVAILABLE', 'Runtime is unavailable')
  const runId = string(params.runId)
  if (runs.has(runId)) throw new StudioError('REGISTRATION_CONFLICT', 'Run already exists')
  const controller = new AbortController()
  const ctx = executionContext(object(params.scope) as unknown as ExecutionScope, string(params.scopeHandle), controller.signal) as AgentRunContext
  const handle = await runtime.runtime.run(object(params.input) as unknown as AgentRunInput, ctx)
  runs.set(runId, { handle, controller })
  void (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let ended = false
    try {
      const expired = new Promise<never>((_, reject) => {
        void handle.result.then(() => { timer = setTimeout(() => reject(new StudioError('DEADLINE_EXCEEDED', 'Agent output did not drain')), 5_000) }).catch(() => {})
      })
      const [, result] = await Promise.race([Promise.all([
        (async () => { for await (const event of handle.events) { if (ended) break; await peer.request('run.event', { runId, event: json(event) }) } })(),
        handle.result,
      ]), expired])
      await peer.request('run.result', { runId, result: json(result) })
    } catch (error) {
      const safe = error instanceof StudioError ? error.toJSON() : new StudioError('INTERNAL', 'Agent run failed').toJSON()
      await peer.request('run.error', { runId, error: json(safe) }).catch(() => {})
    } finally { ended = true; if (timer) clearTimeout(timer); runs.delete(runId); controller.abort() }
  })()
  return { respond: typeof handle.respond === 'function' }
})

peer.handle('run.cancel', async value => {
  const params = object(value), run = runs.get(string(params.runId))
  if (run) { run.controller.abort(); await run.handle.cancel(string(params.reason)) }
  return null
})
peer.handle('run.respond', async value => {
  const params = object(value), run = runs.get(string(params.runId))
  if (!run || run.controller.signal.aborted) throw new StudioError('RUNTIME_UNAVAILABLE', 'Run is unavailable')
  if (!run.handle.respond) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Agent cannot respond to interactions')
  await run.handle.respond(object(params.input) as unknown as Parameters<NonNullable<AgentRunHandle['respond']>>[0])
  return null
})
peer.handle('runtime.dispose', async value => {
  const params = object(value), id = string(params.runtimeSessionId), runtime = runtimes.get(id)
  if (runtime) { runtimes.delete(id); runtime.controller.abort(); await runtime.runtime.dispose(string(params.reason)) }
  return null
})
peer.handle('runtime.checkpoint', async value => {
  const runtime = runtimes.get(string(object(value).runtimeSessionId))?.runtime
  if (!runtime?.checkpoint) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Checkpoint is unsupported')
  return runtime.checkpoint()
})
peer.handle('event.deliver', async value => {
  const params = object(value), id = string(params.id), subscription = callbacks.get(id)
  if (!subscription) return null
  if (subscription.once) callbacks.delete(id)
  const controller = new AbortController()
  try {
    await subscription.handler(object(params.event) as unknown as EventEnvelope,
      executionContext(object(params.scope) as unknown as ExecutionScope, string(params.scopeHandle), controller.signal))
  } finally { controller.abort() }
  return null
})

async function dispose(): Promise<void> {
  active = false
  for (const { handle, controller } of runs.values()) { controller.abort(); await handle.cancel('Plugin shutdown').catch(() => {}) }
  for (const { runtime, controller } of runtimes.values()) { controller.abort(); await runtime.dispose('Plugin shutdown').catch(() => {}) }
  for (const dispose of disposers.reverse()) { try { await dispose() } catch { /* Host also owns process cleanup. */ } }
  runs.clear(); runtimes.clear(); definitions.clear(); callbacks.clear()
}
peer.handle('dispose', async () => { await dispose(); return null })
process.on('message', message => { void peer.receive(message).catch(() => { peer.close(); if (process.connected) process.disconnect() }) })
process.once('disconnect', () => { peer.close(); void dispose().finally(() => process.exit(0)) })
