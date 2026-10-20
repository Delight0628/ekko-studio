import { describe, expect, it, vi } from 'vitest'
import { DesktopBrowserRelayRegistry } from '../../packages/server/src/modules/studio/services/browser/desktop-relay'

describe('remote Desktop browser isolation', () => {
  it('fails closed without a matching user and profile', async () => {
    const registry = new DesktopBrowserRelayRegistry()
    registry.register({ id: 'desktop', userId: 1, profile: 'default', request: vi.fn(), revoke: vi.fn() })
    await expect(registry.request(2, 'default', { method: 'tabs.list' })).rejects.toThrow('No authorized')
    await expect(registry.request(1, 'private', { method: 'tabs.list' })).rejects.toThrow('No authorized')
  })
  it('routes one authenticated browser, never guesses among multiple desktops', async () => {
    const registry = new DesktopBrowserRelayRegistry()
    const request = vi.fn(async () => ({ result: { tabs: [] } }))
    registry.register({ id: 'one', userId: 1, profile: 'default', request, revoke: vi.fn() })
    await expect(registry.request(1, 'default', { method: 'tabs.list' })).resolves.toEqual({ result: { tabs: [] } })
    registry.register({ id: 'two', userId: 1, profile: 'default', request, revoke: vi.fn() })
    await expect(registry.request(1, 'default', { method: 'tabs.list' })).rejects.toThrow('Multiple')
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('revokes connection and discards late responses', async () => {
    const registry = new DesktopBrowserRelayRegistry()
    let finish!: (value: unknown) => void
    const revoke = vi.fn()
    const release = registry.register({ id: 'one', userId: 1, profile: 'default', request: () => new Promise(resolve => { finish = resolve }), revoke })
    const pending = registry.request(1, 'default', { method: 'snapshot', params: { tab_id: 'one' } })
    release(); finish({ result: 'private' })
    await expect(pending).rejects.toThrow('disconnected')
    expect(revoke).toHaveBeenCalledOnce()
    await expect(registry.request(1, 'default', { method: 'tabs.list' })).rejects.toThrow('No authorized')
  })
  it('rejects unsupported or oversized operations before forwarding', async () => {
    const registry = new DesktopBrowserRelayRegistry()
    await expect(registry.request(1, 'default', { method: 'eval' })).rejects.toThrow('Unsupported')
    await expect(registry.request(1, 'default', { method: 'navigate', params: { url: 'a'.repeat(1_000_001) } })).rejects.toThrow('1 MB')
  })
})
