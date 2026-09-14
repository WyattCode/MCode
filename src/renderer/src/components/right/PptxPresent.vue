<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import type { PptxViewer } from "@aiden0z/pptx-renderer"
import JSZip from "jszip"
import { effectAnimation, parseMotion, transitionAnimation, type SlideMotion } from "../../lib/pptx-parse"
import { effectTarget, reducedMotion } from "../../lib/pptx-dom"
import { t } from "../../lib/i18n"
import LucideIcon from "../LucideIcon.vue"

/**
 * MiMo's slide show: the deck full screen on black from the slide in view,
 * each slide drawn into one of two stacked layers so a change can play the
 * slide's own transition (fade, push, wipe, split, cover, cut), then its
 * entrance effects. A click, →, space or Page Down goes on (finishing effects
 * still playing first); ←, Page Up back; Home and End to either end; Escape,
 * the corner button or leaving full screen ends it. The button and the
 * "n / N" counter fade after 3s without the mouse moving.
 */
const props = defineProps<{ viewer: PptxViewer; bytes: Uint8Array; startIndex: number }>()
const emit = defineEmits<{ close: [] }>()

type Slot = "A" | "B"
type Handle = NonNullable<ReturnType<PptxViewer["renderSlideToContainer"]>>
type Nodes = readonly { id: string | number }[]

const root = ref<HTMLElement>()
const stage = ref<HTMLElement>()
const slotA = ref<HTMLElement>()
const slotB = ref<HTMLElement>()
const index = ref(props.startIndex)
const controls = ref(true)
const size = ref({ w: 0, h: 0 })

const slides = () => (props.viewer.presentationData as unknown as { slides?: { nodes?: Nodes }[] } | undefined)?.slides
const count = computed(() => props.viewer.slideCount || slides()?.length || 1)
const reduce = reducedMotion()
const slideWidth = () => props.viewer.slideWidth || 960
const slideHeight = () => props.viewer.slideHeight || 540

let front: Slot = "A"
const handles: Record<Slot, Handle | null> = { A: null, B: null }
let effectAnimations: Animation[] = []
let transitionAnimations: Animation[] = []
let effectsPlaying = false
let moving = false
let effectsStarted = false
const motions = new Map<number, SlideMotion | null>()
let zip: Promise<JSZip | null> | undefined

const slotOf = (slot: Slot) => (slot === "A" ? slotA.value : slotB.value)
const other = (slot: Slot): Slot => (slot === "A" ? "B" : "A")

function cancel(list: Animation[]) {
  for (const animation of list) {
    try {
      animation.cancel()
    } catch {
      /* already gone */
    }
  }
}

function dispose(slot: Slot) {
  try {
    handles[slot]?.dispose()
  } catch {
    /* already disposed */
  }
  handles[slot] = null
}

function measure() {
  const el = stage.value
  if (!el) return
  const scale = Math.min(el.clientWidth / slideWidth(), el.clientHeight / slideHeight())
  size.value = { w: slideWidth() * scale, h: slideHeight() * scale }
}

/* A slide's transition and effects, read from its own part (by file number) once. */
async function motionOf(at: number): Promise<SlideMotion | null> {
  if (motions.has(at)) return motions.get(at) ?? null
  zip ??= JSZip.loadAsync(props.bytes).catch(() => null)
  let motion: SlideMotion | null = null
  try {
    const xml = await (await zip)?.file(`ppt/slides/slide${at + 1}.xml`)?.async("string")
    motion = xml ? parseMotion(xml) : null
  } catch {
    motion = null
  }
  motions.set(at, motion)
  return motion
}

async function renderInto(at: number, slot: Slot): Promise<Handle | null> {
  const el = slotOf(slot)
  if (!el || size.value.w === 0) return null
  dispose(slot)
  el.innerHTML = ""
  const handle = props.viewer.renderSlideToContainer(at, el, size.value.w / slideWidth())
  if (!handle) return null
  handles[slot] = handle
  await handle.ready
  return handle
}

async function playEffects(at: number, slide: HTMLElement) {
  const motion = await motionOf(at)
  const nodes = slides()?.[at]?.nodes
  if (!motion?.effects.length || !nodes) return
  cancel(effectAnimations)
  effectAnimations = []
  const targets = new Map<string, HTMLElement>()
  for (const effect of motion.effects) {
    const target = effectTarget(slide, effect.spid, nodes)
    if (!target) continue
    targets.set(effect.spid, target)
    target.style.visibility = "hidden"
  }
  effectsPlaying = true
  for (const effect of motion.effects) {
    const target = targets.get(effect.spid)
    if (!target) continue
    const { keyframes, timing } = effectAnimation(effect)
    effectAnimations.push(target.animate(keyframes, timing))
  }
  try {
    await Promise.all(effectAnimations.map((animation) => animation.finished.catch(() => undefined)))
  } finally {
    effectsPlaying = false
  }
}

function finishEffects() {
  for (const animation of effectAnimations) {
    try {
      animation.finish()
    } catch {
      /* cancelled */
    }
  }
  const slide = slotOf(front)?.firstElementChild
  const motion = motions.get(index.value)
  const nodes = slides()?.[index.value]?.nodes
  if (slide && motion && nodes) {
    for (const effect of motion.effects) {
      const target = effectTarget(slide, effect.spid, nodes)
      if (!target) continue
      target.style.visibility = "visible"
      target.style.opacity = "1"
    }
  }
  effectsPlaying = false
}

async function goTo(at: number) {
  if (at < 0 || at >= count.value || at === index.value || moving) return
  const nextSlot = other(front)
  const nextEl = slotOf(nextSlot)
  if (!nextEl) return
  moving = true
  try {
    const handle = await renderInto(at, nextSlot)
    if (!handle) {
      moving = false
      return
    }
    const motion = await motionOf(at)
    nextEl.style.display = "block"
    nextEl.style.zIndex = "1"
    const { current, next, timing } = transitionAnimation(reduce ? undefined : motion?.transition)
    cancel(transitionAnimations)
    const leaving = slotOf(front)
    transitionAnimations = []
    if (leaving && current.length) transitionAnimations.push(leaving.animate(current, timing))
    if (next.length) transitionAnimations.push(nextEl.animate(next, timing))
    await Promise.all(transitionAnimations.map((animation) => animation.finished.catch(() => undefined)))
    const old = front
    dispose(old)
    const oldEl = slotOf(old)
    if (oldEl) {
      oldEl.style.display = "none"
      oldEl.style.transform = ""
      oldEl.style.clipPath = ""
      oldEl.style.opacity = ""
      oldEl.style.zIndex = ""
      oldEl.innerHTML = ""
    }
    nextEl.style.zIndex = ""
    front = nextSlot
    index.value = at
    moving = false
    if (!reduce) void playEffects(at, handle.element)
  } catch {
    moving = false
  }
}

function step(delta: 1 | -1) {
  if (moving) return
  if (delta === 1 && effectsPlaying) {
    finishEffects()
    return
  }
  void goTo(index.value + delta)
}

function onKey(event: KeyboardEvent) {
  if (event.defaultPrevented) return
  const actions: Record<string, () => void> = {
    Escape: () => emit("close"),
    ArrowRight: () => step(1),
    " ": () => step(1),
    PageDown: () => step(1),
    ArrowLeft: () => step(-1),
    PageUp: () => step(-1),
    Home: () => void goTo(0),
    End: () => void goTo(count.value - 1),
  }
  const action = actions[event.key]
  if (!action) return
  event.preventDefault()
  action()
}

let idleTimer: ReturnType<typeof setTimeout> | undefined
function wake() {
  clearTimeout(idleTimer)
  controls.value = true
  idleTimer = setTimeout(() => (controls.value = false), 3000)
}
watch(index, wake)

/* The slide in view is drawn again whenever the stage changes size; its effects play only the first time. */
watch(
  () => size.value.w,
  async (width) => {
    if (!width) return
    const handle = await renderInto(index.value, front)
    if (!handle || effectsStarted) return
    effectsStarted = true
    if (!reduce) await playEffects(index.value, handle.element)
  },
)

function onFullscreenChange() {
  if (document.fullscreenElement == null) emit("close")
}

onMounted(() => {
  root.value?.requestFullscreen?.().catch(() => undefined)
  document.addEventListener("fullscreenchange", onFullscreenChange)
  window.addEventListener("resize", measure)
  window.addEventListener("keydown", onKey)
  measure()
  wake()
})

onBeforeUnmount(() => {
  document.removeEventListener("fullscreenchange", onFullscreenChange)
  window.removeEventListener("resize", measure)
  window.removeEventListener("keydown", onKey)
  clearTimeout(idleTimer)
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
  dispose("A")
  dispose("B")
  cancel(effectAnimations)
  cancel(transitionAnimations)
})
</script>

<template>
  <Teleport to="body">
    <div ref="root" class="pptx-present" data-pptx-present :aria-label="t('office.pptxPresent')" @mousemove="wake">
      <div ref="stage" class="present-stage" @click="step(1)">
        <div class="present-box" :style="{ width: `${size.w}px`, height: `${size.h}px` }">
          <div ref="slotA" class="present-slot" data-pptx-slot="A" />
          <div ref="slotB" class="present-slot" data-pptx-slot="B" style="display: none" />
        </div>
      </div>
      <button type="button" class="present-exit" :style="{ opacity: controls ? 1 : 0 }" :aria-label="t('office.pptxPresentExit')" @click="emit('close')">
        <LucideIcon name="x" :size="18" />
      </button>
      <div class="present-count" :style="{ opacity: controls ? 1 : 0 }">{{ index + 1 }} / {{ count }}</div>
    </div>
  </Teleport>
</template>

<style scoped>
.pptx-present {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #000;
}

.present-stage {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  overflow: hidden;
  cursor: pointer;
}

.present-box {
  position: relative;
}

.present-slot {
  position: absolute;
  inset: 0;
  transform-origin: top left;
}

.present-exit {
  position: absolute;
  top: 20px;
  right: 20px;
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  padding: 0;
  color: #fff;
  background: rgba(255, 255, 255, 0.12);
  border: none;
  border-radius: 8px;
  transition: opacity 0.2s cubic-bezier(0.2, 0.7, 0.2, 1);
}

.present-count {
  position: absolute;
  right: 28px;
  bottom: 24px;
  padding: 6px 14px;
  color: #fff;
  background: rgba(0, 0, 0, 0.55);
  border-radius: 999px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-variant-numeric: tabular-nums;
  pointer-events: none;
  transition: opacity 0.2s cubic-bezier(0.2, 0.7, 0.2, 1);
}
</style>
