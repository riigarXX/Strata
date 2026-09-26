<script setup lang="ts">
import type { ConnectionProfile, Engine, SslMode } from '@strata/contracts'
import { computed, nextTick, onBeforeUnmount, reactive, ref, useId, watch } from 'vue'
import FormField from '../../../components/FormField.vue'
import { useConnectionsApi } from '../api/use-connections-api'
import { ENGINE_LABELS, SSL_LABELS, describeError, endSentence } from '../model/presentation'
import {
  FIELD_ORDER,
  buildRequest,
  draftFromProfile,
  hasStoredPassword,
  requiresPasswordReentry,
  type FieldErrors,
  type ProfileDraft,
} from '../model/profile-form'

const props = defineProps<{
  /** Perfil que se edita; `null` para crear uno nuevo. */
  profile: ConnectionProfile | null
  titleId: string
}>()

const emit = defineEmits<{
  cancel: []
  /** `passwordSent`: se envió una password nueva, así que main pudo cerrar la sesión abierta. */
  saved: [profile: ConnectionProfile, passwordSent: boolean]
}>()

type TestOutcome =
  { status: 'ok'; serverVersion: string; latencyMs: number } | { status: 'failed'; message: string }

const api = useConnectionsApi()
const uid = useId()
const form = ref<HTMLFormElement | null>(null)

// La password vive solo aquí, en el estado local del formulario: nunca en Pinia ni en props/emits.
const draft = reactive<ProfileDraft>(draftFromProfile(props.profile))
const errors = ref<FieldErrors>({})
const submitError = ref('')
const testOutcome = ref<TestOutcome | null>(null)
const saving = ref(false)
const testing = ref(false)
const picking = ref(false)

const editing = computed(() => props.profile !== null)
const isPostgres = computed(() => draft.engine === 'postgres')
const passwordReentryNeeded = computed(() => requiresPasswordReentry(draft, props.profile))
const passwordHint = computed(() => {
  if (passwordReentryNeeded.value) {
    return 'Has cambiado el host, el puerto o el usuario: vuelve a escribir la contraseña.'
  }
  return hasStoredPassword(props.profile) && isPostgres.value
    ? 'Déjala vacía para conservar la contraseña guardada.'
    : undefined
})

const engines = Object.keys(ENGINE_LABELS) as Engine[]
const sslModes = Object.keys(SSL_LABELS) as SslMode[]

// Cualquier cambio invalida el resultado de la prueba y el error del campo editado.
watch(
  () => ({ ...draft }),
  (now, before) => {
    testOutcome.value = null
    submitError.value = ''
    for (const field of FIELD_ORDER) {
      if (now[field] !== before[field]) delete errors.value[field]
    }
  },
)

onBeforeUnmount(() => {
  draft.password = ''
})

async function focusFirstInvalid(): Promise<void> {
  await nextTick()
  form.value?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
}

async function pickFile(): Promise<void> {
  if (picking.value) return
  picking.value = true
  const result = await api.pickSqliteFile()
  picking.value = false
  if (!result.ok) {
    errors.value.filePath = describeError(result.error)
    await focusFirstInvalid()
  } else if (result.data.filePath !== null) {
    draft.filePath = result.data.filePath
  }
}

async function testConnection(): Promise<void> {
  if (testing.value || saving.value) return
  const built = buildRequest(draft, props.profile)
  if (!built.ok) {
    errors.value = built.errors
    await focusFirstInvalid()
    return
  }

  testing.value = true
  testOutcome.value = null
  const result = await api.test(built.request)
  testing.value = false
  if (!result.ok) {
    testOutcome.value = { status: 'failed', message: describeError(result.error) }
  } else if (result.data.ok) {
    const { serverVersion, latencyMs } = result.data
    testOutcome.value = { status: 'ok', serverVersion, latencyMs }
  } else {
    testOutcome.value = { status: 'failed', message: describeError(result.data.error) }
  }
}

async function submit(): Promise<void> {
  if (saving.value) return
  const built = buildRequest(draft, props.profile)
  if (!built.ok) {
    errors.value = built.errors
    await focusFirstInvalid()
    return
  }

  const passwordSent = built.request.engine === 'postgres' && built.request.password !== undefined
  // La password ya viaja en la petición: se borra del estado local antes de esperar la respuesta.
  draft.password = ''
  saving.value = true
  submitError.value = ''
  const result =
    'id' in built.request ? await api.update(built.request) : await api.create(built.request)
  saving.value = false

  if (!result.ok) {
    submitError.value = passwordSent
      ? `${endSentence(describeError(result.error))} Vuelve a escribir la contraseña antes de reintentarlo.`
      : describeError(result.error)
    return
  }
  emit('saved', result.data, passwordSent)
}

function selectEngine(engine: Engine): void {
  draft.engine = engine
  if (engine === 'sqlite') draft.password = ''
  errors.value = {}
}
</script>

<template>
  <form ref="form" class="connection-form" novalidate @submit.prevent="submit">
    <h2 :id="titleId" class="connection-form__title">
      {{ editing ? 'Editar conexión' : 'Nueva conexión' }}
    </h2>

    <FormField label="Nombre" :error="errors.name" v-slot="{ id, describedBy, invalid }">
      <input
        :id="id"
        v-model="draft.name"
        type="text"
        name="name"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        autofocus
        required
        :aria-describedby="describedBy"
        :aria-invalid="invalid ? 'true' : undefined"
      />
    </FormField>

    <FormField label="Motor" :error="errors.engine" v-slot="{ id, describedBy, invalid }">
      <select
        :id="id"
        name="engine"
        :value="draft.engine"
        :aria-describedby="describedBy"
        :aria-invalid="invalid ? 'true' : undefined"
        @change="selectEngine(($event.target as HTMLSelectElement).value as Engine)"
      >
        <option v-for="engine in engines" :key="engine" :value="engine">
          {{ ENGINE_LABELS[engine] }}
        </option>
      </select>
    </FormField>

    <template v-if="isPostgres">
      <FormField label="Host" :error="errors.host" v-slot="{ id, describedBy, invalid }">
        <input
          :id="id"
          v-model="draft.host"
          type="text"
          class="mono"
          name="host"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          required
          :aria-describedby="describedBy"
          :aria-invalid="invalid ? 'true' : undefined"
        />
      </FormField>

      <FormField label="Puerto" :error="errors.port" v-slot="{ id, describedBy, invalid }">
        <input
          :id="id"
          v-model="draft.port"
          type="text"
          class="mono"
          inputmode="numeric"
          name="port"
          autocomplete="off"
          required
          :aria-describedby="describedBy"
          :aria-invalid="invalid ? 'true' : undefined"
        />
      </FormField>

      <FormField label="Usuario" :error="errors.user" v-slot="{ id, describedBy, invalid }">
        <input
          :id="id"
          v-model="draft.user"
          type="text"
          class="mono"
          name="user"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          required
          :aria-describedby="describedBy"
          :aria-invalid="invalid ? 'true' : undefined"
        />
      </FormField>

      <FormField
        label="Base de datos"
        :error="errors.database"
        v-slot="{ id, describedBy, invalid }"
      >
        <input
          :id="id"
          v-model="draft.database"
          type="text"
          class="mono"
          name="database"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          required
          :aria-describedby="describedBy"
          :aria-invalid="invalid ? 'true' : undefined"
        />
      </FormField>

      <FormField label="SSL" :error="errors.ssl" v-slot="{ id, describedBy, invalid }">
        <select
          :id="id"
          v-model="draft.ssl"
          name="ssl"
          :aria-describedby="describedBy"
          :aria-invalid="invalid ? 'true' : undefined"
        >
          <option v-for="mode in sslModes" :key="mode" :value="mode">{{ SSL_LABELS[mode] }}</option>
        </select>
      </FormField>

      <FormField
        label="Contraseña"
        :error="errors.password"
        :hint="passwordHint"
        v-slot="{ id, describedBy, invalid }"
      >
        <input
          :id="id"
          v-model="draft.password"
          type="password"
          name="password"
          autocomplete="off"
          :aria-required="passwordReentryNeeded ? 'true' : undefined"
          :aria-describedby="describedBy"
          :aria-invalid="invalid ? 'true' : undefined"
        />
      </FormField>
    </template>

    <template v-else>
      <FormField
        label="Archivo SQLite"
        :error="errors.filePath"
        :hint="draft.filePath ? undefined : 'Ningún archivo elegido.'"
        v-slot="{ id, describedBy, invalid }"
      >
        <div class="connection-form__file">
          <input
            :id="id"
            :value="draft.filePath"
            type="text"
            class="mono"
            name="filePath"
            readonly
            :aria-describedby="describedBy"
            :aria-invalid="invalid ? 'true' : undefined"
          />
          <button
            type="button"
            class="btn btn--secondary connection-form__pick"
            data-action="pick-file"
            :aria-disabled="picking ? 'true' : undefined"
            @click="pickFile"
          >
            Elegir archivo…
          </button>
        </div>
      </FormField>
    </template>

    <div class="form-field form-field--checkbox">
      <label class="form-field__label">
        <input
          v-model="draft.readOnly"
          type="checkbox"
          name="readOnly"
          :aria-describedby="`${uid}-readonly`"
        />
        Solo lectura
      </label>
      <p :id="`${uid}-readonly`" class="form-field__hint">
        Bloquea las sentencias que modifican datos o el esquema en esta conexión.
      </p>
    </div>

    <div class="connection-form__test" aria-live="polite">
      <p
        v-if="testing"
        class="callout callout--running connection-form__test-result"
        data-result="running"
      >
        Probando la conexión…
      </p>
      <p
        v-else-if="testOutcome?.status === 'ok'"
        class="callout callout--success connection-form__test-result"
        data-result="ok"
      >
        Conexión correcta. Servidor: {{ testOutcome.serverVersion }} ({{
          Math.round(testOutcome.latencyMs)
        }}
        ms).
      </p>
      <p
        v-else-if="testOutcome?.status === 'failed'"
        class="callout callout--error connection-form__test-result"
        data-result="failed"
        role="alert"
      >
        <strong>La prueba falló.</strong> {{ testOutcome.message }}
      </p>
    </div>

    <p v-if="submitError" class="callout callout--error connection-form__error" role="alert">
      <strong>No se pudo guardar la conexión.</strong> {{ submitError }}
    </p>

    <div class="connection-form__actions">
      <button
        type="button"
        class="btn btn--secondary connection-form__button connection-form__test-action"
        data-action="test"
        :aria-disabled="testing ? 'true' : undefined"
        @click="testConnection"
      >
        Probar conexión
      </button>
      <button
        type="button"
        class="btn btn--secondary connection-form__button"
        data-action="cancel"
        @click="emit('cancel')"
      >
        Cancelar
      </button>
      <button
        type="submit"
        class="btn btn--primary connection-form__button"
        data-action="save"
        :aria-disabled="saving ? 'true' : undefined"
      >
        {{ saving ? 'Guardando…' : editing ? 'Guardar cambios' : 'Crear conexión' }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.connection-form {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: var(--spacing-4);
  padding: var(--spacing-6) var(--spacing-6) 0;
}

.connection-form > * {
  grid-column: 1 / -1;
}

.connection-form__title {
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  line-height: var(--font-line-height-lg);
}

.connection-form__file {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-2);
}

.connection-form .connection-form__file input {
  flex: 1 1 12rem;
  min-width: 0;
  width: auto;
}

.connection-form .connection-form__file .btn {
  flex: none;
}

.connection-form__test:empty {
  margin-block-start: calc(-1 * var(--spacing-4));
}

.connection-form__actions {
  position: sticky;
  bottom: 0;
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-2);
  margin: 0 calc(-1 * var(--spacing-6));
  padding: var(--spacing-4) var(--spacing-6);
  border-top: 1px solid var(--dialog-border);
  background: var(--dialog-bg);
}

.connection-form__test-action {
  margin-inline-end: auto;
}

@media (min-width: 40rem) {
  .connection-form :deep(.form-field:has([name='host'])) {
    grid-column: span 4;
  }

  .connection-form :deep(.form-field:has([name='port'])) {
    grid-column: span 2;
  }

  .connection-form
    :deep(.form-field:has([name='user'], [name='database'], [name='ssl'], [name='password'])) {
    grid-column: span 3;
  }
}
</style>
