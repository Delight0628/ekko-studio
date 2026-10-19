import { getAppRelayClient } from '../app-relay/client'
import { APP_RELAY_CONNECTION_ID } from '../app-relay/connection'

export async function manageModelApiCloudLink(userId: number, action: 'get' | 'create' | 'rotate' | 'revoke') {
  const client = getAppRelayClient(APP_RELAY_CONNECTION_ID)
  if (!client?.isConnected()) return { available: false, urls: null, reason: 'cloud_connection_required' }
  return client.requestModelApiLink(userId, action)
}
