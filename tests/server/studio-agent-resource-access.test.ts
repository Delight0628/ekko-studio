import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentExecutionStore } from '../../packages/server/src/modules/studio/repositories/agent-execution-store'
import { AgentCoordinator } from '../../packages/server/src/modules/studio/services/agents/coordinator'
import { AgentRegistry } from '../../packages/server/src/modules/studio/services/agents/registry'
import { PluginEventBus } from '../../packages/server/src/modules/studio/services/events/plugin-events'
import { createExecutionContext } from '../../packages/server/src/modules/studio/services/context/execution'
import { StudioError, type ExecutionScope } from '../../packages/studio-plugin-sdk/src'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const scope: ExecutionScope = { scopeId: 'scope', principal: { id: 'owner', kind: 'user' }, profileId: 'profile', surface: 'api', traceId: 'trace' }
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'resource-access-'))
  const db = new DatabaseSync(':memory:'), store = new AgentExecutionStore(db), registry = new AgentRegistry(), events = new PluginEventBus()
  const authorize = vi.fn(), dispose = vi.fn(async () => {}), logger = { info() {}, warn() {}, error() {} }
  const locations = vi.fn(async () => ({ configs: [{ id: 'config', name: 'Config', path: join(root, 'config.json'), scope: 'global' as const, readOnly: false, kind: 'file' as const, format: 'json' }] }))
  const create = vi.fn(async () => ({ run: async () => ({ events: (async function* () {})(), result: Promise.resolve({ status: 'completed' as const }), cancel: async () => {} }), dispose }))
  const registration = registry.stage('*', { kind: 'builtin', module: 'ekko', implementationVersion: 'test' }, ['ekko'])
  registration.register({ id: 'ekko', name: 'Fixture', configSchema: { type: 'object' }, capabilities: { text: true, modes: ['global', 'scoped'] }, management: { locations }, create }); registration.commit()
  const coordinator = new AgentCoordinator({ store, registry, events, logger, authorize, context: (scope, signal) => createExecutionContext(scope, signal, logger, { authorize: async () => {}, agents: { list: async () => [] }, sessions: { get: async () => null } }) })
  const instance = coordinator.createInstance(scope, { agentTypeId: 'ekko', config: {}, mode: 'global' })
  cleanup.push(async () => { await coordinator.close(); events.close(); db.close(); await rm(root, { recursive: true, force: true }) })
  return { root, coordinator, instance, locations, authorize, dispose, create }
}
const ref = { kind: 'configs' as const, locationId: 'config', path: '' }
it('keeps file IO bound to owner, profile, config revision and latest location snapshot', async () => {
  const f = await setup(), list = await f.coordinator.resourceFiles(scope, f.instance.id, 1, { action: 'list' })
  expect(list).toMatchObject({ configRevision: 1, files: [{ locationId: 'config', exists: false }] })
  for (const caller of [{ ...scope, profileId: 'other' }, { ...scope, principal: { id: 'other', kind: 'user' as const } }]) {
    await expect(f.coordinator.resourceFiles(caller, f.instance.id, 1, { action: 'read', ...ref }, list.snapshot)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  }
  await f.coordinator.resourceFiles(scope, f.instance.id, 1, { action: 'write', ...ref, etag: 'missing', content: '{"native":true}' }, list.snapshot)
  expect(await readFile(join(f.root, 'config.json'), 'utf8')).toBe('{"native":true}')
  f.locations.mockResolvedValue({ configs: [{ id: 'config', name: 'Changed', path: join(f.root, 'other.json'), kind: 'file', scope: 'global', readOnly: false, format: 'json' }] })
  await expect(f.coordinator.resourceFiles(scope, f.instance.id, 1, { action: 'read', ...ref }, list.snapshot)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  await f.coordinator.updateInstance(scope, f.instance.id, { revision: 1, config: {}, mode: 'scoped' })
  await expect(f.coordinator.resourceFiles(scope, f.instance.id, 1, { action: 'list' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  expect(f.create).not.toHaveBeenCalled()
})
it('holds the management lock through location discovery and rejects revoked access before writing', async () => {
  const f = await setup(), original = await f.locations()
  let release!: () => void
  f.locations.mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve }); return original })
  const pending = f.coordinator.resourceFiles(scope, f.instance.id, 1, { action: 'list' })
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  expect(() => f.coordinator.start(scope, f.instance.id, { content: [{ type: 'text', text: 'start' }] }, 'start')).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
  await expect(f.coordinator.updateInstance(scope, f.instance.id, { revision: 1, config: {}, mode: 'global' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  f.authorize.mockImplementation(() => { throw new StudioError('FORBIDDEN', 'revoked') })
  release()
  await expect(pending).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await expect(readFile(join(f.root, 'config.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})
it('invalidates an idle native runtime after a file save so the next Run reloads configuration', async () => {
  const f = await setup(), input = { content: [{ type: 'text' as const, text: 'run' }] }
  const first = f.coordinator.start(scope, f.instance.id, input, 'first'); await f.coordinator.wait(first.id)
  expect(f.create).toHaveBeenCalledTimes(1)
  const list = await f.coordinator.resourceFiles(scope, f.instance.id, 1, { action: 'list' })
  await f.coordinator.resourceFiles(scope, f.instance.id, 1, { action: 'write', ...ref, etag: 'missing', content: '{}' }, list.snapshot)
  expect(f.dispose).toHaveBeenCalledTimes(1)
  const next = f.coordinator.start(scope, f.instance.id, input, 'next'); await f.coordinator.wait(next.id)
  expect(f.create).toHaveBeenCalledTimes(2)
})
