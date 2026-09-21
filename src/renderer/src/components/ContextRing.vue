<script setup lang="ts">
import { computed } from "vue"

/**
 * How full the model's context is, drawn as a ring - the composer's usage mark.
 *
 * MiMo 26.920's ring, measured: drawn in a 16-unit square shown at 18px, a
 * circle of radius 6 under a 2.4 stroke, so 6.75 and 2.7 on screen. The track
 * is its line colour (#2e2e2e on dark, the window's weak border on light) and
 * the arc its muted text.
 *
 * The arithmetic behind `percent` belongs to session-context.ts; this component
 * only draws what it is handed.
 */
/* `size` is the ring on screen; `stroke` is in the 16-unit square it is drawn in. */
const props = withDefaults(defineProps<{ percent?: number; size?: number; stroke?: number }>(), {
  /* Zero rather than nothing: the caller decides whether to draw at all. */
  percent: 0,
  size: 18,
  stroke: 2.4,
})

/*
 * Driven by the offset over a path length of 100, not by the dash pattern:
 * only stroke-dashoffset animates, so the arc is drawn full and wound back by
 * whatever is still free. Clamped here, because a turn can be sent more than
 * the model advertises and the reading says so, but a ring stops at full.
 */
const offset = computed(() => 100 - Math.min(100, Math.max(0, props.percent)))
</script>

<template>
  <!-- Turned as a whole, so the arc starts at the top. -->
  <svg class="ring" :width="size" :height="size" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="8" cy="8" r="6" fill="none" class="ring-track" :stroke-width="stroke" />
    <circle
      cx="8"
      cy="8"
      r="6"
      fill="none"
      class="ring-arc"
      :stroke-width="stroke"
      stroke-linecap="round"
      pathLength="100"
      stroke-dasharray="100"
      :stroke-dashoffset="offset"
    />
  </svg>
</template>

<style scoped>
.ring {
  display: block;
  flex-shrink: 0;
  transform: rotate(-90deg);
}

.ring-track {
  stroke: var(--border-weak);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .ring-track {
    stroke: #2e2e2e;
  }
}

:root[data-theme="dark"] .ring-track {
  stroke: #2e2e2e;
}

.ring-arc {
  stroke: var(--text-base);
  transition: stroke-dashoffset 0.35s cubic-bezier(0.65, 0, 0.35, 1);
}
</style>
