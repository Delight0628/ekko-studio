import type { AuthenticatedUser } from '../../public/auth'
import type { ExecutionScope } from '../plugins'

/** Internal invocation identity and delivery port. Never accepted from a client payload. */
export interface ChatRunCaller {
  readonly kind: 'direct' | 'socket'
  readonly originId: string
  readonly user?: AuthenticatedUser
  readonly executionScope?: ExecutionScope
  readonly mobileDeviceTarget?: {
    deviceCode: string
    userId: string
    profile: string
    platform?: 'ios' | 'android' | 'unknown'
  }
  readonly groupRunIsCurrent?: () => boolean
  isActive(): boolean
  observeSession(sessionId: string): void
  reply(event: string, payload: any): void
  publishToPeers(sessionId: string, event: string, payload: any): void
}
