<script setup lang="ts">
import { computed, useId } from 'vue'

const props = defineProps<{
  label: string
  error?: string | undefined
  hint?: string | undefined
}>()

const uid = useId()
const controlId = `${uid}-control`
const hintId = computed(() => (props.hint ? `${uid}-hint` : undefined))
const errorId = computed(() => (props.error ? `${uid}-error` : undefined))
const describedBy = computed(
  () => [hintId.value, errorId.value].filter(Boolean).join(' ') || undefined,
)
</script>

<template>
  <div class="form-field" :data-invalid="error ? 'true' : undefined">
    <label class="form-field__label" :for="controlId">{{ label }}</label>
    <slot :id="controlId" :describedBy="describedBy" :invalid="Boolean(error)" />
    <p v-if="hint" :id="hintId" class="form-field__hint">{{ hint }}</p>
    <p v-if="error" :id="errorId" class="form-field__error">{{ error }}</p>
  </div>
</template>
