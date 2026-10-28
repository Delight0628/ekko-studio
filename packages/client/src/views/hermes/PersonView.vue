<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '@/stores/hermes/app'
import SessionListSidebar from '@/components/hermes/chat/SessionListSidebar.vue'
import SessionSelectionToolbar from '@/components/hermes/chat/SessionSelectionToolbar.vue'
import ListActionsMenu from '@/components/layout/ListActionsMenu.vue'
import PageSidebarNav from '@/components/layout/PageSidebarNav.vue'
import HeaderSidebarToggle from '@/components/layout/HeaderSidebarToggle.vue'
import SessionListItem from '@/components/hermes/chat/SessionListItem.vue'
import { usePageSidebarState } from '@/composables/usePageSidebar'
import { batchDeleteSessions, renameSession, type SessionSummary } from '@/api/studio/sessions'
import { ref, nextTick, onMounted, onBeforeUnmount, computed, watch, provide } from 'vue'
import { useI18n } from 'vue-i18n'
import { NInput, NEmpty, NButton, NAlert, NTabs, NTabPane, NDrawer, NDrawerContent, NTooltip, NModal, NPopconfirm, NDropdown, useMessage } from 'naive-ui'
import PageLoading from '@/components/common/PageLoading.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import ChatInput from '@/components/hermes/chat/ChatInput.vue'
import MessageList from '@/components/hermes/chat/MessageList.vue'
import SessionTasksDrawer from '@/components/hermes/tasks/SessionTasksDrawer.vue'
import PersonTaskChat from '@/components/hermes/person/PersonTaskChat.vue'
import { personTaskNavigation } from '@/components/hermes/person/task-navigation'
import PersonSchedulesPanel from '@/components/hermes/person/PersonSchedulesPanel.vue'
import PersonMemoryPanel from '@/components/hermes/person/PersonMemoryPanel.vue'
import PersonPanelIcon from '@/components/hermes/person/PersonPanelIcon.vue'
import { useTaskDrawerLayout } from '@/components/hermes/tasks/useTaskDrawerLayout'
import PersonAgentSettings from '@/components/hermes/person/PersonAgentSettings.vue'
import PersonGeneralSettings from '@/components/hermes/person/PersonGeneralSettings.vue'
import PersonTaskActivity from '@/components/hermes/person/PersonTaskActivity.vue'
import { onPersonUpdated } from '@/api/studio/chat'
import ModelCascader from '@/components/hermes/models/ModelCascader.vue'
import SessionTaskIcon from '@/components/common/SessionTaskIcon.vue'
import FolderIcon from '@/components/common/FolderIcon.vue'
import BroomIcon from '@/components/common/BroomIcon.vue'
import FolderPicker from '@/components/hermes/chat/FolderPicker.vue'
import { useDefaultWorkspace } from '@/composables/useDefaultWorkspace'
import { useChatStore, mapHermesSession } from '@/stores/hermes/chat'
import { useSettingsStore } from '@/stores/hermes/settings'
import { usePersonPresenceStore } from '@/stores/hermes/person-presence'
import type { AvailableModelGroup } from '@/api/hermes/system'
import { personRequest, type PersonSnapshot, type PersonModelGroup, type PersonTask, type PersonSchedule, type PersonMemory } from '@/api/person'

const { t } = useI18n()
const message = useMessage()
const settingsStore = useSettingsStore()
const chatStore = useChatStore()
const appStore = useAppStore()
const route = useRoute()
const router = useRouter()
const { expanded: showSessions, isMobile } = usePageSidebarState()
watch(showSessions, value => appStore.setPageSidebarExpanded(value), { immediate: true })
const selectedSessionId = computed(() => typeof route.query.session === 'string' ? route.query.session : '')
const conversations = ref<SessionSummary[]>([])
const nextOffset = ref<number | null>(null)
const showCreate = ref(false)
const conversationName = ref('')
const creating = ref(false)
const renameConversationId = ref<string | null>(null)
const showConversationMenu = ref(false)
const contextConversationId = ref<string | null>(null)
const conversationMenuX = ref(0)
const conversationMenuY = ref(0)
const showDeleteConversation = ref(false)
const deleteConversationId = ref<string | null>(null)
const batchMode = ref(false)
const selectedConversationIds = ref(new Set<string>())
const showBatchDeleteConfirm = ref(false)
const conversationMenuOptions = computed(() => [
  { key: 'rename', label: t('chat.rename'), disabled: pending.value },
  { key: 'delete', label: t('common.delete'), disabled: pending.value },
  { key: 'batch', label: t('chat.toggleBatchMode'), disabled: pending.value },
])
const sidebarSessions = computed(() => conversations.value.map(mapHermesSession))
function openCreateConversation() {
  if (pending.value || creating.value) return
  batchMode.value = false
  selectedConversationIds.value = new Set()
  showBatchDeleteConfirm.value = false
  renameConversationId.value = null
  conversationName.value = ''; error.value = ''
  if (isMobile.value) showSessions.value = false
  showCreate.value = true
}
function openConversationMenu(event: MouseEvent, id: string) {
  event.preventDefault()
  if (pending.value || batchMode.value) return
  contextConversationId.value = id
  conversationMenuX.value = event.clientX
  conversationMenuY.value = event.clientY
  showConversationMenu.value = true
}
function selectConversationAction(action: string) {
  showConversationMenu.value = false
  const session = conversations.value.find(item => item.id === contextConversationId.value)
  if (!session || pending.value) return
  error.value = ''
  if (action !== 'batch' && isMobile.value) showSessions.value = false
  if (action === 'rename') {
    renameConversationId.value = session.id
    conversationName.value = session.title || ''
    showCreate.value = true
  } else if (action === 'delete') {
    deleteConversationId.value = session.id
    showDeleteConversation.value = true
  } else if (action === 'batch') {
    batchMode.value = true
    selectedConversationIds.value = new Set([session.id])
  }
}
function toggleBatchMode() {
  if (pending.value) return
  batchMode.value = !batchMode.value
  selectedConversationIds.value = new Set()
  showBatchDeleteConfirm.value = false
  showConversationMenu.value = false
}
function toggleConversationSelection(id: string) {
  if (pending.value) return
  const selected = new Set(selectedConversationIds.value)
  if (selected.has(id)) selected.delete(id); else selected.add(id)
  selectedConversationIds.value = selected
  if (!selected.size) showBatchDeleteConfirm.value = false
}
function selectAllConversations() {
  if (!pending.value) selectedConversationIds.value = new Set(conversations.value.map(session => session.id))
}
async function deleteSelectedConversations() {
  if (pending.value || !selectedConversationIds.value.size) return
  const targets = [...selectedConversationIds.value].map(id => ({ id }))
  pending.value = true; error.value = ''
  try {
    const result = await batchDeleteSessions(targets)
    const failedIds = new Set(result.errors.map(item => item.id))
    const deletedIds = new Set(targets.filter(target => !failedIds.has(target.id)).map(target => target.id))
    for (const id of deletedIds) chatStore.forgetSession(id)
    selectedConversationIds.value = failedIds
    await loadConversations()
    if (deletedIds.has(selectedSessionId.value)) {
      await router.replace({ name: 'hermes.person', query: conversations.value[0] ? { session: conversations.value[0].id } : {} })
    } else await refresh()
    if (result.deleted) message.success(t('chat.batchDeleteSuccess', { count: result.deleted }))
    if (result.failed) message.warning(t('chat.batchDeletePartial', { failed: result.failed }))
    else batchMode.value = false
    showBatchDeleteConfirm.value = false
  } catch (e) { error.value = String(e); message.error(t('chat.batchDeleteFailed')) }
  finally { pending.value = false }
}
let conversationRequestSequence = 0
async function loadConversations(offset = 0) {
  const request = ++conversationRequestSequence
  const result = await personRequest<{ sessions: SessionSummary[]; next_offset: number | null }>(`/conversations?offset=${offset}`, undefined, 'GET', lifetime.signal)
  if (disposed || request !== conversationRequestSequence) return
  conversations.value = offset ? [...conversations.value, ...result.sessions.filter(session => !conversations.value.some(existing => existing.id === session.id))] : result.sessions
  nextOffset.value = result.next_offset
}
function selectConversation(id: string) {
  if (batchMode.value) { toggleConversationSelection(id); return }
  error.value = ''
  showConversationMenu.value = false
  if (isMobile.value) showSessions.value = false
  showTasks.value = false; chatTaskId.value = null
  return router.push({ name: 'hermes.person', query: { session: id } })
}
async function saveConversationName() {
  if (!conversationName.value.trim() || creating.value) return false
  creating.value = true; error.value = ''
  try {
    const title = conversationName.value.trim()
    const renameId = renameConversationId.value
    let created: SessionSummary | undefined
    if (renameId) {
      if (!await renameSession(renameId, title)) throw new Error(t('chat.renameFailed'))
    } else created = await personRequest<SessionSummary>('/conversations', { title })
    await loadConversations()
    if (created) await selectConversation(created.id)
    else {
      const session = conversations.value.find(item => item.id === renameId)
      if (session) chatStore.ensureSessionLoaded(session)
      await refresh()
    }
    showCreate.value = false; conversationName.value = ''
    return true
  } catch (e) { error.value = String(e); return false }
  finally { creating.value = false }
}
async function deleteConversation(id: string) {
  if (pending.value) return false
  pending.value = true; error.value = ''
  try {
    const snapshot = await personRequest<PersonSnapshot>(`?session_id=${encodeURIComponent(id)}`, undefined, 'GET', lifetime.signal)
    await personRequest(`/conversations/${encodeURIComponent(id)}`, { expected_history_revision: snapshot.history_revision }, 'DELETE', lifetime.signal)
    error.value = ''
    chatStore.forgetSession(id)
    await loadConversations()
    if (selectedSessionId.value === id) await router.replace({ name: 'hermes.person', query: conversations.value[0] ? { session: conversations.value[0].id } : {} })
    else await refresh()
    return true
  } catch (e) { if (!disposed) error.value = String(e); return false }
  finally { pending.value = false }
}
function confirmDeleteConversation() {
  return deleteConversationId.value ? deleteConversation(deleteConversationId.value) : false
}
const personPresence = usePersonPresenceStore()
const data = ref<PersonSnapshot | null>(null)
const initializing = ref(true)
const error = ref('')
const pending = ref(false)
const tab = ref('general')
const showTasks = ref(false)
const showPanel = ref(false)
const showAgentSetup = ref(false)
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
const { drawerWidth } = useTaskDrawerLayout()
let bootstrapping = true
let refreshing = false
let refreshAgain = false
let disposed = false
let snapshotSequence = 0
const lifetime = new AbortController()
const busy = computed(() => chatStore.isRunActive)
const currentModel = computed(() => data.value?.settings.model)
const needsAgentSetup = computed(() => !!data.value && !data.value.settings.agents.length)
watch([needsAgentSetup, showPanel], ([needed, panelOpen]) => { showAgentSetup.value = needed && !panelOpen })
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
function openPanel(name: string) { if (name === 'tasks') { showTasks.value = true; return }; tab.value = name; showPanel.value = true; void refresh() }
async function refresh() {
  if (disposed) return
  if (refreshing) { refreshAgain = true; return }
  refreshing = true
  const sequence = snapshotSequence
  try {
    const next = await personRequest<PersonSnapshot>(selectedSessionId.value ? `?session_id=${encodeURIComponent(selectedSessionId.value)}` : '', undefined, 'GET', lifetime.signal)
    if (disposed) return
    if (sequence !== snapshotSequence) { refreshAgain = true; return }
    data.value = next
    syncSession(next)
    if (next.session && (chatStore.activeSessionId !== next.session.id || (typeof route.query.message === 'string' && chatStore.focusMessageId !== route.query.message))) void chatStore.switchSession(next.session.id, typeof route.query.message === 'string' ? route.query.message : null).catch(e => { if (!disposed) error.value = String(e) })
    else if (!next.session && chatStore.activeSessionId?.startsWith('person-main-')) chatStore.clearActiveSession()
  } catch (e) { if (!disposed) { error.value = String(e); if ((e as { status?: number }).status === 404) { chatStore.forgetSession(selectedSessionId.value); await router.replace({ name: 'hermes.person' }) } } } finally { refreshing = false; if (refreshAgain && !disposed) { refreshAgain = false; void refresh() } }
}
async function act(work: () => Promise<unknown>) {
  if (pending.value) return false
  pending.value = true; error.value = ''
  try { await work(); await refresh(); return true } catch (e) { if (!disposed) error.value = String(e); return false } finally { pending.value = false }
}
function syncSession(snapshot: PersonSnapshot) {
  if (!snapshot.session) return
  const session = chatStore.ensureSessionLoaded(snapshot.session)
  if (chatStore.activeSessionId === session.id) chatStore.activeSession = session
}
function folderName(path: string) { return path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || path }
function openWorkspace() {
  workspaceValue.value = data.value?.settings.workspace || ''
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
    await personRequest('/clear', { session_id: selectedSessionId.value, expected_history_revision: data.value.history_revision })
    const next = await personRequest<PersonSnapshot>(selectedSessionId.value ? `?session_id=${encodeURIComponent(selectedSessionId.value)}` : '', undefined, 'GET', lifetime.signal)
    if (disposed) return true
    snapshotSequence++; data.value = next; syncSession(next)
    showTasks.value = false; chatTaskId.value = null; showClearConfirm.value = false
    if (next.session) await chatStore.switchSession(next.session.id)
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
  let saved = false
  settingsWrites.value++
  error.value = ''
  settingsChain = settingsChain.then(async () => {
    if (disposed || !data.value) return
    const result = await personRequest<Pick<PersonSnapshot, 'settings' | 'revision' | 'inherits_global_model' | 'reasoning_efforts' | 'compression' | 'contextTokens'>>('/settings', { ...patch, expected_revision: data.value.revision }, 'PUT', lifetime.signal)
    snapshotSequence++
    if (!disposed && data.value) {
      const model = result.settings.model
      data.value = { ...data.value, ...result, session: data.value.session ? { ...data.value.session,
        model: model?.model || '', provider: model?.provider || '', profile: model?.profile || data.value.session.profile,
        reasoning_effort: result.settings.reasoningEffort } : null }
      syncSession(data.value)
      saved = true
    }
  }).catch(async e => { if (!disposed) { error.value = String(e); await refresh() } })
    .finally(() => { settingsWrites.value--; if (!settingsWrites.value) optimisticEffort.value = null })
  return settingsChain.then(() => saved)
}
function selectModel(selection: { provider: string; model: string }) {
  const group = modelGroups.value.find(group => modelKey(group.profile, group.provider) === selection.provider)
  if (!group) return
  void saveSettings({ model: { profile: group.profile, provider: group.provider, model: selection.model } })
  showModelPicker.value = false
}
function selectEffort(value: string) { optimisticEffort.value = value; void saveSettings({ reasoning_effort: value }) }
function inheritModel() { void saveSettings({ use_global_default: true }); showModelPicker.value = false }
function memoryForget(memory: PersonMemory) { return act(() => personRequest('/memory', { id: memory.id, expected_revision: memory.revision, forget: true })) }
function scheduleAction(schedule: PersonSchedule, action: string) { return act(() => personRequest('/schedules/apply', { schedule_id: schedule.id, action, expected_revision: schedule.revision, idempotency_key: crypto.randomUUID() })) }
function saveSchedule(input: Record<string, unknown>) { return act(() => personRequest('/schedules/apply', input)) }

watch(busy, (running, wasRunning) => { if (wasRunning && !running) void refresh() })
const stopPersonUpdates = onPersonUpdated(() => { void loadConversations().catch(() => {}); void refresh() })
watch([selectedSessionId, () => route.query.message], async () => {
  if (bootstrapping) return
  snapshotSequence++; data.value = null; chatTaskId.value = null; showTasks.value = false
  await refresh()
})
onMounted(async () => {
  try {
    chatStore.setRuntimeMode('default')
    await Promise.all([settingsStore.fetchSettings(), loadConversations()])
    if (!selectedSessionId.value && conversations.value.length) await router.replace({ name: 'hermes.person', query: { session: conversations.value[0].id } })
    await nextTick()
    bootstrapping = false
    await refresh()
  } catch (e) { if (!disposed) error.value = String(e) }
  finally { bootstrapping = false; if (!disposed) initializing.value = false }
})
onBeforeUnmount(() => { stopPersonUpdates(); disposed = true; lifetime.abort() })
</script>

<template>
  <div class="person-layout">
    <SessionListSidebar class="person-sidebar" :expanded="showSessions" :aria-label="t('person.conversations')">
      <template #header>
        <PageSidebarNav active="person" :primary-label="t('person.newConversation')" @primary="openCreateConversation">
          <template #actions>
            <ListActionsMenu :label="t('chat.sessionListActions')" :batch-mode="batchMode" :batch-disabled="pending || !conversations.length" @batch="toggleBatchMode" />
            <button v-if="isMobile" class="session-close-btn" type="button" :aria-label="t('common.close')" @click="showSessions = false">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m18 6-12 12M6 6l12 12" /></svg>
            </button>
          </template>
        </PageSidebarNav>
        <SessionSelectionToolbar v-if="batchMode" v-model:show-confirm="showBatchDeleteConfirm" :selected-count="selectedConversationIds.size" :can-select-all="conversations.length > 0" :deleting="pending"
          @select-all="selectAllConversations" @delete="deleteSelectedConversations" @cancel="toggleBatchMode" />
      </template>
      <template #default>
            <SessionListItem v-for="session in sidebarSessions" :key="session.id" :session="session" :active="session.id === selectedSessionId" :pinned="false" :can-delete="!pending && !isMobile"
              :selectable="batchMode" :selected="selectedConversationIds.has(session.id)" @toggle-select="toggleConversationSelection(session.id)"
              single-line :show-profile="false" :streaming="chatStore.isSessionLive(session.id)" :to="router.resolve({ name: 'hermes.person', query: { session: session.id } }).href"
              :delete-confirm-text="t('person.deleteConversationConfirm')" @select="selectConversation(session.id)" @delete="deleteConversation(session.id)" @contextmenu="openConversationMenu($event, session.id)" />
            <NButton v-if="nextOffset !== null" quaternary block @click="loadConversations(nextOffset!)">{{ t('person.older') }}</NButton>
      </template>
    </SessionListSidebar>
  <PageLoading :show="initializing || chatStore.isLoadingMessages" initial-only class="person-view">
    <PageHeader>
      <header class="person-header">
        <div class="header-left">
          <HeaderSidebarToggle class="header-sidebar-toggle" :expanded="showSessions" @toggle="showSessions = !showSessions" />
          <span class="person-title">{{ data?.session?.title || t('person.title') }}</span>
        </div>
        <div class="person-header-actions">
          <NTooltip trigger="hover">
            <template #trigger><NButton quaternary circle size="small" :aria-label="t('person.tasks')" :aria-expanded="showTasks" :disabled="!data?.session" @click="openPanel('tasks')"><SessionTaskIcon :size="17" /></NButton></template>
            {{ t('person.tasks') }}
          </NTooltip>
          <NTooltip trigger="hover">
            <template #trigger><NButton quaternary circle size="small" :disabled="!data?.can_clear || busy || pending || settingsWrites > 0" :aria-label="t('chat.workspace')" :aria-expanded="showWorkspace" @click="openWorkspace"><FolderIcon /></NButton></template>
            {{ data?.settings.workspace || t('chat.workspace') }}
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
            <template #trigger><NButton quaternary circle size="small" :aria-label="t('person.settings')" :aria-expanded="showPanel" @click="openPanel('general')"><PersonPanelIcon name="settings" :size="17" /></NButton></template>
            {{ t('person.settings') }}
          </NTooltip>
        </div>
      </header>
    </PageHeader>
    <NAlert v-if="error" class="person-alert" type="error" closable @close="error = ''">{{ error }}</NAlert>
    <template v-if="data">
      <PersonTaskActivity :count="personPresence.backgroundTaskCount" :expanded="showTasks" @open="openPanel('tasks')" />
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
      <MessageList v-if="data.session" :user-label="t('person.you')" hide-tool-calls />
      <NEmpty v-if="!data.session" class="person-empty" :description="t('person.noConversations')"><template #extra><NButton type="primary" @click="openCreateConversation">{{ t('person.newConversation') }}</NButton></template></NEmpty>
      <div v-if="data.session" class="person-compose">
        <button v-if="needsAgentSetup" type="button" class="person-model-hint" @click="openPanel('agents')">{{ t('person.agentSetupTitle') }} · {{ t('person.configureAgents') }}</button>
        <button v-if="!currentModel" type="button" class="person-model-hint" @click="openModels">{{ t('person.defaultUnavailable') }}</button>
        <ChatInput hide-settings managed-reasoning-effort :send-disabled="needsAgentSetup || !currentModel || pending || settingsWrites > 0"
          :model-label="modelLabel" :model-disabled="busy || settingsWrites > 0" :model-expanded="showModelPicker"
          :reasoning-effort="reasoningEffort" :reasoning-effort-disabled="busy || !currentModel"
          :default-effort-label="t('person.defaultEffort')"
          :scoped-reasoning-efforts="data.reasoning_efforts" @update:reasoning-effort="selectEffort" @model-click="openModels" />
      </div>
      <ModelCascader v-model:show="showModelPicker" :groups="pickerGroups" :custom-models="{}" :display-name="displayModel"
        :provider="pickerProvider" :model="currentModel?.model" :loading="modelsLoading || settingsWrites > 0" :trigger-element="modelTrigger"
        :title="t('chat.setModelTitle')" @select="selectModel">
        <template #footer>
          <NButton size="small" quaternary :disabled="busy || settingsWrites > 0" @click="inheritModel">{{ data.inherits_global_model ? t('person.followingGlobalModel') : t('person.useGlobalModel') }}</NButton>
        </template>
      </ModelCascader>
      <NDrawer v-model:show="showPanel" :width="drawerWidth" placement="right" :close-on-esc="true" class="person-workspace-drawer">
        <NDrawerContent closable :native-scrollbar="false" :body-content-style="{ padding: '0' }">
          <template #header><div class="workspace-heading"><span class="workspace-brand">zhezhe</span><span class="workspace-divider">/</span><span>{{ t('person.title') }}</span></div></template>
          <div class="person-workspace">
            <NAlert v-if="error && !['general', 'agents'].includes(tab)" class="workspace-error" type="error" closable @close="error = ''">{{ error }}</NAlert>
            <NTabs v-model:value="tab" type="line" size="large" animated>
              <NTabPane name="general" display-directive="show:lazy" :tab-props="{ role: 'tab', 'aria-selected': tab === 'general' }">
                <template #tab><span class="workspace-tab"><PersonPanelIcon name="settings" :size="17" />{{ t('person.generalSettings') }}</span></template>
                <PersonGeneralSettings :settings="data.settings" :compression="data.compression" :context-tokens="data.contextTokens" :model-label="modelLabel" :save-error="error" :saving="settingsWrites > 0" :busy="busy || data.busy" :save="saveSettings" />
              </NTabPane>
              <NTabPane name="agents" display-directive="show:lazy" :tab-props="{ role: 'tab', 'aria-selected': tab === 'agents' }">
                <template #tab><span class="workspace-tab"><PersonPanelIcon name="agents" :size="17" />{{ t('person.agentsTab') }}<span class="workspace-tab-count">{{ data.settings.agents.length }}</span></span></template>
                <PersonAgentSettings :agents="data.settings.agents" :save-error="error" :saving="settingsWrites > 0" @save="saveSettings({ agents: JSON.parse(JSON.stringify($event)) })" />
              </NTabPane>
              <NTabPane name="schedules" :tab-props="{ role: 'tab', 'aria-selected': tab === 'schedules' }">
                <template #tab><span class="workspace-tab"><PersonPanelIcon name="schedule" :size="17" />{{ t('person.schedules') }}<span class="workspace-tab-count">{{ data.schedules.length }}</span></span></template>
                <PersonSchedulesPanel :schedules="data.schedules" :tasks="data.tasks" :timezone="data.settings.timezone" :saving="pending" :save="saveSchedule" @action="scheduleAction" />
              </NTabPane>
              <NTabPane name="memory" :tab-props="{ role: 'tab', 'aria-selected': tab === 'memory' }">
                <template #tab><span class="workspace-tab"><PersonPanelIcon name="memory" :size="17" />{{ t('person.memory') }}<span class="workspace-tab-count">{{ data.memories.length }}</span></span></template>
                <PersonMemoryPanel :memories="data.memories" :saving="pending" @forget="memoryForget" />
              </NTabPane>
            </NTabs>
          </div>
        </NDrawerContent>
      </NDrawer>
      <NModal v-model:show="showAgentSetup" preset="card" class="person-setup-dialog" :bordered="false" :closable="false" :content-style="{ padding: '0' }" :mask-closable="false" :close-on-esc="false" role="dialog" aria-modal="true" aria-labelledby="person-setup-title" aria-describedby="person-setup-hint">
          <div class="person-setup-icon"><PersonPanelIcon name="agents" :size="28" /></div>
          <h2 id="person-setup-title">{{ t('person.agentSetupTitle') }}</h2>
          <p id="person-setup-hint">{{ t('person.agentSetupHint') }}</p>
          <NButton type="primary" size="large" block @click="openPanel('agents')">{{ t('person.configureAgents') }}<template #icon><PersonPanelIcon name="settings" :size="18" /></template></NButton>
      </NModal>
      <SessionTasksDrawer v-if="data.session" v-model:show="showTasks" person :person-session-id="data.session.id" @open-person-task="openTask" />
      <PersonTaskChat v-if="chatTaskId && data.session" :task-id="chatTaskId" :main-session-id="data.session.id" @close="chatTaskId = null; refresh()" />
    </template>
  </PageLoading>
    <NDropdown trigger="manual" placement="bottom-start" :show="showConversationMenu" :x="conversationMenuX" :y="conversationMenuY" :options="conversationMenuOptions"
      @select="selectConversationAction" @clickoutside="showConversationMenu = false" />
    <NModal v-model:show="showCreate" preset="dialog" :title="renameConversationId ? t('chat.renameSession') : t('person.newConversation')" :positive-text="renameConversationId ? t('common.ok') : t('common.create')" :negative-text="t('common.cancel')"
      :positive-button-props="{ loading: creating, disabled: !conversationName.trim() }" :mask-closable="!creating" :close-on-esc="!creating" @positive-click="saveConversationName">
      <NInput v-model:value="conversationName" :maxlength="100" :placeholder="t('person.conversationName')" :input-props="{ 'aria-label': t('person.conversationName') }" @keydown.enter.prevent="saveConversationName" />
      <NAlert v-if="error" type="error">{{ error }}</NAlert>
    </NModal>
    <NModal v-model:show="showDeleteConversation" preset="dialog" :title="t('chat.deleteSession')" :positive-text="t('common.confirm')" :negative-text="t('common.cancel')"
      :positive-button-props="{ loading: pending }" :mask-closable="!pending" :close-on-esc="!pending" @positive-click="confirmDeleteConversation">
      {{ t('person.deleteConversationConfirm') }}
      <NAlert v-if="error" type="error">{{ error }}</NAlert>
    </NModal>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.person-layout { display: flex; width: 100%; height: 100%; min-width: 0; min-height: 0; position: relative; }
.person-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.person-view { flex: 1; display: flex; flex-direction: column; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; color: $text-primary; background: var(--card-container-bg, var(--bg-main-surface)); }
.person-header { display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; padding: calc(21px * var(--spacing-scale, 1)) calc(20px * var(--spacing-scale, 1)); border-bottom: var(--border-width, 1px) solid $border-color; }
.header-left { display: flex; align-items: center; gap: calc(8px * var(--spacing-scale, 1)); overflow: hidden; flex: 1; min-width: 0; }
.person-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: calc(var(--font-size-base, 14px) * 16 / 14); font-weight: 600; }
.person-header-actions { display: flex; flex-shrink: 0; align-items: center; gap: 4px; }
.person-workspace-shortcuts { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
.person-alert { margin: 12px; width: auto; }
.person-compose { flex-shrink: 0; min-width: 0; }
.person-model-hint { display: block; margin: 0 auto; border: 0; background: transparent; color: $accent-primary; cursor: pointer; font: inherit; font-size: 12px; padding: 8px; }
.person-workspace { padding: 0 24px 28px; min-width: 0; }
:global(.person-setup-dialog) { width: min(420px, calc(100vw - 32px)); box-sizing: border-box; padding: 32px; border: 1px solid $border-color; border-radius: var(--radius-container, 16px); color: $text-primary; }
.person-setup-icon { display: grid; place-items: center; width: 56px; height: 56px; margin-bottom: 24px; border: 1px solid $border-color; border-radius: var(--radius-component, 12px); color: $accent-primary; }
.person-setup-dialog h2 { margin: 0 0 12px; font-size: 23px; font-weight: 600; letter-spacing: -.4px; line-height: 1.4; }
.person-setup-dialog p { margin: 0 0 28px; font-size: 14px; line-height: 1.8; color: $text-secondary; }
.workspace-heading { display: flex; align-items: center; gap: 12px; font-size: 13px; font-weight: 400; color: $text-secondary; }
.workspace-brand { font-size: 17px; font-weight: 600; letter-spacing: -.4px; color: $text-primary; }
.workspace-divider { color: $text-muted; }
.workspace-tab { display: flex; align-items: center; gap: 8px; padding: 8px 0; font-size: 13px; }
.workspace-tab-count { color: $text-muted; font-size: 11px; font-variant-numeric: tabular-nums; margin-inline-start: 4px; }
.workspace-error { margin-top: 20px; }
.person-workspace :deep(.n-tab-pane) { padding-top: 28px; }
@media (max-width: 640px) { .person-workspace { padding: 0 16px 24px; } .workspace-tab { gap: 6px; } .workspace-tab-count { display: none; } }
@media (max-width: 768px) {
  .person-sidebar :deep(.session-item) { -webkit-touch-callout: none; user-select: none; }
  .person-header { padding: calc(16px + env(safe-area-inset-top, 0px)) 12px 16px 52px; }
  .person-title { font-size: 14px; }
}
</style>
