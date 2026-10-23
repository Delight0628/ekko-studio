import { randomUUID } from 'node:crypto'
import {
  StudioError, type EventEnvelope, type ExecutionContext, type JsonObject, type JsonValue,
  type ScopedLogger, type StudioEventMap, type Disposer,
} from '../../contracts/plugins'
import { SYSTEM_CODING_PLUGINS, isSystemPluginId } from '../../contracts/system-plugins'
import { PluginStore, type PluginInstallation, type PluginProfileState } from '../../repositories/plugin-store'
import { AgentRegistry } from '../agents/registry'
import { PluginEventBus } from '../events/plugin-events'
import { inspectPluginArtifact, stagePluginArtifact } from './artifacts'
import { compileSchema, jsonCopy, parseManifest, toJson } from './validation'
import { ResourceScope } from './resources'
import { PluginWorker } from './worker'

interface ActivePlugin { worker: PluginWorker; resources: ResourceScope; generation: string }
export interface PluginHostOptions {
  store: PluginStore
  registry: AgentRegistry
  events: PluginEventBus
  artifactsRoot: string
  runnerPath: string
  logger: ScopedLogger
  eventContext(state: PluginProfileState, event: EventEnvelope, signal: AbortSignal): Promise<ExecutionContext>
  acceptEvents(events: EventEnvelope[]): Promise<void>
}

const CORE_EVENTS: Array<keyof StudioEventMap> = [
  'plugin.ready', 'plugin.disabled', 'plugin.failed', 'agent.available', 'agent.unavailable',
  'run.completed', 'run.failed', 'run.cancelled', 'session.deleted',
]
const SUPPORTED_CAPABILITIES = new Set([
  'agents.register', 'agents.read', 'sessions.read', 'runs.read',
  ...CORE_EVENTS.map(name => `events.subscribe:${name}`),
])

export class PluginHost {
  private readonly active = new Map<string, ActivePlugin>()
  private readonly operations = new Map<string, Promise<unknown>>()
  private closed = false

  constructor(private readonly options: PluginHostOptions) {}

  list(): PluginInstallation[] { return this.options.store.list() }

  install(source: string): Promise<PluginInstallation> {
    return this.serial('install', async () => {
      const inspected = await inspectPluginArtifact(source)
      if (isSystemPluginId(inspected.manifest.id)) throw new StudioError('SYSTEM_PLUGIN_PROTECTED', 'Cannot replace a system plugin')
      this.validateDeclarations(inspected.manifest)
      if (this.options.store.get(inspected.manifest.id)) throw new StudioError('REVISION_CONFLICT', 'Plugin is already installed')
      const staged = await stagePluginArtifact(source, this.options.artifactsRoot)
      this.validateDeclarations(staged.manifest)
      if (staged.manifest.id !== inspected.manifest.id) throw new StudioError('INVALID_ARGUMENT', 'Plugin identity changed during installation')
      return this.options.store.installUser({ id: staged.manifest.id, ...staged })
    })
  }

  async registerSystemArtifact(source: string): Promise<PluginInstallation> {
    const inspected = await inspectPluginArtifact(source)
    this.validateDeclarations(inspected.manifest)
    if (!isSystemPluginId(inspected.manifest.id)) throw new StudioError('INVALID_ARGUMENT', 'Not a system plugin')
    return this.options.store.registerSystem({ id: inspected.manifest.id, manifest: inspected.manifest,
      generation: `${inspected.manifest.version}-${inspected.digest}`, artifactPath: source })
  }

  configure(input: Omit<PluginProfileState, 'revision'>, expectedRevision: number): Promise<PluginProfileState> {
    return this.serial(input.pluginId, async () => {
      const installation = this.requireInstallation(input.pluginId)
      if (!input.profileId.trim() || !input.ownerId.trim()) throw new StudioError('INVALID_ARGUMENT', 'Profile and owner are required')
      compileSchema(installation.manifest.configSchema ?? { type: 'object', additionalProperties: false })(input.config)
      if (input.grants.some(grant => !installation.manifest.requires.capabilities.includes(grant))) throw new StudioError('INVALID_ARGUMENT', 'Grant was not declared by plugin')
      const active = this.active.get(this.key(input.pluginId, input.profileId))
      if (active?.worker.hasLeases()) throw new StudioError('REVISION_CONFLICT', 'Drain Agent sessions before changing plugin configuration')
      // Compare and persist before stopping any healthy activation.
      const state = this.options.store.saveProfile(jsonCopy(input), expectedRevision)
      await this.stop(input.pluginId, input.profileId)
      if (state.enabled) await this.activateState(installation, state)
      return state
    })
  }

  activate(pluginId: string, profileId: string): Promise<void> {
    return this.serial(pluginId, async () => {
      const state = this.options.store.profile(pluginId, profileId)
      if (!state?.enabled) throw new StudioError('PLUGIN_UNAVAILABLE', 'Plugin is not enabled in this profile')
      if (this.active.has(this.key(pluginId, profileId))) return
      await this.activateState(this.requireInstallation(pluginId), state)
    })
  }

  uninstall(pluginId: string): Promise<void> {
    // Check protection before scheduling or touching workers, profiles or files.
    this.options.store.assertRemovable(pluginId)
    return this.serial(pluginId, async () => {
      this.options.store.assertRemovable(pluginId)
      const entries = [...this.active].filter(([key]) => key.startsWith(`${pluginId}:`))
      if (entries.some(([, value]) => value.worker.hasLeases())) throw new StudioError('REVISION_CONFLICT', 'Plugin still has active runtime leases')
      for (const [key, active] of entries) { this.active.delete(key); await active.resources.close() }
      this.options.store.remove(pluginId)
    })
  }

  async restore(): Promise<void> {
    for (const state of this.options.store.enabledProfiles()) {
      if (!this.options.store.get(state.pluginId)) continue
      try { await this.activate(state.pluginId, state.profileId) }
      catch { this.options.logger.warn('Plugin activation failed', { pluginId: state.pluginId, profileId: state.profileId }) }
    }
  }

  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.operations.values()])
    const active = [...this.active.values()]
    this.active.clear()
    await Promise.all(active.map(entry => entry.resources.close()))
  }

  private async activateState(installation: PluginInstallation, state: PluginProfileState): Promise<void> {
    const manifest = parseManifest(installation.manifest)
    this.validateDeclarations(manifest)
    if (manifest.requires.capabilities.some(capability => !state.grants.includes(capability))) throw new StudioError('FORBIDDEN', 'Plugin capabilities have not been granted')
    compileSchema(manifest.configSchema ?? { type: 'object', additionalProperties: false })(state.config)
    const artifact = await inspectPluginArtifact(installation.artifactPath)
    if (`${artifact.manifest.version}-${artifact.digest}` !== installation.generation || artifact.manifest.id !== installation.id) {
      throw new StudioError('PLUGIN_UNAVAILABLE', 'Plugin artifact integrity check failed')
    }
    const key = this.key(installation.id, state.profileId)
    const resources = new ResourceScope(() => this.options.logger.warn('Plugin resource cleanup failed', { pluginId: installation.id }))
    const provider = { kind: 'plugin' as const, pluginId: installation.id, version: manifest.version, generation: installation.generation }
    const registration = this.options.registry.stage(state.profileId, provider, manifest.contributes.agents)
    const authorize = (capability: string): void => {
      const latest = this.options.store.profile(installation.id, state.profileId)
      if (!latest?.enabled || !latest.grants.includes(capability) || !manifest.requires.capabilities.includes(capability)) throw new StudioError('FORBIDDEN', 'Plugin capability is not granted')
    }
    let worker: PluginWorker
    worker = new PluginWorker(this.options.runnerPath, this.options.logger, () => {
      if (this.active.get(key)?.worker === worker) this.active.delete(key)
      void resources.close()
    }, authorize)
    resources.add(() => worker.close())
    resources.add(() => registration.dispose())
    const removers = new Map<string, Disposer>()
    const subscriptions = new Map<string, Disposer>()
    const pendingEvents: EventEnvelope[] = []
    let committed = false
    worker.peer.handle('agent.remove', value => { const dispose = removers.get(String((value as JsonObject).id)); if (dispose) void dispose(); return null })
    worker.peer.handle('subscription.remove', value => { const dispose = subscriptions.get(String((value as JsonObject).id)); if (dispose) void dispose(); return null })
    worker.peer.handle('event.emit', async value => {
      const { type, data } = value as JsonObject
      if (typeof type !== 'string' || !Object.hasOwn(manifest.contributes.events || {}, type)) throw new StudioError('FORBIDDEN', 'Undeclared plugin event')
      authorize(`events.emit:${type}`)
      compileSchema(manifest.contributes.events![type])(data)
      const event = this.event(type, { profileId: state.profileId, pluginId: manifest.id }, data as JsonObject)
      if (!committed) {
        if (pendingEvents.length >= 128) throw new StudioError('RESOURCE_EXHAUSTED', 'Too many activation events')
        pendingEvents.push(event)
      } else await this.options.acceptEvents([event])
      return { id: event.id }
    })
    try {
      const activated = await worker.activate(artifact.entry, { id: manifest.id, version: manifest.version, generation: installation.generation, profileId: state.profileId }, state.config)
      if (activated.agents.length) authorize('agents.register')
      for (const meta of activated.agents) removers.set(meta.id, registration.register(worker.definition(meta)))
      const stagedSubscriptions: Array<() => void> = []
      for (const subscription of activated.subscriptions) {
        if (typeof subscription.id !== 'string' || !CORE_EVENTS.includes(subscription.type as keyof StudioEventMap) || typeof subscription.once !== 'boolean') throw new StudioError('INVALID_ARGUMENT', 'Invalid plugin subscription')
        const capability = `events.subscribe:${subscription.type}`
        authorize(capability)
        stagedSubscriptions.push(() => {
          const dispose = this.options.events.subscribe(subscription.type as keyof StudioEventMap, {
            profileId: state.profileId,
            context: async (event, signal) => {
              authorize(capability)
              return this.options.eventContext(state, event, signal)
            },
          }, async (event, ctx) => worker.withContext(ctx, async scopeHandle => {
            await worker.peer.request('event.deliver', toJson({ id: subscription.id, event, scope: ctx.scope, scopeHandle }))
          }), subscription.once)
          subscriptions.set(subscription.id, resources.add(dispose))
        })
      }
      if (resources.signal.aborted) throw new StudioError('PLUGIN_UNAVAILABLE', 'Plugin exited during activation')
      registration.commit()
      stagedSubscriptions.forEach(subscribe => subscribe())
      this.active.set(key, { worker, resources, generation: installation.generation })
      committed = true
      await this.options.acceptEvents([...pendingEvents, this.event('plugin.ready', { profileId: state.profileId, pluginId: manifest.id }, { pluginId: manifest.id, generation: installation.generation })])
    } catch (error) { if (this.active.get(key)?.worker === worker) this.active.delete(key); await resources.close(); throw error }
  }

  private event(type: string, subject: EventEnvelope['subject'], data: JsonObject): EventEnvelope {
    const id = randomUUID()
    return { schemaVersion: 1, id, type, occurredAt: Date.now(), partitionKey: `${subject.profileId}:${subject.pluginId}`, sequence: 0, subject, data, correlationId: id }
  }

  private validateDeclarations(manifest: PluginInstallation['manifest']): void {
    const system = SYSTEM_CODING_PLUGINS.find(plugin => plugin.pluginId === manifest.id)
    if (system && (manifest.contributes.agents.length !== 1 || manifest.contributes.agents[0] !== system.agentTypeId)) throw new StudioError('INVALID_ARGUMENT', 'System plugin must provide its distributed Agent type')
    for (const id of manifest.contributes.agents) {
      if (system ? id !== system.agentTypeId : !id.startsWith(`${manifest.id}/`)) throw new StudioError('FORBIDDEN', 'Agent type is outside the plugin namespace')
    }
    for (const capability of manifest.requires.capabilities) {
      if (SUPPORTED_CAPABILITIES.has(capability)) continue
      if (capability.startsWith('events.emit:') && Object.hasOwn(manifest.contributes.events || {}, capability.slice('events.emit:'.length))) continue
      throw new StudioError('CAPABILITY_UNSUPPORTED', 'Plugin requests an unsupported capability')
    }
  }

  private requireInstallation(id: string): PluginInstallation {
    const installation = this.options.store.get(id)
    if (!installation) throw new StudioError('NOT_FOUND', 'Plugin is not installed')
    return installation
  }

  private async stop(pluginId: string, profileId: string): Promise<void> {
    const key = this.key(pluginId, profileId), active = this.active.get(key)
    if (!active) return
    this.active.delete(key)
    await active.resources.close()
  }
  private key(pluginId: string, profileId: string): string { return `${pluginId}:${profileId}` }

  private serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new StudioError('PLUGIN_UNAVAILABLE', 'Plugin host is closed'))
    const previous = this.operations.get(key) || Promise.resolve()
    const pending = previous.catch(() => {}).then(operation)
    this.operations.set(key, pending)
    void pending.finally(() => { if (this.operations.get(key) === pending) this.operations.delete(key) }).catch(() => {})
    return pending
  }
}
