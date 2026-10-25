import { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { BundledAgentPlugins } from '../../packages/server/src/modules/studio/services/plugins/bundled-agents'
import { PluginStore } from '../../packages/server/src/modules/studio/repositories/plugin-store'
import type { PluginHost } from '../../packages/server/src/modules/studio/services/plugins/host'
import { StudioError, type PluginManifest } from '../../packages/studio-plugin-sdk/src'

const close: Array<() => void> = []
afterEach(() => { close.splice(0).forEach(fn => fn()) })
function setup() {
  const db = new DatabaseSync(':memory:'), store = new PluginStore(db)
  close.push(() => db.close())
  const manifest: PluginManifest = { schemaVersion: 1, id: 'studio.agent-qwen', version: '0.1.0', engines: { studioSdk: '^0.1.0', rpc: 1 },
    backend: 'index.cjs', activation: 'profile', contributes: { agents: ['qwen'] }, requires: { capabilities: ['agents.register', 'processes.spawn', 'models.gateway', 'artifacts.read'] } }
  const authorize = vi.fn()
  const registerSystemArtifact = vi.fn(async (path: string, expectedId: string, check: () => void) => {
    check()
    expect(expectedId).toBe(manifest.id)
    return store.registerSystem({ id: manifest.id, manifest, generation: 'generation', artifactPath: path })
  })
  const configure = vi.fn(async (input, revision: number, check: () => void) => { check(); return store.saveProfile(input, revision) })
  const host = { registerSystemArtifact, configure, diagnostic: () => ({ state: 'disabled' }) } as unknown as PluginHost
  return { store, manifest, registerSystemArtifact, configure, authorize, service: new BundledAgentPlugins(host, store, '/distribution/server/plugin-runner.cjs', authorize) }
}

it('lists only implemented bundles and enables one through a trusted distribution path', async () => {
  const f = setup()
  expect(f.service.list('one').map(item => item.id)).toEqual(['qwen', 'codex', 'kimi', 'qoder', 'codebuddy', 'copilot', 'opencode', 'pi', 'dsh', 'claude-code', 'antigravity', 'cursor', 'grok', 'zcode'])
  expect(f.store.list()).toEqual([])
  const result = await f.service.enable('qwen', 'one', 'owner', 0)
  expect(result).toMatchObject({ enabled: true, ownerId: 'owner', profileId: 'one', revision: 1 })
  expect(f.registerSystemArtifact).toHaveBeenCalledWith('/distribution/plugins/qwen-code', 'studio.agent-qwen', expect.any(Function))
  expect(f.store.get('studio.agent-qwen')?.installationPolicy).toEqual({ kind: 'system', removable: false })
  expect(f.store.get('studio.agent-codex')).toBeNull()
})

it('displays the permissions of the actual distributed bundles before first installation', async () => {
  const f = setup()
  for (const bundle of f.service.list('one')) {
    const directory = bundle.id === 'qwen' ? 'qwen-code' : bundle.id
    const manifest = JSON.parse(await readFile(`plugins/${directory}/studio-plugin.json`, 'utf8'))
    expect(bundle.requiredCapabilities).toEqual(manifest.requires.capabilities)
  }
})

it('does not replace installed artifacts or reset existing profile settings and grants', async () => {
  const f = setup()
  await f.service.enable('qwen', 'one', 'owner', 0)
  f.store.saveProfile({ pluginId: 'studio.agent-qwen', profileId: 'one', ownerId: 'previous', enabled: false, config: { custom: 'keep' }, grants: ['agents.register'] }, 1)
  const original = f.store.get('studio.agent-qwen')
  expect(await f.service.enable('qwen', 'one', 'owner', 2)).toMatchObject({ config: { custom: 'keep' }, grants: ['agents.register'], revision: 3 })
  expect(f.registerSystemArtifact).toHaveBeenCalledOnce()
  expect(f.store.get('studio.agent-qwen')).toEqual(original)
  expect(f.store.profile('studio.agent-qwen', 'other')).toBeNull()
})

it('grants only an explicit current permission selection while preserving saved settings', async () => {
  const f = setup()
  await f.service.enable('qwen', 'one', 'owner', 0)
  f.store.saveProfile({ pluginId: 'studio.agent-qwen', profileId: 'one', ownerId: 'owner', enabled: false, config: { custom: 'keep' }, grants: ['agents.register'] }, 1)
  const before = f.store.profile('studio.agent-qwen', 'one')
  for (const grants of [['agents.register'], [...f.manifest.requires.capabilities, 'sessions.remove'], ['agents.register', 'agents.register']]) {
    await expect(f.service.enable('qwen', 'one', 'owner', 2, grants)).rejects.toBeInstanceOf(StudioError)
    expect(f.store.profile('studio.agent-qwen', 'one')).toEqual(before)
  }
  expect(await f.service.enable('qwen', 'one', 'owner', 2, f.manifest.requires.capabilities)).toMatchObject({
    config: { custom: 'keep' }, grants: f.manifest.requires.capabilities, enabled: true, revision: 3,
  })
})

it('rejects unknown IDs, stale revisions and revoked administrators before side effects', async () => {
  const f = setup()
  for (const id of ['../codex', 'studio.agent-qwen', 'hermes', 'unknown-agent']) await expect(f.service.enable(id, 'one', 'owner', 0)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  await expect(f.service.enable('qwen', 'one', 'owner', 3)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  f.authorize.mockImplementation(() => { throw new StudioError('FORBIDDEN', 'Revoked') })
  await expect(f.service.enable('qwen', 'one', 'owner', 0)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(f.registerSystemArtifact).not.toHaveBeenCalled()
  expect(f.configure).not.toHaveBeenCalled()
  expect(f.store.list()).toEqual([])
})

it('does not activate a bundle after authority is revoked during artifact inspection', async () => {
  const f = setup()
  f.registerSystemArtifact.mockImplementationOnce(async () => {
    f.authorize.mockImplementation(() => { throw new StudioError('FORBIDDEN', 'Revoked') })
    throw new StudioError('FORBIDDEN', 'Revoked')
  })
  await expect(f.service.enable('qwen', 'one', 'owner', 0)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(f.configure).not.toHaveBeenCalled()
  expect(f.store.list()).toEqual([])
})

it('drains in-flight setup and prevents late registration/activation during shutdown', async () => {
  const f = setup()
  let release!: () => void, started!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve }), entered = new Promise<void>(resolve => { started = resolve })
  f.registerSystemArtifact.mockImplementationOnce(async (_path, _id, authorize) => {
    started(); await barrier; authorize()
    throw new Error('Shutdown must reject before registration')
  })
  const result = f.service.enable('qwen', 'one', 'owner', 0).catch(error => error)
  await entered
  let finished = false
  const closing = f.service.close().then(() => { finished = true })
  expect(finished).toBe(false)
  release(); await closing
  expect(await result).toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  await expect(f.service.enable('qwen', 'one', 'owner', 0)).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  expect(f.configure).not.toHaveBeenCalled()
  expect(f.store.list()).toEqual([])
})
