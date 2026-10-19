import Koa from 'koa'
import { bodyParser } from '@koa/bodyparser'
import type { Server } from 'node:http'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), models: vi.fn(), cloud: vi.fn(), run: false, appValid: false, user: { id: 7, username: 'tester', role: 'user', status: 'active' }, profiles: ['work'] }))
vi.mock('../../packages/server/src/modules/studio/services/model-api/service', () => ({ prepareModelResponse: mocks.prepare, listApiModels: mocks.models }))
vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({ getActiveProfileName: () => 'default', listProfileNamesFromDisk: () => ['work', 'default'] }))
vi.mock('../../packages/server/src/modules/studio/repositories/users-store', () => ({
  findUserById: () => mocks.user, listUserProfiles: () => mocks.profiles.map(profile_name => ({ profile_name })),
  userCanAccessProfile: (_id: number, profile: string) => mocks.profiles.includes(profile), touchUserLogin: vi.fn(),
}))
vi.mock('../../packages/server/src/modules/studio/services/auth/token-auth', () => ({ getToken: async () => 'test-only-secret' }))
vi.mock('../../packages/server/src/modules/studio/services/session-shares/http-access', () => ({ handleSessionShareHttp: async () => false }))
vi.mock('../../packages/server/src/modules/studio/repositories/app-connections-store', () => ({ isAppConnectionTokenActive: () => mocks.appValid }))
vi.mock('../../packages/server/src/modules/studio/services/auth/run-mcp-credentials', () => ({ runMcpCredentials: {
  recognizes: (value: string) => value.startsWith('studio_run_'),
  authenticate: () => mocks.run ? { contextId: 'test-context', profile: 'work', userId: 7 } : undefined,
} }))
vi.mock('../../packages/server/src/modules/studio/services/model-api/cloud-link', () => ({ manageModelApiCloudLink: mocks.cloud }))
import { modelApiRoutes } from '../../packages/server/src/modules/studio/routes/model-api'
import { issueUserJwt, issueAppJwt, signUserJwt, userAuthMiddleware } from '../../packages/server/src/modules/studio/middleware/auth'

let server: Server
let url: string
let token: string
beforeEach(async () => {
  vi.clearAllMocks()
  mocks.run = false
  mocks.appValid = false
  mocks.cloud.mockImplementation(async (userId, action) => ({ available: true, userId, action }))
  vi.stubEnv('AUTH_JWT_SECRET', 'test-only-secret')
  mocks.profiles = ['work']
  mocks.models.mockResolvedValue({ object: 'list', data: [{ id: 'glm/glm-5.3' }] })
  const app = new Koa().use(bodyParser())
  for (const middleware of userAuthMiddleware) app.use(middleware)
  app.use(modelApiRoutes.routes())
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  url = `http://127.0.0.1:${(server.address() as any).port}/api/ekko-studio/models/v1`
  token = await issueUserJwt(mocks.user as any)
})
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); vi.unstubAllEnvs() })
const headers = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' })

it('requires authentication and Profile membership before resolving models or upstream credentials', async () => {
  expect((await fetch(`${url}/models`)).status).toBe(401)
  expect(mocks.models).not.toHaveBeenCalled()
  expect(mocks.prepare).not.toHaveBeenCalled()
  expect(await (await fetch(`${url}/models`, { headers: headers() })).json()).toMatchObject({ object: 'list' })
  expect(mocks.models).toHaveBeenCalledWith(['work'], undefined)
  mocks.profiles = ['work', 'default']
  expect((await fetch(`${url}/models`, { headers: { ...headers(), 'x-hermes-profile': 'other' } })).status).toBe(200)
  expect(mocks.models).toHaveBeenLastCalledWith(['default', 'work'], undefined)
})

it('returns JSON with server-owned account attribution and a request ID', async () => {
  mocks.prepare.mockResolvedValue({ id: 'resp_1', stream: false, create: async () => ({ id: 'resp_1', object: 'response', output: [] }) })
  const response = await fetch(`${url}/responses`, { method: 'POST', headers: headers(), body: JSON.stringify({ model: 'glm/glm-5.3', input: 'Hi', accountId: 'other' }) })
  expect(response.status).toBe(200)
  expect(response.headers.get('x-request-id')).toBe('resp_1')
  expect(await response.json()).toMatchObject({ object: 'response' })
  expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ accountId: '7', profiles: ['work'] }))
})

it('streams named SSE events and aborts upstream work when the HTTP client disconnects', async () => {
  let signal: AbortSignal | undefined
  const closed = vi.fn()
  mocks.prepare.mockImplementation(async input => {
    signal = input.signal
    return { id: 'resp_2', stream: true, async *events() {
      try {
        yield { type: 'response.created', sequence_number: 0, response: { id: 'resp_2' } }
        await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }))
      } finally { closed() }
    } }
  })
  const abort = new AbortController()
  const response = await fetch(`${url}/responses`, { method: 'POST', headers: headers(), body: '{}', signal: abort.signal })
  expect(response.headers.get('content-type')).toContain('text/event-stream')
  const first = await response.body!.getReader().read()
  expect(new TextDecoder().decode(first.value)).toContain('event: response.created\ndata: ')
  abort.abort()
  await vi.waitFor(() => expect(signal?.aborted).toBe(true))
  await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce())
})

it('rejects run-scoped credentials on every cloud link action, including trailing slashes', async () => {
  mocks.run = true
  const root = url.replace('/api/ekko-studio/models/v1', '')
  const auth = { Authorization: 'Bearer studio_run_test', 'x-studio-run-context': 'test-context', 'x-hermes-profile': 'work', 'content-type': 'application/json' }
  for (const path of ['/api/studio/models/cloud-link', '/API/STUDIO/MODELS/CLOUD-LINK', '/Api/Studio/Models/Cloud-Link']) for (const suffix of ['', '/']) for (const method of ['GET', 'POST', 'DELETE']) {
    expect((await fetch(`${root}${path}${suffix}`, { method, headers: auth, ...(method === 'POST' ? { body: '{"rotate":true}' } : {}) })).status).toBe(403)
  }
  expect(mocks.cloud).not.toHaveBeenCalled()
  for (const path of ['/API/STUDIO/MODELS/API-KEYS', '/API/EKKO-STUDIO/MODELS/V1/MODELS']) {
    expect((await fetch(`${root}${path}`, { headers: auth })).status).toBe(403)
  }
})

it('requires a Studio/App login for cloud link management and ignores Profile/account overrides', async () => {
  const root = url.replace('/api/ekko-studio/models/v1', '')
  expect((await fetch(`${root}/api/studio/models/cloud-link`)).status).toBe(401)
  const modelKey = `sk-ekko-${'a'.repeat(43)}`
  for (const method of ['GET', 'POST', 'DELETE']) {
    expect((await fetch(`${root}/api/studio/models/cloud-link`, { method, headers: { ...headers(), Authorization: `Bearer ${modelKey}` }, ...(method === 'POST' ? { body: '{}' } : {}) })).status).toBe(403)
  }
  for (const [method, body, action] of [['GET', undefined, 'get'], ['POST', '{}', 'create'], ['POST', '{"rotate":true,"userId":99,"profile":"other"}', 'rotate'], ['DELETE', undefined, 'revoke']] as const) {
    const response = await fetch(`${root}/api/studio/models/cloud-link?profile=other`, { method, headers: { ...headers(), 'x-hermes-profile': 'other' }, ...(body ? { body } : {}) })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ userId: 7, action })
  }
  expect(mocks.cloud).toHaveBeenCalledTimes(4)
})

it('allows a valid App connection owner and denies expired or revoked login credentials', async () => {
  const endpoint = url.replace('/api/ekko-studio/models/v1', '/api/studio/models/cloud-link')
  const appToken = await issueAppJwt(mocks.user as any, 'device-1', 'cloud')
  mocks.appValid = true
  expect((await fetch(endpoint, { headers: { Authorization: `Bearer ${appToken}` } })).status).toBe(200)
  expect(mocks.cloud).toHaveBeenCalledWith(7, 'get')
  mocks.cloud.mockClear()
  mocks.appValid = false
  expect((await fetch(endpoint, { method: 'DELETE', headers: { Authorization: `Bearer ${appToken}` } })).status).toBe(401)
  const expired = signUserJwt(mocks.user as any, 'test-only-secret', Date.now() - 10000, 1)
  expect((await fetch(endpoint, { method: 'DELETE', headers: { Authorization: `Bearer ${expired}` } })).status).toBe(401)
  expect(mocks.cloud).not.toHaveBeenCalled()
})
