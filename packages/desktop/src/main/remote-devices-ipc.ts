import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type { DesktopRemoteDevices } from './remote-devices'
import { isTrustedDesktopAppUrl } from './window-open-policy'

interface RemoteDeviceContext {
  mainContents: WebContents | null
  serverUrl: string | null
  recoveryUrl: string | null
}

export function registerRemoteDevicesIpc(
  devices: () => DesktopRemoteDevices,
  context: () => RemoteDeviceContext,
): void {
  function authorize(event: IpcMainInvokeEvent, recovery = false): void {
    const current = context()
    if (!current.mainContents || event.sender !== current.mainContents
      || event.senderFrame !== event.sender.mainFrame
      || (!isTrustedDesktopAppUrl(event.senderFrame?.url || '', current.serverUrl)
        && !(recovery && current.recoveryUrl && event.senderFrame?.url === current.recoveryUrl))) {
      throw new Error('Remote devices can only be managed from the main Studio window')
    }
  }
  ipcMain.handle('hermes-desktop:remote-devices-list', event => {
    authorize(event)
    return devices().state()
  })
  ipcMain.handle('hermes-desktop:remote-devices-add', (event, input: unknown) => {
    authorize(event)
    return devices().add(input)
  })
  ipcMain.handle('hermes-desktop:remote-devices-remove', (event, id: unknown) => {
    authorize(event)
    return devices().remove(id)
  })
  ipcMain.handle('hermes-desktop:remote-devices-switch', (event, id: unknown) => {
    authorize(event)
    return devices().switchTo(id)
  })
  ipcMain.handle('hermes-desktop:remote-devices-return-local', event => {
    authorize(event, true)
    return devices().switchTo(null)
  })
}
