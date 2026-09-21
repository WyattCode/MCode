<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { t } from "../lib/i18n"
import { isRovingKey, rovingStep } from "../lib/composer-menu"
import { useEscapeLayerWhile } from "../lib/escape-layer"

/**
 * The home screen's project chip and its menu, laid out from MiMo's.
 *
 * A ghost chip in the strip under the box: the chosen project's folder and
 * name, or "work in a project" when there is none. The menu opens below it and
 * never flips: a search field over the three most recent projects (the rest
 * behind "show more", or found by typing), a rule, "add a project" with a
 * submenu - a blank one, or a folder already on disk - and "no project".
 */
export interface PickerProject {
  directory: string
  name: string
  /** Where it lives, shown only when another project has the same name. */
  hint?: string
}

const props = defineProps<{
  projects: PickerProject[]
  /** The project the next task goes into; undefined when it goes into none. */
  chosen?: string
}>()

const emit = defineEmits<{
  choose: [directory: string]
  none: []
  existing: []
  blank: []
}>()

/* Three rows before "show more", as the reference keeps it. */
const FIRST = 3

const ICON = {
  folder: ["M1.9 4.2c0-.6.5-1.1 1.1-1.1h2.6l1.3 1.5h6.1c.6 0 1.1.5 1.1 1.1v6.1c0 .6-.5 1.1-1.1 1.1H3c-.6 0-1.1-.5-1.1-1.1z"],
  folderAdd: [
    "M1.9 4.2c0-.6.5-1.1 1.1-1.1h2.6l1.3 1.5h6.1c.6 0 1.1.5 1.1 1.1v6.1c0 .6-.5 1.1-1.1 1.1H3c-.6 0-1.1-.5-1.1-1.1z",
    "M8 7.3v3.4M6.3 9h3.4",
  ],
  add: ["M4 2.5h8A1.5 1.5 0 0 1 13.5 4v8a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12V4A1.5 1.5 0 0 1 4 2.5z", "M8 5.5v5M5.5 8h5"],
  none: ["M4.5 4.5l7 7M11.5 4.5l-7 7"],
  search: ["M7.2 2.8a4.4 4.4 0 1 0 0 8.8 4.4 4.4 0 0 0 0-8.8z", "M13.2 13.2l-2.8-2.8"],
  check: ["M3.5 8.2 6.4 11.1 12.5 5"],
  chev: ["M6.5 4.5 10 8l-3.5 3.5"],
} as const

const open = ref(false)
const query = ref("")
const expanded = ref(false)
const sub = ref(false)
const root = ref<HTMLElement>()
const field = ref<HTMLInputElement>()
const menuEl = ref<HTMLElement>()
const trigger = ref<HTMLElement>()
const submenuEl = ref<HTMLElement>()

const current = computed(() => props.projects.find((project) => project.directory === props.chosen))

const matches = computed(() => {
  const needle = query.value.trim().toLowerCase()
  return needle ? props.projects.filter((project) => project.name.toLowerCase().includes(needle)) : props.projects
})
const searching = computed(() => query.value.trim().length > 0)
const shown = computed(() => (searching.value || expanded.value ? matches.value : matches.value.slice(0, FIRST)))
const more = computed(() => !searching.value && !expanded.value && matches.value.length > FIRST)

/* Every visit starts from the top: no leftover search, no list left expanded. */
watch(open, async (value) => {
  query.value = ""
  expanded.value = false
  sub.value = false
  if (!value) return
  await nextTick()
  field.value?.focus()
})

function toggle() {
  open.value = !open.value
}

function choose(directory: string) {
  open.value = false
  emit("choose", directory)
}

function act(what: "none" | "existing" | "blank") {
  open.value = false
  if (what === "none") emit("none")
  else if (what === "existing") emit("existing")
  else emit("blank")
}

function onPointerDown(event: MouseEvent) {
  if (open.value && !root.value?.contains(event.target as Node)) open.value = false
}

/* MiMo's picker is a non-modal popover: focus moving anywhere outside it and its chip closes it. */
function onFocusOut(event: FocusEvent) {
  const next = event.relatedTarget
  if (open.value && next instanceof Node && !root.value?.contains(next)) open.value = false
}

/*
 * Escape closes one level, as MiMo's nested menus do: the "add a project"
 * submenu back to its row, then the picker.
 */
useEscapeLayerWhile(
  () => open.value,
  () => {
    if (!sub.value) {
      open.value = false
      return
    }
    sub.value = false
    trigger.value?.focus()
  },
  () => (open.value = false),
)

/*
 * MiMo's list keys: ArrowUp and ArrowDown walk the rows and wrap, Home and End
 * go to the ends. The submenu's rows are walked on their own while it has focus.
 */
function rowsIn(container: HTMLElement | undefined, nested: boolean): HTMLElement[] {
  const all = [...(container?.querySelectorAll<HTMLElement>("[data-picker-row]") ?? [])]
  return nested ? all : all.filter((row) => !row.closest(".submenu"))
}

function walk(rows: HTMLElement[], key: "ArrowDown" | "ArrowUp" | "Home" | "End") {
  const ids = rows.map((_, index) => String(index))
  const at = rows.indexOf(document.activeElement as HTMLElement)
  const next = rovingStep(ids, at < 0 ? undefined : String(at), key)
  if (next !== undefined) rows[Number(next)]?.focus()
}

function onMenuKeys(event: KeyboardEvent) {
  if (event.altKey || event.ctrlKey || event.metaKey || !isRovingKey(event.key)) return
  const inSub = Boolean((event.target as HTMLElement).closest(".submenu"))
  event.preventDefault()
  walk(inSub ? rowsIn(submenuEl.value, true) : rowsIn(menuEl.value, false), event.key)
}

/* The search box keeps its keys to itself, as MiMo's does - except Down, which steps into the list. */
function onSearchKeys(event: KeyboardEvent) {
  event.stopPropagation()
  if (event.key === "ArrowDown" && !event.altKey && !event.ctrlKey && !event.metaKey) {
    event.preventDefault()
    rowsIn(menuEl.value, false)[0]?.focus()
  }
}

/* ArrowRight, Enter or Space on "add a project" opens its submenu on the first row. */
async function openSub(event: KeyboardEvent) {
  if (event.target !== trigger.value) return
  event.preventDefault()
  sub.value = true
  await nextTick()
  rowsIn(submenuEl.value, true)[0]?.focus()
}

/* ArrowLeft inside the submenu closes it and gives focus back to its row. */
function closeSub(event: KeyboardEvent) {
  event.preventDefault()
  event.stopPropagation()
  sub.value = false
  trigger.value?.focus()
}

onMounted(() => {
  window.addEventListener("mousedown", onPointerDown, true)
})
onBeforeUnmount(() => {
  window.removeEventListener("mousedown", onPointerDown, true)
})
</script>

<template>
  <div ref="root" class="picker" @focusout="onFocusOut">
    <button class="chip" aria-haspopup="menu" :aria-expanded="open" @click="toggle">
      <svg v-if="current" class="i" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path v-for="d in ICON.folder" :key="d" :d="d" />
      </svg>
      <span class="chip-name">{{ current?.name ?? t("home.enterProject") }}</span>
      <svg class="caret" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M5 6.5L8 9.5L11 6.5" />
      </svg>
    </button>

    <div v-if="open" ref="menuEl" class="menu" role="menu" @keydown="onMenuKeys">
      <div class="search">
        <svg class="i" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path v-for="d in ICON.search" :key="d" :d="d" />
        </svg>
        <input
          ref="field"
          v-model="query"
          spellcheck="false"
          :placeholder="t('home.searchProjects')"
          @keydown="onSearchKeys"
        />
      </div>

      <div class="list-wrap" :class="{ scroll: shown.length > FIRST }">
        <div class="list">
          <div v-if="projects.length && !shown.length" class="row muted">
            <span class="name">{{ t("home.noMatch") }}</span>
          </div>
          <button
            v-for="project in shown"
            :key="project.directory"
            class="row project"
            role="menuitemradio"
            data-picker-row
            :aria-checked="project.directory === chosen"
            :data-directory="project.directory"
            @click="choose(project.directory)"
          >
            <svg class="i" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path v-for="d in ICON.folder" :key="d" :d="d" />
            </svg>
            <span class="names">
              <span class="name">{{ project.name }}</span>
              <span v-if="project.hint" class="hint">{{ project.hint }}</span>
            </span>
            <svg v-if="project.directory === chosen" class="check" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path v-for="d in ICON.check" :key="d" :d="d" />
            </svg>
          </button>
        </div>
      </div>
      <button v-if="more" class="row show-more" role="menuitem" data-picker-row @click="expanded = true">
        <span class="name">{{ t("home.showMore") }}</span>
      </button>

      <div v-if="projects.length" class="rule" role="separator" />

      <div
        ref="trigger"
        class="row sub-trigger"
        :class="{ on: sub }"
        role="menuitem"
        aria-haspopup="menu"
        :aria-expanded="sub"
        tabindex="0"
        data-picker-row
        @mouseenter="sub = true"
        @mouseleave="sub = false"
        @click="sub = !sub"
        @keydown.right="openSub"
        @keydown.enter="openSub"
        @keydown.space="openSub"
      >
        <svg class="i" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path v-for="d in ICON.add" :key="d" :d="d" />
        </svg>
        <span class="name">{{ t("home.newProject") }}</span>
        <svg class="chev" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path v-for="d in ICON.chev" :key="d" :d="d" />
        </svg>
        <div v-if="sub" ref="submenuEl" class="submenu" role="menu" @click.stop @keydown.left="closeSub">
          <button class="row" role="menuitem" data-picker-row data-new-project="blank" @click="act('blank')">
            <svg class="i" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path v-for="d in ICON.folderAdd" :key="d" :d="d" />
            </svg>
            <span class="name">{{ t("home.createBlank") }}</span>
          </button>
          <button class="row" role="menuitem" data-picker-row data-new-project="existing" @click="act('existing')">
            <svg class="i" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path v-for="d in ICON.folder" :key="d" :d="d" />
            </svg>
            <span class="name">{{ t("home.useExisting") }}</span>
          </button>
        </div>
      </div>

      <button class="row no-project" role="menuitem" data-picker-row @click="act('none')">
        <svg class="i" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path v-for="d in ICON.none" :key="d" :d="d" />
        </svg>
        <span class="name">{{ t("home.noProject") }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.picker {
  position: relative;
  min-width: 80px;
  max-width: 100%;
}

svg path {
  stroke: currentColor;
  stroke-width: 1.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* MiMo's chip in the strip: 13/400 in the muted grey, 4 by 12, radius 8, a 15px folder. */
.chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  max-width: 100%;
  padding: 4px 12px;
  color: var(--text-weak);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 8px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 400;
  line-height: calc(20px * var(--ui-font-scale, 1));
}

/* Hover only: MiMo's chip goes back to rest once the pointer is in its menu. */
.chip:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.chip .i {
  flex: none;
  width: 15px;
  height: 15px;
}

.chip-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.caret {
  flex: none;
  width: 16px;
  height: 16px;
}

.caret path {
  stroke-width: 1;
}

/* Below the chip, never flipped: 260 to 440 wide on the glass menu surface, its parts 1 apart. */
.menu {
  position: absolute;
  top: calc(100% + 4px);
  inset-inline-start: 0;
  z-index: 50;
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 260px;
  max-width: min(440px, 100vw - 40px);
  padding: 5px;
  background: color-mix(in srgb, var(--surface-menu) 92%, transparent);
  border: 0.5px solid var(--border-weak);
  border-radius: 16px;
  box-shadow: var(--shadow-lg);
  backdrop-filter: blur(18px) saturate(150%);
}

.search {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 4px;
  padding: 6px 10px;
  color: var(--text-weak);
  border-bottom: 1px solid var(--border-weak);
}

.search .i {
  flex: none;
  width: 15px;
  height: 15px;
}

.search input {
  flex: 1;
  min-width: 0;
  color: var(--text-strong);
  background: transparent;
  border: 0;
  outline: none;
  font: inherit;
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.search input::placeholder {
  color: var(--text-weak);
}

.search input:not(:placeholder-shown) {
  font-weight: 500;
}

/* Past three rows the list scrolls, and fades out at its foot to say so. */
.list-wrap {
  position: relative;
  max-height: 132px;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-height: 132px;
  overflow-y: auto;
}

.list-wrap.scroll::after {
  position: absolute;
  inset: auto 0 0;
  z-index: 1;
  height: 18px;
  pointer-events: none;
  background: linear-gradient(to bottom, transparent, var(--surface-menu));
  content: "";
}

/* MiMo's menu row: 13px, 6 by 10, 9 apart, an 11px corner. */
.row {
  display: flex;
  flex: none;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-width: 0;
  padding: 6px 10px;
  color: var(--text-strong);
  background: transparent;
  border-radius: 11px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 400;
  line-height: calc(20px * var(--ui-font-scale, 1));
  text-align: start;
  cursor: default;
}

.row:hover,
.row:focus-visible,
.sub-trigger.on {
  background: var(--surface-hover);
  outline: none;
}

.row .i {
  flex: none;
  width: 17px;
  height: 17px;
  color: color-mix(in srgb, var(--text-base) 87%, transparent);
}

.names {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hint {
  overflow: hidden;
  color: var(--text-weak);
  font-size: calc(11px * var(--ui-font-scale, 1));
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.check {
  flex: none;
  width: 16px;
  height: 16px;
  margin-inline-start: auto;
  color: var(--text-strong);
}

.muted,
.muted:hover {
  background: transparent;
  opacity: 0.6;
}

.show-more {
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.show-more:hover {
  color: var(--text-strong);
}

.rule {
  flex: none;
  height: 1px;
  margin: 4px 6px;
  background: var(--border-weak);
}

.sub-trigger {
  position: relative;
}

.chev {
  flex: none;
  width: 14px;
  height: 14px;
  margin-inline-start: auto;
  opacity: 0.5;
}

/* MiMo's submenu surface, 5 of padding like every other, its rows 1 apart. */
.submenu {
  position: absolute;
  top: -6px;
  inset-inline-start: calc(100% + 4px);
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 184px;
  padding: 5px;
  background: color-mix(in srgb, var(--surface-menu) 92%, transparent);
  border: 0.5px solid var(--border-weak);
  border-radius: 16px;
  box-shadow: var(--shadow-lg);
  backdrop-filter: blur(18px) saturate(150%);
}

/* A bridge over the gap, so moving from the row into the submenu keeps it open. */
.submenu::before {
  position: absolute;
  inset-block: 0;
  inset-inline-start: -6px;
  width: 6px;
  content: "";
}

/* MiMo's submenu rows keep their 5 by 12 and 6 apart, but take the 11px corner every row has. */
.submenu .row {
  gap: 6px;
  padding: 5px 12px;
  white-space: nowrap;
}
</style>
