<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import type { Annotation } from "@shared/protocol"
import { useAnnotations } from "../stores/annotations"
import { annotationId, annotationRequest, mainAnnotationScope, requestAnnotation, type AnnotationRequest } from "../lib/annotate"
import { closeVideoPreview, videoPreview } from "../lib/image-preview"
import { t } from "../lib/i18n"

/**
 * MiMo's video preview: the video on a dark ground, opened paused, with a
 * light bar under it - play or pause, the time, and a progress slider. A click
 * on a playing frame pauses it; on a paused frame a drag boxes a region, and
 * the annotation box opens beside it with that moment: "add to chat" puts it
 * in the box, sending adds it and sends the message. Boxes already added show
 * numbered on the frame while the video is within 0.4s of their moment.
 * Escape drops a pending box first, then closes; so does a click on the ground.
 */
const annotations = useAnnotations()

const MIN_BOX = 5

type Box = { left: number; top: number; w: number; h: number }

const video = ref<HTMLVideoElement>()
const playing = ref(false)
const time = ref(0)
const duration = ref(0)
const seeking = ref(false)
const live = ref<Box | null>(null)
const kept = ref(new Map<string, { box: Box; t: number }>())
let start: { x: number; y: number } | null = null
let swallowClick = false
let swallowTimer: ReturnType<typeof setTimeout> | undefined
let ownRequest: AnnotationRequest | null = null

const shown = computed(() => videoPreview.value)

function reset() {
  playing.value = false
  time.value = 0
  duration.value = 0
  seeking.value = false
  live.value = null
  kept.value = new Map()
  start = null
  dropRequest()
}

watch(() => videoPreview.value?.url, reset)

function dropRequest() {
  if (ownRequest && annotationRequest.value === ownRequest) requestAnnotation(null)
  ownRequest = null
}

/* The box closes with the note: whatever was boxed goes with it, unless a new drag has begun. */
watch(annotationRequest, (current) => {
  if (ownRequest && current !== ownRequest) {
    ownRequest = null
    if (!start) live.value = null
  }
})

function clock(seconds: number) {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const rest = String(whole % 60).padStart(2, "0")
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`
}

function togglePlay() {
  const el = video.value
  if (!el) return
  if (el.paused) void el.play().catch(() => undefined)
  else el.pause()
}

function boxFrom(event: PointerEvent): Box | null {
  const el = video.value
  if (!el || !start) return null
  const rect = el.getBoundingClientRect()
  const x = event.clientX - rect.left
  const y = event.clientY - rect.top
  return { left: Math.min(start.x, x), top: Math.min(start.y, y), w: Math.abs(x - start.x), h: Math.abs(y - start.y) }
}

function onPointerDown(event: PointerEvent) {
  const el = video.value
  if (!el) return
  if (!el.paused) {
    el.pause()
    return
  }
  event.preventDefault()
  try {
    el.setPointerCapture(event.pointerId)
  } catch {
    // A pointer that is no longer active cannot be captured; the drag still works without it.
  }
  dropRequest()
  const rect = el.getBoundingClientRect()
  start = { x: event.clientX - rect.left, y: event.clientY - rect.top }
  live.value = { left: start.x, top: start.y, w: 0, h: 0 }
}

function onPointerMove(event: PointerEvent) {
  const box = boxFrom(event)
  if (box) live.value = box
}

/* Where the picture itself sits inside the element, letterboxed to its own proportions. */
function contentOf(width: number, height: number, naturalWidth: number, naturalHeight: number) {
  if (!width || !height || !naturalWidth || !naturalHeight) return { left: 0, top: 0, w: width, h: height }
  const scale = Math.min(width / naturalWidth, height / naturalHeight)
  const w = naturalWidth * scale
  const h = naturalHeight * scale
  return { left: (width - w) / 2, top: (height - h) / 2, w, h }
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

function onPointerUp(event: PointerEvent) {
  const el = video.value
  const box = boxFrom(event)
  start = null
  if (!el || !box) return
  if (box.w < MIN_BOX && box.h < MIN_BOX) {
    live.value = null
    return
  }
  swallowClick = true
  // The click that ends the drag comes in this same task; any later click is a new one.
  clearTimeout(swallowTimer)
  swallowTimer = setTimeout(() => {
    swallowClick = false
  }, 0)
  live.value = box
  const rect = el.getBoundingClientRect()
  const content = contentOf(rect.width, rect.height, el.videoWidth, el.videoHeight)
  const x = clamp01((box.left - content.left) / content.w)
  const y = clamp01((box.top - content.top) / content.h)
  const region = { fx: x, fy: y, fw: clamp01((box.left + box.w - content.left) / content.w) - x, fh: clamp01((box.top + box.h - content.top) / content.h) - y }
  const moment = el.currentTime
  const preview = videoPreview.value
  const request: AnnotationRequest = {
    rect: { left: rect.left + box.left, top: rect.top + box.top, right: rect.left + box.left + box.w, bottom: rect.top + box.top + box.h },
    initialText: "",
    above: true,
    emptyEnterStashes: true,
    make: (text): Annotation => {
      const note: Annotation = {
        id: annotationId(),
        kind: "video",
        ...(preview?.path ? { path: preview.path } : {}),
        name: preview?.name || (preview?.path ? preview.path.split(/[\\/]/).pop() : "") || "视频",
        region,
        timeSec: moment,
        text,
      }
      kept.value = new Map(kept.value).set(note.id, { box, t: moment })
      return note
    },
  }
  ownRequest = request
  requestAnnotation(request)
}

function onPointerCancel() {
  start = null
  live.value = null
}

/*
 * A finished drag is followed by a click, which must not close the preview. With
 * the pointer captured that click lands on the video and stops at the column, so
 * the flag is also dropped after the drag's task and on the next press.
 */
function onGroundPointerDown() {
  swallowClick = false
}

function onGroundClick() {
  if (swallowClick) {
    swallowClick = false
    return
  }
  closeVideoPreview()
}

function onKey(event: KeyboardEvent) {
  if (!videoPreview.value || event.key !== "Escape") return
  event.preventDefault()
  event.stopPropagation()
  if (ownRequest || live.value) {
    dropRequest()
    live.value = null
    return
  }
  closeVideoPreview()
}

const markers = computed(() => {
  const list = annotations.list(mainAnnotationScope.value)
  const out: { id: string; num: number; box: Box }[] = []
  list.forEach((note, index) => {
    const entry = kept.value.get(note.id)
    if (entry && Math.abs(time.value - entry.t) < 0.4) out.push({ id: note.id, num: index + 1, box: entry.box })
  })
  return out
})

const place = (box: Box) => ({ left: `${box.left}px`, top: `${box.top}px`, width: `${box.w}px`, height: `${box.h}px` })

function onTimeUpdate() {
  if (!seeking.value && video.value) time.value = video.value.currentTime
}

function onDuration() {
  const value = video.value?.duration ?? 0
  duration.value = Number.isFinite(value) ? value : 0
}

/* MiMo scrubs live: every step of the thumb moves the frame, not only the release. */
function onSlide(event: Event) {
  const value = Number((event.target as HTMLInputElement).value)
  if (video.value) video.value.currentTime = value
  time.value = value
}

/* A held thumb mutes timeupdate, which would otherwise pull it back mid-drag; the release may land off the slider. */
function endSeek() {
  seeking.value = false
  window.removeEventListener("pointerup", endSeek, true)
  window.removeEventListener("pointercancel", endSeek, true)
}

function startSeek() {
  seeking.value = true
  window.addEventListener("pointerup", endSeek, true)
  window.addEventListener("pointercancel", endSeek, true)
}

onMounted(() => window.addEventListener("keydown", onKey, true))
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey, true)
  endSeek()
  clearTimeout(swallowTimer)
  dropRequest()
})
</script>

<template>
  <Teleport to="body">
    <div v-if="shown" class="vp-overlay" data-video-preview>
      <div id="video-preview" v-modal class="vp-content" role="dialog" aria-modal="true" data-new-task-clears :aria-label="t('videoPreview.title')" @pointerdown.capture="onGroundPointerDown" @click="onGroundClick">
        <span class="vp-sr">{{ t("videoPreview.title") }}</span>
        <div class="vp-column" @click.stop>
          <div class="vp-frame">
            <video
              :key="shown.url"
              ref="video"
              class="vp-video"
              :class="{ playing }"
              :src="shown.url"
              data-selectable="none"
              playsinline
              @play="playing = true"
              @pause="playing = false"
              @ended="playing = false"
              @timeupdate="onTimeUpdate"
              @loadedmetadata="onDuration"
              @durationchange="onDuration"
              @pointerdown="onPointerDown"
              @pointermove="onPointerMove"
              @pointerup="onPointerUp"
              @pointercancel="onPointerCancel"
            />
            <div v-for="marker in markers" :key="marker.id" class="vp-mark" data-video-marker :style="place(marker.box)">
              <span class="vp-badge">{{ marker.num }}</span>
            </div>
            <div v-if="live" class="vp-live" data-video-box :style="place(live)" />
          </div>
          <div class="vp-bar">
            <button type="button" class="vp-toggle" data-video-toggle :title="playing ? t('videoPreview.pause') : t('videoPreview.play')" @click="togglePlay">
              <svg v-if="playing" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
                <rect x="6" y="5" width="4" height="14" rx="1" />
                <rect x="14" y="5" width="4" height="14" rx="1" />
              </svg>
              <svg v-else viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M7 5l12 7-12 7z" /></svg>
            </button>
            <span class="vp-time" data-video-time>{{ clock(time) }} / {{ clock(duration) }}</span>
            <input
              class="vp-range"
              type="range"
              min="0"
              :max="duration || 1"
              step="0.01"
              :value="time"
              :disabled="!duration"
              :aria-label="t('videoPreview.progress')"
              data-video-range
              @pointerdown="startSeek"
              @input="onSlide"
            />
          </div>
          <div class="vp-hint" data-video-hint>{{ playing ? t("videoPreview.hintPlaying") : t("videoPreview.hintPaused") }}</div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.vp-overlay {
  position: fixed;
  inset: 0;
  z-index: 300;
  background: rgba(0, 0, 0, 0.5);
  animation: vp-fade 0.2s ease-out;
}

.vp-content {
  position: fixed;
  inset: 0;
  z-index: 301;
  display: grid;
  place-items: center;
  box-sizing: border-box;
  padding: 40px;
  background: rgba(0, 0, 0, 0.72);
  animation: vp-zoom 0.2s ease-out;
}

@keyframes vp-fade {
  from {
    opacity: 0;
  }
}

@keyframes vp-zoom {
  from {
    opacity: 0;
    transform: scale(0.95);
  }
}

@media (prefers-reduced-motion: reduce) {
  .vp-overlay,
  .vp-content {
    animation: none;
  }
}

.vp-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.vp-column {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  max-height: 100%;
}

.vp-frame {
  position: relative;
  display: inline-flex;
}

.vp-video {
  max-width: 100%;
  max-height: 78vh;
  border-radius: 8px;
  box-shadow: 0 12px 40px #00000024;
  object-fit: contain;
  cursor: crosshair;
  touch-action: none;
}

.vp-video.playing {
  cursor: pointer;
}

.vp-live,
.vp-mark {
  position: absolute;
  box-sizing: border-box;
  border: 2px solid #3295fb;
  border-radius: 4px;
  pointer-events: none;
}

.vp-live {
  background: rgba(50, 149, 251, 0.12);
}

.vp-mark {
  background: rgba(50, 149, 251, 0.1);
}

.vp-badge {
  position: absolute;
  top: -9px;
  left: -9px;
  display: grid;
  place-items: center;
  box-sizing: border-box;
  min-width: 19px;
  height: 19px;
  padding: 0 4px;
  color: #fff;
  background: #3295fb;
  border-radius: 999px;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25);
  font-size: 11px;
  font-weight: 500;
}

.vp-bar {
  display: flex;
  box-sizing: border-box;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 10px 14px;
  color: var(--text-strong);
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 12px;
  box-shadow: 0 8px 30px #0000002e, 0 1px 3px #0000001a;
}

.vp-toggle {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 30px;
  height: 30px;
  padding: 0;
  color: var(--text-strong);
  background: transparent;
  border: none;
  border-radius: 7px;
}

.vp-toggle:hover {
  background: var(--surface-hover);
}

.vp-time {
  flex-shrink: 0;
  color: var(--text-weak);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.vp-range {
  flex: 1;
  height: 4px;
  accent-color: #ff6a2b;
  cursor: pointer;
}

.vp-range:disabled {
  opacity: 0.4;
}

/* The shadows stay the light ones in dark too: MiMo's utilities compile with fixed colours. */
.vp-hint {
  color: var(--text-weak);
  font-size: 12px;
}
</style>
