import { beforeEach, describe, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ token: 'account', mode: true, allow: true, callbacks: new Map<string, (...args: any[]) => void>(), revoke: vi.fn(), request: vi.fn(async () => ({ result: { tabs: [] } })), invalidated: null as (() => void) | null }))
vi.mock('socket.io-client', () => ({ io: vi.fn(() => ({ on: (event: string, cb: (...args: any[]) => void) => fixture.callbacks.set(event, cb), removeAllListeners: vi.fn(), disconnect: vi.fn() })) }))
vi.mock('@/api/client', () => ({ getApiKey: () => fixture.token, getBaseUrlValue: () => 'https://nas.example', getActiveProfileName: () => 'default' }))
vi.mock('@/api/auth-invalidation', () => ({ onAuthInvalidated: (cb: () => void) => { fixture.invalidated = cb; return () => { fixture.invalidated = null } } }))
vi.mock('@/utils/desktop-bridge', () => ({ desktopBridge: () => ({ remoteMode: fixture.mode, browser: { remoteRequest: fixture.request, setRemoteControl: async (enabled: boolean) => { if (!enabled) fixture.revoke(); return enabled && fixture.allow } } }) }))

describe('remote browser consent lifecycle', () => {
  beforeEach(() => { vi.resetModules(); fixture.callbacks.clear(); fixture.request.mockClear(); fixture.revoke.mockClear(); fixture.token = 'account'; fixture.mode = true; fixture.allow = true })
  it('requires Desktop consent and an authenticated remote session', async () => {
    const relay = await import('../../packages/client/src/composables/useRemoteBrowserRelay')
    fixture.allow = false
    await relay.startRemoteBrowserRelay()
    expect(relay.remoteBrowserEnabled.value).toBe(false)
    fixture.token = ''
    await expect(relay.startRemoteBrowserRelay()).rejects.toThrow('login')
  })
  it('forwards only while enabled and revokes on auth loss', async () => {
    const relay = await import('../../packages/client/src/composables/useRemoteBrowserRelay')
    await relay.startRemoteBrowserRelay()
    expect(relay.remoteBrowserEnabled.value).toBe(true)
    const handler = fixture.callbacks.get('browser.request')!
    const ack = vi.fn()
    await handler({ method: 'tabs.list' }, ack)
    expect(ack).toHaveBeenCalledWith({ envelope: { result: { tabs: [] } } })
    fixture.invalidated!()
    expect(relay.remoteBrowserEnabled.value).toBe(false)
    await handler({ method: 'snapshot' }, ack)
    expect(fixture.request).toHaveBeenCalledTimes(1)
  })
  it('revokes on disconnect instead of reconnecting automatically', async () => {
    const relay = await import('../../packages/client/src/composables/useRemoteBrowserRelay')
    await relay.startRemoteBrowserRelay()
    fixture.callbacks.get('disconnect')!()
    expect(relay.remoteBrowserEnabled.value).toBe(false)
    expect(fixture.revoke).toHaveBeenCalled()
  })
})
