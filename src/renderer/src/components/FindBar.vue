<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import type { Find } from "../lib/find"
import { t } from "../lib/i18n"

/**
 * Find in the conversation, as MiMo draws it: a floating card 54px below the
 * top of the conversation pane and 20px in from its end, holding a 15px glass,
 * a 180px field, the count, previous / next and close.
 *
 * The count is MiMo's: `cur/total` with 0 before anything is selected, "no
 * matches" once a needle finds nothing, and `cur/total(未展开 N)` when some of
 * the matches sit in folded steps that are not on screen.
 */
const props = defineProps<{
  find: Find
  /** The pane the bar hangs inside, top trailing corner. */
  anchor: () => HTMLElement | undefined
}>()

const input = ref<HTMLInputElement>()
const box = ref({ top: 0, end: 0 })

function measure(): void {
  const host = props.anchor()
  if (!host) return
  const rect = host.getBoundingClientRect()
  box.value = { top: Math.round(rect.top + 54), end: Math.round(window.innerWidth - rect.right + 20) }
}

const style = computed(() => ({ top: `${box.value.top}px`, insetInlineEnd: `${box.value.end}px` }))

const label = computed(() => {
  const visible = props.find.count.value
  const hidden = props.find.hidden.value
  const total = visible + hidden
  if (total === 0 && props.find.query.value.trim()) return t("stream.find.empty")
  const cur = visible ? props.find.index.value + 1 : 0
  return hidden > 0 ? t("stream.find.countHidden", { cur, total, hidden }) : `${cur}/${total}`
})

watch(
  () => props.find.open.value,
  (open) => {
    if (!open) return
    measure()
    props.find.focus()
  },
)

onMounted(() => {
  props.find.setInput(input.value)
  window.addEventListener("resize", measure)
  measure()
})
onBeforeUnmount(() => {
  props.find.setInput(undefined)
  window.removeEventListener("resize", measure)
})

watch(input, (element) => props.find.setInput(element))
</script>

<template>
  <div v-if="find.open.value" class="find" data-find-bar :style="style" @pointerdown.stop>
    <svg class="glass" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2" />
      <path d="m20 20-4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    </svg>

    <input
      ref="input"
      class="needle"
      :placeholder="t('stream.find.placeholder')"
      :value="find.query.value"
      @input="find.setQuery(($event.target as HTMLInputElement).value)"
      @keydown="find.onInputKeydown($event)"
    />

    <span class="count" data-find-count>{{ label }}</span>

    <button
      type="button"
      class="step"
      data-find-prev
      :disabled="find.count.value === 0"
      :aria-label="t('stream.find.prev')"
      @click="find.next(-1)"
    >
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="m18 15-6-6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
    <button
      type="button"
      class="step"
      data-find-next
      :disabled="find.count.value === 0"
      :aria-label="t('stream.find.next')"
      @click="find.next(1)"
    >
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="m6 9 6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
    <button type="button" class="step" data-find-close :aria-label="t('stream.find.close')" @click="find.close()">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
/*
 * The card never grows past the width MiMo draws it at with a 42px count:
 * a longer count ("1/12 (3 masqués)") takes its room from the field instead,
 * so a translated count cannot push the card across the reading column.
 */
.find {
  position: fixed;
  z-index: 170;
  display: flex;
  align-items: center;
  gap: 6px;
  max-inline-size: calc(2 * 10px + 2 * 1px + 15px + 180px + 42px + 3 * 22px + 5 * 6px);
  padding: 6px 10px;
  /* MiMo's --color-bg: #fffefd on light, #181818 on dark (below). */
  background: #fffefd;
  border: 1px solid var(--border-weak);
  border-radius: 10px;
  box-shadow: 0 4px 16px rgb(0 0 0 / 0.14);
}

.glass {
  flex-shrink: 0;
  width: 15px;
  height: 15px;
  color: var(--text-base);
}

.needle {
  flex: 0 1 180px;
  width: 180px;
  min-inline-size: 72px;
  color: #151c13cc;
  font-size: calc(13px * var(--ui-font-scale, 1));
  background: transparent;
  border: none;
  outline: none;
}

.needle::placeholder {
  color: var(--text-weak);
}

.count {
  flex-shrink: 0;
  min-width: 42px;
  color: var(--text-weak);
  font-size: calc(11px * var(--ui-font-scale, 1));
  font-variant-numeric: tabular-nums;
  text-align: center;
  white-space: nowrap;
}

.step {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  color: var(--text-base);
  background: transparent;
  border: 0;
  border-radius: 6px;
}

.step svg {
  width: 15px;
  height: 15px;
}

.step:hover:not(:disabled) {
  background: var(--surface-hover);
}

.step:disabled {
  opacity: 0.4;
}

/*
 * MiMo's --color-txt on the dark scheme (#f4f4f5); lane F1 is adding a token
 * for it, so the pair is written out here.
 */
:root[data-theme="dark"] .find {
  background: #181818;
}

:root[data-theme="dark"] .needle {
  color: #f4f4f5;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .find {
    background: #181818;
  }

  :root:not([data-theme="light"]) .needle {
    color: #f4f4f5;
  }
}
</style>
