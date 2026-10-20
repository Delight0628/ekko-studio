import { randomUUID } from 'node:crypto'

export const DESKTOP_BROWSER_METHODS = new Set([
  'state', 'tabs.list', 'tabs.create', 'tabs.activate', 'tabs.close', 'lease.release',
  'navigate', 'navigation.action', 'snapshot', 'text.read', 'interact', 'interact.batch',
  'screenshot', 'console.read', 'console.clear',
])

type RelayPeer = {
  id: string
  userId: number
  profile: string
  request: (body: Record<string, unknown>) => Promise<unknown>
  revoke: () => void
}

/** Session-only capabilities; no browser tokens or descriptors are persisted. */
export class DesktopBrowserRelayRegistry {
  private peers = new Map<string, RelayPeer>()

  register(peer: RelayPeer): () => void {
    this.peers.set(peer.id, peer)
    return () => {
      if (this.peers.get(peer.id) === peer) this.peers.delete(peer.id)
      peer.revoke()
    }
  }

  private select(userId: number, profile: string): RelayPeer {
    const peers = [...this.peers.values()].filter(peer => peer.userId === userId && peer.profile === profile)
    if (!peers.length) throw new Error('No authorized Desktop browser connected for this user and profile. Enable remote control in the Desktop browser panel.')
    if (peers.length !== 1) throw new Error('Multiple Desktop browsers connected. Disable remote control on other desktops before retrying.')
    return peers[0]
  }

  async request(userId: number, profile: string, input: Record<string, unknown>): Promise<unknown> {
    if (typeof input.method !== 'string' || !DESKTOP_BROWSER_METHODS.has(input.method)) throw new Error('Unsupported browser method')
    if (JSON.stringify(input).length > 1_000_000) throw new Error('Browser request exceeds 1 MB')
    const peer = this.select(userId, profile)
    const result = await peer.request({ method: input.method, params: input.params || {}, operation_id: randomUUID() })
    if (this.peers.get(peer.id) !== peer) throw new Error('Desktop browser disconnected during operation')
    return result
  }
}

export const desktopBrowserRelays = new DesktopBrowserRelayRegistry()
