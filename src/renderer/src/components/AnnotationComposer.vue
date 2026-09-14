<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { useAnnotations } from "../stores/annotations"
import {
  annotatableOf,
  annotationId,
  annotationRequest,
  anchorRectOf,
  locate,
  occurrenceOf,
  quoteOf,
  rectOf,
  requestAnnotation,
  requestAnnotationSend,
  type AnnotationRect,
} from "../lib/annotate"
import { t } from "../lib/i18n"

/**
 * MiMo's annotation box.
 *
 * Selecting text in a reply, or in code in the files tab, brings it up 300ms
 * after the selection settles, above the first line of the selection with its
 * right edge on that line's end; double-clicking a passage already annotated
 * reopens it with its note. The files tab asks for it at the pointer to
 * annotate a whole file. Enter (or the arrow) adds the annotation and sends the
 * message at once; the other button only adds it to the box, and an empty note
 * makes it a plain reference. While the note has focus the passage stays lit,
 * since the selection itself has to go.
 */
const props = defineProps<{ scope: string; disabled: boolean }>()
const store = useAnnotations()

const OPEN_DELAY = 300
const CLOSE_DELAY = 180
const MAX_FIELD = 132
const WIDTH = 296
const HIGHLIGHT = "mcode-annotating"

const request = annotationRequest
const box = ref<HTMLElement>()
const field = ref<HTMLTextAreaElement>()
const text = ref("")
const focused = ref(false)
const entered = ref(false)
const closing = ref(false)
const position = ref<{ top: number; left: number } | null>(null)

const shown = computed(() => entered.value && Boolean(position.value) && !closing.value)

/* The composer's top edge is the floor: the box never covers what is being typed. */
function bounds() {
  const composer = document.querySelector<HTMLElement>("#float-dock .composer, #main-dock .composer, #hero-dock .composer")
  const top = composer?.getBoundingClientRect().top ?? 0
  return { width: window.innerWidth, height: top > 0 ? Math.min(window.innerHeight, top - 8) : window.innerHeight }
}

/* MiMo's placement: 8 above the anchor (below it when that runs off the top), right edges together, 8 inside the room. */
function place(rect: AnnotationRect) {
  const el = box.value
  if (!el) return
  const width = el.offsetWidth
  const height = el.offsetHeight
  const room = bounds()
  const edge = 8
  const above = rect.top - height - edge
  const top = Math.min(Math.max(edge, above >= edge ? above : rect.bottom + edge), Math.max(edge, room.height - height - edge))
  const left = Math.min(Math.max(edge, rect.right - width), Math.max(edge, room.width - width - edge))
  position.value = { top, left }
}

function grow() {
  const el = field.value
  if (!el) return
  el.style.height = "auto"
  el.style.height = `${Math.min(el.scrollHeight, MAX_FIELD)}px`
}

watch(request, (next) => {
  clearTimeout(closeTimer)
  closing.value = false
  entered.value = false
  position.value = null
  text.value = next?.initialText ?? ""
  if (!next) return
  void nextTick(() => {
    grow()
    // Measured while still transparent - which lays it out - so turning it on animates it in.
    place(next.rect)
    entered.value = true
    // A fresh selection leaves the focus where it was, so the text can still be copied; the rest take it.
    if (next.index !== undefined || !next.range) field.value?.focus()
  })
})

watch(text, () =>
  void nextTick(() => {
    grow()
    const current = request.value
    if (current) place(current.follow?.() ?? current.rect)
  }),
)

/* The passage stays lit while its note is being written. */
watch([focused, request], ([hasFocus, current]) => {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return
  if (hasFocus && current?.range) {
    CSS.highlights.set(HIGHLIGHT, new Highlight(current.range))
    window.getSelection()?.removeAllRanges()
  } else CSS.highlights.delete(HIGHLIGHT)
})

let closeTimer: ReturnType<typeof setTimeout> | undefined
function close(after?: () => void) {
  if (!request.value || closing.value) return
  closing.value = true
  closeTimer = setTimeout(() => {
    closing.value = false
    requestAnnotation(null)
    after?.()
  }, CLOSE_DELAY)
}

function dismiss() {
  const current = request.value
  close(() => {
    window.getSelection()?.removeAllRanges()
    current?.onClose?.()
  })
}

/** The box's lower button: adds it (or changes its note) and leaves the message unsent. */
function stash() {
  const current = request.value
  if (!current) return
  const value = text.value.trim()
  const scope = current.scope ?? props.scope
  if (current.index !== undefined) {
    store.update(scope, current.index, value)
    close()
    return
  }
  const note = current.make?.(value)
  if (note && store.add(scope, note)) close()
}

/** Enter, or the arrow: adds it and sends the message with everything waiting. */
function send() {
  const current = request.value
  const value = text.value.trim()
  if (current?.sendNow) {
    const note = current.make?.(value)
    if (!note) return
    close()
    current.sendNow(note)
    return
  }
  if (!current || !value) return
  const scope = current.scope ?? props.scope
  if (current.index !== undefined) {
    store.update(scope, current.index, value)
    close()
    requestAnnotationSend(scope)
    return
  }
  const note = current.make?.(value)
  if (note && store.add(scope, note)) {
    close()
    requestAnnotationSend(scope)
  }
}

function onKey(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault()
    send()
  } else if (event.key === "Escape") {
    event.preventDefault()
    dismiss()
  }
}

/* What is selected, if it is something that can be annotated. */
function fromSelection() {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null
  const selected = selection.toString()
  if (!selected.trim()) return null
  const range = selection.getRangeAt(0)
  const host = annotatableOf(range.startContainer)
  if (!host) return null
  const rect = anchorRectOf(range)
  if (!rect) return null
  const quote = quoteOf(selected)
  const { occ, occTotal } = occurrenceOf(host.el, range, quote)
  const kept = range.cloneRange()
  requestAnnotation({
    scope: host.scope,
    rect,
    follow: () => anchorRectOf(kept),
    range: kept,
    make: (note) => ({
      id: annotationId(),
      kind: host.kind,
      ...(host.path ? { path: host.path } : {}),
      quote,
      occ,
      occTotal,
      text: note,
    }),
  })
  return true
}

const QUIET_KEYS = new Set(["Shift", "Home", "End", "PageUp", "PageDown"])
let openTimer: ReturnType<typeof setTimeout> | undefined

function inside(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest("[data-annotation-composer]"))
}

function settle(event: MouseEvent | KeyboardEvent) {
  if (inside(event.target)) return
  if (event instanceof MouseEvent && event.button !== 0) return
  if (event instanceof KeyboardEvent && !(QUIET_KEYS.has(event.key) || event.key.startsWith("Arrow"))) return
  if (props.disabled) return
  clearTimeout(openTimer)
  openTimer = setTimeout(() => {
    if (!props.disabled) fromSelection()
  }, OPEN_DELAY)
}

function press(event: MouseEvent) {
  if (inside(event.target)) return
  clearTimeout(openTimer)
  if (event.button === 0 && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed && selection.rangeCount && annotatableOf(selection.getRangeAt(0).startContainer)) {
      selection.removeAllRanges()
    }
  }
  const current = request.value
  if (current) close(() => current.onClose?.())
}

/* Double-clicking a passage already annotated opens its note again. */
function reopen(event: MouseEvent) {
  if (inside(event.target) || props.disabled) return
  const host = annotatableOf(event.target as Node)
  if (!host) return
  const scope = host.scope ?? props.scope
  const list = store.list(scope)
  for (let index = list.length - 1; index >= 0; index--) {
    const note = list[index]
    if (note.kind !== host.kind || !note.quote) continue
    if (note.kind === "code" && note.path !== host.path) continue
    const range = locate(host.el, note.quote, note.occ)
    if (!range) continue
    const hit = [...range.getClientRects()].some(
      (rect) => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom,
    )
    const rect = hit ? (anchorRectOf(range) ?? rectOf(range)) : null
    if (!rect) continue
    event.preventDefault()
    window.getSelection()?.removeAllRanges()
    requestAnnotation({ scope: host.scope, rect, follow: () => anchorRectOf(range), range, index, initialText: note.text })
    return
  }
}

let followFrame: ReturnType<typeof setTimeout> | undefined
function follow() {
  if (followFrame || !request.value) return
  followFrame = setTimeout(() => {
    followFrame = undefined
    const rect = request.value?.follow?.()
    if (rect) place(rect)
  }, 16)
}

onMounted(() => {
  document.addEventListener("mouseup", settle)
  document.addEventListener("keyup", settle)
  document.addEventListener("mousedown", press)
  document.addEventListener("dblclick", reopen, true)
  window.addEventListener("scroll", follow, true)
  window.addEventListener("resize", follow)
})

onBeforeUnmount(() => {
  document.removeEventListener("mouseup", settle)
  document.removeEventListener("keyup", settle)
  document.removeEventListener("mousedown", press)
  document.removeEventListener("dblclick", reopen, true)
  window.removeEventListener("scroll", follow, true)
  window.removeEventListener("resize", follow)
  clearTimeout(openTimer)
  clearTimeout(closeTimer)
  clearTimeout(followFrame)
  if (typeof CSS !== "undefined" && "highlights" in CSS) CSS.highlights.delete(HIGHLIGHT)
  requestAnnotation(null)
})

/* Another conversation, or a dialog over everything, ends it. */
watch(
  () => props.scope,
  () => requestAnnotation(null),
)
watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) requestAnnotation(null)
  },
)
</script>

<template>
  <Teleport to="body">
    <div
      v-if="request"
      ref="box"
      class="ann-composer"
      data-annotation-composer
      :class="{ shown, focused, closing }"
      :style="{ top: `${position?.top ?? -9999}px`, left: `${position?.left ?? -9999}px`, width: `${WIDTH}px` }"
    >
      <textarea
        ref="field"
        v-model="text"
        rows="1"
        :placeholder="t('annotations.convoPlaceholder')"
        @focus="focused = true"
        @blur="focused = false"
        @keydown="onKey"
      />
      <button v-if="text.trim()" type="button" class="ann-send" data-ann-send :aria-label="t('annotations.send')" :title="t('annotations.send')" @click="send">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
      </button>
      <button
        type="button"
        class="ann-stash"
        data-ann-stash
        :aria-label="t('annotations.stash')"
        :title="`${t('annotations.stash')}\n${t('annotations.stashTip')}`"
        @click="stash"
      >
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M8.5 2.5H3.5a1.5 1.5 0 0 0-1.5 1.5v6.5a1.5 1.5 0 0 0 1.5 1.5H5v2.5l3-2.5h4.5a1.5 1.5 0 0 0 1.5-1.5V7.5" />
          <path d="M12.5 1v4.5M10.25 3.25h4.5" />
        </svg>
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
/* MiMo's annotation box: 296 wide, 5 / 6 / 5 / 10 in, a 1px line on a 10px corner; lifts from a tip shadow to a menu shadow with focus. */
.ann-composer {
  position: fixed;
  z-index: 120;
  display: flex;
  align-items: center;
  gap: 5px;
  box-sizing: border-box;
  max-width: 92vw;
  padding: 5px 6px 5px 10px;
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 10px;
  box-shadow: 0 2px 8px #0000000d, 0 1px 2px #0000000a;
  opacity: 0;
  transform: translateY(-6px) scale(0.96);
  transform-origin: top center;
  transition:
    opacity 0.18s cubic-bezier(0.16, 1, 0.3, 1),
    transform 0.18s cubic-bezier(0.16, 1, 0.3, 1),
    box-shadow 140ms ease;
  will-change: opacity, transform;
}

.ann-composer.shown {
  opacity: 1;
  transform: translateY(0) scale(1);
}

.ann-composer.closing {
  pointer-events: none;
}

.ann-composer.focused {
  box-shadow: 0 8px 30px #0000002e, 0 1px 3px #0000001a;
}

:root[data-theme="dark"] .ann-composer {
  box-shadow: 0 2px 8px #0000004d, 0 1px 2px #00000040;
}

:root[data-theme="dark"] .ann-composer.focused {
  box-shadow: 0 8px 30px #0009, 0 1px 3px #0006;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .ann-composer {
    box-shadow: 0 2px 8px #0000004d, 0 1px 2px #00000040;
  }

  :root:not([data-theme="light"]) .ann-composer.focused {
    box-shadow: 0 8px 30px #0009, 0 1px 3px #0006;
  }
}

@media (prefers-reduced-motion: reduce) {
  .ann-composer {
    transition: none;
  }
}

.ann-composer textarea {
  display: block;
  flex: 1;
  min-width: 0;
  max-height: 132px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  color: var(--text-strong);
  background: transparent;
  border: none;
  outline: none;
  resize: none;
  font-family: inherit;
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 18px;
}

.ann-send,
.ann-stash {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border-radius: 8px;
}

.ann-send {
  color: #fff;
  background: #3295fb;
  border: none;
}

.ann-stash {
  color: #3295fb;
  background: transparent;
  border: 1px solid var(--border-weak);
}
</style>

<style>
/* The passage being annotated, lit in MiMo's selection blue while its note has focus. */
::highlight(mcode-annotating) {
  background-color: #b3d7ff;
}

:root[data-theme="dark"] ::highlight(mcode-annotating) {
  background-color: #33518a;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) ::highlight(mcode-annotating) {
    background-color: #33518a;
  }
}

/* A chip's passage, lit for a moment when the chip is clicked (MiMo's flash). */
::highlight(mcode-annotation-flash) {
  background-color: rgba(50, 149, 251, 0.6);
  border-radius: 3px;
}
</style>
