<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NCheckbox, NCheckboxGroup, NInput, NModal, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { AvailableModelGroup } from '@/api/hermes/system'
import { useModelsStore } from '@/stores/hermes/models'
import { useAppStore } from '@/stores/hermes/app'

const props = defineProps<{ provider: AvailableModelGroup }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const message = useMessage()
const modelsStore = useModelsStore()
const appStore = useAppStore()
const sourceProvider = computed(() => modelsStore.allProviders.find(g => g.provider === props.provider.provider))
const allModels = computed(() => props.provider.available_models?.length ? props.provider.available_models : (sourceProvider.value?.models?.length ? sourceProvider.value.models : props.provider.models))
const selectedVisibleModels = ref([...props.provider.models])
const visibilitySaving = ref(false)
const modelAlias = (model: string) => appStore.getModelAlias(model, props.provider.provider)
const modelDisplayName = (model: string) => appStore.displayModelName(model, props.provider.provider)
const search = ref('')
const filteredModels = computed(() => {
  const query = search.value.trim().toLowerCase()
  if (!query) return allModels.value
  return allModels.value.filter(model => model.toLowerCase().includes(query)
    || modelDisplayName(model).toLowerCase().includes(query))
})

async function handleVisibilitySave() {
  if (selectedVisibleModels.value.length === 0) {
    message.error(t('models.visibilitySelectOne'))
    return
  }
  visibilitySaving.value = true
  try {
    const selected = selectedVisibleModels.value.filter(m => allModels.value.includes(m))
    const mode = selected.length === allModels.value.length ? 'all' : 'include'
    await appStore.setModelVisibility(props.provider.provider, { mode, models: selected })
    await modelsStore.fetchProviders()
    emit('close')
    message.success(t('models.visibilitySaved'))
  } catch (e: any) {
    message.error(e.message || t('models.visibilitySaveFailed'))
  } finally {
    visibilitySaving.value = false
  }
}

function resetVisibility() {
  selectedVisibleModels.value = [...allModels.value]
}

function clearVisibility() {
  selectedVisibleModels.value = []
}
</script>

<template>
  <NModal
    :show="true"
    @update:show="value => { if (!value && !visibilitySaving) emit('close') }"
    preset="card"
    :title="t('models.manageVisibleModelsFor', { name: provider.label })"
    :style="{ width: 'min(560px, calc(100vw - 32px))' }"
    :mask-closable="!visibilitySaving"
  >
    <p class="visibility-hint">{{ t('models.visibilityHint') }}</p>
    <div class="visibility-count">
      {{ t('models.visibilitySelectedCount', { selected: selectedVisibleModels.length, total: allModels.length }) }}
    </div>
    <NInput
      v-model:value="search"
      class="visibility-search"
      :placeholder="t('models.searchPlaceholder')"
      :input-props="{ 'aria-label': t('models.searchPlaceholder') }"
      clearable
    />
    <div class="visibility-list">
      <p v-if="filteredModels.length === 0" class="visibility-empty" role="status">{{ t('models.noResults') }}</p>
      <NCheckboxGroup v-model:value="selectedVisibleModels">
        <NCheckbox
          v-for="model in filteredModels"
          :key="model"
          :value="model"
          class="visibility-model"
        >
          <code>{{ modelDisplayName(model) }}</code>
          <code v-if="modelAlias(model)" class="visibility-model-id">{{ model }}</code>
        </NCheckbox>
      </NCheckboxGroup>
    </div>
    <div class="visibility-actions">
      <NButton size="small" quaternary :disabled="visibilitySaving" @click="resetVisibility">
        {{ t('models.showAllModels') }}
      </NButton>
      <NButton size="small" quaternary :disabled="visibilitySaving" @click="clearVisibility">
        {{ t('models.clearVisibleModels') }}
      </NButton>
      <div class="visibility-action-spacer" />
      <NButton size="small" :disabled="visibilitySaving" @click="emit('close')">
        {{ t('common.cancel') }}
      </NButton>
      <NButton size="small" type="primary" :loading="visibilitySaving" @click="handleVisibilitySave">
        {{ t('common.save') }}
      </NButton>
    </div>
  </NModal>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.visibility-hint {
  margin: 0 0 10px;
  color: $text-secondary;
  font-size: 13px;
  line-height: 1.5;
}

.visibility-count {
  color: $text-muted;
  font-size: 12px;
  margin-bottom: 10px;
}

.visibility-list {
  max-height: 360px;
  overflow-y: auto;
  border: 1px solid $border-light;
  border-radius: $radius-sm;
  padding: 8px;
}

.visibility-search {
  margin-bottom: 10px;
}

.visibility-empty {
  margin: 16px 0;
  color: $text-muted;
  text-align: center;
}

.visibility-model {
  display: flex;
  width: 100%;
  padding: 4px 2px;

  code {
    font-family: $font-code;
    font-size: 12px;
    color: $text-secondary;
  }
}

.visibility-model-id {
  margin-inline-start: 6px;
  color: $text-muted !important;
  font-size: 11px !important;
}

.visibility-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
}

.visibility-action-spacer {
  flex: 1;
}
</style>
