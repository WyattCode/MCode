<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import type { MenuItem } from "../lib/menu"
import ContextMenu from "./ContextMenu.vue"
import ConfirmDialog from "./ConfirmDialog.vue"
import PanelExpand from "./PanelExpand.vue"
import RpReview from "./right/RpReview.vue"
import RpFiles from "./right/RpFiles.vue"
import RpChat from "./right/RpChat.vue"
import RpBrowser from "./right/RpBrowser.vue"
import RpTerminal from "./right/RpTerminal.vue"
import RpDiffTab from "./right/RpDiffTab.vue"
import OfficeTab from "./right/OfficeTab.vue"
import HtmlTab from "./right/HtmlTab.vue"
import FloatingChat from "./right/FloatingChat.vue"
import PaneBoundary from "./right/PaneBoundary.vue"
import { PANEL_MIN_WIDTH, useRightPanel, type RightTab, type RightTool } from "../stores/right-panel"
import { ADD_MENU_ORDER, LAUNCH_HINTED, LAUNCH_ORDER, MAIN_MIN_WIDTH, RAIL_WIDTH, TOOL_INFO, iconOf } from "../lib/right-tools"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"

/**
 * MiMo's right panel.
 *
 * A head of tabs, the plus that adds one, and the button that expands the panel
 * over the conversation; under it the launcher while there are no tabs, or the
 * tab on show. Every tab's pane stays mounted - a terminal keeps its screen, a
 * page keeps its place, a side chat its transcript - and each is drawn inside
 * an error boundary, so a pane that throws shows MiMo's inline error instead of
 * going blank.
 *
 * Its width is dragged on its start edge, kept between 300 and what leaves the
 * conversation 480, and remembered. Opening and closing slide over content
 * that keeps its final layout. Closing a terminal something was typed into
 * asks first, as MiMo's does.
 */
const props = defineProps<{
  /** The conversation on show, for the side chat, the terminal and the review; absent on the home screen. */
  sessionID?: string
  /** The project the tools work in. */
  directory?: string
  browserAllowed: boolean
  /** How much the open side column takes past its rail, for the widest the panel may be. */
  sidebarWidth: number
  /** The side column is folded to its rail, whose buttons then stand over an expanded panel's head. */
  sideCollapsed: boolean
  /** Each tool's shortcut as currently bound; a tool without one shows none. */
  hints: Partial<Record<RightTool, string>>
  /** A modal is up: the floating chat goes inert under it. */
  modalOpen: boolean
  /** The search overlay is open: the floating chat's box dims. */
  searchOpen: boolean
}>()
const emit = defineEmits<{
  "open-settings": [section?: "models"]
  connect: []
  shell: [command: string]
  terminal: []
}>()

const rp = useRightPanel()
const app = useApp()

const tools = computed(() => LAUNCH_ORDER.filter((tool) => tool !== "browser" || props.browserAllowed))

function title(tab: RightTab): string {
  if (tab.name) return tab.name
  if (tab.type === "diff" || tab.type === "office" || tab.type === "html") return ""
  if (tab.type === "files") return t("rp.files.openFileTitle")
  const name = t(TOOL_INFO[tab.type].label)
  return tab.ord > 1 ? `${name} ${tab.ord}` : name
}

/* Width: between MiMo's 300 and what leaves the conversation its 480. */
const viewport = ref(window.innerWidth)
const maxWidth = computed(() => Math.max(PANEL_MIN_WIDTH, viewport.value - RAIL_WIDTH - props.sidebarWidth - MAIN_MIN_WIDTH))
const shownWidth = computed(() => Math.min(maxWidth.value, Math.max(PANEL_MIN_WIDTH, rp.width)))
const resizing = ref(false)

function onResize() {
  viewport.value = window.innerWidth
}

function beginResize(event: MouseEvent) {
  const startX = event.clientX
  const start = shownWidth.value
  const sign = getComputedStyle(event.currentTarget as HTMLElement).direction === "rtl" ? 1 : -1
  resizing.value = true
  document.body.classList.add("resizing")
  const move = (moved: MouseEvent) => {
    rp.width = Math.round(Math.min(maxWidth.value, Math.max(PANEL_MIN_WIDTH, start + sign * (moved.clientX - startX))))
  }
  const done = () => {
    resizing.value = false
    document.body.classList.remove("resizing")
    window.removeEventListener("mousemove", move)
    window.removeEventListener("mouseup", done)
    rp.setWidth(shownWidth.value)
  }
  window.addEventListener("mousemove", move)
  window.addEventListener("mouseup", done)
}

/*
 * MiMo's rp-motion: for the 200ms of an open or close slide the panel clips,
 * and its body keeps the final width, so nothing inside re-lays out per frame.
 */
const motion = ref(false)
let motionTimer: ReturnType<typeof setTimeout> | undefined
watch(
  () => rp.open,
  () => {
    clearTimeout(motionTimer)
    motion.value = true
    motionTimer = setTimeout(() => (motion.value = false), 200)
  },
)

/* Tabs: 160 each, 120 once they would not all fit, then the strip scrolls. */
const panel = ref<HTMLElement>()
const head = ref<HTMLElement>()
const strip = ref<HTMLElement>()
const compact = ref(false)
let measureFrame = 0

function measure() {
  cancelAnimationFrame(measureFrame)
  measureFrame = requestAnimationFrame(() => {
    const box = head.value
    const aside = panel.value
    if (!box || !aside || !rp.open) return
    // MiMo skips mid-slide: below its width less one the pills would turn compact and snap back.
    const width = aside.getBoundingClientRect().width
    if (rp.fullscreen ? width <= 0 : width < shownWidth.value - 1) return
    const style = getComputedStyle(box)
    // MiMo's sum: the head's inner width less the plus, the spacer's floor of 0, and two gaps.
    const room = box.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 26 - 8
    const count = rp.tabs.length
    compact.value = count > 0 && count * 160 + (count - 1) * 4 > room
  })
}

const observer = new ResizeObserver(() => measure())

function onWheel(event: WheelEvent) {
  const box = strip.value
  if (!box || box.scrollWidth <= box.clientWidth) return
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
  if (!delta) return
  box.scrollLeft += delta
  event.preventDefault()
}

watch(() => [rp.active, rp.tabs.length] as const, async () => {
  measure()
  await nextTick()
  strip.value?.querySelector<HTMLElement>(".rp-tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" })
})

onMounted(() => {
  window.addEventListener("resize", onResize)
  for (const element of [head.value, strip.value, panel.value]) if (element) observer.observe(element)
  measure()
})

onBeforeUnmount(() => {
  window.removeEventListener("resize", onResize)
  observer.disconnect()
  cancelAnimationFrame(measureFrame)
  clearTimeout(motionTimer)
})

/* Closing: a terminal something was typed into is held for a question; the rest go at once. */
const pendingClose = ref<string[]>([])

function requestClose(ids: string[]) {
  const held = rp.tabs.filter((tab) => ids.includes(tab.id) && tab.type === "terminal" && tab.used).map((tab) => tab.id)
  const free = ids.filter((id) => !held.includes(id))
  if (free.length) rp.close(free)
  if (held.length) pendingClose.value = held
}

function confirmClose() {
  const ids = pendingClose.value
  pendingClose.value = []
  rp.close(ids)
}

/* The tab menu: close, close the others, close those to the right. */
const tabMenu = ref<{ x: number; y: number; id: string }>()
const tabMenuItems = computed<MenuItem[]>(() => {
  const id = tabMenu.value?.id
  const at = rp.tabs.findIndex((tab) => tab.id === id)
  return [
    { key: "close", label: t("rp.tabs.close") },
    { key: "closeOthers", label: t("rp.tabs.closeOthers"), enabled: rp.tabs.length > 1 },
    { key: "closeRight", label: t("rp.tabs.closeRight"), enabled: at >= 0 && at < rp.tabs.length - 1 },
  ]
})

function openTabMenu(event: MouseEvent, id: string) {
  rp.activate(id)
  tabMenu.value = { x: event.clientX, y: event.clientY, id }
}

function pickTabMenu(key: string) {
  const id = tabMenu.value?.id
  tabMenu.value = undefined
  if (!id) return
  if (key === "close") requestClose([id])
  else if (key === "closeOthers") requestClose(rp.tabs.filter((tab) => tab.id !== id).map((tab) => tab.id))
  else if (key === "closeRight") {
    const at = rp.tabs.findIndex((tab) => tab.id === id)
    requestClose(rp.tabs.slice(at + 1).map((tab) => tab.id))
  }
}

function onTabMouseDown(event: MouseEvent, id: string) {
  if (event.button !== 1) return
  event.preventDefault()
  requestClose([id])
}

/* The plus and its menu of tools. */
const addMenu = ref<{ x: number; y: number }>()
const addItems = computed<MenuItem[]>(() =>
  ADD_MENU_ORDER.filter((tool) => tool !== "browser" || props.browserAllowed).map((tool) => ({
    key: tool,
    label: t(TOOL_INFO[tool].label),
    icon: TOOL_INFO[tool].icon.join(" "),
    hint: props.hints[tool],
  })),
)

function openAddMenu(event: MouseEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  addMenu.value = { x: rect.left, y: rect.bottom + 4 }
}

function pickAdd(key: string) {
  addMenu.value = undefined
  rp.openTool(key as RightTool)
}

/* What each tab was holding goes with it. */
rp.setDisposer((tab) => {
  if (tab.type === "terminal" && tab.shellID) void app.client?.request({ type: "shell.close", shellID: tab.shellID })
  if (tab.type === "browser" && tab.pageId) void window.mcode.browserTab("close", tab.pageId)
})

/* A page is drawn only while a browser tab is the one on show in an open panel. */
const browserShowing = computed(() => rp.open && rp.activeTab?.type === "browser")
watch(browserShowing, (showing) => {
  if (!showing) window.mcode.browserBounds({ x: 0, y: 0, width: 0, height: 0 })
})

const browserPanes = ref<Record<string, InstanceType<typeof RpBrowser>>>({})
function setBrowserPane(id: string, instance: unknown) {
  if (instance) browserPanes.value[id] = instance as InstanceType<typeof RpBrowser>
  else delete browserPanes.value[id]
}

defineExpose({
  /* Ctrl+L and Ctrl+. reach the browser tab on show. */
  activeBrowser: () => (rp.activeTab?.type === "browser" ? browserPanes.value[rp.activeTab.id] : undefined),
  /* C25, MiMo's lj(): Ctrl+R reloads the browser tab on show, else the panel's first browser tab even behind another. */
  reloadTarget: () => {
    const tab = rp.activeTab?.type === "browser" ? rp.activeTab : rp.tabs.find((entry) => entry.type === "browser")
    return tab ? browserPanes.value[tab.id] : undefined
  },
})
</script>

<template>
  <aside
    ref="panel"
    class="right-panel"
    :class="{
      hidden: !rp.open,
      fullscreen: rp.open && rp.fullscreen,
      resizing,
      motion: motion && !rp.fullscreen,
      'side-collapsed': sideCollapsed,
    }"
    :style="{ '--rw': `${shownWidth}px` }"
    :aria-label="t('key.sidePanel')"
    data-right-panel
  >
    <div ref="head" class="rp-head">
      <div ref="strip" class="rp-tabs" :class="{ compact }" role="tablist" @wheel="onWheel">
        <div
          v-for="tab in rp.tabs"
          :key="tab.id"
          class="rp-tab"
          :class="{ active: tab.id === rp.active }"
          role="tab"
          :aria-selected="tab.id === rp.active"
          :data-rp-tab="tab.type"
          @click="rp.activate(tab.id)"
          @mousedown="onTabMouseDown($event, tab.id)"
          @contextmenu.prevent="openTabMenu($event, tab.id)"
        >
          <svg class="rpt-ic" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path v-for="d in iconOf(tab.type)" :key="d" :d="d" />
          </svg>
          <span class="rpt-name" v-tip="{ label: title(tab), placement: 'bottom' }">{{ title(tab) }}</span>
          <button
            type="button"
            class="rpt-close"
            :aria-label="t('rp.tabs.close')"
            v-tip="t('rp.tabs.close')"
            @click.stop="requestClose([tab.id])"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
              <path d="M17 7 7 17M7 7l10 10" />
            </svg>
          </button>
        </div>
      </div>
      <button
        type="button"
        class="rp-add"
        data-rp-add
        :aria-label="t('launch.newTool')"
        v-tip="{ label: t('launch.newTool'), disabled: Boolean(addMenu) }"
        @click="openAddMenu"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
      <span class="rp-head-spacer" />
      <PanelExpand v-if="rp.open" :full="rp.fullscreen" @toggle="rp.toggleFullscreen()" />
    </div>
    <!-- After the head in the document: Electron's later regions win, so its no-drag beats the head's drag. -->
    <div v-if="!rp.fullscreen" class="resizer" :title="t('rp.panel.resizeTitle')" @mousedown.prevent="beginResize" />

    <div v-if="!rp.tabs.length" class="rp-launch" data-rp-launch>
      <button v-for="tool in tools" :key="tool" type="button" class="launch-card" :data-tool="tool" @click="rp.openTool(tool)">
        <svg class="lc-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path v-for="d in TOOL_INFO[tool].icon" :key="d" :d="d" />
        </svg>
        <span class="lc-name">{{ t(TOOL_INFO[tool].label) }}</span>
        <kbd v-if="LAUNCH_HINTED.includes(tool) && hints[tool]" class="lc-kbd">{{ hints[tool] }}</kbd>
      </button>
    </div>

    <div v-else class="rp-body">
      <div v-for="tab in rp.tabs" :key="tab.id" class="rp-pane" :data-rp-pane="tab.id" v-show="tab.id === rp.active">
        <PaneBoundary :reset-key="tab.id">
          <RpReview v-if="tab.type === 'review'" :root="directory" />
          <RpFiles
            v-else-if="tab.type === 'files'"
            :root="directory"
            :viewFile="tab.viewFile"
            @view="(file: string) => rp.update(tab.id, { viewFile: file, name: file.split('/').pop() })"
          />
          <RpChat
            v-else-if="tab.type === 'chat'"
            :convoId="tab.convoId"
            :parentID="sessionID"
            :active="tab.id === rp.active && rp.open"
            @created="(id: string) => rp.update(tab.id, { convoId: id })"
            @open-settings="emit('open-settings', $event)"
            @connect="emit('connect')"
            @shell="emit('shell', $event)"
            @terminal="emit('terminal')"
          />
          <RpBrowser
            v-else-if="tab.type === 'browser'"
            :ref="(instance) => setBrowserPane(tab.id, instance)"
            :active="tab.id === rp.active && rp.open"
            :pageId="tab.pageId"
            @page="(id: string) => rp.update(tab.id, { pageId: id })"
          />
          <RpTerminal
            v-else-if="tab.type === 'terminal'"
            :active="tab.id === rp.active && rp.open"
            :shellID="tab.shellID"
            :cwd="tab.cwd"
            :sessionID="sessionID"
            :directory="directory"
            @opened="(shellID: string, cwd: string) => rp.update(tab.id, { shellID, cwd })"
            @used="rp.update(tab.id, { used: true })"
            @openNew="rp.openTool('terminal')"
          />
          <OfficeTab v-else-if="tab.type === 'office'" :tab="tab" :active="tab.id === rp.active && rp.open" />
          <HtmlTab v-else-if="tab.type === 'html'" :tab="tab" :active="tab.id === rp.active && rp.open" />
          <RpDiffTab v-else-if="tab.type === 'diff'" :diff="tab.diff ?? ''" />
        </PaneBoundary>
      </div>
    </div>

    <!-- MiMo's floating chat: over the foot of the expanded panel, in a conversation. Always in the page, for the composer's dock. -->
    <FloatingChat :shown="rp.open && rp.fullscreen && Boolean(sessionID)" :covered="modalOpen" :searching="searchOpen" />

    <ContextMenu v-if="tabMenu" tool :minWidth="180" :x="tabMenu.x" :y="tabMenu.y" :items="tabMenuItems" @pick="pickTabMenu" @close="tabMenu = undefined" />
    <ContextMenu v-if="addMenu" tool :x="addMenu.x" :y="addMenu.y" :items="addItems" @pick="pickAdd" @close="addMenu = undefined" />
    <ConfirmDialog
      v-if="pendingClose.length"
      :title="t(pendingClose.length > 1 ? 'rp.termClose.batchTitle' : 'rp.termClose.title')"
      :body="t(pendingClose.length > 1 ? 'rp.termClose.batchMessage' : 'rp.termClose.message', { count: pendingClose.length })"
      :confirmLabel="t('rp.termClose.confirm')"
      :danger="false"
      @confirm="confirmClose"
      @close="pendingClose = []"
    />
  </aside>
</template>

<style>
/* MiMo's body.resizing: the drag keeps its cursor off the strip, selects nothing, and no frame takes the pointer. */
body.resizing {
  cursor: col-resize;
  user-select: none;
}

body.resizing iframe,
body.resizing webview {
  pointer-events: none;
}
</style>

<style scoped>
/* MiMo's right panel: --rw wide on its own surface, a line down its start. */
.right-panel {
  position: relative;
  display: flex;
  flex: none;
  flex-direction: column;
  width: var(--rw, 380px);
  min-height: 0;
  background: var(--surface-raised);
  border-inline-start: 1px solid var(--border-weak);
  transition: width 0.2s cubic-bezier(0.16, 1, 0.3, 1), visibility 0s;
}

.right-panel.hidden {
  width: 0;
  overflow: hidden;
  visibility: hidden;
  pointer-events: none;
  border-inline-start-width: 0;
  transition: width 0.2s cubic-bezier(0.16, 1, 0.3, 1), visibility 0s 0.2s;
}

.right-panel.resizing,
body.resizing .right-panel {
  transition: none;
}

/* Sliding open or shut: clipped, with the body at its final width so nothing reflows per frame. */
.right-panel.motion {
  overflow: hidden;
}

.right-panel.motion > .rp-body,
.right-panel.motion > .rp-launch {
  box-sizing: border-box;
  width: calc(var(--rw) - 1px);
}

/* Expanded over the conversation: rounded where it meets the side column, with no shadow (MiMo's --shadow-panel is none). */
.right-panel.fullscreen {
  flex: 1 1 auto;
  width: auto;
  min-width: 0;
  overflow: hidden;
  border-inline-start-width: 0;
  border-start-start-radius: 16px;
  border-end-start-radius: 20px;
}

/* With the side column folded, the rail's toggle, back and forward stand over the head: the tabs start clear of them. */
.right-panel.fullscreen.side-collapsed .rp-head {
  padding-inline-start: 131px;
}

/* MiMo's drag edge: 7px across the start line, never a window drag region. */
.resizer {
  position: absolute;
  inset-block: 0;
  inset-inline-start: -3px;
  z-index: 30;
  width: 7px;
  cursor: col-resize;
  -webkit-app-region: no-drag;
}

/*
 * MiMo's rp-head: 46 tall with its row four down, 10 in at the start and, at the
 * end, clear of the caption buttons and the side panel toggle over it - so the
 * expand button ends 4px before that toggle.
 */
.rp-head {
  position: relative;
  display: flex;
  flex: none;
  box-sizing: border-box;
  align-items: center;
  gap: 4px;
  height: 46px;
  padding-block: 4px 0;
  padding-inline: 10px calc(37px + 100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw));
  -webkit-app-region: drag;
}

.rp-tabs {
  display: flex;
  flex: 0 1 auto;
  align-items: center;
  gap: 4px;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
  -webkit-app-region: no-drag;
}

.rp-tabs::-webkit-scrollbar {
  display: none;
}

/* MiMo's tab: a 160px pill, 4 / 5 / 4 / 7 inside, 12px muted text on --color-side-active. */
.rp-tab {
  display: inline-flex;
  flex: 0 0 160px;
  box-sizing: border-box;
  align-items: center;
  gap: 6px;
  width: 160px;
  min-width: min(160px, 100%);
  max-width: min(160px, 100%);
  padding: 4px 5px 4px 7px;
  color: var(--text-weak);
  background: color-mix(in srgb, var(--text-strong) 6%, transparent);
  border: 1px solid transparent;
  border-radius: 999px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-weight: 400;
  white-space: nowrap;
  cursor: default;
}

.rp-tabs.compact .rp-tab {
  flex-basis: 120px;
  width: 120px;
  min-width: min(120px, 100%);
  max-width: min(120px, 100%);
}

.rp-tab.active {
  color: var(--text-strong);
  background: var(--surface-raised);
  border-color: var(--border-weak);
}

.rpt-ic {
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--text-strong);
}

.rpt-ic path,
.lc-icon path {
  stroke: currentColor;
  stroke-width: 1.33;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.rpt-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* MiMo's rpt-close glyph in --color-txt: 80% ink on light. */
.rpt-close {
  display: grid;
  flex: none;
  place-items: center;
  width: 18px;
  height: 18px;
  padding: 0;
  color: color-mix(in srgb, var(--text-strong) 80%, transparent);
  background: transparent;
  border: 0;
  border-radius: 5px;
}

.rpt-close:hover {
  background: var(--surface-hover);
}

/* The plus follows the tabs: 26px, a 16px glyph in --color-mut, --color-txt under the pointer. */
.rp-add {
  display: grid;
  flex: none;
  place-items: center;
  width: 26px;
  height: 26px;
  padding: 0;
  color: color-mix(in srgb, var(--text-strong) 60%, transparent);
  background: transparent;
  border: 0;
  border-radius: 7px;
  -webkit-app-region: no-drag;
}

.rp-add:hover {
  color: color-mix(in srgb, var(--text-strong) 80%, transparent);
  background: var(--surface-hover);
}

.rp-head-spacer {
  flex: 1;
  min-width: 0;
}

/* MiMo's launcher: cards 10 apart, 16 in. */
.rp-launch {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding: 16px;
  overflow: auto;
}

/* MiMo's launch-card: 14 by 16 on a 12px corner, 12 between icon, name and key, its hover fading in. */
.launch-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  color: var(--text-strong);
  text-align: start;
  background: transparent;
  border: 0;
  border-radius: 12px;
  font-family: inherit;
  line-height: normal;
  cursor: default;
  transition: background-color 0.12s;
}

.launch-card:hover {
  background: var(--surface-hover);
}

.lc-icon {
  flex: none;
  width: 16px;
  height: 16px;
  margin: 0 2px;
  color: var(--text-strong);
}

/* The name in --color-txt: 80% ink on light. */
.lc-name {
  color: color-mix(in srgb, var(--text-strong) 80%, transparent);
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 400;
  white-space: nowrap;
}

/* MiMo's key cap: 11px in --color-dim on the page's own white, 1 by 5 inside a 1px line on a 5px corner. */
.lc-kbd {
  margin-inline-start: auto;
  padding: 1px 5px;
  color: color-mix(in srgb, var(--text-strong) 40%, transparent);
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 5px;
  font-family: inherit;
  font-size: calc(11px * var(--ui-font-scale, 1));
  line-height: normal;
}

/* Dark: MiMo's side-active tint and near-white glyphs, #b8b8b8 plus, and #2a2a2a key caps in #777. */
:root[data-theme="dark"] .rp-tab {
  background: var(--surface-selected);
}

:root[data-theme="dark"] .rp-tab.active {
  background: var(--surface-raised);
}

:root[data-theme="dark"] .rpt-close,
:root[data-theme="dark"] .rp-add:hover,
:root[data-theme="dark"] .lc-name {
  color: var(--text-strong);
}

:root[data-theme="dark"] .rp-add {
  color: #b8b8b8;
}

:root[data-theme="dark"] .lc-kbd {
  color: #777;
  background: #2a2a2a;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .rp-tab {
    background: var(--surface-selected);
  }

  :root:not([data-theme="light"]) .rp-tab.active {
    background: var(--surface-raised);
  }

  :root:not([data-theme="light"]) .rpt-close,
  :root:not([data-theme="light"]) .rp-add:hover,
  :root:not([data-theme="light"]) .lc-name {
    color: var(--text-strong);
  }

  :root:not([data-theme="light"]) .rp-add {
    color: #b8b8b8;
  }

  :root:not([data-theme="light"]) .lc-kbd {
    color: #777;
    background: #2a2a2a;
  }
}

.rp-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.rp-pane {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
</style>
