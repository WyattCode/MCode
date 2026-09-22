<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue"
import { useApp } from "../stores/app"
import { useRightPanel } from "../stores/right-panel"
import ContextMenu from "./ContextMenu.vue"
import { useOpenWith } from "../lib/open-with"
import { sessionTitle, t } from "../lib/i18n"
import { convoCard } from "../lib/convo-card"

/**
 * The bar across the top of an open conversation.
 *
 * The title used to live only in the window's own chrome, which the new design
 * gives over to tabs - so the session states its own name here, next to how
 * much of the model's context it has used and the things that can be done to
 * it.
 */
const app = useApp()

/**
 * Whether the Context view this header's ring opens is currently up, and
 * whether the info card beside the conversation is.
 */
/* `sideCollapsed`: the side column is folded away, and its toggle and 新建任务 float over this header's start. */
/* `hasContent`: something has been said, which is when MiMo offers the info card at all. */
/* `panelBeside`: a side panel stands to the right, so this row ends at the column instead of under the toggle. */
/* `menuOpen`: this conversation's menu is up, which keeps its "more" tip shut as MiMo's is. */
defineProps<{ infoOpen?: boolean; bottomOpen?: boolean; sideCollapsed?: boolean; hasContent?: boolean; panelBeside?: boolean; menuOpen?: boolean }>()

const emit = defineEmits<{ menu: [x: number, y: number]; info: []; bottom: [] }>()

const title = computed(() => (app.current ? sessionTitle(app.current.title) : ""))

/*
 * MiMo 26.920's rename: one click on the title makes the title itself editable,
 * with everything in it selected. Enter or leaving the field saves, Escape puts
 * the old name back. The element's text is written by hand rather than by the
 * template, so what is being typed is never overwritten under the caret.
 */
const titleEl = ref<HTMLElement>()
const editing = ref(false)
/* MiMo's cap on a conversation name, counted in code points so a pair is never split. */
const TITLE_MAX = 80

function clampTitle(text: string) {
  const points = Array.from(text)
  return points.length > TITLE_MAX ? points.slice(0, TITLE_MAX).join("") : text
}

function showTitle() {
  const el = titleEl.value
  if (el && !editing.value && el.textContent !== title.value) el.textContent = title.value
}

onMounted(showTitle)
watch(title, () => void nextTick(showTitle))

function beginEdit() {
  const el = titleEl.value
  if (!el || !app.current || editing.value) return
  editing.value = true
  el.contentEditable = "true"
  el.textContent = title.value
  requestAnimationFrame(() => {
    if (el.contentEditable !== "true") return
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    const selection = getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
}

function finishEdit() {
  const el = titleEl.value
  if (!el || !editing.value) return
  el.contentEditable = "false"
  editing.value = false
  const next = clampTitle(el.textContent?.trim() || t("session.untitled"))
  el.textContent = next
  el.scrollLeft = 0
  const session = app.current
  if (session && next !== title.value) void app.rename(session.id, next)
}

function cancelEdit() {
  const el = titleEl.value
  if (!el || !editing.value) return
  editing.value = false
  el.textContent = title.value
  el.contentEditable = "false"
  el.scrollLeft = 0
}

/* Past the cap, what was typed is cut back and the caret goes to the end. */
function clampInput() {
  const el = titleEl.value
  if (!el || !editing.value) return
  const text = el.textContent ?? ""
  const clamped = clampTitle(text)
  if (clamped === text) return
  el.textContent = clamped
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  const selection = getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

/* Enter saves unless an IME is still composing; Escape cancels. */
function onTitleKey(event: KeyboardEvent) {
  if (!editing.value) return
  if (event.key === "Enter" && !(event.isComposing || event.keyCode === 229)) {
    event.preventDefault()
    finishEdit()
  } else if (event.key === "Escape") {
    event.preventDefault()
    event.stopPropagation()
    cancelEdit()
  }
}

defineExpose({ beginEdit })

/* MiMo's card over the title: the project, the folder and when it last changed. */
const card = computed(() => (app.current ? convoCard(app.current, app.config?.projectNames, [], undefined, app.groupContext, app.automationTasks) : undefined))
const pinned = computed(() => Boolean(app.current && app.isPinned(app.current.id)))

/*
 * MiMo's open-location control: the folder the conversation works in. MiMo
 * takes it away while the side panel shows a document, a browser or a web page,
 * whose own bars say where they are.
 */
const rp = useRightPanel()
const OWN_LOCATION = ["office", "browser", "html"]
const directory = computed(() =>
  rp.open && OWN_LOCATION.includes(rp.activeTab?.type ?? "") ? undefined : app.current?.directory,
)
const { label: openLabel, items: openItems, open: openIn, pick: pickOpen, choice: openChoice, options: openOptions } = useOpenWith(
  () => app.platform,
)
/*
 * MiMo draws the control only when its app scan finds something, and that scan
 * looks for macOS application bundles alone - Finder among them - so on
 * Windows and Linux the control never appears, and on macOS it always does.
 */
const openShown = computed(() => Boolean(directory.value) && app.platform === "darwin")
/* The face carries the chosen app's own 14px icon, as MiMo's does; the folder mark stands in until it is known. */
const openIcon = computed(() => openOptions.value.find((entry) => entry.value === openChoice.value)?.icon || "")
const appMenu = ref<{ x: number; y: number }>()

function openAppMenu(event: MouseEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  appMenu.value = { x: Math.round(rect.left), y: Math.round(rect.bottom + 4) }
}

function pickApp(key: string) {
  appMenu.value = undefined
  if (directory.value) void pickOpen(key, directory.value)
}

function openMenu(event: MouseEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  emit("menu", rect.right, rect.bottom + 4)
}
</script>

<template>
  <div class="head" :class="{ 'after-rail': sideCollapsed, beside: panelBeside }">
    <div class="left">
      <!-- MiMo marks a pinned conversation before its title. -->
      <span
        v-if="pinned"
        class="pin-mark"
        :aria-label="t('header.pinnedTip')"
        :title="t('header.pinnedTip')"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M9.6 2.2 13.8 6.4l-1.5.4-2.3 2.3.4 2.6-1.2 1.2-5.5-5.5 1.2-1.2 2.6.4 2.3-2.3zM5.6 10.4 2.6 13.4" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
        </svg>
      </span>
      <!-- One click edits the name in place, as MiMo's does; its card stays shut while it is being edited. -->
      <h1
        ref="titleEl"
        class="title"
        :class="{ editing }"
        data-header-title
        spellcheck="false"
        v-tip="card && !editing ? { card, placement: 'bottom' } : ''"
        @click="beginEdit"
        @keydown="onTitleKey"
        @blur="finishEdit"
        @input="clampInput"
      />

      <!--
        Beside the name rather than at the far end of the bar: it is this
        conversation's menu, and MiMo keeps it against the title it belongs to.
        The buttons at the other end drive the panels, which are not the
        conversation.
      -->
      <button class="ico options" v-tip="{ label: t('header.moreTip'), disabled: menuOpen }" @click="openMenu">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.7" />
          <circle cx="12" cy="12" r="1.7" />
          <circle cx="19" cy="12" r="1.7" />
        </svg>
      </button>
    </div>

    <div class="right">
      <!--
        MiMo's first tool: the face opens the project folder in the app last
        chosen, the caret chooses another. Only while there is a folder, and
        only on macOS (openShown).
      -->
      <div v-if="openShown && directory" class="open-with">
        <button
          class="open-face"
          :aria-label="t('header.openDirTip', { name: openLabel })"
          v-tip="t('header.openDirTip', { name: openLabel })"
          @click="openIn(directory)"
        >
          <img v-if="openIcon" class="open-icon" :src="openIcon" width="14" height="14" alt="" aria-hidden="true" />
          <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M2 4.5C2 3.67 2.67 3 3.5 3H6l1.5 1.75h5c.83 0 1.5.67 1.5 1.5v5.25c0 .83-.67 1.5-1.5 1.5h-9c-.83 0-1.5-.67-1.5-1.5v-7Z"
              stroke="currentColor"
              stroke-width="1.2"
              stroke-linejoin="round"
            />
          </svg>
          <span>{{ t("header.openLocation") }}</span>
        </button>
        <button
          class="open-caret"
          :aria-label="t('header.pickApp')"
          v-tip="{ label: t('header.pickApp'), disabled: Boolean(appMenu) }"
          @click="openAppMenu"
        >
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M6.7 8.3 10 11.7l3.3-3.4" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>
      <ContextMenu v-if="appMenu" :x="appMenu.x" :y="appMenu.y" :items="openItems" @pick="pickApp" @close="appMenu = undefined" />
      <!-- The info card beside the conversation; lit while it is up, as MiMo's toggle is. -->
      <button
        v-if="hasContent"
        class="ico info"
        :aria-pressed="Boolean(infoOpen)"
        :aria-label="t('info.tip')"
        v-tip="t('info.tip')"
        @click="emit('info')"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M9.5 6h11M9.5 12h11M9.5 18h11M4 6h.01M4 12h.01M4 18h.01" />
        </svg>
      </button>

      <!--
        The bottom panel, MiMo's second tool here: the terminal docked under the
        conversation, also on Ctrl+J. The context ring this slot used to hold
        lives in the composer, where MiMo keeps it.
      -->
      <button
        class="ico bottom"
        :aria-pressed="Boolean(bottomOpen)"
        :aria-label="t('key.bottomPanel')"
        v-tip="{ label: t('key.bottomPanel'), hint: 'Ctrl+J' }"
        @click="emit('bottom')"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="2.5" y="2.5" width="19" height="19" rx="4" />
          <path d="M2.5 15h19" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 48px;
  padding-block: 0;
  /* MiMo's 18px before the title; the end is set below, clear of the caption buttons. */
  padding-inline: 18px 20px;
}

.left {
  display: flex;
  flex: 1;
  align-items: center;
  /* MiMo's row: pin, title and menu 8 apart. */
  gap: 8px;
  min-width: 0;
}

.pin-mark {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 14px;
  height: 26px;
  margin-inline-end: 2px;
  color: var(--text-weak);
}

/* The rename control itself: MiMo gives it the text cursor and nothing else until it is clicked. */
.title {
  overflow: hidden;
  width: fit-content;
  max-width: 100%;
  margin: 0;
  padding: 4px 8px;
  color: var(--text-strong);
  border-radius: 6px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 530;
  line-height: calc(16px * var(--ui-font-scale, 1));
  letter-spacing: -0.04px;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: text;
  outline: none;
}


.right {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
}

.ico {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  color: var(--text-weak);
  border-radius: 6px;
  transition: background 0.12s, color 0.12s;
}

.ico:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

/*
 * 2.0 has no title strip, so the conversation's own header is what drags the
 * window, and it has to stay clear of the caption buttons Windows draws over
 * its top-right corner. env(titlebar-area-*) describes exactly that band when
 * the overlay is present - the width it leaves for content - and is absent on
 * macOS, where the traffic lights sit over the side column instead; so the
 * reserve below is the caption buttons' width where they exist and nothing
 * where they do not.
 */
.head {
  /* MiMo's header: 46 tall with its row pushed four down, so the title sits
     on the same line as the side column's buttons. */
  height: 46px;
  padding-block: 4px 0;
  /* Clear of the caption buttons, and of the side panel button App.vue keeps beside them:
     its 9px inset and 24px, then MiMo's 4px before this row's last button. */
  /* (the start is pushed past the rail's controls row by .after-rail, below) */
  padding-inline-end: calc(37px + 100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw));
  -webkit-app-region: drag;
}

/* MiMo's topbar inset once a side panel stands beside the column: the toggle is over the panel now. */
.head.beside {
  padding-inline-end: 12px;
}

/* MiMo's title: 14 on regular weight in a 26px line, no padding, at most 320 wide. */
.title {
  height: calc(26px * var(--ui-font-scale, 1));
  max-width: 320px;
  padding: 0;
  border-radius: 0;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 400;
  line-height: calc(26px * var(--ui-font-scale, 1));
  letter-spacing: 0;
}

/*
 * MiMo's title while it is being renamed: a field at least 100 wide on the side
 * column's ground, a 1px edge of that ground with a tenth of the strongest text
 * in it, 8 in on each side and a 7px corner; the text is cut, not ellipsed.
 */
.title.editing {
  display: flex;
  box-sizing: border-box;
  align-items: center;
  min-width: 100px;
  padding: 0 8px;
  background: var(--surface-base);
  border: 1px solid color-mix(in srgb, var(--surface-base), var(--text-strong) 10%);
  border-radius: 7px;
  line-height: normal;
  text-overflow: clip;
}

/*
 * MiMo's title-bar buttons: 24 square, 7 round, in its title-bar icon colour -
 * near the strongest text on a dark ground, that text at 60% on a light one.
 */
.ico {
  width: 24px;
  height: 24px;
  color: color-mix(in srgb, var(--text-strong) 60%, transparent);
  border-radius: 7px;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .ico:not(.options) {
    color: var(--text-strong);
  }
}

:root[data-theme="dark"] .ico:not(.options) {
  color: var(--text-strong);
}

/*
 * MiMo on Windows: the panel toggles' glyphs 12px in its Windows title-bar
 * colour, #2b2b2b on light and #ececec on dark, which hovering and pressing
 * keep rather than brighten.
 */
.app[data-platform="win32"] .ico:not(.options) {
  color: #2b2b2b;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .app[data-platform="win32"] .ico:not(.options) {
    color: #ececec;
  }
}

:root[data-theme="dark"] .app[data-platform="win32"] .ico:not(.options) {
  color: #ececec;
}

.app[data-platform="win32"] .ico:not(.options) svg {
  width: 12px;
  height: 12px;
}

/* Against the title, and never squeezed by a long one: MiMo's 26px menu in its muted (mut) colour. */
.ico.options {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  color: var(--text-base);
}

/*
 * MiMo's open-location control, measured: one bordered piece 24 tall with a
 * 10px corner; the face is 14px medium text after a 14px glyph, 10 in from the
 * left and 4 before the caret, which is 2 and 6 either side of its chevron.
 */
.open-with {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  height: calc(24px * var(--ui-font-scale, 1));
  overflow: hidden;
  border: 1px solid var(--border-weak);
  border-radius: 10px;
}

.open-face {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 100%;
  padding-inline: 10px 4px;
  color: var(--text-strong);
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
}

.open-icon {
  flex: none;
  object-fit: contain;
}

.open-caret {
  display: flex;
  align-items: center;
  height: 100%;
  padding-inline: 2px 6px;
  color: var(--text-weak);
}

.open-face:hover,
.open-caret:hover {
  background: var(--surface-hover);
}

/* The info card's toggle stays lit, in the selected tint, while the card is up; the bottom panel's does not. */
.info[aria-pressed="true"] {
  color: var(--text-strong);
  background: var(--surface-selected);
}

.left > *,
.right {
  -webkit-app-region: no-drag;
}

/* The side column folded away: its toggle and 新建任务 float over the start of this row. */
/* MiMo 26.920's inset past the folded controls: 新建任务's end (107 + 24) less 2, the window's own x now that no rail stands before it. */
.head.after-rail {
  padding-inline-start: 129px;
}

/* Left-aligned folded controls (the user's choice, off macOS): 新建任务 ends at 18 + 24 + 8 + 24 = 74, less the same 2. */
.app:not([data-platform="darwin"]) .head.after-rail {
  padding-inline-start: 72px;
}
</style>
