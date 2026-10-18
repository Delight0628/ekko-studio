<script setup lang="ts">
import { ref } from 'vue'
import { NAlert, NButton, NForm, NFormItem, NInput, NModal, NSelect, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { addCustomProvider } from '@/api/hermes/system'
import type { ProviderImport } from '@/utils/provider-import'

const props = defineProps<{
  draft: ProviderImport
  profile: string
  profiles: Array<{ name: string }>
}>()
const emit = defineEmits<{ close: []; saved: [profile: string] }>()
const { t } = useI18n()
const message = useMessage()
const targetProfile = ref(props.profile)
const name = ref(props.draft.name)
const apiKey = ref(props.draft.apiKey || '')
const saving = ref(false)
const keyInputProps = { autocomplete: 'new-password', name: 'import-provider-api-key', 'data-1p-ignore': 'true' }

async function save() {
  if (saving.value || !props.profiles.some(p => p.name === targetProfile.value)) return
  if (!name.value.trim() || !apiKey.value.trim()) {
    message.error(t('models.importRequired'))
    return
  }
  saving.value = true
  const profile = targetProfile.value
  try {
    await addCustomProvider({
      name: name.value.trim(), base_url: props.draft.baseUrl, model: props.draft.model,
      api_key: apiKey.value.trim(), api_mode: props.draft.apiMode, create_only: true,
    }, profile)
    apiKey.value = ''
    message.success(t('models.providerAdded'))
    emit('saved', profile)
  } catch (error: any) {
    message.error(error?.status === 409 ? t('models.importDuplicate') : t('models.importFailed'))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <NModal :show="true" preset="card" :title="t('models.importTitle')"
    :style="{ width: 'min(520px, calc(100vw - 32px))' }"
    :mask-closable="!saving" :closable="!saving" :close-on-esc="!saving"
    @update:show="value => { if (!value && !saving) emit('close') }">
    <NAlert type="warning" :show-icon="false">{{ t('models.importNotice') }}</NAlert>
    <NForm label-placement="top" autocomplete="off">
      <NFormItem :label="t('workflow.profile')" required>
        <NSelect v-model:value="targetProfile" :disabled="saving"
          :options="profiles.map(p => ({ label: p.name, value: p.name }))" />
      </NFormItem>
      <NFormItem :label="t('models.provider')" required>
        <NInput v-model:value="name" :disabled="saving" :maxlength="80" :input-props="{ autocomplete: 'off', name: 'import-provider-name' }" />
      </NFormItem>
      <NFormItem :label="t('models.baseUrl')"><NInput :value="draft.baseUrl" readonly /></NFormItem>
      <NFormItem :label="t('models.defaultModel')"><NInput :value="draft.model" readonly /></NFormItem>
      <NFormItem :label="t('models.apiMode')"><NInput :value="draft.apiMode" readonly /></NFormItem>
      <NFormItem :label="t('models.apiKey')" required>
        <NInput v-model:value="apiKey" type="password" show-password-on="click" :disabled="saving"
          :input-props="keyInputProps" />
      </NFormItem>
    </NForm>
    <template #footer>
      <div class="import-actions">
        <NButton :disabled="saving" @click="emit('close')">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="saving" @click="save">{{ t('models.importConfirm') }}</NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.import-actions { display: flex; justify-content: flex-end; gap: calc(8px * var(--spacing-scale, 1)); }
</style>
