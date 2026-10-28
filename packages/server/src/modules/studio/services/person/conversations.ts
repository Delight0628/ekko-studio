import { personSessionId } from '../../contracts/person-session'
import { personRevision, personText } from '../../contracts/person'
import { createSession } from '../../repositories/session-store'
import { beginPersonSessionDeletion, listPersonSessions, requirePersonSession } from '../../repositories/person-session-store'
import { clearPersonHistory } from '../../repositories/person-history-store'
import { personUpdated } from '../../repositories/person-updates'
import { getChatRunServer } from '../../public/chat-run'
import { effectivePersonSettings, personUser } from './catalog'
import { ensurePersonSession } from './chat-agent'
import { personWorkspace } from './workspace'
import { stopPersonSessionTasks } from './tasks'

export function personConversations(userId: number, query = '', offset = 0) {
  personUser(userId)
  const sessions = listPersonSessions(userId, query.slice(0, 200), offset, 51)
  return { sessions: sessions.slice(0, 50), next_offset: sessions.length > 50 ? offset + 50 : null }
}

export async function createPersonConversation(userId: number, title: unknown) {
  personUser(userId)
  const name = personText(title, 'conversation name', 100)
  const { settings } = await effectivePersonSettings(userId)
  personUser(userId)
  const id = personSessionId()
  createSession({ id, user_id: userId, studio_user_id: userId, title: name,
    source: 'builtin_agent', agent: 'ekko-agent', agent_preset: 'person', agent_mode: 'scoped',
    profile: settings.model?.profile || 'default', workspace: personWorkspace(userId), push_enabled: false })
  personUpdated(userId)
  return (await ensurePersonSession(userId, id)).session
}

export async function deletePersonConversation(userId: number, sessionId: string, expectedRevision: unknown) {
  personUser(userId)
  const session = requirePersonSession(userId, sessionId)
  const revision = personRevision(expectedRevision)
  if (session.history_revision !== revision) throw Object.assign(new Error('Conversation changed; reload and retry'), { status: 409 })
  const release = beginPersonSessionDeletion(userId, sessionId)
  try {
    const server = getChatRunServer()
    await server?.abortSession?.(sessionId, 'Person conversation deleted', { waitForTermination: true })
    await stopPersonSessionTasks(userId, sessionId)
    personUser(userId)
    const result = clearPersonHistory(userId, sessionId, revision, true)
    for (const id of result.sessionIds) await server?.disposeSession?.(id)
    personUpdated(userId)
    return { deleted: true, session_id: sessionId }
  } finally { release() }
}
