import { StudioError, type ExecutionContext, type JsonObject, type JsonValue, type ModelStreamEvent } from '../../studio-plugin-sdk/src'

export function remoteModels(call: (method: string, args: JsonValue) => Promise<JsonValue>): ExecutionContext['models'] {
  return Object.freeze({
    list: async () => await call('models.list', {}) as unknown as Awaited<ReturnType<ExecutionContext['models']['list']>>,
    get: async (id: string) => await call('models.get', { id }) as unknown as Awaited<ReturnType<ExecutionContext['models']['get']>>,
    stream: async (input: Parameters<ExecutionContext['models']['stream']>[0]) => {
      const opened = await call('models.open', JSON.parse(JSON.stringify(input))) as JsonObject
      const args = { handle: opened.handle }
      let closing: Promise<void> | undefined, reading = false
      const cancel = () => closing ??= call('models.close', args).then(() => {}, error => { closing = undefined; throw error })
      return Object.freeze({ id: String(opened.id), cancel, events: {
        [Symbol.asyncIterator]() {
          if (reading) throw new StudioError('REVISION_CONFLICT', 'Model stream already has a reader')
          reading = true
          return (async function* () {
            try {
              while (true) {
                const result = await call('models.next', args) as JsonObject
                if (result.pending) continue
                if (result.done) return
                yield result.event as unknown as ModelStreamEvent
              }
            } finally { await cancel() }
          })()
        },
      } })
    },
  })
}
