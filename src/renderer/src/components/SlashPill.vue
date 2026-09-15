<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue"
import { slashLead } from "../lib/composer-text"

/**
 * MiMo's highlight behind a known /command that opens the draft.
 *
 * Drawn under the textarea's own text (the textarea sits above it with a
 * transparent fill), so it is measured rather than laid out: the command's
 * width in the textarea's font, placed after any leading spaces and blank
 * lines. Hidden when the line would not fit, when it falls below the visible
 * height, or once the textarea is scrolled.
 */
const props = defineProps<{ input?: HTMLTextAreaElement; text: string; known: ReadonlySet<string> }>()

const place = ref<{ start: number; top: number; width: number; height: number }>()

let canvas: HTMLCanvasElement | undefined

function widthOf(value: string, font: string): number {
  if (!value) return 0
  canvas ??= document.createElement("canvas")
  const context = canvas.getContext("2d")
  if (!context) return 0
  context.font = font
  return context.measureText(value).width
}

function measure() {
  const input = props.input
  const lead = slashLead(props.text, props.known)
  if (!input || !lead || input.scrollTop > 2) {
    place.value = undefined
    return
  }
  const style = getComputedStyle(input)
  const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  const fontSize = Number.parseFloat(style.fontSize) || 14
  const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.5
  const padStart = Number.parseFloat(style.paddingInlineStart) || 0
  const padEnd = Number.parseFloat(style.paddingInlineEnd) || 0
  const padTop = Number.parseFloat(style.paddingTop) || 0
  const token = widthOf(lead.token, font)
  const indent = widthOf(lead.indent, font)
  const height = fontSize * 1.25 + 2
  const top = input.offsetTop + padTop + lead.newlines * lineHeight + (lineHeight - fontSize * 1.25) / 2 - 1
  const fits = indent + token <= input.clientWidth - padStart - padEnd
  const visible = top + height <= input.offsetTop + input.clientHeight
  if (!fits || !visible) {
    place.value = undefined
    return
  }
  // Measured from the inline start, so a right-to-left box places it from the right.
  const parent = input.offsetParent instanceof HTMLElement ? input.offsetParent : undefined
  const offset = style.direction === "rtl" && parent ? parent.clientWidth - input.offsetLeft - input.offsetWidth : input.offsetLeft
  place.value = { start: offset + padStart + indent - 3, top, width: token + 6, height }
}

let observer: ResizeObserver | undefined

function remeasure() {
  void nextTick(measure)
}

watch(
  () => props.input,
  (next, previous) => {
    previous?.removeEventListener("scroll", measure)
    observer?.disconnect()
    if (next) {
      observer = new ResizeObserver(() => measure())
      observer.observe(next)
      if (next.parentElement) observer.observe(next.parentElement)
      next.addEventListener("scroll", measure)
    }
    remeasure()
  },
  { immediate: true },
)

watch(() => [props.text, props.known], remeasure)

onBeforeUnmount(() => {
  observer?.disconnect()
  props.input?.removeEventListener("scroll", measure)
})
</script>

<template>
  <span
    v-if="place"
    class="slash-pill"
    aria-hidden="true"
    :style="{
      insetInlineStart: `${place.start}px`,
      top: `${place.top}px`,
      width: `${place.width}px`,
      height: `${place.height}px`,
    }"
  />
</template>

<style scoped>
/* The slash chip's tone, under the text: 6px corner, never in the pointer's way. */
.slash-pill {
  position: absolute;
  z-index: 0;
  background: color-mix(in srgb, var(--text-strong) 8%, transparent);
  border-radius: 6px;
  pointer-events: none;
}
</style>
