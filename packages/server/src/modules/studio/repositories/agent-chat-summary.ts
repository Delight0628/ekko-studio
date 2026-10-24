import type { DatabaseSync } from 'node:sqlite'
import type { RunUsageSummary } from '../contracts/runs/run-usage'
import { MESSAGES_TABLE } from '../infrastructure/database/schemas'

export interface AgentChatUsage {
  modelCalls: number; unknownModelCalls: number
  inputTokens: number | null; outputTokens: number | null
  cacheReadTokens: number | null; cacheWriteTokens: number | null; reasoningTokens: number | null
  costUsd: number | null; estimatedCost: boolean
}
export interface AgentChatSummary {
  agent_instance_id: string
  agent_instance_revision: number
  agent_usage: AgentChatUsage
  model: string; workspace: string | null; agent_mode: string
}

function available(db: DatabaseSync): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='studio_agent_chat_bindings'").get()
}
export function agentChatOwnerFilter(db: DatabaseSync, ownerId?: string): { sql: string; params: string[] } | undefined {
  if (ownerId === undefined || !available(db)) return
  return { sql: `(NOT EXISTS (SELECT 1 FROM studio_agent_chat_bindings b WHERE b.session_id=s.id)
    OR EXISTS (SELECT 1 FROM studio_agent_chat_bindings b JOIN studio_agent_instances i ON i.id=b.instance_id
      WHERE b.session_id=s.id AND b.owner_id=? AND s.studio_user_id=b.owner_id AND i.owner_id=b.owner_id
        AND i.profile_id=b.profile_id AND COALESCE(NULLIF(s.profile,''),'default')=b.profile_id AND s.source=b.source AND s.agent=i.agent_type_id))`, params: [ownerId] }
}
const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'costUsd'] as const
// Host model usage normalizes input into disjoint uncached/read/write buckets.
// Runtime reports currently expose only their aggregate input counter.
const valueSql = (field: typeof fields[number]) => field === 'inputTokens'
  ? `CASE WHEN json_extract(u.value_json,'$.source')='host' THEN json_extract(u.value_json,'$.inputTokens')+json_extract(u.value_json,'$.cacheReadTokens')+json_extract(u.value_json,'$.cacheWriteTokens') ELSE json_extract(u.value_json,'$.inputTokens') END`
  : `json_extract(u.value_json,'$.${field}')`
const metrics = `count(u.call_id) AS modelCalls, sum(CASE WHEN u.call_id IS NOT NULL AND ((${valueSql('inputTokens')}) IS NULL OR json_extract(u.value_json, '$.outputTokens') IS NULL) THEN 1 ELSE 0 END) AS unknownModelCalls,
  ${fields.map(field => `CASE WHEN count(u.call_id)>0 AND count(${valueSql(field)}) = count(u.call_id) THEN total(${valueSql(field)}) END AS ${field}`).join(', ')},
  max(CASE WHEN json_extract(u.value_json, '$.costSource')='estimated' THEN 1 ELSE 0 END) AS estimatedCost`
function usage(row?: Record<string, unknown>): AgentChatUsage {
  const result: Record<string, unknown> = { modelCalls: Number(row?.modelCalls || 0), unknownModelCalls: Number(row?.unknownModelCalls || 0), estimatedCost: !!row?.estimatedCost }
  for (const field of fields) {
    const value = row?.[field]
    result[field] = typeof value === 'number' && Number.isFinite(value) && value >= 0 && (field === 'costUsd' || Number.isSafeInteger(value)) ? value : null
  }
  return result as unknown as AgentChatUsage
}

/** Read projections only: model-call revisions remain owned by canonical Run
 * accounting, never copied into the old vendor usage ledger. */
export function readAgentChatSummaries(db: DatabaseSync, sessionIds: string[]): Record<string, AgentChatSummary> {
  if (!sessionIds.length || !available(db)) return {}
  const ids = [...new Set(sessionIds)], placeholders = ids.map(() => '?').join(',')
  const bindings = db.prepare(`SELECT b.session_id, b.instance_id, i.revision, i.mode,
    json_extract(i.config_json,'$.model') AS model, json_extract(i.config_json,'$.cwd') AS workspace
    FROM studio_agent_chat_bindings b JOIN studio_agent_instances i ON i.id=b.instance_id WHERE b.session_id IN (${placeholders})`).all(...ids)
  const totals = db.prepare(`SELECT t.session_id, ${metrics} FROM studio_agent_run_targets t JOIN studio_agent_usage u ON u.run_id=t.run_id
    WHERE t.session_id IN (${placeholders}) GROUP BY t.session_id`).all(...ids)
  const byId = new Map(totals.map(row => [String(row.session_id), row]))
  return Object.fromEntries(bindings.map(row => [String(row.session_id), { agent_instance_id: String(row.instance_id), agent_instance_revision: Number(row.revision),
    agent_mode: String(row.mode), model: typeof row.model === 'string' ? row.model : '', workspace: typeof row.workspace === 'string' ? row.workspace : null,
    agent_usage: usage(byId.get(String(row.session_id))) }]))
}

export function readAgentChatRunSummaries(db: DatabaseSync, sessionId: string, assistantIds: string[]): RunUsageSummary[] {
  if (!assistantIds.length || !available(db)) return []
  const rows = db.prepare(`SELECT p.run_id, m.id, ${metrics} FROM studio_agent_chat_messages p JOIN ${MESSAGES_TABLE} m ON m.id=p.message_id
    JOIN studio_agent_run_targets t ON t.run_id=p.run_id LEFT JOIN studio_agent_usage u ON u.run_id=p.run_id
    WHERE m.session_id=? AND t.session_id=m.session_id AND p.kind IN ('message','tool-call') AND m.id IN (${assistantIds.map(() => '?').join(',')})
    AND m.id=(SELECT max(last.message_id) FROM studio_agent_chat_messages last WHERE last.run_id=p.run_id AND last.kind IN ('message','tool-call'))
    GROUP BY p.run_id, m.id`).all(sessionId, ...assistantIds)
  return rows.map(row => {
    const value = usage(row)
    return { runId: String(row.run_id), assistantMessageId: String(row.id), inputTokens: value.inputTokens, outputTokens: value.outputTokens,
      cacheReadTokens: value.cacheReadTokens, cacheHitRate: value.inputTokens != null && value.inputTokens > 0 && value.cacheReadTokens != null ? value.cacheReadTokens / value.inputTokens : null,
      costUsd: value.costUsd, tokensPerSecond: null, speedSource: null, isEstimated: value.estimatedCost }
  })
}
