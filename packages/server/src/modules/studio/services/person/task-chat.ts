import { personError, personRevision, personText } from '../../contracts/person'
import type { ContentBlock } from '../../contracts/runs/session'
import type { PersonExecution, PersonTask, PersonTaskOrigin } from '../../contracts/person'
import { personTaskSessionId } from '../../contracts/person-session'
import { getPersonTask, personDb, personOperation, personTaskRunning, enqueuePersonExecution, replayPersonOperation, pendingPersonInputs } from '../../repositories/person-store'
import { createSession, getSession } from '../../repositories/session-store'
import { personUpdated } from '../../repositories/person-updates'
import { personUser, validatePersonSelection } from './catalog'
import { savePersonTaskOrigin } from './delivery'
import { requirePersonSession } from '../../repositories/person-session-store'

/** Hidden task conversations are account-owned, never shared by Profile. */
export function ownedPersonTaskSession(userId: number | undefined, sessionId: string) {
  if (userId === undefined || !sessionId.startsWith('person-task-')) throw personError('Session not found', 404)
  const task = getPersonTask(userId, sessionId.slice('person-task-'.length))
  const user = personUser(userId)
  const session = getSession(sessionId)
  if (!session || String(session.studio_user_id) !== String(userId)) throw personError('Session not found', 404)
  if (user.role !== 'super_admin' && !user.profiles.includes(session.profile || 'default')) throw personError('Resource permission revoked', 403)
  return { task, session }
}

export async function personTaskChat(userId: number, taskId: string) {
  const task = getPersonTask(userId, taskId)
  const selection = JSON.parse(task.selection_json)
  const id = personTaskSessionId(taskId)
  const user = personUser(userId)
  if (user.role !== 'super_admin' && !user.profiles.includes(selection.profile || 'default')) throw personError('Resource permission revoked', 403)
  if (!getSession(id)) createSession({ id, user_id: userId, studio_user_id: userId, title: task.title,
    source: selection.runtime === 'ekko' ? 'builtin_agent' : selection.runtime === 'hermes' ? 'api_server' : 'coding_agent',
    agent: selection.runtime === 'ekko' ? 'ekko-agent' : selection.runtime, agent_mode: selection.mode,
    profile: selection.profile, provider: selection.provider, model: selection.model,
    reasoning_effort: selection.reasoningEffort, workspace: task.workspace, push_enabled: false })
  const { session } = ownedPersonTaskSession(userId, id)
  return { task: { ...getPersonTask(userId, taskId), running: personTaskRunning(taskId) }, session, pending: pendingPersonInputs(userId, taskId) }
}

function chatInput(value: unknown): ContentBlock[] {
  if (!Array.isArray(value) || !value.length || value.length > 50 || JSON.stringify(value).length > 100_000) throw personError('Invalid input')
  return value.map(block => {
    if (!block || typeof block !== 'object') throw personError('Invalid input block')
    if (block.type === 'text') return { type: 'text', text: personText(block.text, 'text', 32000) }
    if (block.type !== 'file' && block.type !== 'image') throw personError('Invalid input block')
    return { type: block.type, name: personText(block.name, 'name', 1000), path: personText(block.path, 'path', 4000),
      ...(block.type === 'image' || block.media_type ? { media_type: personText(block.media_type, 'media_type', 200) } : {}),
      ...(block.context ? { context: personText(block.context, 'context', 32000) } : {}), ...(block.video_frame === true ? { video_frame: true } : {}) } as ContentBlock
  })
}

/** New turns still use the durable background runner and its original Person callback. */
export async function continuePersonTask(userId: number, taskId: string, body: Record<string, unknown>, origin?: PersonTaskOrigin) {
  const request = { ...body, task_id: taskId }
  const key = `task-chat:${personText(body.idempotency_key, 'idempotency_key', 200)}`
  const task = getPersonTask(userId, taskId)
  await validatePersonSelection(userId, JSON.parse(task.selection_json))
  const replay = replayPersonOperation<{ task: PersonTask; execution: PersonExecution; pending: ReturnType<typeof pendingPersonInputs> }>(userId, key, request)
  if (replay !== undefined) return replay
  const input = chatInput(body.input)
  const result = personOperation(userId, key, request, () => {
    const current = getPersonTask(userId, taskId)
    requirePersonSession(userId, current.session_id)
    if (current.revision !== personRevision(body.expected_revision)) throw personError('Task changed; query it again', 409)
    if (current.execution_state === 'stopping') throw personError('Task is stopping; wait for acknowledgement', 409)
    if (Object.hasOwn(body, 'expected_execution_id') && body.expected_execution_id !== (current.execution_id || null)) throw personError('Execution changed; query the task again', 409)
    if (current.status === 'closed') throw personError('Reopen the task before continuing', 409)
    personDb().prepare("UPDATE session_tasks SET status='open',completion_evidence='',completed_at=NULL,revision=revision+1,updated_at=? WHERE id=?")
      .run(Date.now(), taskId)
    savePersonTaskOrigin(userId, taskId, origin)
    const next = getPersonTask(userId, taskId)
    const execution = enqueuePersonExecution(next, null, input, true)
    return { task: { ...getPersonTask(userId, taskId), running: true }, execution, pending: pendingPersonInputs(userId, taskId) }
  })
  personUpdated(userId)
  return result
}
