import { personMemory } from './memory'
import { randomUUID } from 'node:crypto'
import { personError } from '../../contracts/person'
import { getSession, updateSession } from '../../repositories/session-store'
import { personDb } from '../../repositories/person-store'
import { personWorkspace } from './workspace'
import { getChatRunServer } from '../../public/chat-run'
import { personRuntime } from '../../public/person-runtime'
import { effectivePersonSettings, personUser, validatePersonSelection } from './catalog'
import { PERSON_SYSTEM_PROMPT } from './model'
import { personTools } from './tools'
import { createPersonContext } from './context'
import { requirePersonAgents } from './agents'
import { personSessionIds, requirePersonSession } from '../../repositories/person-session-store'
import { recordSessionUsage } from '../usage/usage-recorder'

export function personChatBusy(userId: number, sessionId?: string): boolean {
  const server = getChatRunServer()
  return sessionId ? !!server?.isSessionRunning?.(sessionId) : personSessionIds(userId).some(id => server?.isSessionRunning?.(id))
}

/** Person owns an account session in the shared single-chat store. */
export async function ensurePersonSession(userId: number, id: string) {
  const effective = await effectivePersonSettings(userId)
  const workspace = personWorkspace(userId)
  const session = requirePersonSession(userId, id)
  if (!personChatBusy(userId, id)) {
    const model = effective.settings.model
    // This Profile is a model resource, never the owner of the conversation.
    if (model) personDb().prepare('UPDATE sessions SET profile=? WHERE id=?').run(model.profile, id)
    updateSession(id, { workspace, model: model?.model || '', provider: model?.provider || '', api_mode: model?.apiMode || '', reasoning_effort: effective.settings.reasoningEffort })
  }
  return { ...effective, session: getSession(id)! }
}

/** Called only after account ownership has been checked at the transport boundary. */
export async function createPersonChatAgent(userId: number, sessionId: string) {
  requirePersonSession(userId, sessionId)
  requirePersonAgents(userId)
  const { settings, compression, contextTokens } = await effectivePersonSettings(userId)
  if (!settings.model) throw personError('No available global default model; choose a Person model', 409)
  const selection = settings.model
  await validatePersonSelection(userId, selection)
  const factory = personRuntime().chatAgent
  if (!factory) throw personError('Person chat runtime unavailable', 503)
  const context = createPersonContext(userId, sessionId, contextTokens)
  const summaryRunId = randomUUID()
  let summaryCall = 0, requestedAt = Date.now()
  return factory({ selection, tools: personTools(userId, 'main', undefined, sessionId),
    systemPrompt: `${PERSON_SYSTEM_PROMPT}\nRole: main. Current conversation: ${JSON.stringify({ id: sessionId, title: getSession(sessionId)!.title })}. Use bot_sessions_query for other account conversations. Task ownership and result delivery follow the target conversation. Current time: ${new Date().toISOString()}. Account timezone: ${settings.timezone}. Query task records on demand. All background tasks use the Person workspace selected by the user; individual tasks cannot override it.`,
    maxSteps: settings.maxSteps, contextTokens, compression,
    workspace: getSession(sessionId)!.workspace!,
    memory: personMemory(userId, sessionId), loadHistory: context.loadHistory, summaryCache: context.summaryCache,
    onSummaryUsage: response => recordSessionUsage({ sessionId, runId: `person:context:${summaryRunId}:${++summaryCall}`,
      purpose: 'person_context_summary', source: 'ekko_agent', agent: 'ekko_agent', accountId: String(userId),
      profile: selection.profile, provider: selection.provider, model: selection.model, usageScope: 'model_call', apiCalls: 1,
      usage: response.usage, apiDuration: (Date.now() - requestedAt) / 1000 }),
    beforeRequest: () => {
      requestedAt = Date.now()
      requirePersonSession(userId, sessionId)
      context.assertCurrent()
      const user = personUser(userId)
      if (user.role !== 'super_admin' && !user.profiles.includes(selection.profile)) throw personError('Resource permission revoked', 403)
    },
  })
}
