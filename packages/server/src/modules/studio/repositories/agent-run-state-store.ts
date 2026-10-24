import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { StudioError, type AgentInteraction, type AgentInteractionResponse, type AgentOutputEvent, type AgentUsage, type AgentProviderRef, type JsonValue } from '../contracts/plugins'

/** Projections share the output/terminal transaction owned by AgentExecutionStore. */
export class AgentRunStateStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS studio_agent_usage (
      run_id TEXT NOT NULL, call_id TEXT NOT NULL, value_json TEXT NOT NULL, event_json TEXT NOT NULL,
      PRIMARY KEY(run_id, call_id)
    ); CREATE TABLE IF NOT EXISTS studio_agent_interactions (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, request_id TEXT NOT NULL, value_json TEXT NOT NULL,
      response_json TEXT, UNIQUE(run_id, request_id)
    ); CREATE TABLE IF NOT EXISTS studio_agent_checkpoints (
      instance_id TEXT PRIMARY KEY, provider_json TEXT NOT NULL, config_revision INTEGER NOT NULL,
      run_id TEXT NOT NULL, value_json TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS studio_agent_runtime_leases (
      id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, provider_json TEXT NOT NULL, config_revision INTEGER NOT NULL,
      status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ); CREATE TABLE IF NOT EXISTS studio_agent_run_leases (
      run_id TEXT PRIMARY KEY, lease_id TEXT NOT NULL
    );`)
  }

  project(runId: string, event: AgentOutputEvent): void {
    if (event.type === 'usage.reported') {
      const previous = this.db.prepare('SELECT value_json, event_json FROM studio_agent_usage WHERE run_id=? AND call_id=?')
        .get(runId, event.modelCallId) as { value_json: string; event_json: string } | undefined
      const old = previous ? JSON.parse(previous.value_json) as AgentUsage : undefined
      // Producer sequence belongs to transport, not the model-call revision.
      const value = { modelCallId: event.modelCallId, model: event.model, mode: event.mode, revision: event.revision, inputTokens: event.inputTokens, outputTokens: event.outputTokens }
      if (old && old.model !== event.model) throw new StudioError('INVALID_ARGUMENT', 'Model call identity changed')
      if (old && event.revision < old.revision) return
      if (old && event.revision === old.revision) {
        if (JSON.stringify(value) !== previous!.event_json) throw new StudioError('REVISION_CONFLICT', 'Conflicting usage revision')
        return
      }
      if (old?.final && event.mode !== 'final') throw new StudioError('REVISION_CONFLICT', 'Final usage requires an explicit final correction')
      const inputTokens = event.inputTokens + (event.mode === 'delta' ? old?.inputTokens || 0 : 0)
      const outputTokens = event.outputTokens + (event.mode === 'delta' ? old?.outputTokens || 0 : 0)
      if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)) throw new StudioError('INVALID_ARGUMENT', 'Usage exceeds numeric limits')
      const usage: AgentUsage = { modelCallId: event.modelCallId, model: event.model, revision: event.revision, inputTokens, outputTokens, final: event.mode === 'final' }
      this.db.prepare('INSERT INTO studio_agent_usage VALUES (?, ?, ?, ?) ON CONFLICT(run_id, call_id) DO UPDATE SET value_json=excluded.value_json, event_json=excluded.event_json')
        .run(runId, event.modelCallId, JSON.stringify(usage), JSON.stringify(value))
    }
    if (event.type === 'interaction.requested') {
      if (new Set(event.choices.map(choice => choice.id)).size !== event.choices.length || (event.kind === 'approval' && !event.choices.length)) {
        throw new StudioError('INVALID_ARGUMENT', 'Interaction choices must have unique ids')
      }
      if (this.interactions(runId).some(item => item.requestId === event.requestId)) throw new StudioError('REVISION_CONFLICT', 'Interaction request already exists')
      const interaction: AgentInteraction = { id: randomUUID(), runId, requestId: event.requestId, kind: event.kind,
        prompt: event.prompt, choices: event.choices, expiresAt: event.expiresAt ?? null, status: 'pending' }
      this.db.prepare('INSERT INTO studio_agent_interactions (id, run_id, request_id, value_json) VALUES (?, ?, ?, ?)')
        .run(interaction.id, runId, event.requestId, JSON.stringify(interaction))
    }
  }

  usage(runId: string): AgentUsage[] {
    return (this.db.prepare('SELECT value_json FROM studio_agent_usage WHERE run_id=? ORDER BY call_id').all(runId) as Array<{ value_json: string }>).map(row => JSON.parse(row.value_json))
  }
  interactions(runId: string): AgentInteraction[] {
    return (this.db.prepare('SELECT value_json FROM studio_agent_interactions WHERE run_id=? ORDER BY rowid').all(runId) as Array<{ value_json: string }>).map(row => JSON.parse(row.value_json))
  }
  claimResponse(runId: string, input: AgentInteractionResponse): { interaction: AgentInteraction; dispatch: boolean } {
    const row = this.db.prepare('SELECT value_json, response_json FROM studio_agent_interactions WHERE id=? AND run_id=?')
      .get(input.interactionId, runId) as { value_json: string; response_json: string | null } | undefined
    if (!row) throw new StudioError('NOT_FOUND', 'Interaction is unavailable')
    const interaction = JSON.parse(row.value_json) as AgentInteraction
    const response = JSON.stringify({ idempotencyKey: input.idempotencyKey, choiceId: input.choiceId ?? null, text: input.text ?? null })
    if (row.response_json) {
      if (row.response_json !== response) throw new StudioError('REVISION_CONFLICT', 'Interaction already has a different response')
      return { interaction, dispatch: false }
    }
    if (interaction.status !== 'pending') throw new StudioError('REVISION_CONFLICT', 'Interaction is no longer pending')
    if (interaction.expiresAt !== null && interaction.expiresAt <= Date.now()) {
      this.setInteraction(interaction, 'expired')
      throw new StudioError('DEADLINE_EXCEEDED', 'Interaction has expired')
    }
    if (input.choiceId !== undefined && !interaction.choices.some(choice => choice.id === input.choiceId)) throw new StudioError('INVALID_ARGUMENT', 'Unknown interaction choice')
    if (interaction.kind === 'approval' && (input.choiceId === undefined || input.text !== undefined)) throw new StudioError('INVALID_ARGUMENT', 'Approval requires one declared choice')
    if (input.choiceId === undefined && !input.text?.trim()) throw new StudioError('INVALID_ARGUMENT', 'Interaction response is empty')
    interaction.status = 'responding'
    this.db.prepare('UPDATE studio_agent_interactions SET value_json=?, response_json=? WHERE id=?').run(JSON.stringify(interaction), response, interaction.id)
    return { interaction, dispatch: true }
  }
  setInteraction(interaction: AgentInteraction, status: AgentInteraction['status']): AgentInteraction {
    const current = this.interactions(interaction.runId).find(item => item.id === interaction.id)
    if (!current || !['pending', 'responding'].includes(current.status)) return current || interaction
    const value = { ...current, status }
    this.db.prepare('UPDATE studio_agent_interactions SET value_json=? WHERE id=?').run(JSON.stringify(value), value.id)
    return value
  }
  endInteractions(runId: string): void {
    for (const interaction of this.interactions(runId)) this.setInteraction(interaction, 'interrupted')
  }

  openLease(instanceId: string, provider: AgentProviderRef, configRevision: number): string {
    const id = randomUUID(), now = Date.now()
    this.db.prepare("INSERT INTO studio_agent_runtime_leases VALUES (?, ?, ?, ?, 'active', ?, ?)").run(id, instanceId, JSON.stringify(provider), configRevision, now, now)
    return id
  }
  bindLease(runId: string, leaseId: string): void {
    this.db.prepare('INSERT INTO studio_agent_run_leases VALUES (?, ?)').run(runId, leaseId)
  }
  closeLease(id: string): void {
    this.db.prepare("UPDATE studio_agent_runtime_leases SET status='closed', updated_at=? WHERE id=?").run(Date.now(), id)
  }
  recover(): void {
    this.db.prepare("UPDATE studio_agent_runtime_leases SET status='closed', updated_at=? WHERE status='active'").run(Date.now())
  }
  saveCheckpoint(instanceId: string, provider: AgentProviderRef, configRevision: number, runId: string, value: JsonValue): void {
    this.db.prepare('INSERT INTO studio_agent_checkpoints VALUES (?, ?, ?, ?, ?) ON CONFLICT(instance_id) DO UPDATE SET provider_json=excluded.provider_json, config_revision=excluded.config_revision, run_id=excluded.run_id, value_json=excluded.value_json')
      .run(instanceId, JSON.stringify(provider), configRevision, runId, JSON.stringify(value))
  }
  checkpoint(instanceId: string, provider: AgentProviderRef, configRevision: number): JsonValue | undefined {
    const row = this.db.prepare('SELECT value_json FROM studio_agent_checkpoints WHERE instance_id=? AND provider_json=? AND config_revision=?')
      .get(instanceId, JSON.stringify(provider), configRevision) as { value_json: string } | undefined
    return row ? JSON.parse(row.value_json) as JsonValue : undefined
  }
}
