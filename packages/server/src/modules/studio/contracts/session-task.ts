/** User goals persist across turns; they are independent of run task plans. */
export interface SessionTask {
  id: string
  title: string
  summary: string
  status: 'open' | 'completed'
  source_message_id: number
  evidence_message_id: number | null
  completion_evidence: string
  created_at: number
  updated_at: number
  completed_at: number | null
}

export interface SessionTasksSnapshot {
  session_id: string
  revision: number
  updated_at: number
  tasks: SessionTask[]
}

export interface SessionTaskChange {
  id?: string
  title: string
  summary: string
  status: 'open' | 'completed'
  completion_evidence?: string
}

export interface SessionTasksUpdate {
  revision: number
  changes: SessionTaskChange[]
}
