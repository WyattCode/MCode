<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue"
import { turnOpeners } from "@shared/steer"
import { useApp } from "../stores/app"
import { renderMarkdown } from "../lib/markdown"
import { spineNote } from "../lib/sound"

/**
 * The conversation navigator - MiMo's session spine, rebuilt for this app.
 *
 * A narrow rail at the start of the conversation with one tick per turn. The
 * ticks for the turns on screen are drawn strong; the pointer swells the ticks
 * near it and, after a moment's rest, shows what that turn asked, the first
 * sentence of its answer and the tools it used. Pressing a tick glides the
 * transcript to that turn. With the setting on, moving along the rail plays a
 * rising pentatonic scale by position and a press rings fuller.
 *
 * It only appears when it has something to navigate - three turns or more -
 * and room to stand in beside the reading column.
 */
const props = defineProps<{ scroller?: HTMLElement }>()
const app = useApp()

interface Stop {
  id: string
  question: string
  answer: string
  tools: string[]
}

const MIN_TURNS = 3
/** The free width beside the reading column the rail needs. */
const ROOM = 56
const TICK = 4
const GAP = 6
const NARROW = 9
const WIDE = 24
/** How far either side of the pointer a tick still swells. */
const REACH = 3
/** How close to a tick's centre the pointer must be to pick it. */
const PICK = 10
/** A rail entered this recently has only been crossed, not explored: no sound yet. */
const SETTLE_MS = 100

/** The first sentence, capped: the card is a reminder, not the answer. */
function firstSentence(text: string): string {
  const trimmed = text.trim()
  const end = /[。！？]|[.!?](?=\s|$)/.exec(trimmed)
  return (end ? trimmed.slice(0, end.index + 1) : trimmed).slice(0, 140)
}

/*
 * Grouped the way the transcript groups them, so tick N is the Nth element
 * carrying data-turn: assistant messages before any user message open a turn
 * of their own, and of the user's messages only the ones the transcript opens
 * a turn with do - never the app's own synthetic word that a plan was
 * approved, and never news of a subagent, which stays inside the turn it
 * reached. A tick for either would point at nothing and would show the
 * reader what the runner wrote to the model as though it were a question.
 */
const stops = computed<Stop[]>(() => {
  const out: Stop[] = []
  const openers = turnOpeners(app.visible, !app.busy)
  let current: Stop | undefined
  for (const message of app.visible) {
    if (message.role === "user") {
      if (message.synthetic) continue
      if (current && !openers.has(message.id)) continue
      // A notice is the runner's words to the model, not a question: the card leaves it out as the transcript does.
      const text = message.notices?.length ? "" : (message.text ?? "")
      current = { id: message.id, question: text.trim().split("\n")[0].slice(0, 140), answer: "", tools: [] }
      out.push(current)
      continue
    }
    if (!current) {
      current = { id: message.id, question: "", answer: "", tools: [] }
      out.push(current)
    }
    for (const part of message.parts) {
      if (part.type === "text" && !current.answer && part.text.trim()) current.answer = firstSentence(part.text)
      else if (part.type === "tool" && !current.tools.includes(part.name)) current.tools.push(part.name)
    }
  }
  return out
})

const room = ref(0)
const box = ref({ top: 0, bottom: 0 })
const show = computed(() => stops.value.length >= MIN_TURNS && room.value >= ROOM)

const rail = ref<HTMLElement>()
const card = ref<HTMLElement>()
const active = ref(new Set<number>())
const hovered = ref(-1)
const clicked = ref(-1)
const offset = ref(0)
const panning = ref(false)
const fadeTop = ref(0)
const fadeBottom = ref(0)
const cardAt = ref({ left: 0, top: 0 })

const soundOn = () => app.config?.spineSound !== false

const rtl = (element: Element) => getComputedStyle(element).direction === "rtl"

/** Where the rail stands: level with the scroller, whatever sits above or below it. */
function measure() {
  const view = props.scroller
  const host = view?.offsetParent as HTMLElement | null
  if (!view || !host) return
  const inner = view.querySelector<HTMLElement>(".inner")
  const viewRect = view.getBoundingClientRect()
  const hostRect = host.getBoundingClientRect()
  const innerRect = inner?.getBoundingClientRect()
  // The room at the start of the line: left of the column, or right of it when the page reads right to left.
  room.value = innerRect ? (rtl(view) ? viewRect.right - innerRect.right : innerRect.left - viewRect.left) : 0
  box.value = { top: viewRect.top - hostRect.top, bottom: hostRect.bottom - viewRect.bottom }
  pan()
}

/** When the ticks outgrow the rail they travel with the scroll, fading at the cut edges. */
function pan() {
  const view = props.scroller
  const height = rail.value?.clientHeight ?? 0
  const count = stops.value.length
  const total = count ? count * TICK + (count - 1) * GAP : 0
  panning.value = total > height && height > 0
  if (!view || !panning.value) {
    offset.value = 0
    fadeTop.value = 0
    fadeBottom.value = 0
    return
  }
  const range = view.scrollHeight - view.clientHeight
  const ratio = range > 0 ? Math.min(1, Math.max(0, view.scrollTop / range)) : 0
  offset.value = (total - height) * ratio
  fadeTop.value = Math.min(1, offset.value / 64)
  fadeBottom.value = Math.min(1, (total - height - offset.value) / 64)
}

function turnElement(index: number): HTMLElement | null {
  const stop = stops.value[index]
  if (!stop || !props.scroller) return null
  return props.scroller.querySelector<HTMLElement>(`[data-turn="${CSS.escape(stop.id)}"]`)
}

/** The turns any part of which is inside the scroller's window. */
function markActive() {
  const view = props.scroller
  if (!view) return
  const rect = view.getBoundingClientRect()
  const next = new Set<number>()
  /*
   * Every turn found in one pass: a selector per stop scanned the whole
   * transcript once per turn, 22ms of a switch to a 160-turn conversation.
   */
  const byID = new Map<string, HTMLElement>()
  for (const element of view.querySelectorAll<HTMLElement>("[data-turn]")) byID.set(element.dataset.turn ?? "", element)
  stops.value.forEach((stop, index) => {
    const box = byID.get(stop.id)?.getBoundingClientRect()
    if (box && box.bottom > rect.top && box.top < rect.bottom) next.add(index)
  })
  active.value = next
}

let frame = 0
function onScroll() {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    markActive()
    pan()
  })
}

let observer: ResizeObserver | undefined
watch(
  () => props.scroller,
  (view, old) => {
    old?.removeEventListener("scroll", onScroll)
    observer?.disconnect()
    if (!view) return
    view.addEventListener("scroll", onScroll, { passive: true })
    observer = new ResizeObserver(() => {
      measure()
      markActive()
    })
    observer.observe(view)
    const inner = view.querySelector(".inner")
    if (inner) observer.observe(inner)
    measure()
    markActive()
  },
  { immediate: true },
)
watch(
  () => stops.value.length,
  () => requestAnimationFrame(() => {
    measure()
    markActive()
  }),
)
window.addEventListener("resize", measure)

function widthOf(index: number): number {
  if (hovered.value < 0) return NARROW
  const distance = Math.abs(index - hovered.value)
  if (distance > REACH) return NARROW
  return NARROW + Math.exp(-(distance * distance) / 0.8) * (WIDE - NARROW)
}

/** The tick whose centre is nearest the pointer, if one is near enough. */
function tickAt(y: number): number {
  const ticks = rail.value?.querySelectorAll<HTMLElement>(".spine-tick") ?? []
  let best = -1
  let distance = Infinity
  ticks.forEach((tick, index) => {
    const rect = tick.getBoundingClientRect()
    const away = Math.abs(rect.top + rect.height / 2 - y)
    if (away < distance) {
      distance = away
      best = index
    }
  })
  return distance <= PICK ? best : -1
}

let enteredAt = 0

function placeCard(y: number) {
  const railRect = rail.value?.getBoundingClientRect()
  if (!railRect) return
  const height = card.value?.offsetHeight || 140
  const lowest = Math.min(window.innerHeight - height - 12, railRect.bottom - height)
  // 14 past the rail on the side the conversation lies: its right, or its left right to left.
  const left = rail.value && rtl(rail.value) ? railRect.left - 14 - (card.value?.offsetWidth || 300) : railRect.right + 14
  cardAt.value = { left, top: Math.max(12, Math.min(lowest, y - height / 2)) }
}

function onEnter() {
  enteredAt = performance.now()
}

function onMove(event: PointerEvent) {
  const index = tickAt(event.clientY)
  if (index !== hovered.value && index >= 0 && soundOn() && performance.now() - enteredAt >= SETTLE_MS) {
    spineNote(index, stops.value.length)
  }
  hovered.value = index
  if (index >= 0) placeCard(event.clientY)
}

function clear() {
  hovered.value = -1
}

function onLeave(event: PointerEvent) {
  if (card.value?.contains(event.relatedTarget as Node | null)) return
  clear()
}

function onCardLeave(event: PointerEvent) {
  if (rail.value?.contains(event.relatedTarget as Node | null)) return
  clear()
}

let glide = 0
let flash = 0

/** Glides the transcript to a turn: quick for a near one, never slow for a far one. */
function jump(index: number) {
  const view = props.scroller
  const target = turnElement(index)
  if (!view || !target) return
  clicked.value = index
  window.clearTimeout(flash)
  flash = window.setTimeout(() => (clicked.value = -1), 200)
  if (soundOn()) spineNote(index, stops.value.length, true)

  const max = view.scrollHeight - view.clientHeight
  const from = view.scrollTop
  const to = Math.max(0, Math.min(max, from + target.getBoundingClientRect().top - view.getBoundingClientRect().top - 14))
  const distance = to - from
  if (Math.abs(distance) < 1) return
  const duration = Math.min(850, Math.max(280, 260 + Math.abs(distance) * 0.25))
  const start = performance.now()
  cancelAnimationFrame(glide)
  const step = (now: number) => {
    const progress = Math.min(1, (now - start) / duration)
    view.scrollTop = from + distance * (1 - Math.pow(1 - progress, 3))
    if (progress < 1) glide = requestAnimationFrame(step)
  }
  glide = requestAnimationFrame(step)
}

function onClick(event: MouseEvent) {
  const index = hovered.value >= 0 ? hovered.value : tickAt(event.clientY)
  if (index >= 0) jump(index)
}

function onCardClick() {
  if (hovered.value < 0) return
  jump(hovered.value)
  clear()
}

const shownStop = computed(() => (hovered.value >= 0 ? stops.value[hovered.value] : undefined))
/*
 * Both lines are markdown as written, so inline code and emphasis read as they
 * do in the transcript. Safe to bind as HTML: renderMarkdown escapes the source
 * before formatting it.
 */
const questionHtml = computed(() => renderMarkdown(shownStop.value?.question || "—"))
const answerHtml = computed(() => (shownStop.value?.answer ? renderMarkdown(shownStop.value.answer) : ""))

onBeforeUnmount(() => {
  props.scroller?.removeEventListener("scroll", onScroll)
  observer?.disconnect()
  window.removeEventListener("resize", measure)
  cancelAnimationFrame(frame)
  cancelAnimationFrame(glide)
  window.clearTimeout(flash)
})
</script>

<template>
  <div v-if="show" class="spine" :style="{ top: `${box.top}px`, bottom: `${box.bottom}px` }" aria-hidden="true">
    <div
      ref="rail"
      class="spine-rail"
      :class="{ panning }"
      @pointerenter="onEnter"
      @pointermove="onMove"
      @pointerleave="onLeave"
      @click="onClick"
    >
      <div class="spine-ticks" :style="panning ? { transform: `translateY(${-offset}px)` } : undefined">
        <div
          v-for="(stop, index) in stops"
          :key="stop.id"
          class="spine-tick"
          :class="{ active: active.has(index), clicked: clicked === index }"
        >
          <i :style="{ width: `${widthOf(index).toFixed(2)}px` }" />
        </div>
      </div>
      <div class="spine-fade top" :style="{ opacity: fadeTop }" />
      <div class="spine-fade bottom" :style="{ opacity: fadeBottom }" />
    </div>

    <Teleport to="body">
      <div
        ref="card"
        class="spine-preview"
        :class="{ show: Boolean(shownStop) }"
        :style="{ left: `${cardAt.left}px`, top: `${cardAt.top}px` }"
        @click="onCardClick"
        @pointerleave="onCardLeave"
      >
        <template v-if="shownStop">
          <div class="sp-q" v-html="questionHtml" />
          <div v-if="answerHtml" class="sp-a" v-html="answerHtml" />
          <div v-if="shownStop.tools.length" class="sp-tools">
            <span v-for="tool in shownStop.tools.slice(0, 6)" :key="tool" class="sp-tool">{{ tool }}</span>
          </div>
        </template>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/*
 * MiMo's measurements: a 48px strip at the start of the conversation, its rail
 * inset 7.5% top and bottom (plus 10), ticks 4 tall with 6 between, each a 2px
 * bar 9 wide that swells to 24 near the pointer; the card 300 wide on a 20px
 * corner, 14 past the rail. Placed by logical sides, so right to left the
 * strip stands at the right, where the lines start, and the card opens leftward.
 */
.spine {
  position: absolute;
  inset-inline-start: 0;
  z-index: 15;
  width: 48px;
  pointer-events: none;
}

.spine-rail {
  position: absolute;
  inset: calc(10px + 7.5%) 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding-block: 0;
  padding-inline: 12px 20px;
  overflow: hidden;
  pointer-events: auto;
  cursor: pointer;
}

.spine-rail.panning {
  justify-content: flex-start;
}

.spine-ticks {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}

.spine-tick {
  position: relative;
  flex: none;
  width: 100%;
  height: 4px;
}

.spine-tick i {
  position: absolute;
  top: 50%;
  inset-inline-start: 0;
  width: 9px;
  height: 2px;
  background: var(--text-weak);
  border-radius: 999px;
  transform: translateY(-50%);
  transition: width 0.15s ease, height 0.12s ease, background-color 0.12s ease;
}

.spine-tick.active i {
  background: var(--text-strong);
}

.spine-tick.clicked i {
  height: 4px;
}

.spine-fade {
  position: absolute;
  inset-inline: 0;
  z-index: 2;
  height: 64px;
  pointer-events: none;
}

/* The rail lies on the work area, so its fades end on MiMo's --color-main-bg, which --surface-raised already is. */
.spine-fade.top {
  top: 0;
  background: linear-gradient(180deg, var(--surface-raised) 30%, transparent);
}

.spine-fade.bottom {
  bottom: 0;
  background: linear-gradient(0deg, var(--surface-raised) 30%, transparent);
}

.spine-preview {
  position: fixed;
  z-index: 60;
  width: 300px;
  padding: 12px 14px;
  background: var(--surface-page);
  border: 0.5px solid var(--border-input);
  border-radius: 20px;
  box-shadow: var(--shadow-composer);
  opacity: 0;
  pointer-events: none;
  transform: translateY(6px) scale(0.97);
  transform-origin: 0 50%;
  transition: opacity 0.16s, transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
}

.spine-preview:dir(rtl) {
  transform-origin: 100% 50%;
}

.spine-preview.show {
  opacity: 1;
  pointer-events: auto;
  cursor: pointer;
  transform: none;
}

/* A bridge across the 14px gap, so the pointer can reach the card without the card closing. */
.spine-preview.show::before {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  inset-inline-start: -16px;
  width: 16px;
}

.sp-q {
  margin-bottom: 7px;
  overflow: hidden;
  color: var(--text-strong);
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 600;
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sp-a {
  display: -webkit-box;
  overflow: hidden;
  color: var(--text-base);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 1.55;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

/* Rendered markdown kept to the card's own type: no block margins, the question on one line. */
.sp-q :deep(:is(p, h1, h2, h3, h4, h5, h6, blockquote, ul, ol, pre)),
.sp-a :deep(:is(p, h1, h2, h3, h4, h5, h6, blockquote, ul, ol, pre)) {
  margin: 0;
  color: inherit;
  font: inherit;
}

.sp-q :deep(:is(p, h1, h2, h3, h4, h5, h6, blockquote, ul, ol, pre)) {
  display: inline;
}

.sp-a :deep(:is(ul, ol)) {
  padding-inline-start: 16px;
}

.sp-q :deep(code),
.sp-a :deep(code) {
  padding: 0 4px;
  background: var(--surface-hover);
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: inherit;
}

.sp-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 9px;
}

/* MiMo's --color-code-bg under its --color-txt: #f0f0f2 on light, #2e2e2e on dark (below). */
.sp-tool {
  max-width: 148px;
  padding: 1px 6px;
  overflow: hidden;
  color: #151c13cc;
  background: #f0f0f2;
  border-radius: 6px;
  font-family: var(--font-mono);
  font-size: calc(11px * var(--code-font-scale, 1));
  line-height: calc(16px * var(--code-font-scale, 1));
  text-overflow: ellipsis;
  white-space: nowrap;
}

/*
 * MiMo's --color-txt on the dark scheme (#f4f4f5); lane F1 is adding a token
 * for it, so the pair is written out here.
 */
:root[data-theme="dark"] .sp-tool {
  color: #f4f4f5;
  background: #2e2e2e;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .sp-tool {
    color: #f4f4f5;
    background: #2e2e2e;
  }
}
</style>
