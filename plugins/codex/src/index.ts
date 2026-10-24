import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { AgentEventQueue, NativeRpcConnection } from '@ekko-studio/agent-drivers'
import { StudioError, type AgentOutputEvent, type AgentRunHandle, type AgentRunResult, type JsonObject, type StudioPlugin } from '@ekko-studio/plugin-sdk'
import { codexEvents } from './events'

type Output = AgentOutputEvent extends infer T ? T extends AgentOutputEvent ? Omit<T, 'producerSequence'> : never : never
const schema: JsonObject = {
  type: 'object', required: ['cwd'], additionalProperties: false,
  properties: {
    cwd: { type: 'string', minLength: 1, maxLength: 4096 },
    command: { type: 'string', minLength: 1, maxLength: 4096 },
    args: { type: 'array', maxItems: 128, items: { type: 'string', maxLength: 16384 } },
    env: { type: 'object', maxProperties: 128, additionalProperties: { type: 'string', maxLength: 32768 } },
    model: { type: 'string', minLength: 1, maxLength: 256 },
    effort: { type: 'string', minLength: 1, maxLength: 64 },
    developerInstructions: { type: 'string', maxLength: 65536 },
    approvalPolicy: { type: 'string', enum: ['untrusted', 'on-request', 'never'] },
    sandbox: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'] },
  },
}

interface Turn {
  id?: string
  cancelled: boolean
  notification(method: string, params: Record<string, any>): void
  request(method: string, params: Record<string, any>, signal: AbortSignal): Promise<unknown>
  handle: AgentRunHandle
}

export const apply: StudioPlugin['apply'] = plugin => {
  plugin.agents.register({
    id: 'codex', name: 'Codex', configSchema: schema,
    capabilities: { text: true, streaming: true, reasoning: true, approvals: true, resume: true, persistentSession: true, modes: ['global'] },
    async create(input, runtime) {
      const config = input.config, cwd = String(config.cwd)
      if (!isAbsolute(cwd)) throw new StudioError('INVALID_ARGUMENT', 'Codex working directory must be absolute')
      let threadId: string | undefined, resumed = false
      if (input.resume !== undefined) {
        const resume = input.resume as JsonObject
        if (!resume || typeof resume !== 'object' || Array.isArray(resume) || Object.keys(resume).some(key => key !== 'threadId')
          || typeof resume.threadId !== 'string' || !resume.threadId || resume.threadId.length > 4096) throw new StudioError('INVALID_ARGUMENT', 'Invalid Codex checkpoint')
        threadId = resume.threadId
      }
      const process = await runtime.processes.spawn({ command: String(config.command || 'codex'),
        args: [...(config.args as string[] || []), 'app-server', '--listen', 'stdio://'], cwd, env: config.env as Record<string, string> | undefined })
      let current: Turn | undefined, ended = false
      const rpc = new NativeRpcConnection(process, {
        notification(method, params) { current?.notification(method, params) },
        async request(method, params, signal) {
          if (!current) throw new Error('No active Codex turn')
          return current.request(method, params, signal)
        },
      })
      const aborted = () => { void rpc.close().catch(() => {}) }
      runtime.signal.addEventListener('abort', aborted, { once: true })
      try {
        await rpc.start()
        if (runtime.signal.aborted) throw new StudioError('CANCELLED', 'Codex runtime ended')
        await rpc.request('initialize', { clientInfo: { name: 'ekko_studio', title: 'Ekko Studio', version: '0.1.0' } })
        await rpc.notify('initialized')
      } catch (error) { runtime.signal.removeEventListener('abort', aborted); await rpc.close(); throw error }
      return {
        async run(input, ctx) {
          if (ended || current) throw new StudioError('RUNTIME_UNAVAILABLE', 'Codex runtime is unavailable or busy')
          if (input.content.some(block => block.type !== 'text')) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Codex instance runs currently accept text')
          const events = new AgentEventQueue<AgentOutputEvent>()
          let sequence = 0, ready!: () => void, complete!: (status: string) => void
          const started = new Promise<void>(resolve => { ready = resolve })
          const terminal = new Promise<string>(resolve => { complete = resolve })
          const pending = new Map<string, { resolve(value: string): void; choices: Set<string> }>()
          const emit = (event: Output) => events.push({ ...event, producerSequence: ++sequence } as AgentOutputEvent)
          const project = codexEvents(emit)
          const buffered: Array<[string, Record<string, any>]> = []
          let bufferedBytes = 0, cancelTask: Promise<void> | undefined
          const turn: Turn = { cancelled: ctx.signal.aborted, handle: undefined!,
            notification(method, params) {
              if (params.threadId !== threadId) return
              if (!turn.id) {
                bufferedBytes += Buffer.byteLength(JSON.stringify(params))
                if (buffered.length >= 128 || bufferedBytes > 4 * 1024 * 1024) throw new Error('Codex startup event limit exceeded')
                buffered.push([method, params]); return
              }
              if ((params.turnId || params.turn?.id) !== turn.id) return
              if (method === 'turn/completed') complete(String(params.turn?.status))
              else if (!turn.cancelled) project(method, params)
            },
            async request(method, params, signal) {
              await Promise.race([started, rpc.closed])
              if (params.threadId !== threadId || params.turnId !== turn.id || turn.cancelled || signal.aborted) throw new Error('Codex request is outside the current turn')
              if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) throw new Error('Unsupported Codex client request')
              const choices = ['accept', 'decline', 'cancel'].filter(choice => !Array.isArray(params.availableDecisions) || params.availableDecisions.includes(choice))
              if (!choices.length) return { decision: 'cancel' }
              const requestId = randomUUID()
              const decision = await new Promise<string>((resolve, reject) => {
                const abort = () => finish('cancel')
                const finish = (value: string) => { signal.removeEventListener('abort', abort); pending.delete(requestId); resolve(value) }
                pending.set(requestId, { resolve: finish, choices: new Set(choices) })
                signal.addEventListener('abort', abort, { once: true })
                try {
                  emit({ type: 'interaction.requested', kind: 'approval', requestId,
                    prompt: [params.reason, params.command, params.cwd, params.grantRoot].filter(value => typeof value === 'string').join('\n').slice(0, 16384) || 'Codex requests permission',
                    choices: choices.map(id => ({ id, label: id === 'accept' ? 'Allow once' : id === 'decline' ? 'Decline' : 'Cancel turn' })) })
                } catch (error) { signal.removeEventListener('abort', abort); pending.delete(requestId); reject(error) }
              })
              return { decision }
            },
          }
          current = turn
          const onAbort = () => { void turn.handle.cancel('Cancelled').catch(() => {}) }
          const result = (async (): Promise<AgentRunResult> => {
            try {
              if (turn.cancelled) return { status: 'cancelled' }
              if (!resumed) {
                const parameters = Object.fromEntries(['model', 'developerInstructions', 'approvalPolicy', 'sandbox'].filter(key => config[key] !== undefined).map(key => [key, config[key]]))
                const response = await rpc.request(threadId ? 'thread/resume' : 'thread/start', { ...parameters, cwd, ...(threadId ? { threadId } : {}) })
                if (typeof response?.thread?.id !== 'string' || !response.thread.id || response.thread.id.length > 4096
                  || (threadId && response.thread.id !== threadId)) throw new Error('Invalid Codex thread identity')
                threadId = response.thread.id; resumed = true
              }
              if (turn.cancelled) return { status: 'cancelled' }
              const response = await rpc.request('turn/start', { threadId, input: input.content,
                ...(input.model || config.model ? { model: input.model || config.model } : {}), ...(config.effort ? { effort: config.effort } : {}) })
              if (typeof response?.turn?.id !== 'string' || !response.turn.id || response.turn.id.length > 256) throw new Error('Invalid Codex turn identity')
              turn.id = response.turn.id; ready()
              for (const [method, params] of buffered.splice(0)) turn.notification(method, params)
              const status = await Promise.race([terminal, rpc.closed])
              if (turn.cancelled || status === 'interrupted') return { status: 'cancelled' }
              if (status !== 'completed') throw new StudioError('RUNTIME_UNAVAILABLE', 'Codex turn failed')
              return { status: 'completed', checkpoint: { threadId: threadId! } }
            } catch (error) {
              if (turn.cancelled) return { status: 'cancelled' }
              events.fail(error instanceof Error ? error : new Error('Codex execution failed'))
              throw error
            } finally {
              ready(); ctx.signal.removeEventListener('abort', onAbort)
              for (const entry of pending.values()) entry.resolve('cancel')
              events.end(); current = undefined
            }
          })()
          void result.catch(() => {})
          const handle: AgentRunHandle = { events, result,
            cancel() {
              if (cancelTask) return cancelTask
              turn.cancelled = true
              cancelTask = (async () => {
                // The process barrier also covers cancellation during thread/turn admission.
                if (turn.id) {
                  let timer: ReturnType<typeof setTimeout> | undefined
                  try { await Promise.race([rpc.request('turn/interrupt', { threadId, turnId: turn.id }, 2000).then(() => terminal),
                    new Promise(resolve => { timer = setTimeout(resolve, 2000) })]) } catch {} finally { clearTimeout(timer) }
                }
                await rpc.close(); await result.catch(() => {})
              })()
              return cancelTask
            },
            async respond(response) {
              const entry = pending.get(response.requestId)
              if (!entry || !response.choiceId || !entry.choices.has(response.choiceId) || response.text !== undefined) throw new StudioError('INVALID_ARGUMENT', 'Invalid Codex approval response')
              entry.resolve(response.choiceId)
            },
          }
          turn.handle = handle
          ctx.signal.addEventListener('abort', onAbort, { once: true })
          if (ctx.signal.aborted) onAbort()
          return handle
        },
        async dispose(reason) {
          ended = true; runtime.signal.removeEventListener('abort', aborted)
          try { await current?.handle.cancel(reason) } finally { await rpc.close() }
        },
      }
    },
  })
}
