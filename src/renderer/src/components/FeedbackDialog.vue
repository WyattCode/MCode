<script setup lang="ts">
import { ref } from "vue"
import { FEEDBACK_TYPES, type FeedbackInput, type FeedbackType } from "@shared/protocol"
import { t } from "../lib/i18n"
import { useEscapeLayer } from "../lib/escape-layer"

const props = defineProps<{ pending: boolean }>()
const emit = defineEmits<{
  close: []
  submit: [Pick<FeedbackInput, "types" | "description" | "includeMaterials">]
}>()
const types = ref<FeedbackType[]>([])
const description = ref("")
const includeMaterials = ref(false)

function close() {
  if (!props.pending) emit("close")
}
function submit() {
  if (!props.pending) emit("submit", { types: [...types.value], description: description.value, includeMaterials: includeMaterials.value })
}

useEscapeLayer(close)
</script>

<template>
  <div class="scrim" @mousedown.self="close">
    <form v-modal class="dialog" data-feedback-dialog role="dialog" aria-modal="true" aria-labelledby="feedback-title" @submit.prevent="submit">
      <h2 id="feedback-title">{{ t("feedback.title") }}</h2>
      <fieldset class="body">
        <legend>{{ t("feedback.types") }}</legend>
        <div v-for="type in FEEDBACK_TYPES" :key="type">
          <label><input v-model="types" type="checkbox" :disabled="pending" :value="type" :data-feedback-type="type" /> {{ t(`feedback.${type}`) }}</label>
        </div>
      </fieldset>
      <label class="body" for="feedback-description">{{ t("feedback.description") }}</label>
      <textarea id="feedback-description" v-model="description" rows="4" maxlength="4000" :disabled="pending" />
      <label class="body">
        <input v-model="includeMaterials" type="checkbox" role="switch" data-feedback-attach :disabled="pending" />
        {{ t("feedback.attach") }}
      </label>
      <footer>
        <button type="button" class="ghost" data-feedback-cancel :disabled="pending" @click="close">{{ t("common.cancel") }}</button>
        <button type="submit" class="confirm" data-feedback-submit :disabled="pending">{{ t("common.submit") }}</button>
      </footer>
    </form>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 130;
  display: grid;
  place-items: center;
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

.ghost {
  color: var(--text-base);
  background: var(--surface-page);
  border-color: var(--border-weak);
}

.ghost:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

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
