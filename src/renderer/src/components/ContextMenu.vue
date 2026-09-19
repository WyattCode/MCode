<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue"
import { filterMenu, type MenuItem } from "../lib/menu"
import { besideRow } from "../lib/submenu"
import { isRovingKey } from "../lib/composer-menu"
import { focusRow } from "../lib/menu-keys"
import { composing, shownChord } from "../lib/keys"
import { useEscapeLayer } from "../lib/escape-layer"

/**
 * The right-click menu, wherever one is wanted.
 *
 * Three panels grew one of these independently, and each had to solve the same
 * things: staying on screen near an edge, closing on a click elsewhere or on
 * Escape, and sitting above every other layer. Those belong in one place; what
 * differs between them is only the list of actions.
 *
 * A row with children opens a second panel beside it, as MiMo's menus do: on
 * hover, on a click, or on the arrow key pointing into it. Escape and the other
 * arrow close that panel alone, and the menu stays.
 */
const props = defineProps<{
  x: number
  y: number
  items: MenuItem[]
  /** `y` is the menu's bottom edge: for a control at the foot of the window. */
  above?: boolean
  /** `x` is the menu's right edge: for a control at the end of a row. */
  end?: boolean
  /** MiMo's side column menus: 13px rows on a 14px corner inside 4px of padding. */
  side?: boolean
  /** MiMo's tool dropdown (the right panel's plus and tab menus): 14px rows on an 11px corner, key caps for shortcuts. */
  tool?: boolean
  /** The narrowest the panel may be, as each of MiMo's menus sets its own. */
  minWidth?: number
}>()
const emit = defineEmits<{ pick: [key: string]; close: [] }>()

const box = ref<HTMLElement>()
const at = ref({ x: props.x, y: props.y })

/* The child panel: which row opened it, where it sits, and what its search holds. */
const sub = ref<{ key: string; left: number; top: number; toward: "left" | "right" }>()
const subBox = ref<HTMLElement>()
const query = ref("")
const parent = computed(() => props.items.find((item) => item.key === sub.value?.key))
const filtered = computed(() => filterMenu(parent.value?.children ?? [], query.value))

/* MiMo's child panels are 184 wide unless the row says otherwise. */
const CHILD_WIDTH = 184
/* Long enough to cross a row on the way into the panel, short enough to feel immediate. */
const CLOSE_DELAY = 220
let closeTimer: ReturnType<typeof setTimeout> | undefined

onMounted(async () => {
  // Measured rather than guessed: the width depends on the language.
  await nextTick()
  const rect = box.value?.getBoundingClientRect()
  if (!rect) return
  const margin = 8
  if (props.above) at.value.y = Math.max(margin, props.y - rect.height)
  if (props.end) at.value.x = Math.max(margin, props.x - rect.width)
  /*
   * Flipped to the other side of the pointer rather than merely pushed back,
   * so the pointer never lands on top of the first item.
   */
  if (at.value.x + rect.width > window.innerWidth - margin) {
    at.value.x = Math.max(margin, at.value.x - rect.width)
  }
  if (at.value.y + rect.height > window.innerHeight - margin) {
    at.value.y = Math.max(margin, window.innerHeight - margin - rect.height)
  }

  /*
   * MiMo's menu takes focus on its first row however it was opened, so Enter
   * acts on the menu and not on the control under it. Text right-clicks use
   * the system menu, so no editing command is left without its field.
   */
  box.value?.querySelector<HTMLButtonElement>(".item:not(:disabled)")?.focus({ preventScroll: true })
})

function place(row: HTMLElement, width: number, height: number) {
  const rect = row.getBoundingClientRect()
  const spot = besideRow(rect, width, height)
  return { left: spot.left, top: spot.top, toward: spot.left >= rect.right - 1 ? "right" : "left" } as const
}

function cancelClose() {
  if (closeTimer) clearTimeout(closeTimer)
  closeTimer = undefined
}

/**
 * Closes the child panel after a moment.
 *
 * `always` is for the pointer arriving on another row of this menu, which closes
 * it even while its search has focus; merely leaving the panels does not, so a
 * pointer that strays while someone types does not take the field away.
 */
function scheduleClose(always: boolean) {
  cancelClose()
  closeTimer = setTimeout(() => {
    closeTimer = undefined
    if (!always && subBox.value?.contains(document.activeElement)) return
    closeSub(false)
  }, CLOSE_DELAY)
}

function closeSub(refocus: boolean) {
  const key = sub.value?.key
  const hadFocus = Boolean(subBox.value?.contains(document.activeElement))
  sub.value = undefined
  query.value = ""
  if (key && (refocus || hadFocus)) box.value?.querySelector<HTMLElement>(`[data-sub="${CSS.escape(key)}"]`)?.focus()
}

async function openSub(item: MenuItem, row: HTMLElement, focus: "first" | "search" | "none") {
  cancelClose()
  if (sub.value?.key !== item.key) {
    query.value = ""
    sub.value = { key: item.key, ...place(row, item.childWidth ?? CHILD_WIDTH, 120) }
    await nextTick()
    // Placed again once drawn, now that its real size is known.
    const rect = subBox.value?.getBoundingClientRect()
    if (rect && sub.value?.key === item.key) sub.value = { key: item.key, ...place(row, rect.width, rect.height) }
  }
  if (focus === "none") return
  await nextTick()
  const field = subBox.value?.querySelector<HTMLElement>(".sub-search input")
  const first = subBox.value?.querySelector<HTMLElement>(".item:not(:disabled)")
  ;(field ?? (focus === "first" ? first : undefined))?.focus()
}

function enterRow(item: MenuItem, event: MouseEvent) {
  if (item.children && item.enabled !== false) {
    void openSub(item, event.currentTarget as HTMLElement, item.search ? "search" : "none")
    return
  }
  if (sub.value) scheduleClose(true)
}

function pressRow(item: MenuItem, event: MouseEvent) {
  if (item.children) {
    void openSub(item, event.currentTarget as HTMLElement, "first")
    return
  }
  emit("pick", item.key)
}

function leaveMain(event: MouseEvent) {
  if (!sub.value) return
  if (subBox.value?.contains(event.relatedTarget as Node | null)) return
  scheduleClose(false)
}

function leaveSub(event: MouseEvent) {
  const next = event.relatedTarget as HTMLElement | null
  if (next?.closest?.(`[data-sub]`)?.getAttribute("data-sub") === sub.value?.key) return
  scheduleClose(false)
}

/** Keys typed into the search stay there: they neither move nor close the menu. */
function searchKey(event: KeyboardEvent) {
  if (event.key === "ArrowDown") {
    event.preventDefault()
    event.stopPropagation()
    subBox.value?.querySelector<HTMLElement>(".item:not(:disabled)")?.focus()
    return
  }
  // Enter that commits a pinyin candidate is the input method's, not a pick.
  if (event.key === "Enter" && !composing(event)) {
    event.preventDefault()
    event.stopPropagation()
    const first = filtered.value.rows.find((item) => !item.sticky && item.enabled !== false)
    if (first) emit("pick", first.key)
    return
  }
  event.stopPropagation()
}

// One level at a time: the child panel first, then the menu.
useEscapeLayer(
  () => {
    if (sub.value) closeSub(true)
    else emit("close")
  },
  () => emit("close"),
)

function onKey(event: KeyboardEvent) {
  const inSub = Boolean(subBox.value?.contains(document.activeElement))
  if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
    const rtl = document.documentElement.dir === "rtl"
    const inward = (event.key === "ArrowRight") !== rtl
    const active = document.activeElement as HTMLElement | null
    if (inward && !inSub && active?.dataset.sub) {
      const item = props.items.find((entry) => entry.key === active.dataset.sub)
      if (item) {
        event.preventDefault()
        void openSub(item, active, "first")
      }
      return
    }
    if (!inward && inSub) {
      event.preventDefault()
      closeSub(true)
    }
    return
  }
  // A modal menu keeps Tab inside, walking its rows as the arrows do.
  const key = event.key === "Tab" ? (event.shiftKey ? "ArrowUp" : "ArrowDown") : event.key
  if (!isRovingKey(key)) return

  const scope = inSub ? subBox.value : box.value
  const items = [...(scope?.querySelectorAll<HTMLElement>(".item:not(:disabled)") ?? [])]
  if (!items.length) return
  event.preventDefault()
  // Wraps at either end; Home and End jump there.
  focusRow(items, key)
}

/* A label ending in a full-width colon runs straight into its value; any other gets a space. */
const joiner = (label: string) => (label.endsWith("：") ? "" : " ")

onMounted(() => document.addEventListener("keydown", onKey))
onBeforeUnmount(() => {
  document.removeEventListener("keydown", onKey)
  cancelClose()
})
</script>

<template>
  <!-- Closes on any click, takes the next right-click, and leaves nothing behind. -->
  <div class="scrim" @mousedown="emit('close')" @contextmenu.prevent="emit('close')" @wheel="emit('close')" />
  <div
    ref="box"
    class="menu"
    :class="{ side, tool }"
    role="menu"
    :style="{ left: `${at.x}px`, top: `${at.y}px`, minWidth: minWidth ? `${minWidth}px` : undefined }"
    @mouseleave="leaveMain"
  >
    <template v-for="item in items" :key="item.key">
      <div v-if="item.divided" class="rule" />
      <div v-if="item.heading" class="heading">{{ item.label }}</div>
      <button
        v-else
        class="item"
        :class="{
          ticked: item.checked && !item.checkEnd,
          danger: item.danger,
          active: item.active,
          'has-sub': Boolean(item.children),
          open: sub?.key === item.key,
        }"
        role="menuitem"
        :disabled="item.enabled === false"
        :data-key="item.key"
        :data-sub="item.children ? item.key : undefined"
        :aria-haspopup="item.children ? 'menu' : undefined"
        :aria-expanded="item.children ? sub?.key === item.key : undefined"
        @mousedown.prevent
        @mouseenter="enterRow(item, $event)"
        @click="pressRow(item, $event)"
      >
        <img v-if="item.image" class="app-icon" :src="item.image" alt="" data-menu-app-icon />
        <span v-else-if="item.letter" class="app-letter" data-menu-app-icon>{{ item.letter }}</span>
        <svg
          v-if="item.icon"
          class="glyph"
          :class="{ tinted: Boolean(item.iconColor) }"
          :style="item.iconColor ? { color: item.iconColor } : undefined"
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path :d="item.icon" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span v-if="!item.checkEnd" class="tick" aria-hidden="true">
          <svg v-if="item.checked" width="12" height="12" viewBox="0 0 20 20" fill="none">
            <path d="M4.5 10.5L8 14L15.5 6.5" stroke="currentColor" stroke-linecap="square" />
          </svg>
        </span>
        <span class="label">{{ item.label }}<span v-if="item.value" class="value">{{ joiner(item.label) }}{{ item.value }}</span></span>
        <span v-if="item.hint" class="hint">{{ shownChord(item.hint) }}</span>
        <svg v-if="item.children" class="chev" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M6 3.8 10.2 8 6 12.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <svg v-else-if="item.checkEnd" class="tick-end" :class="{ on: item.checked }" width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M4.5 10.5L8 14L15.5 6.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </template>
  </div>

  <div
    v-if="sub && parent"
    ref="subBox"
    class="menu sub"
    :class="[{ side }, sub.toward]"
    role="menu"
    data-submenu
    :style="{ left: `${sub.left}px`, top: `${sub.top}px`, minWidth: `${parent.childWidth ?? CHILD_WIDTH}px` }"
    @mouseenter="cancelClose"
    @mouseleave="leaveSub"
  >
    <div v-if="parent.search" class="sub-search">
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="7" cy="7" r="4.3" stroke="currentColor" stroke-width="1.2" />
        <path d="M10.2 10.2 14 14" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
      </svg>
      <input
        v-model="query"
        :class="{ filled: Boolean(query) }"
        :placeholder="parent.search.placeholder"
        :aria-label="parent.search.placeholder"
        spellcheck="false"
        autocomplete="off"
        @mousedown.stop
        @keydown="searchKey"
      />
    </div>
    <template v-for="child in filtered.rows" :key="child.key">
      <div v-if="child.divided && !query.trim()" class="rule" />
      <button
        class="item"
        :class="{ ticked: child.checked && !child.checkEnd, danger: child.danger, active: child.active }"
        role="menuitem"
        :disabled="child.enabled === false"
        :data-key="child.key"
        @mousedown.prevent
        @click="emit('pick', child.key)"
      >
        <svg
          v-if="child.icon"
          class="glyph"
          :class="{ tinted: Boolean(child.iconColor) }"
          :style="child.iconColor ? { color: child.iconColor } : undefined"
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path :d="child.icon" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span v-if="!child.checkEnd" class="tick" aria-hidden="true">
          <svg v-if="child.checked" width="12" height="12" viewBox="0 0 20 20" fill="none">
            <path d="M4.5 10.5L8 14L15.5 6.5" stroke="currentColor" stroke-linecap="square" />
          </svg>
        </span>
        <span class="label">{{ child.label }}</span>
        <span v-if="child.hint" class="hint">{{ shownChord(child.hint) }}</span>
        <svg v-if="child.checkEnd" class="tick-end" :class="{ on: child.checked }" width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M4.5 10.5L8 14L15.5 6.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </template>
    <div v-if="parent.search && query.trim() && !filtered.matched" class="sub-empty" data-submenu-empty>{{ parent.search.empty }}</div>
    <template v-if="parent.footer?.length">
      <div class="rule" />
      <button
        v-for="foot in parent.footer"
        :key="foot.key"
        class="item"
        :class="{ danger: foot.danger }"
        role="menuitem"
        :disabled="foot.enabled === false"
        :data-key="foot.key"
        @mousedown.prevent
        @click="emit('pick', foot.key)"
      >
        <svg v-if="foot.icon" class="glyph" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path :d="foot.icon" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span class="label">{{ foot.label }}</span>
      </button>
    </template>
  </div>
</template>

<style scoped>
/*
 * Above every other layer, tooltips included: this is opened by the user at a
 * moment of their choosing and has to be reachable wherever it lands.
 */
.scrim {
  position: fixed;
  inset: 0;
  z-index: 320;
}

/*
 * MiMo's `.menu`, measured: a 12px corner over 5px of padding, 200 at its
 * narrowest, on a 1px line - and it pops in rather than appearing.
 */
.menu {
  --pad: 5px;
  position: fixed;
  z-index: 321;
  min-width: 200px;
  padding: var(--pad);
  background: var(--surface-menu);
  border: 1px solid var(--border-weak);
  border-radius: 12px;
  /*
   * MiMo's --shadow-menu written out: one wide soft throw over one tight drop,
   * and no ring - the border above is the edge. Written literally rather than
   * as --shadow-lg, whose third layer is a 0.5px ring that framed it twice.
   */
  box-shadow: 0 8px 30px #0000002e, 0 1px 3px #0000001a;
  transform-origin: 0 100%;
  animation: menu-pop 0.18s cubic-bezier(0.16, 1, 0.3, 1);
}

:root[data-theme="dark"] .menu {
  box-shadow: 0 8px 30px #0009, 0 1px 3px #0006;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .menu {
    box-shadow: 0 8px 30px #0009, 0 1px 3px #0006;
  }
}

@keyframes menu-pop {
  from {
    opacity: 0;
    transform: scale(0.96) translateY(4px);
  }

  to {
    opacity: 1;
    transform: none;
  }
}

/* A child panel scrolls on its own when a long list of projects outgrows the window. */
.menu.sub {
  z-index: 322;
  max-height: min(420px, calc(100vh - 16px));
  overflow-y: auto;
}

/* The gap between a row and its panel still counts as the panel, so the pointer can cross it. */
.menu.sub::before {
  position: absolute;
  inset-block: 0;
  width: 8px;
  content: "";
}

.menu.sub.right::before {
  right: 100%;
}

.menu.sub.left::before {
  left: 100%;
}

/* A group's name, the way opencode's DropdownMenu.GroupLabel reads. */
.heading {
  padding: 6px 10px 2px;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-weight: 500;
}

/*
 * The tick column is drawn only in a menu that has something ticked - an
 * ordinary menu has no `checked` on any item, so `.tick` collapses and every
 * label keeps the inset it had.
 */
.tick {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 0;
  margin-inline-end: 0;
  overflow: hidden;
  color: var(--text-strong);
  transition: none;
}

.item.ticked .tick,
.menu:has(.ticked) .tick {
  width: 14px;
  margin-inline-end: 4px;
}

/* MiMo's `.menu-item`: a 14px row 6 by 10 on an 8px corner, 9 from glyph to label. */
.item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 6px 10px;
  color: var(--text-strong);
  text-align: start;
  border-radius: 8px;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 400;
  line-height: 20px;
}

.label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item:hover:not(:disabled),
.item.open {
  background: var(--surface-hover);
}

/* The current choice, like the project a conversation already sits in. */
.item.active {
  background: var(--surface-selected);
}

.item:disabled {
  opacity: 0.5;
  pointer-events: none;
}

.item:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: -2px;
}

/* MiMo's `.menu-div`: inset from both ends rather than drawn full-bleed. */
.rule {
  height: 1px;
  margin: 4px 6px;
  background: var(--border-weak);
}

/* A shortcut beside its row, pushed to the far edge so a column of them lines up. */
.hint {
  margin-inline-start: auto;
  padding-inline-start: 20px;
  color: var(--text-weak);
  font-size: calc(11px * var(--ui-font-scale, 1));
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* A glyph against every row, as MiMo draws its conversation menu: 17px. */
.glyph {
  flex-shrink: 0;
  width: 17px;
  height: 17px;
  color: var(--text-base);
}

.item:hover:not(:disabled) .glyph {
  color: var(--text-strong);
}

/* An app's own icon, or its first letter on a small square, sized as the settings picker draws them. */
.app-icon,
.app-letter {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  border-radius: 4px;
}

.app-letter {
  display: grid;
  place-items: center;
  color: var(--text-weak);
  background: var(--surface-hover);
  font-size: calc(10px * var(--ui-font-scale, 1));
  line-height: 1;
}

/* MiMo's submenu mark: 14px at half strength, at the far end, pointing into the panel. */
.chev {
  flex-shrink: 0;
  margin-inline-start: auto;
  padding-inline-start: 0;
  opacity: 0.5;
}

.chev:dir(rtl) {
  transform: scaleX(-1);
}

.item.has-sub .label {
  padding-inline-end: 12px;
}

/* A choice's tick at the far end, drawn only on the one in force. */
.tick-end {
  flex-shrink: 0;
  margin-inline-start: auto;
  opacity: 0;
}

.tick-end.on {
  opacity: 1;
}

.item:has(.tick-end) .label {
  padding-inline-end: 16px;
}

/* The row that destroys something says so before it is pressed. */
.item.danger,
.item.danger .glyph,
.item.danger:hover:not(:disabled) .glyph {
  color: var(--error);
}

.item.danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--error) 12%, transparent);
}

/*
 * MiMo's search over a child panel: a 15px magnifier 7 before a 13px field,
 * held at the top on the menu's own glass as the list scrolls under it.
 */
.sub-search {
  position: sticky;
  top: calc(-1 * var(--pad));
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 7px;
  margin: calc(-1 * var(--pad)) calc(-1 * var(--pad)) 4px;
  padding: 11px 15px 6px;
  color: var(--text-weak);
  background: var(--surface-menu);
  -webkit-backdrop-filter: blur(18px) saturate(150%);
  backdrop-filter: blur(18px) saturate(150%);
}

.sub-search input {
  flex: 1;
  min-width: 0;
  padding: 0;
  color: var(--text-strong);
  font: inherit;
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 400;
  background: transparent;
  border: 0;
  outline: none;
}

.sub-search input.filled {
  font-weight: 500;
}

.sub-search input::placeholder {
  color: var(--text-weak);
  font-weight: 400;
}

/* Nothing the search matched: a plain line, dimmer and smaller than a row. */
.sub-empty {
  padding: 5px 7px;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

/*
 * MiMo's side column menus, measured from its stylesheet: 4px of padding on a
 * 12px corner, 13px rows 5 by 12 on a 14px corner with 9 between glyph and
 * label, 16px glyphs, and rules 3 by 4 in from the edges.
 */
.menu.side {
  --pad: 4px;
}

.menu.side .item {
  padding: 5px 12px;
  border-radius: 14px;
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.menu.side .glyph {
  width: 16px;
  height: 16px;
}

.menu.side .rule {
  margin: 3px 4px;
}

/*
 * MiMo's tool dropdown, used by the right panel's plus and tab menus: the base
 * menu's rows on a wider 16px corner, an 11px corner of their own, disabled
 * rows at .4, and each shortcut an 11px key cap in muted ink.
 */
.menu.tool {
  border-radius: 16px;
}

.menu.tool .item {
  border-radius: 11px;
}

.menu.tool .item:disabled {
  opacity: 0.4;
}

.menu.tool .hint {
  padding: 1px 5px;
  color: color-mix(in srgb, var(--text-strong) 60%, transparent);
  border: 1px solid var(--border-weak);
  border-radius: 5px;
  line-height: normal;
}

:root[data-theme="dark"] .menu.tool .hint {
  color: #b8b8b8;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .menu.tool .hint {
    color: #b8b8b8;
  }
}
</style>
