import { randomUUID } from 'node:crypto'
import { getDb, isSqliteAvailable } from '../infrastructure/database'
import { MESSAGES_TABLE, SESSIONS_TABLE, SESSION_TASKS_TABLE } from '../infrastructure/database/schemas'
import type { SessionTask, SessionTasksSnapshot, SessionTaskChange } from '../contracts/session-task'

export interface SessionTasksState {
  session_id: string
  profile: string
  source: string
  history_revision: number
  revision: number
  updated_at: number
}
export function getSessionTasksState(sessionId: string): SessionTasksState | null {
  if (!isSqliteAvailable()) return null
  return getDb()!.prepare(`SELECT id AS session_id, profile, source, history_revision, task_summary_revision AS revision, task_summary_updated_at AS updated_at
    FROM ${SESSIONS_TABLE} WHERE id = ?`).get(sessionId) as unknown as SessionTasksState || null
}

export function getSessionTasks(sessionId: string): SessionTasksSnapshot {
  const state = getSessionTasksState(sessionId)
  const tasks = state ? getDb()!.prepare(`SELECT id, title, summary, status, source_message_id,
    evidence_message_id, completion_evidence, created_at, updated_at, completed_at
    FROM ${SESSION_TASKS_TABLE} WHERE session_id = ? ORDER BY created_at, id`).all(sessionId) as unknown as SessionTask[] : []
  return { session_id: sessionId, revision: state?.revision || 0, updated_at: state?.updated_at || 0, tasks }
}

const titleKey = (title: string) => title.normalize('NFKC').toLowerCase().replace(/\s+/g, '').trim()

/** Revision checks and upserts commit together. Omitted goals are retained. */
export function commitSessionTasks(
  expected: SessionTasksState, changes: SessionTaskChange[],
): SessionTasksSnapshot | null {
  const db = getDb()
  if (!db) return null
  const current = getSessionTasksState(expected.session_id)
  if (!current || current.profile !== expected.profile || current.history_revision !== expected.history_revision
    || current.revision !== expected.revision) return null
  const source = db.prepare(`SELECT id FROM ${MESSAGES_TABLE} WHERE session_id = ?
    AND role = 'user' AND COALESCE(display_role, role) = 'user' AND content NOT LIKE '/%' ORDER BY id DESC LIMIT 1`)
    .get(expected.session_id) as { id: number } | undefined
  if (!source) throw new Error('Session goals require a user request')
  const anchor = db.prepare(`SELECT MAX(id) AS id FROM ${MESSAGES_TABLE} WHERE session_id = ?`)
    .get(expected.session_id) as { id: number }
  const previous = getSessionTasks(expected.session_id).tasks
  const byId = new Map(previous.map(task => [task.id, task]))
  const byTitle = new Map(previous.map(task => [titleKey(task.title), task]))
  const seen = new Set<string>()
  const now = Date.now()
  const tasks: SessionTask[] = []
  for (const change of changes) {
    const old = change.id ? byId.get(change.id) : byTitle.get(titleKey(change.title))
    if (change.id && !old) throw new Error('Unknown session goal id')
    const sameTitle = byTitle.get(titleKey(change.title))
    if (sameTitle && old && sameTitle.id !== old.id) throw new Error('Goal title belongs to another goal')
    const id = old?.id || randomUUID()
    if (seen.has(id) || tasks.some(task => titleKey(task.title) === titleKey(change.title))) throw new Error('Duplicate goal in summary')
    seen.add(id)
    const status = change.status
    const evidence = status === 'completed' ? change.completion_evidence?.trim() || old?.completion_evidence || '' : ''
    if (status === 'completed' && !evidence) throw new Error('Completed goals require completion_evidence describing verified delivery')
    const evidenceId = status === 'completed'
      ? (old?.status === 'completed' && evidence === old.completion_evidence ? old.evidence_message_id : anchor.id) : null
    const task: SessionTask = {
      id, title: change.title, summary: change.summary, status,
      source_message_id: old?.source_message_id || source.id,
      evidence_message_id: status === 'completed' ? evidenceId : null,
      completion_evidence: status === 'completed' ? evidence : '',
      created_at: old?.created_at || now, updated_at: now,
      completed_at: status === 'completed' ? old?.completed_at || now : null,
    }
    tasks.push(task)
    byTitle.set(titleKey(task.title), task)
  }
  if (previous.length + tasks.filter(task => !byId.has(task.id)).length > 200) throw new Error('Session goal limit exceeded')
  db.exec('BEGIN')
  try {
    const claimed = db.prepare(`UPDATE ${SESSIONS_TABLE} SET task_summary_revision = task_summary_revision + 1, task_summary_updated_at = ?
      WHERE id = ? AND profile = ? AND history_revision = ? AND task_summary_revision = ?`)
      .run(now, expected.session_id, expected.profile, expected.history_revision, expected.revision)
    if (!claimed.changes) { db.exec('ROLLBACK'); return null }
    const save = db.prepare(`INSERT INTO ${SESSION_TASKS_TABLE}
      (id, session_id, title, summary, status, source_message_id, evidence_message_id, completion_evidence, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, summary = excluded.summary, status = excluded.status,
      evidence_message_id = excluded.evidence_message_id, completion_evidence = excluded.completion_evidence,
      updated_at = excluded.updated_at, completed_at = excluded.completed_at`)
    for (const task of tasks) save.run(task.id, expected.session_id, task.title, task.summary, task.status,
      task.source_message_id, task.evidence_message_id, task.completion_evidence, task.created_at, task.updated_at, task.completed_at)
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
  return getSessionTasks(expected.session_id)
}
