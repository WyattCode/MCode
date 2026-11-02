<script setup lang="ts">
/**
 * A task row's title, as MiMo draws one. A title too long for its row fades at
 * its end while the row rests, and slides along to show the rest while the row
 * is hovered or focused. Double-clicking it asks for a rename.
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { reducedMotion } from "../lib/modal"

const props = defineProps<{
  text: string
  /** How much of the row's end its hover buttons lie over; the slide goes far enough to clear them. */
  cover: number
}>()

const emit = defineEmits<{ rename: [] }>()

// MiMo's pace: 36px a second, never quicker than 0.9s or slower than 8s, after a 0.35s rest.
const SPEED = 36
const SHORTEST = 900
const LONGEST = 8000
const REST = 350

const viewport = ref<HTMLElement>()
const inner = ref<HTMLElement>()
const distance = ref(0)
let run: Animation | undefined
let row: HTMLElement | null = null
let observer: ResizeObserver | undefined

function measure() {
  const box = viewport.value
  const line = inner.value
  if (!box || !line || box.clientWidth <= 0) return
  const room = Math.max(1, box.clientWidth - Math.max(0, props.cover))
  distance.value = Math.max(0, Math.ceil(line.scrollWidth - room))
}

function slide() {
  const line = inner.value
  if (run || !line || distance.value <= 0 || reducedMotion()) return
  const shift = getComputedStyle(line).direction === "rtl" ? distance.value : -distance.value
  run = line.animate([{ transform: "translateX(0)" }, { transform: `translateX(${shift}px)` }], {
    duration: Math.round(Math.min(LONGEST, Math.max(SHORTEST, (distance.value / SPEED) * 1000))),
    delay: REST,
    easing: "linear",
    fill: "both",
  })
}

function stop() {
  run?.cancel()
  run = undefined
}

/* Leaving the row, or focus leaving it: back to the start unless the other still holds it. */
function settle() {
  setTimeout(() => {
    if (row?.matches(":hover") || row?.matches(":focus-within")) return
    stop()
  })
}

onMounted(() => {
  measure()
  row = viewport.value?.closest<HTMLElement>(".row") ?? null
  row?.addEventListener("mouseenter", slide)
  row?.addEventListener("focusin", slide)
  row?.addEventListener("mouseleave", settle)
  row?.addEventListener("focusout", settle)
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(measure)
    if (viewport.value) observer.observe(viewport.value)
    if (inner.value) observer.observe(inner.value)
  }
  document.fonts?.addEventListener?.("loadingdone", measure)
})

watch(
  () => [props.text, props.cover],
  () => {
    stop()
    void nextTick(measure)
  },
)

onBeforeUnmount(() => {
  stop()
  row?.removeEventListener("mouseenter", slide)
  row?.removeEventListener("focusin", slide)
  row?.removeEventListener("mouseleave", settle)
  row?.removeEventListener("focusout", settle)
  observer?.disconnect()
  document.fonts?.removeEventListener?.("loadingdone", measure)
})
</script>

<template>
  <span ref="viewport" class="title-viewport" :data-title-overflow="distance > 0 ? 'true' : 'false'" :title="distance > 0 ? text : undefined">
    <span ref="inner" class="title-txt" :data-marquee="distance > 0 ? 'true' : 'false'" @dblclick.stop="emit('rename')">{{ text }}</span>
  </span>
</template>

<style scoped>
.title-viewport {
  display: block;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}

.title-txt {
  display: block;
  width: max-content;
  max-width: none;
  white-space: nowrap;
}
</style>
