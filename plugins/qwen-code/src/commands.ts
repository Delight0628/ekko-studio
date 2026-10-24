import { createHash } from 'node:crypto'
import { StudioError, type AgentRuntimeContext, type CommandDefinition, type CommandHandler } from '@ekko-studio/plugin-sdk'

/** ACP publishes its own catalog. Studio never interprets these native names. */
export function qwenCommands(value: unknown): Array<{ definition: CommandDefinition; handler: CommandHandler }> {
  if (!Array.isArray(value) || value.length > 4096) throw new StudioError('RESOURCE_EXHAUSTED', 'Qwen command discovery limit exceeded')
  const names = new Set<string>()
  return value.filter(command => {
    if (!command || typeof command.name !== 'string' || !/^[\p{L}\p{N}_][\p{L}\p{N}_.:-]{0,127}$/u.test(command.name)
      || names.has(command.name) || typeof command.description !== 'string') return false
    names.add(command.name); return true
  }).slice(0, 64).map(command => {
    const name = command.name
    return {
      definition: { id: name === 'compress' ? 'studio.agent-qwen/compress' : `studio.agent-qwen/native-${createHash('sha256').update(name).digest('hex').slice(0, 32)}`, name, agentTypeIds: ['qwen'],
        description: command.description.slice(0, 512), ...(typeof command.input?.hint === 'string' ? { argsHint: command.input.hint.slice(0, 256) } : {}) },
      handler: async (input, ctx) => {
        if (!ctx.session.instanceId) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Qwen command requires an instance chat')
        await ctx.runs.start({ instanceId: ctx.session.instanceId, input: { content: [{ type: 'text', text: `/${name}${input.rawArguments}` }] }, idempotencyKey: ctx.scope.scopeId })
        return { command: input.command, action: 'submitted', ok: true, message: '', terminal: false }
      },
    }
  })
}
export const compressCommand = qwenCommands([{ name: 'compress', description: 'Compress the current Qwen conversation' }])[0]!

export function qwenCommandCatalog(runtime: AgentRuntimeContext) {
  let pending = Promise.resolve(), failure: unknown, queued = 0
  return {
    update(value: unknown) {
      const parsed = qwenCommands(value)
      const registrations = parsed.filter(command => command.definition.id !== compressCommand.definition.id)
      if (Array.isArray(value) && value.length > parsed.length) runtime.logger.warn('Qwen completion omitted unsupported or excess native commands', { discovered: value.length, published: parsed.length, limit: 64 })
      if (runtime.commands) {
        if (queued >= 64) throw new StudioError('RESOURCE_EXHAUSTED', 'Qwen command update limit exceeded')
        queued++
        pending = pending.then(() => runtime.commands!.replace(registrations)).catch(error => { failure = error }).finally(() => { queued-- })
      }
    },
    async drain() { await pending; if (failure) throw failure },
  }
}
