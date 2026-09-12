<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import type { McpServerState } from "@shared/protocol"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"

const emit = defineEmits<{ close: [] }>()
const app = useApp()

const servers = ref<McpServerState[]>([])
const query = ref("")
const busy = ref<string>()
const field = ref<HTMLInputElement>()

/*
 * A server counts as enabled when it is actually connected. "Configured and
 * switched on but failing" is not enabled in any sense the user cares about,
 * and the count at the top is the one place that distinction shows.
 */
const connected = computed(() => servers.value.filter((entry) => entry.status === "connected").length)

const shown = computed(() => {
  const needle = query.value.trim().toLowerCase()
  const rows = [...servers.value].sort((a, b) => a.name.localeCompare(b.name))
  if (!needle) return rows
  return rows.filter(
    (entry) =>
      entry.name.toLowerCase().includes(needle) || entry.status.toLowerCase().includes(needle),
  )
})

async function load() {
  const result = await app.client?.request({ type: "mcp.list" })
  if (result) servers.value = result.servers
}

/**
 * Flips a server, and holds the row while the connection is made.
 *
 * Connecting means spawning a process and waiting for a handshake, which is
 * slow enough to see - so the switch is disabled rather than left looking
 * ignored, and the list is re-read once the answer is in.
 */
async function toggle(name: string) {
  if (busy.value) return
  busy.value = name
  try {
    const result = await app.client?.request({ type: "mcp.toggle", name })
    if (result) servers.value = result.servers
  } finally {
    busy.value = undefined
  }
}

onMounted(() => {
  void load()
  field.value?.focus()
  // Status arrives on its own as each server answers, so the dialog follows
  // the bus rather than polling for the handshake to finish.
  const off = app.client?.on((event) => {
    if (event.type === "mcp.status") servers.value = event.servers
  })
  return off
})
</script>

<template>
  <div class="scrim" @mousedown.self="emit('close')">
    <div v-modal class="dialog" @keydown.escape="emit('close')">
      <header class="bar">
        <div class="head">
          <h2 class="title">{{ t("mcp.title") }}</h2>
          <p class="lead">
            {{ t("mcp.enabledCount", { enabled: String(connected), total: String(servers.length) }) }}
          </p>
        </div>
        <span class="gap" />
        <button class="icon" v-tip="{ label: t('common.close'), placement: 'bottom' }" @click="emit('close')">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
        </button>
      </header>

      <div class="search">
        <input
          ref="field"
          v-model="query"
          class="field"
          :placeholder="t('common.search')"
          spellcheck="false"
        />
      </div>

      <div class="list">
        <p v-if="!shown.length" class="empty">{{ t("mcp.empty") }}</p>

        <button
          v-for="entry in shown"
          :key="entry.name"
          class="row"
          :disabled="busy === entry.name || entry.status === 'pending'"
          @click="toggle(entry.name)"
        >
          <span class="text">
            <span class="name-line">
              <span class="name">{{ entry.name }}</span>
              <span class="status">{{ t(`mcp.status.${entry.status}`) }}</span>
            </span>
            <span v-if="entry.error" class="why">{{ entry.error }}</span>
          </span>
          <span
            class="switch"
            :class="{ on: entry.status === 'connected' }"
            role="switch"
            :aria-checked="entry.status === 'connected'"
          >
            <span class="knob" />
          </span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/*
 * Scoped styles cannot be shared, so a dialog that leaves this out gets no
 * overlay at all: it becomes a plain block in the document flow, sitting
 * wherever it was mounted with nothing dimmed behind it. This one had.
 */
.scrim {
  position: fixed;
  inset: 0;
  z-index: 130;
  display: grid;
  place-items: center;
  background: var(--scrim);
}

.dialog {
  display: flex;
  flex-direction: column;
  width: min(520px, 92vw);
  max-height: 70vh;
}

.bar {
  display: flex;
  flex-shrink: 0;
  flex-direction: row;
  align-items: flex-start;
  gap: 0;
  width: 100%;
  padding: 16px;
}

.head {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: flex-start;
  gap: 0;
  min-width: 0;
}

.title {
  margin: 0;
  color: var(--text-strong);
  font-size: calc(15px * var(--ui-font-scale, 1));
  font-weight: 530;
  line-height: 20px;
  letter-spacing: -0.13px;
}

.lead {
  margin-top: 4px;
  color: var(--text-base);
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 440;
  line-height: 20px;
  letter-spacing: -0.04px;
}

.gap {
  flex: 1;
}

/* Twenty square, pulled two pixels out of the header's padding so the glyph
   lines up with the title rather than the button's box doing. */
.icon {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-top: -2px;
  margin-inline-start: auto;
  margin-inline-end: -2px;
  color: var(--icon-weak);
  border-radius: 4px;
}

.icon:hover {
  background: var(--surface-hover);
}

.search {
  padding: 0 12px 8px;
}

.list {
  padding: 0 12px 12px;
  overflow-y: auto;
}

.empty {
  display: flex;
  align-items: center;
  height: 48px;
  padding: 0 12px;
  color: var(--text-weak);
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 8px 12px;
  text-align: start;
  border-radius: 6px;
}

.row:hover:not(:disabled) {
  background: var(--surface-hover);
}

.row:disabled {
  opacity: 0.5;
}

.text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.name-line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.name {
  overflow: hidden;
  color: var(--text-strong);
  font-size: calc(13px * var(--ui-font-scale, 1));
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The status and the reason share one weight: neither is the headline, and
   making the error louder would put a red stripe down a list of settings. */
.status,
.why {
  color: var(--text-weaker);
  font-size: calc(11px * var(--ui-font-scale, 1));
  font-weight: 440;
}

.why {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.switch {
  position: relative;
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  width: 28px;
  height: 16px;
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: 3px;
  transition: background-color 0.15s, border-color 0.15s;
}

.switch.on {
  box-sizing: border-box;
  background-color: var(--icon-base);
  border-color: var(--icon-base);
}

/*
 * Off is the end the track begins at and on is the end it finishes at, so the
 * knob travels the way the row is read rather than always rightwards.
 */
.knob {
  position: absolute;
  top: 0;
  box-sizing: content-box;
  width: 14px;
  height: 14px;
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: 2px;
  /* Sat over the track's own border, so the two edges read as one. */
  inset-inline-start: -1px;
  transition: inset-inline-start 0.15s, background-color 0.15s;
}

.switch.on .knob {
  background-color: var(--surface-base);
  border: none;
  inset-inline-start: 12px;
}
</style>
