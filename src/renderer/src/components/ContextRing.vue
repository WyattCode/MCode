<script setup lang="ts">
import { computed } from "vue"

/**
 * How full the model's context is, drawn as a ring.
 *
 * Two places in the app draw this same picture and the reference draws them at
 * two different sizes: 14px with a 1.5 stroke in the session header, and 16px
 * with a 2 stroke in front of the Context tab's label (ProgressCircleV2 at
 * `size: 14, strokeWidth: 1.5` @5073340 against ProgressCircle at `size: 16,
 * strokeWidth: 2` @4990418). A pair of rings written twice is a pair of rings
 * that drifts apart - one gets a new easing curve, or a track colour, and no
 * screenshot of either one on its own shows that they no longer match. So the
 * geometry is a prop and the drawing happens once.
 *
 * The arithmetic behind `percent` is not here: it belongs to session-context.ts,
 * which both callers already read, so this component only draws what it is
 * handed.
 */
const props = withDefaults(defineProps<{ percent?: number; size?: number; stroke?: number }>(), {
  /*
   * Zero rather than nothing, because the caller decides whether to draw at
   * all. The reference's tab indicator passes `context()?.usage ?? 0` and shows
   * an empty ring on a session that has not answered yet; its header instead
   * hides the control until there is a figure. Both are its behaviour, and both
   * are reachable from here.
   */
  percent: 0,
  size: 14,
  stroke: 1.5,
})

/*
 * The stroke straddles the radius, half of it inside and half out, so a circle
 * drawn at the full half-width would have its outer edge sitting beyond the
 * box and be clipped by the viewBox. Taking back half the stroke is the
 * reference's own rule - it is where both of its rings' radii come from, 7 for
 * the 16/2 ring and 6.25 for the 14/1.5 one.
 */
const radius = computed(() => props.size / 2 - props.stroke / 2)
const circumference = computed(() => 2 * Math.PI * radius.value)
const centre = computed(() => props.size / 2)

/*
 * Driven by the offset, not the dash pattern.
 *
 * Only stroke-dashoffset is animatable, so the arc is drawn full-length and
 * then wound back by however much of the context is still free - which is what
 * lets the ring fill smoothly as a turn eats into it.
 *
 * Clamped at both ends here rather than where the figure is worked out: a turn
 * can be sent more context than the model advertises, and the reading says 118%
 * on purpose because that is the truth about the session. It is only the
 * picture that has to stop at full, because a ring cannot draw more than a
 * circle.
 */
const offset = computed(() => {
  const drawn = Math.min(100, Math.max(0, props.percent)) / 100
  return circumference.value * (1 - drawn)
})
</script>

<template>
  <!-- Turned as a whole, so the arc starts at the top. -->
  <svg
    class="ring"
    :width="size"
    :height="size"
    :viewBox="`0 0 ${size} ${size}`"
    fill="none"
    aria-hidden="true"
  >
    <circle :cx="centre" :cy="centre" :r="radius" fill="none" class="ring-track" :stroke-width="stroke" />
    <circle
      :cx="centre"
      :cy="centre"
      :r="radius"
      fill="none"
      class="ring-arc"
      :stroke-width="stroke"
      stroke-linecap="round"
      :stroke-dasharray="circumference"
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
  stroke: var(--avatar-gray);
}

.ring-arc {
  stroke: var(--icon-base);
  transition: stroke-dashoffset 0.35s cubic-bezier(0.65, 0, 0.35, 1);
}
</style>
