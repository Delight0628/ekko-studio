<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed, watch, provide } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NInput, NSelect, NAlert, NTabs, NTabPane, NDrawer, NDrawerContent, NTooltip, NModal, NPopconfirm, useMessage } from 'naive-ui'
import PageLoading from '@/components/common/PageLoading.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import ChatInput from '@/components/hermes/chat/ChatInput.vue'
import MessageList from '@/components/hermes/chat/MessageList.vue'
import SessionTasksDrawer from '@/components/hermes/tasks/SessionTasksDrawer.vue'
import PersonTaskChat from '@/components/hermes/person/PersonTaskChat.vue'
import { personTaskNavigation } from '@/components/hermes/person/task-navigation'
import PersonAgentSettings from '@/components/hermes/person/PersonAgentSettings.vue'
import { onPersonUpdated } from '@/api/studio/chat'
import ModelCascader from '@/components/hermes/models/ModelCascader.vue'
import SessionTaskIcon from '@/components/common/SessionTaskIcon.vue'
import FolderIcon from '@/components/common/FolderIcon.vue'
import BroomIcon from '@/components/common/BroomIcon.vue'
import FolderPicker from '@/components/hermes/chat/FolderPicker.vue'
import { useDefaultWorkspace } from '@/composables/useDefaultWorkspace'
import { useChatStore } from '@/stores/hermes/chat'
import { useSettingsStore } from '@/stores/hermes/settings'
import type { AvailableModelGroup } from '@/api/hermes/system'
import { personRequest, type PersonSnapshot, type PersonModelGroup, type PersonTask, type PersonSchedule, type PersonMemory } from '@/api/person'

const { t } = useI18n()
const message = useMessage()
const settingsStore = useSettingsStore()
const chatStore = useChatStore()
const data = ref<PersonSnapshot | null>(null)
const initializing = ref(true)
const error = ref('')
const pending = ref(false)
const tab = ref('settings')
const showTasks = ref(false)
const showPanel = ref(false)
const showWorkspace = ref(false)
const showClearConfirm = ref(false)
const workspaceValue = ref<string | null>('')
const workspaceDirectories = useDefaultWorkspace()
const { defaultWorkspaces, recentWorkspaces } = workspaceDirectories
const chatTaskId = ref<string | null>(null)
function openTask(task: PersonTask) { showTasks.value = false; chatTaskId.value = task.id }
provide(personTaskNavigation, taskId => { showTasks.value = false; chatTaskId.value = taskId })
const showModelPicker = ref(false)
const modelsLoading = ref(false)
const modelTrigger = ref<HTMLElement | null>(null)
const modelGroups = ref<PersonModelGroup[]>([])
const settingsWrites = ref(0)
let settingsChain = Promise.resolve()
const optimisticEffort = ref<string | null>(null)
const memoryText = ref(''); const editingMemory = ref<PersonMemory | null>(null)
const scheduleTask = ref<string | null>(null); const scheduleKind = ref('once'); const expression = ref(''); const timezone = ref(Intl.DateTimeFormat().resolvedOptions().timeZone)
const scheduleEdit = ref<PersonSchedule | null>(null)
let refreshing = false
let refreshAgain = false
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
function openPanel(name: string) { if (name === 'tasks') { showTasks.value = true; return }; tab.value = name; showPanel.value = true; void refresh() }
async function refresh() {
  if (disposed) return
  if (refreshing) { refreshAgain = true; return }
  refreshing = true
  const sequence = snapshotSequence
  try {
    const next = await personRequest<PersonSnapshot>('', undefined, 'GET', lifetime.signal)
    if (!data.value) timezone.value = next.settings.timezone
    if (disposed) return
    if (sequence !== snapshotSequence) { refreshAgain = true; return }
    data.value = next
    syncSession(next)
  } catch (e) { if (!disposed) error.value = String(e) } finally { refreshing = false; if (refreshAgain && !disposed) { refreshAgain = false; void refresh() } }
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
function folderName(path: string) { return path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || path }
function openWorkspace() {
  workspaceValue.value = data.value?.session.workspace || ''
  showWorkspace.value = true
  void workspaceDirectories.init().catch(e => { error.value = String(e) })
}
async function saveWorkspace() {
  const workspace = workspaceValue.value?.trim() || ''
  await saveSettings({ workspace })
  if (data.value?.settings.workspace !== workspace) return false
  await refresh()
  showWorkspace.value = false
  return true
}
async function clearHistory() {
  if (!data.value?.can_clear || busy.value || pending.value || settingsWrites.value) return false
  pending.value = true; error.value = ''
  try {
    await personRequest('/clear', { expected_history_revision: data.value.history_revision })
    const next = await personRequest<PersonSnapshot>('', undefined, 'GET', lifetime.signal)
    if (disposed) return true
    snapshotSequence++; data.value = next; syncSession(next)
    showTasks.value = false; chatTaskId.value = null; showClearConfirm.value = false
    await chatStore.switchSession(next.session.id)
    message.success(t('person.cleared'))
    return true
  } catch (e) { if (!disposed) { error.value = String(e); await refresh() }; return false }
  finally { pending.value = false }
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
function memorySave() { return act(async () => { await personRequest('/memory', { content: memoryText.value, ...(editingMemory.value ? { id: editingMemory.value.id, expected_revision: editingMemory.value.revision } : {}) }); memoryText.value = ''; editingMemory.value = null }) }
function memoryForget(memory: PersonMemory) { return act(() => personRequest('/memory', { id: memory.id, expected_revision: memory.revision, forget: true })) }
function scheduleAction(schedule: PersonSchedule, action: string) { return act(() => personRequest('/schedules/apply', { schedule_id: schedule.id, action, expected_revision: schedule.revision, idempotency_key: crypto.randomUUID() })) }
function scheduleSave() { return act(async () => { await personRequest('/schedules/apply', { action: scheduleEdit.value ? 'update' : 'create', task_id: scheduleTask.value, schedule_id: scheduleEdit.value?.id, expected_revision: scheduleEdit.value?.revision, kind: scheduleKind.value, expression: expression.value, timezone: timezone.value, misfire: 'run_latest', idempotency_key: crypto.randomUUID() }); expression.value = ''; scheduleEdit.value = null }) }
function editSchedule(schedule: PersonSchedule) { scheduleEdit.value = schedule; scheduleTask.value = schedule.task_id; expression.value = schedule.expression; timezone.value = schedule.timezone; scheduleKind.value = /\s/.test(schedule.expression) ? 'cron' : 'once' }

watch(busy, (running, wasRunning) => { if (wasRunning && !running) void refresh() })
const stopPersonUpdates = onPersonUpdated(event => { if (event.session_id === data.value?.session.id) void refresh() })
onMounted(async () => {
  try {
    chatStore.setRuntimeMode('default')
    await Promise.all([settingsStore.fetchSettings(), refresh()])
    if (!disposed && data.value) await chatStore.switchSession(data.value.session.id)
  } catch (e) { if (!disposed) error.value = String(e) }
  finally { if (!disposed) initializing.value = false }
})
onBeforeUnmount(() => { stopPersonUpdates(); disposed = true; lifetime.abort() })
</script>

<template>
  <PageLoading :show="initializing || chatStore.isLoadingMessages" initial-only class="person-view">
    <PageHeader>
      <header class="person-header">
        <span class="person-title">Person</span>
        <div class="person-header-actions">
          <NTooltip trigger="hover">
            <template #trigger><NButton quaternary circle size="small" :aria-label="t('person.tasks')" :aria-expanded="showTasks" @click="openPanel('tasks')"><SessionTaskIcon :size="17" /></NButton></template>
            {{ t('person.tasks') }}
          </NTooltip>
          <NTooltip trigger="hover">
            <template #trigger><NButton quaternary circle size="small" :disabled="!data?.can_clear || busy || pending || settingsWrites > 0" :aria-label="t('chat.workspace')" :aria-expanded="showWorkspace" @click="openWorkspace"><FolderIcon /></NButton></template>
            {{ data?.session.workspace || t('chat.workspace') }}
          </NTooltip>
          <NPopconfirm v-model:show="showClearConfirm" :positive-text="t('common.confirm')" :negative-text="t('common.cancel')" :positive-button-props="{ loading: pending }" :disabled="!data?.can_clear || busy || pending || settingsWrites > 0" @positive-click="clearHistory">
            <template #trigger>
              <NTooltip trigger="hover">
                <template #trigger><NButton quaternary circle size="small" :aria-label="t('person.clearHistoryTasks')" :disabled="!data?.can_clear || busy || pending || settingsWrites > 0"><BroomIcon /></NButton></template>
                {{ data?.can_clear && !busy ? t('person.clearHistoryTasks') : t('person.clearHistoryTasksBusy') }}
              </NTooltip>
            </template>
            {{ t('person.clearHistoryTasksConfirm') }}
          </NPopconfirm>
          <NTooltip trigger="hover">
            <template #trigger><NButton quaternary circle size="small" :aria-label="t('person.schedules')" :aria-expanded="showPanel && tab === 'schedules'" @click="openPanel('schedules')"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></NButton></template>
            {{ t('person.schedules') }}
          </NTooltip>
          <NTooltip trigger="hover">
            <template #trigger><NButton quaternary circle size="small" :aria-label="t('person.memory')" :aria-expanded="showPanel && tab === 'memory'" @click="openPanel('memory')"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12 5c-3-2-6-2-10-1v15c4-1 7-1 10 1 3-2 6-2 10-1V4c-4-1-7-1-10 1Z"/><path d="M12 5v15"/></svg></NButton></template>
            {{ t('person.memory') }}
          </NTooltip>
          <NButton quaternary size="small" :aria-expanded="showPanel && tab === 'settings'" @click="openPanel('settings')">{{ t('person.settings') }}</NButton>
        </div>
      </header>
    </PageHeader>
    <NAlert v-if="error" class="person-alert" type="error" closable @close="error = ''">{{ error }}</NAlert>
    <template v-if="data">
      <NModal v-model:show="showWorkspace" preset="dialog" :title="t('chat.setWorkspaceTitle')" :positive-text="t('common.ok')" :negative-text="t('common.cancel')"
        :positive-button-props="{ loading: settingsWrites > 0, disabled: busy || pending || !data?.can_clear }" style="width: var(--studio-workspace-picker-width)" @positive-click="saveWorkspace">
        <p>{{ t('person.workspaceHint') }}</p>
        <div v-if="defaultWorkspaces.length" class="person-workspace-shortcuts">
          <NButton v-for="path in defaultWorkspaces" :key="path" size="tiny" :title="path" @click="workspaceValue = path">{{ folderName(path) }}</NButton>
        </div>
        <FolderPicker v-model="workspaceValue" show-favorite :favorite="!!workspaceValue && workspaceDirectories.isDefaultWorkspace(workspaceValue)" :favorite-disabled="!workspaceValue"
          @toggle-favorite="workspaceValue && workspaceDirectories.toggleDefaultWorkspace(workspaceValue).catch(e => { error = String(e) })" />
        <div v-if="recentWorkspaces.length" class="person-workspace-shortcuts">
          <NButton v-for="entry in recentWorkspaces" :key="entry.path" size="tiny" :title="entry.path" @click="workspaceValue = entry.path">{{ folderName(entry.path) }}</NButton>
        </div>
      </NModal>
      <MessageList :user-label="t('person.you')" />
      <div class="person-compose">
        <button v-if="!currentModel" type="button" class="person-model-hint" @click="openModels">{{ t('person.defaultUnavailable') }}</button>
        <ChatInput managed-reasoning-effort :send-disabled="!currentModel || pending || settingsWrites > 0"
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
        <NDrawerContent :title="t(`person.${tab}`)" closable>
          <NTabs v-model:value="tab" type="line" animated>
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

          <NTabPane name="settings" :tab-props="{ role: 'tab', 'aria-selected': tab === 'settings' }" :tab="t('person.settings')">
            <PersonAgentSettings :agents="data.settings.agents" :save-error="error" :saving="settingsWrites > 0" @save="saveSettings({ agents: JSON.parse(JSON.stringify($event)) })" />
          </NTabPane>
          </NTabs>

        </NDrawerContent>
      </NDrawer>
      <SessionTasksDrawer v-model:show="showTasks" person @open-person-task="openTask" />
      <PersonTaskChat v-if="chatTaskId" :task-id="chatTaskId" :main-session-id="data.session.id" @close="chatTaskId = null; refresh()" />
    </template>
  </PageLoading>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.person-view { display: flex; flex-direction: column; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; color: $text-primary; background: var(--card-container-bg, var(--bg-main-surface)); }
.person-header { display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; padding: calc(21px * var(--spacing-scale, 1)) calc(20px * var(--spacing-scale, 1)); border-bottom: var(--border-width, 1px) solid $border-color; }
.person-title { font-size: calc(var(--font-size-base, 14px) * 16 / 14); font-weight: 600; }
.person-header-actions { display: flex; align-items: center; gap: 4px; }
.person-workspace-shortcuts { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
.person-alert { margin: 12px; width: auto; }
.person-compose { flex-shrink: 0; min-width: 0; }
.person-model-hint { display: block; margin: 0 auto; border: 0; background: transparent; color: $accent-primary; cursor: pointer; font: inherit; font-size: 12px; padding: 8px; }
.person-card { padding: 16px; margin: 12px 0; border: 1px solid $border-light; border-radius: var(--radius-component, 8px); }
.person-card h3 { margin: 0; font-size: 14px; }
.person-row { display: flex; align-items: center; gap: 12px; min-width: 0; }
.person-row :deep(.n-input), .person-row :deep(.n-select) { flex: 1; min-width: 0; }
.person-wrap { flex-wrap: wrap; }
.person-card p { white-space: pre-wrap; overflow-wrap: anywhere; }
.person-form { display: grid; gap: 12px; margin-top: 12px; }
@media (max-width: 768px) {
  .person-header { padding: calc(16px + env(safe-area-inset-top, 0px)) 12px 16px 52px; }
  .person-title { font-size: 14px; }
  .person-row { gap: 8px; }
  .person-card { padding: 12px; }
}
</style>
