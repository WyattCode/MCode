<script setup lang="ts">
import { useApp } from "../stores/app"
import { sessionTitle, t } from "../lib/i18n"
import MessageStream from "./MessageStream.vue"
import Composer from "./Composer.vue"

/**
 * The open conversation, in a column of its own beside the workspace.
 *
 * The point is to keep a conversation in view while the main area is doing
 * something else - a page in the browser, the artifacts list, the start of a
 * new task. It holds whichever conversation is current, which is what makes it
 * safe: the box in here sends where every other box in the app would send, and
 * there is no second session for a message to go to by mistake.
 *
 * That is also its limit, and it is deliberate. Pinning a *different*
 * conversation here would mean giving the composer a target other than the
 * current session, and the send path is not somewhere to make a change as a
 * side effect of building a panel.
 */
const app = useApp()
const emit = defineEmits<{ close: []; expand: [] }>()
</script>

<template>
  <aside class="side-chat" :aria-label="t('side.chat')">
    <header class="bar">
      <span class="title">{{ sessionTitle(app.current?.title ?? "") }}</span>
      <!-- Back to the middle, which is where a conversation lives by default. -->
      <button class="ico" :aria-label="t('side.chatExpand')" v-tip="{ label: t('side.chatExpand'), placement: 'bottom' }" @click="emit('expand')">
        <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M8 3.5H4.5a1 1 0 0 0-1 1V8M12 16.5h3.5a1 1 0 0 0 1-1V12" stroke="currentColor" stroke-linecap="round" />
          <path d="M16.5 3.5 11 9M3.5 16.5 9 11" stroke="currentColor" stroke-linecap="round" />
        </svg>
      </button>
      <button class="ico" :aria-label="t('common.close')" @click="emit('close')">
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
        </svg>
      </button>
    </header>

    <MessageStream class="stream" />

    <!--
      Its own box rather than the one in the middle. The middle's is moved
      around by a Teleport whose target has to exist when it is patched, and a
      column that appears and disappears is not something to hand that.
    -->
    <div class="dock">
      <Composer />
    </div>
  </aside>
</template>

<style scoped>
/*
 * 380 wide, which is what the reference gives it: narrow enough that the
 * workspace keeps its room, wide enough that a paragraph is still a paragraph.
 */
.side-chat {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  width: 380px;
  min-height: 0;
  background: var(--surface-base);
  border-inline-start: 1px solid var(--border-weak);
}

.bar {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
  height: 46px;
  padding: 0 8px 0 14px;
}

.title {
  flex: 1;
  overflow: hidden;
  color: var(--text-strong);
  font-size: 14px;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ico {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  color: var(--icon-base);
  background: transparent;
  border: 0;
  border-radius: 7px;
  cursor: pointer;
}

.ico:hover {
  background: var(--surface-hover);
}

.stream {
  flex: 1;
  min-height: 0;
}

.dock {
  flex-shrink: 0;
  padding: 0 8px 10px;
}

/*
 * The conversation and its box were both laid out for the middle of the
 * window, and at 380 they broke in the two ways that matter: a table crushed
 * to a few characters a column, and a row of controls that wrapped its own
 * labels and pushed the send button half off the edge. What follows is only
 * what this column needs; the middle keeps its own layout untouched.
 */

/* The reading column's cap and its wide gutters are for a wide pane. */
.stream :deep(.inner) {
  max-width: none;
  padding: 8px 14px 12px;
}

/*
 * A table scrolls sideways here rather than folding every cell down to a word
 * or two - it already could scroll; its cells were simply allowed to shrink
 * first, and in a narrow column they always could.
 */
.stream :deep(.md-table th),
.stream :deep(.md-table td) {
  padding: 8px;
}

/* Every column but the first, which is usually a number or a short key and
   was being held open to seven ems of nothing. */
.stream :deep(.md-table th:not(:first-child)),
.stream :deep(.md-table td:not(:first-child)) {
  min-width: 7em;
}

/* One line of controls, never two: labels give way before the buttons do. */
.dock :deep(.row) {
  flex-wrap: nowrap;
  min-width: 0;
  gap: 2px;
}

.dock :deep(.pill),
.dock :deep(.pill > span) {
  white-space: nowrap;
}

/* The access control keeps its icon and gives up its words, which the menu
   it opens still says in full. */
.dock :deep(.pill.access > span) {
  display: none;
}

/* The model is the pill right after the spacer; its name is what gets cut. */
/*
 * A flex item will not shrink below its own text unless told it may, and a
 * nowrap label makes that text one long line - so the row was wider than the
 * column and the send button was what got cut. The model pill is the one
 * allowed to give way, all the way down through its label.
 */
.dock :deep(.grow) {
  min-width: 0;
}

.dock :deep(.grow + .pill-wrap),
.dock :deep(.grow + .pill-wrap .pill),
.dock :deep(.grow + .pill-wrap .pill > span) {
  min-width: 0;
  flex-shrink: 1;
}

.dock :deep(.grow + .pill-wrap .pill > span) {
  max-width: 6em;
  overflow: hidden;
  text-overflow: ellipsis;
}

/*
 * Shrinking the wrapper is not the same as shrinking the pill. The wrapper is
 * a plain positioned box, so the pill inside it went on sizing itself to its
 * own text - 126 wide in a 79-wide wrapper - and drew underneath the
 * microphone and the send button. Made a flex container, the wrapper holds the
 * pill to its own width and the pill clips what no longer fits.
 *
 * The clip is on the pill and not on the wrapper on purpose: the model menu is
 * the wrapper's other child, positioned against it, and hiding the wrapper's
 * overflow would cut the menu off the moment it opened.
 */
.dock :deep(.grow + .pill-wrap) {
  display: flex;
}

.dock :deep(.grow + .pill-wrap .pill) {
  max-width: 100%;
  overflow: hidden;
}

.dock :deep(.attach),
.dock :deep(.mic),
.dock :deep(.send) {
  flex-shrink: 0;
}
</style>
