<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue"
import type { QueuedPrompt, SessionInfo } from "@shared/protocol"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"
import ConfirmDialog from "./ConfirmDialog.vue"

const props = defineProps<{ sessionID: string }>()
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

const paused = computed(() => Boolean(session.value?.queuePaused))
const sending = computed(() => app.queueSending.get(props.sessionID))
const editing = ref<string>()
const editor = ref<HTMLTextAreaElement[]>()
const draft = ref("")
const pending = ref(false)
const showParked = ref(false)
watch(running, (active) => { if (active) showParked.value = false })
const showCards = computed(() => running.value || !!sending.value || paused.value || !!editing.value || showParked.value)
let alive = true

onBeforeUnmount(() => {
  alive = false
  if (editing.value) void app.editQueued(props.sessionID, editing.value, { action: "cancel" })
})

async function edit(item: QueuedPrompt) {
  if (pending.value || editing.value) return
  pending.value = true
  try {
    if (!(await app.editQueued(props.sessionID, item.id, { action: "start" }))) return
    if (!alive) {
      await app.editQueued(props.sessionID, item.id, { action: "cancel" })
      return
    }
    editing.value = item.id
    draft.value = item.text
    await nextTick()
    editor.value?.[0]?.focus()
  } finally {
    pending.value = false
  }
}

async function finishEdit(save: boolean) {
  const id = editing.value
  if (!id || pending.value) return
  pending.value = true
  try {
    const ok = await app.editQueued(props.sessionID, id, save ? { action: "save", text: draft.value } : { action: "cancel" })
    if (ok || !save) editing.value = undefined
  } finally {
    pending.value = false
  }
}

function editKeys(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return
  if (event.key !== "Escape") return
  event.stopPropagation()
  event.preventDefault()
  void finishEdit(false)
}

/* Clearing is asked first: it cannot be taken back, and sits beside the small remove marks. */
const confirmingClear = ref(false)

/** Clear every waiting message at once, when more than one is queued and nothing runs. */
async function clearAll() {
  confirmingClear.value = false
  const held = props.sessionID
  for (const item of [...queued.value]) {
    // Leaving mid-clear must not aim the rest of this conversation's ids at another one.
    if (!alive || props.sessionID !== held) return
    if (!(await app.removeQueued(held, item.id))) return
  }
}
</script>

<template>
  <button v-if="queued.length && !showCards" class="queue-clear parked-toggle" type="button" aria-expanded="false" @click="showParked = true">
    {{ t("composer.queue.title", { count: queued.length }) }}
  </button>
  <div v-else-if="queued.length" class="queue-bar" data-queue-bar>
    <div class="queue-head">
      <svg class="queue-mark" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>
      <span class="queue-title" data-queue-count>{{ t("composer.queue.title", { count: queued.length }) }}</span>
      <span v-if="paused" class="queue-note" role="status">{{ t("composer.queue.paused") }}</span>
      <span v-else-if="!running && !sending && !editing" class="queue-note">{{ t("composer.queue.parked") }}</span>
      <button v-if="paused" class="queue-clear" type="button" :disabled="!!sending || !!editing" @click="app.sendQueued(sessionID, queued[0].id, 'send')">
        {{ t("composer.queue.sendNow") }}
      </button>
      <button v-if="showParked && !running && !paused && !sending && !editing" class="queue-act" type="button" aria-expanded="true" :aria-label="t('common.close')" @click="showParked = false">×</button>
      <button v-if="!running && queued.length > 1 && !sending && !editing" class="queue-clear" type="button" data-queue-clear @click="confirmingClear = true">{{ t("composer.queue.clearAll") }}</button>
    </div>
    <div class="queue-scroll">
      <div v-for="item in queued" :key="item.id" class="queue-item" :class="{ editing: editing === item.id }" data-queue-item>
        <template v-if="editing === item.id">
          <label class="queue-editor-label">
            <span>{{ t("composer.queue.editing") }}{{ t("composer.queue.draft") }}</span>
            <textarea ref="editor" v-model="draft" rows="2" @keydown="editKeys" />
          </label>
          <div class="queue-editor-actions">
            <button class="queue-act" type="button" :disabled="pending" @click="finishEdit(false)">{{ t("composer.queue.cancelEdit") }}</button>
            <button class="queue-act" type="button" :disabled="pending" @click="finishEdit(true)">{{ t("common.save") }}</button>
          </div>
        </template>
        <template v-else>
          <span class="queue-text" :title="item.text">{{ line(item) }}</span>
          <span v-if="sending === item.id" class="queue-note" role="status">{{ t("composer.queue.sending") }}</span>
          <template v-else>
            <button class="queue-act" type="button" data-queue-edit :disabled="pending || !!editing" @click="edit(item)">{{ t("composer.queue.edit") }}</button>
            <button class="queue-act" type="button" data-queue-remove @click="app.removeQueued(sessionID, item.id)">{{ t("composer.queue.remove") }}</button>
            <button v-if="running" class="queue-act" type="button" data-queue-steer :disabled="!!sending" @click="app.sendQueued(sessionID, item.id, 'steer')">{{ t("composer.queue.steer") }}</button>
            <button class="queue-act" type="button" data-queue-send :disabled="!!sending" @click="app.sendQueued(sessionID, item.id, 'send')">{{ t("composer.queue.sendNow") }}</button>
          </template>
        </template>
      </div>
    </div>
    <Teleport to="body">
      <ConfirmDialog
        v-if="confirmingClear"
        :title="t('composer.queue.clearTitle')"
        :body="t('composer.queue.clearBody', { count: queued.length })"
        :confirm-label="t('composer.queue.clearAll')"
        @confirm="clearAll"
        @close="confirmingClear = false"
      />
    </Teleport>
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
  color: var(--text-weak);
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
  border-top: 1px solid var(--border-weak);
  flex-wrap: wrap;
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
  flex: none;
  min-height: 24px;
  padding: 2px 5px;
  font: inherit;
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

.queue-act:disabled,
.queue-clear:disabled {
  opacity: 0.5;
  cursor: default;
}

.queue-item.editing,
.queue-editor-label {
  display: grid;
  gap: 4px;
}

.queue-editor-label textarea {
  resize: vertical;
  width: 100%;
  padding: 6px;
  border: 1px solid var(--border-weak);
  border-radius: 6px;
  background: var(--surface-base);
  color: var(--text-base);
  font: inherit;
}

.queue-editor-actions {
  display: flex;
  justify-content: flex-end;
  gap: 4px;
}

.queue-clear {
  flex: none;
  margin-inline-start: auto;
  padding: 0 8px;
  min-height: calc(24px * var(--ui-font-scale, 1));
  color: var(--text-weak);
  background: transparent;
  border: 0;
  border-radius: 6px;
  cursor: pointer;
  font: inherit;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.parked-toggle {
  margin: 0 0 4px;
}

.queue-clear:hover {
  color: var(--text-strong);
  background: var(--surface-selected);
}

.queue-clear:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: 1px;
}

</style>
