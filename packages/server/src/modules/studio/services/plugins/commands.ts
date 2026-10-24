import { randomUUID } from 'node:crypto'
import { StudioError, type AgentProviderRef, type CommandDefinition, type CommandInput, type CommandContext, type CommandResult } from '../../contracts/plugins'
import { compileSchema, jsonCopy } from './validation'

const name = { type: 'string', pattern: '^[a-z][a-z0-9-]*$', maxLength: 64 }
const validateDefinition = compileSchema({ type: 'object', additionalProperties: false, required: ['id', 'name', 'description'], properties: {
  id: { type: 'string', maxLength: 256 }, name, description: { type: 'string', maxLength: 512 }, argsHint: { type: 'string', maxLength: 256 },
  aliases: { type: 'array', maxItems: 16, uniqueItems: true, items: name },
  agentTypeIds: { type: 'array', minItems: 1, maxItems: 64, uniqueItems: true, items: { type: 'string', maxLength: 256 } },
} })
// These fields carry transport authority, rather than plugin result data.
const envelope = new Set(['event', 'session_id', 'sessionId', 'ownerId', 'profileId', 'profile', 'scope', 'providerRef', 'generation', 'runId', 'run_id', 'run_marker', 'agent_run_id', 'queue_id', 'replayed', 'producer_sequence', 'commandCallId', 'commandSequence', 'messageId'])
export function parseCommandResult(value: unknown, input: CommandInput): CommandResult {
  const result = jsonCopy(value, 32_768) as CommandResult
  if (!result || typeof result !== 'object' || Array.isArray(result) || result.command !== input.command
    || typeof result.action !== 'string' || !/^[a-z][a-z0-9_.-]{0,127}$/.test(result.action)
    || typeof result.ok !== 'boolean' || typeof result.message !== 'string' || result.message.length > 16_384
    || Object.keys(result).some(key => envelope.has(key))
    || (result.messageKey !== undefined && (typeof result.messageKey !== 'string' || result.messageKey.length > 128))
    || ['started', 'terminal'].some(key => result[key] !== undefined && typeof result[key] !== 'boolean')) {
    throw new StudioError('INVALID_ARGUMENT', 'Invalid command result')
  }
  return result
}
export interface CommandSummary extends CommandDefinition { provider: AgentProviderRef; revision: string; qualifiedName: string }
type Invoke = (id: string, input: CommandInput, ctx: CommandContext) => Promise<void>
interface Entry { summary: CommandSummary; invoke: Invoke; authorize(): void }

/** Registry owns dispatch only; all argument/command semantics remain in plugin handlers. */
export class PluginCommandRegistry {
  private entries = new Map<string, Entry>()
  list(profileId: string, agentTypeId: string): CommandSummary[] {
    return [...this.entries].filter(([key, entry]) => key.startsWith(`${profileId}:`) && this.matches(entry, agentTypeId))
      .flatMap(([, entry]) => { try { entry.authorize(); return [jsonCopy(entry.summary)] } catch { return [] } })
      .sort((a, b) => a.id.localeCompare(b.id))
  }
  resolve(profileId: string, agentTypeId: string, id: string, revision: string): Entry {
    const entry = this.entries.get(`${profileId}:${id}`)
    if (!entry || !this.matches(entry, agentTypeId)) throw new StudioError('PLUGIN_UNAVAILABLE', 'Command is unavailable')
    entry.authorize()
    if (entry.summary.revision !== revision) throw new StudioError('REVISION_CONFLICT', 'Command registration changed')
    return entry
  }
  stage(profileId: string, provider: Extract<AgentProviderRef, { kind: 'plugin' }>, ids: string[], agentIds: string[], invoke: Invoke, authorize: () => void) {
    const pending = new Map<string, Entry>()
    let committed = false, disposed = false
    return {
      validate: (values: CommandDefinition[]) => {
        if (committed || disposed || !Array.isArray(values) || values.length !== ids.length) throw new StudioError('INVALID_ARGUMENT', 'Command declarations do not match registrations')
        for (const value of values) {
          const definition = jsonCopy(value)
          validateDefinition(definition as unknown as import('../../contracts/plugins').JsonValue)
          if (!ids.includes(definition.id) || pending.has(definition.id) || definition.agentTypeIds?.some(id => !agentIds.includes(id))) throw new StudioError('FORBIDDEN', 'Command was not declared for this provider')
          const names = [definition.name, ...(definition.aliases || [])]
          if (new Set(names).size !== names.length) throw new StudioError('REGISTRATION_CONFLICT', 'Duplicate command alias')
          if (this.entries.has(`${profileId}:${definition.id}`)) throw new StudioError('REGISTRATION_CONFLICT', 'Command is already registered')
          pending.set(definition.id, { summary: { ...definition, provider: jsonCopy(provider), revision: randomUUID(), qualifiedName: `${provider.pluginId}:${definition.id.split('/')[1]}` }, invoke, authorize })
        }
      },
      commit: () => {
        if (disposed || committed || pending.size !== ids.length) throw new StudioError('INVALID_ARGUMENT', 'Commands were not validated')
        for (const [id, entry] of pending) this.entries.set(`${profileId}:${id}`, entry)
        committed = true
      },
      remove: (id: string) => {
        const key = `${profileId}:${id}`
        if (this.entries.get(key) === pending.get(id)) this.entries.delete(key)
        pending.delete(id)
      },
      dispose: () => {
        disposed = true
        for (const [id, entry] of pending) if (this.entries.get(`${profileId}:${id}`) === entry) this.entries.delete(`${profileId}:${id}`)
        pending.clear()
      },
    }
  }
  private matches(entry: Entry, type: string): boolean { return !entry.summary.agentTypeIds || entry.summary.agentTypeIds.includes(type) }
}
