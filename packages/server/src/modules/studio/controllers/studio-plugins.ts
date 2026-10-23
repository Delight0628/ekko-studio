import type { Context } from 'koa'
import { randomUUID } from 'node:crypto'
import { StudioError, type JsonObject, type AgentRunInput, type ExecutionScope } from '../contracts/plugins'
import { getStudioPluginRuntime, authorizePluginScope } from '../services/plugins/runtime'
import { jsonCopy } from '../services/plugins/validation'

const statusFor = (code: string): number => ({ INVALID_ARGUMENT: 400, FORBIDDEN: 403, NOT_FOUND: 404,
  SYSTEM_PLUGIN_PROTECTED: 403, REVISION_CONFLICT: 409, REGISTRATION_CONFLICT: 409,
  PLUGIN_UNAVAILABLE: 503, PLUGIN_VERSION_INCOMPATIBLE: 409, CAPABILITY_UNSUPPORTED: 422,
  RUNTIME_UNAVAILABLE: 503, DEADLINE_EXCEEDED: 504, CANCELLED: 409,
  RESOURCE_EXHAUSTED: 429 }[code] || 500)

async function respond(ctx: Context, action: () => unknown | Promise<unknown>): Promise<void> {
  ctx.set('Cache-Control', 'no-store')
  try { ctx.body = { ok: true, data: await action() } }
  catch (error) {
    if (!(error instanceof StudioError)) throw error
    ctx.status = statusFor(error.code)
    ctx.body = { ok: false, error: error.toJSON() }
  }
}

function body(ctx: Context, keys: string[]): JsonObject {
  const value = jsonCopy(ctx.request.body || {})
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new StudioError('INVALID_ARGUMENT', 'Invalid plugin request')
  return value as JsonObject
}
function profile(ctx: Context): string {
  const id = ctx.state.profile?.name
  if (typeof id !== 'string' || !id) throw new StudioError('INVALID_ARGUMENT', 'Profile is required')
  authorizePluginScope({ scopeId: 'http', principal: { kind: 'user', id: userId(ctx) }, profileId: id, surface: 'api', traceId: 'http' })
  return id
}

function userId(ctx: Context): string {
  if (!ctx.state.user) throw new StudioError('FORBIDDEN', 'Authentication is required')
  return String(ctx.state.user.id)
}

export const listPlugins = (ctx: Context) => respond(ctx, () => getStudioPluginRuntime().host.list().map(plugin => ({
  id: plugin.id, version: plugin.manifest.version, generation: plugin.generation, origin: plugin.origin,
  installationPolicy: plugin.installationPolicy, revision: plugin.revision,
  agents: plugin.manifest.contributes.agents, requiredCapabilities: plugin.manifest.requires.capabilities,
})))

export const installPlugin = (ctx: Context) => respond(ctx, async () => {
  const input = body(ctx, ['path'])
  if (typeof input.path !== 'string' || !input.path.trim()) throw new StudioError('INVALID_ARGUMENT', 'Plugin directory path is required')
  const plugin = await getStudioPluginRuntime().host.install(input.path)
  return { id: plugin.id, version: plugin.manifest.version, installationPolicy: plugin.installationPolicy }
})

export const configurePlugin = (ctx: Context) => respond(ctx, async () => {
  const profileId = profile(ctx)
  const input = body(ctx, ['enabled', 'config', 'grants', 'revision', 'profile'])
  if (typeof input.enabled !== 'boolean' || !input.config || typeof input.config !== 'object' || Array.isArray(input.config)
    || !Array.isArray(input.grants) || input.grants.some(value => typeof value !== 'string') || !Number.isSafeInteger(input.revision) || Number(input.revision) < 0) throw new StudioError('INVALID_ARGUMENT', 'Invalid plugin configuration')
  return getStudioPluginRuntime().host.configure({ pluginId: ctx.params.id, profileId, ownerId: userId(ctx),
    enabled: input.enabled, config: input.config, grants: input.grants as string[] }, Number(input.revision))
})

export const getPluginProfile = (ctx: Context) => respond(ctx, () => getStudioPluginRuntime().store.profile(ctx.params.id, profile(ctx)))
export const removePlugin = (ctx: Context) => respond(ctx, async () => {
  await getStudioPluginRuntime().host.uninstall(ctx.params.id)
  return { removed: true }
})
export const listAgentTypes = (ctx: Context) => respond(ctx, () => ({
  revision: getStudioPluginRuntime().registry.getRevision(), agents: getStudioPluginRuntime().registry.list(profile(ctx)),
}))

function executionScope(ctx: Context): ExecutionScope {
  return { scopeId: randomUUID(), principal: { kind: 'user', id: userId(ctx) }, profileId: profile(ctx), surface: 'api', traceId: randomUUID() }
}
export const listAgentInstances = (ctx: Context) => respond(ctx, () => getStudioPluginRuntime().coordinator.listInstances(executionScope(ctx)))
export const createAgentInstance = (ctx: Context) => respond(ctx, () => {
  const input = body(ctx, ['agentTypeId', 'config', 'mode', 'profile'])
  if (typeof input.agentTypeId !== 'string' || !input.config || typeof input.config !== 'object' || Array.isArray(input.config)
    || (input.mode !== 'scoped' && input.mode !== 'global')) throw new StudioError('INVALID_ARGUMENT', 'Invalid Agent instance')
  return getStudioPluginRuntime().coordinator.createInstance(executionScope(ctx), { agentTypeId: input.agentTypeId, config: input.config, mode: input.mode })
})
export const startAgentExecution = (ctx: Context) => respond(ctx, () => {
  const input = body(ctx, ['input', 'idempotencyKey', 'profile'])
  if (!input.input || typeof input.input !== 'object' || Array.isArray(input.input) || typeof input.idempotencyKey !== 'string') throw new StudioError('INVALID_ARGUMENT', 'Run input and idempotency key are required')
  if (Object.keys(input.input).some(key => !['content', 'model', 'timeoutMs'].includes(key))) throw new StudioError('INVALID_ARGUMENT', 'Unknown run input property')
  return getStudioPluginRuntime().coordinator.start(executionScope(ctx), ctx.params.id, input.input as unknown as AgentRunInput, input.idempotencyKey)
})
export const getAgentExecution = (ctx: Context) => respond(ctx, () => getStudioPluginRuntime().coordinator.get(executionScope(ctx), ctx.params.id))
export const getAgentExecutionOutput = (ctx: Context) => respond(ctx, () => getStudioPluginRuntime().coordinator.output(executionScope(ctx), ctx.params.id, Number(ctx.query.after ?? -1)))
export const cancelAgentExecution = (ctx: Context) => respond(ctx, () => getStudioPluginRuntime().coordinator.cancel(executionScope(ctx), ctx.params.id))
