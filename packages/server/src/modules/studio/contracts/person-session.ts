export const personTaskSessionId = (taskId: string) => `person-task-${taskId}`

/** Account identity is independent of the Profile used to execute a model call. */
export const personSessionId = (userId: number) => `person-main-${userId}`
export const isPersonSession = (id?: string | null) => !!id?.startsWith('person-main-')
export const isPrivatePersonSession = (id?: string | null) => isPersonSession(id) || !!id?.startsWith('person-task-')
export function ownsPersonSession(userId: number | undefined, session: { id: string; studio_user_id?: string | number | null } | null | undefined) {
  return userId !== undefined && !!session && session.id === personSessionId(userId) && String(session.studio_user_id) === String(userId)
}
