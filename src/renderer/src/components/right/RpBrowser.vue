<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import type { LocalServer } from "@shared/protocol"
import { ZOOM_MAX, ZOOM_MIN, barMode, loadErrorKind } from "@shared/browser-page"
import { useApp } from "../../stores/app"
import { installBrowserBridge } from "../../lib/browser-bridge"
import { notify, notifyFailure } from "../../lib/toast"
import { t } from "../../lib/i18n"
import { shownChord } from "../../lib/keys"

/**
 * MiMo's browser tab: an address bar - a status dot, back and forward, the
 * address, reload, open in the real browser, a screenshot, and a menu of the
 * rest - over the page. A tab that has been nowhere shows what is answering on
 * this machine instead; a page that failed says why, over the frame, and offers
 * to try again.
 *
 * The page is a view the main process owns and places; this tab is the frame
 * it is placed in. Each tab holds its own page, and only the tab on show asks
 * for it to be drawn - the panel hides the page when no browser tab is showing.
 */
/* url: where a tab opened at an address (a video card's) goes once it has a page. */
const props = defineProps<{ active: boolean; pageId?: string; url?: string }>()
const emit = defineEmits<{ page: [pageId: string]; address: [url: string] }>()
const app = useApp()

interface State {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  tabs: { id: string }[]
  active: string
  zoom: number
  error?: { code: number; url: string; description?: string }
}

const state = ref<State>({ url: "", title: "", loading: false, canGoBack: false, canGoForward: false, tabs: [], active: "", zoom: 100 })
const address = ref("")
const editing = ref(false)
const root = ref<HTMLElement>()
const bar = ref<HTMLElement>()
const stage = ref<HTMLElement>()
const menu = ref<HTMLElement>()
const moreButton = ref<HTMLElement>()
const addressInput = ref<HTMLInputElement>()
const servers = ref<LocalServer[]>([])
const barWidth = ref(400)
const menuOpen = ref(false)
/* MiMo's annotate mode, which MiMo itself still ships as a frame and a "coming soon" hint. */
const annotating = ref(false)
const ANNOTATE_COMBO = "Ctrl+."

const showingPage = computed(() => Boolean(state.value.url) && state.value.url !== "about:blank")
/* MiMo's bar widths: under 300 the secondary buttons give way, under 380 the annotate button does. */
const mode = computed(() => barMode(barWidth.value))
const mini = computed(() => mode.value === "mini")
const compact = computed(() => mode.value !== "full")
const zoomFloor = Math.round(ZOOM_MIN * 100)
const zoomCeiling = Math.round(ZOOM_MAX * 100)

function apply(next: unknown) {
  if (!next || typeof next !== "object") return
  const incoming = next as State
  // The panel speaks for whichever page is open; only this tab's page is this tab's news.
  if (props.pageId && incoming.active && incoming.active !== props.pageId) return
  state.value = incoming
  if (!editing.value) address.value = incoming.url === "about:blank" ? "" : incoming.url
  // The tab keeps its page's address, so a card for the same address takes this tab up again.
  if (incoming.url && incoming.url !== "about:blank" && incoming.url !== props.url) emit("address", incoming.url)
  remeasure()
}

/*
 * The page is a native view drawn over this frame, so nothing here can paint on
 * top of it. While annotating, the page steps back from the frame instead: in
 * by the dashed outline on every side, and down below the hint, which sits in
 * the strip it leaves. The more menu hangs over the frame, so while it is open
 * the page is not drawn at all.
 */
const ANNOTATE_INSET = 2
const ANNOTATE_HINT_SPACE = 46

function measure() {
  if (!props.active) return
  const box = stage.value?.getBoundingClientRect()
  const hidden = !box || !showingPage.value || Boolean(state.value.error) || menuOpen.value
  const inset = !hidden && annotating.value ? ANNOTATE_INSET : 0
  const top = !hidden && annotating.value ? ANNOTATE_HINT_SPACE : 0
  window.mcode.browserBounds({
    x: hidden ? 0 : box.left + inset,
    y: hidden ? 0 : box.top + top,
    width: hidden ? 0 : Math.max(0, box.width - inset * 2),
    height: hidden ? 0 : Math.max(0, box.height - top - inset),
  })
}

function remeasure() {
  void nextTick(measure)
}

/* Makes sure this tab has its page, and that it is the one the panel draws. */
async function claim() {
  if (!props.active) return
  const box = stage.value?.getBoundingClientRect()
  const bounds = { x: box?.left ?? 0, y: box?.top ?? 0, width: 0, height: 0 }
  if (props.pageId) {
    const selected = await window.mcode.browserTab("select", props.pageId)
    if (selected) {
      apply(selected)
      return
    }
  }
  // No page yet, or its page is gone: a new one, which opens the panel's pages if there were none.
  const fresh = (await window.mcode.browserOpen(bounds)) as State | undefined
  if (!fresh?.active) return
  emit("page", fresh.active)
  state.value = fresh
  address.value = ""
  remeasure()
  if (props.url && props.url !== "about:blank") apply(await window.mcode.browserNavigate(props.url))
}

let stopState: (() => void) | undefined
const observer = new ResizeObserver(() => {
  barWidth.value = bar.value?.getBoundingClientRect().width ?? barWidth.value
  remeasure()
})

onMounted(() => {
  installBrowserBridge()
  stopState = window.mcode.onBrowserState(apply)
  if (root.value) observer.observe(root.value)
  if (bar.value) observer.observe(bar.value)
  window.addEventListener("resize", remeasure)
  void claim()
  void scan()
})

onBeforeUnmount(() => {
  stopState?.()
  observer.disconnect()
  window.removeEventListener("resize", remeasure)
  closeMenu()
})

watch(() => props.active, (active) => {
  if (active) void claim()
})
watch([showingPage, () => state.value.error, annotating, menuOpen], () => remeasure())
/* A page that goes blank takes annotating with it, as MiMo's does. */
watch(showingPage, (showing) => {
  if (!showing) annotating.value = false
})

/* Annotating is for a page; a blank tab has nothing to mark, and says so, so Ctrl+. can fall back. */
function toggleAnnotate(): boolean {
  if (!showingPage.value) return false
  annotating.value = !annotating.value
  return true
}

/*
 * MiMo closes the menu on Escape wherever focus is, and on a press anywhere
 * outside it - the press is not swallowed, so it still reaches what it landed on.
 */
function onMenuKey(event: KeyboardEvent) {
  if (event.key === "Escape") closeMenu()
}

function onMenuPress(event: MouseEvent) {
  const target = event.target as Node | null
  if (target && (menu.value?.contains(target) || moreButton.value?.contains(target))) return
  closeMenu()
}

function openMenu() {
  menuOpen.value = true
  window.addEventListener("keydown", onMenuKey)
  document.addEventListener("mousedown", onMenuPress)
}

function closeMenu() {
  menuOpen.value = false
  window.removeEventListener("keydown", onMenuKey)
  document.removeEventListener("mousedown", onMenuPress)
}

/* MiMo's device toolbar is a menu entry that, for now, only says it is coming. */
function deviceToolbar() {
  closeMenu()
  notify(t("rp.browser.toast.deviceToolbarWip"))
}

async function go() {
  editing.value = false
  apply(await window.mcode.browserNavigate(address.value))
}

/* Enter while an input method is still composing picks the word; it must not also navigate. */
function onAddressKey(event: KeyboardEvent) {
  if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  void go()
}

async function act(what: "back" | "forward" | "reload" | "forceReload" | "zoomIn" | "zoomOut" | "zoomReset") {
  apply(await window.mcode.browserAct(what))
}

function forceReload() {
  closeMenu()
  void act("forceReload")
}

function openExternal() {
  if (showingPage.value) window.mcode.openExternal(state.value.url)
}

async function screenshot() {
  const ok = await window.mcode.browserScreenshot().catch(() => false)
  if (ok) notify(t("rp.browser.toast.screenshotOk"))
  else notifyFailure(t("rp.browser.toast.screenshotFail"))
}

async function clearSite(what: "cookies" | "cache") {
  closeMenu()
  const failure = await window.mcode.browserClearSite(what)
  if (what === "cookies") failure ? notifyFailure(t("rp.browser.toast.clearCookiesError")) : notify(t("rp.browser.toast.clearCookies"))
  else failure ? notifyFailure(t("rp.browser.toast.clearCacheError")) : notify(t("rp.browser.toast.clearCache"))
}

async function scan() {
  servers.value =
    (await app.client
      ?.request({ type: "local.servers" })
      .then((result) => result.servers)
      .catch(() => [])) ?? []
}

function openServer(server: LocalServer) {
  address.value = server.url
  void go()
}

/* Chromium's network errors, sorted into MiMo's four explanations by number or by name. */
const errorKind = computed(() => {
  const error = state.value.error
  return error ? loadErrorKind(error.code, error.description ?? "") : undefined
})

defineExpose({
  focusAddress: () => {
    addressInput.value?.focus()
    addressInput.value?.select()
  },
  /* Its own page, even while another tab is on show (C25); a tab that never opened one has nothing to reload. */
  reload: async (force = false) => {
    if (props.pageId) apply(await window.mcode.browserAct(force ? "forceReload" : "reload", props.pageId))
  },
  toggleAnnotate,
})
</script>

<template>
  <div ref="root" class="rp-browser" data-rp-browser>
    <div ref="bar" class="rb-bar" :class="[`tb-${mode}`, { mini }]">
      <span class="rb-dot" aria-hidden="true" />
      <template v-if="!mini">
        <button type="button" class="rb-round" data-rb-back :disabled="!state.canGoBack" :aria-label="t('rp.browser.back')" v-tip="t('rp.browser.back')" @click="act('back')">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true"><path d="M3.2 9 7.9 4.3l.92.92L5.7 8.35h9.1v1.3H5.7l3.12 3.13-.92.92L3.2 9Z" /></svg>
        </button>
        <button type="button" class="rb-round" data-rb-forward :disabled="!state.canGoForward" :aria-label="t('rp.browser.forward')" v-tip="t('rp.browser.forward')" @click="act('forward')">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true"><path d="M14.8 9 10.1 13.7l-.92-.92 3.12-3.13H3.2v-1.3h9.1L9.18 5.22l.92-.92L14.8 9Z" /></svg>
        </button>
      </template>
      <input
        ref="addressInput"
        v-model="address"
        class="rb-url"
        data-rb-url
        spellcheck="false"
        :placeholder="t('rp.browser.urlPlaceholder')"
        @focus="editing = true"
        @blur="editing = false"
        @keydown="onAddressKey"
      />
      <button type="button" class="rb-round" data-rb-reload :aria-label="t('rp.browser.reload')" v-tip="t('rp.browser.reload')" @click="act('reload')">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true">
          <path d="M14.12 10.37A5.3 5.3 0 1 1 11.65 4.41L11 5.54A4 4 0 1 0 12.86 10.04Z" />
          <path d="M12.43 3.07 13.58 6.27 10.23 6.88Z" />
        </svg>
      </button>
      <template v-if="showingPage && !mini">
        <button type="button" class="rb-round" data-rb-open-external :aria-label="t('rp.browser.openExternal')" v-tip="t('rp.browser.openExternal')" @click="openExternal">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" fill-rule="evenodd" aria-hidden="true">
            <path d="M9 2.33a6.67 6.67 0 1 1 0 13.34A6.67 6.67 0 0 1 9 2.33Zm0 1.34a5.33 5.33 0 1 0 0 10.66A5.33 5.33 0 0 0 9 3.67Z" />
            <path d="M11.9 6.1 10.1 10.1 6.1 11.9 7.9 7.9Z" />
          </svg>
        </button>
        <button type="button" class="rb-round" data-rb-screenshot :aria-label="t('rp.browser.screenshotToClipboard')" v-tip="t('rp.browser.screenshotToClipboard')" @click="screenshot">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" fill-rule="evenodd" aria-hidden="true">
            <path d="M3 3.2c0-.39.31-.7.7-.7h10.6c.39 0 .7.31.7.7V9h-1.3V3.8H4.3V9H3V3.2Z" />
            <path d="M6.8 11.4 10.4 7.6l.9.9-3.6 3.8-.9-.9ZM11.2 11.4 7.6 7.6l-.9.9 3.6 3.8.9-.9Z" />
            <path d="M5.8 11.4a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm0 1.2a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6ZM12.2 11.4a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm0 1.2a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6Z" />
          </svg>
        </button>
        <button
          v-if="!compact"
          type="button"
          class="rb-annotate"
          :class="{ active: annotating }"
          data-rb-annotate
          :aria-pressed="annotating"
          v-tip="t('rp.browser.annotate', { combo: shownChord(ANNOTATE_COMBO) })"
          @click="toggleAnnotate"
        >
          <span>{{ t("rp.browser.annotateLabel") }}</span>
          <kbd class="rb-annotate-kbd">{{ shownChord(ANNOTATE_COMBO) }}</kbd>
        </button>
      </template>
      <button
        ref="moreButton"
        type="button"
        class="rb-round"
        data-rb-more
        :aria-label="t('rp.browser.more')"
        v-tip="{ label: t('rp.browser.more'), disabled: menuOpen }"
        @click="menuOpen ? closeMenu() : openMenu()"
      >
        <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true">
          <circle cx="4.63" cy="9" r="0.875" /><circle cx="9" cy="9" r="0.875" /><circle cx="13.38" cy="9" r="0.875" />
        </svg>
      </button>
      <div v-if="menuOpen" ref="menu" class="rb-menu" role="menu" data-rb-menu>
        <button type="button" role="menuitem" class="rb-item" :disabled="!showingPage" @click="forceReload"><span class="rb-item-name">{{ t("rp.browser.dotMenu.forceReload") }}</span></button>
        <button type="button" role="menuitem" class="rb-item" data-rb-device-toolbar :disabled="!showingPage" @click="deviceToolbar"><span class="rb-item-name">{{ t("rp.browser.dotMenu.deviceToolbar") }}</span></button>
        <div class="rb-zoom" role="group" :aria-label="t('rp.browser.dotMenu.zoom')" data-rb-zoom>
          <span class="rb-zoom-label">{{ t("rp.browser.dotMenu.zoom") }}</span>
          <span class="rb-zoom-pill">
            <button type="button" class="rb-step" :disabled="!showingPage || state.zoom <= zoomFloor" :aria-label="t('key.zoomOut')" @click="act('zoomOut')">−</button>
            <span class="rb-zoom-value">{{ state.zoom }}%</span>
            <button type="button" class="rb-step" :disabled="!showingPage || state.zoom >= zoomCeiling" :aria-label="t('key.zoomIn')" @click="act('zoomIn')">+</button>
          </span>
          <button type="button" class="rb-zoom-reset" :disabled="!showingPage" :aria-label="t('key.zoomReset')" @click="act('zoomReset')">↻</button>
        </div>
        <div class="rb-rule" />
        <button type="button" role="menuitem" class="rb-item danger" :disabled="!showingPage" @click="clearSite('cookies')"><span class="rb-item-name">{{ t("rp.browser.dotMenu.clearCookies") }}</span></button>
        <button type="button" role="menuitem" class="rb-item danger" :disabled="!showingPage" @click="clearSite('cache')"><span class="rb-item-name">{{ t("rp.browser.dotMenu.clearCache") }}</span></button>
      </div>
    </div>

    <div v-show="showingPage || state.error" ref="stage" class="rb-frame">
      <div v-if="annotating && !state.error" class="rb-annotate-overlay" data-rb-annotate-overlay role="presentation">
        <div class="rb-annotate-hint">{{ t("rp.browser.annotateHint", { combo: shownChord(ANNOTATE_COMBO) }) }}</div>
      </div>
      <div v-if="state.error" class="rb-error" data-rb-error role="alert">
        <div class="rb-error-title">{{ t("rp.browser.error.title") }}</div>
        <div class="rb-error-desc">{{ t(`rp.browser.error.${errorKind}`) }}</div>
        <div v-if="state.error.url" class="rb-error-url">{{ state.error.url }}</div>
        <button type="button" class="rb-error-retry" @click="act('reload')">{{ t("rp.browser.error.retry") }}</button>
      </div>
    </div>

    <div v-if="!showingPage && !state.error" class="rb-local" data-rb-local>
      <template v-if="servers.length">
        <div class="rb-local-head">{{ t("rp.browser.local") }}</div>
        <div class="rb-local-list">
          <button v-for="server in servers" :key="server.url" type="button" class="rb-server" :data-local-url="server.url" @click="openServer(server)">
            <span class="rb-thumb" aria-hidden="true">
              <span class="rb-thumb-dots"><i /><i /><i /></span>
              <span class="rb-thumb-name">{{ server.name }}</span>
              <span class="rb-thumb-sub">{{ server.label }}</span>
            </span>
            <span class="rb-server-meta">
              <span class="rb-server-title">{{ server.name }}</span>
              <span class="rb-server-url">{{ server.label }}</span>
            </span>
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.rp-browser {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* MiMo's address bar: 14 in on three sides, 8 between its parts; the more menu hangs from it. */
.rb-bar {
  position: relative;
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  margin: 14px 14px 0;
}

.rb-dot {
  flex: none;
  width: 8px;
  height: 8px;
  background: var(--text-success);
  border-radius: 50%;
}

/* MiMo's round button in the bar: no ring or fill, the composer's ink, and a press that gives a little. */
.rb-round {
  display: grid;
  flex: none;
  place-items: center;
  width: 30px;
  height: 30px;
  padding: 0;
  color: #151c13;
  background: transparent;
  border: 0;
  border-radius: 50%;
}

.rb-round:hover {
  background: #f1f0ec;
}

.rb-round:active:not(:disabled) {
  scale: 0.96;
}

.rb-round:disabled {
  opacity: 0.4;
}

.rb-url {
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  color: var(--text-body);
  background: transparent;
  border: 0;
  border-radius: 8px;
  outline: none;
  font-family: var(--font-mono);
  font-size: calc(12px * var(--ui-font-scale, 1));
  transition: background 0.12s;
}

/* MiMo leans on the preflight rule: the placeholder is half the field's own ink. */
.rb-url::placeholder {
  opacity: 1;
  color: color-mix(in oklab, currentcolor 50%, transparent);
}

.rb-url:hover,
.rb-url:focus {
  background: #f1f0ec;
}

/* MiMo's more menu: 42 below the bar's top, at its end, at least 230 wide. */
.rb-menu {
  position: absolute;
  top: 42px;
  inset-inline-end: 0;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  min-width: 230px;
  padding: 5px;
  background: #fffefd;
  border: 1px solid var(--border-weak);
  border-radius: 12px;
  box-shadow: var(--shadow-menu);
  transform-origin: 0 100%;
  animation: rb-menu-pop 0.18s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes rb-menu-pop {
  from {
    opacity: 0;
    transform: scale(0.96) translateY(4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.rb-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 6px 10px;
  color: var(--text-body);
  text-align: start;
  background: transparent;
  border: 0;
  border-radius: 8px;
  font-size: calc(14px * var(--ui-font-scale, 1));
}

.rb-item-name {
  white-space: nowrap;
}

.rb-item:hover:not(:disabled) {
  background: #f1f0ec;
}

.rb-item:disabled {
  opacity: 0.4;
}

.rb-item.danger {
  color: #e5484d;
}

/* MiMo's zoom row: the label, a pill holding − percent +, and a reset of its own beside it. */
.rb-zoom {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  color: var(--text-body);
  font-size: calc(14px * var(--ui-font-scale, 1));
}

.rb-zoom-label {
  flex: 1;
}

.rb-zoom-pill {
  display: inline-flex;
  align-items: center;
  background: #fffefd;
  border: 1px solid #e3e3e0;
  border-radius: 7px;
  overflow: hidden;
}

.rb-zoom-value {
  min-width: 46px;
  padding: 0 2px;
  text-align: center;
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-variant-numeric: tabular-nums;
}

.rb-step,
.rb-zoom-reset {
  display: grid;
  place-items: center;
  /*
   * MiMo writes these plain (24 square under a var(--text-14) glyph), which
   * cuts into the glyph at the top of the interface-size slider. Round 15's
   * U3 rule wins: the box scales with the text it holds.
   */
  width: calc(24px * var(--ui-font-scale, 1));
  height: calc(24px * var(--ui-font-scale, 1));
  padding: 0;
  color: #5c5c57;
  background: transparent;
  border: 0;
  font-size: calc(14px * var(--ui-font-scale, 1));
}

.rb-zoom-reset {
  background: #fffefd;
  border: 1px solid #e3e3e0;
  border-radius: 7px;
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.rb-step:hover:not(:disabled),
.rb-zoom-reset:hover:not(:disabled) {
  background: #f1f0ec;
}

.rb-step:disabled,
.rb-zoom-reset:disabled {
  opacity: 0.4;
}

.rb-rule {
  height: 1px;
  margin: 4px 6px;
  background: var(--border-weak);
}

/* MiMo's annotate button: 34 high, a 1px line on an 8px corner, the chord in a key cap. */
.rb-annotate {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 10px;
  color: var(--text-body);
  background: #fffefd;
  border: 1px solid #e3e3e0;
  border-radius: 8px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-weight: 400;
}

.rb-annotate:hover {
  background: #f1f0ec;
}

.rb-annotate.active {
  color: #2f6fed;
  border-color: #2f6fed;
}

/* The key cap keeps its muted ink while the button is pressed, as MiMo's does. */
.rb-annotate-kbd {
  padding: 0 5px;
  color: #151c1399;
  background: #f0f0f2;
  border: 1px solid var(--border-weak);
  border-radius: 5px;
  font-family: var(--font-mono);
  font-size: calc(11px * var(--ui-font-scale, 1));
  /* MiMo's line is a flat 18px, which cuts into the cap at a large interface font; it scales here (round 15's U3). */
  line-height: calc(18px * var(--ui-font-scale, 1));
}

/* MiMo's page frame: 10 below the bar, 14 in, on a 10px corner. The error covers it exactly. */
.rb-frame {
  position: relative;
  flex: 1;
  min-height: 0;
  margin: 10px 14px 14px;
  border-radius: 10px;
  overflow: hidden;
}

/* MiMo's annotate overlay: a dashed blue outline just inside the frame, the hint centred at its top. */
.rb-annotate-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  outline: 2px dashed #2f6fed;
  outline-offset: -2px;
  background: #2862ff0f;
  border-radius: 10px;
  pointer-events: none;
}

.rb-annotate-hint {
  margin-top: 10px;
  padding: 4px 10px;
  color: #2f6fed;
  background: #fffefd;
  border: 1px solid #2f6fed;
  border-radius: 8px;
  box-shadow: 0 1px 4px #00000014;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

/* MiMo's empty tab: the local servers, scrolling on their own. */
.rb-local {
  flex: 1;
  min-height: 0;
  padding: 8px 2px 24px;
  overflow: auto;
}

.rb-local-head {
  margin: 18px 4px 12px;
  color: #151c13;
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 400;
}

.rb-local-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* MiMo's server card: a small window drawing of the site, then its name and address. */
.rb-server {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  padding: 10px 14px;
  text-align: start;
  background: #fffefd;
  border: 1px solid var(--border-weak);
  border-radius: 12px;
  transition: 0.12s;
}

.rb-server:hover {
  background: #f1f0ec;
  border-color: #dcdcd8;
}

.rb-thumb {
  position: relative;
  display: flex;
  flex: none;
  flex-direction: column;
  width: 120px;
  height: 74px;
  padding: 18px 10px 0;
  background: #fafafa;
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  overflow: hidden;
}

.rb-thumb-dots {
  position: absolute;
  top: 7px;
  inset-inline-start: 8px;
  display: flex;
  gap: 4px;
}

.rb-thumb-dots i {
  display: block;
  width: 6px;
  height: 6px;
  background: #f87171;
  border-radius: 50%;
}

.rb-thumb-dots i:nth-child(2) {
  background: #fbbf24;
}

.rb-thumb-dots i:nth-child(3) {
  background: #34d399;
}

.rb-thumb-name {
  color: #444;
  font-size: calc(10px * var(--ui-font-scale, 1));
  font-weight: 400;
  line-height: 1.2;
  white-space: nowrap;
  text-overflow: ellipsis;
  overflow: hidden;
}

.rb-thumb-sub {
  margin-top: 2px;
  color: #aaa;
  font-size: calc(8px * var(--ui-font-scale, 1));
}

.rb-server-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.rb-server-title {
  color: #151c13;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 400;
}

.rb-server-url {
  margin-top: 2px;
  color: #151c1399;
  font-size: calc(13px * var(--ui-font-scale, 1));
}

/* MiMo's error: over the frame, in the panel's colour, announced. */
.rb-error {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
  background: #fff;
  border-radius: 10px;
}

.rb-error-title {
  color: #151c13;
  font-size: calc(16px * var(--ui-font-scale, 1));
  font-weight: 600;
}

.rb-error-desc {
  max-width: 340px;
  color: var(--text-body);
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: 1.5;
}

.rb-error-url {
  max-width: 340px;
  color: #151c1399;
  font-family: var(--font-mono);
  font-size: calc(12px * var(--ui-font-scale, 1));
  word-break: break-all;
}

.rb-error-retry {
  margin-top: 8px;
  padding: 6px 18px;
  color: #151c13;
  background: #fffefd;
  border: 1px solid #f0ebe5;
  border-radius: 8px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  transition: background 0.12s;
}

.rb-error-retry:hover {
  background: #f1f0ec;
}

/* MiMo's dark values, for the explicit choice and for the system's. */
/* Written out rather than grouped with :is(), which the scoped compiler scopes onto :root and so never matches. */
/* The danger rows keep MiMo's one red over the dark menu ink. */
:root[data-theme="dark"] .rb-round {
  color: #a0a0a0;
}

:root[data-theme="dark"] .rb-round:hover,
:root[data-theme="dark"] .rb-url:hover,
:root[data-theme="dark"] .rb-url:focus,
:root[data-theme="dark"] .rb-item:hover:not(:disabled),
:root[data-theme="dark"] .rb-step:hover:not(:disabled),
:root[data-theme="dark"] .rb-zoom-reset:hover:not(:disabled),
:root[data-theme="dark"] .rb-annotate:hover,
:root[data-theme="dark"] .rb-server:hover,
:root[data-theme="dark"] .rb-error-retry:hover {
  background: #ffffff0f;
}

:root[data-theme="dark"] .rb-local-head,
:root[data-theme="dark"] .rb-server-title,
:root[data-theme="dark"] .rb-error-title,
:root[data-theme="dark"] .rb-error-retry {
  color: #fff;
}

:root[data-theme="dark"] .rb-annotate-kbd,
:root[data-theme="dark"] .rb-server-url,
:root[data-theme="dark"] .rb-error-url {
  color: #b8b8b8;
}

:root[data-theme="dark"] .rb-menu,
:root[data-theme="dark"] .rb-zoom-pill,
:root[data-theme="dark"] .rb-zoom-reset,
:root[data-theme="dark"] .rb-annotate,
:root[data-theme="dark"] .rb-annotate-hint,
:root[data-theme="dark"] .rb-server,
:root[data-theme="dark"] .rb-error,
:root[data-theme="dark"] .rb-error-retry {
  background: #181818;
}

:root[data-theme="dark"] .rb-menu {
  border-color: #2e2e2e;
}

:root[data-theme="dark"] .rb-item.danger {
  color: #e5484d;
}

:root[data-theme="dark"] .rb-zoom-pill,
:root[data-theme="dark"] .rb-zoom-reset,
:root[data-theme="dark"] .rb-annotate {
  border-color: #3a3a3a;
}

:root[data-theme="dark"] .rb-annotate-kbd,
:root[data-theme="dark"] .rb-server,
:root[data-theme="dark"] .rb-server:hover,
:root[data-theme="dark"] .rb-thumb,
:root[data-theme="dark"] .rb-error-retry {
  border-color: #2e2e2e;
}

:root[data-theme="dark"] .rb-rule,
:root[data-theme="dark"] .rb-annotate-kbd {
  background: #2e2e2e;
}

:root[data-theme="dark"] .rb-step,
:root[data-theme="dark"] .rb-zoom-reset {
  color: #d0d0d0;
}

:root[data-theme="dark"] .rb-annotate.active,
:root[data-theme="dark"] .rb-annotate-hint {
  color: #5a9cff;
  border-color: #5a9cff;
}

:root[data-theme="dark"] .rb-annotate-overlay {
  outline-color: #5a9cff;
}

:root[data-theme="dark"] .rb-thumb {
  background: #242424;
}

/*
 * The name on the card was a literal #444 with no dark rule of any kind, so on
 * the #242424 thumbnail it sat at about 1.6:1 - the server's own name was the
 * one thing on the card nobody could read (R25-D2). The label beside it was
 * already #aaa.
 */
:root[data-theme="dark"] .rb-thumb-name {
  color: #c8c8c8;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .rb-thumb-name {
    color: #c8c8c8;
  }

  :root:not([data-theme="light"]) .rb-round {
    color: #a0a0a0;
  }

  :root:not([data-theme="light"]) .rb-round:hover,
  :root:not([data-theme="light"]) .rb-url:hover,
  :root:not([data-theme="light"]) .rb-url:focus,
  :root:not([data-theme="light"]) .rb-item:hover:not(:disabled),
  :root:not([data-theme="light"]) .rb-step:hover:not(:disabled),
  :root:not([data-theme="light"]) .rb-zoom-reset:hover:not(:disabled),
  :root:not([data-theme="light"]) .rb-annotate:hover,
  :root:not([data-theme="light"]) .rb-server:hover,
  :root:not([data-theme="light"]) .rb-error-retry:hover {
    background: #ffffff0f;
  }

  :root:not([data-theme="light"]) .rb-local-head,
  :root:not([data-theme="light"]) .rb-server-title,
  :root:not([data-theme="light"]) .rb-error-title,
  :root:not([data-theme="light"]) .rb-error-retry {
    color: #fff;
  }

  :root:not([data-theme="light"]) .rb-annotate-kbd,
  :root:not([data-theme="light"]) .rb-server-url,
  :root:not([data-theme="light"]) .rb-error-url {
    color: #b8b8b8;
  }

  :root:not([data-theme="light"]) .rb-menu,
  :root:not([data-theme="light"]) .rb-zoom-pill,
  :root:not([data-theme="light"]) .rb-zoom-reset,
  :root:not([data-theme="light"]) .rb-annotate,
  :root:not([data-theme="light"]) .rb-annotate-hint,
  :root:not([data-theme="light"]) .rb-server,
  :root:not([data-theme="light"]) .rb-error,
  :root:not([data-theme="light"]) .rb-error-retry {
    background: #181818;
  }

  :root:not([data-theme="light"]) .rb-menu {
    border-color: #2e2e2e;
  }

  :root:not([data-theme="light"]) .rb-item.danger {
    color: #e5484d;
  }

  :root:not([data-theme="light"]) .rb-zoom-pill,
  :root:not([data-theme="light"]) .rb-zoom-reset,
  :root:not([data-theme="light"]) .rb-annotate {
    border-color: #3a3a3a;
  }

  :root:not([data-theme="light"]) .rb-annotate-kbd,
  :root:not([data-theme="light"]) .rb-server,
  :root:not([data-theme="light"]) .rb-server:hover,
  :root:not([data-theme="light"]) .rb-thumb,
  :root:not([data-theme="light"]) .rb-error-retry {
    border-color: #2e2e2e;
  }

  :root:not([data-theme="light"]) .rb-rule,
  :root:not([data-theme="light"]) .rb-annotate-kbd {
    background: #2e2e2e;
  }

  :root:not([data-theme="light"]) .rb-step,
  :root:not([data-theme="light"]) .rb-zoom-reset {
    color: #d0d0d0;
  }

  :root:not([data-theme="light"]) .rb-annotate.active,
  :root:not([data-theme="light"]) .rb-annotate-hint {
    color: #5a9cff;
    border-color: #5a9cff;
  }

  :root:not([data-theme="light"]) .rb-annotate-overlay {
    outline-color: #5a9cff;
  }

  :root:not([data-theme="light"]) .rb-thumb {
    background: #242424;
  }
}
</style>
