import { beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), menu: vi.fn(), popup: vi.fn(), confirm: vi.fn(), windows: [] as any[] }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Contents extends EventEmitter {
    mainFrame = { url: '' }
    session = { setPermissionRequestHandler: vi.fn() }
    isDestroyed = vi.fn(() => false)
    close = vi.fn()
    insertCSS = vi.fn(async () => '')
    send = vi.fn()
    setWindowOpenHandler = vi.fn()
    loadURL = vi.fn(async (url: string) => { this.mainFrame.url = url })
  }
  class Window extends EventEmitter {
    webContents = new Contents()
    contentView = { addChildView: vi.fn(), removeChildView: vi.fn() }
    getContentSize = () => [1000, 700]
    isDestroyed = () => false
    destroy = vi.fn()
    show = vi.fn()
    focus = vi.fn()
    constructor() { super();mock.windows.push(this) }
  }
  return {
    app: { getLocale: () => 'en' }, BrowserWindow: Window,
    WebContentsView: class { webContents = new Contents();setBackgroundColor = vi.fn();setBounds = vi.fn() },
    ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => mock.handlers.set(name, handler), removeHandler: (name: string) => mock.handlers.delete(name) },
    Menu: { buildFromTemplate: (entries: any[]) => { mock.menu(entries);return { popup: mock.popup } } },
    dialog: { showMessageBox: mock.confirm },
  }
})
import { BrowserWindow } from 'electron'
import { NativeDeviceSwitcher, nativeDeviceSwitcherLayout } from '../../packages/desktop/src/main/native-device-switcher'
import type { DesktopRemoteDevices } from '../../packages/desktop/src/main/remote-devices'

beforeEach(() => { vi.clearAllMocks();mock.handlers.clear();mock.windows.length = 0;mock.confirm.mockResolvedValue({ response: 1 }) })
function setup() {
  const state = { devices: [{ id: 'home', name: 'Home', serverUrl: 'https://home.example.com' }], activeDeviceId: 'home', activeServerUrl: 'https://home.example.com' }
  const manager = { state: vi.fn(() => state), add: vi.fn(), remove: vi.fn(), switchTo: vi.fn(async () => {}) }
  const window = new BrowserWindow()
  const control = new NativeDeviceSwitcher(window, () => manager as unknown as DesktopRemoteDevices, 'win32')
  const contents = control.view.webContents
  const event = { sender: contents, senderFrame: contents.mainFrame }
  return { control, manager, window, event, call: (method: string, from = event, input?: unknown) => mock.handlers.get(`studio-native-devices:${method}`)!(from, input) }
}

describe('desktop-owned native device switcher', () => {
  it('reserves device and window-control space with an 8px gap on each platform', () => {
    expect(nativeDeviceSwitcherLayout(1000, 'win32')).toEqual({ bounds: { x: 694, y: 0, width: 160, height: 40 }, inset: 306 })
    expect(nativeDeviceSwitcherLayout(1000, 'darwin')).toEqual({ bounds: { x: 832, y: 0, width: 160, height: 40 }, inset: 168 })
    expect(nativeDeviceSwitcherLayout(769, 'linux').bounds.x).toBe(463)
  })

  it('keeps the native control independent of the main page and reserves space in older pages', () => {
    const { control, window, call } = setup()
    expect(call('state').state.activeDeviceId).toBe('home')
    expect(window.webContents.insertCSS).toHaveBeenCalledWith(expect.stringContaining('padding-right: 306px'))
    expect(control.view.webContents.setWindowOpenHandler).toHaveBeenCalled()
    call('menu')
    const entries = mock.menu.mock.calls[0][0]
    expect(entries.map((entry: any) => entry.label).filter(Boolean)).toEqual(['This computer', 'Home', 'Manage devices…'])
    expect(entries[1].checked).toBe(true)
    expect(mock.popup).toHaveBeenCalledWith({ window, x: 694, y: 40 })
  })

  it.each(['remote page', 'foreign local view', 'subframe', 'navigated native view'])('denies native IPC from a %s', async kind => {
    const { call, event, window, manager } = setup()
    const bad = { ...event }
    if (kind === 'remote page') bad.sender = window.webContents
    if (kind === 'foreign local view') bad.sender = { ...event.sender } as any
    if (kind === 'subframe') bad.senderFrame = { ...event.senderFrame } as any
    if (kind === 'navigated native view') (event.senderFrame as any).url = 'https://remote.example.com'
    for (const method of ['state', 'menu', 'add', 'remove', 'switch']) await expect(Promise.resolve().then(() => call(method, bad))).rejects.toThrow('desktop-owned view')
    expect(manager.state).not.toHaveBeenCalled()
  })

  it('allows mutations only from the local manager and honors native switch cancellation', async () => {
    const { control, call, event, manager } = setup()
    expect(() => call('add', event, {})).toThrow('local manager')
    control.openManager()
    const contents = mock.windows[1].webContents
    const from = { sender: contents, senderFrame: contents.mainFrame }
    call('add', from, { name: 'Office', serverUrl: 'http://office' })
    expect(manager.add).toHaveBeenCalledWith({ name: 'Office', serverUrl: 'http://office' })
    mock.confirm.mockResolvedValueOnce({ response: 0 })
    await call('switch', from, null)
    expect(manager.switchTo).not.toHaveBeenCalled()
    expect(call('state').busy).toBe(false)
    await call('switch', from, null)
    expect(manager.switchTo).toHaveBeenCalledExactlyOnceWith(null)
    expect(call('state').busy).toBe(true)
  })

  it('recovers from connection failures and detaches handlers on disposal', async () => {
    const { control, call, manager, window } = setup()
    control.openManager()
    const contents = mock.windows[1].webContents
    const from = { sender: contents, senderFrame: contents.mainFrame }
    manager.switchTo.mockRejectedValueOnce(new Error('REMOTE_DEVICE_UNREACHABLE'))
    await expect(call('switch', from, null)).rejects.toThrow('UNREACHABLE')
    expect(call('state').busy).toBe(false)
    control.dispose()
    expect(mock.handlers.size).toBe(0)
    expect(window.contentView.removeChildView).toHaveBeenCalledWith(control.view)
    expect(control.view.webContents.close).toHaveBeenCalledOnce()
  })
})
