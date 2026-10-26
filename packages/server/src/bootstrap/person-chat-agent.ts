import { randomUUID } from 'node:crypto'
import { AgentRuntime, AgentToolRegistry } from '../../../ekko-agent/src'
import type { AgentRuntimeRunInput, AgentRuntimeBoundaryInterruptRequest } from '../../../ekko-agent/src/runtime/types'
import type { PersonTaskOrigin } from '../modules/studio/contracts/person'
import type { PersonChatAgentOptions } from '../modules/studio/public/person-runtime'
import { personBudgetedClient } from './person-model-context'

export function createPersonAgent(options: PersonChatAgentOptions) {
  let originMessages: PersonTaskOrigin['messages'] = []
  const registry = new AgentToolRegistry()
  for (const tool of options.tools) registry.register({ definition: { name: tool.name, description: tool.description, parameters: tool.parameters }, async execute(args, context = {}) {
    options.beforeRequest?.()
    if (context.signal?.aborted) throw context.signal.reason || new Error('Cancelled')
    if (tool.name === 'bot_decision_request' && !context.requestUserClarification) throw new Error('User clarification is unavailable in this chat')
    const value = tool.name === 'bot_decision_request'
      ? { response: await context.requestUserClarification?.({ clarifyId: randomUUID(), question: String(args.question || ''),
          choices: Array.isArray(args.choices) ? args.choices.map(String).slice(0, 5) : [], timeoutMs: 30 * 60_000 }) || '',
          instruction: 'Only an actual user response supplies a decision. An empty response is not approval.' }
      : await tool.execute(args, context.sessionId ? { sessionId: context.sessionId, runId: context.runId || '', messages: originMessages } : undefined)
    const content = JSON.stringify(value)
    if (content.length > 18000) throw new Error('Tool result too large; request a smaller page')
    return { ok: true, content }
  } })
  const runtime = new AgentRuntime({ tools: registry, systemPrompt: options.systemPrompt,
    skillsEnabled: false, backgroundDelegationEnabled: false, maxSteps: options.maxSteps, maxModelRetries: 1, modelDefaults: { maxTokens: 2048 } })
  const isolated = (input: AgentRuntimeRunInput): AgentRuntimeRunInput => ({ ...input,
    modelClient: input.modelClient ? personBudgetedClient(input.modelClient, { ...options, messages: [], signal: input.signal || new AbortController().signal }) : undefined,
    memoryEnabled: false, memoryInput: undefined, skillReviewEnabled: false, backgroundDelegationEnabled: false,
    ephemeralContext: true, contextKey: undefined,
  })
  return {
    sessionWorkspaceDirectory: () => options.workspace,
    requestBoundaryInterrupt: (request: AgentRuntimeBoundaryInterruptRequest) => runtime.requestBoundaryInterrupt(request),
    estimateContext: (input: AgentRuntimeRunInput) => runtime.estimateContext(isolated(input)),
    run: (input: AgentRuntimeRunInput) => {
      originMessages = structuredClone(input.messages) as PersonTaskOrigin['messages']
      return runtime.run(isolated(input))
    },
  }
}
