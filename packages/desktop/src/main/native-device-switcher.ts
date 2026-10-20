import { BrowserWindow, WebContentsView, Menu, dialog, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DesktopRemoteDevices, DesktopRemoteDevicesState } from './remote-devices'
import { nativeDeviceLabels } from './native-device-messages'
import { nativeDeviceHtml } from './native-device-html'

const WIDTH = 160
const HEIGHT = 40
const GAP = 8
const CHANNELS = ['state', 'menu', 'add', 'remove', 'switch'] as const
const channel = (name: typeof CHANNELS[number]) => `studio-native-devices:${name}`

export function nativeDeviceSwitcherLayout(width: number, platform: NodeJS.Platform) {
  const controls = platform === 'darwin' ? 0 : 138
  return {
    bounds: { x: Math.max(0, width - controls - GAP - WIDTH), y: 0, width: WIDTH, height: HEIGHT },
    inset: controls + GAP + WIDTH,
  }
}

export class NativeDeviceSwitcher {
  readonly view: WebContentsView
  private manager: BrowserWindow | null = null
  private readonly documents = new Map<WebContents, string>()
  private busy = false
  private disposed = false
  private readonly mainContents: WebContents
  private readonly resize = () => this.layout()
  private readonly style = () => {
    const { inset } = nativeDeviceSwitcherLayout(this.window.getContentSize()[0], this.platform)
    // Reserve the native view even in an older remote UI. The control itself is
    // a separate WebContentsView, so page reloads and crashes cannot remove it.
    void this.window.webContents.insertCSS(`#app .studio-page-header { padding-right: ${inset}px; --studio-header-controls-gap: 8px; box-sizing: border-box; } #app .studio-page-header > header { padding-right: 8px; }`).catch(() => undefined)
  }

  constructor(private readonly window: BrowserWindow, private readonly devices: () => DesktopRemoteDevices, private readonly platform: NodeJS.Platform = process.platform) {
    this.mainContents = window.webContents
    const preferences = this.preferences()
    this.view = new WebContentsView({ webPreferences: preferences })
    this.view.setBackgroundColor('#00000000')
    this.window.contentView.addChildView(this.view)
    this.load(this.view.webContents, 'button')
    this.layout()
    this.window.on('resize', this.resize)
    this.window.webContents.on('dom-ready', this.style)
    this.window.once('closed', () => this.dispose())
    this.style()

    ipcMain.handle(channel('state'), event => {
      this.authorize(event)
      let state: DesktopRemoteDevicesState
      let failed = false
      try { state = this.devices().state() } catch { state = { devices: [], activeDeviceId: null, activeServerUrl: null };failed = true }
      return { state, labels: nativeDeviceLabels(), busy: this.busy, failed }
    })
    ipcMain.handle(channel('menu'), event => {
      this.authorize(event, true)
      this.openMenu()
    })
    ipcMain.handle(channel('add'), (event, input: unknown) => {
      this.authorizeManager(event)
      if (this.busy) throw new Error('REMOTE_DEVICE_BUSY')
      const state = this.devices().add(input)
      this.refresh()
      return state
    })
    ipcMain.handle(channel('remove'), async (event, id: unknown) => {
      this.authorizeManager(event)
      if (this.busy) throw new Error('REMOTE_DEVICE_BUSY')
      const labels = nativeDeviceLabels()
      const { response } = await dialog.showMessageBox(this.manager!, { type: 'question', message: labels.deleteConfirm, buttons: [labels.cancel, labels.remove], defaultId: 0, cancelId: 0, noLink: true })
      if (response === 1) { this.devices().remove(id);this.refresh() }
    })
    ipcMain.handle(channel('switch'), (event, id: unknown) => {
      this.authorizeManager(event)
      return this.switchTo(id)
    })
  }

  private preferences() {
    return { preload: join(__dirname, '..', 'preload', 'native-devices.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, partition: `native-device-ui-${randomUUID()}` }
  }

  private load(contents: WebContents, kind: 'button' | 'manager') {
    const url = 'data:text/html;charset=utf-8,' + encodeURIComponent(nativeDeviceHtml(kind))
    this.documents.set(contents, url)
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', event => event.preventDefault())
    contents.on('will-redirect', event => event.preventDefault())
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    contents.on('render-process-gone', () => { if (!this.disposed && !contents.isDestroyed()) void contents.loadURL(url).catch(() => undefined) })
    void contents.loadURL(url).catch(() => undefined)
  }

  private authorize(event: IpcMainInvokeEvent, buttonOnly = false) {
    const sender = event.sender
    if (this.disposed || sender.isDestroyed() || event.senderFrame !== sender.mainFrame
      || !this.documents.has(sender) || event.senderFrame.url !== this.documents.get(sender)
      || (buttonOnly && sender !== this.view.webContents)) throw new Error('Device controls require a desktop-owned view')
  }

  private authorizeManager(event: IpcMainInvokeEvent) {
    this.authorize(event)
    if (!this.manager || event.sender !== this.manager.webContents) throw new Error('Device management requires the local manager window')
  }

  private layout() {
    if (!this.disposed) this.view.setBounds(nativeDeviceSwitcherLayout(this.window.getContentSize()[0], this.platform).bounds)
  }

  raise() {
    if (!this.disposed && !this.window.isDestroyed()) this.window.contentView.addChildView(this.view)
  }

  refresh() {
    if (this.disposed) return
    for (const contents of this.documents.keys()) if (!contents.isDestroyed()) contents.send('studio-native-devices:changed')
  }

  openMenu() {
    const labels = nativeDeviceLabels()
    let state: DesktopRemoteDevicesState
    try { state = this.devices().state() } catch { this.openManager();return }
    const entries = [{ id: null, name: labels.local }, ...state.devices]
    const menu = Menu.buildFromTemplate([
      ...entries.map(device => ({
        label: device.name, type: 'radio' as const,
        checked: device.id === null ? state.activeServerUrl === null : state.activeDeviceId === device.id,
        enabled: !this.busy,
        click: () => { void this.switchTo(device.id).catch(error => this.showError(error)) },
      })),
      { type: 'separator' },
      { label: labels.manage, enabled: !this.busy, click: () => this.openManager() },
    ])
    const { bounds } = nativeDeviceSwitcherLayout(this.window.getContentSize()[0], this.platform)
    menu.popup({ window: this.window, x: bounds.x, y: HEIGHT })
  }

  openManager() {
    if (this.manager && !this.manager.isDestroyed()) { this.manager.show();this.manager.focus();return }
    this.manager = new BrowserWindow({ width: 600, height: 640, minWidth: 420, minHeight: 480, parent: this.window, title: nativeDeviceLabels().manage, autoHideMenuBar: true, show: false, webPreferences: this.preferences() })
    const manager = this.manager
    const contents = manager.webContents
    manager.once('ready-to-show', () => { if (!manager.isDestroyed()) manager.show() })
    manager.once('closed', () => { this.documents.delete(contents);if (this.manager === manager) this.manager = null })
    this.load(manager.webContents, 'manager')
  }

  private async switchTo(id: unknown) {
    if (this.busy) throw new Error('REMOTE_DEVICE_BUSY')
    const manager = this.devices()
    const state = manager.state()
    const device = id === null ? null : state.devices.find(device => device.id === id)
    if (device === undefined) throw new Error('REMOTE_DEVICE_NOT_FOUND')
    if ((id === null && state.activeServerUrl === null) || (id !== null && state.activeDeviceId === id)) return
    const labels = nativeDeviceLabels()
    this.busy = true;this.refresh()
    let scheduled = false
    try {
      const { response } = await dialog.showMessageBox(this.manager || this.window, { type: 'question', message: device?.name || labels.local, detail: labels.hint, buttons: [labels.cancel, labels.confirm], defaultId: 0, cancelId: 0, noLink: true })
      if (response !== 1) return
      await manager.switchTo(id)
      scheduled = true
    } finally {
      if (!scheduled) { this.busy = false;this.refresh() }
    }
  }

  private showError(error: unknown) {
    const labels = nativeDeviceLabels()
    const text = error instanceof Error ? error.message : ''
    const message = text.includes('UNREACHABLE') ? labels.unreachable : labels.failed
    void dialog.showMessageBox(this.manager || this.window, { type: 'error', message, buttons: ['OK'] })
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.window.off('resize', this.resize)
    this.mainContents.off('dom-ready', this.style)
    for (const name of CHANNELS) ipcMain.removeHandler(channel(name))
    if (this.manager && !this.manager.isDestroyed()) this.manager.destroy()
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(this.view)
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close()
    this.documents.clear()
  }
}
