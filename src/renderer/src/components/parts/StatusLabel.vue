<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from "vue"
import TextShimmer from "./TextShimmer.vue"

/**
 * A label that changes as work finishes, without the line jumping.
 *
 * "Exploring" becoming "Explored" is a different word of a different width, so
 * replacing one with the other shifts everything after it. Both sit in the same
 * grid cell instead and cross-fade, and the cell's width is animated from one
 * to the other - so the sentence rearranges itself smoothly rather than
 * snapping.
 */
const props = withDefaults(
  defineProps<{
    /** Shown while the work is still going, and given the shimmer. */
    activeText: string
    /** Shown once it is done. */
    doneText: string
    active: boolean
  }>(),
  {},
)

const activeEl = ref<HTMLElement>()
const doneEl = ref<HTMLElement>()

/** The width of whichever label is showing, in pixels. */
const width = ref<number>()

/**
 * Off for the first frame.
 *
 * A row that arrives already finished should not animate from the running
 * label it never showed.
 */
const ready = ref(false)

async function measure() {
  await nextTick()
  const el = props.active ? activeEl.value : doneEl.value
  if (el) width.value = el.getBoundingClientRect().width
}

onMounted(async () => {
  await measure()
  /*
   * A frame if the window is drawing, a tick if it is not: rAF is held back
   * while the window is hidden, and a row that mounted in the background would
   * otherwise stay frozen with its transitions switched off.
   */
  requestAnimationFrame(() => (ready.value = true))
  setTimeout(() => (ready.value = true), 50)
})

watch(() => [props.active, props.activeText, props.doneText], measure)
</script>

<template>
  <span
    class="status"
    :data-active="String(props.active)"
    :data-ready="String(ready)"
    aria-live="polite"
    aria-atomic="true"
  >
    <span class="swap" :style="width !== undefined ? { width: `${width}px` } : undefined">
      <span ref="activeEl" class="side on" :aria-hidden="props.active ? undefined : 'true'">
        <TextShimmer :text="props.activeText" :active="props.active" />
      </span>
      <span ref="doneEl" class="side off" :aria-hidden="props.active ? 'true' : undefined">{{ props.doneText }}</span>
    </span>
  </span>
</template>

<style scoped>
.status {
  display: inline-flex;
  align-items: baseline;
  text-align: start;
  white-space: nowrap;
}

/* Both labels share one cell; the cell is what changes size. */
.swap {
  display: inline-grid;
  overflow: hidden;
  justify-items: start;
  transition: width var(--tool-motion-spring-ms) var(--tool-motion-ease);
}

.side {
  grid-area: 1 / 1;
  justify-self: start;
  text-align: start;
  white-space: nowrap;
  transition-property: opacity, filter, transform;
  transition-duration: var(--tool-motion-fade-ms), calc(var(--tool-motion-fade-ms) * 0.8),
    calc(var(--tool-motion-fade-ms) * 0.8);
  transition-timing-function: ease-out, ease-out, ease-out;
}

/*
 * The one on its way out is blurred a little and nudged down, so the swap
 * reads as one word settling into another rather than two words flickering.
 */
.side.on {
  opacity: 0;
  filter: blur(calc(var(--tool-motion-blur) * 0.45));
  transform: translateY(0.03em);
}

.side.off {
  color: var(--text-strong);
  opacity: 1;
  transform: translateY(0);
}

.status[data-active="true"] .side.on {
  opacity: 1;
  filter: none;
  transform: translateY(0);
}

.status[data-active="true"] .side.off {
  opacity: 0;
  filter: blur(calc(var(--tool-motion-blur) * 0.45));
  transform: translateY(0.03em);
}

/* The first paint lands on the right word instead of travelling to it. */
.status[data-ready="false"] .swap,
.status[data-ready="false"] .side {
  transition-duration: 0s;
}

@media (prefers-reduced-motion: reduce) {
  .swap,
  .side {
    transition-duration: 0s;
  }

  .side {
    filter: none !important;
    transform: none !important;
  }
}
</style>
