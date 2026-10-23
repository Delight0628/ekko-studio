import { StudioError, type ExecutionContext, type ExecutionScope, type ScopedLogger, type StudioDomainServices } from '../../contracts/plugins'
import { jsonCopy } from '../plugins/validation'

export type ContextOperation = 'sessions.read' | 'agents.read' | 'runs.read'

export interface ContextServices {
  authorize(scope: ExecutionScope, operation: ContextOperation, resourceId?: string): Promise<void>
  sessions: StudioDomainServices['sessions']
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
  const call = async <T>(operation: ContextOperation, resourceId: string | undefined, execute: () => Promise<T>): Promise<T> => {
    if (signal.aborted) throw new StudioError('CANCELLED', 'Execution scope has ended')
    await services.authorize(scope, operation, resourceId)
    if (signal.aborted) throw new StudioError('CANCELLED', 'Execution scope has ended')
    const result = await execute()
    if (signal.aborted) throw new StudioError('CANCELLED', 'Execution scope has ended')
    return jsonCopy(result)
  }
  const runId = (id: string): void => {
    if (typeof id !== 'string' || !id || id.length > 256) throw new StudioError('INVALID_ARGUMENT', 'Invalid run id')
    if (scope.runId && scope.runId !== id) throw new StudioError('FORBIDDEN', 'Run is outside the execution scope')
    if (!services.runs) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Run services are unavailable in this host')
  }
  return Object.freeze({
    scope, signal, logger,
    sessions: Object.freeze({ get: (id: string) => {
      if (typeof id !== 'string' || !id || id.length > 256) return Promise.reject(new StudioError('INVALID_ARGUMENT', 'Invalid session id'))
      return call('sessions.read', id, () => services.sessions.get(id))
    } }),
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
