<script setup lang="ts">
import { ref } from 'vue'
import { NButton, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { desktopBridge, type DesktopBrowserDownload, type DesktopBrowserState } from '@/utils/desktop-bridge'

const props = defineProps<{ item: DesktopBrowserDownload }>()
const emit = defineEmits<{ state: [value: DesktopBrowserState] }>()
const { t } = useI18n()
const message = useMessage()
const busy = ref(false)
const bridge = desktopBridge()?.browser
const errorKeys: Record<string, string> = {
  BROWSER_DOWNLOAD_ACTIVE: 'downloadActive',
  BROWSER_DOWNLOAD_NOT_FOUND: 'downloadNotFound',
  BROWSER_DOWNLOAD_FILE_UNAVAILABLE: 'downloadFileUnavailable',
  BROWSER_DOWNLOAD_OPEN_FAILED: 'downloadOpenFailed',
}
async function act(action: 'open' | 'reveal' | 'remove' | 'trash') {
  if (busy.value || !bridge?.downloadAction) return
  busy.value = true
  try { emit('state', await bridge.downloadAction(props.item.id, action)) }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const key = Object.keys(errorKeys).find(key => detail.includes(key))
    message.error(t(`browser.${key ? errorKeys[key] : 'downloadActionFailed'}`))
  } finally { busy.value = false }
}
</script>

<template>
  <div v-if="bridge?.downloadAction" class="download-actions" data-desktop-browser-overlay>
    <template v-if="item.state === 'completed' && item.savePath">
      <NButton size="tiny" text :disabled="busy" @click="act('open')">{{ t('browser.openDownload') }}</NButton>
      <NButton size="tiny" text :disabled="busy" @click="act('reveal')">{{ t('browser.revealDownload') }}</NButton>
    </template>
    <template v-if="item.state !== 'progressing'">
      <NButton size="tiny" text :disabled="busy" @click="act('remove')">{{ t('browser.removeDownload') }}</NButton>
      <NButton v-if="item.state === 'completed' && item.savePath" size="tiny" text type="error" :disabled="busy" @click="act('trash')">{{ t('browser.trashDownload') }}</NButton>
    </template>
  </div>
</template>

<style scoped lang="scss">
.download-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: calc(8px * var(--spacing-scale, 1)) calc(12px * var(--spacing-scale, 1));
}
</style>
