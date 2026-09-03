<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import type { Find } from "../lib/find"
import { t } from "../lib/i18n"

/**
 * The find-in-view bar: a needle, a position, two steps and a close.
 *
 * Shaped after opencode's `FileSearchBar` (main-8t-QUXax.js @1393688), down to
 * its measurements - a 32px pill with an 8px gap and 12px of inset, a 160px
 * input, a 10ch right-aligned tabular counter that reads `0/0` before anything
 * matches, 24px icon buttons, and the two steps disabled rather than hidden
 * while the count is zero. The three glyphs are its own sprite's paths.
 *
 * It floats over the pane rather than sitting inside it, so opening it neither
 * reflows the conversation nor takes a row from it. The reference does the same
 * with a Portal and a fixed position measured off the viewer; this measures off
 * whatever element it is anchored to, and re-measures on resize because the
 * pane's width moves with the review panel.
 */
const props = defineProps<{
  find: Find
  /** The pane the bar hangs inside, top trailing corner. */
  anchor: () => HTMLElement | undefined
}>()

const input = ref<HTMLInputElement>()
const box = ref({ top: 0, end: 0 })

/** Where the bar sits: just inside the anchor's top trailing corner. */
function measure(): void {
  const host = props.anchor()
  if (!host) return
  const rect = host.getBoundingClientRect()
  box.value = { top: Math.round(rect.top + 12), end: Math.round(window.innerWidth - rect.right + 12) }
}

const style = computed(() => ({ top: `${box.value.top}px`, insetInlineEnd: `${box.value.end}px` }))

/** `0/0` until something matches, then the reference's one-based position. */
const position = computed(() =>
  props.find.count.value ? `${props.find.index.value + 1}/${props.find.count.value}` : "0/0",
)

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
  <div v-if="find.open.value" class="find" :style="style" @pointerdown.stop>
    <svg class="ico" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M13 13L10.6418 10.6418M11.9552 7.47761C11.9552 9.95053 9.95053 11.9552 7.47761 11.9552C5.0047 11.9552 3 9.95053 3 7.47761C3 5.0047 5.0047 3 7.47761 3C9.95053 3 11.9552 5.0047 11.9552 7.47761Z"
        stroke="currentColor"
        stroke-linecap="square"
        vector-effect="non-scaling-stroke"
      />
    </svg>

    <input
      ref="input"
      class="needle"
      :placeholder="t('ui.fileSearch.placeholder')"
      :value="find.query.value"
      @input="find.setQuery(($event.target as HTMLInputElement).value)"
      @keydown="find.onInputKeydown($event)"
    />

    <div class="count">{{ position }}</div>

    <div class="steps">
      <button
        type="button"
        class="step"
        :disabled="find.count.value === 0"
        :aria-label="t('ui.fileSearch.previousMatch')"
        @click="find.next(-1)"
      >
        <svg class="ico back" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M6.6665 8.33325L9.99984 11.6666L13.3332 8.33325" stroke="currentColor" stroke-linecap="square" />
        </svg>
      </button>
      <button
        type="button"
        class="step"
        :disabled="find.count.value === 0"
        :aria-label="t('ui.fileSearch.nextMatch')"
        @click="find.next(1)"
      >
        <svg class="ico" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M6.6665 8.33325L9.99984 11.6666L13.3332 8.33325" stroke="currentColor" stroke-linecap="square" />
        </svg>
      </button>
    </div>

    <button type="button" class="step" :aria-label="t('ui.fileSearch.close')" @click="find.close()">
      <svg class="ico" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path d="M6 6L14 14M14 6L6 14" stroke="currentColor" stroke-linecap="square" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
/* `fixed z-50 flex h-8 items-center gap-2 rounded-md border px-3 shadow-md`. */
.find {
  position: fixed;
  z-index: 50;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding-inline: 12px;
  background: var(--surface-base);
  border: 1px solid var(--border-base);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md, 0 4px 12px rgb(0 0 0 / 0.28));
}

/* `w-40 bg-transparent outline-none text-14-regular text-text-strong`. */
.needle {
  width: 160px;
  background: transparent;
  border: none;
  outline: none;
  color: var(--text-strong);
  font-size: 14px;
}

.needle::placeholder {
  color: var(--text-weak);
}

/*
 * A fixed 10ch so the two step buttons do not shuffle sideways as the count
 * goes from 1/9 to 10/99 - which is the whole reason the reference pins it.
 */
.count {
  flex-shrink: 0;
  width: 10ch;
  color: var(--text-weak);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  text-align: end;
}

.steps {
  display: flex;
  align-items: center;
}

/* `size-6 grid place-items-center rounded` with the weak/strong hover pair. */
.step {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  color: var(--text-weak);
  border-radius: var(--radius-sm, 4px);
}

.step:hover:not(:disabled) {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.step:disabled {
  opacity: 0.4;
  pointer-events: none;
}

.ico {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

.back {
  transform: rotate(180deg);
}
</style>
