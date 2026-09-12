<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue"
import type { McpServerState } from "@shared/protocol"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"
import { notifyFailure } from "../lib/toast"

/**
 * The plugins page, laid out from MiMo's: a 900 column with a 24/500 title, a
 * line under it, a search field, and an Installed section whose right end
 * offers Manage.
 *
 * MiMo follows that with a catalogue - Featured, Productivity - of things to
 * install with one press. There is no catalogue here: this app's plugins are
 * the MCP servers the user has configured, and a shop front with nothing
 * behind it would be a picture of a feature rather than the feature. So the
 * page stops where the real data stops, and Manage opens the place servers
 * are actually added.
 */
const app = useApp()
const emit = defineEmits<{ manage: [] }>()

const servers = ref<McpServerState[]>([])
const loaded = ref(false)
const query = ref("")

const shown = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase()
  if (!needle) return servers.value
  return servers.value.filter((entry) => entry.name.toLocaleLowerCase().includes(needle))
})

let off: (() => void) | undefined

onMounted(async () => {
  /*
   * A server answers in its own time, and the answer arrives as an event
   * rather than in the reply to the list. Without this the page would show
   * whatever was true the moment it opened - every server stuck at "pending",
   * and a switch pressed here never seen to take.
   */
  off = app.client?.on((event) => {
    if (event.type === "mcp.status") servers.value = event.servers
  })
  const result = await app.client?.request({ type: "mcp.list" }).catch(() => undefined)
  servers.value = result?.servers ?? []
  loaded.value = true
})

onUnmounted(() => off?.())

/**
 * Off and on again, which is the only switch a server has.
 *
 * Held while the connection is made, as the dialog holds its own: starting a
 * server takes long enough to see, and a switch that can be pressed again in
 * that gap sends a second toggle at a server that is still answering the first.
 */
const busy = ref("")

async function toggle(name: string) {
  busy.value = name
  try {
    const result = await app.client?.request({ type: "mcp.toggle", name })
    if (result) servers.value = result.servers
  } catch (err) {
    notifyFailure(t("mcp.title"), err instanceof Error ? err.message : String(err))
  } finally {
    busy.value = ""
  }
}
</script>

<template>
  <div class="plugins">
    <div class="drag" aria-hidden="true" />
    <div class="column">
      <h1 class="title">{{ t("plugins.title") }}</h1>
      <p class="subtitle">{{ t("plugins.subtitle") }}</p>

      <div class="search">
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="7" cy="7" r="4.3" stroke="currentColor" stroke-width="1.2" />
          <path d="M10.2 10.2 14 14" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
        </svg>
        <input
          v-model="query"
          :placeholder="t('plugins.search')"
          :aria-label="t('plugins.search')"
          spellcheck="false"
          autocomplete="off"
        />
      </div>

      <div class="head">
        <span class="head-label">{{ t("plugins.installed") }}</span>
        <button class="manage" @click="emit('manage')">{{ t("plugins.manage") }}</button>
      </div>

      <div v-if="shown.length" class="cards">
        <div v-for="entry in shown" :key="entry.name" class="card">
          <div class="card-text">
            <span class="card-name">{{ entry.name }}</span>
            <span class="card-note">
              <span v-if="entry.error" class="card-error">{{ entry.error }}</span>
              <template v-else>{{ t("plugins.tools", { n: String(entry.tools) }) }}</template>
            </span>
          </div>
          <span class="card-state">{{ t(`mcp.status.${entry.status}`) }}</span>
          <button
            class="switch"
            :class="{ on: entry.status === 'connected' }"
            role="switch"
            :aria-checked="entry.status === 'connected'"
            :aria-label="entry.name"
            :disabled="busy === entry.name || entry.status === 'pending'"
            @click="toggle(entry.name)"
          >
            <span class="knob" />
          </button>
        </div>
      </div>

      <p v-else-if="loaded" class="empty">{{ t("plugins.none") }}</p>
    </div>
  </div>
</template>

<style scoped>
/*
 * MiMo's plugins page, measured: the column 900 wide, its title 24/500/30 at
 * 55 from the top of the pane, the line under it 13/400/20, the search field
 * a row below, and the section head 14/500/22.4 with its quiet link at the
 * far end. The cards are this app's own: a server is a name, a state and a
 * switch, not a thing to be installed.
 */
.plugins {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scrollbar-gutter: stable both-edges;
}

/* No header on this page, so the top strip is what drags the window. */
.drag {
  position: absolute;
  inset: 0 0 auto;
  height: 44px;
  -webkit-app-region: drag;
}

.column {
  max-width: 900px;
  margin: 0 auto;
  padding: 55px 0 40px;
}

.title {
  margin: 0;
  color: var(--text-strong);
  font-size: 24px;
  font-weight: 500;
  line-height: 30px;
}

.subtitle {
  margin: 4px 0 0;
  color: var(--text-base);
  font-size: 13px;
  font-weight: 400;
  line-height: 20px;
}

.search {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  margin-top: 22px;
  padding: 0 12px;
  color: var(--text-weak);
  background: color-mix(in srgb, var(--text-strong) 4%, var(--surface-raised));
  border: 1px solid color-mix(in srgb, var(--text-strong) 10%, var(--surface-raised));
  border-radius: 10px;
}

.search input {
  flex: 1;
  min-width: 0;
  color: var(--text-strong);
  background: transparent;
  border: 0;
  outline: none;
  font-size: 14px;
  line-height: 22.4px;
}

.search input::placeholder {
  color: var(--text-weak);
}

/* 14/500/22.4 with the link at the far end, as MiMo sets its own. */
.head {
  display: flex;
  align-items: center;
  margin-top: 32px;
}

.head-label {
  color: var(--text-strong);
  font-size: 14px;
  font-weight: 500;
  line-height: 22.4px;
}

.manage {
  margin-inline-start: auto;
  color: var(--text-base);
  font-size: 13px;
  line-height: 17px;
}

.manage:hover {
  color: var(--text-strong);
}

/* Two to a row, as MiMo lays its catalogue out. */
.cards {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px 20px;
  margin-top: 14px;
}

.card {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 14px 16px;
  background: color-mix(in srgb, var(--text-strong) 4%, var(--surface-raised));
  border: 1px solid color-mix(in srgb, var(--text-strong) 10%, var(--surface-raised));
  border-radius: 14px;
}

.card-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.card-name {
  overflow: hidden;
  color: var(--text-strong);
  font-size: 15px;
  font-weight: 500;
  line-height: 21px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-note {
  overflow: hidden;
  color: var(--text-base);
  font-size: 14px;
  line-height: 18.9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-error {
  color: var(--error);
}

.card-state {
  flex-shrink: 0;
  color: var(--text-weak);
  font-size: 12px;
  line-height: 16px;
}

/* The same round switch the settings page uses, so one control reads one way. */
.switch {
  position: relative;
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  width: 32px;
  height: 20px;
  background: color-mix(in srgb, var(--text-strong) 22%, var(--surface-raised));
  border: 0;
  border-radius: 999px;
  transition: background-color 0.15s;
}

.switch.on {
  background: #ececec;
}

.switch:disabled {
  opacity: 0.6;
}

.knob {
  position: absolute;
  top: 2px;
  width: 16px;
  height: 16px;
  background: #ececec;
  border-radius: 50%;
  inset-inline-start: 2px;
  transition: inset-inline-start 0.15s, background-color 0.15s;
}

.switch.on .knob {
  background: #141414;
  inset-inline-start: 14px;
}

.empty {
  margin: 14px 0 0;
  color: var(--text-base);
  font-size: 13px;
  line-height: 20.8px;
}
</style>
