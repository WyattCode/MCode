<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import type { LocalServer } from "@shared/protocol"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"
import PanelExpand from "./PanelExpand.vue"

/**
 * The browser panel.
 *
 * Everything here is chrome. The page itself is a view the main process owns
 * and places, and this component's job is to tell it where: `.stage` is an
 * empty box whose position on screen is measured and sent across whenever the
 * layout moves. Drawing the page in here instead would mean letting an
 * arbitrary site run inside the renderer that draws this app.
 *
 * That division is also why the stage is deliberately empty in the markup. It
 * looks like a hole in the component, and it is: the hole is where the page
 * shows through.
 */
const app = useApp()
const emit = defineEmits<{ close: []; fullscreen: [] }>()
/* At the window's right edge, where the caption buttons and the side panel button sit over its tab row. */
/* `full`: expanded over the main column. */
defineProps<{ edge?: boolean; full?: boolean }>()

interface Tab {
  id: string
  title: string
  url: string
  loading: boolean
}

interface State {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  tabs: Tab[]
  active: string
}

const state = ref<State>({
  url: "",
  title: "",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  tabs: [],
  active: "",
})
const address = ref("")
/* While the reader is typing, the bar is theirs; the page stops rewriting it. */
const editing = ref(false)
const stage = ref<HTMLElement>()
const servers = ref<LocalServer[]>([])
const scanning = ref(false)

/*
 * The panel's width, held locally while a drag is in flight and read from the
 * config the rest of the time - the same arrangement the project panel uses,
 * so a drag stays smooth and what is kept is what was let go of.
 */
const MIN_WIDTH = 320
const DEFAULT_WIDTH = 420
const dragWidth = ref<number>()
const dragging = ref(false)

const width = computed(() =>
  Math.max(MIN_WIDTH, dragWidth.value ?? app.config?.browserWidth ?? DEFAULT_WIDTH),
)

function clampWidth(want: number) {
  /* Never more than two thirds: the conversation is the reason the panel is
     beside it rather than over it. */
  return Math.round(Math.min(window.innerWidth * 0.66, Math.max(MIN_WIDTH, want)))
}

async function commitWidth(next: number) {
  dragWidth.value = next
  if (next !== app.config?.browserWidth) await app.patchConfig({ browserWidth: next })
  dragWidth.value = undefined
}

function beginResize(event: PointerEvent) {
  if (event.detail > 1) return
  const target = event.currentTarget as HTMLElement
  const startX = event.clientX
  const startWidth = width.value
  /* The panel is on the trailing edge, so widening means dragging towards the
     leading one - and in Arabic that is the other direction. */
  const sign = getComputedStyle(target).direction === "rtl" ? 1 : -1
  target.setPointerCapture(event.pointerId)
  dragging.value = true
  dragWidth.value = startWidth

  const move = (moved: PointerEvent) => {
    dragWidth.value = clampWidth(startWidth + sign * (moved.clientX - startX))
    remeasure()
  }
  const done = () => {
    dragging.value = false
    target.removeEventListener("pointermove", move)
    target.removeEventListener("pointerup", done)
    target.removeEventListener("pointercancel", done)
    void commitWidth(width.value)
  }
  target.addEventListener("pointermove", move)
  target.addEventListener("pointerup", done)
  target.addEventListener("pointercancel", done)
}

function resetWidth() {
  void commitWidth(DEFAULT_WIDTH)
}

let stopState: (() => void) | undefined

const showingPage = computed(() => Boolean(state.value.url))

function apply(next: unknown) {
  if (!next || typeof next !== "object") return
  state.value = next as State
  if (!editing.value) address.value = state.value.url
  /* Any of this can change the layout - a page arriving takes the starting
     list's room, a title can wrap the strip - so the hole is measured again. */
  remeasure()
  /* The last tab closing takes the panel with it; the window is told so it can
     stop drawing a frame around nothing. */
  if (!state.value.tabs.length) emit("close")
}

/** Where the page goes, in the window's own pixels. */
function measure() {
  const box = stage.value?.getBoundingClientRect()
  if (!box) return
  const zoom = window.devicePixelRatio === 0 ? 1 : 1
  window.mcode.browserBounds({
    x: box.left * zoom,
    y: box.top * zoom,
    width: box.width * zoom,
    height: box.height * zoom,
  })
}

/*
 * After the DOM has settled, not after the next paint.
 *
 * This rode requestAnimationFrame, and a window that is not being composited
 * does not get frames: the page was placed once at zero height and never
 * corrected, behind chrome that looked entirely correct. A microtask runs
 * whether or not anything is on screen, which is the right guarantee for a
 * measurement.
 */
function remeasure() {
  void nextTick(measure)
}

onMounted(async () => {
  stopState = window.mcode.onBrowserState(apply)
  const box = stage.value?.getBoundingClientRect()
  const opened = await window.mcode.browserOpen({
    x: box?.left ?? 0,
    y: box?.top ?? 0,
    width: box?.width ?? 0,
    height: box?.height ?? 0,
  })
  apply(opened)
  window.addEventListener("resize", remeasure)
  if (stage.value) observer.observe(stage.value)
  remeasure()
  void scan()
})

onBeforeUnmount(() => {
  window.removeEventListener("resize", remeasure)
  observer.disconnect()
  stopState?.()
  window.mcode.browserClose()
})

/*
 * The hole changes size for three different reasons - the window, the panel's
 * own layout, and the moment a page arrives and the starting list gives up its
 * room - so all three are watched. The first version watched the template ref,
 * which never changes after mount: the observer was attached to nothing and the
 * page sat at zero height while the chrome around it looked right.
 */
const observer = new ResizeObserver(() => remeasure())

watch(showingPage, () => remeasure())

async function go() {
  editing.value = false
  apply(await window.mcode.browserNavigate(address.value))
}

async function act(what: "back" | "forward" | "reload" | "forceReload" | "stop") {
  apply(await window.mcode.browserAct(what))
}

async function tab(what: "new" | "select" | "close", id?: string) {
  apply(await window.mcode.browserTab(what, id))
}

/* What the window's shortcuts reach in here: a new tab, the address bar, a reload. */
const addressInput = ref<HTMLInputElement>()
defineExpose({
  newTab: () => tab("new"),
  focusAddress: () => {
    addressInput.value?.focus()
    addressInput.value?.select()
  },
  reload: (force = false) => act(force ? "forceReload" : "reload"),
})

/** What a tab calls itself before it has been anywhere. */
function tabName(entry: Tab): string {
  return entry.title || entry.url || t("browser.newTab")
}

function openServer(server: LocalServer) {
  address.value = server.url
  void go()
}

/** What is answering on this machine, asked again whenever the reader asks. */
async function scan() {
  scanning.value = true
  servers.value =
    (await app.client
      ?.request({ type: "local.servers" })
      .then((result) => result.servers)
      .catch(() => [])) ?? []
  scanning.value = false
}
</script>

<template>
  <section class="browser" :aria-label="t('browser.title')" :style="{ width: `${width}px` }">
    <!--
      The seam, which is a thing you drag. Eight pixels to grab and three to
      see, the same handle the project panel uses.
    -->
    <div
      v-if="!full"
      class="pane-grip"
      :class="{ on: dragging }"
      @pointerdown.prevent="beginResize"
      @dblclick="resetWidth"
    />
    <!-- MiMo's expand, level with the side panel toggle and 4px before it. -->
    <PanelExpand v-if="edge" class="float-expand" :full="full" @toggle="emit('fullscreen')" />
    <header class="tabs" :class="{ edge }">
      <div class="strip">
        <div
          v-for="entry in state.tabs"
          :key="entry.id"
          class="tab"
          :class="{ on: entry.id === state.active }"
        >
          <button class="tab-open" :title="entry.url || tabName(entry)" @click="tab('select', entry.id)">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="6.2" stroke="currentColor" stroke-width="1.2" />
              <path d="M1.8 8h12.4M8 1.8c1.7 1.8 2.6 3.9 2.6 6.2S9.7 12.4 8 14.2C6.3 12.4 5.4 10.3 5.4 8S6.3 3.6 8 1.8z" stroke="currentColor" stroke-width="1.2" />
            </svg>
            <span class="tab-name">{{ tabName(entry) }}</span>
          </button>
          <button class="tab-close" :aria-label="t('common.close')" @click="tab('close', entry.id)">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            </svg>
          </button>
        </div>
        <button class="ico" :aria-label="t('browser.newTab')" @click="tab('new')">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
          </svg>
        </button>
      </div>
      <!-- No close of its own, as MiMo's panel has none: beside the window's own
           close it read as a second set of window buttons. The last tab closing
           takes the panel with it, and Ctrl+Shift+B puts it away. -->
    </header>

    <div class="bar">
      <button class="ico" :disabled="!state.canGoBack" :aria-label="t('title.back')" @click="act('back')">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <button class="ico" :disabled="!state.canGoForward" :aria-label="t('title.forward')" @click="act('forward')">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <input
        ref="addressInput"
        v-model="address"
        class="address"
        spellcheck="false"
        autocomplete="off"
        :placeholder="t('browser.address')"
        :aria-label="t('browser.address')"
        @focus="editing = true"
        @blur="editing = false"
        @keydown.enter="go"
      />
      <button
        class="ico"
        :aria-label="state.loading ? t('browser.stop') : t('browser.reload')"
        @click="act(state.loading ? 'stop' : 'reload')"
      >
        <svg v-if="state.loading" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="4.5" y="4.5" width="7" height="7" rx="1" fill="currentColor" />
        </svg>
        <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.4V5h-2.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>

    <!--
      The page shows through here. Empty on purpose: see the note at the top.
    -->
    <div ref="stage" class="stage" :class="{ blank: !showingPage }" />

    <div v-if="!showingPage" class="start">
      <div class="start-head">
        <span class="start-title">{{ t("browser.local") }}</span>
        <button class="rescan" :disabled="scanning" @click="scan">{{ t("browser.rescan") }}</button>
      </div>
      <button v-for="server in servers" :key="server.port" class="server" @click="openServer(server)">
        <span class="server-name">{{ server.title || t("browser.untitled") }}</span>
        <span class="server-url">{{ server.url.replace(/^https?:\/\//, "").replace(/\/$/, "") }}</span>
      </button>
      <p v-if="!servers.length" class="none">
        {{ scanning ? t("browser.scanning") : t("browser.noneLocal") }}
      </p>
    </div>
  </section>
</template>

<style scoped>
.browser {
  position: relative;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  height: 100%;
  min-height: 0;
  background: var(--surface-base);
  border-inline-start: 1px solid var(--border-weak);
}

.pane-grip {
  position: absolute;
  z-index: 30;
  inset-block: 0;
  inset-inline-start: -4px;
  width: 8px;
  cursor: col-resize;
}

.tabs {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 6px;
  height: 38px;
  padding: 0 8px;
}

/* Clear of the caption buttons, the side panel button beside them and the expand button before that. */
.tabs.edge {
  padding-inline-end: calc(65px + 100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw));
}

/* Level with the side panel toggle (13 down), ending 4px before it. */
.float-expand {
  position: absolute;
  top: 13px;
  inset-inline-end: calc(37px + 100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw));
  z-index: 31;
}

/* The row scrolls rather than squeezing: a tab too narrow to read is not a
   tab, and the panel is narrow to begin with. */
.strip {
  display: flex;
  flex: 1;
  gap: 4px;
  align-items: center;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}

.strip::-webkit-scrollbar {
  display: none;
}

.tab {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  max-width: 168px;
  height: 26px;
  padding-inline-end: 4px;
  color: var(--text-base);
  background: transparent;
  border-radius: 8px;
}

.tab.on {
  color: var(--text-strong);
  background: var(--surface-raised);
}

.tab:hover:not(.on) {
  background: var(--surface-hover);
}

.tab-open {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  height: 26px;
  padding: 0 4px 0 10px;
  color: inherit;
  background: transparent;
  border: 0;
  cursor: pointer;
}

.tab-name {
  overflow: hidden;
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tab-close {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  color: var(--icon-weak);
  background: transparent;
  border: 0;
  border-radius: 5px;
  cursor: pointer;
}

.tab-close:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.bar {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
  padding: 0 8px 8px;
}

.ico {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  color: var(--icon-base);
  background: transparent;
  border: 0;
  border-radius: 7px;
  cursor: pointer;
}

.ico:hover:not(:disabled) {
  background: var(--surface-hover);
}

.ico:disabled {
  opacity: 0.4;
  cursor: default;
}

.address {
  flex: 1;
  min-width: 0;
  height: 26px;
  padding: 0 10px;
  color: var(--text-strong);
  background: var(--surface-raised);
  border: 1px solid transparent;
  border-radius: 8px;
  outline: none;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.address:focus {
  border-color: var(--border-strong);
}

/*
 * The hole the page shows through. It takes the room whether or not a page is
 * loaded, so the starting list below it does not jump when one arrives.
 */
.stage {
  flex: 1;
  min-height: 0;
}

.stage.blank {
  flex: 0 0 0;
}

.start {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  padding: 6px 12px 14px;
  overflow-y: auto;
}

.start-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.start-title {
  color: var(--text-strong);
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: 18px;
}

.rescan {
  color: var(--text-base);
  background: transparent;
  border: 0;
  font-size: calc(12px * var(--ui-font-scale, 1));
  cursor: pointer;
}

.rescan:hover:not(:disabled) {
  color: var(--text-strong);
}

.server {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  text-align: start;
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 12px;
  cursor: pointer;
}

.server:hover {
  border-color: var(--border-strong);
}

.server-name {
  color: var(--text-strong);
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: 18px;
}

.server-url {
  color: var(--text-weak);
  font-family: var(--font-mono);
  font-size: calc(11.5px * var(--ui-font-scale, 1));
}

.none {
  margin: 0;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
}
</style>
