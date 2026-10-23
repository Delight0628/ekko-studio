import { randomUUID } from 'node:crypto'
import {
  StudioError, type AgentRunHandle, type AgentRunInput, type AgentRunContext, type AgentRuntime,
  type ExecutionScope, type ExecutionContext, type JsonObject, type ScopedLogger,
} from '../../contracts/plugins'
import { AgentExecutionStore, type AgentInstance, type AgentExecution } from '../../repositories/agent-execution-store'
import { AgentRegistry } from './registry'
import { PluginEventBus } from '../events/plugin-events'
import { compileSchema, jsonCopy, parseAgentOutput } from '../plugins/validation'

interface ActiveRun { controller: AbortController; handle?: AgentRunHandle; completed: Promise<void> }
export class AgentCoordinator {
  private readonly active = new Map<string, ActiveRun>()
  private closed = false
  constructor(private readonly options: {
    store: AgentExecutionStore; registry: AgentRegistry; events: PluginEventBus; logger: ScopedLogger
    authorize(scope: ExecutionScope): void
    context(scope: ExecutionScope, signal: AbortSignal): ExecutionContext
  }) {}

  createInstance(scope: ExecutionScope, input: { agentTypeId: string; config: JsonObject; mode: 'scoped' | 'global' }): AgentInstance {
    this.options.authorize(scope)
    const { definition } = this.options.registry.resolve(scope.profileId, input.agentTypeId)
    compileSchema(definition.configSchema)(input.config)
    if (!definition.capabilities.modes.includes(input.mode)) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Unsupported Agent mode')
    return this.options.store.createInstance({ ...jsonCopy(input), profileId: scope.profileId, ownerId: scope.principal.id })
  }

  listInstances(scope: ExecutionScope): AgentInstance[] {
    this.options.authorize(scope)
    return this.options.store.instances(scope.principal.id, scope.profileId)
  }

  start(scope: ExecutionScope, instanceId: string, input: AgentRunInput, idempotencyKey: string): AgentExecution {
    if (this.closed) throw new StudioError('RUNTIME_UNAVAILABLE', 'Agent coordinator is shutting down')
    this.options.authorize(scope)
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 128) throw new StudioError('INVALID_ARGUMENT', 'An idempotency key is required')
    const instance = this.options.store.instance(instanceId)
    if (!instance || instance.ownerId !== scope.principal.id || instance.profileId !== scope.profileId) throw new StudioError('NOT_FOUND', 'Agent instance is unavailable')
    input = jsonCopy(input)
    const previous = this.options.store.findRequest(instance, input, idempotencyKey)
    if (previous) return previous
    const { definition, provider } = this.options.registry.resolve(scope.profileId, instance.agentTypeId)
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['content', 'model', 'timeoutMs'].includes(key))) throw new StudioError('INVALID_ARGUMENT', 'Invalid run input')
    if (!Array.isArray(input.content) || !input.content.length || input.content.length > 100) throw new StudioError('INVALID_ARGUMENT', 'Run content is required')
    for (const block of input.content) {
      if (!block || typeof block !== 'object' || block.type !== 'text' || typeof block.text !== 'string') throw new StudioError('CAPABILITY_UNSUPPORTED', 'This execution endpoint currently accepts text blocks')
      if (Object.keys(block).some(key => !['type', 'text'].includes(key))) throw new StudioError('INVALID_ARGUMENT', 'Unknown content property')
    }
    if (input.model !== undefined && (typeof input.model !== 'string' || !input.model.trim() || input.model.length > 256)) throw new StudioError('INVALID_ARGUMENT', 'Invalid model')
    if (!definition.capabilities.text) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Agent does not support text input')
    if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 3_600_000)) throw new StudioError('INVALID_ARGUMENT', 'Invalid run deadline')
    const accepted = this.options.store.accept(instance, provider, jsonCopy(input), idempotencyKey)
    if (!accepted.created) return accepted.run
    const controller = new AbortController()
    const active: ActiveRun = { controller, completed: Promise.resolve() }
    this.active.set(accepted.run.id, active)
    active.completed = this.execute(accepted.run, instance, input, scope, active).finally(() => this.active.delete(accepted.run.id))
    void active.completed.catch(() => this.options.logger.error('Agent execution finalization failed', { runId: accepted.run.id }))
    return accepted.run
  }

  get(scope: ExecutionScope, id: string): AgentExecution {
    this.options.authorize(scope)
    const run = this.options.store.get(id)
    if (!run || run.ownerId !== scope.principal.id || run.profileId !== scope.profileId) throw new StudioError('NOT_FOUND', 'Run is unavailable')
    return run
  }
  output(scope: ExecutionScope, id: string, after: number) {
    this.get(scope, id)
    if (!Number.isSafeInteger(after) || after < -1) throw new StudioError('INVALID_ARGUMENT', 'Invalid output cursor')
    return this.options.store.output(id, after)
  }
  async cancel(scope: ExecutionScope, id: string): Promise<AgentExecution> {
    const run = this.get(scope, id)
    if (!this.options.store.transition(id, ['accepted', 'starting', 'running'], 'cancelling')) return run
    const active = this.active.get(id)
    // The execution owns cancellation dispatch; HTTP acknowledgement must not wait on a broken provider.
    active?.controller.abort()
    return this.get(scope, id)
  }

  async wait(id: string): Promise<void> { await this.active.get(id)?.completed }
  async close(): Promise<void> {
    this.closed = true
    for (const active of this.active.values()) active.controller.abort()
    await Promise.allSettled([...this.active.values()].map(active => active.completed))
  }

  private async execute(run: AgentExecution, instance: AgentInstance, input: AgentRunInput, scope: ExecutionScope, active: ActiveRun): Promise<void> {
    let runtime: AgentRuntime | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    const runtimeController = new AbortController()
    const runtimeSessionId = randomUUID()
    const finish = (status: 'completed' | 'cancelled' | 'failed' | 'interrupted', error: string | null) => {
      for (const event of this.options.store.finish(run.id, status, error)) this.options.events.publish(event)
    }
    let rejectAbort!: (error: Error) => void
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject })
    void aborted.catch(() => {})
    const onAbort = () => {
      void active.handle?.cancel('Execution cancelled').catch(() => {})
      deadline = setTimeout(() => rejectAbort(new StudioError('DEADLINE_EXCEEDED', 'Agent did not stop within cancellation deadline')), 5_000)
    }
    active.controller.signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => active.controller.abort(), input.timeoutMs ?? 600_000)
    let ended = false
    try {
      this.options.store.transition(run.id, ['accepted'], 'starting')
      const resolved = this.options.registry.resolve(scope.profileId, instance.agentTypeId)
      const creating = resolved.definition.create({ instanceId: instance.id, config: instance.config, configRevision: instance.revision, mode: instance.mode }, {
        provider: run.provider, runtimeSessionId, profileId: scope.profileId, signal: runtimeController.signal, logger: this.options.logger,
      })
      // A slow factory may resolve after the deadline. It still owes us disposal.
      void creating.then(late => { if (ended) void late.dispose('Runtime creation exceeded deadline').catch(() => {}) }).catch(() => {})
      runtime = await Promise.race([creating, aborted])
      if (active.controller.signal.aborted) { finish('cancelled', null); return }
      const context = this.options.context({ ...scope, runId: run.id }, active.controller.signal)
      const runContext: AgentRunContext = { ...context, scope: { ...context.scope, runId: run.id, runtimeSessionId } }
      this.options.store.transition(run.id, ['starting'], 'running')
      const starting = runtime.run(input, runContext)
      void starting.then(late => { if (ended) { void late.result.catch(() => {}); void late.cancel('Run start exceeded deadline').catch(() => {}) } }).catch(() => {})
      active.handle = await Promise.race([starting, aborted])
      if (active.controller.signal.aborted) void active.handle.cancel('Execution cancelled').catch(() => {})
      let sequence = -1
      const [result] = await Promise.race([
        Promise.all([active.handle.result, (async () => {
          for await (const raw of active.handle!.events) {
            if (ended) break
            const event = parseAgentOutput(raw)
            if (event.producerSequence <= sequence) throw new StudioError('INVALID_ARGUMENT', 'Agent output is out of sequence')
            sequence = event.producerSequence
            this.options.store.appendOutput(run.id, event)
          }
        })()]),
        aborted,
      ])
      if (!result || !['completed', 'cancelled'].includes(result.status)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Agent result')
      const cancelling = this.options.store.get(run.id)?.status === 'cancelling'
      finish(cancelling || result.status === 'cancelled' ? 'cancelled' : active.controller.signal.aborted ? 'interrupted' : 'completed', null)
    } catch (error) {
      finish(error instanceof StudioError && ['PLUGIN_UNAVAILABLE', 'DEADLINE_EXCEEDED'].includes(error.code) ? 'interrupted' : 'failed', error instanceof StudioError ? error.code : 'INTERNAL')
    } finally {
      ended = true
      active.controller.signal.removeEventListener('abort', onAbort)
      if (timer) clearTimeout(timer)
      if (deadline) clearTimeout(deadline)
      active.controller.abort()
      runtimeController.abort()
      if (runtime) {
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([runtime.dispose('Run ended').catch(() => {}), new Promise<void>(resolve => { cleanupTimer = setTimeout(resolve, 5_000) })])
        if (cleanupTimer) clearTimeout(cleanupTimer)
      }
    }
  }
}
