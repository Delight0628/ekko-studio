import { personError, personRevision } from '../../contracts/person'
import { personSessionId } from '../../contracts/person-session'
import { getChatRunServer } from '../../public/chat-run'
import { clearPersonHistory, personHistorySessions } from '../../repositories/person-history-store'
import { personUpdated } from '../../repositories/person-updates'
import { personUser } from './catalog'
import { personChatBusy } from './chat-agent'

export async function clearPerson(userId: number, input: Record<string, unknown>) {
  personUser(userId)
  const server = getChatRunServer()
  for (const { id } of personHistorySessions(userId)) await server?.assertSessionMessagesEditable?.(id)
  personUser(userId)
  if (personChatBusy(userId)) throw personError('Wait for the current Person reply to finish', 409)
  const result = clearPersonHistory(userId, personRevision(input.expected_history_revision))
  for (const id of result.sessionIds) server?.clearSessionHistory?.(id, { historyAlreadyCleared: true })
  for (const id of result.sessionIds) if (id !== personSessionId(userId)) await server?.disposeSession?.(id)
  personUpdated(userId)
  return { cleared: true, session_id: personSessionId(userId), deleted_tasks: result.deletedTasks }
}
