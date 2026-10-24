import { randomUUID } from 'node:crypto'
import { StudioError, type ExecutionContext, type JsonObject, type JsonValue, type ModelStreamEvent, type ModelStreamHandle, type ModelStreamInput } from '../../contracts/plugins'
import { toJson } from './validation'

interface Stream {
  scope: string
  handle: ModelStreamHandle
  iterator: AsyncIterator<ModelStreamEvent>
  pending?: Promise<IteratorResult<ModelStreamEvent>>
  reading: boolean
  watch: ReturnType<typeof setInterval>
  closing?: Promise<void>
}

/** Opaque capabilities belong to one host-issued callback/run scope, never to plugin-supplied IDs. */
export class PluginModelBridge {
  private readonly streams = new Map<string, Stream>()
  private readonly opening = new Map<Promise<unknown>, string>()
  private readonly cleanupFailures = new Map<string, unknown>()
  private closed = false
  constructor(private readonly context: (scope: string, capability: string) => ExecutionContext) {}

  async call(scope: string, method: string, value: JsonValue): Promise<JsonValue> {
    if (method === 'models.open') {
      if (this.closed || this.streams.size + this.opening.size >= 64) throw new StudioError('RESOURCE_EXHAUSTED', 'Model stream limit exceeded')
      const ctx = this.context(scope, 'models.stream')
      const operation = (async () => {
        const handle = await ctx.models.stream(value as unknown as ModelStreamInput)
        try {
          if (this.closed) throw new StudioError('CANCELLED', 'Model bridge closed')
          this.context(scope, 'models.stream')
          const id = randomUUID()
          const stream: Stream = { scope, handle, iterator: handle.events[Symbol.asyncIterator](), reading: false,
            watch: setInterval(() => {
              try { this.context(scope, 'models.stream') } catch { void this.stop(stream).catch(() => {}) }
            }, 250) }
          this.streams.set(id, stream)
          return { id: handle.id, handle: id }
        } catch (error) {
          try { await handle.cancel() } catch (cleanupError) { this.cleanupFailures.set(scope, cleanupError); throw cleanupError }
          throw error
        }
      })()
      this.opening.set(operation, scope)
      try { return await operation } finally { this.opening.delete(operation) }
    }
    const args = value as JsonObject
    if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.handle !== 'string' || Object.keys(args).some(key => key !== 'handle')) throw new StudioError('INVALID_ARGUMENT', 'Invalid model stream handle')
    const stream = this.streams.get(args.handle)
    if (!stream || stream.scope !== scope) throw new StudioError('FORBIDDEN', 'Model stream is outside the execution scope')
    if (method === 'models.close') { await this.stop(stream); this.streams.delete(args.handle); return null }
    if (method !== 'models.next') throw new StudioError('FORBIDDEN', 'Unknown model stream operation')
    if (stream.reading) throw new StudioError('REVISION_CONFLICT', 'Model stream has a pending read')
    stream.reading = true
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      this.context(scope, 'models.stream')
      stream.pending ??= stream.iterator.next()
      const result = await Promise.race([stream.pending, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1_000) })])
      this.context(scope, 'models.stream')
      if (!result) return { pending: true }
      stream.pending = undefined
      return result.done ? { done: true } : toJson({ done: false, event: result.value })
    } catch (error) { await this.stop(stream); throw error }
    finally { clearTimeout(timer); stream.reading = false }
  }
  private stop(stream: Stream): Promise<void> {
    clearInterval(stream.watch)
    return stream.closing ??= stream.handle.cancel()
  }
  async closeScope(scope: string): Promise<void> {
    await Promise.allSettled([...this.opening].filter(([, owner]) => owner === scope).map(([pending]) => pending))
    const entries = [...this.streams].filter(([, stream]) => stream.scope === scope)
    const results = await Promise.allSettled(entries.map(([, stream]) => this.stop(stream)))
    for (const [index, [id]] of entries.entries()) if (results[index].status === 'fulfilled') this.streams.delete(id)
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
    if (this.cleanupFailures.has(scope)) throw this.cleanupFailures.get(scope)
  }
  async close(): Promise<void> {
    this.closed = true
    const scopes = new Set([...this.streams.values()].map(stream => stream.scope).concat([...this.opening.values()], [...this.cleanupFailures.keys()]))
    const results = await Promise.allSettled([...scopes].map(scope => this.closeScope(scope)))
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }
}
