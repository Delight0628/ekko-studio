import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PersonRuntimePort } from '../../packages/server/src/modules/studio/public/person-runtime'

let db: DatabaseSync
let dir: string
let store: typeof import('../../packages/server/src/modules/studio/repositories/person-store')
let tasks: typeof import('../../packages/server/src/modules/studio/services/person/tasks')
let runner: typeof import('../../packages/server/src/modules/studio/services/person/runner')
let schedules: typeof import('../../packages/server/src/modules/studio/services/person/schedules')
let runtime: PersonRuntimePort
const selection = { runtime: 'ekko', mode: 'scoped' as const, profile: 'default', provider: 'test', model: 'm', apiMode: 'chat_completions' }
let catalog: Array<any>
let activeAccount = true

beforeEach(async () => {
  vi.resetModules(); db = new DatabaseSync(':memory:'); dir = mkdtempSync(join(tmpdir(), 'person-test-')); activeAccount = true
  vi.doMock('../../packages/server/src/modules/studio/public/chat-run', () => ({ getChatRunServer: () => ({ isSessionRunning: () => false }) }))
  vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({ getDb: () => db, isSqliteAvailable: () => true }))
  vi.doMock('../../packages/server/src/modules/studio/public/config', () => ({ config: { appHome: dir }, getWebUiHome: () => dir }))
  vi.doMock('../../packages/server/src/modules/studio/repositories/users-store', () => ({
    findUserById: (id: number) => ({ id, status: activeAccount ? 'active' : 'disabled', role: id === 1 ? 'super_admin' : 'admin', username: `user${id}` }),
    listUserProfiles: () => [{ profile_name: 'default' }], userCanAccessProfile: (_id: number, p: string) => p === 'default',
  }))
  vi.doMock('../../packages/server/src/modules/studio/public/profile-config', () => ({ listProfileNamesFromDisk: () => ['default'], getActiveProfileName: () => 'default' }))
  vi.doMock('../../packages/server/src/modules/studio/public/agent-status-registry', () => ({ getAgentAvailabilitySnapshot: () => ({ agents: [{ id: 'ekko-agent', installed: true }, { id: 'codex', installed: true }, { id: 'pi', installed: false }] }) }))
  catalog = [{ provider: 'test', models: ['m'], api_mode: 'chat_completions' }]
  vi.doMock('../../packages/server/src/modules/studio/public/session-agent-runtime', () => ({ getSessionAvailableModelGroups: async () => catalog }))
  vi.doMock('../../packages/server/src/modules/studio/services/usage/usage-recorder', () => ({ recordSessionUsage: vi.fn() }))
  const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
  initAllHermesTables()
  store = await import('../../packages/server/src/modules/studio/repositories/person-store')
  tasks = await import('../../packages/server/src/modules/studio/services/person/tasks')
  schedules = await import('../../packages/server/src/modules/studio/services/person/schedules')
  runner = await import('../../packages/server/src/modules/studio/services/person/runner')
  runtime = {
    modelConfig: vi.fn(async () => ({ default: 'm', default_provider: 'test', groups: catalog })),
    model: vi.fn(async call => {
      const review = call.tools.find(t => t.name === 'bot_review_submit')
      if (review) {
        const input = JSON.parse(call.messages[0].content as string)
        await call.tools.find(t => t.name === 'bot_artifact_read')!.execute({ execution_id: input.execution_id, path: 'result.txt' })
        await review.execute({ result: 'pass', evidence: 'Read result.txt: expected result verified' })
      }
      return 'Done'
    }),
    nativeModels: vi.fn(async () => ({ status: 'ready', models: [{ id: 'native/model-latest', name: 'Native' }] })),
    execute: vi.fn(async input => { input.onEvent('run.started', {}); writeFileSync(join(input.workspace, 'result.txt'), '42'); return { ok: true, output: 'Created result.txt with 42' } }),
    answer: vi.fn(async () => true), stop: vi.fn(async () => {}),
  }
  const { configurePersonRuntime } = await import('../../packages/server/src/modules/studio/public/person-runtime')
  configurePersonRuntime(runtime)
  store.savePersonSettings(1, { ...store.personSettings(1).settings, model: selection }, 0)
})
afterEach(async () => {
  await runner?.stopPersonWork()
  await new Promise(resolve => setTimeout(resolve, 10))
  db?.close(); rmSync(dir, { recursive: true, force: true }); vi.clearAllMocks()
})
async function create(overrides = {}) {
  return tasks.applyPersonTask(1, { action: 'create', idempotency_key: crypto.randomUUID(), title: 'Compute result', goal: 'Write 42 into result.txt', acceptance: 'File contains 42', selection_ref: store.savePersonSelection(1, selection), workspace: dir, ...overrides }) as Promise<{ task: import('../../packages/server/src/modules/studio/contracts/person').PersonTask; execution: import('../../packages/server/src/modules/studio/contracts/person').PersonExecution }>
}
const wait = async (id: string, state: string) => vi.waitFor(() => expect(store.getPersonExecution(1, id).state).toBe(state), { timeout: 2000, interval: 10 })

describe('Person account-owned tasks and runtime', () => {
  it('inherits the global default without creating settings and follows later default changes', async () => {
    db.prepare('DELETE FROM person_accounts WHERE user_id=1').run()
    const { personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
    expect(await personSnapshot(1)).toMatchObject({ inherits_global_model: true, settings: { model: selection } })
    expect(store.personSettings(1).settings.model).toBeNull()
    expect(await personSnapshot(1)).toMatchObject({ session: { id: 'person-main-1', model: 'm', reasoning_effort: '', studio_user_id: '1' } })
    catalog[0].models.push('m2')
    vi.mocked(runtime.modelConfig).mockResolvedValue({ default: 'm2', default_provider: 'test', groups: catalog })
    expect(await personSnapshot(1)).toMatchObject({ session: { id: 'person-main-1', model: 'm2' } })
    expect(store.personSettings(1).settings.model).toBeNull()
  })

  it('persists model and supported reasoning choices, then restores global inheritance', async () => {
    catalog[0].models.push('m2')
    catalog[0].model_meta = { m: { reasoning_efforts: ['low', 'high'] }, m2: { reasoning: false } }
    const { configurePerson, personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
    await configurePerson(1, { reasoning_effort: 'high', expected_revision: 1 })
    expect(await personSnapshot(1)).toMatchObject({ session: { reasoning_effort: 'high' } })
    const switched = await configurePerson(1, { model: { profile: 'default', provider: 'test', model: 'm2' }, expected_revision: 2 })
    expect(switched).toMatchObject({ inherits_global_model: false, reasoning_efforts: [], settings: { model: { model: 'm2' }, reasoningEffort: '' } })
    expect(await personSnapshot(1)).toMatchObject({ settings: { model: { model: 'm2' } } })
    await expect(configurePerson(1, { reasoning_effort: 'high', expected_revision: 3 })).rejects.toThrow('does not support')
    const restored = await configurePerson(1, { use_global_default: true, expected_revision: 3 })
    expect(restored).toMatchObject({ inherits_global_model: true, settings: { model: selection } })
    expect(store.personSettings(1).settings.model).toBeNull()
  })

  it('keeps model catalogs in the UI, strips credentials and rejects unavailable choices', async () => {
    catalog[0] = { ...catalog[0], api_key: 'private-key', base_url: 'https://private.example', models: ['m','hidden','unsupported'],
      model_meta: { hidden: { disabled: true } }, api_mode_by_model: { unsupported: 'bedrock_converse' } }
    const { personModelCatalog } = await import('../../packages/server/src/modules/studio/services/person/catalog')
    const result = await personModelCatalog(1)
    expect(result.groups[0].models).toEqual(['m'])
    expect(JSON.stringify(result)).not.toContain('private')
    const { configurePerson } = await import('../../packages/server/src/modules/studio/services/person/service')
    await expect(configurePerson(1, { model: { profile: 'forbidden', provider: 'test', model: 'm' }, expected_revision: 1 })).rejects.toThrow('unavailable')
    await expect(configurePerson(1, { model: { profile: 'default', provider: 'test', model: 'hidden' }, expected_revision: 1 })).rejects.toThrow('unavailable')
    await expect(configurePerson(1, { reasoning_effort: 'invented', expected_revision: 1 })).rejects.toThrow('Invalid reasoning')
    await expect(configurePerson(1, { reasoning_effort: 'high', expected_revision: 0 })).rejects.toThrow('changed')
  })

  it('does not send a request if the global default is missing or disabled', async () => {
    db.prepare('DELETE FROM person_accounts WHERE user_id=1').run()
    catalog[0].model_meta = { m: { disabled: true } }
    const { personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
    expect(await personSnapshot(1)).toMatchObject({ inherits_global_model: true, settings: { model: null } })
    const { createPersonChatAgent } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
    await expect(createPersonChatAgent(1, 'person-main-1')).rejects.toThrow('global default model')
    expect(runtime.model).not.toHaveBeenCalled()
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id='person-main-1'").get()).toMatchObject({ n: 0 })
  })

  it('reuses a hidden owned session and preserves ordinary history', async () => {
    const { ensurePersonSession } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
    const sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
    const first = await ensurePersonSession(1)
    sessions.addMessage({ session_id: first.session.id, role: 'user', content: 'Private message' })
    await ensurePersonSession(1)
    const other = await ensurePersonSession(2)
    sessions.createSession({ id: 'ordinary', title: 'Ordinary chat', source: 'builtin_agent', user_id: 1 })
    expect(first.session.id).toBe('person-main-1')
    expect(first.session.studio_user_id).toBe('1')
    expect(sessions.getSessionDetail(first.session.id)?.messages.map(m => m.content)).toEqual(['Private message'])
    expect(sessions.getSessionDetail(other.session.id)?.messages).toEqual([])
    expect(sessions.listSessions().map(s => s.id)).toEqual(['ordinary'])
    expect(sessions.searchSessions(undefined, 'Private').length).toBe(0)
    expect(store.searchPersonContext(1, 'Private')).toHaveLength(1)
    expect(store.searchPersonContext(2, 'Private')).toHaveLength(0)
  })

  it('only exposes worker questions after task-scoped coordination escalates', async () => {
    const { personChatInteraction } = await import('../../packages/server/src/modules/studio/services/person/chat-interactions')
    const { execution } = await create()
    store.addPersonInteraction(1, execution, 'native-question', 'Which scope?', ['A', 'B'])
    store.setPersonExecution(execution, 'waiting_person')
    expect(personChatInteraction(1)).toBeUndefined()
    store.setPersonExecution(execution, 'waiting_user')
    expect(personChatInteraction(1)).toMatchObject({ event: 'clarify.requested', data: { session_id: 'person-main-1', question: 'Which scope?', choices: ['A','B'] } })
    expect(personChatInteraction(2)).toBeUndefined()
  })

  it('migrates legacy required chat anchors while preserving custom indexes and data', async () => {
    db.exec('DROP TABLE session_tasks')
    db.exec(`CREATE TABLE session_tasks (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','completed')),source_message_id INTEGER NOT NULL,evidence_message_id INTEGER,completion_evidence TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,completed_at INTEGER)`)
    db.exec("CREATE INDEX custom_person_migration ON session_tasks(title)")
    db.exec("INSERT INTO session_tasks VALUES ('old','chat','Original','','open',1,NULL,'',1,1,NULL)")
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables(); initAllHermesTables()
    expect(db.prepare("SELECT title FROM session_tasks WHERE id='old'").get()).toMatchObject({title:'Original'})
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='custom_person_migration'").get()).toBeTruthy()
    const created = await create({start:false})
    expect(created.task.bot_id).toBe('person:1')
  })

  it('separates account memory, conversations, selections and tasks while reusing the existing goal table', async () => {
    store.changePersonMemory(1, { content: 'Prefer Chinese', source: 'user' })
    expect(store.personMemories(2)).toEqual([])
    const { task } = await create({ start: false })
    expect(() => store.getPersonTask(2, task.id)).toThrow('not found')
    expect(() => store.resolvePersonSelection(2, store.savePersonSelection(1, selection))).toThrow('unavailable')
    expect(db.prepare('SELECT session_id,source_message_id,bot_id FROM session_tasks WHERE id=?').get(task.id)).toMatchObject({ session_id: null, source_message_id: null, bot_id: 'person:1' })
    const { listSessions, searchSessions, createSession } = await import('../../packages/server/src/modules/studio/repositories/session-store')
    createSession({ id: 'person-task-private', profile: 'default', source: 'coding_agent', title: 'private' })
    expect(listSessions('default')).toEqual([]); expect(searchSessions('default','private')).toEqual([])
    const sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
    sessions.addMessage({session_id:'person-task-private',role:'user',content:'Private worker requirement',timestamp:Date.now()})
    const goals = await import('../../packages/server/src/modules/studio/services/session-tasks')
    goals.updateSessionTasks('person-task-private','default',{revision:0,changes:[{title:'Private worker goal',summary:'Private',status:'open'}]})
    const repository = await import('../../packages/server/src/modules/studio/repositories/session-task-store')
    expect(repository.listSessionTaskItems({profiles:['default'],limit:20,offset:0,order:'newest'}).tasks).toEqual([])

  })
  it('adopts an existing owned session goal without duplicating it and preserves its origin', async () => {
    const sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
    sessions.createSession({id:'owned',profile:'default',source:'coding_agent',studio_user_id:'1'})
    const msg = Number(sessions.addMessage({session_id:'owned',role:'user',content:'Write a report',timestamp:Date.now()}))
    const goals = await import('../../packages/server/src/modules/studio/services/session-tasks')
    const old = goals.updateSessionTasks('owned','default',{revision:0,changes:[{title:'Report',summary:'Needs work',status:'open'}]}).tasks[0]
    expect(store.listAssignablePersonGoals(1)).toHaveLength(1)
    expect(store.listAssignablePersonGoals(2)).toHaveLength(0)
    const result = await create({action:'adopt',task_id:old.id,expected_revision:old.updated_at,start:false})
    expect(result.task.id).toBe(old.id)
    expect(JSON.parse(result.task.requirements_json).origin).toMatchObject({session_id:'owned',source_message_id:msg})
    expect(goals.getSessionTasks('owned').tasks).toHaveLength(0)
    sessions.deleteSession('owned')
    expect(store.getPersonTask(1,old.id).status).toBe('open')
  })

  it('keeps creation idempotent and rejects reuse for changed intent', async () => {
    const reference = store.savePersonSelection(1, selection)
    const a = await create({ idempotency_key: 'same', selection_ref: reference })
    db.prepare('DELETE FROM person_selections WHERE id=?').run(reference)
    const b = await create({ idempotency_key: 'same', selection_ref: reference })
    expect(a.task.id).toBe(b.task.id); expect(store.listPersonTasks(1)).toHaveLength(1)
    await expect(create({ idempotency_key: 'same', selection_ref: reference, goal: 'other' })).rejects.toThrow('another operation')
  })
  it('runs an interactive worker and independent evidence review before completing a goal', async () => {
    const { task, execution } = await create()
    expect(execution.state).toBe('queued')
    await runner.tickPersonWork(); await wait(execution.id, 'finished')
    expect(store.getPersonTask(1, task.id)).toMatchObject({ status: 'completed', completion_evidence: expect.stringContaining('result.txt') })
    expect(runtime.execute).toHaveBeenCalledTimes(1)
    const call = vi.mocked(runtime.model).mock.calls[0][0]
    expect(call.systemPrompt).toContain('reviewer'); expect(call.messages).toHaveLength(1)
    expect(call.tools.map(t => t.name)).not.toContain('bot_task_apply')
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id='person-main-1'").get()).toMatchObject({ n: 0 })
  })
  it('does not accept a worker claim without reading independent artifacts', async () => {
    vi.mocked(runtime.model).mockImplementation(async call => {
      await expect(call.tools.find(t => t.name === 'bot_review_submit')!.execute({ result: 'pass', evidence: 'Worker said done' })).rejects.toThrow('actual task artifact')
      return 'Done'
    })
    const { task, execution } = await create(); await runner.tickPersonWork(); await wait(execution.id, 'paused')
    expect(store.getPersonTask(1, task.id).status).toBe('open')
    expect(store.personInteractions(1)).toHaveLength(1)
    const question = store.personInteractions(1)[0]
    const response = await runner.replyPersonQuestion(1, question.id, question.revision, 'Check result.txt and continue')
    expect(response).toHaveProperty('execution.state', 'queued')
  })
  it('answers worker questions through a task-scoped Person context, without human escalation', async () => {
    let resume!: () => void
    vi.mocked(runtime.execute).mockImplementation(async input => {
      input.onEvent('run.started', {})
      const paused = new Promise<void>(resolve => { resume = resolve })
      input.onEvent('clarify.requested', { clarify_id: 'q1', question: 'Which number?', choices: ['42','43'] })
      await paused; writeFileSync(join(dir, 'result.txt'), '42'); return { ok: true, output: 'result.txt contains 42' }
    })
    vi.mocked(runtime.answer).mockImplementation(async () => { resume(); return true })
    const reviewer = runtime.model
    runtime.model = vi.fn(async call => {
      const reply = call.tools.find(t => t.name === 'bot_interaction_reply')
      if (reply) { await reply.execute({ answer: '42', basis: 'Task explicitly asks for 42' }); return 'Answered' }
      return reviewer(call)
    })
    const { execution } = await create(); await runner.tickPersonWork(); await wait(execution.id, 'finished')
    expect(runtime.answer).toHaveBeenCalledWith(execution.session_id, 'q1', '42', false)
    expect(store.personInteractions(1)).toEqual([])
    expect(db.prepare('SELECT answered_by FROM person_interactions').get()).toMatchObject({ answered_by: 'person' })
  })
  it('records stopping until native acknowledgement and rejects late completion after cancellation', async () => {
    let finish!: (value: {ok:boolean;output:string}) => void
    vi.mocked(runtime.execute).mockImplementation(async input => { input.onEvent('run.started', {}); return new Promise(resolve => { finish = resolve }) })
    const { task, execution } = await create(); await runner.tickPersonWork(); await wait(execution.id, 'running')
    await tasks.applyPersonTask(1, { action: 'cancel', task_id: task.id, expected_revision: 0, idempotency_key: 'cancel' })
    expect(store.getPersonExecution(1, execution.id).state).toBe('stopping')
    vi.mocked(runtime.stop).mockRejectedValueOnce(new Error('not stopped'))
    await runner.tickPersonWork(); expect(store.getPersonExecution(1, execution.id).state).toBe('stopping')
    await runner.tickPersonWork(); expect(store.getPersonExecution(1, execution.id).state).toBe('cancelled')
    finish({ok:true,output:'late result'}); await new Promise(resolve => setTimeout(resolve, 10))
    expect(store.getPersonTask(1, task.id).status).toBe('open'); expect(runtime.model).not.toHaveBeenCalled()
  })
  it('rejects Person granting authorization and permits only an explicit user choice', async () => {
    const { execution } = await create()
    const question = store.addPersonInteraction(1, execution, 'approval', 'External action', ['once','deny'], 'approval')
    expect(() => store.answerPersonInteraction(1, question.id, 0, 'once', 'person')).toThrow('cannot grant')
    await expect(runner.replyPersonQuestion(2, question.id, 0, 'once')).rejects.toThrow('expired')
    await expect(runner.replyPersonQuestion(1, question.id, 0, 'yes')).rejects.toThrow('Unsupported')
  })
  it('exposes only bounded role tools and keeps memory out of the reviewer', async () => {
    const { personTools } = await import('../../packages/server/src/modules/studio/services/person/tools')
    const main = personTools(1, 'main').map(t => t.name)
    expect(main).toEqual(expect.arrayContaining(['bot_task_apply','bot_models_search','bot_schedule_apply','bot_memory_apply','bot_decision_request']))
    expect(main.some(t => /shell|terminal|browser|exec_command|file_write/.test(t))).toBe(false)
    expect(personTools(1, 'reviewer').map(t => t.name)).not.toContain('bot_memory_search')
    activeAccount = false
    const { personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
    await expect(personSnapshot(1)).rejects.toThrow('unavailable')
  })
  it('searches a 5000-model catalog with bounded candidates, exact ranking, account refs and valid cursors', async () => {
    catalog[0].models = Array.from({ length: 5000 }, (_, i) => `model-${i}`)
    const { searchPersonModels } = await import('../../packages/server/src/modules/studio/services/person/catalog')
    const result = await searchPersonModels(1, { query: 'model-45', limit: 3 })
    expect(result.candidates).toHaveLength(3); expect(result.candidates[0].model).toBe('model-45')
    expect(JSON.stringify(result).length).toBeLessThan(2500)
    const next = await searchPersonModels(1, { query: 'model-45', limit: 3, cursor: result.cursor })
    expect(next.candidates[0].model).not.toBe('model-45')
    await expect(searchPersonModels(1, { query: 'other', cursor: result.cursor })).rejects.toThrow('expired')
    await expect(searchPersonModels(2, { mode: 'global', runtime: 'codex' })).rejects.toThrow('unavailable')
  })
  it('fences expired workers before acknowledging interruption, keeping the goal open', async () => {
    const { task,execution }=await create()
    db.prepare("UPDATE person_executions SET state='running',lease_until=0 WHERE id=?").run(execution.id)
    await runner.tickPersonWork()
    expect(store.getPersonExecution(1,execution.id).state).toBe('stopping')
    await runner.tickPersonWork()
    expect(store.getPersonExecution(1,execution.id).state).toBe('interrupted')
    expect(store.getPersonTask(1,task.id).status).toBe('open')
    expect(runtime.execute).not.toHaveBeenCalled()
  })

  it('claims a due occurrence once, persists revisions and skips overlaps', async () => {
    const { task } = await create({ start: false }); const at = Date.now() + 60_000
    const schedule = schedules.applyPersonSchedule(1, { action:'create', task_id:task.id, kind:'once', expression:new Date(at).toISOString(), timezone:'UTC', misfire:'run_latest', idempotency_key:'schedule' })
    schedules.tickPersonSchedules(at); schedules.tickPersonSchedules(at)
    expect(store.taskPersonExecutions(1, task.id)).toHaveLength(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM person_occurrences').get()).toMatchObject({n:1})
    expect(store.listPersonSchedules(1)[0].state).toBe('exhausted')
    const updated = schedules.applyPersonSchedule(1, { action:'update', schedule_id:schedule.id, expected_revision:0, kind:'once', expression:new Date(at+60_000).toISOString(), timezone:'UTC', idempotency_key:'update' })
    expect(updated?.revision).toBe(1)
    schedules.tickPersonSchedules(at+60_000)
    expect(db.prepare("SELECT COUNT(*) AS n FROM person_occurrences WHERE state='skipped'").get()).toMatchObject({n:1})
  })
})
