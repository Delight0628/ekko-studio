import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getLocale: () => 'en' }, BrowserWindow: class {}, WebContentsView: class {},
  dialog: {}, Menu: {}, session: {}, shell: {},
}))
import { BrowserManager } from '../../packages/desktop/src/main/browser/browser-manager'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it('writes only the approved profile, configures before writing, persists and sanitizes partial failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ekko-cookie-manager-'))
  roots.push(root)
  const manager = new BrowserManager({} as BrowserWindow, root)
  const internal = manager as any
  await internal.profileStore.initialize()
  const profileId = internal.profileStore.active().id
  const { managerUrl, token } = await manager.startCookieImport(profileId)
  const set = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('secret cookie value'))
  internal.profileSession = vi.fn(() => ({ cookies: { set } }))
  internal.configureSession = vi.fn(async () => undefined)
  internal.flushProfileSession = vi.fn(async () => undefined)
  const response = await fetch(managerUrl + '/api/cookie-import-helper/submit', {
    method: 'POST', headers: { Origin: `chrome-extension://${'a'.repeat(32)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, cookies: [
      { name: 'one', value: 'synthetic', domain: 'example.com', path: '/' },
      { name: 'two', value: 'synthetic', domain: 'example.com', path: '/' },
    ] }),
  })
  expect(response.status).toBe(202)
  expect(set).not.toHaveBeenCalled()
  expect(await manager.confirmCookieImport()).toEqual({ imported: 1, failed: 1 })
  expect(internal.profileSession).toHaveBeenCalledWith(expect.objectContaining({ id: profileId }))
  expect(internal.configureSession.mock.invocationCallOrder[0]).toBeLessThan(set.mock.invocationCallOrder[0])
  expect(internal.flushProfileSession).toHaveBeenCalledWith(expect.objectContaining({ id: profileId }))
  await expect(manager.confirmCookieImport()).rejects.toThrow('No pending')
  expect(manager.cookieImportStatus()).toBeNull()
})
