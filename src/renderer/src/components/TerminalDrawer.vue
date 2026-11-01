<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import TerminalPane from "./TerminalPane.vue"
import ConfirmDialog from "./ConfirmDialog.vue"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"
import { notifyFailure } from "../lib/toast"
import { clampPanelHeight, nextTerminalNumber, shouldRespawn, showMismatch, storedPanelHeight, terminalLabel } from "../lib/terminal"

const emit = defineEmits<{ close: []; height: [px: number] }>()
const app = useApp()

/*
 * Whose terminals these are: a conversation's, or - on the home screen, before
 * there is one - the project folder picked there.
 */
const props = defineProps<{ sessionID?: string; directory?: string }>()

const root = ref<HTMLElement>()

/* MiMo's `mimo.bph`: the height a drag left, kept across opens and restarts. */
const HEIGHT_KEY = "mcode.bph"

function readHeight() {
  try {
    return storedPanelHeight(localStorage.getItem(HEIGHT_KEY))
  } catch {
    return storedPanelHeight(null)
  }
}

const height = ref(readHeight())

/*
 * Told to the app so the info card can stop above the drawer. The card floats
 * over the conversation, and without this a long one ran down over the
 * terminal and covered the buttons at its right-hand end.
 */
watch(height, (px) => emit("height", px), { immediate: true })

/*
 * The drawer holds a list of shells rather than one. Each entry keeps its own
 * pane, and the panes stay mounted while they are behind another tab - closing
 * one is what ends a process, not switching away from it.
 *
 * Shells outlive this component. App.vue mounts the drawer under `v-if`, so
 * collapsing the panel - or stepping to the home screen - unmounts every pane;
 * that used to end every shell with it, so a dev server started here died the
 * moment the panel was put away. The backend now holds them, buffers what they
 * print, and hands them back on `shell.list`, which is what reopening asks for.
 * Ending one is the tab's close button; whatever is left goes when the window
 * that opened it does.
 *
 * `num` is the tab's number, fixed when it opens as MiMo's label is (0 is the
 * bare title). `pane` changes when an untouched shell is started again in
 * another folder, which remounts its pane in the same tab.
 */
interface Entry {
  id: number
  num: number
  shellID?: string
  cwd?: string
  used: boolean
  pane: number
}

const terms = ref<Entry[]>([])
const activeID = ref(1)
let nextID = 1

type Pane = { focus: () => void; run: (command: string) => boolean }

/* Keyed by the pane's own key, so a remounted pane's late null ref cannot remove its successor. */
const panes = new Map<string, Pane>()
const paneKey = (term: Entry) => `${term.id}:${term.pane}`

function setPane(key: string, instance: unknown) {
  if (instance) panes.set(key, instance as Pane)
  else panes.delete(key)
}

function entry(id: number) {
  return terms.value.find((term) => term.id === id)
}

function paneOf(id: number) {
  const term = entry(id)
  return term ? panes.get(paneKey(term)) : undefined
}

defineExpose({
  /** Closes the focused shell, asking first if it was used; the drawer goes with the last one. */
  closeActive: () => requestClose(activeID.value),
  /**
   * Runs a command in the terminal that is showing.
   *
   * The composer's shell mode sends here rather than opening a shell of its
   * own, so a command typed in the box and one typed in the drawer share a
   * working directory and a history. Returns false while the shell is still
   * starting, so the caller can wait.
   */
  run: (command: string) => {
    const pane = paneOf(activeID.value)
    if (!pane) return false
    const ran = pane.run(command)
    if (ran === false) return false
    pane.focus()
    return true
  },
})

function select(id: number) {
  activeID.value = id
  void nextTick(() => paneOf(id)?.focus())
}

function add(shellID?: string, cwd?: string, used = false) {
  const id = nextID
  nextID += 1
  const num = nextTerminalNumber(terms.value.map((term) => term.num))
  terms.value.push({ id, num, shellID, cwd, used, pane: 0 })
  select(id)
  return id
}

/** Records the backend id a fresh pane opened, so the tab can close it later. */
function opened(id: number, shellID: string, cwd: string) {
  const term = entry(id)
  if (!term) return
  term.shellID = shellID
  term.cwd = cwd
}

function markUsed(id: number) {
  const term = entry(id)
  if (term) term.used = true
}

/*
 * The drawer stays up while the conversation changes, so its terminals can
 * belong to another project. As MiMo does: one nobody has typed into is ended
 * and started again here, silently, in the same tab; one that was used gets the
 * notice above it instead, with "Dismiss" holding for that tab until the
 * workspace changes again.
 */
const here = computed(() => props.directory ?? app.current?.directory)
const dismissed = ref(new Set<number>())

function respawn(term: Entry) {
  if (!shouldRespawn(term.cwd, here.value, term.used)) return
  if (term.shellID) void app.client?.request({ type: "shell.close", shellID: term.shellID })
  term.shellID = undefined
  term.cwd = undefined
  term.pane += 1
}

function attached(id: number) {
  const term = entry(id)
  if (term) respawn(term)
}

const pendingClose = ref<number>()

watch(here, () => {
  dismissed.value = new Set()
  pendingClose.value = undefined
  for (const term of terms.value) respawn(term)
})

const mismatch = computed(() => {
  const term = entry(activeID.value)
  if (!term || dismissed.value.has(term.id)) return false
  return showMismatch(term.cwd, here.value, term.used)
})

function dismissMismatch() {
  dismissed.value = new Set(dismissed.value).add(activeID.value)
}

/*
 * What is already running for this scope, asked again whenever the drawer is
 * pointed somewhere else.
 *
 * A drawer that always started a shell would leave the previous one running
 * with nothing on screen attached to it - the leak that keeping them alive
 * would otherwise buy. Falling back to one fresh tab is the first-open case.
 */
const scopeKey = computed(() => props.sessionID ? `session:${props.sessionID}` : props.directory ? `dir:${props.directory}` : "")

let loadSeq = 0

async function loadTabs() {
  const seq = ++loadSeq
  const key = scopeKey.value
  const client = app.client
  const sessionID = props.sessionID
  const directory = props.directory
  const where = sessionID ? { sessionID } : directory ? { directory } : undefined
  // Drop the previous scope's tabs without closing their shells: they keep
  // running, and coming back to this scope lists them again. Clear before the
  // await so a mid-flight switch cannot keep typing into the wrong session.
  terms.value = []
  dismissed.value = new Set()
  pendingClose.value = undefined
  if (!client || !where) {
    add()
    return
  }
  // The drawer's own shells only: the right panel's terminal is not a tab here (N11-9).
  try {
    const found = await client.request({ type: "shell.list", ...where, surface: "drawer" })
    if (seq !== loadSeq || key !== scopeKey.value) return
    if (found?.shells.length) for (const shell of found.shells) add(shell.shellID, shell.cwd, shell.used)
    else add()
  } catch (err) {
    if (seq !== loadSeq || key !== scopeKey.value) return
    // Keep one usable tab; do not orphan running shells without a word.
    notifyFailure(t("common.requestFailed"), err instanceof Error ? err.message : String(err))
    add()
  }
}

watch(scopeKey, () => void loadTabs(), { immediate: true })

/* A terminal someone typed into is held for MiMo's question; the rest close at once. */

function requestClose(id: number) {
  const term = entry(id)
  if (!term) return
  if (term.used) pendingClose.value = id
  else close(id)
}

function confirmClose() {
  const id = pendingClose.value
  pendingClose.value = undefined
  if (id !== undefined) close(id)
}

/*
 * Closing the last terminal closes the drawer with it. A drawer holding no
 * shells is a strip of empty chrome, and reopening it starts a fresh one
 * anyway, so there is nothing for the empty state to preserve.
 */
function close(id: number) {
  const index = terms.value.findIndex((term) => term.id === id)
  if (index === -1) return
  // The one place a shell is actually ended, now that unmounting is not.
  const shellID = terms.value[index].shellID
  if (shellID) void app.client?.request({ type: "shell.close", shellID })
  terms.value.splice(index, 1)
  if (!terms.value.length) {
    emit("close")
    return
  }
  if (activeID.value === id) select(terms.value[Math.min(index, terms.value.length - 1)].id)
}

/* MiMo clamps a kept height again whenever the window changes size. */
function onWindowResize() {
  height.value = clampPanelHeight(height.value)
}

onMounted(() => window.addEventListener("resize", onWindowResize))
onBeforeUnmount(() => {
  loadSeq += 1
  window.removeEventListener("resize", onWindowResize)
  document.body.classList.remove("resizing", "resizing-v")
})

/**
 * Drags the drawer taller or shorter.
 *
 * Capturing the pointer is what keeps the drag alive over the terminal, which
 * would otherwise swallow the moves the moment the cursor crossed into it. The
 * body carries MiMo's resizing classes meanwhile, for the row-resize cursor.
 */
function startResize(event: PointerEvent) {
  const target = event.currentTarget as HTMLElement
  const startY = event.clientY
  const startHeight = height.value
  target.setPointerCapture(event.pointerId)
  document.body.classList.add("resizing", "resizing-v")

  const move = (moved: PointerEvent) => {
    height.value = clampPanelHeight(startHeight + (startY - moved.clientY))
  }
  const stop = () => {
    target.releasePointerCapture(event.pointerId)
    target.removeEventListener("pointermove", move)
    target.removeEventListener("pointerup", stop)
    target.removeEventListener("pointercancel", stop)
    document.body.classList.remove("resizing", "resizing-v")
    try {
      localStorage.setItem(HEIGHT_KEY, String(height.value))
    } catch {
      /* Storage refused; the height still holds until the drawer is closed. */
    }
  }
  target.addEventListener("pointermove", move)
  target.addEventListener("pointerup", stop)
  target.addEventListener("pointercancel", stop)
}
</script>

<template>
  <!--
    Two boxes of the same height: the outer one is what opens and closes (its
    height runs from 0 when App.vue wraps it in <Transition name="bp">), the
    inner one keeps the terminal at its full size throughout, so xterm is not
    refitted - and the shell not resized - on every frame of the animation.
  -->
  <div ref="root" class="drawer" data-terminal-drawer :style="{ height: `${height}px` }">
    <div class="resize" :title="t('term.resizeTitle')" @pointerdown.prevent="startResize" />

    <div class="drawer-body" :style="{ height: `${height}px` }">
      <div class="head" role="tablist">
        <!--
          The tab is not a <button>: its close is a real button of its own,
          which a button cannot hold and still let it take focus.
        -->
        <div
          v-for="term in terms"
          :key="term.id"
          class="tab"
          :class="{ on: term.id === activeID }"
          role="tab"
          tabindex="0"
          :aria-selected="term.id === activeID"
          @click="select(term.id)"
          @keydown.enter.space.self.prevent="select(term.id)"
        >
          <span class="tab-label">{{ terminalLabel(term.num, t("term.title")) }}</span>
          <button type="button" class="tab-close" :aria-label="t('term.close')" @click.stop="requestClose(term.id)">×</button>
        </div>

        <!-- MiMo's: a bare plus in the muted colour, named by the platform's own tooltip. -->
        <button class="add" :title="t('term.new')" :aria-label="t('term.new')" @click="add()">+</button>

        <span class="gap" />
        <button class="icon-btn hide" :title="t('term.closePanel')" :aria-label="t('term.closePanel')" @click="emit('close')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div v-if="mismatch" class="mismatch" role="status">
        <span class="mismatch-msg">{{ t("term.mismatch") }}</span>
        <button class="mismatch-btn" @click="dismissMismatch">{{ t("ui.common.dismiss") }}</button>
        <button class="mismatch-btn primary" @click="add()">{{ t("term.mismatchOpenNew") }}</button>
      </div>

      <!--
        shellID is bound in camelCase deliberately. Vue hyphenates it to
        shell-i-d, so `:shell-id` arrives as a prop named shellId and never
        matches the declared shellID - measured: every restored tab silently
        started a second shell beside the one it was meant to come back to.
      -->
      <TerminalPane
        v-for="term in terms"
        :key="paneKey(term)"
        :ref="(instance) => setPane(paneKey(term), instance)"
        :active="term.id === activeID"
        :height="height"
        :shellID="term.shellID"
        surface="drawer"
        :sessionID="sessionID"
        :directory="directory"
        @opened="(shellID: string, cwd: string) => opened(term.id, shellID, cwd)"
        @used="markUsed(term.id)"
        @attached="attached(term.id)"
      />
    </div>

    <!-- MiMo's question before a used terminal is closed, with its plain (not red) confirm. -->
    <ConfirmDialog
      v-if="pendingClose !== undefined"
      :title="t('rp.termClose.title')"
      :body="t('rp.termClose.message')"
      :confirmLabel="t('rp.termClose.confirm')"
      :danger="false"
      @confirm="confirmClose"
      @close="pendingClose = undefined"
    />
  </div>
</template>

<style scoped>
/*
 * Docked along the foot of the conversation, as MiMo has it: the full width of
 * the column, butted against the transcript and set off from it by a hairline
 * along its top, on MiMo's panel colour. The drag edge straddles that line.
 */
.drawer {
  position: relative;
  flex-shrink: 0;
  min-height: 0;
  background: var(--surface-raised);
}

.drawer-body {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  border-top: 1px solid var(--border-weak);
}

/* MiMo's open and close: the height, over .2s on its sidebar curve, clipped meanwhile. */
.drawer.bp-enter-active,
.drawer.bp-leave-active {
  overflow: hidden;
  transition: height 0.2s cubic-bezier(0.7, 0.1, 0.5, 0.9);
}

.drawer.bp-enter-from,
.drawer.bp-leave-to {
  height: 0 !important;
}

/* MiMo's .resizer.r-top: 7 tall, 3 of it above the line, no fill on hover or drag. */
.resize {
  position: absolute;
  inset-block-start: -3px;
  inset-inline: 0;
  height: 7px;
  cursor: row-resize;
  z-index: 30;
}

:global(body.resizing-v) {
  cursor: row-resize;
}

/*
 * MiMo's bar: no height of its own, 5 by 10 inside, four between the tabs and
 * no rule under it. Its own stylesheet measures 37.71 with a tab in it, so 38
 * is the floor here rather than the ceiling - the row grows with the interface
 * font, as MiMo's does.
 */
.head {
  display: flex;
  flex-shrink: 0;
  box-sizing: border-box;
  align-items: center;
  gap: 4px;
  min-height: 38px;
  padding: 5px 10px;
}

/*
 * MiMo's tab: an 11px inline padding, 7 between the label and its close mark,
 * a 7px corner, 12px text in the ordinary text colour.
 */
.tab {
  display: flex;
  flex-shrink: 0;
  box-sizing: border-box;
  align-items: center;
  gap: 7px;
  max-width: 180px;
  height: calc(28px * var(--ui-font-scale, 1));
  padding-block: 0;
  padding-inline: 11px;
  color: var(--text-body);
  border: 1px solid transparent;
  border-radius: 7px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-weight: 400;
  line-height: calc(18px * var(--ui-font-scale, 1));
  /* What the button it used to be gave it. */
  text-align: center;
  cursor: pointer;
}

/* MiMo's .bp-tab.active: the page fill (#fffefd, #181818 dark) inside a warm hairline. */
.tab.on {
  background: #fffefd;
  border-color: #f0ebe5;
}

:root[data-theme="dark"] .tab.on {
  background: #181818;
  border-color: #2e2e2e;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .tab.on {
    background: #181818;
    border-color: #2e2e2e;
  }
}

.tab-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* MiMo's new terminal: a 14px plus, 5 by 8 of padding, muted until pointed at. */
.add {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  padding: 5px 8px;
  color: var(--text-base);
  background: transparent;
  border: 0;
  border-radius: 7px;
  font-size: calc(14px * var(--ui-font-scale, 1));
  line-height: 1;
}

.add:hover {
  color: var(--text-body);
}

/*
 * Putting the panel away is MiMo's 26px icon-btn xs at the far end of the bar:
 * a 16px glyph, muted, on its menu-hover fill when pointed at. `flex-shrink`
 * matters: the head is a row, and without it the button was squeezed.
 */
.head .icon-btn.hide {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
}

/* MiMo's close mark: a 13px ×, always there, muted, on a 4px corner. */
.tab-close {
  flex-shrink: 0;
  padding: 0 3px;
  color: var(--text-base);
  border-radius: 4px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: calc(18px * var(--ui-font-scale, 1));
}

.tab-close:hover {
  color: var(--text-body);
  background: var(--overlay-hover);
}

.gap {
  flex: 1;
}

/*
 * The notice for a terminal outside the conversation's project, as MiMo draws
 * it: a bordered strip between the tabs and the terminal, then two outlined
 * buttons, the one that opens a terminal filled with the text colour.
 */
.mismatch {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  margin: 6px 8px 0;
  padding: 6px 10px;
  color: var(--text-body);
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.mismatch-msg {
  flex: 1 1 0;
  min-width: 0;
}

.mismatch-btn {
  flex: 0 0 auto;
  padding: 2px 10px;
  color: var(--text-body);
  background: none;
  border: 1px solid var(--border-weak);
  border-radius: 6px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  cursor: pointer;
}

.mismatch-btn:hover {
  opacity: 0.85;
}

/* MiMo's primary pill: the txt ink filled, its label the page colour. */
.mismatch-btn.primary {
  color: #fffefd;
  background: #151c13cc;
  border-color: transparent;
}

/* MiMo's --color-txt is the fill of the button that carries the turn, not a translucent white. */
:root[data-theme="dark"] .mismatch-btn.primary {
  color: #181818;
  background: #f4f4f5;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .mismatch-btn.primary {
    color: #181818;
    background: #f4f4f5;
  }
}
</style>
