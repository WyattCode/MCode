<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue"
import { t } from "../lib/i18n"

/**
 * Asks for one line of text.
 *
 * This began as the session rename, which had been a window.prompt - Electron
 * refuses those outright, throwing "prompt() is not supported", so the command
 * did nothing at all. Anything that needs a line of text from the user has to
 * be drawn by the app, and there turned out to be three such places.
 */
const props = withDefaults(
  defineProps<{ value: string; heading?: string; placeholder?: string; confirm?: string }>(),
  { heading: undefined, placeholder: undefined, confirm: undefined },
)
const emit = defineEmits<{ close: []; submit: [title: string] }>()

const draft = ref(props.value)
const field = ref<HTMLInputElement>()

function submit() {
  const next = draft.value.trim()
  if (!next) return
  emit("submit", next)
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") emit("close")
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown)
  field.value?.focus()
  field.value?.select()
})
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown))
</script>

<template>
  <div class="scrim" @mousedown.self="emit('close')">
    <div v-modal class="dialog">
      <h2>{{ heading ?? t("cmd.rename") }}</h2>
      <input
        ref="field"
        v-model="draft"
        class="field"
        spellcheck="false"
        :placeholder="placeholder"
        @keydown.enter="submit"
      />
      <footer>
        <button class="ghost" @click="emit('close')">{{ t("common.cancel") }}</button>
        <button class="go" :disabled="!draft.trim()" @click="submit">{{ confirm ?? t("common.save") }}</button>
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

.field {
  height: 36px;
  padding: 0 12px;
  color: var(--text-strong);
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: var(--radius-md);
  font-size: 14px;
}

.field:focus {
  border-color: var(--interactive);
  outline: none;
}

footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.ghost {
  height: 32px;
  padding: 0 14px;
  color: var(--text-base);
  border-radius: var(--radius-md);
  font-size: 13px;
}

.ghost:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.go {
  height: 32px;
  padding: 0 18px;
  color: var(--surface-base);
  background: var(--text-strong);
  border-radius: var(--radius-md);
  font-size: 13px;
  font-weight: 530;
}

.go:disabled {
  opacity: 0.45;
}
</style>
