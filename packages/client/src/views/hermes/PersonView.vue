<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NInput, NSelect, NAlert, NTabs, NTabPane, NSpin, NDrawer, NDrawerContent, NTooltip } from 'naive-ui'
import PageHeader from '@/components/layout/PageHeader.vue'
import ChatInput from '@/components/hermes/chat/ChatInput.vue'
import MessageList from '@/components/hermes/chat/MessageList.vue'
import ModelCascader from '@/components/hermes/models/ModelCascader.vue'
import SessionTaskIcon from '@/components/common/SessionTaskIcon.vue'
import { useChatStore } from '@/stores/hermes/chat'
import { useSettingsStore } from '@/stores/hermes/settings'
import type { AvailableModelGroup } from '@/api/hermes/system'
import { personRequest, type PersonSnapshot, type PersonModelGroup, type PersonTask, type PersonSchedule, type PersonMemory } from '@/api/person'

const { t } = useI18n()
const settingsStore = useSettingsStore()
const chatStore = useChatStore()
const data = ref<PersonSnapshot | null>(null)
const error = ref('')
const pending = ref(false)
const tab = ref('tasks')
const showPanel = ref(false)
const showModelPicker = ref(false)
const modelsLoading = ref(false)
const modelTrigger = ref<HTMLElement | null>(null)
const modelGroups = ref<PersonModelGroup[]>([])
const settingsWrites = ref(0)
let settingsChain = Promise.resolve()
const optimisticEffort = ref<string | null>(null)
const memoryText = ref(''); const editingMemory = ref<PersonMemory | null>(null)
const taskQuery = ref(''); const taskOffset = ref(0); const detail = ref(''); const selectedTask = ref<string | null>(null)
const scheduleTask = ref<string | null>(null); const scheduleKind = ref('once'); const expression = ref(''); const timezone = ref(Intl.DateTimeFormat().resolvedOptions().timeZone)
const scheduleEdit = ref<PersonSchedule | null>(null)
let refreshing = false
let disposed = false
let snapshotSequence = 0
const lifetime = new AbortController()
const busy = computed(() => chatStore.isRunActive)
const currentModel = computed(() => data.value?.settings.model)
const modelKey = (profile: string, provider: string) => JSON.stringify([profile, provider])
const pickerProvider = computed(() => currentModel.value ? modelKey(currentModel.value.profile, currentModel.value.provider) : '')
const pickerGroups = computed<AvailableModelGroup[]>(() => modelGroups.value.map(group => ({
  ...group, provider: modelKey(group.profile, group.provider),
  label: new Set(modelGroups.value.map(item => item.profile)).size > 1 ? `${group.label} · ${group.profile}` : group.label,
  base_url: '', api_key: '',
})))
function displayModel(model: string, provider: string) {
  return pickerGroups.value.find(group => group.provider === provider)?.model_meta?.[model]?.alias || model
}
const modelLabel = computed(() => currentModel.value ? displayModel(currentModel.value.model, pickerProvider.value) : t('models.selectModel'))
const reasoningEffort = computed(() => optimisticEffort.value ?? data.value?.settings.reasoningEffort ?? '')
const taskOptions = computed(() => (data.value?.tasks || []).filter(task => task.status === 'open').map(task => ({ label: task.title, value: task.id })))
function stateLabel(state: string) { return t(`person.states.${state}`) }
function openPanel(name: string) { tab.value = name; showPanel.value = true; void refresh() }
async function refresh() {
  if (refreshing || disposed) return
  refreshing = true
  const sequence = snapshotSequence
  try {
    const next = await personRequest<PersonSnapshot>('', undefined, 'GET', lifetime.signal)
    if (taskQuery.value || taskOffset.value) next.tasks = (await personRequest<{tasks: PersonTask[]}>('/tasks/query', { search: taskQuery.value, offset: taskOffset.value }, 'POST', lifetime.signal)).tasks
    if (!data.value) timezone.value = next.settings.timezone
    if (disposed || sequence !== snapshotSequence) return
    data.value = next
    syncSession(next)
  } catch (e) { if (!disposed) error.value = String(e) } finally { refreshing = false }
}
async function act(work: () => Promise<unknown>) {
  if (pending.value) return
  pending.value = true; error.value = ''
  try { await work(); await refresh() } catch (e) { if (!disposed) error.value = String(e) } finally { pending.value = false }
}
function syncSession(snapshot: PersonSnapshot) {
  const session = chatStore.ensureSessionLoaded(snapshot.session)
  if (chatStore.activeSessionId === session.id) chatStore.activeSession = session
}
async function openModels(event: MouseEvent) {
  modelTrigger.value = event.currentTarget as HTMLElement
  showModelPicker.value = true
  modelsLoading.value = true
  try { modelGroups.value = (await personRequest<{ groups: PersonModelGroup[] }>('/models', undefined, 'GET', lifetime.signal)).groups }
  catch (e) { if (!disposed) error.value = String(e) }
  finally { modelsLoading.value = false }
}
function saveSettings(patch: Record<string, unknown>) {
  settingsWrites.value++
  error.value = ''
  settingsChain = settingsChain.then(async () => {
    if (disposed || !data.value) return
    const result = await personRequest<Pick<PersonSnapshot, 'settings' | 'revision' | 'inherits_global_model' | 'reasoning_efforts'>>('/settings', { ...patch, expected_revision: data.value.revision }, 'PUT', lifetime.signal)
    snapshotSequence++
    if (!disposed && data.value) {
      const model = result.settings.model
      data.value = { ...data.value, ...result, session: { ...data.value.session,
        model: model?.model || '', provider: model?.provider || '', profile: model?.profile || data.value.session.profile,
        reasoning_effort: result.settings.reasoningEffort } }
      syncSession(data.value)
    }
  }).catch(async e => { if (!disposed) { error.value = String(e); await refresh() } })
    .finally(() => { settingsWrites.value--; if (!settingsWrites.value) optimisticEffort.value = null })
  return settingsChain
}
function selectModel(selection: { provider: string; model: string }) {
  const group = modelGroups.value.find(group => modelKey(group.profile, group.provider) === selection.provider)
  if (!group) return
  void saveSettings({ model: { profile: group.profile, provider: group.provider, model: selection.model } })
  showModelPicker.value = false
}
function selectEffort(value: string) { optimisticEffort.value = value; void saveSettings({ reasoning_effort: value }) }
function inheritModel() { void saveSettings({ use_global_default: true }); showModelPicker.value = false }
function taskAction(task: PersonTask, action: string) { return act(() => personRequest('/tasks/apply', { task_id: task.id, action, expected_revision: task.revision, idempotency_key: crypto.randomUUID() })) }
function showTask(task: PersonTask) { return act(async () => {
  selectedTask.value = task.id
  const result = await personRequest<{ executions: Array<{ output: string; error: string; review_json: string; state: string }> }>(`/tasks/${task.id}/executions`)
  detail.value = result.executions.map(run => `${stateLabel(run.state)}\n${run.error || ''}\n${run.output}\n${run.review_json || ''}`).join('\n\n') || task.summary
}) }
function memorySave() { return act(async () => { await personRequest('/memory', { content: memoryText.value, ...(editingMemory.value ? { id: editingMemory.value.id, expected_revision: editingMemory.value.revision } : {}) }); memoryText.value = ''; editingMemory.value = null }) }
function memoryForget(memory: PersonMemory) { return act(() => personRequest('/memory', { id: memory.id, expected_revision: memory.revision, forget: true })) }
function scheduleAction(schedule: PersonSchedule, action: string) { return act(() => personRequest('/schedules/apply', { schedule_id: schedule.id, action, expected_revision: schedule.revision, idempotency_key: crypto.randomUUID() })) }
function scheduleSave() { return act(async () => { await personRequest('/schedules/apply', { action: scheduleEdit.value ? 'update' : 'create', task_id: scheduleTask.value, schedule_id: scheduleEdit.value?.id, expected_revision: scheduleEdit.value?.revision, kind: scheduleKind.value, expression: expression.value, timezone: timezone.value, misfire: 'run_latest', idempotency_key: crypto.randomUUID() }); expression.value = ''; scheduleEdit.value = null }) }
function editSchedule(schedule: PersonSchedule) { scheduleEdit.value = schedule; scheduleTask.value = schedule.task_id; expression.value = schedule.expression; timezone.value = schedule.timezone; scheduleKind.value = /\s/.test(schedule.expression) ? 'cron' : 'once' }

watch(busy, (running, wasRunning) => { if (wasRunning && !running) void refresh() })
onMounted(async () => {
  chatStore.setRuntimeMode('default')
  void settingsStore.fetchSettings()
  await refresh()
  if (!disposed && data.value) await chatStore.switchSession(data.value.session.id)
})
onBeforeUnmount(() => { disposed = true; lifetime.abort() })
</script>

<template>
  <section class="person-view">
    <PageHeader>
      <header class="person-header">
        <span class="person-title">Person</span>
        <div class="person-header-actions">
          <NTooltip trigger="hover">
            <template #trigger><NButton quaternary circle size="small" :aria-label="t('person.tasks')" :aria-expanded="showPanel && tab === 'tasks'" @click="openPanel('tasks')"><SessionTaskIcon :size="17" /></NButton></template>
            {{ t('person.tasks') }}
          </NTooltip>
          <NTooltip trigger="hover">
            <template #trigger><NButton quaternary circle size="small" :aria-label="t('person.schedules')" :aria-expanded="showPanel && tab === 'schedules'" @click="openPanel('schedules')"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></NButton></template>
            {{ t('person.schedules') }}
          </NTooltip>
          <NTooltip trigger="hover">
            <template #trigger><NButton quaternary circle size="small" :aria-label="t('person.memory')" :aria-expanded="showPanel && tab === 'memory'" @click="openPanel('memory')"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12 5c-3-2-6-2-10-1v15c4-1 7-1 10 1 3-2 6-2 10-1V4c-4-1-7-1-10 1Z"/><path d="M12 5v15"/></svg></NButton></template>
            {{ t('person.memory') }}
          </NTooltip>
        </div>
      </header>
    </PageHeader>
    <NAlert v-if="error" class="person-alert" type="error" closable @close="error = ''">{{ error }}</NAlert>
    <div v-if="!data" class="person-loading"><NSpin /></div>
    <template v-else>
      <MessageList :user-label="t('person.you')" />
      <div class="person-compose">
        <button v-if="!currentModel" type="button" class="person-model-hint" @click="openModels">{{ t('person.defaultUnavailable') }}</button>
        <ChatInput managed-reasoning-effort :send-disabled="!currentModel || settingsWrites > 0"
          :model-label="modelLabel" :model-disabled="busy || settingsWrites > 0" :model-expanded="showModelPicker"
          :reasoning-effort="reasoningEffort" :reasoning-effort-disabled="busy || !currentModel"
          :scoped-reasoning-efforts="data.reasoning_efforts" @update:reasoning-effort="selectEffort" @model-click="openModels" />
      </div>
      <ModelCascader v-model:show="showModelPicker" :groups="pickerGroups" :custom-models="{}" :display-name="displayModel"
        :provider="pickerProvider" :model="currentModel?.model" :loading="modelsLoading || settingsWrites > 0" :trigger-element="modelTrigger"
        :title="t('chat.setModelTitle')" @select="selectModel">
        <template #footer>
          <NButton size="small" quaternary :disabled="busy || settingsWrites > 0" @click="inheritModel">{{ data.inherits_global_model ? t('person.followingGlobalModel') : t('person.useGlobalModel') }}</NButton>
        </template>
      </ModelCascader>
      <NDrawer v-model:show="showPanel" :width="460" placement="right" :close-on-esc="true" :style="{ maxWidth: '100vw' }">
        <NDrawerContent :title="t(tab === 'memory' ? 'person.memory' : tab === 'schedules' ? 'person.schedules' : 'person.tasks')" closable>
          <NTabs v-model:value="tab" type="line" animated>
        <NTabPane name="tasks" :tab-props="{ role: 'tab', 'aria-selected': tab === 'tasks' }" :tab="t('person.tasks')">
          <form class="person-row" @submit.prevent="taskOffset = 0; refresh()">
          <NInput v-model:value="taskQuery" :input-props="{ 'aria-label': t('person.search') }" />
          <NButton attr-type="submit">{{ t('person.search') }}</NButton>
          </form>
          <p v-if="!data.tasks.length">{{ t('person.empty') }}</p>
          <article v-for="task in data.tasks" :key="task.id" class="person-card" data-theme-surface="card">
          <div class="person-row">
          <h3>{{ task.title }}</h3>
          <span role="status">{{ stateLabel(task.execution_state) }} · {{ stateLabel(task.status) }}</span>
          </div>
          <p>{{ task.summary }}</p>
          <p v-if="task.completion_evidence">{{ task.completion_evidence }}</p>
          <div class="person-row person-wrap">
          <NButton @click="showTask(task)">{{ t('person.details') }}</NButton>
          <NButton v-if="task.status !== 'open'" :disabled="pending" @click="taskAction(task, 'reopen')">{{ t('person.reopen') }}</NButton>
          <template v-if="task.status === 'open'">
          <NButton v-if="['running','starting','queued','waiting_person','waiting_user','waiting_approval','reviewing'].includes(task.execution_state)" :disabled="pending" @click="taskAction(task, 'pause')">{{ t('person.pause') }}</NButton>
          <NButton v-if="['idle','paused','failed','interrupted','cancelled','finished'].includes(task.execution_state)" :disabled="pending" @click="taskAction(task, 'resume')">{{ t('person.resume') }}</NButton>
          <NButton :disabled="pending || task.execution_state === 'stopping'" @click="taskAction(task, 'cancel')">{{ t('person.cancel') }}</NButton>
          <NButton :disabled="pending" @click="taskAction(task, 'close')">{{ t('person.close') }}</NButton>
          </template>
          </div>
          </article>
          <div class="person-row">
          <NButton :disabled="taskOffset === 0" @click="taskOffset = Math.max(0, taskOffset - 20); refresh()">{{ t('person.previous') }}</NButton>
          <NButton :disabled="data.tasks.length < 20" @click="taskOffset += 20; refresh()">{{ t('person.more') }}</NButton>
          </div>
          </NTabPane>
        <NTabPane name="schedules" :tab-props="{ role: 'tab', 'aria-selected': tab === 'schedules' }" :tab="t('person.schedules')">
          <section class="person-card" data-theme-surface="card">
          <h3>{{ t('person.scheduleEdit') }}</h3>
          <form @submit.prevent="scheduleSave" class="person-form">
          <NSelect v-model:value="scheduleTask" :options="taskOptions" :disabled="!!scheduleEdit" :placeholder="t('person.tasks')" :aria-label="t('person.tasks')" />
          <NSelect v-model:value="scheduleKind" :options="[{label:t('person.once'),value:'once'},{label:t('person.recurring'),value:'cron'}]" :aria-label="t('person.schedules')" />
          <NInput v-model:value="expression" :placeholder="scheduleKind === 'once' ? t('person.dateHint') : t('person.cronHint')" :input-props="{ 'aria-label': t('person.expression') }" />
          <NInput v-model:value="timezone" :input-props="{ 'aria-label': t('person.timezone') }" />
          <NButton attr-type="submit" :disabled="pending || !scheduleTask || !expression">{{ t('common.save') }}</NButton>
          <NButton v-if="scheduleEdit" @click="scheduleEdit = null; expression = ''">{{ t('common.cancel') }}</NButton>
          </form>
          </section>
          <article v-for="schedule in data.schedules" :key="schedule.id" class="person-card" data-theme-surface="card">
          <h3>{{ data.tasks.find(task => task.id === schedule.task_id)?.title || t('person.tasks') }}</h3>
          <p>{{ schedule.expression }} · {{ schedule.timezone }} · {{ stateLabel(schedule.state) }}</p>
          <time>{{ new Date(schedule.next_at).toLocaleString() }}</time>
          <div class="person-row person-wrap">
          <NButton v-if="schedule.state !== 'cancelled'" @click="editSchedule(schedule)">{{ t('common.edit') }}</NButton>
          <NButton v-if="schedule.state === 'active'" :disabled="pending" @click="scheduleAction(schedule, 'pause')">{{ t('person.pause') }}</NButton>
          <NButton v-if="schedule.state === 'paused'" :disabled="pending" @click="scheduleAction(schedule, 'resume')">{{ t('person.resume') }}</NButton>
          <NButton v-if="schedule.state !== 'cancelled'" :disabled="pending" @click="scheduleAction(schedule, 'cancel')">{{ t('person.cancel') }}</NButton>
          </div>
          </article>
          </NTabPane>
        <NTabPane name="memory" :tab-props="{ role: 'tab', 'aria-selected': tab === 'memory' }" :tab="t('person.memory')">
          <p>{{ t('person.memoryHint') }}</p>
          <form @submit.prevent="memorySave" class="person-row">
          <NInput v-model:value="memoryText" :maxlength="2000" :input-props="{ 'aria-label': t('person.memory') }" />
          <NButton attr-type="submit" :disabled="pending || !memoryText.trim()">{{ t('common.save') }}</NButton>
          <NButton v-if="editingMemory" @click="editingMemory = null; memoryText = ''">{{ t('common.cancel') }}</NButton>
          </form>
          <article v-for="memory in data.memories" :key="memory.id" class="person-card" data-theme-surface="card">
          <p>{{ memory.content }}</p>
          <div class="person-row">
          <NButton @click="editingMemory = memory; memoryText = memory.content">{{ t('common.edit') }}</NButton>
          <NButton :disabled="pending" @click="memoryForget(memory)">{{ t('person.forget') }}</NButton>
          </div>
          </article>
          </NTabPane>

          </NTabs>
          <section v-if="detail" class="person-card" data-theme-surface="card">
            <div class="person-row"><h3>{{ t('person.details') }}</h3><NButton @click="detail = ''; selectedTask = null">{{ t('common.close') }}</NButton></div>
            <pre>{{ detail }}</pre>
          </section>
        </NDrawerContent>
      </NDrawer>
    </template>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.person-view { display: flex; flex-direction: column; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; color: $text-primary; background: var(--card-container-bg, var(--bg-main-surface)); }
.person-header { display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; padding: calc(21px * var(--spacing-scale, 1)) calc(20px * var(--spacing-scale, 1)); border-bottom: var(--border-width, 1px) solid $border-color; }
.person-title { font-size: calc(var(--font-size-base, 14px) * 16 / 14); font-weight: 600; }
.person-header-actions { display: flex; align-items: center; gap: 4px; }
.person-alert { margin: 12px; width: auto; }
.person-loading { flex: 1; display: grid; place-items: center; }
.person-compose { flex-shrink: 0; min-width: 0; }
.person-model-hint { display: block; margin: 0 auto; border: 0; background: transparent; color: $accent-primary; cursor: pointer; font: inherit; font-size: 12px; padding: 8px; }
.person-card { padding: 16px; margin: 12px 0; border: 1px solid $border-light; border-radius: var(--radius-component, 8px); }
.person-card h3 { margin: 0; font-size: 14px; }
.person-row { display: flex; align-items: center; gap: 12px; min-width: 0; }
.person-row :deep(.n-input), .person-row :deep(.n-select) { flex: 1; min-width: 0; }
.person-wrap { flex-wrap: wrap; }
.person-card p { white-space: pre-wrap; overflow-wrap: anywhere; }
.person-form { display: grid; gap: 12px; margin-top: 12px; }
.person-card pre { white-space: pre-wrap; overflow-wrap: anywhere; font-family: inherit; max-height: 480px; overflow-y: auto; }
@media (max-width: 768px) {
  .person-header { padding: calc(16px + env(safe-area-inset-top, 0px)) 12px 16px 52px; }
  .person-title { font-size: 14px; }
  .person-row { gap: 8px; }
  .person-card { padding: 12px; }
}
</style>
