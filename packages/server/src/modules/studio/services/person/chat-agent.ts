import { personSessionId, ownsPersonSession } from '../../contracts/person-session'
import { personError } from '../../contracts/person'
import { createSession, getSession, updateSession } from '../../repositories/session-store'
import { personDb } from '../../repositories/person-store'
import { personWorkspace } from './workspace'
import { getChatRunServer } from '../../public/chat-run'
import { personRuntime } from '../../public/person-runtime'
import { effectivePersonSettings, personUser, validatePersonSelection } from './catalog'
import { PERSON_SYSTEM_PROMPT } from './model'
import { personTools } from './tools'

export function personChatBusy(userId: number): boolean {
  return !!getChatRunServer()?.isSessionRunning?.(personSessionId(userId))
}

/** Person owns an account session in the shared single-chat store. */
export async function ensurePersonSession(userId: number) {
  const effective = await effectivePersonSettings(userId)
  const id = personSessionId(userId)
  const workspace = personWorkspace(userId)
  let session = getSession(id)
  if (!session) session = createSession({ id, user_id: userId, studio_user_id: userId, source: 'builtin_agent',
      agent: 'ekko-agent', agent_preset: 'person', agent_mode: 'scoped', title: 'Person',
      profile: effective.settings.model?.profile || 'default', push_enabled: false,
      workspace })
  if (!ownsPersonSession(userId, session)) throw personError('Session not found', 404)
  if (!personChatBusy(userId)) {
    const model = effective.settings.model
    // This Profile is a model resource, never the owner of the conversation.
    if (model) personDb().prepare('UPDATE sessions SET profile=? WHERE id=?').run(model.profile, id)
    updateSession(id, { workspace, model: model?.model || '', provider: model?.provider || '', api_mode: model?.apiMode || '', reasoning_effort: effective.settings.reasoningEffort })
  }
  return { ...effective, session: getSession(id)! }
}

/** Called only after account ownership has been checked at the transport boundary. */
export async function createPersonChatAgent(userId: number, sessionId: string) {
  if (!ownsPersonSession(userId, getSession(sessionId))) throw personError('Session not found', 404)
  const { settings } = await effectivePersonSettings(userId)
  if (!settings.model) throw personError('No available global default model; choose a Person model', 409)
  const selection = settings.model
  await validatePersonSelection(userId, selection)
  const factory = personRuntime().chatAgent
  if (!factory) throw personError('Person chat runtime unavailable', 503)
  return factory({ selection, tools: personTools(userId, 'main', undefined, `session:${sessionId}`),
    systemPrompt: `${PERSON_SYSTEM_PROMPT}\nRole: main. Current time: ${new Date().toISOString()}. Account timezone: ${settings.timezone}. Query task records on demand. All background tasks use the Person workspace selected by the user; individual tasks cannot override it.`,
    maxSteps: settings.maxSteps, contextTokens: settings.contextTokens,
    workspace: getSession(sessionId)!.workspace!,
    beforeRequest: () => {
      const user = personUser(userId)
      if (user.role !== 'super_admin' && !user.profiles.includes(selection.profile)) throw personError('Resource permission revoked', 403)
    },
  })
}
