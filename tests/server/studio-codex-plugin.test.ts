import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { buildAgentPlugins } from '../../scripts/build-agent-plugins.mjs'
import { PluginHost } from '../../packages/server/src/modules/studio/services/plugins/host'
import { PluginStore } from '../../packages/server/src/modules/studio/repositories/plugin-store'
import { AgentExecutionStore } from '../../packages/server/src/modules/studio/repositories/agent-execution-store'
import { AgentRegistry } from '../../packages/server/src/modules/studio/services/agents/registry'
import { AgentCoordinator } from '../../packages/server/src/modules/studio/services/agents/coordinator'
import { PluginEventBus } from '../../packages/server/src/modules/studio/services/events/plugin-events'
import { createExecutionContext } from '../../packages/server/src/modules/studio/services/context/execution'
import type { ExecutionScope } from '../../packages/studio-plugin-sdk/src'

let root: string, runner: string
const cleanups: Array<() => Promise<void>> = []
const scope: ExecutionScope = { scopeId: 'scope', principal: { kind: 'user', id: 'caller' }, profileId: 'one', surface: 'api', traceId: 'trace' }
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'codex-plugin-中文 '))
  runner = join(root, 'runner.cjs')
  await build({ entryPoints: ['packages/studio-plugin-runner/src/main.ts'], bundle: true, platform: 'node', target: 'node24.22.1', format: 'cjs', outfile: runner, logLevel: 'silent' })
  await buildAgentPlugins(join(root, 'plugins'))
})
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

const fixture = `const fs = require('node:fs');
fs.writeFileSync(process.env.PID_FILE, String(process.pid));
const send = data => process.stdout.write(JSON.stringify(data) + '\\n');
let turnId, index = 0;
const notify = (method, params) => send({ method, params: { threadId: 'native-thread', turnId, ...params } });
const finish = () => {
  notify('item/completed', { item: { id: 'tool', type: 'commandExecution', command: 'echo fixture', status: 'completed', aggregatedOutput: 'done' } });
  notify('item/completed', { item: { id: 'answer', type: 'agentMessage', text: 'final answer' } });
  notify('turn/completed', { turn: { id: turnId, status: 'completed' } });
};
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const r = JSON.parse(line);
  fs.appendFileSync(process.env.TRACE_FILE, JSON.stringify(r) + '\\n');
  if (r.method === 'initialize') send({ id: r.id, result: {} });
  else if (r.method === 'thread/start' || r.method === 'thread/resume') send({ id: r.id, result: { thread: { id: 'native-thread' } } });
  else if (r.method === 'turn/start') {
    turnId = 'turn-' + (++index);
    const text = r.params.input[0].text;
    if (text === 'approval-slow') process.on('SIGTERM', () => {
      fs.appendFileSync(process.env.TRACE_FILE, JSON.stringify({ stopping: true }) + '\\n');
      setTimeout(() => process.exit(0), 300);
    });
    if (text === 'crash') { process.exit(7); return; }
    if (text === 'broken') { process.stdout.write('{bad\\n'); return; }
    // Send events before the admission response, including unrelated identities.
    notify('item/agentMessage/delta', { itemId: 'answer', delta: 'streamed' });
    notify('item/agentMessage/delta', { threadId: 'other', itemId: 'answer', delta: 'private' });
    notify('item/agentMessage/delta', { turnId: 'old-turn', itemId: 'answer', delta: 'stale' });
    notify('item/started', { item: { id: 'tool', type: 'commandExecution', command: 'echo fixture', status: 'inProgress' } });
    send({ id: r.id, result: { turn: { id: turnId, status: 'inProgress' } } });
    if (text.startsWith('approval')) send({ id: 'approval', method: 'item/commandExecution/requestApproval', params: {
      threadId: 'native-thread', turnId, itemId: 'tool', command: 'echo fixture', cwd: process.cwd(), availableDecisions: ['accept','decline','cancel'] } });
    else if (text === 'unresolved') notify('turn/completed', { turn: { id: turnId, status: 'completed' } });
    else finish();
  } else if (r.id === 'approval' && r.result?.decision === 'accept') finish();
  else if (r.method === 'turn/interrupt') {
    send({ id: r.id, result: {} });
    notify('turn/completed', { turn: { id: turnId, status: 'interrupted' } });
  }
});`

async function setup() {
  const directory = await mkdtemp(join(root, 'run-')), cli = join(directory, 'codex.cjs')
  const pidFile = join(directory, 'pid'), traceFile = join(directory, 'trace')
  await writeFile(cli, fixture)
  const db = new DatabaseSync(':memory:'), store = new PluginStore(db), registry = new AgentRegistry(), events = new PluginEventBus()
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const context = (scope: ExecutionScope, signal: AbortSignal) => createExecutionContext(scope, signal, logger, {
    authorize: async () => {}, agents: { list: async () => [] }, sessions: { get: async () => null },
  })
  const executionStore = new AgentExecutionStore(db)
  const coordinator = new AgentCoordinator({ store: executionStore, registry, events, logger, authorize: () => {}, context })
  const host = new PluginHost({ store, registry, events, context, logger, runnerPath: runner, artifactsRoot: join(root, 'installed'),
    eventContext: async (_state, _event, signal) => context(scope, signal), acceptEvents: async batch => { for (const event of batch) events.publish(event) } })
  cleanups.push(async () => { await coordinator.close(); await host.close(); events.close(); db.close() })
  await host.registerSystemArtifact(join(root, 'plugins/codex'))
  await host.configure({ pluginId: 'studio.agent-codex', profileId: 'one', ownerId: 'installer', enabled: true, config: {}, grants: ['agents.register', 'processes.spawn'] }, 0)
  const instance = coordinator.createInstance(scope, { agentTypeId: 'codex', mode: 'global', config: {
    cwd: directory, command: process.execPath, args: [cli], env: { PID_FILE: pidFile, TRACE_FILE: traceFile },
  } })
  const start = (text: string) => coordinator.start(scope, instance.id, { content: [{ type: 'text', text }] }, text)
  const run = async (text: string) => { const r = start(text); await coordinator.wait(r.id); return coordinator.get(scope, r.id) }
  const trace = async () => (await readFile(traceFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const pid = async () => Number(await readFile(pidFile, 'utf8'))
  const reopen = async () => {
    await coordinator.close()
    const next = new AgentCoordinator({ store: executionStore, registry, events, logger, authorize: () => {}, context })
    cleanups.push(() => next.close())
    return next
  }
  return { coordinator, host, executionStore, instance, start, run, trace, pid, reopen }
}
function alive(pid: number) { try { process.kill(pid, 0); return true } catch { return false } }

it('loads the Codex bundle in a worker, routes approvals and reuses a native process across turns', async () => {
  const f = await setup(), first = f.start('approval')
  await vi.waitFor(() => expect(f.coordinator.get(scope, first.id).status).toBe('waiting_input'))
  const pid = await f.pid()
  const interaction = f.coordinator.interactions(scope, first.id)[0]
  await f.coordinator.respond(scope, first.id, { interactionId: interaction.id, idempotencyKey: 'yes', choiceId: 'accept' })
  await f.coordinator.wait(first.id)
  expect(f.coordinator.get(scope, first.id).status).toBe('completed')
  const output = f.coordinator.output(scope, first.id, -1)
  expect(output.filter(e => e.type === 'message.delta')).toEqual([expect.objectContaining({ text: 'streamed' })])
  expect(output).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'message.snapshot', text: 'final answer' })]))
  expect(f.coordinator.usage(scope, first.id)).toEqual([])
  expect(alive(pid)).toBe(true)
  const second = await f.run('next')
  expect(second.status).toBe('completed')
  expect(await f.pid()).toBe(pid)
  expect((await f.trace()).filter(r => r.method === 'initialize')).toHaveLength(1)
  expect((await f.trace()).filter(r => r.method === 'thread/start')).toHaveLength(1)
  await f.coordinator.close()
  expect(alive(pid)).toBe(false)
})

it('interrupts an approval turn and confirms native process shutdown', async () => {
  const f = await setup(), run = f.start('approval')
  await vi.waitFor(() => expect(f.coordinator.get(scope, run.id).status).toBe('waiting_input'))
  const pid = await f.pid()
  await f.coordinator.cancel(scope, run.id)
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(scope, run.id).status).toBe('cancelled')
  expect(alive(pid)).toBe(false)
  expect(await f.trace()).toEqual(expect.arrayContaining([expect.objectContaining({ method: 'turn/interrupt', params: { threadId: 'native-thread', turnId: 'turn-1' } })]))
})

it('restores the committed native thread after releasing its runtime lease', async () => {
  const f = await setup()
  expect(await f.run('first')).toMatchObject({ status: 'completed' })
  const firstPid = await f.pid(), coordinator = await f.reopen()
  expect(alive(firstPid)).toBe(false)
  const run = coordinator.start(scope, f.instance.id, { content: [{ type: 'text', text: 'restored' }] }, 'restored')
  await coordinator.wait(run.id)
  expect(coordinator.get(scope, run.id).status).toBe('completed')
  expect(await f.pid()).not.toBe(firstPid)
  expect((await f.trace()).filter(r => r.method === 'thread/resume')).toEqual([
    expect.objectContaining({ params: expect.objectContaining({ threadId: 'native-thread' }) }),
  ])
})

it.skipIf(process.platform === 'win32')('keeps cancellation pending until the native process actually exits', async () => {
  const f = await setup(), run = f.start('approval-slow')
  await vi.waitFor(() => expect(f.coordinator.get(scope, run.id).status).toBe('waiting_input'))
  const pid = await f.pid()
  await f.coordinator.cancel(scope, run.id)
  await vi.waitFor(async () => expect((await f.trace()).some(frame => frame.stopping)).toBe(true))
  expect(alive(pid)).toBe(true)
  expect(f.coordinator.get(scope, run.id).status).toBe('cancelling')
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(scope, run.id).status).toBe('cancelled')
  expect(alive(pid)).toBe(false)
})

it.each(['crash', 'broken', 'unresolved'])('fails an incomplete native run and leaves the plugin usable: %s', async text => {
  const f = await setup(), run = await f.run(text)
  expect(run.status).toBe('failed')
  expect(alive(await f.pid())).toBe(false)
  expect(await f.run('fresh')).toMatchObject({ status: 'completed' })
  expect((await f.trace()).filter(r => r.method === 'thread/start')).toHaveLength(2)
})
