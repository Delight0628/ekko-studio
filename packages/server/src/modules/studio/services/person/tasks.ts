import { randomUUID } from 'node:crypto'
import { personError, personRevision, personText } from '../../contracts/person'
import type { PersonExecution, PersonTaskOrigin } from '../../contracts/person'
import { personDb, replayPersonOperation, adoptPersonGoal, personOperation, getPersonTask, personTaskRunning, createPersonTask, updatePersonTask, enqueuePersonExecution } from '../../repositories/person-store'
import { personWorkspace } from './workspace'
import { ensureDirectory } from '../workspace/directory'
import { validatePersonSelection } from './catalog'
import { selectPersonExecutionAgent } from './agents'
import { savePersonTaskOrigin } from './delivery'

const running = new Map<string, AbortController>()
export function personRunSignal(run: PersonExecution) { const controller = new AbortController(); running.set(run.id, controller); return controller }
export function releasePersonRun(id: string) { running.delete(id) }
export async function applyPersonTask(userId: number, input: Record<string, unknown>, boundTask?: string, origin?: PersonTaskOrigin) {
  const action = personText(input.action, 'action', 30)
  if (!['create','adopt','update','start','close','reopen'].includes(action)) throw personError('Unsupported task action')
  const key = personText(input.idempotency_key, 'idempotency_key', 200)
  if (boundTask && (input.task_id !== boundTask || action === 'create' || action === 'adopt')) throw personError('Task is outside this coordinator scope', 403)
  const replay = replayPersonOperation(userId, `task:${key}`, input)
  if (replay !== undefined) return replay
  const selection = ['create','adopt'].includes(action) ? await selectPersonExecutionAgent(userId, input.agent_id) : null
  if (selection) await validatePersonSelection(userId, selection)
  if (action === 'start') await validatePersonSelection(userId, JSON.parse(getPersonTask(userId, String(input.task_id)).selection_json))
  const taskWorkspace = personWorkspace(userId)
  if (input.workspace && input.workspace !== taskWorkspace) throw personError('Task workspace is managed by Person settings')
  if (['create','adopt'].includes(action)) await ensureDirectory(taskWorkspace)
  return personOperation(userId, `task:${key}`, input, () => {
    if (action === 'adopt') {
      const task = adoptPersonGoal(userId, personText(input.task_id,'task_id',100),personRevision(input.expected_revision),selection!,taskWorkspace,personText(input.goal,'goal',8000))
      savePersonTaskOrigin(userId, task.id, origin)
      return { task, execution: input.start === false ? undefined : enqueuePersonExecution(task) }
    }
    if (action === 'create') {
      const task = createPersonTask(userId, personText(input.title, 'title', 200), personText(input.goal, 'goal', 8000), selection!, taskWorkspace)
      savePersonTaskOrigin(userId, task.id, origin)
      return { task, execution: input.start === false ? undefined : enqueuePersonExecution(task) }
    }
    const task = getPersonTask(userId, personText(input.task_id, 'task_id', 100))
    if (task.revision !== personRevision(input.expected_revision)) throw personError('Task changed; query it again', 409)
    if (personTaskRunning(task.id)) throw personError('Task is running; wait for it to finish', 409)
    const db = personDb()
    if (action === 'reopen') {
      if (task.status === 'open') throw personError('Task is already open',409)
      db.prepare("UPDATE session_tasks SET status='open',completion_evidence='',completed_at=NULL,revision=revision+1,updated_at=? WHERE id=?").run(Date.now(),task.id)
    } else if (action === 'update') {
      savePersonTaskOrigin(userId, task.id, origin)
      return { task: updatePersonTask(userId, task.id, task.revision, personText(input.goal, 'goal', 8000)) }
    } else if (action === 'start') {
      savePersonTaskOrigin(userId, task.id, origin)
      const execution = enqueuePersonExecution(task)
      db.prepare('UPDATE session_tasks SET revision=revision+1,updated_at=? WHERE id=?').run(Date.now(), task.id)
      return { task: getPersonTask(userId, task.id), execution }
    } else if (action === 'close') {
      if (boundTask) throw personError('Only the user-facing controller can close a goal', 403)
      db.prepare("UPDATE session_tasks SET status='closed',revision=revision+1,updated_at=? WHERE id=?").run(Date.now(),task.id)
      db.prepare("UPDATE person_schedules SET state='cancelled',revision=revision+1 WHERE task_id=? AND state IN ('active','paused')").run(task.id)
    }
    return { task: getPersonTask(userId, task.id) }
  })
}
export function personOperationKey() { return randomUUID() }
