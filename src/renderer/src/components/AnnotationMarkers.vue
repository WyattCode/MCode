<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue"
import { useAnnotations } from "../stores/annotations"
import { locate, scrollerOf } from "../lib/annotate"

/**
 * MiMo's marks on passages waiting to be sent: every annotation in a box that
 * points at a reply or at code on screen keeps its passage faintly lit, with
 * its number in a small pin just above the passage's first line (beside it
 * when that would run under the top of its scroller), kept inside the
 * conversation and above the composer. Found again whenever the page changes,
 * and moved on scroll and resize. Nothing shows while a dialog is up.
 */
const props = defineProps<{ mainScope: string; disabled: boolean }>()
const store = useAnnotations()

const NOTE = "mcode-annotation-note"
const PIN_W = 20
const PIN_H = 19
const GAP = 3
const EDGE = 6

interface Found {
  key: string
  n: number
  range: Range
  host: HTMLElement | null
}

interface Pin {
  key: string
  n: number
  left: number
  top: number
}

const pins = ref<Pin[]>([])
let found: Found[] = []

const highlights = () => (typeof CSS !== "undefined" && "highlights" in CSS ? CSS.highlights : null)

/* The blocks a box's annotations can point into: the side chat's own, or everything outside a side chat. */
function blocksFor(scope: string): HTMLElement[] {
  if (scope === props.mainScope) {
    return [...document.querySelectorAll<HTMLElement>("[data-annotate]")].filter((el) => !el.closest("[data-annotate-scope]"))
  }
  return [...document.querySelectorAll<HTMLElement>("[data-annotate-scope]")]
    .filter((root) => root.dataset.annotateScope === scope)
    .flatMap((root) => [...root.querySelectorAll<HTMLElement>("[data-annotate]")])
}

function collect() {
  const next: Found[] = []
  const lit = typeof Highlight !== "undefined" ? new Highlight() : null
  if (!props.disabled) {
    for (const [scope, list] of Object.entries(store.byScope)) {
      const blocks = blocksFor(scope).reverse()
      list.forEach((note, index) => {
        if ((note.kind !== "answer" && note.kind !== "code") || !note.quote) return
        for (const el of blocks) {
          if (el.dataset.annotate !== note.kind) continue
          if (note.kind === "code" && el.dataset.annotatePath !== note.path) continue
          const range = locate(el, note.quote, note.occ)
          if (!range) continue
          next.push({ key: `${scope}-${index}`, n: index + 1, range, host: scrollerOf(range.startContainer) })
          lit?.add(range)
          break
        }
      })
    }
  }
  found = next
  const registry = highlights()
  if (registry && lit && next.length) registry.set(NOTE, lit)
  else registry?.delete(NOTE)
}

function place() {
  const composer = document.querySelector<HTMLElement>("#float-dock .composer, #main-dock .composer, #hero-dock .composer")
  const composerTop = composer?.getBoundingClientRect().top ?? 0
  const width = window.innerWidth
  const height = composerTop > 0 ? Math.min(window.innerHeight, composerTop - 8) : window.innerHeight
  const stream = [...document.querySelectorAll<HTMLElement>(".stream")].find((el) => !el.closest("[data-annotate-scope]"))
  const streamTop = stream ? Math.max(0, stream.getBoundingClientRect().top) : 0
  pins.value = found.flatMap((entry) => {
    const box = [...entry.range.getClientRects()].find((rect) => rect.width > 0 || rect.height > 0)
    if (!box) return []
    const bound = entry.host?.getBoundingClientRect()
    const topBound = Math.max(streamTop, bound ? Math.max(0, bound.top) : 0, EDGE)
    const leftBound = Math.max(bound ? Math.max(0, bound.left) : 0, EDGE)
    let left = box.left - 2
    let top = box.top - PIN_H - GAP
    if (top < topBound) {
      top = box.top
      left = box.left - PIN_W - GAP
    }
    return [
      {
        key: entry.key,
        n: entry.n,
        left: Math.min(Math.max(leftBound, left), Math.max(leftBound, width - PIN_W - EDGE)),
        top: Math.min(Math.max(topBound, top), Math.max(topBound, height - PIN_H - EDGE)),
      },
    ]
  })
}

/* Batched to a frame's worth of time; a timer rather than a frame callback, which a covered window never runs. */
let timer: ReturnType<typeof setTimeout> | undefined
let findAgain = false
function schedule(full: boolean) {
  findAgain ||= full
  if (timer) return
  timer = setTimeout(() => {
    timer = undefined
    if (findAgain) collect()
    findAgain = false
    place()
  }, 16)
}

const observer = new MutationObserver(() => {
  if (Object.keys(store.byScope).length || found.length) schedule(true)
})
const onMove = () => {
  if (found.length) schedule(false)
}

onMounted(() => {
  const app = document.getElementById("app")
  if (app) observer.observe(app, { childList: true, subtree: true, characterData: true })
  window.addEventListener("scroll", onMove, true)
  window.addEventListener("resize", onMove)
  schedule(true)
})

onBeforeUnmount(() => {
  observer.disconnect()
  window.removeEventListener("scroll", onMove, true)
  window.removeEventListener("resize", onMove)
  clearTimeout(timer)
  highlights()?.delete(NOTE)
})

watch(
  () => [store.byScope, props.mainScope, props.disabled],
  () => schedule(true),
  { deep: true },
)
</script>

<template>
  <Teleport to="body">
    <div
      v-for="pin in pins"
      :key="pin.key"
      class="annot-pin"
      data-annotation-pin
      :style="{ left: `${pin.left}px`, top: `${pin.top}px` }"
    >
      {{ pin.n }}
    </div>
  </Teleport>
</template>

<style scoped>
/* MiMo's pin: a 19px accent pill, 11px medium white, a soft shadow, fading in. */
.annot-pin {
  position: fixed;
  z-index: 111;
  display: grid;
  place-items: center;
  min-width: 19px;
  height: 19px;
  padding: 0 4px;
  color: #fff;
  background: rgb(50, 149, 251);
  border-radius: 999px;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25);
  font-size: 11px;
  font-weight: 500;
  pointer-events: none;
  animation: annot-pop 0.3s cubic-bezier(0.34, 1.56, 0.56, 1) both;
}

@keyframes annot-pop {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .annot-pin {
    animation: none;
  }
}
</style>

<style>
/* Passages waiting in a box, faintly lit (MiMo's note highlight). */
::highlight(mcode-annotation-note) {
  background-color: rgba(50, 149, 251, 0.2);
}
</style>
