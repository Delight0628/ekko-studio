import { StudioError, type ExecutionContext, type ExecutionScope, type ScopedLogger, type StudioDomainServices } from '../../contracts/plugins'
import { jsonCopy } from '../plugins/validation'

export type ContextOperation = 'sessions.read' | 'sessions.remove' | 'agents.read' | 'runs.read'

export interface ContextServices {
  authorize(scope: ExecutionScope, operation: ContextOperation, resourceId?: string): Promise<void>
  sessions: {
    get: StudioDomainServices['sessions']['get']
    remove?(scope: ExecutionScope, id: string, signal: AbortSignal): ReturnType<StudioDomainServices['sessions']['remove']>
  }
  agents: { list(profileId: string): ReturnType<StudioDomainServices['agents']['list']> }
  runs?: {
    get(scope: ExecutionScope, id: string): ReturnType<StudioDomainServices['runs']['get']>
    output(scope: ExecutionScope, id: string, after: number): ReturnType<StudioDomainServices['runs']['output']>
  }
}

/** Only trusted entrypoints create scopes. Plugins receive this object or an RPC proxy. */
export function createExecutionContext(
  input: ExecutionScope, signal: AbortSignal, logger: ScopedLogger, services: ContextServices,
): ExecutionContext {
  const scope = jsonCopy(input)
  Object.freeze(scope.principal)
  Object.freeze(scope)
  const call = async <T>(operation: ContextOperation, resourceId: string | undefined, execute: () => Promise<T>, mutation = false): Promise<T> => {
    if (signal.aborted) throw new StudioError('CANCELLED', 'Execution scope has ended')
    await services.authorize(scope, operation, resourceId)
    if (signal.aborted) throw new StudioError('CANCELLED', 'Execution scope has ended')
    const result = await execute()
    if (signal.aborted && !mutation) throw new StudioError('CANCELLED', 'Execution scope has ended')
    return jsonCopy(result)
  }
  const sessionId = (id: string): void => {
    if (typeof id !== 'string' || !id.trim() || id.length > 256) throw new StudioError('INVALID_ARGUMENT', 'Invalid session id')
    if (scope.sessionId && scope.sessionId !== id) throw new StudioError('FORBIDDEN', 'Session is outside the execution scope')
  }
  const runId = (id: string): void => {
    if (typeof id !== 'string' || !id || id.length > 256) throw new StudioError('INVALID_ARGUMENT', 'Invalid run id')
    if (scope.runId && scope.runId !== id) throw new StudioError('FORBIDDEN', 'Run is outside the execution scope')
    if (!services.runs) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Run services are unavailable in this host')
  }
  return Object.freeze({
    scope, signal, logger,
    sessions: Object.freeze({
      get: async (id: string) => { sessionId(id); return call('sessions.read', id, () => services.sessions.get(id)) },
      remove: async (id: string) => {
        sessionId(id)
        if (!services.sessions.remove) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Session removal is unavailable in this host')
        return call('sessions.remove', id, () => services.sessions.remove!(scope, id, signal), true)
      },
    }),
    agents: Object.freeze({ list: () => call('agents.read', undefined, () => services.agents.list(scope.profileId)) }),
    runs: Object.freeze({
      get: async (id: string) => { runId(id); return call('runs.read', id, () => services.runs!.get(scope, id)) },
      output: async (id: string, after = -1) => {
        runId(id)
        if (!Number.isSafeInteger(after) || after < -1) throw new StudioError('INVALID_ARGUMENT', 'Invalid output cursor')
        return call('runs.read', id, () => services.runs!.output(scope, id, after))
      },
    }),
  })
}
