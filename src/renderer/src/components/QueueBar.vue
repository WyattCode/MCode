<script setup lang="ts">
/**
 * OpenCode v2's queued follow-ups, above the composer.
 *
 * Messages sent with 排队 while a turn ran wait here, oldest first, and go out
 * one at a time as turns of their own once it ends. After Stop or a failure
 * they stay until the reader acts. Each can be sent now - into the running
 * turn, or as a new one when nothing runs - or taken back into the box.
 *
 * MiMo has no queue; the row is drawn as its goal bar is, so it sits in the
 * same place and the same way.
 */
import { computed, onBeforeUnmount } from "vue"
import type { QueuedPrompt, SessionInfo } from "@shared/protocol"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"

const props = defineProps<{ sessionID: string }>()
const emit = defineEmits<{ edit: [item: QueuedPrompt, sessionID: string] }>()
const app = useApp()

const session = computed(() => app.sessions.find((entry: SessionInfo) => entry.id === props.sessionID) ?? app.sideSessionOf(props.sessionID))
const queued = computed(() => session.value?.queued ?? [])
const running = computed(() => app.running.has(props.sessionID))

/** The line a queued message shows: its words, or what it carries when it has none. */
function line(item: QueuedPrompt): string {
  const words = item.text.replace(/\s+/g, " ").trim()
  if (words) return words
  return t("composer.queue.attachments", { count: item.attachments?.length ?? 0 })
}

/*
 * Composer stays mounted across conversation switches; this bar is keyed per
 * session and remounts. A 撤回 that finishes after the switch must not paste
 * into the draft now on screen — remove still targets the held session, and
 * restore only while this instance is alive and Composer still owns it.
 */
let alive = true
onBeforeUnmount(() => {
  alive = false
})

async function edit(item: QueuedPrompt) {
  const held = props.sessionID
  if (!(await app.removeQueued(held, item.id))) return
  if (!alive || props.sessionID !== held) return
  emit("edit", item, held)
}
</script>

<template>
  <div v-if="queued.length" class="queue-bar" data-queue-bar>
    <div class="queue-head">
      <svg class="queue-mark" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>
      <span class="queue-title" data-queue-count>{{ t("composer.queue.title", { count: queued.length }) }}</span>
      <span class="queue-note">{{ running ? t("composer.queue.afterTurn") : t("composer.queue.parked") }}</span>
    </div>
    <div class="queue-scroll">
      <div v-for="item in queued" :key="item.id" class="queue-item" data-queue-item>
        <span class="queue-text" :title="item.text">{{ line(item) }}</span>
        <button class="queue-act" type="button" data-queue-edit v-tip="{ label: t('composer.queue.edit'), placement: 'top' }" @click="edit(item)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
        </button>
        <button
          class="queue-act"
          type="button"
          data-queue-send
          v-tip="{ label: running ? t('composer.queue.steer') : t('composer.queue.sendNow'), placement: 'top' }"
          @click="app.sendQueued(props.sessionID, item.id)"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-7 7 7-7 7 7" /></svg>
        </button>
        <button class="queue-act" type="button" data-queue-remove v-tip="{ label: t('composer.queue.remove'), placement: 'top' }" @click="app.removeQueued(props.sessionID, item.id)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* The goal bar's frame: the composer's own width, a 10px corner, and 12 either side. */
.queue-bar {
  width: 100%;
  margin-bottom: 6px;
  padding: 4px 12px;
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 10px;
}

.queue-head {
  display: flex;
  gap: 8px;
  align-items: center;
  padding-block: 4px;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.queue-mark {
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--text-interactive);
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.queue-title {
  color: var(--text-strong);
  font-weight: 500;
}

.queue-note {
  overflow: hidden;
  color: var(--text-weak);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* A long queue scrolls rather than pushing the composer up the window. */
.queue-scroll {
  overflow-y: auto;
  max-height: 132px;
}

.queue-item {
  display: flex;
  gap: 4px;
  align-items: center;
  padding: 3px 0 3px 22px;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.queue-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--text-base);
  line-height: calc(18px * var(--ui-font-scale, 1));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue-act {
  display: grid;
  flex: none;
  place-items: center;
  width: 20px;
  height: 20px;
  padding: 0;
  color: var(--text-weak);
  background: transparent;
  border: 0;
  border-radius: 6px;
  cursor: pointer;
}

.queue-act:hover {
  color: var(--text-strong);
  background: var(--surface-selected);
}

.queue-act:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: 1px;
}

.queue-act svg {
  width: 13px;
  height: 13px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
