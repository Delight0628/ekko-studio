import type { AgentChats } from './chats'

let chats: AgentChats | undefined
/** Bootstrap wiring only; importing the chat transport does not load a worker. */
export function setAgentChatService(value: AgentChats | undefined): void { chats = value }
export function getAgentChatService(): AgentChats | undefined { return chats }
