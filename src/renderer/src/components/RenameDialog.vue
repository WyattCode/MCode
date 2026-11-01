<script setup lang="ts">
import { onMounted, ref } from "vue"
import { t } from "../lib/i18n"
import { useEscapeLayer } from "../lib/escape-layer"

/**
 * Asks for one line of text.
 *
 * This began as the session rename, which had been a window.prompt - Electron
 * refuses those outright, throwing "prompt() is not supported", so the command
 * did nothing at all. Anything that needs a line of text from the user has to
 * be drawn by the app.
 *
 * Drawn as MiMo's rename modal: 430 wide on a 16px corner, a 17px title with a
 * 13px subtitle and a close button beside it, a bordered 14px field capped at 80
 * characters, then 取消 and 保存.
 */
const props = withDefaults(
  defineProps<{
    value: string
    heading?: string
    subtitle?: string
    confirm?: string
    maxLength?: number
    closable?: boolean
  }>(),
  { heading: undefined, subtitle: undefined, confirm: undefined, maxLength: 80, closable: true },
)
const emit = defineEmits<{ close: []; submit: [title: string] }>()

/** Cut by code point, so an emoji or a CJK surrogate pair is never split in half. */
function clamp(text: string): string {
  const points = Array.from(text)
  return points.length > props.maxLength ? points.slice(0, props.maxLength).join("") : text
}

const draft = ref(clamp(props.value))
const field = ref<HTMLInputElement>()

function onInput(event: Event) {
  const input = event.target as HTMLInputElement
  const next = clamp(input.value)
  if (next !== input.value) input.value = next
  draft.value = next
}

function submit() {
  const next = draft.value.trim()
  if (!next) return
  emit("submit", next)
}

/* Enter while an IME is composing picks a candidate; it must not save. */
function onEnter(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  submit()
}

useEscapeLayer(() => emit("close"))

onMounted(() => {
  field.value?.focus()
  field.value?.select()
})
</script>

<template>
  <div class="scrim" @mousedown.self="emit('close')">
    <div v-modal class="dialog" data-rename-dialog role="dialog" aria-labelledby="rename-title">
      <div class="head">
        <div class="head-text">
          <h2 id="rename-title">{{ heading ?? t("cmd.rename") }}</h2>
          <p v-if="subtitle" class="subtitle">{{ subtitle }}</p>
        </div>
        <button v-if="closable" class="close" type="button" :aria-label="t('common.close')" @click="emit('close')">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
          </svg>
        </button>
      </div>
      <input
        ref="field"
        :value="draft"
        class="field"
        aria-labelledby="rename-title"
        spellcheck="false"
        :maxlength="maxLength"
        @input="onInput"
        @keydown.enter="onEnter"
      />
      <footer>
        <button class="ghost" type="button" @click="emit('close')">{{ t("common.cancel") }}</button>
        <button class="go" type="button" data-rename-save :disabled="!draft.trim()" @click="submit">
          {{ confirm ?? t("common.save") }}
        </button>
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
  box-sizing: border-box;
  width: min(430px, 88vw);
  padding: 22px 24px;
  background: var(--surface-page);
  border: 1px solid var(--border-weak);
  border-radius: 16px;
  box-shadow: var(--shadow-pop);
}

/* Title and subtitle at the start, the close button at the end, 16 above the field. */
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-block-end: 16px;
}

.head-text {
  min-width: 0;
}

h2 {
  margin: 0;
  color: var(--text-strong);
  font-size: calc(17px * var(--ui-font-scale, 1));
  font-weight: 400;
}

.subtitle {
  margin: 3px 0 0;
  color: var(--text-base);
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.close {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 30px;
  height: 30px;
  color: var(--text-base);
  background: transparent;
  border: 0;
  border-radius: 7px;
}

.close:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.field {
  box-sizing: border-box;
  width: 100%;
  margin-block-end: 18px;
  padding: 10px 12px;
  color: var(--text-strong);
  background: #fff;
  border: 1px solid var(--border-weak);
  border-radius: 9px;
  outline: none;
  font-size: calc(14px * var(--ui-font-scale, 1));
}

.field:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: 2px;
}

/* MiMo's np-card field on focus: the dim colour, #151c1366 light and #777 dark. */
.field:focus {
  border-color: #151c1366;
}

:root[data-theme="dark"] .field {
  background: var(--surface-base);
}

:root[data-theme="dark"] .field:focus {
  border-color: #777777;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .field {
    background: var(--surface-base);
  }

  :root:not([data-theme="light"]) .field:focus {
    border-color: #777777;
  }
}

footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.ghost,
.go {
  padding: 8px 18px;
  border: 1px solid transparent;
  border-radius: 8px;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 400;
  cursor: pointer;
}

/* MiMo's np-btn: the page ground under a line, menu-hover on hover. */
.ghost {
  color: var(--text-base);
  background: #fffefd;
  border-color: var(--border-weak);
}

.ghost:hover {
  color: var(--text-strong);
  background: #f1f0ec;
}

:root[data-theme="dark"] .ghost {
  background: #1a1a1a;
}

:root[data-theme="dark"] .ghost:hover {
  background: #ffffff0f;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .ghost {
    background: #1a1a1a;
  }

  :root:not([data-theme="light"]) .ghost:hover {
    background: #ffffff0f;
  }
}

/* The primary pair, the same one the confirm dialog's non-destructive button uses. */
.go {
  color: var(--button-primary-text);
  background: var(--button-primary);
  border-color: var(--button-primary);
}

.go:hover:not(:disabled) {
  opacity: 0.9;
}

.go:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
