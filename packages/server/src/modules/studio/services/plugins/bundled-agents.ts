import { dirname, resolve } from 'node:path'
import { StudioError } from '../../contracts/plugins'
import type { PluginHost } from './host'
import type { PluginStore } from '../../repositories/plugin-store'

// Only implemented, built artifacts are eligible for explicit setup. This is
// independent of the reservation list and does not default-install 14 agents.
const bundles = [
  { id: 'qwen', name: 'Qwen Code', pluginId: 'studio.agent-qwen', directory: 'qwen-code' },
  { id: 'codex', name: 'Codex', pluginId: 'studio.agent-codex', directory: 'codex' },
] as const
const bundledCapabilities = ['agents.register', 'commands.register', 'runs.start', 'processes.spawn', 'mcp.studio', 'models.gateway', 'artifacts.read']

export class BundledAgentPlugins {
  private pending = new Map<string, Promise<unknown>>()
  private closed = false
  constructor(private host: PluginHost, private store: PluginStore, private runnerPath: string, private authorize: (profileId: string, ownerId: string) => void) {}

  list(profileId: string) {
    return bundles.map(bundle => {
      const profile = this.store.profile(bundle.pluginId, profileId), installed = this.store.get(bundle.pluginId)
      return { id: bundle.id, name: bundle.name, pluginId: bundle.pluginId, installed: !!installed,
        revision: profile?.revision || 0, enabled: profile?.enabled || false,
        requiredCapabilities: installed?.manifest.requires.capabilities || [...bundledCapabilities],
        state: installed ? this.host.diagnostic(bundle.pluginId, profileId).state : 'not_installed' }
    })
  }

  async enable(id: string, profileId: string, ownerId: string, revision: number, grants?: string[]) {
    const authorize = () => {
      if (this.closed) throw new StudioError('RUNTIME_UNAVAILABLE', 'Plugin setup is shutting down')
      this.authorize(profileId, ownerId)
    }
    authorize()
    const bundle = bundles.find(value => value.id === id)
    if (!bundle) throw new StudioError('NOT_FOUND', 'Bundled Agent plugin is unavailable')
    if (!Number.isSafeInteger(revision) || revision < 0) throw new StudioError('INVALID_ARGUMENT', 'Plugin configuration revision is required')
    if (grants !== undefined && (!Array.isArray(grants) || grants.length > 128 || grants.some(value => typeof value !== 'string' || value.length > 256)
      || new Set(grants).size !== grants.length)) throw new StudioError('INVALID_ARGUMENT', 'Invalid plugin permission selection')
    const selectedGrants = grants?.slice()
    if (this.pending.has(bundle.pluginId)) throw new StudioError('REVISION_CONFLICT', 'Bundled Agent plugin is being configured')
    const task = Promise.resolve().then(async () => {
      authorize()
      const current = this.store.profile(bundle.pluginId, profileId)
      if ((current?.revision || 0) !== revision) throw new StudioError('REVISION_CONFLICT', 'Plugin configuration changed')
      const existing = this.store.get(bundle.pluginId)
      const installed = existing || await this.host.registerSystemArtifact(resolve(dirname(this.runnerPath), '../plugins', bundle.directory), bundle.pluginId, authorize)
      authorize()
      if (installed.id !== bundle.pluginId || installed.installationPolicy.kind !== 'system') throw new StudioError('PLUGIN_UNAVAILABLE', 'Bundled Agent artifact identity does not match')
      const required = installed.manifest.requires.capabilities
      if (selectedGrants && (selectedGrants.length !== required.length || selectedGrants.some(value => !required.includes(value)))) throw new StudioError('REVISION_CONFLICT', 'Required plugin permissions changed; reload before authorizing')
      return this.host.configure({ pluginId: bundle.pluginId, profileId, ownerId, enabled: true,
        config: current?.config || {}, grants: selectedGrants || current?.grants || [...required] }, revision, authorize)
    })
    this.pending.set(bundle.pluginId, task)
    try { return await task } finally { this.pending.delete(bundle.pluginId) }
  }

  async close() { this.closed = true; await Promise.allSettled([...this.pending.values()]) }
}
