import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { PluginHost } from '../../packages/server/src/modules/studio/services/plugins/host'
import { PluginStore } from '../../packages/server/src/modules/studio/repositories/plugin-store'
import { PluginCommandStore } from '../../packages/server/src/modules/studio/repositories/plugin-command-store'
import { PluginCommands } from '../../packages/server/src/modules/studio/services/commands/plugin'
import { AgentRegistry } from '../../packages/server/src/modules/studio/services/agents/registry'
import { PluginEventBus } from '../../packages/server/src/modules/studio/services/events/plugin-events'
import { createExecutionContext } from '../../packages/server/src/modules/studio/services/context/execution'
import { StudioError, type ExecutionScope, type PluginManifest } from '../../packages/studio-plugin-sdk/src'

let root: string, runner: string
const cleanup: Array<() => Promise<void>> = []
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'studio-commands-')); runner = join(root, 'runner.cjs')
  await build({ entryPoints: ['packages/studio-plugin-runner/src/main.ts'], bundle: true, platform: 'node', target: 'node24.22.1', format: 'cjs', outfile: runner, logLevel: 'silent' })
})
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
afterAll(async () => { await rm(root, { force: true, recursive: true }) })
const scope: ExecutionScope = { scopeId: 'scope', traceId: 'trace', profileId: 'one', principal: { kind: 'user', id: 'caller' }, surface: 'api' }
const definition = { id: 'test.commands/echo', name: 'echo', aliases: ['say'], description: 'Plugin echo', argsHint: '<text>' }
async function setup(handler: string, options: { definition?: object; extra?: string; grants?: string[] } = {}) {
  const db = new DatabaseSync(':memory:'), store = new PluginStore(db), registry = new AgentRegistry(), events = new PluginEventBus(), calls = new PluginCommandStore(db)
  db.exec('CREATE TABLE command_messages (id INTEGER PRIMARY KEY, session_id TEXT, content TEXT)')
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, publish = vi.fn()
  const target = { agentTypeId: 'hermes', fingerprint: 'initial', isWorking: false, authorized: true }
  const context = (current: ExecutionScope, signal: AbortSignal) => createExecutionContext(current, signal, logger, {
    authorize: async () => { if (!target.authorized) throw new StudioError('FORBIDDEN', 'Revoked') },
    agents: { list: async () => [] }, sessions: { get: async id => ({ id, profileId: current.profileId, title: current.principal.id, agentTypeId: 'hermes', archived: false }) },
  })
  const host = new PluginHost({ store, registry, events, context, logger, runnerPath: runner, artifactsRoot: join(root, 'artifacts'),
    eventContext: async () => context(scope, new AbortController().signal), acceptEvents: async () => {} })
  const service = new PluginCommands({ registry: host.commands, store: calls, context,
    authorize: (current, id) => {
      if (!target.authorized || current.principal.id !== 'caller' || current.profileId !== 'one' || id !== 'session' || (current.sessionId && current.sessionId !== id)) throw new StudioError('FORBIDDEN', 'Wrong target')
      return { ...target }
    },
    persist: (id, text) => Number(db.prepare('INSERT INTO command_messages(session_id, content) VALUES (?, ?)').run(id, text).lastInsertRowid), publish,
  })
  cleanup.push(async () => { await service.close(); await host.close(); events.close(); db.close() })
  const manifest: PluginManifest = { schemaVersion: 1, id: 'test.commands', version: '1.0.0', engines: { studioSdk: '^0.1.0', rpc: 1 }, backend: 'index.cjs', activation: 'profile',
    contributes: { agents: [], commands: [definition.id] }, requires: { capabilities: ['commands.register', ...(options.grants || [])] } }
  const directory = await mkdtemp(join(root, 'plugin-'))
  await writeFile(join(directory, 'studio-plugin.json'), JSON.stringify(manifest))
  await writeFile(join(directory, 'index.cjs'), `module.exports = { apply(plugin) {
    const remove = plugin.commands.register(${JSON.stringify(options.definition || definition)}, ${handler}); ${options.extra || ''}
  } }`)
  await host.install(directory)
  const state = { pluginId: manifest.id, profileId: 'one', ownerId: 'installer', enabled: true, config: {}, grants: manifest.requires.capabilities }
  const activate = () => host.configure(state, 0)
  const input = (text = '/test.commands:echo  "quoted"\n tail ', idempotencyKey = 'once') => ({ sessionId: 'session', commandId: definition.id,
    revision: service.list(scope, 'session')[0].revision, text, idempotencyKey })
  const finish = async (id: string) => {
    await vi.waitFor(() => expect(calls.get(id)?.status).not.toBe('running'))
    return service.get(scope, id)
  }
  const messages = () => db.prepare('SELECT content FROM command_messages ORDER BY id').all().map(row => row.content)
  return { db, host, store, calls, service, publish, target, activate, input, finish, messages, state }
}
const echo = `async (input, ctx) => ({ command: input.command, action: 'echo', ok: true, message: input.rawArguments,
  terminal: !ctx.session.isWorking, caller: ctx.scope.principal.id, profileName: ctx.scope.profileId })`

it('dispatches to a real worker with original parameters, host caller and legacy results, with durable idempotency', async () => {
  const s = await setup(echo); await s.activate()
  const metadata = s.service.list(scope, 'session')
  expect(metadata).toEqual([expect.objectContaining({ ...definition, qualifiedName: 'test.commands:echo', provider: expect.objectContaining({ pluginId: 'test.commands' }) })])
  const request = s.input(), accepted = s.service.start(scope, request)
  expect(s.service.start(scope, request).id).toBe(accepted.id)
  const result = await s.finish(accepted.id)
  expect(result.status).toBe('completed')
  expect(result.results).toEqual([expect.objectContaining({ event: 'session.command', session_id: 'session', command: 'test.commands:echo', action: 'echo',
    ok: true, terminal: true, message: '  "quoted"\n tail ', caller: 'caller', profileName: 'one', commandCallId: accepted.id, commandSequence: 0, messageId: 2 })])
  expect(s.messages()).toEqual([request.text, '  "quoted"\n tail ']); expect(s.publish).toHaveBeenCalledTimes(1)
  expect(s.service.start(scope, request).id).toBe(accepted.id)
  expect(() => s.service.start(scope, { ...request, text: '/say different' })).toThrow('different input')
  expect(() => s.service.get({ ...scope, principal: { kind: 'user', id: 'other' } }, accepted.id)).toThrow()
  expect(() => s.service.list({ ...scope, profileId: 'two' }, 'session')).toThrow()
})

it('streams awaited results while the handler runs and deduplicates concurrent submissions', async () => {
  const s = await setup(`async (input, ctx) => {
    await ctx.reply({ command: input.command, action: 'echo', ok: true, message: 'begin', started: true, terminal: false });
    await new Promise(resolve => setTimeout(resolve, 150));
    return { command: input.command, action: 'echo', ok: true, message: 'end', terminal: true };
  }`); await s.activate()
  const request = s.input('/say hello'), record = s.service.start(scope, request)
  await vi.waitFor(() => expect(s.calls.get(record.id)?.results).toHaveLength(1))
  expect(s.calls.get(record.id)?.status).toBe('running')
  expect(s.service.start(scope, request).id).toBe(record.id)
  expect(() => s.service.start(scope, { ...request, idempotencyKey: 'parallel' })).toThrow('already running')
  const result = await s.finish(record.id)
  expect(result.results.map(event => event.message)).toEqual(['begin', 'end']); expect(s.messages()).toHaveLength(3)
})

it('rechecks context grants and never allows the handler to read another session', async () => {
  const s = await setup(`async (input, ctx) => {
    const own = await ctx.sessions.get('session');
    let code; try { await ctx.sessions.get('foreign') } catch (error) { code = error.code }
    return { command: input.command, action: 'echo', ok: true, message: own.title + ':' + code };
  }`, { grants: ['sessions.read'] }); await s.activate()
  const request = s.input()
  const result = await s.finish(s.service.start(scope, request).id)
  expect(result.results[0].message).toBe('caller:FORBIDDEN')
  s.store.saveProfile({ ...s.state, grants: [] }, 1)
  expect(s.service.list(scope, 'session')).toEqual([])
  expect(() => s.service.start(scope, { ...request, idempotencyKey: 'revoked' })).toThrow()
})

it.each([
  `{ command: input.command, action: 'echo', ok: true, message: 'spoof', session_id: 'foreign' }`,
  `{ command: 'other', action: 'echo', ok: true, message: 'spoof' }`,
])('rejects forged command results before persistence or publication: %s', async payload => {
  const s = await setup(`async input => (${payload})`); await s.activate()
  const result = await s.finish(s.service.start(scope, s.input()).id)
  expect(result).toMatchObject({ status: 'failed', errorCode: 'INVALID_ARGUMENT', results: [] })
  expect(s.messages()).toHaveLength(1); expect(s.publish).not.toHaveBeenCalled()
})

it('preserves busy queries and rejects a result that would end an unrelated active run', async () => {
  const s = await setup(echo); await s.activate(); s.target.isWorking = true
  const query = await s.finish(s.service.start(scope, s.input()).id)
  expect(query.results[0].terminal).toBe(false)
  const bad = await setup(`input => ({ command: input.command, action: 'status', ok: true, message: 'done', terminal: true })`)
  await bad.activate(); bad.target.isWorking = true
  expect(await bad.finish(bad.service.start(scope, bad.input()).id)).toMatchObject({ status: 'failed', errorCode: 'REVISION_CONFLICT', results: [] })
})

it('cancels the actual worker handler, blocks configuration while active, and keeps late replies out', async () => {
  const s = await setup(`async (input, ctx) => {
    await ctx.reply({ command: input.command, action: 'echo', ok: true, message: 'waiting', terminal: false });
    await new Promise(resolve => ctx.signal.addEventListener('abort', resolve, { once: true }));
    return { command: input.command, action: 'echo', ok: true, message: 'late', terminal: true };
  }`); await s.activate()
  const record = s.service.start(scope, s.input())
  await vi.waitFor(() => expect(s.calls.get(record.id)?.results).toHaveLength(1))
  await expect(s.host.configure({ ...s.state, enabled: false }, 1)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  expect(await s.service.cancel(scope, record.id)).toMatchObject({ status: 'cancelled' })
  expect(s.calls.get(record.id)?.results.map(event => event.message)).toEqual(['waiting'])
  await s.host.configure({ ...s.state, enabled: false }, 1)
  expect(s.service.list(scope, 'session')).toEqual([])
})

it('withdraws registrations on activation rollback and rejects foreign target declarations', async () => {
  const broken = await setup(echo, { extra: `throw new Error('fixture activation failure')` })
  await expect(broken.activate()).rejects.toThrow(); expect(broken.service.list(scope, 'session')).toEqual([])
  const foreign = await setup(echo, { definition: { ...definition, agentTypeIds: ['other.plugin/agent'] } })
  await expect(foreign.activate()).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(foreign.service.list(scope, 'session')).toEqual([])
})

it('rejects stale registrations before dispatch and interrupts accepted calls on recovery without replay', async () => {
  const s = await setup(echo); await s.activate()
  const request = s.input()
  await s.host.configure({ ...s.state, enabled: false }, 1); await s.host.configure(s.state, 2)
  expect(() => s.service.start(scope, request)).toThrow('changed')
  const record = s.calls.accept(scope, s.input(), () => {})
  s.calls.recover()
  expect(s.service.start(scope, s.input()).id).toBe(record.id)
  expect(s.calls.get(record.id)).toMatchObject({ status: 'interrupted', results: [] }); expect(s.publish).not.toHaveBeenCalled()
})


it.each(['grants', 'target'])('ends active calls after %s change and rejects late replies', async kind => {
  const s = await setup(`async (input, ctx) => {
    await ctx.reply({ command: input.command, action: 'echo', ok: true, message: 'waiting', terminal: false });
    await new Promise(resolve => setTimeout(resolve, 600));
    return { command: input.command, action: 'echo', ok: true, message: 'late' };
  }`); await s.activate()
  const record = s.service.start(scope, s.input())
  await vi.waitFor(() => expect(s.calls.get(record.id)?.results).toHaveLength(1))
  if (kind === 'grants') s.store.saveProfile({ ...s.state, grants: [] }, 1)
  else s.target.fingerprint = 'changed'
  expect(await s.finish(record.id)).toMatchObject({ status: 'failed' })
  expect(s.calls.get(record.id)?.results.map(event => event.message)).toEqual(['waiting'])
})

it('terminates an uncooperative handler before cancellation returns and withdraws its commands', async () => {
  const s = await setup(`async (input, ctx) => {
    await ctx.reply({ command: input.command, action: 'echo', ok: true, message: 'waiting' });
    await new Promise(() => {});
  }`); await s.activate()
  const record = s.service.start(scope, s.input())
  await vi.waitFor(() => expect(s.calls.get(record.id)?.results).toHaveLength(1))
  expect(await s.service.cancel(scope, record.id)).toMatchObject({ status: 'cancelled' })
  await vi.waitFor(() => expect(s.service.list(scope, 'session')).toEqual([]))
})

it('rolls back accepted receipts and results if message persistence fails', async () => {
  const s = await setup(echo); await s.activate()
  const request = s.input()
  expect(() => s.calls.accept(scope, request, () => { throw new Error('storage failed') })).toThrow('storage failed')
  expect(s.calls.find(scope, request)).toBeNull()
  const record = s.calls.accept(scope, request, () => {})
  expect(() => s.calls.append(record.id, { command: 'echo', action: 'echo', ok: true, message: 'result' }, () => { throw new Error('storage failed') })).toThrow('storage failed')
  expect(s.calls.get(record.id)?.results).toEqual([])
})
