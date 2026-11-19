<script setup lang="ts">
import { onMounted, ref } from "vue"
import { t } from "../lib/i18n"
import { useEscapeLayer } from "../lib/escape-layer"

/**
 * Asks before something that cannot be taken back.
 *
 * Deleting a session was immediate from both the shortcut and the palette, and
 * a session is removed from disk outright - no archive, no recycle bin, nothing
 * to restore from. An action with no way back is worth one question.
 *
 * Drawn as MiMo's shared confirmation: 400 wide on a 16px corner, a 17px title
 * over a 13px message that keeps its line breaks, and 14px buttons. The confirm
 * button is light red for something destructive and plain otherwise.
 */
withDefaults(defineProps<{ title: string; body: string; confirmLabel: string; danger?: boolean; pending?: boolean }>(), { danger: true })
const emit = defineEmits<{ close: []; confirm: [] }>()

/*
 * Focus starts on the confirm button, as MiMo's does, so Enter confirms.
 * This deliberately reverses MCode's earlier cancel-first choice at the user's request.
 */
const confirmButton = ref<HTMLButtonElement>()

useEscapeLayer(() => emit("close"))

onMounted(() => {
  confirmButton.value?.focus()
})
</script>

<template>
  <div class="scrim" @mousedown.self="emit('close')">
    <div v-modal class="dialog" data-confirm-dialog role="alertdialog" aria-labelledby="confirm-title" aria-modal="true">
      <h2 id="confirm-title">{{ title }}</h2>
      <p class="body">{{ body }}</p>
      <footer>
        <button type="button" class="ghost" :disabled="pending" @click="emit('close')">{{ t("common.cancel") }}</button>
        <button type="button" ref="confirmButton" class="confirm" :class="{ danger }" :disabled="pending" data-confirm @click="emit('confirm')">{{ confirmLabel }}</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 130;
  display: grid;
  place-items: center;
  /* MiMo's dialog scrim is bg-black/50 in both schemes, not a lighter one in light. */
  background: #00000080;
}

.dialog {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: min(400px, 88vw);
  padding: 22px 24px;
  background: var(--surface-page);
  border: 1px solid var(--border-weak);
  border-radius: 16px;
  box-shadow: var(--shadow-pop);
}

h2 {
  margin: 0;
  color: var(--text-strong);
  font-size: calc(17px * var(--ui-font-scale, 1));
  font-weight: 400;
}

.body {
  margin: 8px 0 0;
  /* MiMo draws a dialog's message in mut, the same as a row's sub-line. */
  color: var(--text-base);
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: 1.6;
  white-space: pre-wrap;
}

footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 20px;
}

.ghost,
.confirm {
  padding: 8px 18px;
  border: 1px solid transparent;
  border-radius: 8px;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 400;
  cursor: pointer;
}

/* MiMo's dialog cancel: the page ground under a line, menu-hover on hover. */
.ghost {
  color: var(--text-base);
  background: var(--surface-page);
  border-color: var(--border-weak);
}

.ghost:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

/* Not destructive: the app's primary button. */
.confirm {
  color: var(--button-primary-text);
  background: var(--button-primary);
  border-color: var(--button-primary);
}

.confirm:hover {
  opacity: 0.9;
}

.ghost:focus-visible,
.confirm:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: 2px;
}

/* MiMo's light red pair for an action that cannot be undone. */
.confirm.danger {
  color: #d93025;
  background: #fdecea;
  border-color: #fdecea;
}

.confirm.danger:hover {
  background: #fadbd8;
  border-color: #fadbd8;
  opacity: 1;
}

:root[data-theme="dark"] .confirm.danger {
  color: #ff9b7f;
  background: #3a2320;
  border-color: #3a2320;
}

:root[data-theme="dark"] .confirm.danger:hover {
  background: #4a2c27;
  border-color: #4a2c27;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .confirm.danger {
    color: #ff9b7f;
    background: #3a2320;
    border-color: #3a2320;
  }

  :root:not([data-theme="light"]) .confirm.danger:hover {
    background: #4a2c27;
    border-color: #4a2c27;
  }
}
</style>
