<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from "vue"
import { useApp } from "../../stores/app"
import { t } from "../../lib/i18n"
import { shouldRespawn, showMismatch } from "../../lib/terminal"

/**
 * MiMo's terminal tab: one shell, in the conversation's project, with the
 * notice MiMo puts above it when a shell someone has typed into is no longer in
 * the folder the conversation works in - leave it, or open a terminal that is.
 * A shell nobody has touched is started again in the right folder instead.
 *
 * The shell outlives the tab being hidden or the conversation being left; it
 * ends when the tab is closed. Whether anything was typed into it is reported
 * so that closing it can ask first, and that stays true after the shell exits.
 */
const props = defineProps<{
  active: boolean
  shellID?: string
  /** Where the shell started, kept on the tab so a shell attached again still knows. */
  cwd?: string
  sessionID?: string
  directory?: string
}>()
const emit = defineEmits<{ opened: [shellID: string, cwd: string]; used: []; openNew: [] }>()

const app = useApp()

/*
 * Fetched when a terminal tab is first shown, for the same reason the drawer is
 * (see App.vue): this is the panel's own path to the terminal, and while it was
 * a plain import the entry chunk still carried xterm however the drawer was
 * loaded - the panel is always built into the shell, so a static import here
 * pulled xterm in with it. The pane is used only in this template, so nothing
 * holds an instance of it that an async wrapper would hide.
 */
const TerminalPane = defineAsyncComponent(() => import("../TerminalPane.vue"))

const cwd = ref<string | undefined>(props.cwd)
/* The shell the pane shows, which a restart replaces before the tab hears of it. */
const shell = ref<string | undefined>(props.shellID)
const used = ref(false)
/* Bumped to remount the pane when an untouched shell starts again elsewhere. */
const pane = ref(0)
const dismissed = ref(false)

const mismatch = computed(() => !dismissed.value && showMismatch(cwd.value, props.directory, used.value))

function opened(shellID: string, where: string) {
  shell.value = shellID
  cwd.value = where
  emit("opened", shellID, where)
}

function markUsed() {
  used.value = true
  emit("used")
}

/* MiMo's JAe: an unused shell in another folder is ended and opened again here, without a word. */
function respawn() {
  if (!shouldRespawn(cwd.value, props.directory, used.value)) return
  if (shell.value) void app.client?.request({ type: "shell.close", shellID: shell.value })
  shell.value = undefined
  cwd.value = undefined
  pane.value += 1
}

/* A new workspace asks afresh: the notice's dismissal was for the old one. */
watch(
  () => props.directory,
  () => {
    dismissed.value = false
    respawn()
  },
)
</script>

<template>
  <div class="rp-term" data-rp-terminal>
    <div v-if="mismatch" class="mismatch" role="status">
      <span class="mismatch-msg">{{ t("term.mismatch") }}</span>
      <button type="button" class="mismatch-btn" @click="dismissed = true">{{ t("ui.common.dismiss") }}</button>
      <button type="button" class="mismatch-btn primary" @click="emit('openNew')">{{ t("term.mismatchOpenNew") }}</button>
    </div>
    <TerminalPane
      :key="pane"
      :active="active"
      :height="0"
      :shellID="shell"
      surface="panel"
      :sessionID="sessionID"
      :directory="sessionID ? undefined : directory"
      @opened="opened"
      @used="markUsed"
      @attached="respawn"
    />
  </div>
</template>

<style scoped>
/* MiMo's column: no fill of its own - the page colour is on the host inside it. */
.rp-term {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.rp-term :deep(.term),
.rp-term :deep(.term-host) {
  background: var(--surface-raised);
}

/* MiMo's notice: a bordered strip above the terminal, the new-terminal button filled. */
.mismatch {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  margin: 6px 8px 0;
  padding: 6px 10px;
  color: var(--text-body);
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.mismatch-msg {
  flex: 1 1 0;
  min-width: 0;
}

.mismatch-btn {
  flex: 0 0 auto;
  padding: 2px 10px;
  color: var(--text-body);
  background: none;
  border: 1px solid var(--border-weak);
  border-radius: 6px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  cursor: pointer;
}

.mismatch-btn:hover {
  opacity: 0.85;
}
.mismatch-btn:focus-visible {
  outline: 2px solid var(--text-interactive);
  outline-offset: 2px;
}

/* MiMo's primary pill: the txt ink filled, its label the page colour. */
.mismatch-btn.primary {
  color: #fffefd;
  background: #151c13cc;
  border-color: transparent;
}

/* MiMo's --color-txt is the fill of the button that carries the turn, not a translucent white. */
:root[data-theme="dark"] .mismatch-btn.primary {
  color: #181818;
  background: #f4f4f5;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .mismatch-btn.primary {
    color: #181818;
    background: #f4f4f5;
  }
}
</style>
