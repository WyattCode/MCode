<script setup lang="ts">
/**
 * Text with a highlight travelling through it while something is running.
 *
 * Two copies of the same string sit on top of each other: the resting one, and
 * one whose letters are painted by a moving gradient clipped to the glyphs.
 * Swapping between them rather than animating a colour is what keeps the
 * layout still - both copies occupy the same cell of a grid, so the line never
 * shifts when the shimmer starts or stops.
 */
const props = withDefaults(
  defineProps<{
    text: string
    /** Whether the sweep is running. */
    active?: boolean
    /**
     * Position in a list of shimmering rows.
     *
     * Each row starts its sweep a step earlier than the one before it, so a
     * column of them reads as one wave rather than as several loops in sync.
     */
    index?: number
  }>(),
  { active: false, index: 0 },
)
</script>

<template>
  <span
    class="shimmer"
    :data-active="String(props.active)"
    :style="{ '--text-shimmer-index': String(props.index) }"
    :aria-label="props.text"
    :aria-busy="props.active ? 'true' : undefined"
  >
    <span class="char">
      <span class="base" aria-hidden="true">{{ props.text }}</span>
      <span class="sweep" aria-hidden="true" :data-run="String(props.active)">{{ props.text }}</span>
    </span>
  </span>
</template>

<style scoped>
.shimmer {
  --text-shimmer-step: 45ms;
  --text-shimmer-duration: 1.2s;
  --text-shimmer-swap: 0.22s;
  --text-shimmer-index: 0;
  --text-shimmer-angle: 90deg;
  --text-shimmer-spread: 5.2ch;
  --text-shimmer-size: 360%;
  --text-shimmer-base-color: var(--text-weak);
  --text-shimmer-peak-color: var(--text-strong);
  --text-shimmer-sweep: linear-gradient(
    var(--text-shimmer-angle),
    transparent calc(50% - var(--text-shimmer-spread)),
    var(--text-shimmer-peak-color) 50%,
    transparent calc(50% + var(--text-shimmer-spread))
  );
  --text-shimmer-base: linear-gradient(var(--text-shimmer-base-color), var(--text-shimmer-base-color));

  display: inline-flex;
  align-items: baseline;
  font: inherit;
  line-height: inherit;
  letter-spacing: inherit;
}

/* A grid cell both copies share, so neither can move the other. */
.char {
  display: inline-grid;
  font: inherit;
  line-height: inherit;
  letter-spacing: inherit;
  white-space: pre;
}

.base,
.sweep {
  grid-area: 1 / 1;
  font: inherit;
  line-height: inherit;
  letter-spacing: inherit;
  white-space: pre;
  transition: opacity var(--text-shimmer-swap) ease-out;
}

.base {
  color: inherit;
  opacity: 1;
}

.sweep {
  color: var(--text-weaker);
  opacity: 0;
}

.shimmer[data-active="true"] .base {
  opacity: 0;
}

.shimmer[data-active="true"] .sweep {
  opacity: 1;
}

@supports ((-webkit-background-clip: text) or (background-clip: text)) {
  .sweep {
    color: transparent;
    background-image: var(--text-shimmer-sweep), var(--text-shimmer-base);
    background-repeat: no-repeat;
    background-position: 100% 0, 0 0;
    background-size: var(--text-shimmer-size) 100%, 100% 100%;
    background-clip: text;
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }
}

.sweep[data-run="true"] {
  animation-name: sweep;
  animation-duration: var(--text-shimmer-duration);
  animation-timing-function: linear;
  animation-iteration-count: infinite;
  animation-fill-mode: both;
  /* Negative, so a row further down the list is already part-way through. */
  animation-delay: calc(var(--text-shimmer-step) * var(--text-shimmer-index) * -1);
  will-change: background-position;
}

@keyframes sweep {
  0% {
    background-position: 100% 0, 0 0;
  }

  100% {
    background-position: 0 0, 0 0;
  }
}

/* Nothing travels, and the resting copy is the one that shows. */
@media (prefers-reduced-motion: reduce) {
  .base,
  .sweep {
    transition-duration: 0s;
  }

  .sweep {
    color: inherit;
    background-image: none;
    -webkit-text-fill-color: currentColor;
    animation: none !important;
  }

  .base {
    opacity: 1 !important;
  }
}
</style>
