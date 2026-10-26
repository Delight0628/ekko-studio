import { createHash } from 'node:crypto'
import { findUserById, listUserProfiles, userCanAccessProfile } from '../../repositories/users-store'
import { getActiveProfileName, listProfileNamesFromDisk } from '../../public/profile-config'
import { getAgentAvailabilitySnapshot } from '../../public/agent-status-registry'
import { getSessionAvailableModelGroups } from '../../public/session-agent-runtime'
import { isScopedCodingAgentAuthProvider } from '../../contracts/provider-compat'
import { personRuntime } from '../../public/person-runtime'
import { resolveProviderCatalogApiMode } from '../../contracts/providers'
import { isAgentRuntime } from '../../contracts/agents/runtime'
import { personError } from '../../contracts/person'
import type { PersonSelection, PersonSettings } from '../../contracts/person'
import { personSettings, savePersonSelection } from '../../repositories/person-store'

export const PERSON_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export function personUser(userId: number) {
  const user = findUserById(userId)
  if (!user || user.status !== 'active') throw personError('Account is unavailable', 403)
  return { id: user.id, username: user.username, role: user.role, profiles: listUserProfiles(user.id).map(p => p.profile_name) }
}
export function personProfiles(userId: number) {
  const user = personUser(userId)
  return listProfileNamesFromDisk().filter(p => user.role === 'super_admin' || user.profiles.includes(p)).sort()
}
export function personCapabilities(userId: number) {
  personUser(userId)
  return getAgentAvailabilitySnapshot().agents.map(a => ({
    runtime: a.id === 'ekko-agent' ? 'ekko' : a.id,
    installed: a.installed, status: a.installed ? 'requires_model_selection' : 'not_installed',
    controls: ['start', 'cancel', 'checkpoint_resume'], interaction: 'person',
  }))
}
function apiMode(group: any, model: string): string | undefined {
  return group.api_mode_by_model?.[model] || group.api_mode || resolveProviderCatalogApiMode(group.provider, model)
}

function personModelAllowed(group: any, model: string) {
  return group.provider !== 'moa' && !group.model_meta?.[model]?.disabled
    && !['bedrock_converse', 'codex_app_server'].includes(apiMode(group, model) || '')
}

/** UI catalog only: these groups never enter the model's context or expose credentials. */
export async function personModelCatalog(userId: number) {
  const groups = []
  for (const profile of personProfiles(userId)) {
    const catalog = await personRuntime().modelConfig(profile)
    for (const group of catalog.groups) {
      const models = group.models.filter(model => personModelAllowed(group, model))
      if (!models.length) continue
      groups.push({ profile, provider: group.provider, label: group.label || group.provider, models,
        model_meta: Object.fromEntries(models.map(model => [model, group.model_meta?.[model] || {}])) })
    }
  }
  return { groups }
}

export async function effectivePersonSettings(userId: number, stored = personSettings(userId)) {
  const profiles = personProfiles(userId)
  // Use Studio's global default resource, never the browser's current Profile header.
  const profile = stored.settings.model?.profile || getActiveProfileName() || 'default'
  const catalog = profiles.includes(profile) ? await personRuntime().modelConfig(profile) : null
  let model = stored.settings.model
  if (!model && catalog?.default) {
    const group = catalog.groups.find(group => (!catalog.default_provider || group.provider === catalog.default_provider)
      && group.models.includes(catalog.default) && personModelAllowed(group, catalog.default))
    if (group) model = { runtime: 'ekko', mode: 'scoped', profile, provider: group.provider, model: catalog.default, apiMode: apiMode(group, catalog.default) }
  }
  const meta = model ? catalog?.groups.find(group => group.provider === model!.provider)?.model_meta?.[model.model] : undefined
  const reasoningEfforts = !model || meta?.reasoning === false ? []
    : [...PERSON_REASONING_EFFORTS].filter(effort => meta?.reasoning_efforts === undefined || meta.reasoning_efforts.includes(effort))
  const reasoningEffort = reasoningEfforts.includes(stored.settings.reasoningEffort as typeof PERSON_REASONING_EFFORTS[number]) ? stored.settings.reasoningEffort : ''
  return { revision: stored.revision, settings: { ...stored.settings, model, reasoningEffort } as PersonSettings,
    inherits_global_model: !stored.settings.model, reasoning_efforts: reasoningEfforts }
}

export async function personModelSelection(userId: number, input: Record<string, unknown>): Promise<PersonSelection> {
  const profile = String(input.profile || '')
  if (!personProfiles(userId).includes(profile)) throw personError('Execution resource is unavailable', 403)
  const provider = String(input.provider || '')
  const model = String(input.model || '')
  const group = (await personRuntime().modelConfig(profile)).groups.find(group => group.provider === provider && group.models.includes(model))
  if (!group || !personModelAllowed(group, model)) throw personError('Model unavailable or changed', 409)
  return { runtime: 'ekko', mode: 'scoped', profile, provider, model, apiMode: apiMode(group, model) }
}
export async function validatePersonSelection(userId: number, selection: PersonSelection) {
  const user = personUser(userId)
  if (!isAgentRuntime(selection.runtime) || !['global', 'scoped'].includes(selection.mode)) throw personError('Invalid runtime')
  if (!personProfiles(userId).includes(selection.profile) || (user.role !== 'super_admin' && !userCanAccessProfile(userId, selection.profile))) throw personError('Execution resource is unavailable', 403)
  const available = personCapabilities(userId).find(a => a.runtime === selection.runtime)
  if (!available?.installed) throw personError('Agent is not installed', 409)
  if (selection.mode === 'global') {
    if (user.role !== 'super_admin' || ['ekko', 'hermes'].includes(selection.runtime)) throw personError('Native machine credentials are not assigned to this account', 403)
    const result = await personRuntime().nativeModels(selection.runtime)
    if (result.status !== 'ready' || !result.models.some(m => m.id === selection.model)) throw personError(`Native model unavailable: ${result.status}`, 409)
    return
  }
  if (!['ekko','hermes'].includes(selection.runtime) && isScopedCodingAgentAuthProvider(selection.provider)) throw personError('Use native mode for subscription providers', 409)
  const groups = await getSessionAvailableModelGroups(selection.profile)
  const group = groups.find(g => g.provider === selection.provider && g.models?.includes(selection.model))
  if (selection.runtime !== 'hermes' && ['bedrock_converse','codex_app_server'].includes(selection.apiMode || '')) throw personError('Runtime does not support this model protocol', 409)
  if (!group || group.model_meta?.[selection.model]?.disabled || apiMode(group, selection.model) !== selection.apiMode) throw personError('Model unavailable or changed', 409)
}
export async function searchPersonModels(userId: number, input: Record<string, unknown>) {
  const runtime = String(input.runtime || 'ekko')
  if (!isAgentRuntime(runtime)) throw personError('Unknown runtime')
  if (!personCapabilities(userId).find(a => a.runtime === runtime)?.installed) return { candidates: [], reason: 'agent_not_installed', cursor: null }
  const mode = input.mode === 'global' ? 'global' : 'scoped'
  const query = String(input.query || '').trim().toLowerCase().slice(0, 200)
  const profiles = personProfiles(userId)
  const rows: Array<PersonSelection & { label: string }> = []
  if (mode === 'global') {
    if (personUser(userId).role !== 'super_admin' || ['ekko', 'hermes'].includes(runtime)) throw personError('Native machine credentials are unavailable', 403)
    const catalog = await personRuntime().nativeModels(runtime)
    if (catalog.status !== 'ready') return { candidates: [], reason: catalog.status, cursor: null }
    for (const model of catalog.models) rows.push({ runtime, mode, profile: profiles[0] || '', model: model.id, provider: '', label: model.name })
  } else {
    for (const profile of profiles) {
      for (const group of await getSessionAvailableModelGroups(profile)) {
        if (input.provider && input.provider !== group.provider) continue
        if (group.provider === 'moa' || (!['ekko','hermes'].includes(runtime) && isScopedCodingAgentAuthProvider(group.provider))) continue
        for (const model of group.models || []) {
          if (group.model_meta?.[model]?.disabled) continue
          const protocol = apiMode(group, model)
          if (runtime !== 'hermes' && ['bedrock_converse', 'codex_app_server'].includes(protocol || '')) continue
          rows.push({ runtime, mode, profile, provider: group.provider, model, apiMode: protocol, label: model })
        }
      }
    }
  }
  const filtered = rows.filter(r => !query || `${r.provider} ${r.model} ${r.label}`.toLowerCase().includes(query))
    .sort((a, b) => Number(b.model.toLowerCase() === query) - Number(a.model.toLowerCase() === query) || `${a.provider}/${a.model}/${a.profile}`.localeCompare(`${b.provider}/${b.model}/${b.profile}`))
  const signature = createHash('sha256').update(JSON.stringify([userId, runtime, mode, query, input.provider || '', rows])).digest('hex').slice(0,16)
  let offset = 0
  if (input.cursor) {
    try { const cursor = JSON.parse(Buffer.from(String(input.cursor), 'base64url').toString()); if (cursor.signature !== signature || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error(); offset = cursor.offset }
    catch { throw personError('Model search cursor expired', 409) }
  }
  const limit = Math.max(1, Math.min(10, Number(input.limit) || 3))
  const candidates = filtered.slice(offset, offset + limit).map(({ label, ...selection }) => ({ ...selection, label,
    selection_ref: savePersonSelection(userId, selection), availability: 'configuration_found' }))
  return { candidates, cursor: offset + limit < filtered.length ? Buffer.from(JSON.stringify({ signature, offset: offset + limit })).toString('base64url') : null }
}
