<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { NButton, NDropdown, NInput, NPagination, NSpin } from 'naive-ui'
import { fetchSessionTasks, type SessionTaskListItem } from '@/api/studio/session-tasks'
import { chatSessionAgentAvatar } from '@/utils/chat-agent-avatar'

const route = useRoute()
const router = useRouter()
const { t, locale } = useI18n()
const tasks = ref<SessionTaskListItem[]>([])
const total = ref(0)
const loading = ref(true)
const error = ref(false)
const searchOpen = ref(false)
const searchInput = ref<InstanceType<typeof NInput> | null>(null)
const search = ref(typeof route.query.search === 'string' ? route.query.search : '')
const status = computed(() => ['open', 'completed'].includes(String(route.query.status)) ? String(route.query.status) : '')
const order = computed(() => route.query.order === 'oldest' ? 'oldest' : 'newest')
const page = computed(() => {
  const value = Number(route.query.page)
  return Number.isSafeInteger(value) && value > 0 ? value : 1
})
const statusLabel = computed(() => t(status.value ? `sessionTasks.${status.value}` : 'sessionTasks.status'))
const statusOptions = computed(() => [
  { key: '', label: t('sessionTasks.all') },
  { key: 'open', label: t('sessionTasks.open') },
  { key: 'completed', label: t('sessionTasks.completed') },
])
let requestSequence = 0
let searchTimer: ReturnType<typeof setTimeout> | undefined
let refreshTimer: ReturnType<typeof setInterval> | undefined
let disposed = false

function updateQuery(change: Record<string, string | undefined>) {
  return router.replace({ query: { ...route.query, page: undefined, ...change } })
}

async function load(silent = false) {
  const sequence = ++requestSequence
  if (!silent) loading.value = true
  error.value = false
  try {
    const result = await fetchSessionTasks({ search: typeof route.query.search === 'string' ? route.query.search : '',
      status: status.value, order: order.value, page: page.value })
    if (disposed || sequence !== requestSequence) return
    tasks.value = result.tasks
    total.value = result.total
    if (page.value > 1 && !result.tasks.length && result.total > 0) {
      await updateQuery({ page: String(Math.ceil(result.total / 50)) })
    }
  } catch {
    if (!disposed && sequence === requestSequence) error.value = true
  } finally {
    if (!disposed && sequence === requestSequence) loading.value = false
  }
}

function refresh() {
  if (document.visibilityState === 'visible') void load(true)
}

async function openSearch() {
  searchOpen.value = true
  await nextTick()
  searchInput.value?.focus()
}

function handleKeydown(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    event.stopImmediatePropagation()
    void openSearch()
  }
}

function taskHref(task: SessionTaskListItem) {
  return router.resolve({ name: 'hermes.session', params: { sessionId: task.session_id },
    query: { profile: task.profile, ...(task.message_id ? { message: String(task.message_id) } : {}) } }).href
}

function formatTime(timestamp: number, compact = false) {
  const sameDay = new Date(timestamp).toDateString() === new Date().toDateString()
  const options: Intl.DateTimeFormatOptions = compact
    ? sameDay ? { hour: '2-digit', minute: '2-digit' } : { month: '2-digit', day: '2-digit' }
    : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
  return new Intl.DateTimeFormat(locale.value, options).format(timestamp)
}

watch(search, () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void updateQuery({ search: search.value.trim() || undefined }), 200)
})
watch(() => route.query, () => {
  const value = typeof route.query.search === 'string' ? route.query.search : ''
  if (search.value.trim() !== value) search.value = value
  void load()
}, { immediate: true })
onMounted(() => {
  window.addEventListener('keydown', handleKeydown, true)
  window.addEventListener('focus', refresh)
  document.addEventListener('visibilitychange', refresh)
  refreshTimer = setInterval(refresh, 30_000)
})
onUnmounted(() => {
  disposed = true
  requestSequence++
  clearTimeout(searchTimer)
  clearInterval(refreshTimer)
  window.removeEventListener('keydown', handleKeydown, true)
  window.removeEventListener('focus', refresh)
  document.removeEventListener('visibilitychange', refresh)
})
</script>

<template>
  <section class="session-tasks-view" :aria-label="t('sessionTasks.title')">
    <div class="task-list" data-theme-surface="card">
      <table :aria-label="t('sessionTasks.title')" :aria-busy="loading">
        <colgroup><col class="task-col" /><col class="source-col" /><col class="status-col" /><col class="time-col" /><col class="arrow-col" /></colgroup>
        <thead>
          <tr>
            <th scope="col" class="task-heading">
              <div class="search-heading">
                <button type="button" class="header-action" :aria-label="t('sidebar.backToChat')" @click="router.push({ name: 'hermes.chat' })">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg>
                </button>
                <template v-if="!searchOpen && !search">{{ t('sessionTasks.task') }}</template>
                <NInput v-else ref="searchInput" v-model:value="search" clearable size="small" :maxlength="200"
                  :placeholder="t('sessionTasks.search')" :input-props="{ 'aria-label': t('sessionTasks.search') }"
                  @keydown.esc="searchOpen = false; search = ''" />
                <button v-if="!searchOpen && !search" type="button" class="header-action" :aria-label="t('sessionTasks.search')" @click="openSearch">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="10.5" cy="10.5" r="7" /><path d="m16 16 5 5" /></svg>
                </button>
              </div>
            </th>
            <th scope="col" class="source-column">{{ t('sessionTasks.source') }}</th>
            <th scope="col" class="status-heading">
              <NDropdown trigger="click" :options="statusOptions" :menu-props="() => ({ role: 'menu' })"
                :node-props="option => ({ role: 'menuitem', 'aria-label': String(option.label) })"
                @select="key => updateQuery({ status: key || undefined })">
                <button type="button" class="header-action status-filter" :aria-label="t('sessionTasks.filterStatus')">
                  {{ statusLabel }}<span aria-hidden="true">⌄</span>
                </button>
              </NDropdown>
            </th>
            <th scope="col" class="time-column" :aria-sort="order === 'newest' ? 'descending' : 'ascending'">
              <button type="button" class="header-action" @click="updateQuery({ order: order === 'newest' ? 'oldest' : undefined })">
                {{ t('sessionTasks.updated') }}<span aria-hidden="true">{{ order === 'newest' ? '↓' : '↑' }}</span>
              </button>
            </th>
            <th scope="col"><span class="sr-only">{{ t('sessionTasks.openChat') }}</span></th>
          </tr>
        </thead>
        <tbody v-if="loading || error || !tasks.length">
          <tr><td colspan="5" class="list-state" role="status" aria-live="polite">
            <NSpin v-if="loading" size="small" :description="t('sessionTasks.loading')" />
            <template v-else-if="error">{{ t('sessionTasks.loadFailed') }}<NButton text @click="load()">{{ t('sessionTasks.retry') }}</NButton></template>
            <template v-else>{{ t(search || status ? 'sessionTasks.noResults' : 'sessionTasks.empty') }}</template>
          </td></tr>
        </tbody>
        <tbody v-else>
          <tr v-for="task in tasks" :key="task.id" class="task-row" :class="{ 'task-row--completed': task.status === 'completed' }">
            <td class="task-cell">
              <svg class="task-marker" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path v-if="task.status === 'completed'" d="m8 12 3 3 5-6" /></svg>
              <div class="task-copy">
                <a class="task-link" :href="taskHref(task)" :aria-label="t('sessionTasks.openTask', { title: task.title })">{{ task.title }}</a>
                <p class="task-summary">{{ task.summary }}</p>
                <div class="mobile-source"><img :src="chatSessionAgentAvatar(task).src" alt="" />{{ task.session_title || t('sessionTasks.untitled') }}</div>
              </div>
            </td>
            <td class="source-column">
              <div class="source-session"><img :src="chatSessionAgentAvatar(task).src" alt="" /><div><span>{{ task.session_title || t('sessionTasks.untitled') }}</span><small>{{ chatSessionAgentAvatar(task).label }} · {{ task.profile }}</small></div></div>
            </td>
            <td class="status-cell"><span class="task-status"><span aria-hidden="true">{{ task.status === 'completed' ? '●' : '○' }}</span>{{ t(`sessionTasks.${task.status}`) }}</span><time class="mobile-time" :datetime="new Date(task.updated_at).toISOString()">{{ formatTime(task.updated_at, true) }}</time></td>
            <td class="time-column"><time :datetime="new Date(task.updated_at).toISOString()">{{ formatTime(task.updated_at) }}</time></td>
            <td class="row-arrow" aria-hidden="true">›</td>
          </tr>
        </tbody>
      </table>
      <NPagination v-if="total > 50 && !error" class="task-pagination" :page="page" :page-size="50" :item-count="total" :page-slot="5" :disabled="loading" @update:page="value => updateQuery({ page: String(value) })" />
    </div>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.session-tasks-view { height: 100%; overflow: auto; padding: calc(34px * var(--spacing-scale, 1)) calc(48px * var(--spacing-scale, 1)); color: $text-primary; }
.task-list { max-width: 1300px; margin: 0 auto; }
table { width: 100%; table-layout: fixed; border-collapse: collapse; }
.source-col { width: 25%; }
.status-col { width: 116px; }
.time-col { width: 150px; }
.arrow-col { width: 24px; }
th { height: 48px; text-align: start; font-weight: 400; color: $text-muted; }
th, td { padding: 12px 16px; border-bottom: var(--border-width, 1px) solid $border-light; }
th:last-child, td:last-child { padding-inline: 0; }
.header-action { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 32px; padding: 4px; border: 0; border-radius: var(--radius-component, 4px); color: inherit; background: transparent; font: inherit; cursor: pointer; }
.header-action:hover { color: $text-primary; }
.header-action:focus-visible, .task-link:focus-visible { outline: 2px solid $accent-primary; outline-offset: 3px; }
.search-heading { display: flex; align-items: center; gap: 10px; max-width: 400px; }
.task-row { position: relative; }
.task-row:hover, .task-row:focus-within { background: rgba(var(--accent-primary-rgb), 0.035); }
.task-cell { height: 104px; }
.task-marker { flex-shrink: 0; color: $text-muted; vertical-align: middle; margin-inline-end: 14px; }
.task-copy { display: inline-block; width: calc(100% - 40px); min-width: 0; vertical-align: middle; }
.task-link { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: $text-primary; text-decoration: none; font-size: calc(var(--font-size-base, 14px) * 16 / 14); font-weight: 600; line-height: 1.6; }
.task-link::after { content: ''; position: absolute; inset: 0; }
.task-summary { margin: 4px 0 0; color: $text-secondary; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; line-height: 1.7; }
.source-session { display: flex; align-items: center; gap: 10px; min-width: 0; color: $text-secondary; }
.source-session img { width: 24px; height: 24px; object-fit: contain; }
.source-session div { min-width: 0; }
.source-session span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.source-session small { display: block; margin-top: 6px; color: $text-muted; }
.task-status { display: inline-flex; align-items: center; gap: 5px; padding: 4px 8px; border: var(--border-width, 1px) solid $border-light; border-radius: var(--radius-component, 5px); color: $text-secondary; font-size: calc(var(--font-size-base, 14px) * 12 / 14); white-space: nowrap; }
.task-row--completed .task-marker, .task-row--completed .task-status { color: $success; }
.task-row--completed .task-status { background: rgba(var(--success-rgb), 0.06); }
time, .row-arrow { color: $text-muted; font-size: calc(var(--font-size-base, 14px) * 12 / 14); }
.row-arrow { text-align: center; }
.mobile-source, .mobile-time { display: none; }
.list-state { height: 240px; text-align: center; color: $text-muted; }
.list-state :deep(.n-button) { margin-inline-start: 12px; }
.task-pagination { justify-content: center; padding: 24px 0; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }

@media (max-width: 768px) {
  .session-tasks-view { padding: max(10px, env(safe-area-inset-top, 0px)) 16px max(16px, env(safe-area-inset-bottom, 0px)); }
  table, thead, tbody { display: block; }
  colgroup { display: none; }
  tr { display: grid; grid-template-columns: minmax(0, 1fr) 112px 12px; }
  th, td { display: flex; align-items: center; min-width: 0; padding: 16px 4px; }
  .source-column, .time-column { display: none; }
  .task-cell { height: auto; min-height: 116px; }
  .task-marker { width: 18px; height: 18px; margin-inline-end: 10px; }
  .task-copy { width: calc(100% - 28px); }
  .task-link { font-size: var(--font-size-base, 14px); }
  .task-summary { font-size: calc(var(--font-size-base, 14px) * 12 / 14); }
  .mobile-source { display: flex; align-items: center; gap: 6px; margin-top: 6px; color: $text-muted; font-size: calc(var(--font-size-base, 14px) * 11 / 14); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .mobile-source img { width: 14px; height: 14px; object-fit: contain; }
  .status-cell { flex-direction: column; align-items: flex-start; justify-content: center; gap: 6px; padding-inline-start: 8px; }
  .task-status { font-size: calc(var(--font-size-base, 14px) * 11 / 14); padding: 4px 6px; }
  .mobile-time { display: block; white-space: nowrap; font-size: calc(var(--font-size-base, 14px) * 10 / 14); }
  .status-filter { gap: 6px; font-size: calc(var(--font-size-base, 14px) * 12 / 14); }
  .row-arrow { justify-content: center; }
  .list-state { grid-column: 1 / -1; justify-content: center; }
}
</style>
