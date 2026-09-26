<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import { usePaletteController } from '../composables/use-palette-controller'
import type { PaletteItem } from '../model/palette-items'
import PaletteOption from './PaletteOption.vue'

const uid = useId()
const listId = `${uid}-list`
const helpId = `${uid}-help`
const optionId = (index: number): string => `${uid}-option-${index}`

const { palette, view, activeIndex, message, resultsAnnouncement, onKeydown, activate, hover } =
  usePaletteController()

const input = ref<HTMLInputElement | null>(null)

const dialogLabel = computed(() =>
  palette.mode === 'goto' ? 'Buscar tabla, vista o conexión' : 'Paleta de comandos',
)
const placeholder = computed(() =>
  palette.mode === 'goto'
    ? 'Buscar tabla, vista o conexión'
    : 'Escribe un comando (\\ para comandos internos)',
)
const activeId = computed(() =>
  view.value.items.length > 0 ? optionId(activeIndex.value) : undefined,
)

interface Group {
  heading: string | null
  headingId: string
  start: number
  items: PaletteItem[]
}

// Encabezados de categoría solo cuando la lista se agrupa; los índices son globales para los ids de las opciones.
const groups = computed<Group[]>(() => {
  const result: Group[] = []
  view.value.items.forEach((item, index) => {
    const last = result[result.length - 1]
    if (last && last.heading === item.group) {
      last.items.push(item)
    } else {
      result.push({
        heading: item.group,
        headingId: `${uid}-group-${result.length}`,
        start: index,
        items: [item],
      })
    }
  })
  return result
})

const empty = computed(() => view.value.items.length === 0)

watch(
  () => palette.isOpen,
  async (open) => {
    if (!open) return
    await nextTick()
    input.value?.focus()
    input.value?.select()
  },
  { flush: 'post' },
)

watch(activeIndex, async (index) => {
  await nextTick()
  document.getElementById(optionId(index))?.scrollIntoView?.({ block: 'nearest' })
})
</script>

<template>
  <div class="palette-host">
    <p class="visually-hidden" role="status" aria-live="polite" data-part="palette-announcer">
      {{ palette.announcement }}
    </p>

    <div
      v-if="palette.isOpen"
      class="palette"
      data-command-palette
      :data-mode="palette.mode"
      @mousedown.self="palette.close()"
    >
      <div
        class="palette__panel"
        role="dialog"
        aria-modal="true"
        :aria-label="dialogLabel"
        @keydown="onKeydown"
      >
        <input
          ref="input"
          v-model="palette.query"
          type="text"
          class="palette__input"
          name="command-palette-query"
          role="combobox"
          aria-autocomplete="list"
          aria-haspopup="listbox"
          :aria-expanded="empty ? 'false' : 'true'"
          :aria-controls="listId"
          :aria-activedescendant="activeId"
          :aria-describedby="helpId"
          :aria-label="dialogLabel"
          :placeholder="placeholder"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
        />

        <p :id="helpId" class="palette__help" data-part="palette-help">{{ view.help }}</p>
        <p v-if="message" class="palette__message" role="alert" data-part="palette-message">
          {{ message }}
        </p>

        <ul :id="listId" role="listbox" class="palette__list" :aria-label="dialogLabel">
          <template v-for="group in groups" :key="group.headingId">
            <template v-if="group.heading === null">
              <PaletteOption
                v-for="(item, offset) in group.items"
                :id="optionId(group.start + offset)"
                :key="item.key"
                :item="item"
                :selected="group.start + offset === activeIndex"
                show-category
                @hover="hover(group.start + offset)"
                @choose="activate(item)"
              />
            </template>
            <li v-else role="presentation" class="palette__group">
              <span
                :id="group.headingId"
                class="palette__heading"
                data-part="palette-group-heading"
                >{{ group.heading }}</span
              >
              <ul role="group" :aria-labelledby="group.headingId">
                <PaletteOption
                  v-for="(item, offset) in group.items"
                  :id="optionId(group.start + offset)"
                  :key="item.key"
                  :item="item"
                  :selected="group.start + offset === activeIndex"
                  :show-category="false"
                  @hover="hover(group.start + offset)"
                  @choose="activate(item)"
                />
              </ul>
            </li>
          </template>
        </ul>

        <p v-if="empty" class="palette__empty" data-part="palette-empty">{{ view.emptyMessage }}</p>
        <p
          v-else-if="view.total > view.items.length"
          class="palette__empty"
          data-part="palette-truncated"
        >
          Se muestran los primeros {{ view.items.length }} de {{ view.total }}: escribe para acotar.
        </p>

        <p class="visually-hidden" role="status" aria-live="polite" data-part="palette-count">
          {{ resultsAnnouncement }}
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.palette {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 12vh var(--spacing-4) var(--spacing-4);
  background: var(--overlay-scrim);
  backdrop-filter: blur(var(--glass-blur));
  animation: palette-fade var(--motion-duration-base) var(--motion-easing-out);
}

.palette__panel {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-2);
  width: min(40rem, 100%);
  max-height: 70vh;
  padding: var(--spacing-3);
  border: 1px solid var(--dialog-border);
  border-radius: var(--radius-lg);
  background: var(--dialog-bg);
  box-shadow: var(--dialog-shadow);
  color: var(--text-primary);
  animation: palette-in var(--motion-duration-base) var(--motion-easing-expo-out);
}

.palette__input {
  width: 100%;
  min-height: 40px;
  padding: 0 var(--spacing-3);
  border: 1px solid var(--input-border);
  border-radius: var(--radius-sm);
  background-color: var(--input-bg);
  color: var(--input-fg);
  font-size: var(--font-size-md);
  transition: border-color var(--motion-duration-fast) var(--motion-easing-out);
}

.palette__input:focus-visible {
  border-color: var(--input-border-focus);
  outline-offset: 0;
}

.palette__help {
  padding-inline: var(--spacing-1);
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  line-height: var(--font-line-height-xs);
}

.palette__empty {
  padding: var(--spacing-4) var(--spacing-3);
  color: var(--text-muted);
  font-size: var(--font-size-sm);
  line-height: var(--font-line-height-sm);
  text-align: center;
}

.palette__message {
  padding: var(--spacing-2) var(--spacing-3);
  border: 1px solid var(--status-error);
  border-radius: var(--radius-sm);
  color: var(--status-error);
  font-size: var(--font-size-sm);
  line-height: var(--font-line-height-sm);
  overflow-wrap: anywhere;
}

.palette__message::before {
  content: var(--status-glyph-error);
  margin-inline-end: var(--spacing-2);
  font-weight: var(--font-weight-semibold);
}

.palette__list {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.palette__heading {
  display: block;
  padding: var(--spacing-3) var(--spacing-3) var(--spacing-1);
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  letter-spacing: 0.04em;
  line-height: var(--font-line-height-xs);
  text-transform: uppercase;
}

@keyframes palette-fade {
  from {
    opacity: 0;
  }
}

@keyframes palette-in {
  from {
    opacity: 0;
    transform: translateY(calc(-1 * var(--spacing-2))) scale(0.98);
  }
}
</style>
