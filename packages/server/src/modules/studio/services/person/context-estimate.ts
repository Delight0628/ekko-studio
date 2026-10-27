import { countTextTokens } from '../../../../../../ekko-agent/src/model/tokens'
import type { AgentMessage, ModelRequest } from '../../../../../../ekko-agent/src/model/types'
import type { AgentRuntimeContextEstimate } from '../../../../../../ekko-agent/src/runtime/types'

// A conservative per-image reservation, not a provider billing calculation.
// Encoded byte length is unrelated to vision tokens. Keep the original image
// payload intact for the provider and count each image separately instead.
const IMAGE_TOKEN_RESERVE = 4096

export function personContextText(messages: AgentMessage[]) {
  return messages.map(message => ({ ...message, ...(message.contentParts ? {
    contentParts: message.contentParts.map(part => part.type === 'image' ? { type: part.type, mimeType: part.mimeType } : part),
  } : {}) }))
}

export function personMessageTokens(messages: AgentMessage[]) {
  return countTextTokens(JSON.stringify(personContextText(messages))) + imageTokens(messages)
}

function imageTokens(messages: AgentMessage[]) {
  return messages.reduce((sum, message) => sum + (message.contentParts?.filter(part => part.type === 'image').length || 0) * IMAGE_TOKEN_RESERVE, 0)
}

export function estimatePersonContext(request: ModelRequest): AgentRuntimeContextEstimate {
  const systems = request.messages.filter(message => message.role === 'system')
  return {
    contextTokens: Math.ceil((countTextTokens(JSON.stringify({ messages: personContextText(request.messages), tools: request.tools })) + imageTokens(request.messages)) * 1.15),
    systemPromptTokens: personMessageTokens(systems),
    toolTokens: countTextTokens(JSON.stringify(request.tools || [])),
    messageTokens: personMessageTokens(request.messages.filter(message => message.role !== 'system')),
    modelContextTokens: 0, messageCount: request.messages.length, toolCount: request.tools?.length || 0,
    systemPromptChars: systems.reduce((sum, message) => sum + message.content.length, 0),
  }
}
