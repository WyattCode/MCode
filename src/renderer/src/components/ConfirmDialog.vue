<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue"
import { t } from "../lib/i18n"

/**
 * Asks before something that cannot be taken back.
 *
 * Deleting a session was immediate from both the shortcut and the palette, and
 * a session is removed from disk outright - no archive, no recycle bin, nothing
 * to restore from. An action with no way back is worth one question.
 */
defineProps<{ title: string; body: string; confirmLabel: string }>()
const emit = defineEmits<{ close: []; confirm: [] }>()

/** Focus starts on Cancel, so a stray Enter or Space does not confirm. */
const cancel = ref<HTMLButtonElement>()

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") emit("close")
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown)
  cancel.value?.focus()
})
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown))
</script>

<template>
  <div class="scrim" @mousedown.self="emit('close')">
    <div v-modal class="dialog">
      <h2>{{ title }}</h2>
      <p class="body">{{ body }}</p>
      <footer>
        <button ref="cancel" class="ghost" @click="emit('close')">{{ t("common.cancel") }}</button>
        <button class="danger" @click="emit('confirm')">{{ confirmLabel }}</button>
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
  background: var(--scrim);
}

.dialog {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: min(420px, 88vw);
  padding: 20px 22px 18px;
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-lg);
}

h2 {
  margin: 0;
  color: var(--text-strong);
  font-size: 15px;
  font-weight: 530;
  line-height: 20px;
  letter-spacing: -0.13px;
}

.body {
  margin: 0;
  color: var(--text-weak);
  font-size: 13px;
  line-height: 1.6;
}

footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}

.ghost,
.danger {
  height: 30px;
  padding: 0 14px;
  border-radius: var(--radius-md);
  font-size: 12.5px;
}

.ghost {
  color: var(--text-base);
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
}

.ghost:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.danger {
  color: #fff;
  background: var(--error);
}

.danger:hover {
  filter: brightness(1.08);
}
</style>
