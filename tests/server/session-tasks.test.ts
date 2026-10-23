import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

let db: DatabaseSync
let sessions: typeof import('../../packages/server/src/modules/studio/repositories/session-store')
let service: typeof import('../../packages/server/src/modules/studio/services/session-tasks')
beforeEach(async () => {
  vi.resetModules()
  db = new DatabaseSync(':memory:')
  vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({ getDb: () => db, isSqliteAvailable: () => true }))
  const schema = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
  schema.initAllHermesTables()
  sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
  service = await import('../../packages/server/src/modules/studio/services/session-tasks')
  sessions.createSession({ id: 's1', profile: 'research', source: 'coding_agent' })
})
afterEach(() => {
  db.close()
  vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
})
function message(role: string, content: string, sessionId = 's1') {
  return Number(sessions.addMessage({ session_id: sessionId, role, content, timestamp: Date.now() }))
}
const goal = (overrides = {}) => ({ title: 'Add data export', summary: 'Requested; implementation pending', status: 'open', ...overrides })
const write = (changes: unknown[], revision = service.getSessionTasks('s1').revision) => service.updateSessionTasks('s1', 'research', { revision, changes })

describe('conversation-maintained session goals', () => {
  it('creates multiple goals before execution, completes only verified outcomes, and retains omitted tasks across turns', () => {
    const source = message('user', 'Add data export and fix login')
    const first = write([goal(), goal({ title: 'Fix login' })])
    const exportGoal = first.tasks.find(task => task.title === 'Add data export')!
    expect(first.tasks.every(task => task.status === 'open')).toBe(true)
    expect(exportGoal.source_message_id).toBe(source)
    message('tool', 'CSV export integration tests pass')
    const second = write([goal({ id: exportGoal.id, summary: 'CSV export delivered', status: 'completed', completion_evidence: 'CSV integration tests passed' })])
    expect(second.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: exportGoal.id, status: 'completed', completed_at: expect.any(Number) }),
      expect.objectContaining({ title: 'Fix login', status: 'open' }),
    ]))
    message('assistant', 'CSV export delivered; login is still pending')
    message('user', 'Large export files still fail; please fix that')
    const third = write([goal({ id: exportGoal.id, summary: 'Large exports fail; investigating' })])
    expect(third.tasks.find(task => task.id === exportGoal.id)).toMatchObject({ status: 'open', source_message_id: source, completed_at: null, completion_evidence: '' })
    expect(third.tasks).toHaveLength(2)
    expect(db.prepare('SELECT COUNT(*) AS n FROM task_plans').get()).toMatchObject({ n: 0 })
  })

  it('reuses ids for repeated titles and survives service reloads without a separate model', async () => {
    message('user', 'Add data export')
    const first = write([goal()])
    message('user', 'Continue export')
    const nextService = await import('../../packages/server/src/modules/studio/services/session-tasks')
    const next = nextService.updateSessionTasks('s1', 'research', { revision: first.revision, changes: [goal({ title: 'Add Data Export', summary: 'Continuing' })] })
    expect(next.tasks).toHaveLength(1)
    expect(next.tasks[0].id).toBe(first.tasks[0].id)
    expect(next.tasks[0].source_message_id).toBe(first.tasks[0].source_message_id)
  })

  it('keeps tasks open when a turn ends or is interrupted without an explicit verified completion', () => {
    message('user', 'Add export')
    const first = write([goal()])
    message('assistant', 'I will implement it next')
    expect(service.getSessionTasks('s1')).toEqual(first)
    expect(() => write([goal({ id: first.tasks[0].id, status: 'completed' })])).toThrow('completion_evidence')
    expect(service.getSessionTasks('s1')).toEqual(first)
  })

  it('rejects stale revisions, another profile, foreign ids and mixed invalid batches atomically', () => {
    message('user', 'Add export')
    const first = write([goal()])
    expect(() => write([goal()], 0)).toThrow('changed')
    expect(() => service.updateSessionTasks('s1', 'other', { revision: 1, changes: [goal()] })).toThrow('unavailable')
    sessions.createSession({ id: 's2', profile: 'research', source: 'coding_agent' })
    message('user', 'Do another task', 's2')
    const foreign = service.updateSessionTasks('s2', 'research', { revision: 0, changes: [goal()] }).tasks[0]
    expect(() => write([goal({ summary: 'Should roll back' }), goal({ id: foreign.id, title: 'Other task' })])).toThrow('Unknown')
    expect(service.getSessionTasks('s1')).toEqual(first)
  })

  it('rejects history changes even when the caller supplies the latest task revision', () => {
    message('user', 'Add export')
    write([goal()])
    sessions.clearSessionMessages('s1')
    message('user', 'New task')
    expect(() => service.updateSessionTasks('s1', 'research', { revision: service.getSessionTasks('s1').revision, changes: [goal()] }, 0)).toThrow('history changed')
  })

  it('reopens goals when completion anchors are deleted and removes goals when their request anchors are deleted', async () => {
    const source = message('user', 'Add export')
    const first = write([goal()])
    const evidence = message('tool', 'CSV tests passed')
    write([goal({ id: first.tasks[0].id, status: 'completed', completion_evidence: 'CSV checks passed' })])
    const { deleteSessionMessageGroups } = await import('../../packages/server/src/modules/studio/repositories/session-message-deletion')
    deleteSessionMessageGroups('s1', [evidence], 0)
    expect(service.getSessionTasks('s1').tasks[0]).toMatchObject({ status: 'open', completed_at: null, evidence_message_id: null })
    deleteSessionMessageGroups('s1', [source], 1)
    expect(service.getSessionTasks('s1').tasks).toEqual([])
  })

  it.each(['clearSessionMessages', 'deleteSession'] as const)('cleans up goals with %s and rejects old revisions', method => {
    message('user', 'Add export')
    write([goal()])
    sessions[method]('s1')
    expect(service.getSessionTasks('s1').tasks).toEqual([])
    expect(() => write([goal()], 1)).toThrow()
  })

  it.each(['group_chat', 'workflow', 'global_agent'])('rejects writes from %s sessions', source => {
    db.prepare('UPDATE sessions SET source = ? WHERE id = ?').run(source, 's1')
    message('user', 'Do work')
    expect(() => write([goal()])).toThrow('unavailable')
  })

  it.each([{ revision: -1, changes: [goal()] }, { revision: 0, changes: [] }, { revision: 0, changes: [goal({ status: 'pending' })] },
    { revision: 0, changes: [goal()], session_id: 'other' }, { revision: 0, changes: [goal({ source_message_id: 123 })] }])('rejects malformed or caller-selected scope: %j', input => {
    message('user', 'Do work')
    expect(() => service.updateSessionTasks('s1', 'research', input)).toThrow()
    expect(service.getSessionTasks('s1').tasks).toEqual([])
  })
})

describe('task list pages', () => {
  const query = (overrides = {}) => ({ profiles: ['research'], order: 'newest' as const, offset: 0, limit: 50, ...overrides })

  it('resolves visible request and completion turns rather than hidden tool messages', () => {
    const source = message('user', 'Add export')
    const first = write([goal()])
    expect(service.listSessionTaskItems(query()).tasks[0]).toMatchObject({ message_id: source, source_message_id: source, profile: 'research', session_id: 's1' })
    message('assistant', 'Initial implementation')
    const completionTurn = message('user', 'Finish and test export')
    const tool = message('tool', 'All tests passed')
    write([goal({ id: first.tasks[0].id, status: 'completed', completion_evidence: 'Tests passed' })])
    expect(service.listSessionTaskItems(query()).tasks[0]).toMatchObject({ message_id: completionTurn, evidence_message_id: tool })
  })

  it('filters profiles before counts and pagination, hides pending deletions and unsupported surfaces', () => {
    message('user', 'Research goal')
    write([goal()])
    for (const [id, profile, source] of [['other', 'other', 'cli'], ['group', 'research', 'group_chat'], ['workflow', 'research', 'workflow'], ['global', 'research', 'global_agent']]) {
      sessions.createSession({ id, profile, source })
      db.prepare('INSERT INTO session_tasks (id, session_id, title, summary, status, source_message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(`task-${id}`, id, id, '', 'open', 1, 1, 1)
    }
    expect(service.listSessionTaskItems(query())).toMatchObject({ total: 1, has_more: false, tasks: [expect.objectContaining({ session_id: 's1' })] })
    expect(service.listSessionTaskItems(query({ profiles: [] }))).toEqual({ tasks: [], total: 0, has_more: false })
    expect(service.listSessionTaskItems(query({ excludeSessionIds: ['s1'] })).total).toBe(0)
    expect(service.listSessionTaskItems(query({ profiles: ['other'] })).tasks[0].session_id).toBe('other')
  })

  it('searches task and session text literally, sorts stably and paginates all tasks', () => {
    message('user', 'Several goals')
    write([goal({ title: 'Export 100%' }), goal({ title: 'Fix login' }), goal({ title: 'Deploy' })])
    const tasks = service.getSessionTasks('s1').tasks
    for (const [i, task] of tasks.entries()) db.prepare('UPDATE session_tasks SET updated_at = ? WHERE id = ?').run(i + 1, task.id)
    const first = service.listSessionTaskItems(query({ limit: 2 }))
    const second = service.listSessionTaskItems(query({ limit: 2, offset: 2 }))
    expect(first.total).toBe(3)
    expect(first.has_more).toBe(true)
    expect(second.has_more).toBe(false)
    expect(new Set([...first.tasks, ...second.tasks].map(t => t.id)).size).toBe(3)
    expect(service.listSessionTaskItems(query({ order: 'oldest' })).tasks.map(t => t.id)).toEqual(service.listSessionTaskItems(query()).tasks.map(t => t.id).reverse())
    expect(service.listSessionTaskItems(query({ search: '%' })).tasks.map(t => t.title)).toEqual(['Export 100%'])
    expect(service.listSessionTaskItems(query({ search: '_' })).total).toBe(0)
    sessions.renameSession('s1', 'Release checklist')
    expect(service.listSessionTaskItems(query({ search: 'checklist' })).total).toBe(3)
    expect(service.listSessionTaskItems(query({ status: 'completed' })).total).toBe(0)
    write([goal({ id: tasks[0].id, title: tasks[0].title, status: 'completed', completion_evidence: 'Delivered and checked' })])
    const page = service.listSessionTaskItems(query())
    expect(page.tasks.at(-1)?.status).toBe('completed')
    expect(service.listSessionTaskItems(query({ status: 'completed' })).total).toBe(1)
  })
})
