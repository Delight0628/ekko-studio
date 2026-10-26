import { mkdir } from 'node:fs/promises'
import { resolve, isAbsolute } from 'node:path'
import { config } from '../../public/config'
import { randomUUID, createHash } from 'node:crypto'
import { personError, personRevision, personText } from '../../contracts/person'
import type { PersonExecution } from '../../contracts/person'
import { personDb, replayPersonOperation, adoptPersonGoal, personOperation, getPersonTask, taskPersonExecutions, createPersonTask, updatePersonTask, enqueuePersonExecution, resolvePersonSelection } from '../../repositories/person-store'
import { validatePersonSelection } from './catalog'
import { personRuntime } from '../../public/person-runtime'

const running = new Map<string, AbortController>()
export function personRunSignal(run: PersonExecution) { const controller = new AbortController(); running.set(run.id, controller); return controller }
export function releasePersonRun(id: string) { running.delete(id) }
export async function stopPersonRun(run: PersonExecution) {
  running.get(run.id)?.abort(new Error('Task stopped'))
  await personRuntime().stop(run.session_id)
}
export async function applyPersonTask(userId: number, input: Record<string, unknown>, boundTask?: string) {
  const action = personText(input.action, 'action', 30)
  const key = personText(input.idempotency_key, 'idempotency_key', 200)
  if (boundTask && (input.task_id !== boundTask || action === 'create')) throw personError('Task is outside this coordinator scope', 403)
  const replay = replayPersonOperation(userId, `task:${key}`, input)
  if (replay !== undefined) return replay
  const selection = ['create','adopt'].includes(action) ? resolvePersonSelection(userId, personText(input.selection_ref, 'selection_ref', 100)) : null
  if (selection) await validatePersonSelection(userId, selection)
  if (action === 'start' || action === 'resume') await validatePersonSelection(userId, JSON.parse(getPersonTask(userId, String(input.task_id)).selection_json))
  const workspace = String(input.workspace || '')
  if (workspace && !isAbsolute(workspace)) throw personError('Workspace must be an absolute path')
  const taskWorkspace = workspace || resolve(config.appHome, 'person', String(userId), 'workspaces', createHash('sha256').update(key).digest('hex').slice(0,24))
  if (['create','adopt'].includes(action)) await mkdir(taskWorkspace, { recursive: true })
  let stop: PersonExecution | undefined
  const result = personOperation(userId, `task:${key}`, input, () => {
    if (action === 'adopt') {
      if (boundTask) throw personError('Task outside role scope',403)
      const task = adoptPersonGoal(userId, personText(input.task_id,'task_id',100),personRevision(input.expected_revision),selection!,taskWorkspace,personText(input.goal,'goal',8000),personText(input.acceptance,'acceptance',4000))
      return { task, execution: input.start === false ? undefined : enqueuePersonExecution(task) }
    }
    if (action === 'create') {
      const task = createPersonTask(userId, personText(input.title, 'title', 200), personText(input.goal, 'goal', 8000), personText(input.acceptance, 'acceptance', 4000), selection!, taskWorkspace)
      const execution = input.start === false ? undefined : enqueuePersonExecution(task)
      return { task, execution }
    }
    const task = getPersonTask(userId, personText(input.task_id, 'task_id', 100))
    if (task.revision !== personRevision(input.expected_revision)) throw personError('Task changed; query it again', 409)
    const executions = taskPersonExecutions(userId, task.id)
    const active = executions.find(e => ['queued','starting','stopping','running','waiting_person','waiting_user','waiting_approval','reviewing','paused'].includes(e.state))
    const db = personDb()
    const invalidate = (intent: string) => {
      if (!active) return
      db.prepare("UPDATE person_executions SET state='stopping',stop_action=?,generation=generation+1,updated_at=? WHERE id=?").run(intent, Date.now(), active.id)
      db.prepare("UPDATE person_interactions SET state='expired',revision=revision+1 WHERE execution_id=? AND state='pending'").run(active.id)
      stop = active
    }
    if (action === 'reopen') {
      if (task.status === 'open') throw personError('Task is already open',409)
      db.prepare("UPDATE session_tasks SET status='open',completion_evidence='',completed_at=NULL,revision=revision+1,updated_at=? WHERE id=?").run(Date.now(),task.id)
      return { task: getPersonTask(userId,task.id) }
    }
    if (action === 'update' || action === 'steer') {
      invalidate('restart')
      const updated = updatePersonTask(userId, task.id, task.revision, personText(input.goal, 'goal', 8000), personText(input.acceptance, 'acceptance', 4000))
      return { task: updated, stopping: !!active }
    }
    if (action === 'pause' || action === 'cancel') {
      invalidate(action === 'pause' ? 'paused' : 'cancelled')
    } else if (action === 'resume' || action === 'start') {
      if (active?.state === 'paused') db.prepare("UPDATE person_executions SET state='interrupted',generation=generation+1 WHERE id=?").run(active.id)
      else if (active) throw personError('Task is already active', 409)
      const execution = enqueuePersonExecution(task)
      db.prepare('UPDATE session_tasks SET revision=revision+1,updated_at=? WHERE id=?').run(Date.now(), task.id)
      return { task: getPersonTask(userId, task.id), execution }
    } else if (action === 'close') {
      if (boundTask) throw personError('Only the user-facing controller can close a goal', 403)
      invalidate('cancelled')
      db.prepare("UPDATE session_tasks SET status='closed' WHERE id=?").run(task.id)
      db.prepare("UPDATE person_schedules SET state='cancelled',revision=revision+1 WHERE task_id=? AND state IN ('active','paused')").run(task.id)
    } else throw personError('Unsupported task action')
    db.prepare('UPDATE session_tasks SET revision=revision+1,updated_at=? WHERE id=?').run(Date.now(), task.id)
    return { task: getPersonTask(userId, task.id) }
  })
  if (stop) running.get(stop.id)?.abort(new Error('Task stop requested')) // Durable stop intent is acknowledged by the scheduler.
  return result
}
export function personOperationKey() { return randomUUID() }
