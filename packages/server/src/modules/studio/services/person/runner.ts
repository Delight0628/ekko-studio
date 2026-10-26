import { personUpdated } from '../../repositories/person-updates'
import { createHash } from 'node:crypto'
import { personRuntime } from '../../public/person-runtime'
import { personError } from '../../contracts/person'
import type { PersonExecution, PersonInteraction } from '../../contracts/person'
import { personDb, personTransaction, personSettings, getPersonExecution, getPersonTask, setPersonExecution, personEvent,
  addPersonInteraction, answerPersonInteraction, enqueuePersonExecution } from '../../repositories/person-store'
import { personUser, validatePersonSelection } from './catalog'
import { runPersonModel } from './model'
import { personTools, personTool } from './tools'
import { personRunSignal, releasePersonRun } from './tasks'
import { tickPersonSchedules } from './schedules'
import { logger } from '../../public/logging'

const active = new Map<string, { run: PersonExecution; abort: AbortController }>()
const busyTasks = new Set<string>()
const coordinating = new Set<string>()
let timer: ReturnType<typeof setInterval> | undefined
let ticking = false

function current(run: PersonExecution) {
  const actual = getPersonExecution(run.owner_user_id, run.id)
  const task = getPersonTask(run.owner_user_id, run.task_id)
  if (actual.generation !== run.generation || ['paused','stopping','cancelled','interrupted','failed','finished'].includes(actual.state)
    || task.status !== 'open' || task.requirements_revision !== run.requirements_revision) throw personError('Execution is no longer current', 409)
  return actual
}
async function deliver(run: PersonExecution, question: PersonInteraction, answer: string, actor: 'user' | 'person') {
  current(run)
  const accepted = answerPersonInteraction(run.owner_user_id, question.id, question.revision, answer, actor)
  if (!await personRuntime().answer(run.session_id, question.native_id, answer, question.kind === 'approval')) {
    personEvent(run, 'answer.undelivered', { interaction_id: question.id })
    throw personError('Original question expired; resume from the saved answer', 409)
  }
  current(run)
  personDb().prepare("UPDATE person_executions SET state='running',updated_at=? WHERE id=? AND generation=? AND state IN ('waiting_person','waiting_user','waiting_approval')").run(Date.now(),run.id,run.generation)
  personEvent(run, 'answer.delivered', { interaction_id: question.id, actor, answer: accepted.answer })
}
export async function replyPersonQuestion(userId: number, id: string, revision: number, answer: string) {
  const question = personDb().prepare('SELECT * FROM person_interactions WHERE id=? AND owner_user_id=?').get(id, userId) as unknown as PersonInteraction | undefined
  if (!question || question.revision !== revision || question.state !== 'pending') throw personError('Question expired or changed', 409)
  if (question.kind === 'approval') {
    const choices = JSON.parse(question.choices_json) as string[]
    if (!choices.includes(answer) || !['once','session','deny'].includes(answer)) throw personError('Unsupported approval choice')
  }
  const run = getPersonExecution(userId, question.execution_id)
  if (question.native_id.startsWith('review:')) {
    return personTransaction(() => {
      if (run.state !== 'paused') throw personError('Review decision expired', 409)
      answerPersonInteraction(userId, id, revision, answer, 'user')
      personDb().prepare("UPDATE person_executions SET state='interrupted',generation=generation+1 WHERE id=? AND state='paused'").run(run.id)
      return { execution: enqueuePersonExecution(getPersonTask(userId, run.task_id)), delivered: true }
    })
  }
  await deliver(run, question, answer, 'user')
  return { delivered: true }
}
async function coordinate(run: PersonExecution, nativeId: string, questionText: string, choices: string[], approval: boolean, signal: AbortSignal) {
  current(run)
  const question = addPersonInteraction(run.owner_user_id, run, nativeId, questionText.slice(0,4000), (approval && !choices.length ? ['once','session','deny'] : choices).slice(0,5), approval ? 'approval' : 'question')
  if (question.state !== 'pending') return
  setPersonExecution(current(run), approval ? 'waiting_approval' : 'waiting_person')
  if (approval) return // Coding agents normally bypass this; existing interactive runtimes keep their real approvals.
  let decision: { answer?: string; escalation?: string } | undefined
  const tools = personTools(run.owner_user_id, 'coordinator', run.task_id)
  tools.push(personTool('bot_interaction_reply', 'Answer this worker question from existing requirements or retrieved facts; escalate only missing user intent or expanded scope.', {
    answer: { type: 'string' }, escalation: { type: 'string' }, basis: { type: 'string' },
  }, ['basis'], async args => {
    current(run)
    const answer = typeof args.answer === 'string' ? args.answer.trim().slice(0,4000) : ''
    const escalation = typeof args.escalation === 'string' ? args.escalation.trim().slice(0,2000) : ''
    if ((!answer && !escalation) || (answer && escalation)) throw personError('Provide either answer or escalation')
    decision = { answer, escalation }; personEvent(run, 'person.decision', { ...decision, basis: String(args.basis || '').slice(0,2000) })
    return { recorded: true }
  }))
  const task = getPersonTask(run.owner_user_id, run.task_id)
  const decisions = personDb().prepare("SELECT substr(question,1,300) AS question,substr(answer,1,600) AS answer,answered_by FROM person_interactions WHERE task_id=? AND state='answered' ORDER BY created_at DESC LIMIT 6").all(task.id)
  await runPersonModel(run.owner_user_id, 'coordinator', [{ role: 'user', content: JSON.stringify({ task: { title: task.title, requirements: JSON.parse(task.requirements_json) }, question: question.question, choices, decisions }) }], tools, signal,
    'You answer a delegated agent on behalf of Person within the existing task scope. Use bot_interaction_reply once. Read relevant evidence when needed. Do not ask the human about routine implementation choices.',
    event => personEvent(run, 'coordinator.event', event), () => { current(run) })
  current(run)
  const pending = personDb().prepare("SELECT id FROM person_interactions WHERE id=? AND revision=? AND state='pending'").get(question.id,question.revision)
  if (!pending) return
  if (decision?.answer) await deliver(run, question, decision.answer, 'person')
  else {
    if (decision?.escalation) personDb().prepare("UPDATE person_interactions SET question=? WHERE id=? AND state='pending'").run(decision.escalation, question.id)
    setPersonExecution(current(run), 'waiting_user')
  }
}

async function review(run: PersonExecution, signal: AbortSignal) {
  const task = getPersonTask(run.owner_user_id, run.task_id)
  const output = getPersonExecution(run.owner_user_id, run.id).output
  const digest = createHash('sha256').update(output).digest('hex')
  let verdict: { result: string; evidence: string; missing: string } | undefined
  const evidenceReads: Array<{ tool: string; input: Record<string, unknown>; digest: string }> = []
  const tools = personTools(run.owner_user_id, 'reviewer', run.task_id).map(tool => ({ ...tool, async execute(input: Record<string, unknown>) {
    const value = await tool.execute(input)
    if (tool.name === 'bot_artifact_read' && input.path && input.execution_id === run.id) evidenceReads.push({ tool: tool.name, input, digest: createHash('sha256').update(JSON.stringify(value)).digest('hex') })
    return value
  } }))
  tools.push(personTool('bot_review_submit', 'Submit independent acceptance against the latest requirements. Pass requires evidence from actual artifacts or execution receipts, not just the worker claim.', {
    result: { type: 'string', enum: ['pass','rework','needs_user','inconclusive'] }, evidence: { type: 'string' }, missing: { type: 'string' },
  }, ['result','evidence'], async args => {
    current(run)
    if (!['pass','rework','needs_user','inconclusive'].includes(String(args.result)) || typeof args.evidence !== 'string' || !args.evidence.trim()) throw personError('Valid verdict and evidence required')
    if (args.result === 'pass' && evidenceReads.length === 0) throw personError('Read at least one actual task artifact before passing. Use inconclusive when only a worker claim is available.')
    verdict = { result: String(args.result), evidence: args.evidence.slice(0,6000), missing: String(args.missing || '').slice(0,4000) }
    return { recorded: true }
  }))
  await runPersonModel(run.owner_user_id, 'reviewer', [{ role: 'user', content: JSON.stringify({ title: task.title, requirements: JSON.parse(task.requirements_json), execution_id: run.id, output_preview: output.slice(0,3000) }) }], tools, signal,
    'Independently verify the task against each acceptance criterion. Use artifact and execution evidence tools before passing. Report missing evidence honestly. Do not modify files. Finish with bot_review_submit.',
    event => personEvent(run, 'reviewer.event', event), () => { current(run) })
  current(run)
  if (!verdict) verdict = { result: 'inconclusive', evidence: 'Reviewer did not submit acceptance evidence', missing: '' }
  if (createHash('sha256').update(getPersonExecution(run.owner_user_id, run.id).output).digest('hex') !== digest) throw personError('Output changed during review', 409)
  for (const read of evidenceReads) {
    const tool = personTools(run.owner_user_id, 'reviewer', run.task_id).find(t => t.name === read.tool)!
    if (createHash('sha256').update(JSON.stringify(await tool.execute(read.input))).digest('hex') !== read.digest) throw personError('Evidence changed during review', 409)
  }
  const receipt = { ...verdict, requirements_revision: run.requirements_revision, output_hash: digest, artifacts: evidenceReads.map(read => ({...read.input,digest:read.digest})) }
  personEvent(run, 'review.completed', receipt)
  return receipt
}

async function execute(run: PersonExecution, abort: AbortController) {
  const userId = run.owner_user_id
  const heartbeat = setInterval(() => {
    try {
      current(run)
      const account = personUser(userId)
      const selection = JSON.parse(run.selection_json)
      if (account.role !== 'super_admin' && (!account.profiles.includes(selection.profile) || selection.mode === 'global')) throw personError('Execution permission revoked', 403)
      personDb().prepare('UPDATE person_executions SET lease_until=? WHERE id=? AND generation=?').run(Date.now() + 90_000, run.id, run.generation)
    } catch { abort.abort(new Error('Execution lease revoked')) }
  }, 15000)
  heartbeat.unref()
  try {
    const selection = JSON.parse(run.selection_json)
    await validatePersonSelection(userId, selection)
    const task = getPersonTask(userId, run.task_id)
    const decisions = personDb().prepare("SELECT question,answer,answered_by FROM person_interactions WHERE task_id=? AND state='answered' ORDER BY created_at DESC LIMIT 10").all(task.id)
    let prompt = JSON.stringify({ title: task.title, requirements: JSON.parse(task.requirements_json), decisions })
    for (let round = 0; round <= personSettings(userId).settings.maxReviewRounds; round++) {
      current(run)
      const result = await personRuntime().execute({ user: personUser(userId), selection, sessionId: run.session_id, workspace: task.workspace, prompt, signal: abort.signal,
        onEvent: (kind, payload) => {
          try {
            current(run)
            if (!kind.endsWith('.delta')) personEvent(run, kind, payload)
            if (kind === 'run.started') setPersonExecution(current(run), 'running')
            if (kind === 'clarify.requested' || kind === 'approval.requested') {
              const id = String(payload.clarify_id || payload.approval_id || '')
              const questionKey = `${run.id}:${id}`
              if (!id || coordinating.has(questionKey)) return
              coordinating.add(questionKey)
              void coordinate(run, id, String(payload.question || payload.description || 'Input required'), Array.isArray(payload.choices) ? payload.choices.map(String) : [], kind === 'approval.requested', abort.signal)
                .catch(error => {
                  try {
                    const actual = current(run)
                    if (actual.state === 'waiting_person') setPersonExecution(actual, 'waiting_user')
                    personEvent(run, 'coordinator.failed', { error: String(error) })
                  } catch { /* stale run */ }
                }).finally(() => coordinating.delete(questionKey))
            }
          } catch { /* Late native events must not revive a cancelled run. */ }
        },
      })
      current(run)
      if (!result.ok) throw new Error(result.error || 'Execution failed')
      const output = (result.output || '').slice(0,2_000_000)
      setPersonExecution(current(run), 'reviewing', { output })
      const verdict = await review(run, abort.signal)
      current(run)
      if (verdict.result === 'pass') {
        personTransaction(() => {
          current(run)
          setPersonExecution(current(run), 'finished', { review: verdict })
          const recurring = personDb().prepare("SELECT id FROM person_schedules WHERE task_id=? AND state IN ('active','paused')").get(task.id)
          if (!recurring) personDb().prepare("UPDATE session_tasks SET status='completed',completion_evidence=?,revision=revision+1,completed_at=?,updated_at=? WHERE id=? AND requirements_revision=? AND status='open'")
            .run(verdict.evidence, Date.now(), Date.now(), task.id, run.requirements_revision)
          if (run.occurrence_id) personDb().prepare("UPDATE person_occurrences SET state='finished' WHERE id=?").run(run.occurrence_id)
        })
        return
      }
      if (verdict.result !== 'rework' || round >= personSettings(userId).settings.maxReviewRounds) {
        setPersonExecution(current(run), 'paused', { review: verdict, error: verdict.missing || verdict.evidence })
        addPersonInteraction(userId, run, `review:${round}`, (verdict.missing || verdict.evidence).slice(0,2000), [])
        return
      }
      personDb().prepare('UPDATE person_executions SET review_round=?,review_json=? WHERE id=? AND generation=?').run(round + 1, JSON.stringify(verdict), run.id, run.generation)
      setPersonExecution(current(run), 'running')
      prompt = `Continue this same task. Independent review found:\n${verdict.missing}\n${verdict.evidence}\nCorrect the missing work and provide verification evidence.`
    }
  } catch (error) {
    try { setPersonExecution(current(run), 'failed', { error: error instanceof Error ? error.message : 'Task failed' }) } catch { /* cancellation wins */ }
  } finally {
    const latest = getPersonExecution(userId, run.id)
    if (['failed','finished','interrupted','cancelled'].includes(latest.state)) personDb().prepare("UPDATE person_interactions SET state='expired',revision=revision+1 WHERE execution_id=? AND state='pending'").run(run.id)
    personUpdated(userId)
    clearInterval(heartbeat); active.delete(run.id); busyTasks.delete(run.task_id); releasePersonRun(run.id)
  }
}

export async function tickPersonWork() {
  if (ticking) return
  ticking = true
  try {
    tickPersonSchedules()
    const db = personDb()
    const stopping = db.prepare("SELECT * FROM person_executions WHERE state='stopping' LIMIT 30").all() as unknown as PersonExecution[]
    for (const run of stopping) {
      try {
        await personRuntime().stop(run.session_id)
        personTransaction(() => {
          const changed = db.prepare("UPDATE person_executions SET state=?,updated_at=? WHERE id=? AND generation=? AND state='stopping'")
            .run(run.stop_action === 'restart' ? 'interrupted' : run.stop_action, Date.now(), run.id, run.generation)
          if (changed.changes && run.stop_action === 'restart') enqueuePersonExecution(getPersonTask(run.owner_user_id, run.task_id))
        })
      } catch (error) { logger.warn(error, 'Person stop acknowledgement failed; intent retained') }
    }
    // Lost workers are visible as interrupted, never silently counted as running.
    const expired = db.prepare("SELECT * FROM person_executions WHERE state IN ('starting','running','waiting_person','waiting_user','waiting_approval','reviewing') AND lease_until<?").all(Date.now()) as unknown as PersonExecution[]
    for (const run of expired) {
      if (active.has(run.id)) continue
      const fenced = db.prepare("UPDATE person_executions SET state='stopping',stop_action='interrupted',generation=generation+1,error='Execution interrupted; inspect and resume',updated_at=? WHERE id=? AND generation=? AND lease_until<?").run(Date.now(), run.id, run.generation, Date.now())
      if (!fenced.changes) continue
      db.prepare("UPDATE person_interactions SET state='expired',revision=revision+1 WHERE execution_id=? AND state='pending'").run(run.id)
    }
    const queued = db.prepare("SELECT * FROM person_executions WHERE state='queued' ORDER BY created_at LIMIT 30").all() as unknown as PersonExecution[]
    for (const next of queued) {
      if (active.size >= 6) break
      if (busyTasks.has(next.task_id)) continue
      const count = Number((db.prepare("SELECT COUNT(*) AS n FROM person_executions WHERE owner_user_id=? AND state IN ('starting','running','waiting_person','waiting_user','waiting_approval','reviewing','stopping')").get(next.owner_user_id) as { n: number }).n)
      if (count >= personSettings(next.owner_user_id).settings.maxConcurrentTasks) continue
      const claim = db.prepare("UPDATE person_executions SET state='starting',generation=generation+1,lease_until=?,updated_at=? WHERE id=? AND state='queued'").run(Date.now() + 90_000, Date.now(), next.id)
      if (!claim.changes) continue
      const run = getPersonExecution(next.owner_user_id, next.id)
      const abort = personRunSignal(run)
      active.set(run.id, { run, abort }); busyTasks.add(run.task_id)
      void execute(run, abort)
    }
  } finally { ticking = false }
}
export function startPersonWork() {
  if (timer) return
  timer = setInterval(() => { void tickPersonWork().catch(error => logger.warn(error, 'Person scheduler failed')) }, 3000)
  timer.unref()
}
export async function stopPersonWork() {
  if (timer) clearInterval(timer); timer = undefined
  for (const { run, abort } of active.values()) {
    personDb().prepare("UPDATE person_executions SET state='interrupted',generation=generation+1 WHERE id=? AND generation=?").run(run.id, run.generation)
    abort.abort(); await personRuntime().stop(run.session_id)
  }
}
