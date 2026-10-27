import { randomUUID } from 'node:crypto'
import { AgentRuntime, AgentToolRegistry, countTextTokens } from '../../../ekko-agent/src'
import type { AgentRuntimeRunInput, AgentRuntimeBoundaryInterruptRequest, AgentRuntimeContextEstimate } from '../../../ekko-agent/src/runtime/types'
import type { ModelRequest } from '../../../ekko-agent/src/model/types'
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
  const estimate = (request: ModelRequest): AgentRuntimeContextEstimate => {
    const systems = request.messages.filter(m => m.role === 'system')
    return { contextTokens: Math.ceil(countTextTokens(JSON.stringify({ messages: request.messages, tools: request.tools })) * 1.15),
      systemPromptTokens: countTextTokens(JSON.stringify(systems)), toolTokens: countTextTokens(JSON.stringify(request.tools || [])),
      messageTokens: countTextTokens(JSON.stringify(request.messages.filter(m => m.role !== 'system'))), modelContextTokens: 0,
      messageCount: request.messages.length, toolCount: request.tools?.length || 0, systemPromptChars: systems.reduce((n,m) => n+m.content.length,0) }
  }
  const isolated = (input: AgentRuntimeRunInput, onPrepared?: (request: ModelRequest) => void): AgentRuntimeRunInput => ({ ...input,
    modelClient: input.modelClient ? personBudgetedClient(input.modelClient, { ...options, onPrepared, messages: [], signal: input.signal || new AbortController().signal }) : undefined,
    memoryEnabled: false, memoryInput: undefined, skillReviewEnabled: false, backgroundDelegationEnabled: false,
    ephemeralContext: true, contextKey: undefined,
  })
  return {
    sessionWorkspaceDirectory: () => options.workspace,
    requestBoundaryInterrupt: (request: AgentRuntimeBoundaryInterruptRequest) => runtime.requestBoundaryInterrupt(request),
    estimateContext: (input: AgentRuntimeRunInput) => runtime.estimateContext(isolated(input)),
    run: async (input: AgentRuntimeRunInput) => {
      const current = input.messages.findLast(message => typeof message === 'string' || message.role === 'user')
      const query = typeof current === 'string' ? current : current?.content || ''
      const messages = [...(options.loadHistory?.(String(query)) || []), ...input.messages]
      originMessages = structuredClone(messages) as PersonTaskOrigin['messages']
      let latest: AgentRuntimeContextEstimate | undefined
      let runId = '', step = 0
      const result = await runtime.run(isolated({ ...input, messages, onEvent: event => {
        if ('runId' in event) runId = event.runId
        if ('step' in event) step = event.step
        // The runtime estimates before the provider wrapper selects/compacts messages.
        if (event.type !== 'context.estimated') return input.onEvent?.(event)
      } }, request => {
        latest = estimate(request)
        input.onEvent?.({ type: 'context.estimated', runId, step, estimate: latest })
      }))
      return { ...result, contextEstimate: latest || result.contextEstimate }
    },
  }
}
