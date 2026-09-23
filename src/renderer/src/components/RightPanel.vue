<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import type { MenuItem } from "../lib/menu"
import ContextMenu from "./ContextMenu.vue"
import ConfirmDialog from "./ConfirmDialog.vue"
import PanelExpand from "./PanelExpand.vue"
import RpReview from "./right/RpReview.vue"
import RpFiles from "./right/RpFiles.vue"
import RpChat from "./right/RpChat.vue"
// Tabs that are opened rather than shown at start: each its own chunk, the Office viewers and pdf.js with theirs.
const RpBrowser = defineAsyncComponent(() => import("./right/RpBrowser.vue"))
import type RpBrowserComponent from "./right/RpBrowser.vue"
import RpTerminal from "./right/RpTerminal.vue"
import RpDiffTab from "./right/RpDiffTab.vue"
const OfficeTab = defineAsyncComponent(() => import("./right/OfficeTab.vue"))
const HtmlTab = defineAsyncComponent(() => import("./right/HtmlTab.vue"))
import RpSubagents from "./right/RpSubagents.vue"
import FloatingChat from "./right/FloatingChat.vue"
import PaneBoundary from "./right/PaneBoundary.vue"
import { PANEL_MIN_WIDTH, useRightPanel, type RightTab, type RightTool } from "../stores/right-panel"
import { ADD_MENU_ORDER, LAUNCH_HINTED, LAUNCH_ORDER, MAIN_MIN_WIDTH, RAIL_WIDTH, TOOL_INFO, iconOf, panelWidthShown } from "../lib/right-tools"
import { useApp } from "../stores/app"
import { language, t } from "../lib/i18n"
import { shownChord } from "../lib/keys"

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
  // MiMo names a browser tab by its page once the page has a title.
  if (tab.type === "browser" && tab.pageTitle) return tab.pageTitle
  if (tab.name) return tab.name
  // subagents: the one 子智能体 tab, named as MiMo names it.
  if (tab.type === "subagents") return t("launch.subagents")
  if (tab.type === "diff" || tab.type === "office" || tab.type === "html") return ""
  if (tab.type === "files") return t("rp.files.openFileTitle")
  const name = t(TOOL_INFO[tab.type].label)
  return tab.ord > 1 ? `${name} ${tab.ord}` : name
}

/*
 * Whether the tab shows one of the app's own tool names. MCode localizes those
 * (MiMo keeps a short fixed set), so a compact pill may widen to fit one; a
 * page title or a name the reader chose is cut at the compact width as MiMo cuts it.
 */
function isToolName(tab: RightTab): boolean {
  if (tab.type === "browser" && tab.pageTitle) return false
  return !tab.name && title(tab) !== ""
}

/*
 * A favicon that will not load gives the tab its globe back until the page
 * names another - or names the same one again after a navigation cleared it.
 */
const brokenFavicons = ref<Record<string, string>>({})

function faviconOf(tab: RightTab): string | undefined {
  if (tab.type !== "browser" || !tab.faviconUrl) return undefined
  return brokenFavicons.value[tab.id] === tab.faviconUrl ? undefined : tab.faviconUrl
}

function faviconFailed(tab: RightTab) {
  if (tab.faviconUrl) brokenFavicons.value[tab.id] = tab.faviconUrl
}

watch(
  () => rp.tabs.map((tab) => [tab.id, tab.faviconUrl ?? ""] as const),
  (faces) => {
    const now = new Map(faces)
    for (const [id, url] of Object.entries(brokenFavicons.value)) if (now.get(id) !== url) delete brokenFavicons.value[id]
  },
)

/*
 * Width: between MiMo's 300 and what leaves the conversation its 480. A folded
 * side column takes no width at all (R18-U1), so it leaves no rail to allow for.
 */
const viewport = ref(window.innerWidth)
const rail = computed(() => (props.sideCollapsed ? 0 : RAIL_WIDTH))
const maxWidth = computed(() => Math.max(PANEL_MIN_WIDTH, viewport.value - rail.value - props.sidebarWidth - MAIN_MIN_WIDTH))
const shownWidth = computed(() => panelWidthShown(rp.width, viewport.value, props.sidebarWidth, PANEL_MIN_WIDTH, rail.value))
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
    // Settled is the width shown, or less where heavy zoom has the panel give way (its max-width below).
    const settled = Math.min(shownWidth.value, (aside.parentElement?.clientWidth ?? Infinity) - RAIL_WIDTH - 1)
    if (rp.fullscreen ? width <= 0 : width < settled - 1) return
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

// A new language can widen the pills (localized tool names), so the active one is brought back into view then too.
watch(() => [rp.active, rp.tabs.length, language.value] as const, async () => {
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

/*
 * The tabs from the keyboard, beyond MiMo, whose tabs cannot take focus: the
 * shown tab is the strip's one Tab stop, arrows, Home and End walk the strip,
 * Enter or Space shows the tab, and the Menu key or Shift+F10 opens its menu.
 */
const tabEls = new Map<string, HTMLElement>()

function onTabKey(event: KeyboardEvent, id: string) {
  if (event.target !== event.currentTarget) return
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault()
    rp.activate(id)
    return
  }
  if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
    event.preventDefault()
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    rp.activate(id)
    tabMenu.value = { x: rect.left + rect.width / 2, y: rect.bottom, id }
    return
  }
  const ids = rp.tabs.map((tab) => tab.id)
  const at = ids.indexOf(id)
  const rtl = strip.value ? getComputedStyle(strip.value).direction === "rtl" : false
  const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[event.key]
  let next: number | undefined
  if (step !== undefined) next = (at + step + ids.length) % ids.length
  else if (event.key === "Home") next = 0
  else if (event.key === "End") next = ids.length - 1
  if (next === undefined) return
  event.preventDefault()
  tabEls.get(ids[next]!)?.focus()
}

/* MiMo's middle click: the press only keeps the page from autoscrolling; the tab closes on release, over the same tab. */
function onTabMouseDown(event: MouseEvent) {
  if (event.button === 1) event.preventDefault()
}

function onTabAuxClick(event: MouseEvent, id: string) {
  if (event.button !== 1) return
  event.preventDefault()
  event.stopPropagation()
  requestClose([id])
}

/*
 * The project changed under the same tabs - the home screen's picked project,
 * or a conversation moved elsewhere - so the files tab starts over in it. A
 * different conversation brings its own tabs instead (setScope).
 */
watch(
  () => [props.sessionID, props.directory] as const,
  ([session, directory], [sessionBefore, directoryBefore]) => {
    if (session === sessionBefore && directory !== directoryBefore) rp.reroot()
  },
)

/* The plus and its menu of tools. */
const addMenu = ref<{ x: number; y: number }>()
const addItems = computed<MenuItem[]>(() =>
  ADD_MENU_ORDER.filter((tool) => tool !== "browser" || props.browserAllowed).map((tool) => ({
    key: tool,
    label: t(tool === "subagents" ? "launch.subagents" : TOOL_INFO[tool].label),
    icon: iconOf(tool).join(" "),
    hint: tool === "subagents" ? undefined : props.hints[tool],
  })),
)

function openAddMenu(event: MouseEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  addMenu.value = { x: rect.left, y: rect.bottom + 4 }
}

function pickAdd(key: string) {
  addMenu.value = undefined
  if (key === "subagents") rp.openSubagents()
  else rp.openTool(key as RightTool)
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

const browserPanes = ref<Record<string, InstanceType<typeof RpBrowserComponent>>>({})
function setBrowserPane(id: string, instance: unknown) {
  if (instance) browserPanes.value[id] = instance as InstanceType<typeof RpBrowserComponent>
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
          :class="{ active: tab.id === rp.active, 'tool-name': isToolName(tab) }"
          role="tab"
          :aria-selected="tab.id === rp.active"
          :tabindex="tab.id === rp.active ? 0 : -1"
          :data-rp-tab="tab.type"
          :ref="(el) => (el ? tabEls.set(tab.id, el as HTMLElement) : tabEls.delete(tab.id))"
          @click="rp.activate(tab.id)"
          @keydown="onTabKey($event, tab.id)"
          @mousedown="onTabMouseDown"
          @auxclick="onTabAuxClick($event, tab.id)"
          @contextmenu.prevent="openTabMenu($event, tab.id)"
        >
          <img
            v-if="faviconOf(tab)"
            class="rpt-ic rpt-favicon"
            :src="faviconOf(tab)"
            alt=""
            referrerpolicy="no-referrer"
            :data-rp-favicon="tab.id"
            @error="faviconFailed(tab)"
          />
          <svg v-else class="rpt-ic" viewBox="0 0 16 16" fill="none" aria-hidden="true">
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
        <kbd v-if="LAUNCH_HINTED.includes(tool) && hints[tool]" class="lc-kbd">{{ shownChord(hints[tool]!) }}</kbd>
      </button>
    </div>

    <div v-else class="rp-body">
      <div v-for="tab in rp.tabs" :key="tab.id" class="rp-pane" :data-rp-pane="tab.id" v-show="tab.id === rp.active">
        <PaneBoundary :reset-key="tab.id">
          <RpReview v-if="tab.type === 'review'" :root="directory" />
          <RpFiles
            v-else-if="tab.type === 'files'"
            :root="tab.fileRoot || directory"
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
            :url="tab.url"
            @page="(id: string) => rp.update(tab.id, { pageId: id })"
            @address="(url: string) => rp.update(tab.id, { url })"
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
          <RpSubagents v-else-if="tab.type === 'subagents'" :tab="tab" :active="tab.id === rp.active && rp.open" />
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

/*
 * Only where zoom leaves the window narrower than the rail and the 300 floor
 * together: the panel gives up the difference rather than running past the
 * window's edge. The 63 is the rail and the conversation's hairline.
 */
.right-panel:not(.fullscreen) {
  max-width: calc(100% - 63px);
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

/*
 * With the side column folded, its toggle and 新建任务 stand over the head: the
 * tabs start 8 clear of them, as MiMo 26.920's do. On macOS that is
 * 62 + 34 + 32 + 24 + 8 = 160 (rail, its darwin group inset, the nav pair, the
 * folded cluster); off it the user's left-aligned 82 wins below. The macOS
 * arithmetic is MiMo's own and is unverified here - there is no Mac to look at.
 */
.right-panel.fullscreen.side-collapsed .rp-head {
  padding-inline-start: 160px;
}

/* Left-aligned folded controls (the user's choice, off macOS): 8 clear of 新建任务's end at 74. */
.app:not([data-platform="darwin"]) .right-panel.fullscreen.side-collapsed .rp-head {
  padding-inline-start: 82px;
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

/*
 * macOS, from MiMo: the row is centred on the traffic lights, at
 * 2 x --topbar-center-y - 46 = 2 x (22 + 6) - 46 = 10 down and nothing under.
 * Unverified - there is no Mac here to look at.
 */
.app[data-platform="darwin"] .rp-head {
  padding-block: 10px 0;
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
  color: var(--text-base);
  /* MiMo --color-side-active (#f1f0ec / #ffffff1a, the dark half below). */
  background: #f1f0ec;
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

/*
 * A localized tool name keeps its whole word when the pills turn compact: the
 * pill grows from 120 toward the full 160 instead of cutting Überprüfung or
 * الوكلاء الفرعيون mid-word. A short name still sits in exactly 120.
 */
.rp-tabs.compact .rp-tab.tool-name {
  flex-basis: auto;
  width: auto;
  max-width: min(160px, 100%);
}

.rp-tabs.compact .rp-tab.tool-name .rpt-name {
  flex: 1 1 auto;
}

/* The selected tab lifts onto MiMo's --color-bg, one step off the white the panel stands on. */
.rp-tab.active {
  color: var(--text-strong);
  background: var(--surface-page);
  border-color: var(--border-weak);
}

/* MiMo gives the tab glyph no colour of its own: it follows the label, muted until the tab is the active one. */
.rpt-ic {
  flex: none;
  width: 14px;
  height: 14px;
}

/* MiMo's favicon in the glyph's place: the whole image in the 14px box, 2 round. */
.rpt-favicon {
  object-fit: contain;
  border-radius: 2px;
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

/* MiMo's rpt-close glyph in --color-txt. */
.rpt-close {
  display: grid;
  flex: none;
  place-items: center;
  width: 18px;
  height: 18px;
  padding: 0;
  /* MiMo --color-txt (#151c13cc / #f4f4f5); lane F1 is adding the token. */
  color: #151c13cc;
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
  /* MiMo --color-txt (#151c13cc / #f4f4f5); lane F1 is adding the token. */
  color: #151c13cc;
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
  /* MiMo --color-txt (#151c13cc / #f4f4f5); lane F1 is adding the token. */
  color: #151c13cc;
}

/* The name in --color-txt. */
.lc-name {
  color: #151c13cc;
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

/* Dark: MiMo's side-active tint and its #f4f4f5 ink, #b8b8b8 plus, and #2a2a2a key caps in #777. */
:root[data-theme="dark"] .rp-tab {
  background: var(--surface-selected);
}

:root[data-theme="dark"] .rpt-close,
:root[data-theme="dark"] .rp-add:hover,
:root[data-theme="dark"] .lc-icon,
:root[data-theme="dark"] .lc-name {
  color: #f4f4f5;
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

  :root:not([data-theme="light"]) .rpt-close,
  :root:not([data-theme="light"]) .rp-add:hover,
  :root:not([data-theme="light"]) .lc-icon,
  :root:not([data-theme="light"]) .lc-name {
    color: #f4f4f5;
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
