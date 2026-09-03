<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue"

/**
 * A number whose digits roll rather than cut.
 *
 * Each place is a vertical strip of the ten digits, moved by whole ems; the
 * strip is masked at both ends so a digit arrives out of a fade instead of
 * appearing at an edge. Counts that tick up while a turn runs then read as
 * movement, which is the point - a number that simply replaces itself is easy
 * to miss.
 */
const props = defineProps<{ value: number }>()

const digits = computed(() => String(Math.max(0, Math.round(props.value))).split(""))

/**
 * Held off until after the first paint.
 *
 * Without this every digit rolls up from zero the moment the row appears,
 * which turns arriving at a finished transcript into a slot machine.
 */
const animating = ref(false)
onMounted(() => {
  // See StatusLabel: rAF alone never fires for a window that is not drawing.
  requestAnimationFrame(() => (animating.value = true))
  setTimeout(() => (animating.value = true), 50)
})

// A number that grows a place should not roll every digit; remounting by
// length keeps each place's strip tied to the same column it was in.
watch(
  () => digits.value.length,
  () => {
    animating.value = false
    requestAnimationFrame(() => (animating.value = true))
    setTimeout(() => (animating.value = true), 50)
  },
)

const CELLS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
</script>

<template>
  <span class="number">
    <span class="value" :style="{ '--animated-number-width': `${digits.length}ch` }">
      <!--
        Reversed in the flow so a new leading digit grows on the left without
        pushing the ones already there sideways.
      -->
      <span v-for="(digit, at) in [...digits].reverse()" :key="digits.length - at" class="digit">
        <span
          class="strip"
          :data-animating="String(animating)"
          :style="{ '--animated-number-offset': digit }"
        >
          <span v-for="cell in CELLS" :key="cell" class="cell">{{ cell }}</span>
        </span>
      </span>
    </span>
  </span>
</template>

<style scoped>
.number {
  display: inline-flex;
  align-items: baseline;
  vertical-align: baseline;
  line-height: inherit;
  /* Every digit the same width, or the strip would jitter as it rolls. */
  font-variant-numeric: tabular-nums;
}

.value {
  display: inline-flex;
  flex-direction: row-reverse;
  align-items: baseline;
  justify-content: flex-end;
  overflow: hidden;
  width: var(--animated-number-width, 1ch);
  line-height: inherit;
  transition: width var(--tool-motion-spring-ms) var(--tool-motion-ease);
}

.digit {
  width: 1ch;
  height: 1lh;
  vertical-align: baseline;
  /* Faded at both ends, so a digit enters and leaves rather than popping. */
  mask-image: linear-gradient(
    to bottom,
    transparent 0%,
    #000 var(--tool-motion-mask),
    #000 calc(100% - var(--tool-motion-mask)),
    transparent 100%
  );
  -webkit-mask-image: linear-gradient(
    to bottom,
    transparent 0%,
    #000 var(--tool-motion-mask),
    #000 calc(100% - var(--tool-motion-mask)),
    transparent 100%
  );
}

.strip {
  display: inline-flex;
  flex-direction: column;
  transform: translateY(calc(var(--animated-number-offset, 0) * -1lh));
  transition-property: transform;
  transition-duration: var(--tool-motion-spring-ms);
  transition-timing-function: var(--tool-motion-ease);
}

/* The first paint lands on the right digit instead of travelling to it. */
.strip[data-animating="false"] {
  transition-duration: 0s;
}

.cell {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1ch;
  height: 1lh;
  line-height: 1lh;
}

@media (prefers-reduced-motion: reduce) {
  .value,
  .strip {
    transition-duration: 0s;
  }
}
</style>
