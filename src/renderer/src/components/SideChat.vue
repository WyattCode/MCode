<script setup lang="ts">
import { useApp } from "../stores/app"
import { sessionTitle, t } from "../lib/i18n"
import MessageStream from "./MessageStream.vue"
import Composer from "./Composer.vue"

/**
 * A side chat: a second conversation beside the open one, as MiMo has it.
 *
 * It is a conversation of its own - opened in the same project, numbered, and
 * shown in no list - with its own transcript and its own box. The stream and
 * the box are told they are the side ones, and every read and send they make
 * then goes to the side chat, so nothing typed here can land in the
 * conversation in the middle.
 */
const app = useApp()
const emit = defineEmits<{
  close: []
  "open-settings": []
  connect: []
  "manage-models": []
  shell: [command: string]
  terminal: []
}>()
</script>

<template>
  <aside class="side-chat" :aria-label="t('side.chat')">
    <header class="bar">
      <span class="heading">
        <span class="title">{{ app.side ? sessionTitle(app.side.title) : t("side.chat") }}</span>
        <span class="sub">{{ t("side.chatSub") }}</span>
      </span>
      <button class="ico" :aria-label="t('common.close')" @click="emit('close')">
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
        </svg>
      </button>
    </header>

    <MessageStream class="stream" side />

    <!--
      Its own box rather than the one in the middle. The middle's is moved
      around by a Teleport whose target has to exist when it is patched, and a
      column that appears and disappears is not something to hand that.
    -->
    <div class="dock">
      <!--
        Every event the box raises is passed on. It was mounted with none bound,
        so from this column managing models, connecting a provider and shell
        mode all did nothing - silently, which is the worst way for a button
        to fail.
      -->
      <Composer
        side
        @open-settings="emit('open-settings')"
        @connect="emit('connect')"
        @manage-models="emit('manage-models')"
        @shell="emit('shell', $event)"
        @terminal="emit('terminal')"
      />
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

.heading {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.sub {
  overflow: hidden;
  color: var(--text-weak);
  font-size: calc(11px * var(--ui-font-scale, 1));
  line-height: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.title {
  overflow: hidden;
  color: var(--text-strong);
  font-size: calc(14px * var(--ui-font-scale, 1));
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

.dock :deep(.ctx-slot + .pill-wrap),
.dock :deep(.ctx-slot + .pill-wrap .pill),
.dock :deep(.ctx-slot + .pill-wrap .pill > span) {
  min-width: 0;
  flex-shrink: 1;
}

.dock :deep(.ctx-slot + .pill-wrap .pill > span) {
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
.dock :deep(.ctx-slot + .pill-wrap) {
  display: flex;
}

.dock :deep(.ctx-slot + .pill-wrap .pill) {
  max-width: 100%;
  overflow: hidden;
}

.dock :deep(.attach),
.dock :deep(.mic),
.dock :deep(.send) {
  flex-shrink: 0;
}
</style>
