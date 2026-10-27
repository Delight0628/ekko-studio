import { personMemories } from './memory'
import { ensurePersonSession, personChatBusy } from './chat-agent'
import { personError, personRevision, personText } from '../../contracts/person'
import { personSettings, savePersonSettings,
  listPersonTasks, listPersonSchedules, personInteractions } from '../../repositories/person-store'
import { effectivePersonSettings, personModelSelection, personUser, validatePersonSelection, PERSON_REASONING_EFFORTS } from './catalog'
import { validatePersonAgents } from './agents'

export async function personSnapshot(userId: number) {
  personUser(userId)
  return { ...await ensurePersonSession(userId), tasks: listPersonTasks(userId), memories: await personMemories(userId),
    schedules: listPersonSchedules(userId), interactions: personInteractions(userId), busy: personChatBusy(userId) }
}
export async function configurePerson(userId: number, input: Record<string, unknown>) {
  if (personChatBusy(userId)) throw personError('Wait for the current reply before changing settings', 409)
  const old = personSettings(userId)
  const settings = { ...old.settings }
  if (input.model && typeof input.model === 'object' && !Array.isArray(input.model)) {
    settings.model = await personModelSelection(userId, input.model as Record<string, unknown>)
    await validatePersonSelection(userId, settings.model)
  }
  if (input.use_global_default === true) settings.model = null
  if (input.reasoning_effort !== undefined) {
    if (typeof input.reasoning_effort !== 'string' || (input.reasoning_effort !== '' && !PERSON_REASONING_EFFORTS.includes(input.reasoning_effort as any))) throw personError('Invalid reasoning effort')
    settings.reasoningEffort = input.reasoning_effort
  }
  const effective = await effectivePersonSettings(userId, { ...old, settings })
  if (input.reasoning_effort && !effective.reasoning_efforts.includes(input.reasoning_effort as any)) throw personError('Model does not support this reasoning effort')
  settings.reasoningEffort = effective.settings.reasoningEffort
  if (input.timezone !== undefined) { settings.timezone = personText(input.timezone, 'timezone', 100); new Intl.DateTimeFormat('en-US', { timeZone: settings.timezone }) }
  if (input.agents !== undefined) settings.agents = await validatePersonAgents(userId, input.agents)
  for (const [key, min, max] of [['maxSteps', 2, 30], ['contextTokens', 8000, 64000], ['maxConcurrentTasks', 1, 4]] as const) {
    if (input[key] !== undefined) {
      const value = input[key]
      if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw personError(`Invalid ${key}`)
      settings[key] = Number(value)
    }
  }
  return effectivePersonSettings(userId, savePersonSettings(userId, settings, personRevision(input.expected_revision)))
}
// Service facade for the thin HTTP controller.
export { withPersonTaskReturns } from '../../repositories/person-return-store'
export { listPersonTasks, taskPersonExecutions, personEvents } from '../../repositories/person-store'
