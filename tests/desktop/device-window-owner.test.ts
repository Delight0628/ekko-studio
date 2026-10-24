import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { deviceWindowEndpoint, ownDeviceWindow } from '../../packages/desktop/src/main/device-window-owner'
it('reuses a live device owner and permits reopening after it exits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'device-owner-'))
  const endpoint = deviceWindowEndpoint(root, 'https://nas.test')
  const focus = vi.fn()
  const release = await ownDeviceWindow(endpoint, focus)
  try {
    expect(release).toBeTypeOf('function')
    expect(await ownDeviceWindow(endpoint, vi.fn())).toBeNull()
    expect(focus).toHaveBeenCalledOnce()
    release!()
    await new Promise(resolve => setTimeout(resolve, 30))
    const reopened = await ownDeviceWindow(endpoint, focus)
    expect(reopened).toBeTypeOf('function');reopened!()
  } finally { release?.();rmSync(root, { recursive: true, force: true }) }
})
