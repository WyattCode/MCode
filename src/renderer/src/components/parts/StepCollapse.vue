<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue"

/**
 * MiMo's hs-collapse: what a step or group opens to.
 *
 * The rows grow from nothing to their height and fade in over .18s, and on
 * closing the content stays mounted until the fold has finished. It only
 * animates once the reader has toggled it; a body that starts open (or a group
 * that folds itself when the answer arrives) simply appears or goes.
 */
const props = defineProps<{ show: boolean; animate?: boolean }>()

const mounted = ref(props.show)
const opened = ref(props.show)
let timer: ReturnType<typeof setTimeout> | undefined
let frame = 0

watch(
  () => props.show,
  (show) => {
    clearTimeout(timer)
    cancelAnimationFrame(frame)
    if (show) {
      mounted.value = true
      if (!props.animate) {
        opened.value = true
        return
      }
      // Mounted closed for a frame first, so the grid has a zero height to grow from.
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => (opened.value = true))
      })
      return
    }
    opened.value = false
    if (!props.animate) {
      mounted.value = false
      return
    }
    timer = setTimeout(() => (mounted.value = false), 200)
  },
)

onBeforeUnmount(() => {
  clearTimeout(timer)
  cancelAnimationFrame(frame)
})
</script>

<template>
  <div v-if="mounted" class="hs-collapse" :class="{ open: opened, still: !animate }" data-step-collapse>
    <div class="hs-collapse-inner"><slot /></div>
  </div>
</template>
