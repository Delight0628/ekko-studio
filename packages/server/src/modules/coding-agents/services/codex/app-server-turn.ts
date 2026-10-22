import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { CodingAgentImageInput } from '../../protocol/types'

const REQUEST_TIMEOUT_MS = 30_000
export const CODEX_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000
const MAX_FRAME_CHARS = 16 * 1024 * 1024

interface PendingRequest {
  resolve(value: any): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

interface PendingApproval {
  rpcId: string | number
  timer: ReturnType<typeof setTimeout>
}

interface Callbacks {
  session(id: string): void
  event(method: string, params: any): void
  approval(request: { id: string; description: string; timeoutMs: number }): void
  approvalResolved(id: string, reason: string): void
  failed(message: string): void
  inputClosed(): void
  activity(): void
}

/** One foreground turn over Codex's stdio JSON-RPC transport. */
export class CodexAppServerTurn {
  private sequence = 0
  private pending = new Map<number, PendingRequest>()
  private approvals = new Map<string, PendingApproval>()
  private decoder = new StringDecoder('utf8')
  private buffer = ''
  private closed = false
  private threadId = ''
  private turnId = ''
  private startingTurn = false
  private earlyEvents: any[] = []
  completed = false

  constructor(private child: ChildProcess, private callbacks: Callbacks) {
    child.stdout?.on('data', (chunk: Buffer) => {
      if (this.closed) return
      this.callbacks.activity()
      try {
        this.buffer += this.decoder.write(chunk)
        let end: number
        while ((end = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, end).trim()
          this.buffer = this.buffer.slice(end + 1)
          if (line.length > MAX_FRAME_CHARS) throw new Error('Codex app-server frame exceeds 16 MiB')
          if (line.startsWith('{')) this.receive(JSON.parse(line))
        }
        if (this.buffer.length > MAX_FRAME_CHARS) throw new Error('Codex app-server frame exceeds 16 MiB')
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
    child.stdin?.on('error', error => this.fail(error))
    child.on('error', error => this.fail(error))
    child.on('close', () => {
      if (!this.completed && !this.closed) this.fail(new Error('Codex app-server closed before the turn completed'))
      else this.dispose()
    })
  }

  private write(message: object) {
    if (this.closed || !this.child.stdin?.writable) throw new Error('Codex app-server connection is closed')
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }

  private request(method: string, params: object): Promise<any> {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex app-server ${method} timed out`))
      }, REQUEST_TIMEOUT_MS)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      try { this.write({ id, method, params }) } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  async start(input: {
    cwd: string
    text: string
    images: CodingAgentImageInput[]
    nativeSessionId?: string
    model?: string
    developerInstructions?: string
  }): Promise<void> {
    try {
      await this.request('initialize', {
        clientInfo: { name: 'ekko_studio', version: '1.0.0' },
        capabilities: null,
      })
      this.write({ method: 'initialized' })
      const thread = await this.request(input.nativeSessionId ? 'thread/resume' : 'thread/start', {
        ...(input.nativeSessionId ? { threadId: input.nativeSessionId } : {}),
        cwd: input.cwd,
        ...(input.model ? { model: input.model } : {}),
        ...(input.developerInstructions ? { developerInstructions: input.developerInstructions } : {}),
        // Never means "reject dangerous commands without asking", even with no sandbox.
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: 'danger-full-access',
      })
      this.threadId = String(thread?.thread?.id || '')
      if (!this.threadId) throw new Error('Codex app-server returned no thread ID')
      this.callbacks.session(this.threadId)
      this.startingTurn = true
      const turn = await this.request('turn/start', {
        threadId: this.threadId,
        input: [
          ...(input.text ? [{ type: 'text', text: input.text, text_elements: [] }] : []),
          ...input.images.map(image => ({ type: 'localImage', path: image.path })),
        ],
      })
      this.turnId = String(turn?.turn?.id || '')
      if (!this.turnId) throw new Error('Codex app-server returned no turn ID')
      this.startingTurn = false
      for (const event of this.earlyEvents.splice(0)) this.receive(event)
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private receive(message: any) {
    if (!message || typeof message !== 'object' || this.closed) return
    if (message.method) {
      if (this.startingTurn) {
        if (this.earlyEvents.length >= 10_000) throw new Error('Too many Codex notifications before turn/start')
        this.earlyEvents.push(message)
      } else if (message.id !== undefined) {
        this.serverRequest(message)
      } else {
        this.notification(message.method, message.params || {})
      }
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error) pending.reject(new Error(`Codex app-server: ${message.error.message || 'request failed'}`))
    else pending.resolve(message.result)
  }

  private serverRequest(message: any) {
    const params = message.params || {}
    if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method)) {
      this.write({ id: message.id, error: { code: -32601, message: 'Unsupported Codex client method' } })
      return
    }
    // A saved thread may replay events; approvals must belong to this foreground turn.
    if (!this.threadId || params.threadId !== this.threadId
      || (!this.turnId && !this.startingTurn) || (this.turnId && params.turnId !== this.turnId)
      || this.completed) {
      this.write({ id: message.id, result: { decision: 'decline' } })
      return
    }
    if ([...this.approvals.values()].some(request => request.rpcId === message.id)) return
    const id = `codex_${randomUUID()}`
    const timer = setTimeout(() => {
      if (this.resolveApproval(id, 'deny').resolved) this.callbacks.approvalResolved(id, 'Codex approval expired')
    }, CODEX_APPROVAL_TIMEOUT_MS)
    timer.unref?.()
    this.approvals.set(id, { rpcId: message.id, timer })
    this.callbacks.approval({
      id,
      description: [params.reason, params.command, params.cwd, params.grantRoot].filter(value => typeof value === 'string').join('\n'),
      timeoutMs: CODEX_APPROVAL_TIMEOUT_MS,
    })
  }

  resolveApproval(id: string, choice: string): { handled: boolean; resolved: boolean } {
    const request = this.approvals.get(id)
    if (!request) return { handled: false, resolved: false }
    if (!['once', 'deny'].includes(choice)) return { handled: true, resolved: false }
    try {
      this.write({ id: request.rpcId, result: { decision: choice === 'once' ? 'accept' : 'decline' } })
    } catch {
      return { handled: true, resolved: false }
    }
    clearTimeout(request.timer)
    this.approvals.delete(id)
    this.callbacks.activity()
    return { handled: true, resolved: true }
  }

  private notification(method: string, params: any) {
    if (!this.threadId || params.threadId !== this.threadId) return
    const turnId = params.turnId || params.turn?.id
    if (!this.turnId || (turnId && turnId !== this.turnId) || this.completed) return
    if (method === 'turn/completed') {
      this.clearApprovals('Codex turn completed')
      if (params.turn?.status !== 'completed') {
        this.fail(new Error(params.turn?.error?.message || `Codex turn ${params.turn?.status || 'failed'}`))
        return
      }
      this.completed = true
      this.child.stdin?.end()
      this.callbacks.inputClosed()
      return
    }
    this.callbacks.event(method, params)
  }

  private clearApprovals(reason: string) {
    for (const [id, request] of this.approvals) {
      clearTimeout(request.timer)
      if (!this.closed) {
        try { this.write({ id: request.rpcId, result: { decision: 'decline' } }) } catch {}
      }
      this.callbacks.approvalResolved(id, reason)
    }
    this.approvals.clear()
  }

  private fail(error: Error) {
    if (this.closed) return
    this.callbacks.failed(error.message)
    this.dispose()
    this.child.stdin?.end()
    this.callbacks.inputClosed()
  }

  dispose() {
    if (this.closed) return
    this.clearApprovals('Codex connection closed')
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Codex app-server connection closed'))
    }
    this.pending.clear()
    this.earlyEvents = []
  }
}

/** CLI model selection belongs to thread/start; app-server only accepts config flags. */
export function codexAppServerArgs(args: string[]): string[] {
  const result = ['app-server', '--stdio']
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--model' || arg === '-m') {
      result.push('-c', `model=${JSON.stringify(args[++index] || '')}`)
    } else {
      result.push(arg)
    }
  }
  return result
}
