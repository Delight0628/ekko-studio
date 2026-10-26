<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NInput, NSelect, NSpin } from 'naive-ui'
import { personRequest, type PersonAgentPreset } from '@/api/person'
import type { AvailableModelGroup } from '@/api/hermes/system'
import type { CodingAgentId, ChatCodingAgentId } from '@/api/coding-agents'
import { AGENT_OPTIONS } from '@/utils/agent-options'
import { isGlobalOnlyCodingAgent } from '@/utils/agent-catalog'
import { canScopedCodingAgentUseProvider } from '@/utils/codingAgentProviders'
import { modelReasoningEfforts } from '@/utils/model-reasoning-effort'
import ScopedModelSelector from '@/components/hermes/models/ScopedModelSelector.vue'
import NativeCodingAgentModelFields from '@/components/hermes/models/NativeCodingAgentModelFields.vue'

const props = defineProps<{ agents: PersonAgentPreset[]; saving: boolean; saveError?: string }>()
const emit = defineEmits<{ save: [agents: PersonAgentPreset[]] }>()
const { t } = useI18n()
const draft = ref<PersonAgentPreset[]>([])
const groups = ref<Array<AvailableModelGroup & { profile: string }>>([])
const resourceProfiles = ref<string[]>([])
const installed = ref<string[]>([])
const nativeAllowed = ref(false)
const loading = ref(true)
const error = ref('')
watch(() => JSON.stringify(props.agents || []), value => { draft.value = JSON.parse(value) }, { immediate: true })
const profiles = computed(() => resourceProfiles.value.map(value => ({ label: value, value })))
const agentOptions = computed(() => AGENT_OPTIONS.map(option => ({ ...option, value: option.value === 'ekko-agent' ? 'ekko' : option.value,
  disabled: !installed.value.includes(option.value === 'ekko-agent' ? 'ekko' : option.value) || (!nativeAllowed.value && isGlobalOnlyCodingAgent(option.value)) })))
const valid = computed(() => draft.value.every(agent => agent.name.trim() && agent.description.trim() && agent.selection.profile
  && (agent.selection.mode === 'global' || (agent.selection.provider && agent.selection.model))))
function groupsFor(agent: PersonAgentPreset) {
  return groups.value.filter(group => group.profile === agent.selection.profile
    && (agent.selection.runtime === 'hermes' || canScopedCodingAgentUseProvider((agent.selection.runtime === 'ekko' ? 'ekko-agent' : agent.selection.runtime) as ChatCodingAgentId, group.provider)))
    .map(group => ({ ...group, models: group.models.filter(model => agent.selection.runtime === 'hermes'
      || !['bedrock_converse', 'codex_app_server'].includes(group.api_mode_by_model?.[model] || group.api_mode || '')) }))
}
function efforts(agent: PersonAgentPreset) {
  return [{ label: t('person.defaultEffort'), value: '' }, ...modelReasoningEfforts(groupsFor(agent), agent.selection.provider, agent.selection.model)
    .map(value => ({ label: t(`chat.reasoningEffort.options.${value}`), value }))]
}
function resetModel(agent: PersonAgentPreset) { agent.selection.provider = ''; agent.selection.model = ''; agent.selection.reasoningEffort = '' }
function changeRuntime(agent: PersonAgentPreset, runtime: string) {
  agent.selection.runtime = runtime
  agent.selection.mode = isGlobalOnlyCodingAgent(runtime) ? 'global' : 'scoped'
  resetModel(agent)
}
function add() {
  draft.value.push({ id: crypto.randomUUID(), name: '', description: '', selection: { runtime: 'ekko', mode: 'scoped',
    profile: profiles.value[0]?.value || '', provider: '', model: '', reasoningEffort: '' } })
}
onMounted(async () => {
  try {
    const [models, capabilities] = await Promise.all([
      personRequest<{ groups: Array<AvailableModelGroup & { profile: string }>; profiles?: string[] }>('/agent-models'),
      personRequest<{ agents: Array<{ runtime: string; installed: boolean }>; native_allowed: boolean }>('/capabilities'),
    ])
    groups.value = models.groups
    resourceProfiles.value = models.profiles || [...new Set(models.groups.map(group => group.profile))]
    installed.value = capabilities.agents.filter(agent => agent.installed).map(agent => agent.runtime)
    nativeAllowed.value = capabilities.native_allowed
  } catch (e) { error.value = String(e) } finally { loading.value = false }
})
</script>

<template>
  <div class="person-agent-settings">
    <p>{{ t('person.agentsHint') }}</p>
    <NAlert v-if="error || saveError" type="error">{{ saveError || error }}</NAlert>
    <NSpin v-if="loading" />
    <template v-else>
      <NAlert v-if="!draft.length" type="info">{{ t('person.defaultAgentHint') }}</NAlert>
      <article v-for="(agent, index) in draft" :key="agent.id" class="agent-card" data-theme-surface="card">
        <label>{{ t('person.agentName') }}<NInput v-model:value="agent.name" :maxlength="100" :disabled="saving" :input-props="{ 'aria-label': t('person.agentName') }" /></label>
        <label>{{ t('person.agentPurpose') }}<NInput v-model:value="agent.description" type="textarea" :maxlength="1000" :disabled="saving" :autosize="{ minRows: 2, maxRows: 4 }" :input-props="{ 'aria-label': t('person.agentPurpose') }" /></label>
        <label>{{ t('person.agentRuntime') }}<NSelect :value="agent.selection.runtime" :options="agentOptions" :disabled="saving" :aria-label="t('person.agentRuntime')" @update:value="changeRuntime(agent, $event)" /></label>
        <label v-if="!['ekko', 'hermes'].includes(agent.selection.runtime)">{{ t('person.agentMode') }}
          <NSelect v-model:value="agent.selection.mode" :disabled="saving || isGlobalOnlyCodingAgent(agent.selection.runtime)" :aria-label="t('person.agentMode')"
            :options="[{ label: t('person.scopedMode'), value: 'scoped' }, { label: t('person.nativeMode'), value: 'global', disabled: !nativeAllowed }]" @update:value="resetModel(agent)" />
        </label>
        <label>{{ t('person.agentResource') }}<NSelect v-model:value="agent.selection.profile" :options="profiles" :disabled="saving" :aria-label="t('person.agentResource')" @update:value="resetModel(agent)" /></label>
        <template v-if="agent.selection.mode === 'scoped'">
          <label>{{ t('person.chooseModel') }}<ScopedModelSelector :provider="agent.selection.provider" :model="agent.selection.model" :groups="groupsFor(agent)" :disabled="saving"
            @select="Object.assign(agent.selection, $event, { reasoningEffort: '' })" /></label>
          <label>{{ t('chat.reasoningEffort.tooltip') }}<NSelect v-model:value="agent.selection.reasoningEffort" :options="efforts(agent)" :disabled="saving || !agent.selection.model" :aria-label="t('chat.reasoningEffort.tooltip')" /></label>
        </template>
        <template v-else>
          <label>{{ t('person.chooseModel') }}<NativeCodingAgentModelFields :agent="agent.selection.runtime as CodingAgentId" :model="agent.selection.model" :reasoning-effort="agent.selection.reasoningEffort" :disabled="saving" @change="Object.assign(agent.selection, $event)" /></label>
          <label>{{ t('chat.reasoningEffort.tooltip') }}<NativeCodingAgentModelFields field="reasoning-effort" :agent="agent.selection.runtime as CodingAgentId" :model="agent.selection.model" :reasoning-effort="agent.selection.reasoningEffort" :disabled="saving" @change="Object.assign(agent.selection, $event)" /></label>
        </template>
        <NButton :disabled="saving" @click="draft.splice(index, 1)">{{ t('common.delete') }}</NButton>
      </article>
      <div class="agent-actions">
        <NButton :disabled="saving || draft.length >= 20 || !!error" @click="add">{{ t('person.addAgent') }}</NButton>
        <NButton type="primary" :loading="saving" :disabled="!valid || !!error" @click="emit('save', draft)">{{ t('common.save') }}</NButton>
      </div>
    </template>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.person-agent-settings { display: grid; gap: 12px; }
.person-agent-settings p { color: $text-secondary; margin: 0; }
.agent-card { display: grid; gap: 12px; padding: 16px; border: 1px solid $border-light; border-radius: var(--radius-component, 8px); }
.agent-card label { display: grid; gap: 6px; min-width: 0; }
.agent-actions { display: flex; flex-wrap: wrap; gap: 12px; }
</style>
