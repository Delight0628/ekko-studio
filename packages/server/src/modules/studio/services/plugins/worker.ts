import { fork, execFile, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { RpcPeer, type RpcFrame } from '../../../../../../studio-plugin-sdk/src/rpc'
import {
  StudioError, STUDIO_ERROR_CODES, STUDIO_PLUGIN_RPC_VERSION, type StudioErrorCode, type AgentTypeDefinition, type AgentRuntime,
  type AgentRunContext, type AgentRunHandle, type AgentOutputEvent, type AgentRunResult,
  type ExecutionContext, type JsonValue, type JsonObject, type PluginIdentity, type ScopedLogger,
} from '../../contracts/plugins'
import { jsonCopy, toJson, parseAgentOutput } from './validation'
import { AsyncChannel } from './channel'

export interface WorkerActivation {
  agents: Array<Omit<AgentTypeDefinition, 'create'>>
  subscriptions: Array<{ id: string; type: string; once: boolean }>
}
interface RemoteRun {
  channel: AsyncChannel<AgentOutputEvent>
  resolve(result: AgentRunResult): void
  reject(error: unknown): void
  release(): void
  sequence: number
}

export function workerEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { NODE_ENV: 'production', ELECTRON_RUN_AS_NODE: '1' }
  for (const [key, value] of Object.entries(parent)) {
    if (['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'SystemRoot', 'COMSPEC', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG'].includes(key) || key.startsWith('LC_')) result[key] = value
  }
  return result
}

export class PluginWorker {
  readonly peer: RpcPeer
  private readonly child: ChildProcess
  private readonly scopes = new Map<string, ExecutionContext>()
  private readonly runs = new Map<string, RemoteRun>()
  private readonly runtimes = new Set<string>()
  private closed = false
  private closing?: Promise<void>
  private readonly exit: Promise<void>

  constructor(runnerPath: string, private readonly logger: ScopedLogger, private readonly onExit: () => void, private readonly authorize: (capability: string) => void, timeoutMs = 30_000) {
    this.child = fork(runnerPath, [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'json', env: workerEnvironment(process.env),
      execArgv: [], detached: process.platform !== 'win32',
    })
    this.peer = new RpcPeer({ send: frame => new Promise((resolve, reject) => {
      if (!this.child.connected) { reject(new StudioError('PLUGIN_UNAVAILABLE', 'Plugin worker disconnected')); return }
      this.child.send(frame, error => error ? reject(error) : resolve())
    }) }, timeoutMs)
    this.exit = new Promise(resolve => this.child.once('close', () => { this.fail(); resolve() }))
    this.child.on('error', () => this.fail())
    this.child.on('disconnect', () => this.fail())
    this.child.on('message', value => {
      try {
        const frame = jsonCopy(value) as RpcFrame
        if (!frame || typeof frame !== 'object' || !Number.isSafeInteger(frame.id) || !['request', 'response', 'error'].includes(frame.kind)) throw new Error('Malformed frame')
        void this.peer.receive(frame).catch(() => { this.fail(); void this.close() })
      } catch { this.fail(); void this.close() }
    })
    this.child.stdout?.on('data', (chunk: Buffer) => logger.info('Plugin stdout', { text: chunk.toString('utf8').slice(0, 4096) }))
    this.child.stderr?.on('data', (chunk: Buffer) => logger.warn('Plugin stderr', { text: chunk.toString('utf8').slice(0, 4096) }))
    this.peer.handle('context.call', value => this.contextCall(value))
    this.peer.handle('run.event', async value => {
      const params = value as JsonObject, run = this.runs.get(String(params.runId))
      if (!run) throw new StudioError('NOT_FOUND', 'Run is not active')
      const event = parseAgentOutput(params.event)
      if (!event || !Number.isSafeInteger(event.producerSequence) || event.producerSequence <= run.sequence) throw new StudioError('INVALID_ARGUMENT', 'Invalid Agent event sequence')
      run.sequence = event.producerSequence
      await run.channel.push(event)
      return null
    })
    this.peer.handle('run.result', value => {
      const params = value as JsonObject, run = this.runs.get(String(params.runId))
      if (!run) throw new StudioError('NOT_FOUND', 'Run is not active')
      const result = params.result as unknown as AgentRunResult
      if (!result || !['completed', 'cancelled'].includes(result.status)) throw new StudioError('INVALID_ARGUMENT', 'Invalid run result')
      run.channel.finish(); run.resolve(jsonCopy(result)); run.release(); this.runs.delete(String(params.runId))
      return null
    })
    this.peer.handle('run.error', value => {
      const id = String((value as JsonObject).runId), run = this.runs.get(id)
      if (run) {
        const detail = (value as JsonObject).error as JsonObject | undefined
        const code = typeof detail?.code === 'string' && (STUDIO_ERROR_CODES as readonly string[]).includes(detail.code) ? detail.code as StudioErrorCode : 'RUNTIME_UNAVAILABLE'
        const error = new StudioError(code, 'Plugin Agent run failed')
        run.channel.finish(error); run.reject(error); run.release(); this.runs.delete(id)
      }
      return null
    })
  }

  async activate(entry: string, identity: PluginIdentity, config: JsonObject): Promise<WorkerActivation> {
    const result = await this.peer.request('activate', toJson({ entry, identity, config, rpc: STUDIO_PLUGIN_RPC_VERSION })) as JsonObject
    if (!result || result.rpc !== STUDIO_PLUGIN_RPC_VERSION || !Array.isArray(result.agents) || !Array.isArray(result.subscriptions)) {
      throw new StudioError('INVALID_ARGUMENT', 'Invalid plugin activation response')
    }
    return result as unknown as WorkerActivation
  }

  definition(meta: Omit<AgentTypeDefinition, 'create'>): AgentTypeDefinition {
    return {
      ...jsonCopy(meta),
      create: async (input, context): Promise<AgentRuntime> => {
        const id = context.runtimeSessionId
        if (context.signal.aborted) throw new StudioError('CANCELLED', 'Runtime scope ended')
        if (this.runtimes.has(id)) throw new StudioError('REGISTRATION_CONFLICT', 'Runtime is already active')
        // Creation itself owns a lease: configuration changes must not kill an in-flight factory.
        this.runtimes.add(id)
        try { await this.peer.request('runtime.create', toJson({ agentTypeId: meta.id, runtimeSessionId: id, input })) }
        catch (error) { this.runtimes.delete(id); await this.close(); throw error }
        const dispose = async (reason: string): Promise<void> => {
          if (!this.runtimes.delete(id)) return
          context.signal.removeEventListener('abort', aborted)
          try { await this.peer.request('runtime.dispose', { runtimeSessionId: id, reason }, 5_000) }
          catch (error) { await this.close(); throw error }
        }
        const aborted = () => { void dispose('Runtime scope ended').catch(() => {}) }
        context.signal.addEventListener('abort', aborted, { once: true })
        if (context.signal.aborted) { await dispose('Runtime scope ended'); throw new StudioError('CANCELLED', 'Runtime scope ended') }
        return {
          run: (runInput, ctx) => this.startRun(id, runInput, ctx),
          checkpoint: () => this.peer.request('runtime.checkpoint', { runtimeSessionId: id }),
          dispose,
        }
      },
    }
  }

  async withContext<T>(ctx: ExecutionContext, action: (handle: string) => Promise<T>): Promise<T> {
    const handle = randomUUID()
    this.scopes.set(handle, ctx)
    try { return await action(handle) } finally { this.scopes.delete(handle) }
  }

  private async startRun(runtimeSessionId: string, input: Parameters<AgentRuntime['run']>[0], ctx: AgentRunContext): Promise<AgentRunHandle> {
    if (ctx.signal.aborted) throw new StudioError('CANCELLED', 'Run scope ended')
    const runId = ctx.scope.runId
    if (this.runs.has(runId)) throw new StudioError('REGISTRATION_CONFLICT', 'Run is already active')
    const scopeHandle = randomUUID()
    this.scopes.set(scopeHandle, ctx)
    const cancel = async (reason: string): Promise<void> => { await this.peer.request('run.cancel', { runId, reason }) }
    const aborted = () => { void cancel('Execution scope ended').catch(() => {}) }
    const channel = new AsyncChannel<AgentOutputEvent>(128, aborted)
    let resolve!: (value: AgentRunResult) => void, reject!: (error: unknown) => void
    const result = new Promise<AgentRunResult>((yes, no) => { resolve = yes; reject = no })
    void result.catch(() => {})
    const release = () => { this.scopes.delete(scopeHandle); ctx.signal.removeEventListener('abort', aborted) }
    this.runs.set(runId, { channel, resolve, reject, release, sequence: -1 })
    ctx.signal.addEventListener('abort', aborted, { once: true })
    let canRespond = false
    try {
      const response = await this.peer.request('run.start', toJson({ runId, runtimeSessionId, input, scope: ctx.scope, scopeHandle }))
      canRespond = !!(response && typeof response === 'object' && !Array.isArray(response) && response.respond === true)
    }
    catch (error) { channel.finish(error); reject(error); release(); this.runs.delete(runId); throw error }
    return { events: channel, result, cancel,
      ...(canRespond ? { respond: async (input: Parameters<NonNullable<AgentRunHandle['respond']>>[0]) => { await this.peer.request('run.respond', toJson({ runId, input })) } } : {}),
    }
  }

  hasLeases(): boolean { return this.runtimes.size > 0 || this.runs.size > 0 }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      if (!this.closed) await this.peer.request('dispose', {}, 2_000).catch(() => {})
      this.fail()
      if (this.child.pid) {
        if (process.platform === 'win32') {
          await new Promise<void>(resolve => execFile('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], () => resolve()))
        } else {
          try { process.kill(-this.child.pid, 'SIGKILL') } catch { this.child.kill('SIGKILL') }
        }
      }
      await this.exit
    })()
  }

  private async contextCall(value: JsonValue): Promise<JsonValue> {
    const params = value as JsonObject
    const ctx = this.scopes.get(String(params.scopeHandle))
    if (!ctx || ctx.signal.aborted) throw new StudioError('FORBIDDEN', 'Execution scope is unavailable')
    if (params.method === 'workflows.run') {
      this.authorize('workflows.run')
      return toJson(await ctx.workflows.run(params.args as unknown as Parameters<ExecutionContext['workflows']['run']>[0]))
    }
    if (params.method === 'workflows.get' || params.method === 'workflows.cancel') {
      this.authorize(params.method === 'workflows.get' ? 'workflows.read' : 'workflows.cancel')
      const args = params.args as JsonObject
      if (!args || typeof args.id !== 'string' || Object.keys(args).some(key => key !== 'id')) throw new StudioError('INVALID_ARGUMENT', 'Only a workflow run id is accepted')
      return toJson(params.method === 'workflows.get' ? await ctx.workflows.get(args.id) : await ctx.workflows.cancel(args.id))
    }
    if (params.method === 'chat.start') {
      this.authorize('chat.start')
      return toJson(await ctx.chat.start(params.args as unknown as Parameters<ExecutionContext['chat']['start']>[0]))
    }
    if (params.method === 'chat.get' || params.method === 'chat.cancel') {
      this.authorize(params.method === 'chat.get' ? 'chat.read' : 'chat.cancel')
      const args = params.args as JsonObject
      if (!args || typeof args.id !== 'string' || Object.keys(args).some(key => key !== 'id')) throw new StudioError('INVALID_ARGUMENT', 'Only a chat receipt id is accepted')
      return toJson(params.method === 'chat.get' ? await ctx.chat.get(args.id) : await ctx.chat.cancel(args.id))
    }
    if (params.method === 'sessions.get' || params.method === 'sessions.remove') {
      this.authorize(params.method === 'sessions.get' ? 'sessions.read' : 'sessions.remove')
      const args = params.args as JsonObject
      if (!args || typeof args.id !== 'string' || Object.keys(args).some(key => key !== 'id')) throw new StudioError('INVALID_ARGUMENT', 'Only a session id is accepted')
      return toJson(params.method === 'sessions.get' ? await ctx.sessions.get(args.id) : await ctx.sessions.remove(args.id))
    }
    if (params.method === 'agents.list') { this.authorize('agents.read'); return jsonCopy(await ctx.agents.list()) as unknown as JsonValue }
    if (params.method === 'runs.start') {
      this.authorize('runs.start')
      return toJson(await ctx.runs.start(params.args as unknown as Parameters<ExecutionContext['runs']['start']>[0]))
    }
    if (['runs.cancel', 'runs.interactions', 'runs.respond', 'runs.usage'].includes(String(params.method))) {
      this.authorize(params.method === 'runs.cancel' ? 'runs.cancel' : params.method === 'runs.respond' ? 'runs.respond' : 'runs.read')
      const args = params.args as JsonObject
      if (!args || typeof args.id !== 'string' || Object.keys(args).some(key => key !== 'id' && !(params.method === 'runs.respond' && key === 'input'))) throw new StudioError('INVALID_ARGUMENT', 'Invalid run operation')
      if (params.method === 'runs.cancel') return toJson(await ctx.runs.cancel(args.id))
      if (params.method === 'runs.interactions') return toJson(await ctx.runs.interactions(args.id))
      if (params.method === 'runs.usage') return toJson(await ctx.runs.usage(args.id))
      return toJson(await ctx.runs.respond(args.id, args.input as unknown as Parameters<ExecutionContext['runs']['respond']>[1]))
    }
    if (params.method === 'runs.get' || params.method === 'runs.output') {
      this.authorize('runs.read')
      const args = params.args as JsonObject
      if (!args || typeof args.id !== 'string') throw new StudioError('INVALID_ARGUMENT', 'Run id is required')
      return toJson(params.method === 'runs.get' ? await ctx.runs.get(args.id) : await ctx.runs.output(args.id, args.after === undefined ? -1 : Number(args.after)))
    }
    throw new StudioError('FORBIDDEN', 'Unknown context operation')
  }

  private fail(): void {
    if (this.closed) return
    this.closed = true
    this.peer.close()
    const error = new StudioError('PLUGIN_UNAVAILABLE', 'Plugin worker exited')
    for (const run of this.runs.values()) { run.channel.finish(error); run.reject(error); run.release() }
    this.runs.clear(); this.runtimes.clear(); this.scopes.clear()
    try { this.onExit() } catch { this.logger.error('Plugin cleanup failed') }
  }
}
