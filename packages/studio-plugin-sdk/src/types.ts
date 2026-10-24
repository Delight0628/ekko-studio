export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject
export interface JsonObject { [key: string]: JsonValue }
export type JsonSchema = JsonObject | boolean
export type Disposer = () => void | Promise<void>

export type AgentProviderRef =
  | { kind: 'builtin'; module: 'hermes' | 'ekko'; implementationVersion: string }
  | { kind: 'plugin'; pluginId: string; version: string; generation: string }

export type PluginInstallationPolicy =
  | { kind: 'system'; removable: false }
  | { kind: 'user'; removable: true }

export interface PluginIdentity {
  readonly id: string
  readonly version: string
  readonly generation: string
  readonly profileId: string
}

export interface ExecutionScope {
  readonly scopeId: string
  readonly principal: { readonly id: string; readonly kind: 'user' | 'service' }
  readonly profileId: string
  readonly workspaceId?: string
  readonly sessionId?: string
  readonly runId?: string
  readonly surface: 'chat' | 'group-chat' | 'workflow' | 'global-agent' | 'api' | 'job' | 'event'
  readonly traceId: string
}

export interface ScopedLogger {
  info(message: string, data?: JsonObject): void
  warn(message: string, data?: JsonObject): void
  error(message: string, data?: JsonObject): void
}

export interface SessionSummary {
  id: string
  profileId: string
  title: string | null
  agentTypeId: string
  archived: boolean
}

export interface SessionRemovalResult {
  /** Whether a Studio record was removed; native-only history is reported separately. */
  deleted: boolean
  native: { attempted: boolean; deleted: boolean; profileId: string; error?: string }
}

export interface StudioDomainServices {
  readonly chat: {
    start(input: ChatRunStartInput): Promise<ChatRunReceipt>
    get(id: string): Promise<ChatRunRecord>
    cancel(id: string): Promise<ChatRunReceipt>
  }
  readonly sessions: {
    get(id: string): Promise<SessionSummary | null>
    remove(id: string): Promise<SessionRemovalResult>
  }
  readonly agents: {
    list(): Promise<AgentTypeSummary[]>
  }
  readonly runs: {
    start(input: AgentRunStartInput): Promise<AgentRunRecord>
    get(id: string): Promise<AgentRunRecord>
    output(id: string, after?: number): Promise<AgentOutputEvent[]>
    cancel(id: string): Promise<AgentRunRecord>
    interactions(id: string): Promise<AgentInteraction[]>
    respond(id: string, input: AgentInteractionResponse): Promise<AgentInteractionReceipt>
    usage(id: string): Promise<AgentUsage[]>
  }
}

/** Continue an owned chat using its stored Agent/model configuration. */
export interface ChatRunStartInput {
  sessionId: string
  input: string
  idempotencyKey: string
}

/** Host receipt, distinct from the underlying runtime's run id. */
export interface ChatRunRecord {
  id: string
  sessionId: string
  profileId: string
  ownerId: string
  status: AgentRunStatus | 'queued' | 'waiting_input'
  output: string
  reasoning: string
  truncated: boolean
  revision: number
  createdAt: number
  updatedAt: number
  errorCode: string | null
}

/** Mutation receipts contain no text; reading output always requires chat.read. */
export type ChatRunReceipt = Omit<ChatRunRecord, 'output' | 'reasoning' | 'truncated'>

export interface ExecutionContext extends StudioDomainServices {
  readonly scope: ExecutionScope
  readonly signal: AbortSignal
  readonly logger: ScopedLogger
}

export interface AgentCapabilities {
  text: boolean
  images?: boolean
  files?: boolean
  streaming?: boolean
  reasoning?: boolean
  resume?: boolean
  persistentSession?: boolean
  compact?: boolean
  approvals?: boolean
  clarifications?: boolean
  steering?: boolean
  modes: Array<'scoped' | 'global'>
}

export interface AgentTypeSummary {
  id: string
  name: string
  description?: string
  configSchema: JsonSchema
  capabilities: AgentCapabilities
  provider: AgentProviderRef
}

export interface AgentRuntimeContext {
  readonly provider: AgentProviderRef
  readonly runtimeSessionId: string
  readonly profileId: string
  readonly signal: AbortSignal
  readonly logger: ScopedLogger
}

export interface AgentRunContext extends ExecutionContext {
  readonly scope: ExecutionScope & { readonly runId: string; readonly runtimeSessionId: string }
}

export interface RuntimeCreateInput {
  instanceId: string
  config: JsonObject
  configRevision: number
  mode: 'scoped' | 'global'
  workspaceId?: string
  resume?: JsonValue
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image' | 'file'; artifactId: string; mediaType: string }

export interface AgentRunInput {
  content: ContentBlock[]
  model?: string
  timeoutMs?: number
}

/** Start an independent instance run. Identity and execution scope are supplied by the host. */
export interface AgentRunStartInput {
  instanceId: string
  input: AgentRunInput
  idempotencyKey: string
}

export type AgentOutputEvent =
  | { type: 'message.delta'; producerSequence: number; messageId: string; text: string }
  | { type: 'message.snapshot'; producerSequence: number; messageId: string; text: string }
  | { type: 'reasoning.delta'; producerSequence: number; messageId: string; text: string }
  | { type: 'tool.started' | 'tool.completed' | 'tool.failed'; producerSequence: number; callId: string; name: string; data: JsonValue }
  | { type: 'usage.reported'; producerSequence: number; modelCallId: string; model: string; mode: 'delta' | 'cumulative' | 'final'; revision: number; inputTokens: number; outputTokens: number }
  | { type: 'checkpoint.updated'; producerSequence: number; value: JsonValue }
  | { type: 'interaction.requested'; producerSequence: number; requestId: string; kind: 'approval' | 'clarification'; prompt: string; choices: Array<{ id: string; label: string }>; expiresAt?: number }
  | { type: 'diagnostic'; producerSequence: number; message: string }

export interface AgentInteraction {
  id: string
  runId: string
  requestId: string
  kind: 'approval' | 'clarification'
  prompt: string
  choices: Array<{ id: string; label: string }>
  expiresAt: number | null
  status: 'pending' | 'responding' | 'resolved' | 'expired' | 'interrupted'
}

export interface AgentInteractionResponse {
  interactionId: string
  idempotencyKey: string
  choiceId?: string
  text?: string
}

/** Responding does not grant permission to read the interaction's private content. */
export type AgentInteractionReceipt = Pick<AgentInteraction, 'id' | 'runId' | 'status'>

/** A missing model call is unknown usage, never a measured zero. */
export interface AgentUsage {
  modelCallId: string
  model: string
  revision: number
  inputTokens: number
  outputTokens: number
  final: boolean
}

export interface AgentRunResult { status: 'completed' | 'cancelled'; checkpoint?: JsonValue }

export type AgentRunStatus = 'accepted' | 'queued' | 'starting' | 'running' | 'waiting_input' | 'finalizing' | 'cancelling' | 'completed' | 'cancelled' | 'failed' | 'interrupted'
export interface AgentRunRecord {
  id: string
  instanceId: string
  profileId: string
  ownerId: string
  status: AgentRunStatus
  provider: AgentProviderRef
  configRevision: number
  revision: number
  createdAt: number
  updatedAt: number
  errorCode: string | null
}

export interface AgentRunHandle {
  readonly events: AsyncIterable<AgentOutputEvent>
  readonly result: Promise<AgentRunResult>
  cancel(reason: string): Promise<void>
  respond?(input: { requestId: string; choiceId?: string; text?: string }): Promise<void>
}

export interface AgentRuntime {
  run(input: AgentRunInput, ctx: AgentRunContext): Promise<AgentRunHandle>
  checkpoint?(): Promise<JsonValue>
  dispose(reason: string): Promise<void>
}

export interface AgentTypeDefinition {
  id: string
  name: string
  description?: string
  configSchema: JsonSchema
  capabilities: AgentCapabilities
  create(input: RuntimeCreateInput, ctx: AgentRuntimeContext): Promise<AgentRuntime>
}

export interface EventSubject {
  profileId: string
  sessionId?: string
  runId?: string
  pluginId?: string
  agentTypeId?: string
}

export interface StudioEventMap {
  'plugin.ready': { pluginId: string; generation: string }
  'plugin.disabled': { pluginId: string; generation: string }
  'plugin.failed': { pluginId: string; generation: string }
  'agent.available': { agentTypeId: string }
  'agent.unavailable': { agentTypeId: string }
  'run.completed': { runId: string }
  'run.failed': { runId: string }
  'run.cancelled': { runId: string }
  'session.deleted': { sessionId: string }
}

export interface EventEnvelope<T = JsonObject> {
  schemaVersion: 1
  id: string
  type: string
  occurredAt: number
  partitionKey: string
  sequence: number
  subject: EventSubject
  data: T
  correlationId: string
  causationId?: string
}

export type EventHandler<K extends keyof StudioEventMap> =
  (event: EventEnvelope<StudioEventMap[K]>, ctx: ExecutionContext) => void | Promise<void>

export interface PluginManifest {
  schemaVersion: 1
  id: string
  version: string
  engines: { studioSdk: string; rpc: 1 }
  backend: string
  activation: 'profile'
  contributes: { agents: string[]; events?: Record<string, JsonSchema> }
  requires: { capabilities: string[] }
  configSchema?: JsonSchema
}

export interface PluginContext {
  readonly plugin: PluginIdentity
  readonly config: Readonly<JsonObject>
  readonly logger: ScopedLogger
  readonly agents: { register(definition: AgentTypeDefinition): Disposer }
  readonly lifecycle: { onDispose(dispose: Disposer): Disposer }
  on<K extends keyof StudioEventMap>(type: K, handler: EventHandler<K>): Disposer
  once<K extends keyof StudioEventMap>(type: K, handler: EventHandler<K>): Disposer
  emit(type: string, data: JsonObject): Promise<{ id: string }>
}

export interface StudioPlugin { apply(ctx: PluginContext): void | Promise<void> }

export function definePlugin(plugin: StudioPlugin): StudioPlugin { return plugin }
