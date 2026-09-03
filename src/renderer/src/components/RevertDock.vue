<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useApp } from "../stores/app"
import { draftLine, useRestoreDraft } from "../lib/draft"
import { t } from "../lib/i18n"
import { notifyFailure } from "../lib/toast"

/**
 * The messages a rollback has taken out of the conversation, and the way back.
 *
 * Rolling back to a message hides it and everything after it, and puts the
 * project's files back to how that point found them. Both halves are silent:
 * the transcript simply gets shorter and the files simply change underneath.
 * Without something on screen saying so, a rollback is indistinguishable from
 * the app having lost the end of the conversation, and there is no way at all
 * to ask for it back.
 *
 * So this sits above the composer for as long as a rollback stands. Shut, it is
 * one line - how many messages are out, and the first of them - which is enough
 * to know what happened. Open, it lists them, each with the button that brings
 * it back.
 */
const app = useApp()
/** Handed down by App.vue, which is the only thing that can see the composer. */
const restoreDraft = useRestoreDraft()

/*
 * One line per rolled back message, built the way the reference builds it: the
 * words, then each attachment as `[image:<name>]`, whitespace collapsed. See
 * `draftLine`, which is shared with the composer restore so the row and the
 * prompt it puts back cannot disagree about which files belong to the message.
 *
 * `common.attachment` is the reference's last branch: a message that flattens to
 * nothing still gets a row, and an empty row reads as a bug rather than as a
 * message. Passed in because `draftLine` is deliberately free of the table.
 */
const items = computed(() =>
  app.rolledBack.map((message) => ({ id: message.id, text: draftLine(message, t("common.attachment")) })),
)

const open = ref(false)

/*
 * Shut again whenever the list changes, which is what the reference does. An
 * open list is a list someone is working through; once they have restored one,
 * the useful state is the summary again rather than a list that has silently
 * lost its first row while being read.
 */
watch(
  () => items.value.map((item) => item.id).join(),
  () => (open.value = false),
)

/** True while a rollback is in flight, so a second press cannot race the first. */
const busy = ref(false)

/**
 * Puts one rolled back message back, along with everything before it.
 *
 * The boundary is the first message that is still rolled back, so restoring an
 * entry means moving it past that entry: to the one after, or - when there is
 * nothing after - away entirely. This is why the list restores from the top
 * down: pressing the third row brings back the first three, because the
 * conversation cannot have a hole in the middle of it.
 *
 * The composer follows the boundary. The reference's restore mutation is
 * `if (next) { promptSession.set(draft(next.id)); return; } promptSession.reset()`
 * (main-8t-QUXax.js @5579079): the box always holds the message sitting on the
 * boundary, and holds nothing once there is no boundary left. The message is
 * looked up in the store rather than taken from `items`, because a row carries
 * only the flattened one-line summary - putting that in the box would hand back
 * a whitespace-collapsed sentence with `[image:...]` written into it.
 */
async function restore(id: string) {
  const sessionID = app.currentID
  if (!sessionID || busy.value) return
  const at = items.value.findIndex((item) => item.id === id)
  if (at < 0) return
  busy.value = true
  const next = app.rolledBack[at + 1]
  try {
    await app.revert(sessionID, next?.id)
    restoreDraft(next)
  } catch (failure) {
    /*
     * The server refuses a move it cannot make the files follow - a turn still
     * running, a snapshot that never recorded - and says why in a sentence. It
     * has to be shown: the refusal leaves the dock exactly as it was, so
     * without it the button simply appears not to work.
     */
    notifyFailure(t("common.requestFailed"), failure instanceof Error ? failure.message : String(failure))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <!-- Named the way the reference names it, which is the one handle anything
       driving the interface from outside has on a box whose class names it
       shares with the todo dock beside it. -->
  <div v-if="items.length" class="dock" data-component="session-revert-dock" :class="{ open }">
    <button class="head" :aria-expanded="open" @click="open = !open">
      <!--
        The reference's own reset mark: an arrow turning back into the box it
        came out of, which is the shape it uses everywhere a rollback is meant.
      -->
      <svg class="mark" width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path
          d="M5.83333 4.16406L2.5 7.4974L5.83333 10.8307M3.33333 7.4974H17.9167V15.4141H10"
          stroke="currentColor"
          stroke-width="1.2"
          stroke-linecap="square"
        />
      </svg>
      <span class="summary">{{
        t(items.length === 1 ? "revert.summary.one" : "revert.summary.other", { n: items.length })
      }}</span>
      <span v-if="!open" class="preview">{{ items[0].text }}</span>
      <span class="caret" :aria-label="open ? t('revert.collapse') : t('revert.expand')">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
        </svg>
      </span>
    </button>

    <ul v-if="open" class="list">
      <li v-for="item in items" :key="item.id">
        <span class="text">{{ item.text }}</span>
        <button class="restore" :disabled="busy" @click="restore(item.id)">{{ t("revert.restore") }}</button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.dock {
  /*
   * Exactly the composer's box, so the two read as one stack rather than as a
   * panel with a narrower box under it.
   *
   * The composer holds its own 24px inset and then caps its contents at 776px,
   * and both halves of that have to be copied: the inset alone leaves the dock
   * wider than the box on a wide window, and the cap alone leaves it 24px
   * proud on either side of a narrow one. Measured at 8..517 against a box of
   * 32..493 before this was here.
   */
  width: calc(100% - 48px);
  max-width: 776px;
  margin: 0 auto 6px;
  background: var(--surface-raised);
  border: 1px solid var(--border-weaker);
  border-radius: 10px;
  overflow: hidden;
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  text-align: start;
}

.head:hover {
  background: var(--surface-hover);
}

.mark {
  flex-shrink: 0;
  color: var(--icon-weak);
}

/* Mirrored for Arabic: the arrow points back the way the reader came, which is
   the other way round when the reading direction is. */
[dir="rtl"] .mark {
  transform: scaleX(-1);
}

.summary {
  flex-shrink: 0;
  color: var(--text-weaker);
  font-size: 11.5px;
  font-weight: 440;
}

/* The first message that is out, when the list itself is not showing. */
.preview {
  overflow: hidden;
  color: var(--text-base);
  font-size: 12.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.caret {
  display: flex;
  flex-shrink: 0;
  margin-inline-start: auto;
  color: var(--icon-weak);
  transition: transform 0.15s ease-in-out;
}

[dir="rtl"] .caret {
  transform: rotate(180deg);
}

.dock.open .caret {
  transform: rotate(90deg);
}

.list {
  max-height: 180px;
  padding: 2px 12px 10px;
  overflow-y: auto;
  list-style: none;
}

.list li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
}

.list .text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--text-base);
  font-size: 12.5px;
  line-height: 17px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.restore {
  flex-shrink: 0;
  padding: 3px 8px;
  color: var(--text-base);
  font-size: 11.5px;
  background: var(--button-neutral);
  border: 1px solid var(--border-weaker);
  border-radius: 6px;
}

.restore:hover:not(:disabled) {
  background: var(--surface-hover);
}

.restore:disabled {
  opacity: 0.5;
}
</style>
