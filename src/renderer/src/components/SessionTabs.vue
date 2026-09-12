<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { useApp } from "../stores/app"
import { sessionTitle, t } from "../lib/i18n"
import { projectHue, projectName } from "../lib/project"

/**
 * The row of open conversations in the title bar.
 *
 * A session used to be reachable only by going back to the project panel and
 * picking it again, which made moving between two of them a four-click trip.
 * Tabs make the set the user is working through visible, and switching one
 * click - and, as in a browser, they can be reordered and renamed in place.
 */
const app = useApp()

/*
 * `select` rather than calling `app.open` from here: opening the session that
 * is already current changes nothing in the store, and the only thing that
 * takes the app off the launcher is a watcher on that id. Clicking the active
 * tab from the launcher therefore did nothing at all - it looked selected and
 * would not open. App answers this by opening and setting the view.
 */
const emit = defineEmits<{ close: [id: string]; select: [id: string] }>()

const strip = ref<HTMLElement>()

/*
 * The card a tab shows when the pointer rests on it.
 *
 * A tab is 224 pixels holding a title that is often longer, and the project it
 * belongs to is only an avatar. The card is where the whole of it is legible:
 * project, title, and the directory the work is actually happening in.
 */
const hovered = ref<string>()
const cardAt = ref({ x: 0, y: 0 })
let hoverTimer: number | undefined

const card = computed(() => {
  const session = tabs.value.find((entry) => entry.id === hovered.value)
  if (!session) return undefined
  return {
    project: projectName(session.directory, app.config?.projectNames),
    title: sessionTitle(session.title),
    path: session.directory,
  }
})

/*
 * A short delay, so running the pointer across the strip on the way somewhere
 * else does not flash a card for every tab it crosses.
 *
 * The card is placed by the edge the tab begins at, so it reads as belonging to
 * that tab rather than to the one beyond it. A rectangle is measured from the
 * viewport's left whichever way the text runs, so in a mirrored layout the
 * distance the card wants is the one back from the opposite edge.
 */
function enter(event: MouseEvent, id: string) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const rtl = getComputedStyle(document.documentElement).direction === "rtl"
  const start = rtl ? document.documentElement.clientWidth - rect.right : rect.left
  window.clearTimeout(hoverTimer)
  hoverTimer = window.setTimeout(() => {
    cardAt.value = { x: Math.round(start), y: Math.round(rect.bottom + 6) }
    hovered.value = id
  }, 400)
}

function leave() {
  window.clearTimeout(hoverTimer)
  hovered.value = undefined
}

onBeforeUnmount(() => window.clearTimeout(hoverTimer))

/** The avatar keeps whatever the project was given elsewhere. */
function iconOf(directory: string): string | undefined {
  return app.config?.projectIcons?.[directory]
}

function colorOf(directory: string): string {
  return app.config?.projectColors?.[directory] ?? String(projectHue(directory))
}

function initial(directory: string): string {
  const name = projectName(directory, app.config?.projectNames)
  return (name.match(/[a-z0-9]/i)?.[0] ?? name[0] ?? "?").toUpperCase()
}

/*
 * Pinned tabs sort to the front, keeping their order among themselves. Sorting
 * here rather than reordering the stored list means unpinning puts a tab back
 * where it was rather than at the end.
 */
const tabs = computed(() => {
  const rows = app.tabSessions
  const pinnedRows = rows.filter((session) => app.isPinned(session.id))
  if (!pinnedRows.length) return rows
  return [...pinnedRows, ...rows.filter((session) => !app.isPinned(session.id))]
})

/**
 * A session nobody has written in yet.
 *
 * The server names a session "New session" until the first exchange gives it a
 * real title, so that name is the signal - and it is the only one available for
 * a tab whose transcript is not loaded.
 */
function isDraft(session: { title: string }): boolean {
  return session.title === "New session"
}

/*
 * A tab reached by the palette or a keyboard shortcut can be scrolled out of
 * sight, so the strip is brought to it rather than leaving the row apparently
 * unchanged.
 */
watch(
  () => app.currentID,
  async (id) => {
    if (!id) return
    await nextTick()
    strip.value?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    })
  },
)

/**
 * Whether the row has more in it than fits.
 *
 * The ends only fade when there is something behind them. Tabs shrink towards
 * their avatar before the row scrolls at all, so in ordinary use there is
 * nothing hidden and no fade - painting one anyway laid a gradient over the
 * first and last tab, which is what made their edges look dirty.
 */
const overflowing = ref(false)

function measure() {
  const el = strip.value
  overflowing.value = Boolean(el && el.scrollWidth - el.clientWidth > 1)
}

let observer: ResizeObserver | undefined

onMounted(() => {
  measure()
  if (strip.value) {
    observer = new ResizeObserver(measure)
    observer.observe(strip.value)
  }
})

onBeforeUnmount(() => observer?.disconnect())

// A tab opening or closing changes the width without resizing anything.
watch(() => tabs.value.length, async () => {
  await nextTick()
  measure()
})

/** Middle-click closes, the way it does in a browser. */
function onAuxiliary(event: MouseEvent, id: string) {
  if (event.button !== 1) return
  event.preventDefault()
  emit("close", id)
}

// ---------------------------------------------------------------------------
// Dragging a tab to a new place in the row
// ---------------------------------------------------------------------------

/** The tab being carried, and the slot it would drop into. */
const dragging = ref<string>()
const over = ref<number>()

function onDragStart(event: DragEvent, id: string) {
  dragging.value = id
  over.value = undefined
  if (!event.dataTransfer) return
  event.dataTransfer.effectAllowed = "move"
  // Something has to be written or the drag never starts.
  event.dataTransfer.setData("text/plain", id)
}

/**
 * Which side of the hovered tab the pointer is on.
 *
 * Past the midpoint means the carried tab lands after this one, which is what
 * makes a tab end up where it was let go. Which half is "past" depends on the
 * direction the row runs in: the pointer has to have travelled towards the end
 * of the strip, and in a mirrored layout that is towards smaller coordinates.
 */
function onDragOver(event: DragEvent, index: number) {
  if (!dragging.value) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
  const el = event.currentTarget as HTMLElement
  const rect = el.getBoundingClientRect()
  const past = getComputedStyle(el).direction === "rtl"
    ? event.clientX < rect.left + rect.width / 2
    : event.clientX > rect.left + rect.width / 2
  over.value = past ? index + 1 : index
}

function onDrop(event: DragEvent) {
  if (!dragging.value || over.value === undefined) {
    endDrag()
    return
  }
  event.preventDefault()
  const from = app.tabs.indexOf(dragging.value)
  // Taking the tab out first shifts every later slot back by one.
  const to = over.value > from ? over.value - 1 : over.value
  app.moveTab(dragging.value, to)
  endDrag()
}

function endDrag() {
  dragging.value = undefined
  over.value = undefined
}

// ---------------------------------------------------------------------------
// Renaming in place
// ---------------------------------------------------------------------------

/** The tab whose title is being typed over, if any. */
const editing = ref<string>()
const field = ref<HTMLInputElement[] | HTMLInputElement>()

function fieldEl(): HTMLInputElement | undefined {
  const value = field.value
  return Array.isArray(value) ? value[0] : value
}

async function beginRename(session: { id: string }) {
  editing.value = session.id
  await nextTick()
  const input = fieldEl()
  input?.focus()
  input?.select()
}

async function commitRename(id: string) {
  const value = fieldEl()?.value.trim()
  editing.value = undefined
  if (!value) return
  const session = tabs.value.find((entry) => entry.id === id)
  if (!session || value === sessionTitle(session.title)) return
  await app.rename(id, value)
}
</script>

<template>
  <div v-if="tabs.length" class="tabs">
    <!--
      Drawn at the end so it sits over the strip, and positioned rather than
      nested: a tab clips its own contents, which would cut the card in half.
    -->
    <Teleport to="body">
      <div v-if="card" class="tab-card" :style="{ insetInlineStart: `${cardAt.x}px`, top: `${cardAt.y}px` }">
        <div class="tab-card-head">
          <div v-if="card.project" class="tab-card-project">{{ card.project }}</div>
          <div v-if="card.title" class="tab-card-title">{{ card.title }}</div>
        </div>
        <div v-if="card.path" class="tab-card-row">
          <span class="tab-card-detail">{{ card.path }}</span>
        </div>
      </div>
    </Teleport>

    <div ref="strip" class="scroll" @scroll="measure" @dragend="endDrag" @dragover.prevent>
      <div
        v-for="(session, index) in tabs"
        :key="session.id"
        class="slot"
        :data-active="String(session.id === app.currentID)"
        :data-drop="over === index ? 'before' : over === index + 1 ? 'after' : undefined"
        @dragover="onDragOver($event, index)"
        @drop="onDrop"
      >
        <div
          class="tab"
          :class="{ active: session.id === app.currentID, ghost: dragging === session.id }"
          :draggable="editing !== session.id"
          @dblclick="app.togglePinned(session.id)"
          @dragstart="onDragStart($event, session.id)"
          @mouseenter="enter($event, session.id)"
          @mouseleave="leave"
        >
          <button
            v-if="editing !== session.id"
            class="link"
            @click="emit('select', session.id)"
            @dblclick.stop="beginRename(session)"
            @auxclick="onAuxiliary($event, session.id)"
          >
            <span class="avatar-slot">
              <!--
                A session nobody has written in yet is a draft, and the design
                marks it with the compose glyph rather than with the project it
                would belong to - which is not decided until it is used.
              -->
              <svg v-if="isDraft(session)" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M13.5555 8.21534V13.5556H2.44434L2.44434 2.4445H7.78462M6.88878 9.11119C6.88878 9.11119 8.96327 9.0367 9.69678 8.3032L14.0301 3.96986C14.5824 3.4176 14.5824 2.52213 14.0301 1.96986C13.4778 1.4176 12.5824 1.4176 12.0301 1.96986L7.69678 6.3032C7.00513 6.99484 6.88878 9.11119 6.88878 9.11119Z" stroke="currentColor" stroke-width="1" />
              </svg>
              <span v-else class="avatar" :style="{ '--h': colorOf(session.directory) }">
                <img v-if="iconOf(session.directory)" :src="iconOf(session.directory)" alt="" />
                <template v-else>{{ initial(session.directory) }}</template>
              </span>
              <!--
                Sits on the avatar rather than beside the title: the tab strip
                is scanned down the edge each tab begins at, and a mark out at
                the end of a truncated name is not seen at all.
              -->
              <span v-if="app.unread(session.id)" class="unread" aria-hidden="true" />
              <!-- A pinned tab says so where the close button would be. -->
              <svg
                v-if="app.isPinned(session.id)"
                class="pinned"
                width="8"
                height="8"
                viewBox="0 0 10 10"
                aria-hidden="true"
              >
                <path d="M5 1v4M3 5h4l-.6 3H3.6z" fill="currentColor" />
              </svg>
            </span>
            <span class="title">{{ sessionTitle(session.title) }}</span>
          </button>

          <!-- The same row with the title handed over to be typed in. -->
          <input
            v-else
            ref="field"
            class="rename"
            :value="sessionTitle(session.title)"
            spellcheck="false"
            @keydown.enter.prevent="commitRename(session.id)"
            @keydown.esc.prevent="editing = undefined"
            @blur="commitRename(session.id)"
          />

          <button
            v-if="editing !== session.id"
            class="close"
            :aria-label="t('tabs.close')"
            @click.stop="emit('close', session.id)"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4.25 11.75L11.75 4.25M11.75 11.75L4.25 4.25" stroke="currentColor" stroke-width="1" />
            </svg>
          </button>
        </div>
      </div>
    </div>

    <!--
      Only when the row really is scrolled: a fade over a row that fits is a
      gradient across the first and last tab and nothing else.
    -->
    <div class="fade left" :class="{ on: overflowing }" aria-hidden="true" />
    <div class="fade right" :class="{ on: overflowing }" aria-hidden="true" />
  </div>
</template>

<style scoped>
.tabs {
  position: relative;
  min-width: 0;
  -webkit-app-region: no-drag;
}

.scroll {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow-x: auto;
  /* The bar is 36px tall; a scrollbar in it would cost a third of the height. */
  scrollbar-width: none;
}

.scroll::-webkit-scrollbar {
  display: none;
}

.slot {
  position: relative;
  display: flex;
  flex: 0 1 auto;
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: 24px;
  /* Full width while there is room, shrinking towards the avatar when there
     is not - so a tenth tab narrows the row instead of overflowing it. */
  width: 224px;
  min-width: 28px;
  max-width: 224px;
}

/*
 * The divider between two neighbouring tabs, drawn in the 6px gap by the later
 * of the two. The first tab has nothing before it to be divided from, and a
 * tab that is filled - selected or under the pointer - drops its own divider,
 * which would otherwise sit against the fill as a smudge of the same colour.
 */
.slot + .slot::before {
  position: absolute;
  top: 8px;
  inset-inline-start: -3.75px;
  width: 1.5px;
  height: 12px;
  background: var(--surface-layer);
  border-radius: 2px;
  content: "";
}

/*
 * Four rules, which is what opencode has and this had half of.
 *
 * A divider belongs to the later of two tabs and is drawn in the gap between
 * them, so a filled tab has to suppress the one on *both* of its sides: its
 * own, and the one the tab after it draws. Only the first two were here, so
 * the gap to the right of the active or hovered tab kept its divider - and
 * with no tab active at all, which is what the launcher means, every gap drew
 * one, including the gap before a tab that had nothing in it yet.
 */
.slot[data-active="true"]::before,
.slot:hover::before {
  display: none;
}

.slot[data-active="true"] + .slot::before,
.slot:hover + .slot::before {
  display: none;
}

/* Where a dragged tab would land, drawn in the gap it would open up. */
.slot[data-drop]::after {
  position: absolute;
  top: 4px;
  z-index: 12;
  width: 2px;
  height: 20px;
  background: var(--interactive);
  border-radius: 1px;
  content: "";
}

.slot[data-drop="before"]::after {
  inset-inline-start: -4px;
}

.slot[data-drop="after"]::after {
  inset-inline-end: -4px;
}

/*
 * opencode's own card: 256 wide, twelve of padding, six between its lines, and
 * drawn on the deep background rather than the menu surface - it is a label,
 * not something to act on, which is also why it takes no pointer events.
 */
.tab-card {
  position: fixed;
  z-index: 400;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 256px;
  padding: 12px;
  background: var(--surface-base);
  border-radius: 6px;
  box-shadow: var(--shadow-lg);
  user-select: none;
  pointer-events: none;
}

.tab-card-head {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}

.tab-card-project {
  color: var(--text-base);
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 440;
  line-height: 1.5;
  letter-spacing: -0.04px;
}

.tab-card-title {
  color: var(--text-strong);
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 530;
  line-height: 1.5;
  letter-spacing: -0.04px;
  overflow-wrap: anywhere;
}

.tab-card-row {
  display: flex;
  width: 100%;
  min-width: 0;
}

/* The whole path wraps rather than losing its end to an ellipsis. */
.tab-card-detail {
  flex: 1 0 0;
  min-width: 0;
  color: var(--text-base);
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 440;
  line-height: 1.5;
  letter-spacing: -0.04px;
  overflow-wrap: anywhere;
}

.tab {
  position: relative;
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
  height: 28px;
  padding: 0 6px;
  overflow: hidden;
  /* The bar's own colour rather than nothing, which is how the reference
     paints an unselected tab. */
  background: var(--surface-base);
  border-radius: 6px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  white-space: nowrap;
}

/*
 * Three steps, not two.
 *
 * Resting is the bar's own colour; hovering lifts the tab to the layer above
 * it; and the selected tab takes that layer *and* a tenth of white over the
 * top. Painting selected and hovered the same made the row ambiguous - which
 * tab you were pointing at looked exactly like the one you were in.
 */
.tab:hover:not(.active) {
  background-color: var(--surface-layer);
}

/*
 * Lifted with a token rather than with white.
 *
 * The overlay was a dark-scheme device: over #2e2e2e a tenth of white reads as
 * a raised tab, but over the light scheme's #f2f2f2 it lands on #f3f3f3 - which
 * is a step TOWARDS the #fafafa of the unselected tabs beside it, so the one
 * tab that should stand out was the hardest to find. Mixing the text colour in
 * instead lightens in the dark scheme and darkens in the light one, because
 * that is what the token already means in each.
 */
.tab.active {
  background-color: color-mix(in srgb, var(--text-strong) 8%, var(--surface-layer));
}

/* The one being carried steps back, so the gap it would leave reads. */
.tab.ghost {
  opacity: 0.4;
}

.link {
  display: flex;
  flex: 1;
  flex-direction: row;
  align-items: center;
  gap: 6px;
  min-width: 0;
  height: 100%;
  color: var(--text-weak);
  font-size: calc(13px * var(--ui-font-scale, 1));
  /*
   * Five hundred, not the 530 the row titles take. The reference runs two
   * weights and the difference is not noise: its tab-link and its tool rows
   * measure 500, while its session rows and settings row titles measure 530.
   */
  font-weight: 500;
  /* A button centres its text; the title belongs against the avatar. */
  text-align: start;
}

.tab.active .link {
  color: var(--text-strong);
}

/*
 * A session with something waiting - a turn that finished, or a permission
 * asking to be answered. Ringed in the tab's own fill so it stays legible on
 * the active tab as well as the inactive ones.
 */
.unread {
  position: absolute;
  top: -2px;
  inset-inline-end: -2px;
  width: 7px;
  height: 7px;
  background: var(--text-accent);
  border: 1.5px solid var(--surface-base);
  border-radius: 50%;
}

.tab.active .unread {
  border-color: var(--surface-raised);
}

/* Sat under the avatar, opposite the unread dot, so the two never collide. */
.pinned {
  position: absolute;
  inset-inline-end: -3px;
  bottom: -3px;
  color: var(--text-weak);
}

.avatar-slot {
  position: relative;
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
}

.avatar {
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  color: #fff;
  /* The same hue the rail badge uses, so a project reads the same everywhere. */
  background: hsl(var(--h) 42% 46%);
  border-radius: var(--radius-sm);
  font-size: calc(11px * var(--ui-font-scale, 1));
  font-weight: 530;
  line-height: 1;
}

.avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  /* Clipped rather than elided, which is what leaves the row of titles even. */
  text-overflow: clip;
  line-height: 16px;
}

/* Sits where the title was, so renaming does not move the row about. */
.rename {
  flex: 1;
  min-width: 0;
  height: 20px;
  padding: 0;
  color: var(--text-strong);
  background: none;
  border: none;
  outline: none;
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 530;
  line-height: 16px;
}

/*
 * Out of the way until wanted: a row of close buttons reads as clutter, and
 * the one that matters is on the tab already being looked at.
 *
 * Laid over the end of the tab rather than beside it, which is what leaves the
 * title the full width to use - a tab that is not being hovered has no close
 * button to make room for, so reserving the space would waste it always.
 */
.close {
  position: absolute;
  top: 4px;
  inset-inline-end: 4px;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  color: var(--text-weak);
  /*
   * Opaque, and painted to match whichever fill the tab is wearing: the title
   * runs the full width underneath, so without a backdrop a long one would
   * read straight through the cross.
   */
  background-color: var(--surface-layer);
  border-radius: var(--radius-sm);
  opacity: 0;
  transition: opacity 0.12s, background 0.12s, color 0.12s;
}

.tab.active .close {
  background-image: linear-gradient(rgb(255 255 255 / 0.1), rgb(255 255 255 / 0.1));
}

.tab:hover .close,
.tab.active .close,
.close:focus-visible {
  opacity: 1;
}

.close:hover {
  color: var(--text-strong);
  background-image: linear-gradient(rgb(255 255 255 / 0.2), rgb(255 255 255 / 0.2));
}

.fade {
  position: absolute;
  inset-block: 0;
  z-index: 10;
  width: 24px;
  visibility: hidden;
  pointer-events: none;
}

.fade.on {
  visibility: visible;
}

/*
 * One for each end of the row, and physical on both counts: a fade belongs
 * against the edge of the window it hides content behind, and its gradient has
 * to run inwards from that same edge, so the pair is already symmetrical
 * whichever way the row is read.
 */
.fade.left {
  left: 0;
  background: linear-gradient(to right, var(--surface-base), transparent);
}

.fade.right {
  right: 0;
  background: linear-gradient(to left, var(--surface-base), transparent);
}
</style>
