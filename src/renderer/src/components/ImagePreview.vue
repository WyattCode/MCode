<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue"
import type { Annotation } from "@shared/protocol"
import { t } from "../lib/i18n"
import { closeImagePreview, imagePreview, imagePreviewKey, openImagePreview, originTransform, type PreviewRect } from "../lib/image-preview"
import { copyImageFile, fileManagerName } from "../lib/path-open"
import { notice } from "../lib/toast"
import { useApp } from "../stores/app"
import { useAnnotations } from "../stores/annotations"
import { annotationId, annotationRequest, mainAnnotationScope, requestAnnotation, type AnnotationRequest } from "../lib/annotate"

/**
 * MiMo's image preview.
 *
 * A dark ground at 72%, the picture fitted to the window less 40px a side and
 * shown at 80%, a round close button in the corner, and a floating bar at the
 * bottom: zoom out, the percentage, zoom in, rotate, reset, then download. Zoom
 * runs from 20% to 800%; the wheel pans up and down and zooms with Ctrl; the
 * picture drags; the keys are - + 0 R D, Esc, and the arrows step through the
 * pictures it was opened with. A picture opened with its file's path also gets
 * "copy image" (C) and "show in the file manager" (F) after download.
 *
 * The pointer has MiMo's two modes: it pans the picture, or it draws a box over
 * a part of it and asks for a note about that part - the same 框选批注 the slide,
 * web page and video views already offer, which is the one place it was missing.
 */
const app = useApp()
const annotations = useAnnotations()

const MIN_SCALE = 0.2
const MAX_SCALE = 8
const START_SCALE = 0.8

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))

/* MiMo's entry out of the clicked thumbnail, and its faster exit back into it on a different curve. */
const OPEN_EASE = "transform 0.42s cubic-bezier(0.22, 0.61, 0.36, 1), opacity 0.42s cubic-bezier(0.22, 0.61, 0.36, 1)"
const CLOSE_EASE = "transform 0.34s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.34s cubic-bezier(0.4, 0, 0.2, 1)"

const root = ref<HTMLElement>()
const lift = ref<HTMLElement>()
const image = ref<HTMLImageElement>()
const shown = ref(false)
/** The picture apart from the ground and controls: stepping to a neighbour hides only the picture. */
const pictureShown = ref(false)
/** The zoom and pan only ease once the entry is over, so the two never fight. */
const settled = ref(false)
const scale = ref(START_SCALE)
const turn = ref(0)
const offset = ref({ x: 0, y: 0 })
const dragging = ref(false)
let drag: { x: number; y: number; ox: number; oy: number } | undefined
let closing: number | undefined
let settling: number | undefined
let entered = false

/** What the pointer does: MiMo's 查看 (pan) or 框选 (draw a box and annotate it). */
const pointerMode = ref<"view" | "box">("view")
/** The smallest drag that is a box rather than a slip, in the picture's own pixels. */
const MIN_BOX = 6
type Box = { left: number; top: number; w: number; h: number }
/** The box being drawn, and the ones already noted, in the picture's own unscaled pixels. */
const live = ref<Box | null>(null)
const kept = ref(new Map<string, Box>())
let boxFrom: { x: number; y: number } | undefined
let ownRequest: AnnotationRequest | null = null
/** The thumbnail's rect as it was when the preview opened; closing flies back to it even if the reply has scrolled. */
let origin: PreviewRect | undefined

/*
 * The next frame, or a short timer if frames have stopped (a covered window
 * draws none), whichever comes first - so the picture always comes up.
 */
function nextFrame(run: () => void) {
  let ran = false
  const go = () => {
    if (ran) return
    ran = true
    cancelAnimationFrame(frameId)
    window.clearTimeout(timer)
    run()
  }
  const frameId = requestAnimationFrame(go)
  const timer = window.setTimeout(go, 50)
}

watch(
  () => imagePreview.value?.url,
  async (url) => {
    window.clearTimeout(closing)
    window.clearTimeout(settling)
    entered = false
    settled.value = false
    pictureShown.value = false
    /* A different picture is a different set of boxes; the pending note goes with the old one. */
    boxFrom = undefined
    live.value = null
    kept.value = new Map()
    dropRequest()
    if (!url) {
      shown.value = false
      pointerMode.value = "view"
      return
    }
    origin = imagePreview.value?.rect
    scale.value = START_SCALE
    turn.value = 0
    offset.value = { x: 0, y: 0 }
    if (lift.value) {
      lift.value.style.transition = "none"
      lift.value.style.transform = ""
    }
    await nextTick()
    root.value?.focus({ preventScroll: true })
    // A picture already decoded may have finished loading before this ran.
    if (image.value?.complete && image.value.naturalWidth) onImageLoad()
  },
)

/* MiMo starts the entry once the picture has loaded, or failed to, never before. */
function onImageLoad() {
  fit()
  enter()
}

function enter() {
  if (entered) return
  entered = true
  nextFrame(() => {
    const el = lift.value
    if (!el) return
    // Measured where it will end, then put back over the thumbnail, then let go.
    el.style.transition = "none"
    el.style.transform = ""
    void el.offsetWidth
    el.style.transform = originTransform(origin, el.getBoundingClientRect())
    void el.offsetWidth
    nextFrame(() => {
      el.style.transition = OPEN_EASE
      el.style.transform = "translateZ(0)"
      shown.value = true
      pictureShown.value = true
      settling = window.setTimeout(() => (settled.value = true), 440)
    })
  })
}

/** Fits the picture inside the window less 40px a side, larger or smaller than it really is. */
function fit() {
  const el = image.value
  if (!el || !el.naturalWidth || !el.naturalHeight) return
  const ratio = Math.min((window.innerWidth - 80) / el.naturalWidth, (window.innerHeight - 80) / el.naturalHeight)
  el.style.width = `${Math.round(el.naturalWidth * ratio)}px`
  el.style.height = `${Math.round(el.naturalHeight * ratio)}px`
}

/** Keeps a pan inside what the enlarged, possibly turned picture overhangs the window by. */
function bounded(x: number, y: number) {
  const el = image.value
  if (!el) return { x, y }
  const sideways = turn.value % 180 !== 0
  const width = (sideways ? el.offsetHeight : el.offsetWidth) * scale.value
  const height = (sideways ? el.offsetWidth : el.offsetHeight) * scale.value
  const spanX = Math.max(0, (width - window.innerWidth) / 2)
  const spanY = Math.max(0, (height - window.innerHeight) / 2)
  return { x: clamp(x, -spanX, spanX), y: clamp(y, -spanY, spanY) }
}

function zoom(by: number) {
  scale.value = clamp(scale.value * by, MIN_SCALE, MAX_SCALE)
  offset.value = bounded(offset.value.x, offset.value.y)
}

function rotate() {
  turn.value = (turn.value + 90) % 360
  offset.value = bounded(offset.value.x, offset.value.y)
}

function reset() {
  scale.value = START_SCALE
  turn.value = 0
  offset.value = { x: 0, y: 0 }
}

/** Flies back into the thumbnail it came from while everything fades, then lets go of the picture. */
function close() {
  if (!shown.value) {
    closeImagePreview()
    return
  }
  const el = lift.value
  if (el) {
    el.style.transition = CLOSE_EASE
    el.style.transform = originTransform(origin, el.getBoundingClientRect())
  }
  shown.value = false
  pictureShown.value = false
  window.clearTimeout(closing)
  closing = window.setTimeout(closeImagePreview, 380)
}

/* The ground's fade ending lets go at once, before the 380ms fallback. */
function onGroundFaded(event: TransitionEvent) {
  if (event.propertyName !== "opacity" || shown.value || !imagePreview.value) return
  window.clearTimeout(closing)
  closeImagePreview()
}

function download() {
  const current = imagePreview.value
  if (!current) return
  const link = document.createElement("a")
  link.href = current.url
  link.download = current.name || "image.png"
  document.body.appendChild(link)
  link.click()
  link.remove()
}

/* The file onto the clipboard: the main process first, the window's own decoder for formats the system cannot read. */
async function copyImage() {
  const file = imagePreview.value?.path
  if (!file) return
  const direct = await window.mcode.copyImageFromPath(file).catch(() => ({ ok: false as const, error: "" }))
  const ok = direct.ok || (await copyImageFile(file).then(() => true, () => false))
  if (ok) notice.info(t("imagePreview.copied"))
  else notice.danger(t("imagePreview.copyFailed"))
}

/* MiMo shows the file in its folder without a notice on success; say why on failure. */
async function reveal() {
  const file = imagePreview.value?.path
  if (!file) return
  const result = await window.mcode.revealNativePath(file).catch((error: unknown) => ({ ok: false as const, error: String(error) }))
  if (!result.ok) notice.danger(t("officeCard.revealFailed", { error: result.error }))
}

/* The thumbnail a neighbour is shown by, when it is on screen, so the picture zooms out of that one. */
function thumbnailRect(url: string): PreviewRect | undefined {
  const thumbnail = [...document.querySelectorAll<HTMLImageElement>("img")].find(
    (each) => !each.closest("[data-image-preview]") && (each.dataset.previewSrc === url || each.getAttribute("src") === url),
  )
  return thumbnail?.getBoundingClientRect()
}

function neighbour(by: 1 | -1) {
  const current = imagePreview.value
  const group = current?.group ?? []
  const at = current ? group.indexOf(current.url) : -1
  if (group.length < 2 || at < 0) return
  const next = group[(at + by + group.length) % group.length]
  openImagePreview(next, { group, rect: thumbnailRect(next) })
}

/*
 * On the capture phase, and stopped there: the window's own shortcuts listen
 * for the same keys, and while a picture is up they are its keys.
 */
function onKey(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null
  if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return
  const action = imagePreviewKey(event.key, Boolean(imagePreview.value?.path))
  if (!action) return
  /* Escape drops a box being noted first, as the video preview does, and only then closes. */
  if (action === "close" && (ownRequest || live.value)) {
    dropRequest()
    live.value = null
    boxFrom = undefined
    event.preventDefault()
    event.stopPropagation()
    return
  }
  if (action === "close") close()
  else if (action === "previous") neighbour(-1)
  else if (action === "next") neighbour(1)
  else if (action === "zoomIn") zoom(1.2)
  else if (action === "zoomOut") zoom(0.83)
  else if (action === "reset") reset()
  else if (action === "rotate") rotate()
  else if (action === "download") download()
  else if (action === "copy") void copyImage()
  else reveal()
  event.preventDefault()
  event.stopPropagation()
}

function onWheel(event: WheelEvent) {
  if (event.ctrlKey || event.metaKey) zoom(event.deltaY < 0 ? 1.12 : 0.89)
  else offset.value = bounded(offset.value.x, offset.value.y - event.deltaY)
}

/* ------------------------------------------------------- 框选批注 */

/**
 * A point on the screen as a point on the picture, in its own unscaled pixels.
 *
 * The picture is drawn inside `translate(...) scale(...) rotate(...)` about its
 * own centre, so the transform is undone in that order rather than measured off
 * a bounding box - a turned picture's bounding box is not the picture.
 */
function pictureAt(clientX: number, clientY: number): { x: number; y: number } | undefined {
  const el = image.value
  const frame = el?.parentElement
  if (!el || !frame) return undefined
  const box = frame.getBoundingClientRect()
  const dx = clientX - (box.left + box.width / 2)
  const dy = clientY - (box.top + box.height / 2)
  const radians = (-turn.value * Math.PI) / 180
  const x = (dx * Math.cos(radians) - dy * Math.sin(radians)) / scale.value
  const y = (dx * Math.sin(radians) + dy * Math.cos(radians)) / scale.value
  return { x: x + el.offsetWidth / 2, y: y + el.offsetHeight / 2 }
}

function boxTo(event: PointerEvent): Box | null {
  const at = pictureAt(event.clientX, event.clientY)
  if (!at || !boxFrom) return null
  return { left: Math.min(boxFrom.x, at.x), top: Math.min(boxFrom.y, at.y), w: Math.abs(at.x - boxFrom.x), h: Math.abs(at.y - boxFrom.y) }
}

function dropRequest() {
  if (ownRequest && annotationRequest.value === ownRequest) requestAnnotation(null)
  ownRequest = null
}

/* The box closes with the note: whatever was drawn goes with it, unless a new drag has begun. */
watch(annotationRequest, (current) => {
  if (ownRequest && current !== ownRequest) {
    ownRequest = null
    if (!boxFrom) live.value = null
  }
})

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

/** The drawn box back in screen coordinates, so the note opens against what was boxed. */
function screenRect(box: Box) {
  const el = image.value
  const frame = el?.parentElement
  if (!el || !frame) return { left: 0, top: 0, right: 0, bottom: 0 }
  const area = frame.getBoundingClientRect()
  const radians = (turn.value * Math.PI) / 180
  const corners = [
    [box.left, box.top],
    [box.left + box.w, box.top],
    [box.left, box.top + box.h],
    [box.left + box.w, box.top + box.h],
  ].map(([x, y]) => {
    const dx = (x - el.offsetWidth / 2) * scale.value
    const dy = (y - el.offsetHeight / 2) * scale.value
    return {
      x: area.left + area.width / 2 + dx * Math.cos(radians) - dy * Math.sin(radians),
      y: area.top + area.height / 2 + dx * Math.sin(radians) + dy * Math.cos(radians),
    }
  })
  const xs = corners.map((point) => point.x)
  const ys = corners.map((point) => point.y)
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) }
}

function askAbout(box: Box) {
  const el = image.value
  const current = imagePreview.value
  if (!el || !current) return
  const fx = clamp01(box.left / el.offsetWidth)
  const fy = clamp01(box.top / el.offsetHeight)
  const region = { fx, fy, fw: clamp01((box.left + box.w) / el.offsetWidth) - fx, fh: clamp01((box.top + box.h) / el.offsetHeight) - fy }
  const request: AnnotationRequest = {
    rect: screenRect(box),
    initialText: "",
    above: true,
    emptyEnterStashes: true,
    make: (text): Annotation => {
      const note: Annotation = {
        id: annotationId(),
        kind: "image",
        ...(current.path ? { path: current.path } : {}),
        name: current.name || (current.path ? current.path.split(/[\\/]/).pop() : "") || t("imagePreview.title"),
        region,
        text,
      }
      kept.value = new Map(kept.value).set(note.id, box)
      return note
    },
  }
  ownRequest = request
  requestAnnotation(request)
}

/** The boxes already noted about this picture, numbered as the composer numbers them. */
const markers = computed(() => {
  const list = annotations.list(mainAnnotationScope.value)
  const out: { id: string; num: number; box: Box }[] = []
  list.forEach((note, index) => {
    const box = kept.value.get(note.id)
    if (box) out.push({ id: note.id, num: index + 1, box })
  })
  return out
})

const place = (box: Box) => ({ left: `${box.left}px`, top: `${box.top}px`, width: `${box.w}px`, height: `${box.h}px` })

function startDrag(event: PointerEvent) {
  event.preventDefault()
  try {
    image.value?.setPointerCapture?.(event.pointerId)
  } catch {
    // A pointer that is no longer active cannot be captured; the drag still works without it.
  }
  if (pointerMode.value === "box") {
    dropRequest()
    boxFrom = pictureAt(event.clientX, event.clientY)
    live.value = boxFrom ? { left: boxFrom.x, top: boxFrom.y, w: 0, h: 0 } : null
    return
  }
  drag = { x: event.clientX, y: event.clientY, ox: offset.value.x, oy: offset.value.y }
  dragging.value = true
}

function moveDrag(event: PointerEvent) {
  if (boxFrom) {
    const box = boxTo(event)
    if (box) live.value = box
    return
  }
  if (!drag) return
  offset.value = bounded(drag.ox + event.clientX - drag.x, drag.oy + event.clientY - drag.y)
}

function endDrag(event?: PointerEvent) {
  if (boxFrom) {
    const box = event ? boxTo(event) : live.value
    boxFrom = undefined
    if (!box || (box.w < MIN_BOX && box.h < MIN_BOX)) {
      live.value = null
      return
    }
    live.value = box
    askAbout(box)
    return
  }
  drag = undefined
  dragging.value = false
}

function onResize() {
  fit()
  offset.value = bounded(offset.value.x, offset.value.y)
}

watch(
  () => Boolean(imagePreview.value),
  (open) => {
    if (open) {
      window.addEventListener("keydown", onKey, true)
      window.addEventListener("resize", onResize)
    } else {
      window.removeEventListener("keydown", onKey, true)
      window.removeEventListener("resize", onResize)
    }
  },
)

onBeforeUnmount(() => {
  window.clearTimeout(closing)
  window.clearTimeout(settling)
  window.removeEventListener("keydown", onKey, true)
  window.removeEventListener("resize", onResize)
  dropRequest()
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="imagePreview"
      ref="root"
      v-modal
      data-modal-keep-focus
      class="image-preview"
      role="dialog"
      aria-modal="true"
      :aria-label="t('imagePreview.title')"
      tabindex="-1"
      data-image-preview
      data-new-task-clears
      @click="close"
      @wheel.prevent.stop="onWheel"
    >
      <div class="ip-ground" :style="{ opacity: shown ? 0.72 : 0 }" data-image-preview-ground aria-hidden="true" @transitionend="onGroundFaded" />

      <div class="ip-corner" :class="{ mac: app.platform === 'darwin' }" :style="{ opacity: shown ? 1 : 0 }" @click.stop>
        <button type="button" class="ip-close" :aria-label="t('imagePreview.close')" data-image-preview-close @click="close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
        <span class="ip-tip below">{{ t("imagePreview.close") }}<kbd>Esc</kbd></span>
      </div>

      <div class="ip-stage" @click.stop>
        <div ref="lift" class="ip-lift" :style="{ opacity: pictureShown ? 1 : 0 }">
          <div
            class="ip-transform"
            :class="{ dragging, settled }"
            :style="{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale}) rotate(${turn}deg)` }"
            data-image-preview-transform
          >
            <img
              ref="image"
              :src="imagePreview.url"
              :alt="t('imagePreview.alt')"
              draggable="false"
              :style="{ cursor: pointerMode === 'box' ? 'crosshair' : scale > 1 ? 'grab' : 'zoom-in' }"
              data-image-preview-image
              @load="onImageLoad"
              @error="enter"
              @pointerdown="startDrag"
              @pointermove="moveDrag"
              @pointerup="endDrag"
              @pointercancel="endDrag"
            />
            <!-- The boxes sit inside the transform, so they pan, zoom and turn with the picture. -->
            <div v-for="marker in markers" :key="marker.id" class="ip-mark" data-image-marker :style="place(marker.box)">
              <span class="ip-badge">{{ marker.num }}</span>
            </div>
            <div v-if="live" class="ip-live" data-image-box :style="place(live)" />
          </div>
        </div>
      </div>

      <div class="ip-bar" :class="{ shown }" data-image-preview-bar @click.stop>
        <div class="ip-tool">
          <button type="button" :aria-label="t('imagePreview.zoomOut')" data-preview-tool="zoom-out" @click="zoom(0.83)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.3-4.3M8 11h6" />
            </svg>
          </button>
          <span class="ip-tip">{{ t("imagePreview.zoomOut") }}<kbd>−</kbd></span>
        </div>
        <span class="ip-percent" data-preview-percent>{{ Math.round(scale * 100) }}%</span>
        <div class="ip-tool">
          <button type="button" :aria-label="t('imagePreview.zoomIn')" data-preview-tool="zoom-in" @click="zoom(1.2)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.3-4.3M11 8v6M8 11h6" />
            </svg>
          </button>
          <span class="ip-tip">{{ t("imagePreview.zoomIn") }}<kbd>+</kbd></span>
        </div>
        <div class="ip-tool">
          <button type="button" :aria-label="t('imagePreview.rotate')" data-preview-tool="rotate" @click="rotate">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
              <path d="M21 3v5h-5" />
            </svg>
          </button>
          <span class="ip-tip">{{ t("imagePreview.rotate") }}<kbd>R</kbd></span>
        </div>
        <div class="ip-tool">
          <button type="button" :aria-label="t('imagePreview.reset')" data-preview-tool="reset" @click="reset">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M4 9V6a2 2 0 0 1 2-2h3M15 4h3a2 2 0 0 1 2 2v3M20 15v3a2 2 0 0 1-2 2h-3M9 20H6a2 2 0 0 1-2-2v-3" />
            </svg>
          </button>
          <span class="ip-tip">{{ t("imagePreview.reset") }}<kbd>0</kbd></span>
        </div>
        <span class="ip-divider" />
        <div class="ip-tool">
          <!-- MiMo's two pointer modes: the picture drags, or a drag boxes a part of it to write a note about. -->
          <button
            type="button"
            :class="{ on: pointerMode === 'box' }"
            :aria-pressed="pointerMode === 'box'"
            :aria-label="t('imagePreview.annotate')"
            data-preview-tool="annotate"
            @click="pointerMode = pointerMode === 'box' ? 'view' : 'box'"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
              <path d="M9 12h6" />
            </svg>
          </button>
          <span class="ip-tip">{{ t("imagePreview.annotate") }}</span>
        </div>
        <span class="ip-divider" />
        <div class="ip-tool">
          <button type="button" :aria-label="t('imagePreview.download')" data-preview-tool="download" @click="download">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
            </svg>
          </button>
          <span class="ip-tip">{{ t("imagePreview.download") }}<kbd>D</kbd></span>
        </div>
        <template v-if="imagePreview.path">
          <div class="ip-tool">
            <button type="button" :aria-label="t('imagePreview.copy')" data-preview-tool="copy" @click="copyImage">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="9" y="9" width="11" height="11" rx="2" />
                <path d="M5 15V5a2 2 0 0 1 2-2h10" />
              </svg>
            </button>
            <span class="ip-tip">{{ t("imagePreview.copy") }}<kbd>C</kbd></span>
          </div>
          <div class="ip-tool">
            <!-- MiMo says 在访达中显示 on every platform; the platform's own file manager is named here, as elsewhere in MCode. -->
            <button type="button" :aria-label="t('menu.revealIn', { manager: fileManagerName(app.platform) })" data-preview-tool="reveal" @click="reveal">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M4 20h16" />
                <path d="M4 20V8a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v10" />
              </svg>
            </button>
            <span class="ip-tip">{{ t("menu.revealIn", { manager: fileManagerName(app.platform) }) }}<kbd>F</kbd></span>
          </div>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.image-preview {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: grid;
  place-items: center;
  overflow: hidden;
  padding: 40px;
  outline: none;
}

.ip-ground {
  position: absolute;
  inset: 0;
  background: #000;
  transition: opacity 0.34s cubic-bezier(0.4, 0, 0.2, 1);
}

/*
 * MiMo keeps the tools on the side away from the window buttons: left on
 * Windows and Linux, whose buttons are at the top right, and right on macOS,
 * whose traffic lights are at the top left. Those buttons do not move with the
 * text direction, so neither does this.
 */
.ip-corner {
  position: fixed;
  top: 44px;
  left: 44px;
  z-index: 220;
  display: flex;
  transition: opacity 0.25s ease;
}

.ip-corner.mac {
  left: auto;
  right: 44px;
}

.ip-close {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  color: #fff;
  background: rgb(255 255 255 / 0.1);
  border-radius: 50%;
  backdrop-filter: blur(8px);
  transition: background-color 0.15s;
}

.ip-close:hover {
  background: rgb(255 255 255 / 0.2);
}

.ip-close:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
}

.ip-close svg {
  width: 19px;
  height: 19px;
}

.ip-stage {
  position: relative;
  z-index: 210;
  display: inline-flex;
  max-width: 100%;
  max-height: 100%;
}

/* Its transform and transition are set from script: MiMo's entry out of the thumbnail and exit back into it. */
.ip-lift {
  display: inline-flex;
  transform-origin: center;
  will-change: transform, opacity;
  backface-visibility: hidden;
}

.ip-transform {
  position: relative;
  display: inline-flex;
  transform-origin: center;
}

/* The zoom and pan ease only once the entry has finished. */
.ip-transform.settled {
  transition: transform 0.14s ease;
}

.ip-transform.dragging {
  transition: none;
}

.ip-transform img {
  max-width: calc(100vw - 80px);
  max-height: calc(100vh - 80px);
  object-fit: contain;
  border-radius: 8px;
  /* MiMo's shadow-pop, which its utility writes as this one literal in both schemes. */
  box-shadow: 0 12px 40px #00000024;
  user-select: none;
}

.ip-bar {
  position: fixed;
  inset-inline: 0;
  bottom: 44px;
  z-index: 220;
  display: flex;
  align-items: center;
  gap: 3px;
  width: fit-content;
  margin-inline: auto;
  padding: 6px;
  background: rgb(0 0 0 / 0.5);
  border-radius: 14px;
  backdrop-filter: blur(12px);
  opacity: 0;
  transform: translateY(10px);
  transition:
    opacity 0.28s ease,
    transform 0.28s cubic-bezier(0.22, 0.61, 0.36, 1);
}

.ip-bar.shown {
  opacity: 1;
  transform: none;
}

.ip-tool {
  position: relative;
  display: flex;
}

.ip-tool button {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  color: #fff;
  border-radius: 9px;
  transition: background-color 0.15s;
}

.ip-tool button:hover {
  background: rgb(255 255 255 / 0.15);
}

.ip-tool button:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
}

/* The boxing mode stays lit while it is on, so the crosshair is explained. */
.ip-tool button.on {
  background: rgb(255 255 255 / 0.26);
}

/*
 * A box lives in the picture's own pixels inside the transform, so it pans,
 * zooms and turns with what it points at. The border is drawn at a constant
 * screen width by the transform it sits in, which is what a boxed region should
 * look like at any zoom.
 */
.ip-mark,
.ip-live {
  position: absolute;
  box-sizing: border-box;
  border: 2px solid #3295fb;
  border-radius: 4px;
  pointer-events: none;
}

.ip-live {
  background: rgba(50, 149, 251, 0.12);
}

.ip-mark {
  background: rgba(50, 149, 251, 0.1);
}

.ip-badge {
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

.ip-tool svg {
  width: 19px;
  height: 19px;
}

.ip-percent {
  min-width: 48px;
  color: rgb(255 255 255 / 0.85);
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.ip-divider {
  align-self: center;
  width: 1px;
  height: 20px;
  margin-inline: 3px;
  background: rgb(255 255 255 / 0.2);
}

/* The label and its key, above a bar button and below the close button, on hover. */
.ip-tip {
  position: absolute;
  bottom: calc(100% + 9px);
  inset-inline-start: 50%;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  color: #fff;
  white-space: nowrap;
  background: rgb(18 18 20 / 0.97);
  border-radius: 8px;
  box-shadow: 0 6px 20px rgb(0 0 0 / 0.45);
  font-size: calc(12px * var(--ui-font-scale, 1));
  opacity: 0;
  pointer-events: none;
  transform: translateX(-50%);
  transition: opacity 0.15s;
}

.ip-tip.below {
  top: calc(100% + 9px);
  bottom: auto;
}

.ip-tool:hover .ip-tip,
.ip-corner:hover .ip-tip {
  opacity: 1;
}

.ip-tip kbd {
  padding: 1px 6px;
  color: rgb(255 255 255 / 0.9);
  background: rgb(255 255 255 / 0.15);
  border: 0;
  border-radius: 5px;
  font-family: var(--font-mono);
  font-size: calc(11px * var(--ui-font-scale, 1));
  line-height: 1.4;
}
</style>
