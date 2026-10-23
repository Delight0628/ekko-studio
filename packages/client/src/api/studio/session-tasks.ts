import { request } from '@/api/client'

export interface SessionTaskListItem {
  id: string
  session_id: string
  session_title: string | null
  profile: string
  source: string
  agent: string
  title: string
  summary: string
  status: 'open' | 'completed'
  updated_at: number
  message_id: number | null
}

export interface SessionTaskListPage {
  tasks: SessionTaskListItem[]
  total: number
  has_more: boolean
}

export function fetchSessionTasks(query: { search: string; status: string; order: string; page: number }) {
  // An explicit empty profile lists all profiles available to this account.
  const params = new URLSearchParams({ profile: '', order: query.order,
    offset: String((query.page - 1) * 50), limit: '50' })
  if (query.search) params.set('search', query.search)
  if (query.status) params.set('status', query.status)
  return request<SessionTaskListPage>(`/api/studio/session-tasks?${params}`)
}
