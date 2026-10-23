import type { ChatRunCaller } from '../../contracts/runs/caller'
import type { ChatRunStartRequest, ChatRunStartPorts, ChatRunStartScope } from './start'

/** Trusted entrypoint context; never deserialize this interface from a request body. */
export interface DirectChatRunOptions extends Pick<ChatRunStartScope, 'profile' | 'user' | 'shared' | 'reauthorize'> {
  mobileDeviceTarget?: ChatRunCaller['mobileDeviceTarget']
  pushActor: ChatRunStartPorts['pushActor']
  onEvent(event: string, payload: any): void
}

export interface DirectChatRunHandle {
  /** Stop observing; accepted work continues, including queued input. */
  dispose(): void
  /** Revoke queued input belonging to this caller without cancelling another run. */
  dropQueued(): void
}

export interface DirectChatRunPort {
  startDirectRun(request: ChatRunStartRequest, options: DirectChatRunOptions): DirectChatRunHandle
}
