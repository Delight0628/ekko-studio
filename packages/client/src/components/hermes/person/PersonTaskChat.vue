<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NDrawer, NDrawerContent, NSpin } from 'naive-ui'
import { useTaskDrawerLayout } from '@/components/hermes/tasks/useTaskDrawerLayout'
import MessageList from '@/components/hermes/chat/MessageList.vue'
import ChatInput from '@/components/hermes/chat/ChatInput.vue'
import { provideScopedChatStore, buildContentBlocks, uploadFiles, type Attachment } from '@/stores/hermes/chat'
import { personRequest, type PersonTask } from '@/api/person'
import { onPersonUpdated } from '@/api/studio/chat'
import type { SessionSummary } from '@/api/studio/sessions'
const props = defineProps<{ taskId: string; mainSessionId: string }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const { drawerWidth } = useTaskDrawerLayout()
const store = provideScopedChatStore(`person-task-${props.taskId}`)
const task = ref<PersonTask | null>(null)
const session = ref<SessionSummary | null>(null)
const ready = ref(false)
const closing = ref(false)
const sending = ref(false)
const error = ref('')
const lifetime = new AbortController()
let sequence = 0
const disabled = computed(() => !ready.value || closing.value || sending.value || !!task.value?.running || task.value?.status === 'closed' || store.isRunActive)
async function refresh() {
  const request = ++sequence
  try {
    const result = await personRequest<{ task: PersonTask; session: SessionSummary }>(`/tasks/${encodeURIComponent(props.taskId)}/chat`, undefined, 'GET', lifetime.signal)
    if (lifetime.signal.aborted || request !== sequence) return false
    task.value = result.task; session.value = result.session
    return true
  } catch (e) { if (!lifetime.signal.aborted) error.value = String(e); return false }
}
const stopUpdates = onPersonUpdated(event => { if (event.session_id === props.mainSessionId && ready.value) void refresh() })
onMounted(async () => {
  if (!await refresh() || !session.value) return
  store.ensureSessionLoaded(session.value)
  await store.switchSession(session.value.id)
  if (!lifetime.signal.aborted) ready.value = true
})
async function send(text: string, attachments?: Attachment[]) {
  if (disabled.value || !task.value) return false
  sending.value = true; error.value = ''
  try {
    const input = await buildContentBlocks(text, attachments, await uploadFiles(attachments || []))
    const result = await personRequest<{ task: PersonTask }>(`/tasks/${encodeURIComponent(props.taskId)}/chat`, {
      input, expected_revision: task.value.revision, idempotency_key: crypto.randomUUID(),
    }, 'POST', lifetime.signal)
    sequence++; task.value = result.task
    return true
  } catch (e) { if (!lifetime.signal.aborted) { error.value = String(e); await refresh() }; return false }
  finally { sending.value = false }
}
async function close() {
  if (closing.value) return
  closing.value = true; lifetime.abort(); stopUpdates()
  emit('close')
}
onBeforeUnmount(() => { lifetime.abort(); stopUpdates() })
</script>

<template>
  <NDrawer :show="!closing" placement="right" :width="drawerWidth" class="person-task-chat" :aria-label="task?.title || t('person.tasks')" @update:show="value => { if (!value) void close() }">
    <NDrawerContent :title="task?.title || t('person.tasks')" closable :native-scrollbar="true"
      :body-content-style="{ padding: '0', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }">
      <NAlert v-if="error" type="error" class="task-chat-alert">{{ error }}</NAlert>
      <div v-if="!ready" class="task-chat-loading"><NSpin /></div>
      <template v-else>
        <MessageList />
        <ChatInput :submit="send" :send-disabled="disabled" stop-disabled :model-label="session?.model || ''" model-disabled reasoning-effort-disabled />
      </template>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped lang="scss">
.task-chat-alert { margin: 12px; flex-shrink: 0; }
.task-chat-loading { flex: 1; display: grid; place-items: center; }
</style>
