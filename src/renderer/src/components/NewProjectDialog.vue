<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { t } from "../lib/i18n"
import { useEscapeLayer } from "../lib/escape-layer"

/**
 * MiMo's "new blank project" dialog.
 *
 * A name, and under it a source folder: left empty, the project is a new empty
 * folder made under the default project location; picked, that folder becomes
 * the project under the name given. Picking a folder before the name has been
 * touched names the project after the folder.
 */
const props = defineProps<{ value: string; defaultLocation?: string }>()
const emit = defineEmits<{ close: []; submit: [name: string, source?: string, location?: string] }>()

/* MiMo caps a project name at 80 code points, however it was arrived at. */
const MAX_NAME = 80

/** Cut by code point, so an emoji or a CJK surrogate pair is never split in half. */
function clamp(text: string): string {
  const points = Array.from(text)
  return points.length > MAX_NAME ? points.slice(0, MAX_NAME).join("") : text
}

const draft = ref(clamp(props.value))
const touched = ref(false)
const source = ref("")
const field = ref<HTMLInputElement>()

/*
 * Where the new folder goes, as MiMo's dialog lets it be changed. Empty means
 * the default project location, which is what the row shows until it is.
 * Only asked about when no source folder was picked: with one, that folder is
 * the project and there is nowhere else to put it.
 */
const location = ref("")
const shownLocation = computed(() => location.value || props.defaultLocation || "")

async function pickLocation() {
  const [directory] = await window.mcode.pickDirectory(t("set.projectRoot"), false)
  if (directory) location.value = directory
}

function typed(event: Event) {
  touched.value = true
  const input = event.target as HTMLInputElement
  const next = clamp(input.value)
  if (next !== input.value) input.value = next
  draft.value = next
}

async function pickSource() {
  const [directory] = await window.mcode.pickDirectory(t("home.blankSource"), false)
  if (!directory) return
  source.value = directory
  if (!touched.value) draft.value = clamp(directory.split(/[\\/]/).filter(Boolean).pop() || draft.value)
}

function submit() {
  const name = clamp(draft.value.trim())
  if (!name) return
  emit("submit", name, source.value || undefined, source.value ? undefined : location.value || undefined)
}

/* Enter while an IME is composing picks a candidate; it must not create. */
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
    <div v-modal class="card" data-new-project-dialog role="dialog" aria-labelledby="np-title">
      <div class="head">
        <div>
          <div class="icon" data-np-icon aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" />
              <path d="M12 10.5v5M9.5 13h5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
            </svg>
          </div>
          <h2 id="np-title" class="title">{{ t("home.blankTitle") }}</h2>
          <p class="sr-only">{{ t("home.blankSubtitle") }}</p>
        </div>
        <button type="button" class="close" data-np-close :aria-label="t('common.cancel')" @click="emit('close')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          </svg>
        </button>
      </div>

      <label class="label" for="np-input">{{ t("home.blankNameLabel") }}</label>
      <input
        id="np-input"
        ref="field"
        class="field"
        :value="draft"
        spellcheck="false"
        :maxlength="MAX_NAME"
        @input="typed"
        @keydown.enter="onEnter"
      />

      <div class="label">{{ t("home.blankSource") }}</div>
      <button type="button" class="source" data-np-source @click="pickSource">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" />
          <path d="M12 10.5v5M9.5 13h5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
        </svg>
        <span v-if="source" class="source-path" data-np-source-path :title="source">{{ source }}</span>
        <span v-else class="source-hint" data-np-source-hint>{{ t("home.blankSourceHint") }}</span>
      </button>

      <!-- Where the folder goes; with a source folder there is nowhere else for it to be. -->
      <template v-if="!source">
        <div class="label">{{ t("set.projectRoot") }}</div>
        <button type="button" class="where" data-np-location @click="pickLocation">
          <span v-if="shownLocation" class="where-path" data-np-location-path :title="shownLocation">{{ shownLocation }}</span>
          <span v-else class="where-path where-default" data-np-location-path>{{ t("set.projectRootEmpty") }}</span>
          <span class="where-pick">{{ t("set.pickDir") }}</span>
        </button>
      </template>

      <div class="actions">
        <button type="button" class="btn" data-np-cancel @click="emit('close')">{{ t("common.cancel") }}</button>
        <button type="button" class="btn primary" data-np-save :disabled="!draft.trim()" @click="submit">
          {{ t("home.blankCreate") }}
        </button>
      </div>
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

.card {
  width: min(430px, 90vw);
  padding: 22px 24px;
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 16px;
  box-shadow: var(--shadow-overlay);
}

.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 16px;
}

.icon {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  margin-bottom: 14px;
  color: var(--text-strong);
  background: var(--surface-hover);
  border-radius: 12px;
}

.title {
  margin: 0;
  color: var(--text-strong);
  font-size: calc(19px * var(--ui-font-scale, 1));
  font-weight: 600;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.close {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  color: var(--text-weak);
  background: transparent;
  border: 0;
  border-radius: 7px;
  cursor: pointer;
}

.close:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.label {
  display: block;
  margin-bottom: 6px;
  color: var(--text-weak);
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.field {
  box-sizing: border-box;
  width: 100%;
  margin-bottom: 18px;
  padding: 10px 12px;
  color: var(--text-strong);
  font: inherit;
  font-size: calc(14px * var(--ui-font-scale, 1));
  line-height: normal;
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 9px;
}

/* MiMo's np-card field on focus: the dim colour, #151c1366 light and #777 dark. */
.field:focus {
  outline: none;
  border-color: #151c1366;
}

.source {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  box-sizing: border-box;
  width: 100%;
  margin-bottom: 18px;
  padding: 26px 16px;
  color: var(--text-weak);
  font: inherit;
  font-size: calc(13px * var(--ui-font-scale, 1));
  background: var(--surface-hover);
  border: 0;
  border-radius: 10px;
  cursor: pointer;
}

.source:hover {
  color: var(--text-strong);
  background: var(--surface-selected);
}

.source svg {
  flex-shrink: 0;
}

.source-path,
.source-hint {
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.source-path {
  color: var(--text-strong);
}

/* The location row: the path on one line with the button after it, on the field's own ground. */
.where {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  box-sizing: border-box;
  width: 100%;
  margin-bottom: 18px;
  padding: 10px 12px;
  color: var(--text-weak);
  font: inherit;
  font-size: calc(13px * var(--ui-font-scale, 1));
  text-align: start;
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 9px;
  cursor: pointer;
}

.where:hover {
  background: var(--surface-hover);
}

.where-path {
  overflow: hidden;
  color: var(--text-strong);
  font-family: var(--font-mono);
  font-size: calc(11.5px * var(--ui-font-scale, 1));
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* No location chosen yet: the sentence that says where it will land, in the quieter colour. */
.where-default {
  color: var(--text-weak);
  font-family: inherit;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.where-pick {
  flex: none;
  color: var(--text-weak);
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

/* MiMo's np-btn: the page ground under a line, menu-hover on hover. */
.btn {
  padding: 8px 18px;
  color: var(--text-base);
  font: inherit;
  font-size: calc(14px * var(--ui-font-scale, 1));
  background: #fffefd;
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  cursor: pointer;
}

.btn:hover {
  background: #f1f0ec;
}

.btn.primary {
  color: var(--button-primary-text);
  background: var(--button-primary);
  border-color: var(--button-primary);
}

.btn.primary:hover {
  opacity: 0.9;
}

.btn.primary:disabled {
  cursor: default;
  opacity: 0.45;
}

:root[data-theme="dark"] .field:focus {
  border-color: #777777;
}

:root[data-theme="dark"] .btn:not(.primary) {
  background: #1a1a1a;
}

:root[data-theme="dark"] .btn:not(.primary):hover {
  background: #ffffff0f;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .field:focus {
    border-color: #777777;
  }

  :root:not([data-theme="light"]) .btn:not(.primary) {
    background: #1a1a1a;
  }

  :root:not([data-theme="light"]) .btn:not(.primary):hover {
    background: #ffffff0f;
  }
}
</style>
