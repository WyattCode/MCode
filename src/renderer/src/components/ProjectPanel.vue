<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import { useApp } from "../stores/app"
import { sessionTitle, t } from "../lib/i18n"
import { projectName } from "../lib/project"

const props = defineProps<{
  directory: string
  /**
   * "docked" is the sidebar column; "popover" floats out from a rail badge and
   * "menu" is the bare context menu a right-click opens. All three render the
   * same project identity, so they share one component rather than drifting.
   */
  mode: "docked" | "popover" | "menu"
  /** Y position of the rail badge - popover and menu only. */
  anchor?: number
}>()

const emit = defineEmits<{
  close: []
  /** The project was closed - distinct from `close`, which dismisses a popover. */
  closed: [directory: string]
  open: [sessionID: string]
  create: [directory: string]
  edit: [directory: string]
}>()

const app = useApp()
const menuOpen = ref(props.mode === "menu")
const root = ref<HTMLElement>()

const floating = computed(() => props.mode !== "docked")

const name = computed(() => projectName(props.directory, app.config?.projectNames))

const sessions = computed(() =>
  app.sessions.filter((session) => session.directory === props.directory && !session.archived),
)

/**
 * What a row has to report, resolved in the order opencode resolves it: a
 * request for approval outranks the turn it is holding up, and both outrank a
 * session that merely finished while the user was looking somewhere else.
 *
 * Only the open session can be shown as working. The store keeps the whole set
 * of running sessions privately and exposes `busy` for the current one alone,
 * so a background turn stays silent here rather than being guessed at.
 */
function rowStatus(id: string): "permission" | "working" | "error" | "unseen" | undefined {
  if (app.pendingPermissions.has(id)) return "permission"
  if (id === app.currentID && app.busy) return "working"
  if (app.failed(id)) return "error"
  if (app.unseen.has(id)) return "unseen"
  return undefined
}

const rows = computed(() => sessions.value.map((session) => ({ session, status: rowStatus(session.id) })))

/** Keeps a floating panel on screen when its badge sits low in the rail. */
const top = computed(() => Math.min(props.anchor ?? 0, Math.max(12, window.innerHeight - 320)))

/*
 * opencode stores the sidebar with its icon rail included and subtracts the
 * rail again to lay the panel out, so its numbers are 64 larger than the ones
 * that belong here: a 344 default is this 280, a 244 floor is this 180, and a
 * ceiling of three tenths of the window plus the rail is just three tenths of
 * the window. This app never mounts a rail, so what is stored is the column.
 */
const PANEL_DEFAULT = 280
const PANEL_MIN = 180

/**
 * Held locally while a drag is in flight and cleared once the config has come
 * back. Writing on every pointer move would put a disk write behind each frame,
 * and dropping it the moment the pointer lifts would snap the panel back to the
 * old width for as long as the round trip takes.
 */
const dragWidth = ref<number>()
const dragging = ref(false)

/*
 * Floored on the way out as well as on the way in, the way opencode floors it:
 * a window too narrow for three tenths to reach the minimum clamps to a width
 * below it, and the panel is still not allowed to draw itself that thin.
 */
const width = computed(() => Math.max(PANEL_MIN, dragWidth.value ?? app.config?.sidebarWidth ?? PANEL_DEFAULT))

function clampWidth(want: number) {
  return Math.round(Math.min(window.innerWidth * 0.3, Math.max(PANEL_MIN, want)))
}

async function commit(next: number) {
  dragWidth.value = next
  if (next !== app.config?.sidebarWidth) await app.patchConfig({ sidebarWidth: next })
  dragWidth.value = undefined
}

function beginResize(event: PointerEvent) {
  // The second press of a double-click must not open a drag that would then
  // fight the reset the double-click is about to ask for.
  if (event.detail > 1) return
  const target = event.currentTarget as HTMLElement
  const startX = event.clientX
  const startWidth = width.value
  // In Arabic the panel sits against the other edge of the window, so the
  // pointer has to travel the other way to widen it.
  const sign = getComputedStyle(target).direction === "rtl" ? -1 : 1
  target.setPointerCapture(event.pointerId)
  dragging.value = true
  dragWidth.value = startWidth

  const move = (moved: PointerEvent) => {
    dragWidth.value = clampWidth(startWidth + sign * (moved.clientX - startX))
  }
  const done = () => {
    dragging.value = false
    target.removeEventListener("pointermove", move)
    target.removeEventListener("pointerup", done)
    target.removeEventListener("pointercancel", done)
    void commit(width.value)
  }
  target.addEventListener("pointermove", move)
  target.addEventListener("pointerup", done)
  target.addEventListener("pointercancel", done)
}

/** Back to the width it starts at, which is what a double-click means here. */
function resetWidth() {
  void commit(PANEL_DEFAULT)
}

/**
 * A window.prompt could only ever collect the name; icon and colour need a real
 * form. The dialog is owned upstream because a popover closes itself here, and
 * a dialog rendered inside it would unmount before it ever painted.
 */
function edit() {
  menuOpen.value = false
  emit("edit", props.directory)
  if (floating.value) emit("close")
}

async function close() {
  const current = app.config?.closedProjects ?? []
  menuOpen.value = false
  if (floating.value) emit("close")
  /*
   * The workspace has to let go of it too. Adding the directory to the closed
   * list only takes its badge out of the rail; the docked panel follows the
   * open session instead, so closing from there took the icon away and left the
   * project sitting on screen, which read as the button doing nothing at all.
   */
  emit("closed", props.directory)
  // Hiding, not deleting: the sessions stay, so reopening the directory
  // brings the whole history back.
  if (current.includes(props.directory)) return
  await app.patchConfig({ closedProjects: [...current, props.directory] })
}

function onPointerDown(event: MouseEvent) {
  if (root.value?.contains(event.target as Node)) return
  if (floating.value) emit("close")
  else menuOpen.value = false
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape") return
  if (floating.value) emit("close")
  else menuOpen.value = false
}

onMounted(() => {
  window.addEventListener("mousedown", onPointerDown, true)
  window.addEventListener("keydown", onKeydown)
})
onBeforeUnmount(() => {
  window.removeEventListener("mousedown", onPointerDown, true)
  window.removeEventListener("keydown", onKeydown)
})
</script>

<template>
  <!-- Right-click: just the menu, placed where the gesture started. -->
  <div
    v-if="mode === 'menu'"
    ref="root"
    class="floater"
    :style="{ top: `${top}px` }"
  >
    <div class="menu standalone">
      <button class="item" @click="edit">{{ t("proj.edit") }}</button>
      <button class="item" disabled>{{ t("proj.workspace") }}</button>
      <button class="item" disabled>{{ t("proj.clearNotifications") }}</button>
      <div class="sep" />
      <button class="item" @click="close">{{ t("proj.close") }}</button>
    </div>
  </div>

  <component
    :is="mode === 'docked' ? 'aside' : 'div'"
    v-else
    ref="root"
    class="panel"
    :class="mode"
    :style="mode === 'popover' ? { top: `${top}px` } : { width: `${width}px` }"
  >
    <!--
      The seam between the panel and the workspace, which is a thing you drag.
      Eight pixels to grab, three to see, and the three only appear once the
      pointer is on them - the same handle the review pane already uses.
    -->
    <div
      v-if="mode === 'docked'"
      class="pane-grip"
      :class="{ on: dragging }"
      @pointerdown.prevent="beginResize"
      @dblclick="resetWidth"
    />

    <header class="head">
      <div class="ident">
        <div class="name">{{ name }}</div>
        <div class="path" v-tip="{ label: directory, placement: 'bottom' }">{{ directory }}</div>
      </div>

      <button class="more" v-tip="{ label: t('proj.more'), placement: 'bottom' }" @click="menuOpen = !menuOpen">
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="3.2" cy="8" r="1.3" fill="currentColor" />
          <circle cx="8" cy="8" r="1.3" fill="currentColor" />
          <circle cx="12.8" cy="8" r="1.3" fill="currentColor" />
        </svg>
      </button>

      <div v-if="menuOpen" class="menu">
        <button class="item" @click="edit">{{ t("proj.edit") }}</button>
        <button class="item" disabled>{{ t("proj.workspace") }}</button>
        <button class="item" disabled>{{ t("proj.clearNotifications") }}</button>
        <div class="sep" />
        <button class="item" @click="close">{{ t("proj.close") }}</button>
      </div>
    </header>

    <button class="new" @click="emit('create', directory)">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M11.2 2.6a1.4 1.4 0 0 1 2 2L7 10.8l-2.6.7.7-2.6z"
          stroke="currentColor"
          stroke-width="1.2"
          stroke-linejoin="round"
        />
        <path d="M3 13.4h10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
      </svg>
      {{ t("proj.newSession") }}
    </button>

    <div v-if="!rows.length" class="list-empty">{{ t("proj.noSessions") }}</div>

    <div v-else class="list">
      <!--
        A div rather than a button because it holds one: nesting is invalid.
        The role and key handling put back what the element type gave for free -
        without them the session list could not be reached from the keyboard.
      -->
      <div
        v-for="row in rows"
        :key="row.session.id"
        class="row"
        :class="{ on: row.session.id === app.currentID }"
        role="button"
        tabindex="0"
        @click="emit('open', row.session.id)"
        @keydown.enter.prevent="emit('open', row.session.id)"
        @keydown.space.prevent="emit('open', row.session.id)"
      >
        <span class="row-main">
          <!--
            The slot is only built for a row that has something to say, so a
            quiet list keeps every title against the row's own left inset
            rather than indenting the whole column for the sake of one dot.
          -->
          <span v-if="row.status" class="row-status" aria-hidden="true">
            <span v-if="row.status === 'working'" class="row-spin" />
            <span v-else class="row-dot" :class="row.status" />
          </span>
          <span class="row-title">{{ sessionTitle(row.session.title) }}</span>
        </span>

        <!--
          Archiving used to live only in the command palette, which is not where
          anyone looks for it - the sessions are right here.
        -->
        <span class="row-slot">
          <button class="row-act" v-tip="{ label: t('cmd.archive'), placement: 'bottom' }" @click.stop="app.archive(row.session.id, true)">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="1.8" y="2.6" width="12.4" height="3.4" rx="1.1" stroke="currentColor" stroke-width="1.3" />
              <path d="M3.2 6v6.2a1.2 1.2 0 0 0 1.2 1.2h7.2a1.2 1.2 0 0 0 1.2-1.2V6" stroke="currentColor" stroke-width="1.3" />
              <path d="M6.4 8.8h3.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
            </svg>
          </button>
        </span>
      </div>
    </div>
  </component>
</template>

<style scoped>
.list-empty {
  padding: 14px 4px;
  color: var(--text-weaker);
  text-align: center;
  font-size: 12.5px;
}

/* Bare context menu, anchored to the badge that was right-clicked. */
.floater {
  position: fixed;
  /* Clear of the rail, which is the side the reading begins on. */
  inset-inline-start: 58px;
  z-index: 90;
}

/*
 * Twelve either side and nothing top or bottom: every block in the column
 * carries its own vertical inset, which is what lets the session list run its
 * scroll all the way to the panel's edge instead of stopping short of one.
 */
.panel {
  display: flex;
  flex-direction: column;
  padding: 0 12px;
}

/* Docked: a column of the app shell, flush against the rail. */
/* The width is written inline because it is a dragged setting; what stays here
   is the refusal to give any of it back when the workspace wants more. */
.panel.docked {
  position: relative;
  flex-shrink: 0;
  /* Unfilled: the workspace panel underneath is the surface now, and a second
     fill here would draw a box around the sidebar that is not in the design. */
  border-inline-end: 1px solid var(--border-weaker);
}

/* Straddling the seam rather than sitting beside it, so the pointer finds the
   handle at the line it can see rather than a few pixels short of it. */
.pane-grip {
  position: absolute;
  z-index: 30;
  inset-block: 0;
  inset-inline-end: -4px;
  width: 8px;
  cursor: col-resize;
}

.pane-grip::after {
  position: absolute;
  inset-block: 0;
  inset-inline-start: 2.5px;
  width: 3px;
  background: var(--border-strong);
  opacity: 0;
  content: "";
  transition: opacity 0.15s ease-in-out;
}

.pane-grip:hover::after,
.pane-grip.on::after {
  opacity: 1;
}

/* Popover: the same content lifted off the surface. */
.panel.popover {
  position: fixed;
  inset-inline-start: 58px;
  z-index: 90;
  width: 320px;
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-lg);
}

/*
 * The identity carries the inset the panel no longer does. Margin rather than
 * padding on the top edge because the overflow menu is positioned against this
 * box, and padding would push the menu down without moving its trigger.
 */
.head {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 12px;
  padding-inline-start: 12px;
}

.ident {
  flex: 1;
  min-width: 0;
}

.name {
  overflow: hidden;
  color: var(--text-strong);
  font-size: 19px;
  font-weight: 530;
  letter-spacing: -0.01em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.path {
  margin-top: 3px;
  overflow: hidden;
  color: var(--text-base);
  font-size: 13.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.more {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  color: var(--icon-base);
  border-radius: var(--radius-md);
  transition: background 0.12s, color 0.12s;
}

.more:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

/* Hung off the far end of the header, which is where its trigger sits. */
.menu {
  position: absolute;
  top: 32px;
  inset-inline-end: 0;
  z-index: 2;
  min-width: 180px;
  padding: 5px;
  background: var(--surface-raised-hover);
  border: 1px solid var(--border-weak);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
}

.menu.standalone {
  position: static;
}

.item {
  display: block;
  width: 100%;
  padding: 8px 10px;
  color: var(--text-strong);
  text-align: start;
  border-radius: var(--radius-md);
  font-size: 14px;
}

.item:hover:not(:disabled) {
  background: var(--surface-hover);
}

.item:disabled {
  color: var(--text-weaker);
  cursor: default;
}

.sep {
  height: 1px;
  margin: 5px 4px;
  background: var(--border-weak);
}

/* The one call to action in the panel, so it gets real weight. */
/* Sized as a row in a sidebar - it is one action among a list, not a banner. */
.new {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  width: 100%;
  height: 34px;
  margin-top: 14px;
  color: var(--text-strong);
  background: transparent;
  border: 1px solid var(--border-weak);
  border-radius: var(--radius-md);
  font-size: 13px;
  transition: background 0.12s, border-color 0.12s;
}

.new:hover {
  background: var(--surface-hover);
  border-color: var(--border-strong);
}

.list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 14px;
  padding-block: 8px;
  overflow-y: auto;
  /* A track here would sit a second vertical line right beside the seam, and
     the column is short enough that its own scrolling is never in doubt. */
  scrollbar-width: none;
  /* A session arriving above the viewport must not drag the list under the
     pointer while someone is reading further down it. */
  overflow-anchor: none;
}

.list::-webkit-scrollbar {
  display: none;
}

.row {
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  /* Wider at the trailing edge, where the archive button opens out of it. */
  padding-block: 0;
  padding-inline: 8px 12px;
  text-align: start;
  border-radius: var(--radius-md);
  transition: background 0.1s;
}

/* Fill only. An outline arriving on hover redraws the row's edge against the
   panel and reads as movement in a list that has not moved. */
.row:hover {
  background: var(--surface-hover);
}

.row:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: -2px;
}

.row-main {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding-block: 4px;
}

.row-status {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
}

.row-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.row-dot.permission {
  background: var(--warning);
}

.row-dot.unseen {
  background: var(--text-interactive);
}

.row-dot.error {
  background: var(--error);
}

.row-spin {
  width: 15px;
  height: 15px;
  border: 1.5px solid var(--border-strong);
  border-top-color: var(--text-interactive);
  border-radius: 50%;
  animation: session-spin 0.7s linear infinite;
}

@keyframes session-spin {
  to {
    transform: rotate(360deg);
  }
}

/*
 * Closed to nothing at rest rather than held open and empty: an action nobody
 * has reached for should not be spending width the title could be using.
 */
.row-slot {
  flex-shrink: 0;
  display: flex;
  width: 0;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
  transition:
    width 0.12s,
    opacity 0.12s;
}

.row:hover .row-slot,
.row:focus-within .row-slot {
  width: 24px;
  opacity: 1;
  pointer-events: auto;
}

.row-act {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  color: var(--text-weaker);
  border-radius: var(--radius-md);
}

.row-act:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

/* Translucent, so the row underneath still reads as the selected one rather
   than as a second surface laid over the panel. */
.row.on {
  background: var(--surface-selected);
}

.row-title {
  flex: 1;
  overflow: hidden;
  color: var(--text-strong);
  font-size: 14px;
  line-height: 180%;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
