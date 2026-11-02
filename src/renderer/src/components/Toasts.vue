<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { dismiss, hold, release, toasts, visibleToastIds, type ToastLink } from "../lib/toast"
import { t } from "../lib/i18n"

/*
 * Where the column stands: over the middle of the work area, not of the
 * window. MiMo writes the centre of its `<main>` onto the page and puts the
 * notices there, following it as the side column and the panels resize; a
 * scrim over the whole window sends them back to the window's own centre,
 * which is the rule in the stylesheet below.
 */
const centre = ref<string>()
let watching: ResizeObserver | undefined

const shownIds = computed(() => visibleToastIds(toasts.value))

/*
 * This is a CSS pixel written onto the page, so it goes wrong in two ways, not
 * one. The side column and the panels change where the work area is, and the
 * observer below catches that. A **zoom** step changes what a CSS pixel is,
 * and used to reach nothing here at all: the number stayed as it was and the
 * column stood off centre by the zoom ratio - measured at 110% on 2026-09-24,
 * the work area's centre was 810 while this still carried 878, which is how
 * the zoom notice itself came up a tenth of the window right of centre. A step
 * now arrives as the resize it is (`lib/zoom-resize`), and an arriving notice
 * re-measures before it is painted.
 */
function measure() {
  const main = document.querySelector("main.main")
  if (!main) {
    centre.value = undefined
    return
  }
  const box = main.getBoundingClientRect()
  if (box.width === 0) {
    centre.value = undefined
    return
  }
  /*
   * The work area is not all of `main`: the info card is drawn over its inline
   * end rather than standing beside it, so centring on the whole of it put the
   * notices half the card's width off to the side - the same thing the
   * conversation itself was doing, and the user's complaint on 2026-09-24. The
   * card's own box says which end it holds, so this needs no reading direction.
   */
  let start = box.left
  let end = box.right
  const card = main.querySelector(".info-card:not(.floating)")?.getBoundingClientRect()
  if (card && card.width > 0) {
    if (card.left - box.left > box.right - card.right) end = card.left
    else start = card.right
  }
  centre.value = `${Math.round((start + end) / 2)}px`
}

/* A link runs its step, then the notice has done its job. */
function follow(id: string, link: ToastLink) {
  link.run()
  dismiss(id)
}

/*
 * MiMo's keyboard way in (sonner's hotkey): Alt+T puts focus on the notices,
 * which hold still while it is there. Escape, or focus leaving them, puts it
 * back where it was without scrolling.
 */
const list = ref<HTMLElement>()
let before: HTMLElement | null = null

function onHotkey(event: KeyboardEvent) {
  // MiMo's check asks only that Alt is down and the key is T; a chord that carries more still counts.
  if (!event.altKey || event.code !== "KeyT") return
  if (toasts.value.length) list.value?.focus()
}

function onFocusIn(event: FocusEvent) {
  if (before !== null || !list.value) return
  const from = event.relatedTarget
  before = from instanceof HTMLElement && !list.value.contains(from) ? from : document.body
  for (const toast of toasts.value) hold(toast.id)
}

function giveBack() {
  const target = before
  before = null
  for (const toast of toasts.value) release(toast.id)
  if (target && target !== document.body) target.focus({ preventScroll: true })
}

function onFocusOut(event: FocusEvent) {
  if (list.value?.contains(event.relatedTarget as Node | null)) return
  giveBack()
}

function onListKey(event: KeyboardEvent) {
  if (event.key !== "Escape") return
  event.preventDefault()
  event.stopPropagation()
  giveBack()
}

/* A press on a capsule's text leaves focus where it was: capsules take focus for the keyboard only. */
function keepFocus(event: MouseEvent) {
  if (!(event.target instanceof Element && event.target.closest("button"))) event.preventDefault()
}

/*
 * The last notice leaving with focus inside hands focus back as well.
 *
 * A notice arriving re-measures first. This watcher runs before the DOM is
 * patched, so the capsule's first painted frame already stands in the right
 * place - see the note on `measure` for why the observers alone are not enough.
 */
watch(
  () => toasts.value.length,
  (count, was) => {
    if (count > (was ?? 0)) measure()
    if (!count && before !== null) giveBack()
  },
)

let waiting = 0
let arriving: MutationObserver | undefined

/* The work area may not be on the page yet when this column is; MiMo waits a frame at a time for it, as this does. */
function followMain() {
  const main = document.querySelector("main.main")
  if (!main) {
    waiting = requestAnimationFrame(followMain)
    return
  }
  measure()
  if (typeof ResizeObserver !== "function") return
  watching = new ResizeObserver(measure)
  watching.observe(main)
  /*
   * And the card coming or going, which a size observer cannot see.
   *
   * The info card is drawn over the work area's end rather than beside it, so
   * it changes where the middle *is* without changing `main`'s box at all -
   * nothing resizes, and the observer above never fires. A conversation opened
   * at start-up raises its notice before the card has rendered, so the notice
   * was placed as if there were no card and then stayed there (R27). This is a
   * child list, not a subtree: the card is a child of `main`.
   */
  if (typeof MutationObserver !== "function") return
  arriving = new MutationObserver(measure)
  arriving.observe(main, { childList: true })
}

onMounted(() => {
  document.addEventListener("keydown", onHotkey)
  followMain()
  window.addEventListener("resize", measure)
})

onBeforeUnmount(() => {
  document.removeEventListener("keydown", onHotkey)
  window.removeEventListener("resize", measure)
  cancelAnimationFrame(waiting)
  watching?.disconnect()
  arriving?.disconnect()
})
</script>

<template>
  <!--
    MiMo's notices: one capsule per line, 24 under the top edge and centred on
    the work area, the newest first. Only three are shown; the rest wait their
    turn rather than being thrown away. The column lets clicks through; only a
    capsule takes the pointer. As in MiMo, each capsule is an alert and a Tab
    stop of its own inside the polite column.
  -->
  <div
    ref="list"
    class="toasts"
    role="status"
    aria-live="polite"
    tabindex="-1"
    data-toasts
    :style="centre ? { left: centre } : undefined"
    @focusin="onFocusIn"
    @focusout="onFocusOut"
    @keydown="onListKey"
  >
    <TransitionGroup name="toast">
      <div
        v-for="(toast, at) in toasts"
        :key="toast.id"
        class="notice"
        :class="[toast.level, { over: !shownIds.has(toast.id) }]"
        :data-level="toast.level"
        :data-over="shownIds.has(toast.id) ? undefined : 'true'"
        role="alert"
        :tabindex="shownIds.has(toast.id) ? 0 : -1"
        @mousedown="keepFocus"
        @mouseenter="hold(toast.id)"
        @mouseleave="release(toast.id)"
      >
        <svg
          class="mark"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <template v-if="toast.level === 'warning'">
            <path d="M12 3.8 21.2 19.8H2.8z" />
            <path d="M12 10v4.2M12 17v.2" />
          </template>
          <template v-else>
            <circle cx="12" cy="12" r="9.2" />
            <path v-if="toast.level === 'success'" d="m8 12.3 2.8 2.8 5.2-5.4" />
            <path v-else-if="toast.level === 'danger'" d="m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6" />
            <path v-else d="M12 11.2v5.2M12 7.6v.2" />
          </template>
        </svg>
        <span class="text">
          <span class="title">{{ toast.title }}</span>
          <button v-for="link in toast.links" :key="link.label" type="button" class="link" @click="follow(toast.id, link)">
            {{ link.label }}
          </button>
        </span>
        <button v-if="toast.closable" type="button" class="close" :aria-label="t('common.close')" @click="dismiss(toast.id)">✕</button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toasts {
  position: fixed;
  top: 24px;
  left: 50%;
  transform: translateX(-50%);
  max-width: calc(100% - 32px);
  /* Over the image and video previews, which are 210 and 220: MiMo's notices are top-most. */
  z-index: 230;
  display: flex;
  flex-direction: column;
  /* sonner's expanded stack, which MiMo uses: 14 between notices. */
  gap: 14px;
  align-items: center;
  pointer-events: none;
  /* Focused from Alt+T; the notices themselves show where the keyboard is. */
  outline: none;
  /* Over the caption band's drag region, never part of it. */
  -webkit-app-region: no-drag;
}

/*
 * A scrim over the whole window takes the work area's centre away, so the
 * notices go back to the window's, as MiMo's `#app:has(.overlay.full)` does.
 */
#app:has(.overlay, .scrim, .search-overlay) .toasts {
  left: 50% !important;
}

/* Past the third: kept, still on its clock, and shown the moment one in front goes. */
.notice.over {
  display: none;
}

/* MiMo's capsule, measured: 16 round, 8 by 12 of padding, 13px text on a 1.3 line. */
.notice {
  display: inline-flex;
  align-items: flex-start;
  gap: 6px;
  max-width: min(560px, 100%);
  padding: 8px 12px;
  color: var(--text-body);
  background: #ffffff;
  border: 1px solid #ececec;
  border-radius: 16px;
  box-shadow: var(--shadow-menu);
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: 1.3;
  pointer-events: auto;
  -webkit-app-region: no-drag;
}

.notice:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: 2px;
}

.notice.success {
  background: #e5f3ff;
  border-color: #c9e6ff;
}

.notice.warning {
  background: #ffe7d9;
  border-color: #ffd0b8;
}

.notice.danger {
  background: #ffd9d9;
  border-color: #ffbdbd;
}

:root[data-theme="dark"] .notice {
  color: #f4f4f5;
  background: #2e2e2e;
  border-color: #3a3a3a;
}

:root[data-theme="dark"] .notice.success {
  background: #00284d;
  border-color: #0a3f75;
}

:root[data-theme="dark"] .notice.warning {
  background: #4a2206;
  border-color: #6b3309;
}

:root[data-theme="dark"] .notice.danger {
  background: #4d100e;
  border-color: #711a16;
}

.link:focus-visible,
.close:focus-visible {
  outline: 2px solid var(--text-interactive);
  outline-offset: -2px;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .notice {
    color: #f4f4f5;
    background: #2e2e2e;
    border-color: #3a3a3a;
  }

  :root:not([data-theme="light"]) .notice.success {
    background: #00284d;
    border-color: #0a3f75;
  }

  :root:not([data-theme="light"]) .notice.warning {
    background: #4a2206;
    border-color: #6b3309;
  }

  :root:not([data-theme="light"]) .notice.danger {
    background: #4d100e;
    border-color: #711a16;
  }
}

/* 14 square, a pixel down so it sits on the first line. */
.mark {
  flex: none;
  margin-block-start: 1px;
}

.text {
  min-width: 0;
  overflow-wrap: anywhere;
}

/* MiMo's links: blue, 8 after the title, underlined only under the pointer. */
.link {
  margin-inline-start: 8px;
  padding: 0;
  color: #2f6fed;
  font: inherit;
  line-height: 1;
  vertical-align: baseline;
  background: none;
  cursor: pointer;
}

.link:hover {
  text-decoration: underline;
}

.link:focus-visible,
.close:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: 2px;
  border-radius: 4px;
}

:root[data-theme="dark"] .link {
  color: #5a9cff;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .link {
    color: #5a9cff;
  }
}

/* The close mark is a glyph at half strength, fully drawn under the pointer. */
.close {
  flex: none;
  margin-inline-end: -4px;
  padding: 0 4px;
  color: inherit;
  font-size: calc(11px * var(--ui-font-scale, 1));
  line-height: 1.4;
  background: none;
  border-radius: 999px;
  opacity: 0.5;
  cursor: pointer;
}

.close:hover {
  background: var(--surface-hover);
  opacity: 1;
}

/*
 * Down from above the top edge it sits against, and back up the same way:
 * MiMo's notices travel their own height over .4s rather than eight pixels.
 */
.toast-enter-active,
.toast-leave-active {
  transition:
    opacity 0.4s,
    transform 0.4s;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(-100%);
}

@media (prefers-reduced-motion: reduce) {
  .toast-enter-active,
  .toast-leave-active {
    transition: opacity 0.15s ease;
  }

  .toast-enter-from,
  .toast-leave-to {
    transform: none;
  }
}
</style>

