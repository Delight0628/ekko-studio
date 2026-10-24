import { t } from '../desktop-i18n'
import { mkdirSync, realpathSync } from 'node:fs'
import { deviceWindowEndpoint, ownDeviceWindow } from '../device-window-owner'

/** Chromium keeps a Session alive after views close. Hold until process exit. */
export class BrowserProfileLeases {
  private static readonly leases = new Map<string, Promise<void>>()
  constructor(private readonly onExit: (release: () => void) => void) {}
  async acquire(path: string): Promise<void> {
    mkdirSync(path, { recursive: true, mode: 0o700 })
    const canonical = realpathSync(path)
    let pending = BrowserProfileLeases.leases.get(canonical)
    if (!pending) {
      pending = (async () => {
        const release = await ownDeviceWindow(deviceWindowEndpoint('browser-profile-storage-v1', canonical), () => {})
        if (!release) throw new Error(t('browser.profileInUse'))
        this.onExit(release)
      })()
      BrowserProfileLeases.leases.set(canonical, pending)
      pending.catch(() => { if (BrowserProfileLeases.leases.get(canonical) === pending) BrowserProfileLeases.leases.delete(canonical) })
    }
    await pending
  }
}
