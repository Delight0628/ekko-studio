import { request } from '../client'
import type { AgentSetup, AgentInspection, AgentTypeSummary, JsonObject } from '../../../../studio-plugin-sdk/src/types'

export type { AgentSetup, AgentInspection, AgentTypeSummary, JsonObject }
export interface ManagedAgentInstance { id: string; agentTypeId: string; revision: number; mode: 'scoped' | 'global'; config: JsonObject }
export interface BundledAgentPlugin { id: string; name: string; pluginId: string; installed: boolean; enabled: boolean; revision: number; state: string; requiredCapabilities: string[] }
const query = (profile: string) => `?${new URLSearchParams({ profile })}`
async function data<T>(path: string, profile: string, method = 'GET', body?: unknown): Promise<T> {
  return (await request<{ data: T }>(`/api/studio/${path}${query(profile)}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).data
}
export async function fetchAgentTypes(profile: string) { return (await data<{ agents: AgentTypeSummary[] }>('agent-types', profile)).agents }
export function fetchManagedAgentInstances(profile: string) { return data<ManagedAgentInstance[]>('agent-instances', profile) }
export function saveManagedAgentInstance(profile: string, agentTypeId: string, config: JsonObject, mode: 'scoped' | 'global', existing?: ManagedAgentInstance) {
  return existing ? data<ManagedAgentInstance>(`agent-instances/${encodeURIComponent(existing.id)}`, profile, 'PUT', { config, mode, revision: existing.revision })
    : data<ManagedAgentInstance>('agent-instances', profile, 'POST', { agentTypeId, config, mode })
}
export function fetchBundledAgentPlugins(profile: string) { return data<BundledAgentPlugin[]>('bundled-agent-plugins', profile) }
export function enableBundledAgentPlugin(profile: string, plugin: BundledAgentPlugin) { return data(`bundled-agent-plugins/${encodeURIComponent(plugin.id)}/enable`, profile, 'POST', { revision: plugin.revision }) }
export function fetchAgentSetup(profile: string, instance: ManagedAgentInstance) { return data<AgentSetup>(`agent-instances/${encodeURIComponent(instance.id)}/setup`, profile, 'POST', { revision: instance.revision }) }
export function inspectManagedAgent(profile: string, instance: ManagedAgentInstance) { return data<AgentInspection>(`agent-instances/${encodeURIComponent(instance.id)}/inspect`, profile, 'POST', {}) }
