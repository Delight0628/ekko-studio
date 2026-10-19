import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
const mocks = vi.hoisted(() => ({ grants: [] as any[], key: null as any }))
vi.mock('../../packages/server/src/modules/studio/repositories/app-connections-store', () => ({ listAppConnections: () => mocks.grants }))
vi.mock('../../packages/server/src/modules/studio/services/model-api/keys', () => ({ findModelApiKey: () => mocks.key }))
import { CloudModelApiSessions } from '../../packages/server/src/modules/studio/services/app-relay/model-api'

let bridge: CloudModelApiSessions
const key = `sk-ekko-${'a'.repeat(43)}`
const input = () => ({ id: randomUUID(), endpoint: 'responses', apiKey: key, studioUserId: 7, cloudUserId: 9, body: Buffer.from('{"input":"hi"}'), maxDownloadBytes: 100000 })
beforeEach(() => {
  mocks.key = { userId: 7 }
  mocks.grants = [{ connection_type: 'cloud', user_id: 7, cloud_user_id: 9, token_expires_at: Date.now() / 1000 + 600, revoked_at: null }]
})
afterEach(() => bridge?.cancelAll())

it('requires both the key owner and a valid formal cloud grant before fetching', async () => {
  const fetcher = vi.fn()
  bridge = new CloudModelApiSessions('http://127.0.0.1:8648', fetcher)
  mocks.key = { userId: 8 }
  expect(await bridge.open(input())).toMatchObject({ status: 403 })
  mocks.key = { userId: 7 }
  const base = mocks.grants[0]
  for (const grant of [[], [{ ...base, connection_type: 'lan' }], [{ ...base, cloud_user_id: 10 }], [{ ...base, token_expires_at: 1 }]]) {
    mocks.grants = grant
    expect(await bridge.open(input())).toMatchObject({ status: 403 })
  }
  expect(fetcher).not.toHaveBeenCalled()
})

it('returns the first SSE event before completion, preserves UTF-8 bytes and bounds every chunk', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const fetcher = vi.fn(async () => new Response(new ReadableStream({ start(c) { controller = c } }), { headers: { 'content-type': 'text/event-stream' } }))
  bridge = new CloudModelApiSessions('http://localhost:8648', fetcher)
  const request = input()
  expect(await bridge.open(request)).toMatchObject({ ok: true, contentType: 'text/event-stream' })
  expect(fetcher).toHaveBeenCalledWith('http://localhost:8648/api/ekko-studio/models/v1/responses', expect.objectContaining({ redirect: 'error', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' } }))
  const event = Buffer.from('event: response.output_text.delta\ndata: {"delta":"你好"}\n\n')
  controller.enqueue(event)
  const first = await bridge.read(request.id)
  expect(Buffer.from(first.data as Buffer)).toEqual(event)
  controller.enqueue(Buffer.alloc(40000, 65))
  expect((await bridge.read(request.id)).data).toHaveLength(32768)
  expect((await bridge.read(request.id)).data).toHaveLength(7232)
  controller.close()
  expect(await bridge.read(request.id)).toMatchObject({ done: true })
})

it('checks grants and key revocation after a pending read and aborts the upstream on cancellation', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let signal!: AbortSignal
  bridge = new CloudModelApiSessions('http://localhost', (async (_url, init) => {
    signal = init!.signal as AbortSignal
    return new Response(new ReadableStream({ start(c) { controller = c } }))
  }) as typeof fetch)
  const request = input()
  await bridge.open(request)
  const pending = bridge.read(request.id)
  mocks.key = null
  controller.enqueue(Buffer.from('secret'))
  expect(await pending).toMatchObject({ ok: false, error: 'cloud_model_access_denied' })
  expect(signal.aborted).toBe(true)
  mocks.key = { userId: 7 }
  const next = input()
  await bridge.open(next)
  bridge.cancelAll()
  expect(signal.aborted).toBe(true)
  expect(await bridge.read(next.id)).toMatchObject({ ok: false })
})

it('caps cumulative downloads and rejects arbitrary endpoints and redirects', async () => {
  const fetcher = vi.fn(async () => new Response('123456789'))
  bridge = new CloudModelApiSessions('http://localhost', fetcher)
  expect(await bridge.open({ ...input(), endpoint: '../settings' })).toMatchObject({ status: 400 })
  const request = { ...input(), maxDownloadBytes: 5 }
  await bridge.open(request)
  expect(await bridge.read(request.id)).toMatchObject({ error: 'download_too_large' })
})
