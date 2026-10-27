import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
let mainBusy = false
const clearHistoryMock = vi.fn()
const disposeSessionMock = vi.fn(async () => {})
let installedAgent = true
let allowedProfiles: string[] = ['default']

beforeEach(async () => {
  vi.resetModules(); db = new DatabaseSync(':memory:'); dir = mkdtempSync(join(tmpdir(), 'person-test-')); activeAccount = true
  installedAgent = true; allowedProfiles = ['default']; mainBusy = false; clearHistoryMock.mockClear(); disposeSessionMock.mockClear()
  vi.doMock('../../packages/server/src/modules/studio/public/chat-run', () => ({ getChatRunServer: () => ({ isSessionRunning: () => mainBusy, clearSessionHistory: clearHistoryMock, disposeSession: disposeSessionMock }) }))
  vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({ getDb: () => db, isSqliteAvailable: () => true }))
  vi.doMock('../../packages/server/src/modules/studio/public/config', () => ({ config: { appHome: dir }, getWebUiHome: () => dir }))
  vi.doMock('../../packages/server/src/modules/studio/repositories/users-store', () => ({
    findUserById: (id: number) => ({ id, status: activeAccount ? 'active' : 'disabled', role: id === 1 ? 'super_admin' : 'admin', username: `user${id}` }),
    listUserProfiles: () => allowedProfiles.map(profile_name => ({ profile_name })), userCanAccessProfile: (_id: number, p: string) => allowedProfiles.includes(p),
  }))
  vi.doMock('../../packages/server/src/modules/studio/public/profile-config', () => ({ listProfileNamesFromDisk: () => ['default'], getActiveProfileName: () => 'default' }))
  vi.doMock('../../packages/server/src/modules/studio/public/agent-status-registry', () => ({ getAgentAvailabilitySnapshot: () => ({ agents: [{ id: 'ekko-agent', installed: installedAgent }, { id: 'codex', installed: true }, { id: 'pi', installed: false }] }) }))
  catalog = [{ provider: 'test', models: ['m'], api_mode: 'chat_completions' }]
  vi.doMock('../../packages/server/src/modules/studio/public/session-agent-runtime', () => ({ getSessionAvailableModelGroups: async () => catalog, validateCodingAgentModelEffort: vi.fn(async () => {}) }))
  vi.doMock('../../packages/server/src/modules/studio/services/usage/usage-recorder', () => ({ recordSessionUsage: vi.fn() }))
  const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
  initAllHermesTables()
  store = await import('../../packages/server/src/modules/studio/repositories/person-store')
  tasks = await import('../../packages/server/src/modules/studio/services/person/tasks')
  schedules = await import('../../packages/server/src/modules/studio/services/person/schedules')
  runner = await import('../../packages/server/src/modules/studio/services/person/runner')
  runtime = {
    modelConfig: vi.fn(async () => ({ default: 'm', default_provider: 'test', groups: catalog })),
    model: vi.fn(async () => 'Done'),
    deliver: vi.fn(async () => {}),
    nativeModels: vi.fn(async () => ({ status: 'ready', models: [{ id: 'native/model-latest', name: 'Native' }] })),
    execute: vi.fn(async input => { input.onEvent('run.started', {}); writeFileSync(join(input.workspace, 'result.txt'), '42'); return { ok: true, output: 'Created result.txt with 42' } }),
    answer: vi.fn(async () => true), stop: vi.fn(async () => {}),
  }
  const { configurePersonRuntime } = await import('../../packages/server/src/modules/studio/public/person-runtime')
  configurePersonRuntime(runtime)
  store.savePersonSettings(1, { ...store.personSettings(1).settings, model: selection, workspace: dir }, 0)
})
afterEach(async () => {
  await runner?.stopPersonWork()
  await new Promise(resolve => setTimeout(resolve, 10))
  db?.close(); rmSync(dir, { recursive: true, force: true }); vi.clearAllMocks()
})
async function create(overrides = {}) {
  return tasks.applyPersonTask(1, { action: 'create', idempotency_key: crypto.randomUUID(), title: 'Compute result', goal: 'Write 42 into result.txt', ...overrides }) as Promise<{ task: import('../../packages/server/src/modules/studio/contracts/person').PersonTask; execution: import('../../packages/server/src/modules/studio/contracts/person').PersonExecution }>
}
const wait = async (id: string, state: string) => vi.waitFor(() => expect(store.getPersonExecution(1, id).state).toBe(state), { timeout: 2000, interval: 10 })

describe('Person account-owned tasks and runtime', () => {
  it('persists each return on its exact assistant reply and never exposes another account or session', async () => {
    const { ensurePersonSession } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
    const sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
    const { savePersonTaskReturn, withPersonTaskReturns } = await import('../../packages/server/src/modules/studio/repositories/person-return-store')
    await ensurePersonSession(1); await ensurePersonSession(2)
    const { task, execution } = await create()
    store.setPersonExecution(execution, 'finished')
    const first = sessions.addMessage({ session_id: 'person-main-1', role: 'assistant', content: 'First return' })
    const second = sessions.addMessage({ session_id: 'person-main-1', role: 'assistant', content: 'Unrelated reply' })
    const other = sessions.addMessage({ session_id: 'person-main-2', role: 'assistant', content: 'Private' })
    expect(savePersonTaskReturn(1, execution.id, 'person-main-1', other)).toBeUndefined()
    expect(savePersonTaskReturn(2, execution.id, 'person-main-1', first)).toBeUndefined()
    expect(savePersonTaskReturn(1, execution.id, 'person-main-1', undefined)).toBeUndefined()
    const receipt = savePersonTaskReturn(1, execution.id, 'person-main-1', first)
    expect(receipt).toMatchObject({ taskId: task.id, executionId: execution.id, assistantMessageId: String(first), state: 'finished', agent: 'ekko', summary: task.summary })
    savePersonTaskReturn(1, execution.id, 'person-main-1', first)
    expect(db.prepare('SELECT COUNT(*) AS n FROM person_task_returns').get()?.n).toBe(1)
    const page = [{ id: first, role: 'assistant' }, { id: second, role: 'assistant' }]
    expect(withPersonTaskReturns('person-main-1', page)).toEqual([{ ...page[0], person_task_return: receipt }, page[1]])
    expect(withPersonTaskReturns('person-main-1', [page[1]])).toEqual([page[1]])
    expect(withPersonTaskReturns('person-main-2', page)).toEqual(page)
    expect(withPersonTaskReturns('normal-chat', page)).toEqual(page)
    const next = store.enqueuePersonExecution(store.getPersonTask(1, task.id))
    store.setPersonExecution(next, 'failed')
    const failed = savePersonTaskReturn(1, next.id, 'person-main-1', second)
    expect(withPersonTaskReturns('person-main-1', page)).toEqual([
      { ...page[0], person_task_return: receipt }, { ...page[1], person_task_return: failed },
    ])
    expect(failed).toMatchObject({ executionId: next.id, state: 'failed' })
  })

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

  it('separates account memory, conversations and tasks while reusing the existing goal table', async () => {
    store.changePersonMemory(1, { content: 'Prefer Chinese', source: 'user' })
    expect(store.personMemories(2)).toEqual([])
    const { task } = await create({ start: false })
    expect(() => store.getPersonTask(2, task.id)).toThrow('not found')
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
    const a = await create({ idempotency_key: 'same' })
    const b = await create({ idempotency_key: 'same' })
    expect(a.task.id).toBe(b.task.id); expect(store.listPersonTasks(1)).toHaveLength(1)
    await expect(create({ idempotency_key: 'same', goal: 'other' })).rejects.toThrow('another operation')
  })
  it('runs a background worker once, returns its origin and completes without an acceptance step', async () => {
    const { ensurePersonSession } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
    const sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
    await ensurePersonSession(1)
    sessions.addMessage({ session_id: 'person-main-1', role: 'user', content: 'Original request' })
    const { task, execution } = await create()
    sessions.addMessage({ session_id: 'person-main-1', role: 'user', content: 'Unrelated later request' })
    expect(execution.state).toBe('queued')
    await runner.tickPersonWork(); await wait(execution.id, 'finished')
    expect(store.getPersonTask(1, task.id)).toMatchObject({ status: 'completed', completion_evidence: 'Created result.txt with 42' })
    expect(runtime.execute).toHaveBeenCalledTimes(1)
    expect(runtime.model).not.toHaveBeenCalled()
    expect(store.personInteractions(1)).toEqual([])
    await runner.tickPersonWork(); await runner.tickPersonWork()
    expect(runtime.deliver).toHaveBeenCalledTimes(1)
    expect(vi.mocked(runtime.deliver).mock.calls[0][0]).toMatchObject({ executionId: execution.id, status: 'finished',
      origin: { sessionId: 'person-main-1', messages: [{ role: 'user', content: 'Original request' }] } })
    expect(store.personBackgroundPendingCount('person-main-1')).toBe(1)
    expect(store.personBackgroundPendingCount('person-main-2')).toBe(0)
    expect(store.personBackgroundPendingCount('person-main-1', execution.id)).toBe(0)
    expect(store.listPersonTasks(1)[0].running).toBe(1)
    const { finishPersonDelivery } = await import('../../packages/server/src/modules/studio/services/person/delivery')
    finishPersonDelivery(1, execution.id, true)
    expect(store.personBackgroundPendingCount('person-main-1')).toBe(0)
    expect(store.listPersonTasks(1)[0].running).toBe(0)
    const closed = await tasks.applyPersonTask(1, { action: 'close', task_id: task.id, expected_revision: 1, idempotency_key: 'close' })
    expect(closed.task.status).toBe('closed')
    const reopened = await tasks.applyPersonTask(1, { action: 'reopen', task_id: task.id, expected_revision: 2, idempotency_key: 'open' })
    expect(reopened.task).toMatchObject({ status: 'open', completion_evidence: '' })
    expect(store.taskPersonExecutions(1, task.id)).toHaveLength(1)
    await expect(tasks.applyPersonTask(1, { action: 'close', task_id: task.id, expected_revision: 1, idempotency_key: 'stale' })).rejects.toThrow('changed')

  })
  it('only exposes configured presets and validates effort, permission and runtime', async () => {
    const { configurePerson } = await import('../../packages/server/src/modules/studio/services/person/service')
    const { personExecutionAgents } = await import('../../packages/server/src/modules/studio/services/person/agents')
    await configurePerson(1, { reasoning_effort: 'high', expected_revision: 1 })
    const inherited = await create({ start: false })
    expect(JSON.parse(inherited.task.selection_json)).toMatchObject({ ...selection, reasoningEffort: 'high' })
    const preset = { id: 'coder', name: 'Coder', description: 'Implement code changes', selection: { ...selection, runtime: 'codex', reasoningEffort: 'low' } }
    await configurePerson(1, { agents: [preset], expected_revision: 2 })
    expect(await personExecutionAgents(1)).toEqual([preset])
    await expect(create({ agent_id: 'default' })).rejects.toThrow('configured execution agents')
    const { execution } = await create({ agent_id: 'coder' })
    await runner.tickPersonWork(); await wait(execution.id, 'finished')
    expect(vi.mocked(runtime.execute).mock.calls[0][0].selection).toMatchObject(preset.selection)
    await expect(configurePerson(1, { agents: [{ ...preset, selection: { ...selection, reasoningEffort: 'invented' } }], expected_revision: 3 })).rejects.toThrow('reasoning effort')
    await expect(configurePerson(1, { agents: [preset, preset], expected_revision: 3 })).rejects.toThrow('Duplicate')
    await expect(configurePerson(2, { agents: [{ ...preset, selection: { ...selection, runtime: 'codex', mode: 'global', model: 'native/model-latest' } }], expected_revision: 0 })).rejects.toThrow('credentials')
    await configurePerson(1, { agents: [], expected_revision: 3 })
    expect((await personExecutionAgents(1))[0]).toMatchObject({ id: 'default', selection: { runtime: 'ekko', reasoningEffort: 'high' } })
  })
  it('supports native defaults and validates native effort lists and encoded variants', async () => {
    const { configurePerson } = await import('../../packages/server/src/modules/studio/services/person/service')
    const { validatePersonSelection } = await import('../../packages/server/src/modules/studio/services/person/catalog')
    const native = { ...selection, runtime: 'codex', mode: 'global' as const, provider: '', model: '' }
    const preset = { id: 'native', name: 'Native coder', description: 'Code using native credentials', selection: native }
    await configurePerson(1, { agents: [preset], expected_revision: 1 })
    expect((await create({ agent_id: 'native', start: false })).task.selection_json).toContain('"model":""')
    vi.mocked(runtime.nativeModels).mockResolvedValue({ status: 'ready', models: [
      { id: 'plain', name: 'Plain', isDefault: true, reasoningEfforts: ['low', 'high'] },
      { id: 'variant-high', name: 'Variant', reasoningEffort: 'high', reasoningEfforts: ['low', 'high'] },
    ] })
    await expect(validatePersonSelection(1, { ...native, model: 'plain', reasoningEffort: 'high' })).resolves.toBeUndefined()
    await expect(validatePersonSelection(1, { ...native, reasoningEffort: 'low' })).resolves.toBeUndefined()
    await expect(validatePersonSelection(1, { ...native, model: 'variant-high', reasoningEffort: 'high' })).resolves.toBeUndefined()
    await expect(validatePersonSelection(1, { ...native, model: 'variant-high', reasoningEffort: 'low' })).rejects.toThrow('reasoning effort')
    await expect(validatePersonSelection(1, { ...native, model: 'plain', reasoningEffort: 'invented' })).rejects.toThrow('reasoning effort')
  })
  it('returns failures, retries a failed delivery and cancels stale results', async () => {
    const { ensurePersonSession } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
    const { deliverPersonResults, finishPersonDelivery } = await import('../../packages/server/src/modules/studio/services/person/delivery')
    await ensurePersonSession(1)
    vi.mocked(runtime.execute).mockResolvedValue({ ok: false, error: 'Provider failed' })
    const { task, execution } = await create(); await runner.tickPersonWork(); await wait(execution.id, 'failed')
    vi.mocked(runtime.deliver).mockRejectedValueOnce(new Error('Offline runtime'))
    await deliverPersonResults()
    expect(db.prepare('SELECT state FROM person_deliveries').get()).toMatchObject({ state: 'pending' })
    await deliverPersonResults(); expect(runtime.deliver).toHaveBeenCalledTimes(1)
    db.prepare('UPDATE person_deliveries SET updated_at=0').run()
    await deliverPersonResults(); expect(runtime.deliver).toHaveBeenCalledTimes(2)
    expect(vi.mocked(runtime.deliver).mock.calls[1][0]).toMatchObject({ status: 'failed', error: 'Provider failed' })
    finishPersonDelivery(1, execution.id, false, 'Retry')
    db.prepare('UPDATE person_deliveries SET updated_at=0').run()
    db.prepare('UPDATE session_tasks SET requirements_revision=requirements_revision+1 WHERE id=?').run(task.id)
    await deliverPersonResults()
    expect(db.prepare('SELECT state FROM person_deliveries').get()).toMatchObject({ state: 'cancelled' })
    expect(runtime.model).not.toHaveBeenCalled()
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
  it.each(['queued','starting','running','waiting_person','waiting_user','waiting_approval','stopping'])('locks task mutations while %s', async state => {
    const { task, execution } = await create()
    db.prepare('UPDATE person_executions SET state=? WHERE id=?').run(state, execution.id)
    for (const action of ['close','reopen','update','start']) {
      await expect(tasks.applyPersonTask(1, { action, task_id: task.id, goal: 'Changed', expected_revision: 0, idempotency_key: action })).rejects.toThrow('running')
    }
    expect(store.listPersonTasks(1)[0].running).toBe(1)
    expect(store.getPersonTask(1, task.id)).toMatchObject({ status: 'open', revision: 0 })
  })
  it('locks status while the result is being reported and rejects removed controls', async () => {
    const { task, execution } = await create()
    await runner.tickPersonWork(); await wait(execution.id, 'finished')
    for (const action of ['close','reopen']) {
      await expect(tasks.applyPersonTask(1, { action, task_id: task.id, expected_revision: 1, idempotency_key: action })).rejects.toThrow('running')
    }
    for (const action of ['accept','pause','resume','cancel','steer']) {
      await expect(tasks.applyPersonTask(1, { action, task_id: task.id, expected_revision: 1, idempotency_key: action })).rejects.toThrow('Unsupported')
    }
  })
  it('does not revive a worker after server shutdown', async () => {
    let finish!: (value: {ok:boolean;output:string}) => void
    vi.mocked(runtime.execute).mockImplementation(async input => { input.onEvent('run.started', {}); return new Promise(resolve => { finish = resolve }) })
    const { task, execution } = await create(); await runner.tickPersonWork(); await wait(execution.id, 'running')
    await runner.stopPersonWork()
    finish({ok:true,output:'late result'})
    await wait(execution.id, 'interrupted')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(store.getPersonTask(1, task.id).status).toBe('open')
    expect(runtime.deliver).not.toHaveBeenCalled()
  })
  it('rejects Person granting authorization and permits only an explicit user choice', async () => {
    const { execution } = await create()
    const question = store.addPersonInteraction(1, execution, 'approval', 'External action', ['once','deny'], 'approval')
    expect(() => store.answerPersonInteraction(1, question.id, 0, 'once', 'person')).toThrow('cannot grant')
    await expect(runner.replyPersonQuestion(2, question.id, 0, 'once')).rejects.toThrow('expired')
    await expect(runner.replyPersonQuestion(1, question.id, 0, 'yes')).rejects.toThrow('Unsupported')
  })
  it('exposes only preset dispatch tools and no acceptance tool', async () => {
    const { personTools } = await import('../../packages/server/src/modules/studio/services/person/tools')
    const main = personTools(1, 'main').map(t => t.name)
    expect(main).toEqual(expect.arrayContaining(['bot_task_apply','bot_agents_list','bot_schedule_apply','bot_memory_apply','bot_decision_request']))
    expect(main.some(t => /shell|terminal|browser|exec_command|file_write/.test(t))).toBe(false)
    expect(main).not.toContain('bot_review_submit')
    expect(main).not.toContain('bot_models_search')
    activeAccount = false
    const { personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
    await expect(personSnapshot(1)).rejects.toThrow('unavailable')
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

  it('backs off result delivery when its account becomes unavailable', async () => {
    const { ensurePersonSession } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
    const { deliverPersonResults } = await import('../../packages/server/src/modules/studio/services/person/delivery')
    await ensurePersonSession(1)
    const { execution } = await create(); await runner.tickPersonWork(); await wait(execution.id, 'finished')
    activeAccount = false
    await deliverPersonResults()
    expect(db.prepare('SELECT state,error FROM person_deliveries').get()).toMatchObject({ state: 'pending', error: expect.stringContaining('Account is unavailable') })
    activeAccount = true
    await deliverPersonResults(); expect(runtime.deliver).not.toHaveBeenCalled()
    db.prepare('UPDATE person_deliveries SET updated_at=0').run()
    await deliverPersonResults(); expect(runtime.deliver).toHaveBeenCalledTimes(1)
  })
  it('recovers queued result delivery after restart without re-running the worker', async () => {
    const { ensurePersonSession } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
    const { finishPersonDelivery, cancelPersonDelivery } = await import('../../packages/server/src/modules/studio/services/person/delivery')
    await ensurePersonSession(1)
    const { execution } = await create(); await runner.tickPersonWork(); await wait(execution.id, 'finished')
    await runner.tickPersonWork()
    expect(runtime.deliver).toHaveBeenCalledTimes(1)
    runner.startPersonWork(); await runner.tickPersonWork()
    expect(runtime.deliver).toHaveBeenCalledTimes(2)
    finishPersonDelivery(1, execution.id, true)
    await runner.stopPersonWork(); runner.startPersonWork(); await runner.tickPersonWork()
    expect(runtime.deliver).toHaveBeenCalledTimes(2)
    expect(runtime.execute).toHaveBeenCalledTimes(1)
    db.prepare("UPDATE person_deliveries SET state='queued'").run()
    cancelPersonDelivery(1, execution.id)
    await runner.tickPersonWork()
    expect(runtime.deliver).toHaveBeenCalledTimes(2)
  })
  it('finishes a recurring occurrence while keeping future work open', async () => {
    const { task, execution } = await create()
    schedules.applyPersonSchedule(1, { action: 'create', task_id: task.id, kind: 'cron', expression: '0 9 * * *', timezone: 'UTC', idempotency_key: 'recurring' })
    await runner.tickPersonWork(); await wait(execution.id, 'finished')
    expect(store.getPersonTask(1, task.id).status).toBe('open')
    expect(store.listPersonSchedules(1)[0].state).toBe('active')
    expect(store.getPersonTask(1, task.id).completion_evidence).toBe('Created result.txt with 42')
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

it('continues in the same hidden task session and delivers every turn to Person exactly once', async () => {
  const { personTaskChat, continuePersonTask, ownedPersonTaskSession } = await import('../../packages/server/src/modules/studio/services/person/task-chat')
  const { ensurePersonSession } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
  const { finishPersonDelivery, deliverPersonResults } = await import('../../packages/server/src/modules/studio/services/person/delivery')
  await ensurePersonSession(1)
  const { task, execution } = await create()
  const chat = await personTaskChat(1, task.id)
  expect(chat.session.id).toBe(execution.session_id)
  expect(chat.task.running).toBe(true)
  expect(() => ownedPersonTaskSession(2, chat.session.id)).toThrow('not found')
  await expect(personTaskChat(2, task.id)).rejects.toThrow('not found')
  await runner.tickPersonWork(); await wait(execution.id, 'finished')
  await deliverPersonResults(); finishPersonDelivery(1, execution.id, true)
  const input = [{ type: 'text', text: 'Use the previous result to compute the next value' }]
  const request = { input, expected_revision: store.getPersonTask(1, task.id).revision, idempotency_key: 'follow-up' }
  const next: any = await continuePersonTask(1, task.id, request)
  expect(next.task).toMatchObject({ status: 'open', running: true })
  expect(next.execution.session_id).toBe(execution.session_id)
  expect(next.execution.id).not.toBe(execution.id)
  expect(await continuePersonTask(1, task.id, request)).toEqual(next)
  await expect(continuePersonTask(1, task.id, { ...request, expected_revision: next.task.revision, idempotency_key: 'busy' })).rejects.toThrow('running')
  await runner.tickPersonWork(); await wait(next.execution.id, 'finished')
  expect(vi.mocked(runtime.execute).mock.calls[0][0].displayInput).toBe('Write 42 into result.txt')
  expect(vi.mocked(runtime.execute).mock.calls[1][0]).toMatchObject({ sessionId: execution.session_id, prompt: input, displayInput: undefined })
  await deliverPersonResults(); finishPersonDelivery(1, next.execution.id, true); await deliverPersonResults()
  expect(runtime.deliver).toHaveBeenCalledTimes(2)
  expect(vi.mocked(runtime.deliver).mock.calls[1][0]).toMatchObject({ origin: { sessionId: 'person-main-1' }, executionId: next.execution.id })
  const { listSessions } = await import('../../packages/server/src/modules/studio/repositories/session-store')
  expect(listSessions().some((s: any) => s.id.startsWith('person-task-'))).toBe(false)
})

it('requires reopening closed tasks and rejects stale, unauthorized or invalid chat turns', async () => {
  const { continuePersonTask, personTaskChat, ownedPersonTaskSession } = await import('../../packages/server/src/modules/studio/services/person/task-chat')
  const { task } = await create({ start: false })
  const chat = await personTaskChat(1, task.id)
  const request = { input: [{ type: 'text', text: 'Continue' }], expected_revision: 0, idempotency_key: 'continue' }
  await expect(continuePersonTask(2, task.id, request)).rejects.toThrow('not found')
  await expect(continuePersonTask(1, task.id, { ...request, input: [] })).rejects.toThrow('Invalid input')
  await expect(continuePersonTask(1, task.id, { ...request, input: [{ type: 'tool_result' }] })).rejects.toThrow('Invalid input')
  await tasks.applyPersonTask(1, { task_id: task.id, action: 'close', expected_revision: task.revision, idempotency_key: 'close' })
  await expect(continuePersonTask(1, task.id, request)).rejects.toThrow('changed')
  await expect(continuePersonTask(1, task.id, { ...request, expected_revision: 1 })).rejects.toThrow('Reopen')
  expect(ownedPersonTaskSession(1, chat.session.id).task.status).toBe('closed')
  activeAccount = false
  expect(() => ownedPersonTaskSession(1, chat.session.id)).toThrow('unavailable')
})

it.each(['disabled', 'removed', 'uninstalled'])('reads completed task history when the execution model is %s, while rejecting new execution', async unavailable => {
  const { personTaskChat, continuePersonTask } = await import('../../packages/server/src/modules/studio/services/person/task-chat')
  const sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
  const { task, execution } = await create()
  const chat = await personTaskChat(1, task.id)
  sessions.addMessage({ session_id: chat.session.id, role: 'assistant', content: 'Persisted task result' })
  await runner.tickPersonWork(); await wait(execution.id, 'finished')
  if (unavailable === 'disabled') catalog[0].model_meta = { m: { disabled: true } }
  if (unavailable === 'removed') catalog = []
  if (unavailable === 'uninstalled') installedAgent = false
  expect(await personTaskChat(1, task.id)).toMatchObject({ task: { status: 'completed' }, session: { id: chat.session.id } })
  expect(sessions.getSessionDetail(chat.session.id)?.messages).toEqual(expect.arrayContaining([expect.objectContaining({ content: 'Persisted task result' })]))
  await expect(continuePersonTask(1, task.id, { input: [{ type: 'text', text: 'Continue' }],
    expected_revision: store.getPersonTask(1, task.id).revision, idempotency_key: 'unavailable' })).rejects.toThrow(unavailable === 'uninstalled' ? 'not installed' : 'unavailable')
})

it('keeps task history private after resource permission is revoked', async () => {
  const { personTaskChat, ownedPersonTaskSession } = await import('../../packages/server/src/modules/studio/services/person/task-chat')
  const task = store.createPersonTask(2, 'Private task', 'Read history', selection, dir)
  const chat = await personTaskChat(2, task.id)
  allowedProfiles = []
  await expect(personTaskChat(2, task.id)).rejects.toThrow('permission revoked')
  expect(() => ownedPersonTaskSession(2, chat.session.id)).toThrow('permission revoked')
})


it('queries the same 100-task window as single chat with account-scoped search, status and ordering', async () => {
  for (let i = 0; i < 55; i++) {
    const task = store.createPersonTask(1, `Task ${i}`, 'Find reports', selection, dir)
    db.prepare('UPDATE session_tasks SET updated_at=?,status=? WHERE id=?').run(i + 1, i % 2 ? 'completed' : 'open', task.id)
  }
  store.createPersonTask(2, 'Private report', 'Find reports', selection, dir)
  expect(store.listPersonTasks(1)).toHaveLength(20)
  expect(store.listPersonTasks(1, '', 0, { limit: 100 })).toHaveLength(55)
  const completed = store.listPersonTasks(1, 'reports', 0, { limit: 100, status: 'completed', order: 'oldest' })
  expect(completed).toHaveLength(27)
  expect(completed[0].title).toBe('Task 1')
  expect(completed.at(-1)?.title).toBe('Task 53')
  expect(store.listPersonTasks(1, 'Private report', 0, { limit: 100 })).toEqual([])
})

it('uses one account workspace for creation, adoption, scheduled runs and follow-up turns', async () => {
  const { configurePerson, personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
  const { personTaskChat, continuePersonTask } = await import('../../packages/server/src/modules/studio/services/person/task-chat')
  const sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
  const delivery = await import('../../packages/server/src/modules/studio/services/person/delivery')
  const selected = join(dir, 'selected-workspace')
  await configurePerson(1, { workspace: selected, expected_revision: 1 })
  expect((await personSnapshot(1)).session.workspace).toBe(selected)
  sessions.createSession({ id: 'workspace-owned', profile: 'default', studio_user_id: '1', source: 'coding_agent' })
  sessions.addMessage({ session_id: 'workspace-owned', role: 'user', content: 'Take over this goal' })
  const goals = await import('../../packages/server/src/modules/studio/services/session-tasks')
  const original = goals.updateSessionTasks('workspace-owned', 'default', { revision: 0, changes: [{ title: 'Existing goal', summary: 'Take over', status: 'open' }] }).tasks[0]
  const adopted = await create({ action: 'adopt', task_id: original.id, expected_revision: original.updated_at, start: false })
  expect(adopted.task.workspace).toBe(selected)
  const first = await create()
  const second = await create({ start: false })
  expect(first.task.workspace).toBe(selected)
  expect(second.task.workspace).toBe(selected)
  await expect(create({ workspace: join(dir, 'individual-override') })).rejects.toThrow('managed by Person')
  await expect(configurePerson(1, { workspace: dir, expected_revision: 2 })).rejects.toThrow('Wait for Person tasks')
  await runner.tickPersonWork(); await wait(first.execution.id, 'finished')
  await delivery.deliverPersonResults(); delivery.finishPersonDelivery(1, first.execution.id, true)
  expect(vi.mocked(runtime.execute).mock.calls[0][0].workspace).toBe(selected)
  const chat = await personTaskChat(1, first.task.id)
  const nextWorkspace = join(dir, 'next-workspace')
  await configurePerson(1, { workspace: nextWorkspace, expected_revision: 2 })
  expect(store.getPersonTask(1, first.task.id).workspace).toBe(nextWorkspace)
  expect(store.getPersonTask(1, adopted.task.id).workspace).toBe(nextWorkspace)
  expect(sessions.getSession(chat.session.id)?.workspace).toBe(nextWorkspace)
  const next: any = await continuePersonTask(1, first.task.id, { input: [{ type: 'text', text: 'Continue the same work' }], expected_revision: store.getPersonTask(1, first.task.id).revision, idempotency_key: 'workspace-follow-up' })
  await runner.tickPersonWork(); await wait(next.execution.id, 'finished')
  await delivery.deliverPersonResults(); delivery.finishPersonDelivery(1, next.execution.id, true)
  expect(vi.mocked(runtime.execute).mock.calls[1][0]).toMatchObject({ sessionId: chat.session.id, workspace: nextWorkspace })
  const at = Date.now() + 60_000
  schedules.applyPersonSchedule(1, { action: 'create', task_id: second.task.id, kind: 'once', expression: new Date(at).toISOString(), timezone: 'UTC', idempotency_key: 'workspace-schedule' })
  schedules.tickPersonSchedules(at)
  const occurrence = store.taskPersonExecutions(1, second.task.id)[0]
  await runner.tickPersonWork(); await wait(occurrence.id, 'finished')
  expect(vi.mocked(runtime.execute).mock.calls[2][0].workspace).toBe(nextWorkspace)
  expect((await personSnapshot(2)).session.workspace).not.toBe(nextWorkspace)
})

it('restores a shared private workspace when the selected workspace is cleared', async () => {
  const { configurePerson, personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
  await expect(configurePerson(1, { workspace: '../relative', expected_revision: 1 })).rejects.toThrow('absolute')
  await configurePerson(1, { workspace: '', expected_revision: 1 })
  const snapshot = await personSnapshot(1)
  const a = await create({ start: false }); const b = await create({ start: false })
  expect(a.task.workspace).toBe(snapshot.session.workspace)
  expect(b.task.workspace).toBe(a.task.workspace)
  expect(existsSync(a.task.workspace)).toBe(true)
  await expect(configurePerson(1, { workspace: dir, expected_revision: 1 })).rejects.toThrow('changed')
})

it('atomically clears only Person history and tasks, retaining memory, preferences, ordinary chats and files', async () => {
  const { ensurePersonSession } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
  const { personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
  const { clearPerson } = await import('../../packages/server/src/modules/studio/services/person/history')
  const { personTaskChat } = await import('../../packages/server/src/modules/studio/services/person/task-chat')
  const sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
  const { savePersonTaskReturn } = await import('../../packages/server/src/modules/studio/repositories/person-return-store')
  await ensurePersonSession(1); await ensurePersonSession(2)
  sessions.addMessage({ session_id: 'person-main-1', role: 'user', content: 'Clear this conversation' })
  const assistant = sessions.addMessage({ session_id: 'person-main-1', role: 'assistant', content: 'Old result' })
  sessions.addMessage({ session_id: 'person-main-2', role: 'user', content: 'Other account history' })
  sessions.createSession({ id: 'ordinary-kept', studio_user_id: '1', profile: 'default' })
  sessions.addMessage({ session_id: 'ordinary-kept', role: 'user', content: 'Keep ordinary chat' })
  store.changePersonMemory(1, { content: 'Keep this preference', source: 'user' })
  const other = store.createPersonTask(2, 'Other account task', 'Keep this task', selection, dir)
  const { task, execution } = await create()
  const chat = await personTaskChat(1, task.id)
  sessions.addMessage({ session_id: chat.session.id, role: 'user', content: 'Private worker input' })
  store.setPersonExecution(execution, 'finished', { output: 'Old result' })
  db.prepare("UPDATE person_deliveries SET state='delivered' WHERE execution_id=?").run(execution.id)
  store.personEvent(execution, 'run.finished', { output: 'Old result' })
  store.addPersonInteraction(1, execution, 'old-question', 'Old question', [])
  savePersonTaskReturn(1, execution.id, 'person-main-1', assistant)
  const schedule = schedules.applyPersonSchedule(1, { action: 'create', task_id: task.id, kind: 'cron', expression: '0 9 * * *', timezone: 'UTC', idempotency_key: 'clear-schedule' })
  db.prepare('INSERT INTO person_occurrences VALUES (?,?,?,?,?,?)').run('past-occurrence', schedule.id, 0, 1, 'finished', execution.id)
  const file = join(dir, 'keep-result.txt'); writeFileSync(file, 'Keep the output file')
  const settingsBefore = store.personSettings(1)
  expect((await personSnapshot(1)).can_clear).toBe(true)
  expect(await clearPerson(1, { expected_history_revision: 0 })).toMatchObject({ cleared: true, deleted_tasks: 1 })
  expect(sessions.getSessionDetail('person-main-1')?.messages).toEqual([])
  expect(sessions.getSession('person-main-1')?.history_revision).toBe(1)
  expect(sessions.getSession(chat.session.id)).toBeNull()
  expect(sessions.getSessionDetail('person-main-2')?.messages).toHaveLength(1)
  expect(sessions.getSessionDetail('ordinary-kept')?.messages).toHaveLength(1)
  expect(store.getPersonTask(2, other.id).title).toBe('Other account task')
  expect(store.listPersonTasks(1)).toEqual([])
  expect(store.personSettings(1)).toEqual(settingsBefore)
  expect(store.personMemories(1)).toEqual([expect.objectContaining({ content: 'Keep this preference' })])
  expect(existsSync(file)).toBe(true)
  for (const table of ['person_executions', 'person_events', 'person_interactions', 'person_schedules', 'person_task_returns', 'person_deliveries', 'person_task_origins', 'person_operations']) {
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_user_id=1`).get()?.n).toBe(0)
  }
  expect(db.prepare('SELECT COUNT(*) AS n FROM person_occurrences').get()?.n).toBe(0)
  expect(clearHistoryMock).toHaveBeenCalledWith('person-main-1', { historyAlreadyCleared: true })
  expect(disposeSessionMock).toHaveBeenCalledWith(chat.session.id)
  const { deliverPersonResults } = await import('../../packages/server/src/modules/studio/services/person/delivery')
  await deliverPersonResults(); expect(runtime.deliver).not.toHaveBeenCalled()
  sessions.addMessage({ session_id: 'person-main-1', role: 'user', content: 'Fresh conversation' })
  await expect(clearPerson(1, { expected_history_revision: 0 })).rejects.toThrow('changed')
  expect(sessions.getSessionDetail('person-main-1')?.messages).toHaveLength(1)
})

it.each(['queued','starting','running','waiting_person','waiting_user','waiting_approval','stopping','pending_delivery','queued_delivery','main_reply'])('rejects clearing while %s without removing records', async state => {
  const { ensurePersonSession } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
  const { clearPerson } = await import('../../packages/server/src/modules/studio/services/person/history')
  const { personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
  const sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
  await ensurePersonSession(1)
  sessions.addMessage({ session_id: 'person-main-1', role: 'user', content: 'Keep while running' })
  const { task, execution } = await create()
  if (state.endsWith('_delivery')) {
    store.setPersonExecution(execution, 'finished')
    db.prepare('UPDATE person_deliveries SET state=? WHERE execution_id=?').run(state.startsWith('pending') ? 'pending' : 'queued', execution.id)
  } else if (state === 'main_reply') { mainBusy = true }
  else db.prepare('UPDATE person_executions SET state=? WHERE id=?').run(state, execution.id)
  expect((await personSnapshot(1)).can_clear).toBe(false)
  await expect(clearPerson(1, { expected_history_revision: 0 })).rejects.toThrow('finish')
  expect(store.getPersonTask(1, task.id)).toBeTruthy()
  expect(sessions.getSessionDetail('person-main-1')?.messages).toHaveLength(1)
  mainBusy = false
})
