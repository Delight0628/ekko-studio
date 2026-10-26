import type { SessionSummary } from './studio/sessions'
import { request } from './client'
import type { AvailableModelGroup } from './hermes/system'
export interface PersonModel { profile: string; provider: string; model: string }
export interface PersonModelGroup extends Pick<AvailableModelGroup, 'provider' | 'label' | 'models' | 'model_meta'> { profile: string }
export interface PersonCandidate { selection_ref: string; model: string; provider: string; profile: string; label: string }
export interface PersonTask { id: string; title: string; summary: string; status: string; revision: number; execution_state: string; completion_evidence: string }
export interface PersonSchedule { id: string; task_id: string; expression: string; timezone: string; next_at: number; state: string; revision: number }
export interface PersonMemory { id: string; content: string; revision: number }
export interface PersonQuestion { id: string; task_id: string | null; question: string; kind: string; choices_json: string; revision: number }
export interface PersonSnapshot {
  session: SessionSummary
  settings: { model: PersonModel | null; reasoningEffort: string; timezone: string }; revision: number; busy: boolean
  inherits_global_model: boolean; reasoning_efforts: string[]
  tasks: PersonTask[]; schedules: PersonSchedule[]; memories: PersonMemory[]; interactions: PersonQuestion[]
}
export function personRequest<T>(path = '', body?: unknown, method = 'POST', signal?: AbortSignal) {
  return request<T>(`/api/studio/person${path}`, body === undefined ? { signal } : { method, body: JSON.stringify(body), signal })
}
