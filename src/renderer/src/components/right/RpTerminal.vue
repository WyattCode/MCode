<script setup lang="ts">
import { computed, ref } from "vue"
import TerminalPane from "../TerminalPane.vue"
import { t } from "../../lib/i18n"

/**
 * MiMo's terminal tab: one shell, in the conversation's project, with the
 * notice MiMo puts above it when the shell's folder is no longer the one the
 * conversation works in - leave it, or open a terminal that is.
 *
 * The shell outlives the tab being hidden or the conversation being left; it
 * ends when the tab is closed. Whether anything was typed into it is reported
 * so that closing it can ask first.
 */
const props = defineProps<{
  active: boolean
  shellID?: string
  /** Where the shell started, kept on the tab so a shell attached again still knows. */
  cwd?: string
  sessionID?: string
  directory?: string
}>()
const emit = defineEmits<{ opened: [shellID: string, cwd: string]; used: []; exited: []; openNew: [] }>()

const cwd = ref<string | undefined>(props.cwd)
const dismissed = ref(false)

function samePlace(a: string, b: string) {
  const plain = (value: string) => {
    const flat = value.replace(/\\/g, "/").replace(/\/+$/, "")
    return /^[a-zA-Z]:/.test(flat) ? flat.toLowerCase() : flat
  }
  return plain(a) === plain(b)
}

const mismatch = computed(() => !dismissed.value && Boolean(cwd.value && props.directory && !samePlace(cwd.value, props.directory)))

function opened(shellID: string, where: string) {
  cwd.value = where
  emit("opened", shellID, where)
}
</script>

<template>
  <div class="rp-term" data-rp-terminal>
    <div v-if="mismatch" class="mismatch" role="status">
      <span class="mismatch-msg">{{ t("term.mismatch") }}</span>
      <button type="button" class="mismatch-btn" @click="dismissed = true">{{ t("ui.common.dismiss") }}</button>
      <button type="button" class="mismatch-btn primary" @click="emit('openNew')">{{ t("term.new") }}</button>
    </div>
    <TerminalPane
      :active="active"
      :height="0"
      :shellID="shellID"
      :sessionID="sessionID"
      :directory="sessionID ? undefined : directory"
      @opened="opened"
      @used="emit('used')"
      @exited="emit('exited')"
    />
  </div>
</template>

<style scoped>
/* MiMo's host: the page colour, the terminal filling it. */
.rp-term {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
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
  color: var(--text-strong);
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
  color: var(--text-strong);
  background: none;
  border: 1px solid var(--border-weak);
  border-radius: 6px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  cursor: pointer;
}

.mismatch-btn:hover {
  opacity: 0.85;
}

.mismatch-btn.primary {
  color: var(--surface-raised);
  background: var(--text-strong);
  border-color: transparent;
}
</style>
