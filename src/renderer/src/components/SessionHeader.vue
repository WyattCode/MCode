<script setup lang="ts">
import { computed, ref } from "vue"
import { useApp } from "../stores/app"
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
/* `sideCollapsed`: the side column is folded to its rail, whose controls row floats over this header's start. */
/* `hasContent`: something has been said, which is when MiMo offers the info card at all. */
/* `panelBeside`: a side panel stands to the right, so this row ends at the column instead of under the toggle. */
defineProps<{ infoOpen?: boolean; bottomOpen?: boolean; sideCollapsed?: boolean; hasContent?: boolean; panelBeside?: boolean }>()

/* `rename` asks the app for MiMo's rename dialog; the header no longer edits in place. */
const emit = defineEmits<{ rename: []; menu: [x: number, y: number]; info: []; bottom: [] }>()

const title = computed(() => (app.current ? sessionTitle(app.current.title) : ""))

/* MiMo's card over the title: the project, the folder and when it last changed. */
const card = computed(() => (app.current ? convoCard(app.current, app.config?.projectNames) : undefined))
const pinned = computed(() => Boolean(app.current && app.isPinned(app.current.id)))

/* MiMo's open-location control: the folder the conversation works in. */
const directory = computed(() => app.current?.directory)
const { label: openLabel, items: openItems, open: openIn, pick: pickOpen } = useOpenWith(() => app.platform)
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
        v-tip="{ label: t('header.pinnedTip'), placement: 'bottom' }"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M9.6 2.2 13.8 6.4l-1.5.4-2.3 2.3.4 2.6-1.2 1.2-5.5-5.5 1.2-1.2 2.6.4 2.3-2.3zM5.6 10.4 2.6 13.4" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
        </svg>
      </span>
      <!-- A plain label; a double-click opens MiMo's rename dialog. -->
      <h1 class="title" v-tip="card ? { card, placement: 'bottom' } : ''" @dblclick="emit('rename')">{{ title }}</h1>

      <!--
        Beside the name rather than at the far end of the bar: it is this
        conversation's menu, and MiMo keeps it against the title it belongs to.
        The buttons at the other end drive the panels, which are not the
        conversation.
      -->
      <button class="ico options" v-tip="{ label: t('session.options'), placement: 'bottom' }" @click="openMenu">
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
        chosen, the caret chooses another. Only while there is a folder.
      -->
      <div v-if="directory" class="open-with">
        <button
          class="open-face"
          :aria-label="t('header.openDirTip', { name: openLabel })"
          v-tip="{ label: t('header.openDirTip', { name: openLabel }), placement: 'bottom' }"
          @click="openIn(directory)"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
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
          v-tip="{ label: t('header.pickApp'), placement: 'bottom' }"
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
        v-tip="{ label: t('info.tip'), placement: 'bottom' }"
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
        v-tip="{ label: t('key.bottomPanel'), hint: 'Ctrl+J', placement: 'bottom' }"
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
  /* The narrower inset goes where the title starts and the wider where the row
     of icons runs out, so the pair follows the reading rather than the window. */
  padding-inline: 10px 20px;
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

/*
 * Padded and rounded rather than plain text: it is the rename control, and the
 * hover background is the only thing that says so.
 */
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
  line-height: 16px;
  letter-spacing: -0.04px;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.12s;
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
  height: 26px;
  max-width: 320px;
  padding: 0;
  border-radius: 0;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 400;
  line-height: 26px;
  letter-spacing: 0;
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

/* Against the title, and never squeezed by a long one: MiMo's 26px menu in the muted colour. */
.ico.options {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  color: var(--text-weak);
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
  height: 24px;
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

/* The side column folded to its rail: the toggle, back, forward and search float over the start of this row. */
.head.after-rail {
  padding-inline-start: 132px;
}
</style>
