import Koa from 'koa'
import { bodyParser } from '@koa/bodyparser'
import { once } from 'node:events'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import { StudioError } from '../../packages/studio-plugin-sdk/src'

const state = vi.hoisted(() => ({ remove: vi.fn(), configure: vi.fn(), install: vi.fn(), diagnostic: vi.fn(), list: vi.fn(() => []),
  respond: vi.fn(), interactions: vi.fn(() => []), usage: vi.fn(() => []), cancel: vi.fn(), role: 'super_admin' }))
vi.mock('../../packages/server/src/modules/studio/services/plugins/runtime', () => ({
  authorizePluginScope: vi.fn(),
  getStudioPluginRuntime: () => ({ host: { uninstall: state.remove, configure: state.configure, install: state.install, list: state.list, diagnostic: state.diagnostic },
    registry: { list: () => [], getRevision: () => 1 }, coordinator: { respond: state.respond, interactions: state.interactions, usage: state.usage, cancel: state.cancel } }),
}))
import { studioPluginRoutes } from '../../packages/server/src/modules/studio/routes/studio-plugins'

let server: Server, base: string
beforeAll(async () => {
  const app = new Koa()
  app.use(bodyParser())
  app.use(async (ctx, next) => {
    ctx.state.user = { id: 7, username: 'fixture', role: state.role as 'super_admin' | 'admin' }
    if (ctx.query.profile) ctx.state.profile = { name: String(ctx.query.profile) }
    await next()
  })
  app.use(studioPluginRoutes.routes())
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => { server.close(); await once(server, 'close') })

it('returns a stable protection error for system deletion', async () => {
  state.remove.mockImplementation(() => { throw new StudioError('SYSTEM_PLUGIN_PROTECTED', 'System plugins cannot be uninstalled') })
  const response = await fetch(`${base}/api/studio/plugins/studio.agent-codex`, { method: 'DELETE' })
  expect(response.status).toBe(403)
  expect(await response.json()).toMatchObject({ ok: false, error: { code: 'SYSTEM_PLUGIN_PROTECTED', retryable: false } })
})

it('restricts diagnostics to an authorized administrator and profile', async () => {
  state.diagnostic.mockReturnValue({ state: 'blocked', errorCode: 'PLUGIN_UNAVAILABLE' })
  expect((await fetch(`${base}/api/studio/plugins/test.provider/diagnostic`)).status).toBe(400)
  state.role = 'admin'
  try { expect((await fetch(`${base}/api/studio/plugins/test.provider/diagnostic?profile=one`)).status).toBe(403) }
  finally { state.role = 'super_admin' }
  expect(state.diagnostic).not.toHaveBeenCalled()
  const response = await fetch(`${base}/api/studio/plugins/test.provider/diagnostic?profile=one`)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true, data: { state: 'blocked', errorCode: 'PLUGIN_UNAVAILABLE' } })
  expect(state.diagnostic).toHaveBeenCalledWith('test.provider', 'one')
})

it('rejects non-super-admin plugin management before invoking services', async () => {
  state.role = 'admin'
  state.install.mockClear()
  try {
    const response = await fetch(`${base}/api/studio/plugins`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '/plugin' }) })
    expect(response.status).toBe(403)
    expect(state.install).not.toHaveBeenCalled()
  } finally { state.role = 'super_admin' }
})

it('rejects caller-selected identity and requires an authorized profile', async () => {
  state.configure.mockClear()
  const request = { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, config: {}, grants: [], revision: 0, ownerId: 'another-user' }) }
  expect((await fetch(`${base}/api/studio/plugins/example.echo/profile`, request)).status).toBe(400)
  expect((await fetch(`${base}/api/studio/plugins/example.echo/profile?profile=default`, request)).status).toBe(400)
  expect(state.configure).not.toHaveBeenCalled()
})


it('routes lifecycle calls with host identity and rejects forged response fields', async () => {
  state.respond.mockResolvedValue({ id: 'interaction', runId: 'run', status: 'resolved' })
  const request = { interactionId: 'interaction', idempotencyKey: 'answer', choiceId: 'yes' }
  const response = await fetch(`${base}/api/studio/agent-runs/run/respond?profile=default`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
  })
  expect(response.status).toBe(200)
  expect(state.respond).toHaveBeenCalledWith(expect.objectContaining({ principal: { id: '7', kind: 'user' }, profileId: 'default' }), 'run', request)
  expect(await response.json()).toEqual({ ok: true, data: { id: 'interaction', runId: 'run', status: 'resolved' } })
  state.respond.mockClear()
  const forged = await fetch(`${base}/api/studio/agent-runs/run/respond?profile=default`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...request, ownerId: 'other' }),
  })
  expect(forged.status).toBe(400)
  expect(state.respond).not.toHaveBeenCalled()
  for (const method of ['interactions', 'usage'] as const) {
    expect((await fetch(`${base}/api/studio/agent-runs/run/${method}?profile=default`)).status).toBe(200)
    expect(state[method]).toHaveBeenCalledWith(expect.objectContaining({ principal: { id: '7', kind: 'user' }, profileId: 'default' }), 'run')
  }
})

it('returns a finalization conflict without reporting cancellation', async () => {
  state.cancel.mockRejectedValue(new StudioError('RUN_FINALIZING', 'Run is committing its final result'))
  const response = await fetch(`${base}/api/studio/agent-runs/run/cancel?profile=default`, { method: 'POST' })
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ ok: false, error: { code: 'RUN_FINALIZING' } })
})
