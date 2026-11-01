<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { t } from "../lib/i18n"
import { useEscapeLayer } from "../lib/escape-layer"
import { composing } from "../lib/keys"
import { providerIdError } from "../lib/custom-model"
import { providerIdProblem } from "@shared/provider-id"

/**
 * MiMo 26.920's 克隆供应商: the copy's provider id, asked for in the shared
 * confirmation's shape (400 wide on a 16px corner, a 17px title over a 13px
 * line), the field starting on a free `<id>-copy` with the caret at its end.
 * The id is checked as a new provider's is, live, and Enter clones.
 */
const props = defineProps<{ initial: string; taken: ReadonlySet<string> }>()
const emit = defineEmits<{ close: []; confirm: [id: string] }>()

const id = ref(props.initial)
const field = ref<HTMLInputElement>()

/* MiMo's rule, the same the form keeps: not empty, no `/`, not taken in any case. */
const error = computed(() => {
  const problem = providerIdProblem(id.value, props.taken)
  return problem ? providerIdError(problem) : undefined
})

function confirm() {
  if (error.value) return
  emit("confirm", id.value.trim())
}

/* Enter clones, unless it is finishing an input method's composition. */
function onEnter(event: KeyboardEvent) {
  if (composing(event)) return
  event.preventDefault()
  confirm()
}

useEscapeLayer(() => emit("close"))

onMounted(() => {
  const input = field.value
  if (!input) return
  input.focus()
  input.setSelectionRange(input.value.length, input.value.length)
})
</script>

<template>
  <div class="scrim" @mousedown.self="emit('close')">
    <div v-modal class="dialog" data-clone-provider-dialog role="dialog" aria-labelledby="clone-provider-title">
      <h2 id="clone-provider-title">{{ t("set.models.cloneProvider") }}</h2>
      <p class="body">{{ t("set.models.cloneDesc") }}</p>
      <input
        ref="field"
        v-model="id"
        class="field-in"
        :class="{ bad: error }"
        aria-labelledby="clone-provider-title"
        placeholder="my-provider-copy"
        data-clone-provider-id
        spellcheck="false"
        autocomplete="off"
        @keydown.enter="onEnter"
      />
      <div v-if="error" class="error" data-clone-provider-error>{{ error }}</div>
      <footer>
        <button class="ghost" data-clone-cancel @click="emit('close')">{{ t("common.cancel") }}</button>
        <button class="confirm" data-clone-confirm :disabled="Boolean(error)" @click="confirm">{{ t("set.models.cloneConfirm") }}</button>
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
  background: var(--surface-raised);
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
}

.field-in {
  box-sizing: border-box;
  width: 100%;
  height: calc(36px * var(--ui-font-scale, 1));
  margin-top: 16px;
  padding: 0 12px;
  color: var(--text-strong);
  background: transparent;
  border: 1px solid #e3e3e0;
  border-radius: 6px;
  box-shadow: var(--shadow-xs);
  font-size: calc(13px * var(--ui-font-scale, 1));
  outline: none;
}

.field-in::placeholder {
  color: var(--text-base);
}

.field-in:focus {
  border-color: var(--text-weak);
}

.field-in:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: 2px;
}

/* The focus and refusal rings repeated for the dark fill, which would otherwise outrank both - see CustomProviderForm's .cp-in, the same shape. */
:root[data-theme="dark"] .field-in {
  background: rgb(58 58 58 / 0.3);
  border-color: #3a3a3a;
}

:root[data-theme="dark"] .field-in:focus {
  border-color: var(--text-weak);
}

:root[data-theme="dark"] .field-in.bad {
  border-color: #ff6467;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .field-in {
    background: rgb(58 58 58 / 0.3);
    border-color: #3a3a3a;
  }

  :root:not([data-theme="light"]) .field-in:focus {
    border-color: var(--text-weak);
  }

  :root:not([data-theme="light"]) .field-in.bad {
    border-color: #ff6467;
  }
}

/* MiMo rings a bad id in red-400 and says why in red-500. Both are written out
   MiMo's red-400, which is not its --color-err. */
.field-in.bad {
  border-color: #ff6467;
}

.error {
  margin-top: 4px;
  color: #fb2c36;
  font-size: calc(12px * var(--ui-font-scale, 1));
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
  background: transparent;
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

.confirm:hover:not(:disabled) {
  opacity: 0.9;
}

.confirm:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
