<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"
import { mcpNeedsSignIn, mcpStatusLabel } from "../lib/mcp-status"

/**
 * What the title bar's server control opens.
 *
 * The button carries a server icon and a status light, so it has to lead
 * somewhere about the runtime rather than into general settings.
 *
 * opencode puts four tabs here - servers, MCP, LSP and plugins. MCode has no
 * language servers and no plugin system, and a tab whose only content is "not
 * supported" is worse than no tab, so those two are left out. MCP is real and
 * was missing from the one place that reports on the runtime: a server that
 * failed to start said so only inside a dialog nobody had a reason to open.
 */
const emit = defineEmits<{ close: []; manage: [] }>()

const app = useApp()

const root = ref<HTMLElement>()

/**
 * The address in use, or nothing when this is the backend the app started.
 *
 * Read from the config rather than from the socket because the socket reports
 * only whether it is up, not what it reached.
 */
const remote = computed(() => app.config?.serverURL?.trim() || "")

/** The saved servers, which the heading counts and the body now lists. */
const servers = computed(() => app.config?.servers ?? [])

/** One for the local backend, plus each saved server, plus an unsaved address. */
const shownCount = computed(
  () => 1 + servers.value.length + (remote.value && !servers.value.some((entry) => entry.url === remote.value) ? 1 : 0),
)

const tab = ref<"servers" | "mcp">("servers")

const mcp = computed(() => app.mcpServers)
const mcpConnected = computed(() => mcp.value.filter((entry) => entry.status === "connected").length)

/** Held while a server is connecting, which takes long enough to see. */
const busy = ref<string>()

/** Which light a server's state deserves, in the reference's own grading. */
function mcpTone(status: string): string {
  if (status === "connected") return ""
  if (mcpNeedsSignIn(status)) return "attention"
  if (status === "failed") return "off"
  return "idle"
}

async function toggleMcp(name: string) {
  if (busy.value) return
  busy.value = name
  try {
    const result = await app.client?.request({ type: "mcp.toggle", name })
    if (result) app.mcpServers = result.servers
  } finally {
    busy.value = undefined
  }
}

function onPointerDown(event: MouseEvent) {
  const target = event.target as HTMLElement | null
  if (root.value?.contains(target)) return
  // The trigger lives outside this component, so closing on its mousedown just
  // let its own click reopen the panel - it could never be dismissed by it.
  if (target?.closest?.(".server-trigger")) return
  emit("close")
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") emit("close")
}

onMounted(() => {
  window.addEventListener("mousedown", onPointerDown, true)
  window.addEventListener("keydown", onKeydown)
  // Asked again on open: a server can have been added or have failed since the
  // list was last fetched, and this panel is where that is reported.
  void app.loadMcp()
})
onBeforeUnmount(() => {
  window.removeEventListener("mousedown", onPointerDown, true)
  window.removeEventListener("keydown", onKeydown)
})
</script>

<template>
  <div ref="root" class="pop">
    <!--
      Two tabs, because there are two things running that can be wrong. The
      count stays on the servers tab, where it was, rather than being dropped
      to make room for the strip.
    -->
    <div class="tabs" role="tablist">
      <button
        class="tab"
        :class="{ on: tab === 'servers' }"
        role="tab"
        :aria-selected="tab === 'servers'"
        @click="tab = 'servers'"
      >
        {{ t("srv.serversTab", { n: String(shownCount) }) }}
      </button>
      <button
        class="tab"
        :class="{ on: tab === 'mcp' }"
        role="tab"
        :aria-selected="tab === 'mcp'"
        @click="tab = 'mcp'"
      >
        {{ t("mcp.enabledCount", { enabled: String(mcpConnected), total: String(mcp.length) }) }}
      </button>
    </div>

    <div v-if="tab === 'mcp'" class="body">
      <p v-if="!mcp.length" class="none">{{ t("mcp.empty") }}</p>
      <button
        v-for="entry in mcp"
        :key="entry.name"
        class="row mcp-row"
        role="switch"
        :aria-checked="entry.status === 'connected'"
        :disabled="busy === entry.name || entry.status === 'pending'"
        @click="toggleMcp(entry.name)"
      >
        <span class="dot" :class="mcpTone(entry.status)" />
        <span class="name">{{ entry.name }}</span>
        <span class="meta">{{ t(`mcp.status.${mcpStatusLabel(entry.status)}`) }}</span>
        <!-- Drawn only: the row is the switch, so nothing interactive sits inside a button. -->
        <span class="switch" :class="{ on: entry.status === 'connected' }" aria-hidden="true">
          <span class="knob" />
        </span>
      </button>
    </div>

    <div v-else class="body">
      <!-- The backend this app started, which is always here. -->
      <div class="row">
        <span class="dot" :class="{ off: !app.connected && !remote, idle: Boolean(remote) }" />
        <span class="name">{{ t("srv.localServer") }}</span>
        <span class="meta">{{ `127.0.0.1:${app.port || "-"}` }}</span>
        <svg v-if="app.connected && !remote" class="tick" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.5 6.4 4.7 8.6 9.5 3.8" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" />
        </svg>
      </div>

      <!--
        And every server that has been saved. The heading counts them, so
        listing only the one in use made the count disagree with what is under
        it - two servers configured, one row, "2 servers" above it.
      -->
      <div v-for="entry in servers" :key="entry.id" class="row">
        <span
          class="dot"
          :class="{ off: !app.connected && remote === entry.url, idle: remote !== entry.url }"
        />
        <span class="name">{{ entry.name.trim() || t("srv.remoteServer") }}</span>
        <span class="meta">{{ entry.url }}</span>
        <svg
          v-if="app.connected && remote === entry.url"
          class="tick"
          width="12"
          height="12"
          viewBox="0 0 12 12"
          aria-hidden="true"
        >
          <path d="M2.5 6.4 4.7 8.6 9.5 3.8" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" />
        </svg>
      </div>

      <!--
        An address typed once and never saved is still the thing being talked
        to, so it gets a row of its own rather than disappearing from a list of
        servers while being the server.
      -->
      <div v-if="remote && !servers.some((entry) => entry.url === remote)" class="row">
        <span class="dot" :class="{ off: !app.connected }" />
        <span class="name">{{ t("srv.remoteServer") }}</span>
        <span class="meta">{{ remote }}</span>
        <svg v-if="app.connected" class="tick" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.5 6.4 4.7 8.6 9.5 3.8" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" />
        </svg>
      </div>

      <button class="manage" @click="emit('manage')">{{ t("srv.manage") }}</button>
    </div>
  </div>
</template>

<style scoped>
.pop {
  /* Fixed rather than absolute: it is rendered at the app root, where there is
     no positioned ancestor to hang a percentage offset from. */
  position: fixed;
  top: calc(var(--titlebar-height) + 4px);
  /* Hung from the end of the bar, which is the end its trigger is parked at -
     pinned to a fixed side it would open a window's width from the button. */
  inset-inline-end: 10px;
  z-index: 60;
  box-sizing: border-box;
  width: 320px;
  /*
   * MiMo's list popover (X1): a 12px corner on a 1px line with the menu
   * shadow, the frame the servers dialog's row menu already wears. Clipped to
   * the padding box so the fill cannot bleed through the line.
   */
  background: var(--surface-menu);
  background-clip: padding-box;
  border: 1px solid var(--border-weak);
  border-radius: 12px;
  box-shadow: var(--shadow-lg);
  overflow: hidden;
  animation: pop-open 0.15s ease-out;
}

@keyframes pop-open {
  from {
    opacity: 0;
    transform: scale(0.97) translateY(-4px);
  }

  to {
    opacity: 1;
    transform: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .pop {
    animation: none;
  }
}

.body {
  padding: 12px 14px 14px;
}

.row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 4px 0;
}

.dot {
  width: 7px;
  height: 7px;
  background: var(--success);
  border-radius: 50%;
}

.dot.off {
  background: var(--error);
}

/*
 * Not connected to, as opposed to failing. Red on every row but one said the
 * other servers were broken, when the only thing true of them is that this
 * window is talking to a different one.
 */
.dot.idle {
  background: var(--icon-weaker);
}

/* Waiting on the user rather than failing: a sign-in, not a fault. */
.dot.attention {
  background: var(--accent);
}

.none {
  padding: 4px 0 2px;
  color: var(--text-weaker);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.tabs {
  display: flex;
  gap: 2px;
  padding: 8px 10px 0;
  border-bottom: 1px solid var(--border-weaker);
}

.tab {
  padding: 6px 8px 8px;
  color: var(--text-weaker);
  font-size: calc(12.5px * var(--ui-font-scale, 1));
  /* The underline is the selected mark, so it has to sit on the strip's own
     rule rather than above it. */
  border-bottom: 1.5px solid transparent;
  margin-bottom: -1px;
}

.tab:hover {
  color: var(--text-base);
}

.tab.on {
  color: var(--text-strong);
  border-bottom-color: var(--text-strong);
}

.mcp-row {
  width: 100%;
  padding: 5px 4px;
  text-align: start;
  border-radius: 5px;
}

.mcp-row:hover:not(:disabled) {
  background: var(--surface-hover);
}

.mcp-row:disabled {
  opacity: 0.55;
}

.switch {
  position: relative;
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  width: 26px;
  height: 15px;
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: 3px;
}

.switch.on {
  box-sizing: border-box;
  background-color: var(--icon-base);
  border-color: var(--icon-base);
}

/* Off is the end the track begins at, so the knob travels the way the row is
   read rather than always rightwards. */
.knob {
  position: absolute;
  top: 0;
  box-sizing: content-box;
  width: 13px;
  height: 13px;
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: 2px;
  inset-inline-start: -1px;
  transition: inset-inline-start 0.15s;
}

.switch.on .knob {
  background-color: var(--surface-base);
  border: none;
  inset-inline-start: 11px;
}

.name {
  color: var(--text-strong);
  font-size: calc(13.5px * var(--ui-font-scale, 1));
}

.meta {
  flex: 1;
  color: var(--text-weaker);
  font-family: var(--font-mono);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.tick {
  color: var(--text-base);
}

.manage {
  margin-top: 10px;
  height: 30px;
  padding: 0 14px;
  color: var(--text-strong);
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: var(--radius-md);
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.manage:hover {
  border-color: var(--border-strong);
}
</style>
