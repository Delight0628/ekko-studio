import { createHash } from 'node:crypto'
import { createConnection, createServer } from 'node:net'
import { chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function deviceWindowEndpoint(root: string, url: string | null): string {
  const key = createHash('sha256').update(JSON.stringify([root, url])).digest('hex').slice(0, 40)
  return process.platform === 'win32' ? `\\\\.\\pipe\\ekko-device-${key}` : join(process.platform === 'darwin' ? '/tmp' : tmpdir(), `ekko-device-${key}.sock`)
}
export async function focusDeviceWindow(endpoint: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection(endpoint)
    const timer = setTimeout(() => { socket.destroy();resolve(false) }, 1500)
    socket.on('error', () => { clearTimeout(timer);resolve(false) })
    socket.on('connect', () => socket.write('focus\n'))
    socket.on('data', data => { clearTimeout(timer);socket.destroy();resolve(String(data).trim() === 'ok') })
  })
}
/** Kernel socket ownership covers both startup and active windows, across processes. */
export async function ownDeviceWindow(endpoint: string, focus: () => void): Promise<null | (() => void)> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const server = createServer(socket => {
      socket.setTimeout(1500, () => socket.destroy())
      socket.once('data', data => { if (String(data).trim() === 'focus') { focus();socket.end('ok\n') } else socket.destroy() })
    })
    const error = await new Promise<NodeJS.ErrnoException | null>(resolve => {
      server.once('error', resolve)
      server.listen(endpoint, () => resolve(null))
    })
    if (!error) {
      if (process.platform !== 'win32') chmodSync(endpoint, 0o600)
      server.removeAllListeners('error');server.on('error', () => {})
      return () => { server.close() }
    }
    server.close()
    if (error.code !== 'EADDRINUSE') throw error
    if (await focusDeviceWindow(endpoint)) return null
    throw new Error('Device window owner unavailable; restart the stale owner before retrying')
  }
  throw new Error('Device window ownership race')
}
