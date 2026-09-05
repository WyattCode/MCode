<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue"
import TerminalPane from "./TerminalPane.vue"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"

const emit = defineEmits<{ close: [] }>()
const app = useApp()

const root = ref<HTMLElement>()

/*
 * What the reference gives it under an open review panel: measured at `831x280`
 * against that panel's `831x575`, in a column 863 tall.
 */
const height = ref(280)

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
 */
const terms = ref<{ id: number; shellID?: string; dead: boolean }[]>([])
const activeID = ref(1)
let nextID = 1

type Pane = { focus: () => void; run: (command: string) => boolean }

const panes = new Map<number, Pane>()
function setPane(id: number, instance: unknown) {
  if (instance) panes.set(id, instance as Pane)
  else panes.delete(id)
}

/**
 * Runs a command in the terminal that is showing.
 *
 * The composer's shell mode sends here rather than opening a shell of its own,
 * so a command typed in the box and one typed in the drawer share a working
 * directory and a history.
 */
defineExpose({
  /** Closes the focused shell; the drawer goes with the last one. */
  closeActive: () => close(activeID.value),
  /**
   * Open another shell. The drawer owns the tab strip, so the app cannot add
   * one itself; it mounts the drawer and then asks. Ctrl+Alt+T used to be
   * handled only in here, which meant it did nothing whenever the drawer was
   * closed - the state in which someone is most likely to want a terminal.
   */
  add: () => add(),
  /** Returns false while the shell is still starting, so the caller can wait. */
  run: (command: string) => {
    const pane = panes.get(activeID.value)
    if (!pane) return false
    const ran = pane.run(command)
    if (ran === false) return false
    pane.focus()
    return true
  },
})

function label(id: number) {
  const index = terms.value.findIndex((term) => term.id === id)
  return terms.value.length === 1 ? t("term.title") : `${t("term.title")} ${index + 1}`
}

function select(id: number) {
  activeID.value = id
  void nextTick(() => panes.get(id)?.focus())
}

function add(shellID?: string, dead = false) {
  const id = nextID
  nextID += 1
  terms.value.push({ id, shellID, dead })
  select(id)
  return id
}

/** Records the backend id a fresh pane opened, so the tab can close it later. */
function opened(id: number, shellID: string) {
  const term = terms.value.find((entry) => entry.id === id)
  if (term) term.shellID = shellID
}

/*
 * What is already running for this session, asked once on the way in.
 *
 * A drawer that always started a shell would leave the previous one running
 * with nothing on screen attached to it - the leak that keeping them alive
 * would otherwise buy. Falling back to one fresh tab is the first-open case.
 */
onMounted(async () => {
  const client = app.client
  const sessionID = app.currentID
  if (!client || !sessionID) {
    add()
    return
  }
  const found = await client.request({ type: "shell.list", sessionID }).catch(() => undefined)
  if (found?.shells.length) for (const shell of found.shells) add(shell.shellID, !shell.alive)
  else add()
})

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

function exited(id: number) {
  const term = terms.value.find((entry) => entry.id === id)
  if (term) term.dead = true
}

/**
 * Terminal keys, taken before the window handler sees them.
 *
 * Both of these are already spoken for one level up - Ctrl+T starts a session
 * and Ctrl+W closes a tab - so the drawer has to claim them in the capture
 * phase and stop them there. Ctrl+W is claimed only while the focus is inside
 * the drawer, which keeps it closing tabs everywhere else.
 *
 * Stopping immediately rather than merely stopping: the window handler is on
 * the same node as this one, and an event whose target is the window itself
 * reaches every listener on it regardless of phase.
 */
function onKeydown(event: KeyboardEvent) {
  const mod = event.ctrlKey || event.metaKey
  if (!mod) return
  const key = event.key.toLowerCase()

  if (event.altKey && key === "t") {
    event.preventDefault()
    event.stopImmediatePropagation()
    add()
    return
  }

  if (!event.altKey && key === "w") {
    const inside = root.value && document.activeElement && root.value.contains(document.activeElement)
    if (!inside) return
    event.preventDefault()
    event.stopImmediatePropagation()
    close(activeID.value)
  }
}

onMounted(() => window.addEventListener("keydown", onKeydown, true))
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown, true))

/**
 * Drags the drawer taller or shorter.
 *
 * Capturing the pointer is what keeps the drag alive over the terminal, which
 * would otherwise swallow the moves the moment the cursor crossed into it.
 */
function startResize(event: PointerEvent) {
  const target = event.currentTarget as HTMLElement
  const startY = event.clientY
  const startHeight = height.value
  target.setPointerCapture(event.pointerId)

  const move = (moved: PointerEvent) => {
    const want = startHeight + (startY - moved.clientY)
    height.value = Math.round(Math.min(window.innerHeight - 220, Math.max(120, want)))
  }
  const stop = () => {
    target.releasePointerCapture(event.pointerId)
    target.removeEventListener("pointermove", move)
    target.removeEventListener("pointerup", stop)
    target.removeEventListener("pointercancel", stop)
  }
  target.addEventListener("pointermove", move)
  target.addEventListener("pointerup", stop)
  target.addEventListener("pointercancel", stop)
}
</script>

<template>
  <div ref="root" class="drawer" :style="{ height: `${height}px` }">
    <div class="resize" @pointerdown.prevent="startResize" />

    <div class="head" role="tablist">
      <button
        v-for="term in terms"
        :key="term.id"
        class="tab"
        :class="{ on: term.id === activeID }"
        role="tab"
        :aria-selected="term.id === activeID"
        @click="select(term.id)"
        @auxclick.middle.prevent="close(term.id)"
      >
        <span class="tab-label">{{ label(term.id) }}</span>
        <span v-if="term.dead" class="dot" v-tip="{ label: t('term.exited'), placement: 'top' }" />
        <span
          class="tab-close"
          role="button"
          :aria-label="t('term.close')"
          @click.stop="close(term.id)"
        >
          <svg width="8" height="8" viewBox="0 0 10 10" aria-hidden="true">
            <path
              d="M0.5 0.5 L9.5 9.5 M9.5 0.5 L0.5 9.5"
              stroke="currentColor"
              stroke-linecap="round"
            />
          </svg>
        </span>
      </button>

      <button
        class="icon-btn"
        v-tip="{ label: `${t('term.new')} · Ctrl+Alt+T`, placement: 'top' }"
        @click="add()"
      >
        <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M6 1 L6 11 M1 6 L11 6" stroke="currentColor" stroke-linecap="round" />
        </svg>
      </button>

      <span class="gap" />
      <span class="cwd mono">{{ app.current?.directory }}</span>
      <button
        class="icon-btn"
        v-tip="{ label: t('term.hide'), placement: 'top' }"
        @click="emit('close')"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path
            d="M0.5 0.5 L9.5 9.5 M9.5 0.5 L0.5 9.5"
            stroke="currentColor"
            stroke-linecap="round"
          />
        </svg>
      </button>
    </div>

    <!--
      shellID is bound in camelCase deliberately. Vue hyphenates it to
      shell-i-d, so `:shell-id` arrives as a prop named shellId and never
      matches the declared shellID - measured: every restored tab silently
      started a second shell beside the one it was meant to come back to.
    -->
    <TerminalPane
      v-for="term in terms"
      :key="term.id"
      :ref="(instance) => setPane(term.id, instance)"
      :active="term.id === activeID"
      :height="height"
      :shellID="term.shellID"
      @exited="exited(term.id)"
      @opened="(shellID: string) => opened(term.id, shellID)"
    />

    <!--
      No bar along the bottom. It used to carry a standing warning that this
      was a pipe and not a terminal, which a real pty made untrue; and showing
      only the exit there instead would have been the third place the same fact
      is told - the tab already carries a dot labelled with it, and the pane
      itself prints [process exited] into the scrollback. Worse, a bar that
      comes and goes with the exit takes 19px from the pane as it appears, so
      the grid loses a row at the moment the shell dies.
    -->
  </div>
</template>

<style scoped>
/*
 * A card in the right column, not a strip across the foot of the window. The
 * seam it used to draw along its top belonged to the old shape - butted against
 * the conversation, it needed a line to say where one ended; separated from the
 * panel above it by the column's own gutter, the line only doubled the edge.
 */
.drawer {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--surface-raised);
}

.resize {
  position: absolute;
  top: -2px;
  left: 0;
  right: 0;
  height: 5px;
  cursor: ns-resize;
  z-index: 2;
}

.resize:hover {
  background: var(--surface-selected);
}

/* 52 tall with eight between the tabs, which is what the reference measures. */
.head {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
  height: 52px;
  padding-inline: 12px;
  border-bottom: 1px solid var(--border-weak);
}

/*
 * Measured off the reference's own terminal panel rather than reasoned about:
 * 28 tall on a 6px radius, a symmetric 8px inline padding, 8px between the
 * label and the close button, and its text at 14px/500 on a 21px line.
 *
 * The padding used to be 10px at the start and 8px at the end, on the argument
 * that a label wants more room than a close button - a fair argument, and not
 * what the reference does. The label was also inheriting the interface's
 * 13px/440, a size and weight below the reference's.
 */
.tab {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
  max-width: 180px;
  height: 28px;
  padding-block: 0;
  padding-inline: 8px;
  color: var(--text-weak);
  border-radius: 6px;
  font-size: 14px;
  font-weight: 500;
  line-height: 21px;
}

.tab:hover {
  background: var(--overlay-hover);
}

/*
 * The reference gives the selected terminal tab a hairline of its own -
 * `background-color: var(--v2-background-bg-layer-01)` with
 * `box-shadow: inset 0 0 0 .5px var(--v2-border-border-muted)` under
 * `#terminal-panel` - which is what separates it from a tab that merely has
 * the pointer over it. A pressed overlay alone read as the hover state held.
 */
.tab.on {
  color: var(--text-strong);
  background: var(--surface-raised-hover);
  box-shadow: inset 0 0 0 0.5px var(--border-muted);
}

.tab-label {
  overflow: hidden;
  font-size: 13px;
  font-weight: 440;
  /*
   * Its own, rather than the tab's 21. The tab element is 14px/500/21 and the
   * label inside it is 13px/440/16 - two different rules, which is easy to miss
   * because measuring the tab answers for the tab. Inheriting 21 made the label
   * box 21 tall where the reference's is 16.
   */
  line-height: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/*
 * 24, not the 26 every other icon button in the app is. The reference's new
 * terminal button measures `24x24`; scoped here rather than changed on
 * `.icon-btn`, which is shared and whose size is right where it is used.
 */
.head .icon-btn {
  /*
   * `flex-shrink` matters here: the head is a row, and without it the button
   * was squeezed two pixels narrower than whatever it was given - which is why
   * a 26px button measured 24, and setting 24 measured 22.
   */
  flex-shrink: 0;
  width: 24px;
  height: 24px;
}

/*
 * Marks a shell whose process is gone. The tab stays until it is closed, so
 * that its scrollback can still be read.
 */
.dot {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  background: var(--error);
  border-radius: 50%;
}

.tab-close {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  opacity: 0;
  border-radius: 4px;
}

.tab:hover .tab-close,
.tab.on .tab-close {
  opacity: 0.7;
}

.tab-close:hover {
  opacity: 1;
  background: var(--overlay-hover);
}

.cwd {
  overflow: hidden;
  color: var(--text-weak);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gap {
  flex: 1;
}

</style>
