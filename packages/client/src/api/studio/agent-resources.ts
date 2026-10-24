import { request } from '../client'

export interface AgentResourceInstance { id: string; agentTypeId: string; revision: number; mode: 'scoped' | 'global' }
export interface AgentResourceLocation {
  id: string; name: string; path: string; scope: 'global' | 'scoped' | 'workspace' | 'shared' | 'builtin'; readOnly: boolean
  kind?: 'file' | 'directory'; format?: string
}
export interface AgentResourceRef { kind: 'skills' | 'configs'; locationId: string; path: string }
export interface AgentResourceFile extends AgentResourceRef { absolutePath: string; exists: boolean; readOnly: boolean }
export interface AgentResourceContent extends AgentResourceFile { content: string; etag: string }
export interface AgentResourceCatalog {
  instanceId: string; configRevision: number; snapshot: string
  skills?: AgentResourceLocation[]; configs?: AgentResourceLocation[]; files: AgentResourceFile[]
}
export async function fetchResourceInstances(profile: string): Promise<AgentResourceInstance[]> {
  return (await request<{ data: AgentResourceInstance[] }>(`/api/studio/agent-instances?${new URLSearchParams({ profile })}`)).data
}
const pending = new Map<string, Promise<unknown>>()
async function resourceRequest<T>(instance: AgentResourceInstance, profile: string, body: Record<string, unknown>): Promise<T> {
  const key = JSON.stringify([profile, instance.id])
  const task = (pending.get(key) || Promise.resolve()).catch(() => {}).then(async () => (await request<{ data: T }>(`/api/studio/agent-instances/${encodeURIComponent(instance.id)}/resources?${new URLSearchParams({ profile })}`, {
    method: 'POST', body: JSON.stringify({ revision: instance.revision, ...body }),
  })).data)
  pending.set(key, task)
  try { return await task } finally { if (pending.get(key) === task) pending.delete(key) }
}
export function fetchResourceCatalog(instance: AgentResourceInstance, profile: string): Promise<AgentResourceCatalog> {
  return resourceRequest(instance, profile, { action: 'list' })
}
const refFields = (ref: AgentResourceRef) => ({ kind: ref.kind, locationId: ref.locationId, path: ref.path })
export async function readAgentResource(instance: AgentResourceInstance, profile: string, snapshot: string, ref: AgentResourceRef): Promise<AgentResourceContent> {
  return (await resourceRequest<{ file: AgentResourceContent }>(instance, profile, { action: 'read', snapshot, ...refFields(ref) })).file
}
export async function writeAgentResource(instance: AgentResourceInstance, profile: string, snapshot: string, file: AgentResourceContent, content: string): Promise<AgentResourceContent> {
  return (await resourceRequest<{ file: AgentResourceContent }>(instance, profile, { action: 'write', snapshot, ...refFields(file), etag: file.etag, content })).file
}
