<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"
import { composing } from "../lib/keys"
import { useEscapeLayer } from "../lib/escape-layer"
import { projectHue } from "../lib/project"

/**
 * Edits how a project presents itself in the rail.
 *
 * Projects are derived from sessions rather than stored as records, so there is
 * nothing to create or delete here - only the presentation is the user's to
 * choose, and it is keyed by directory alongside the name.
 */
const props = defineProps<{ directory: string }>()
const emit = defineEmits<{ close: [] }>()

const app = useApp()

/** Badge hues, matching the swatch row. */
const COLORS = ["330", "160", "20", "280", "215", "95"]
const MAX_ICON_BYTES = 512 * 1024

const fallbackName = computed(
  () => props.directory.split(/[\\/]/).filter(Boolean).pop() ?? props.directory,
)

const name = ref(app.config?.projectNames?.[props.directory] ?? fallbackName.value)
const icon = ref(app.config?.projectIcons?.[props.directory] ?? "")
const color = ref(app.config?.projectColors?.[props.directory] ?? String(projectHue(props.directory)))
const file = ref<HTMLInputElement>()
const dragging = ref(false)
const error = ref<string>()

const initial = computed(() => (name.value.trim()[0] ?? "?").toUpperCase())

const nameField = ref<HTMLInputElement>()

// Every other dialog closes on Escape, and the first thing anyone does here is
// edit the name - so land the caret there rather than making them click it.
useEscapeLayer(() => emit("close"))

onMounted(() => {
  nameField.value?.focus()
  nameField.value?.select()
})

async function readIcon(chosen: File | undefined) {
  error.value = undefined
  if (!chosen) return
  if (!chosen.type.startsWith("image/")) {
    error.value = t("proj.iconType")
    return
  }
  if (chosen.size > MAX_ICON_BYTES) {
    error.value = t("proj.iconSize")
    return
  }
  // Inlined rather than copied to disk: config already travels as one document,
  // and a path would break the moment the picture moved.
  icon.value = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(chosen)
  })
}

function onDrop(event: DragEvent) {
  dragging.value = false
  void readIcon(event.dataTransfer?.files?.[0])
}

function onPick(event: Event) {
  void readIcon((event.target as HTMLInputElement).files?.[0] ?? undefined)
}

async function save() {
  const config = app.config
  if (!config) return
  const trimmed = name.value.trim() || fallbackName.value

  const names = { ...(config.projectNames ?? {}) }
  const icons = { ...(config.projectIcons ?? {}) }
  const colors = { ...(config.projectColors ?? {}) }

  names[props.directory] = trimmed
  if (icon.value) icons[props.directory] = icon.value
  else delete icons[props.directory]
  colors[props.directory] = color.value

  try {
    await app.patchConfig({ projectNames: names, projectIcons: icons, projectColors: colors })
  } catch {
    // patchConfig already toasts; keep the dialog open.
    return
  }
  emit("close")
}
</script>

<template>
  <div class="scrim" @mousedown.self="emit('close')">
    <div v-modal class="dialog">
      <header>
        <h2>{{ t("proj.editTitle") }}</h2>
        <button class="x" v-tip="t('common.close')" @click="emit('close')">
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
        </button>
      </header>

      <label class="label" for="proj-name">{{ t("proj.name") }}</label>
      <input
        id="proj-name"
        ref="nameField"
        v-model="name"
        class="field"
        spellcheck="false"
        @keydown.enter="!composing($event) && save()"
      />

      <label class="label">{{ t("proj.icon") }}</label>
      <div class="icon-row">
        <button
          class="preview"
          :class="{ dragging }"
          :style="{ '--h': color }"
          @click="file?.click()"
          @dragover.prevent="dragging = true"
          @dragleave="dragging = false"
          @drop.prevent="onDrop"
        >
          <img v-if="icon" :src="icon" alt="" />
          <span v-else>{{ initial }}</span>
        </button>
        <div class="icon-text">
          <button class="link" @click="file?.click()">{{ t("proj.iconPick") }}</button>
          <div class="hint">{{ t("proj.iconHint") }}</div>
          <button v-if="icon" class="link" @click="icon = ''">{{ t("proj.iconClear") }}</button>
        </div>
        <input ref="file" class="hidden" type="file" accept="image/*" @change="onPick" />
      </div>

      <label class="label">{{ t("proj.color") }}</label>
      <div class="swatches">
        <button
          v-for="entry in COLORS"
          :key="entry"
          class="swatch"
          :class="{ on: entry === color }"
          :style="{ '--h': entry }"
          @click="color = entry"
        >
          {{ initial }}
        </button>
      </div>

      <div v-if="error" class="error">{{ error }}</div>

      <footer>
        <button class="ghost" @click="emit('close')">{{ t("common.cancel") }}</button>
        <button class="go" @click="save">{{ t("common.save") }}</button>
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
  gap: 8px;
  width: min(520px, 90vw);
  padding: 20px 22px 18px;
  background: var(--surface-page);
  border: 1px solid var(--border-weak);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-pop);
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

h2 {
  margin: 0;
  color: var(--text-strong);
  font-size: calc(15px * var(--ui-font-scale, 1));
  font-weight: 530;
  line-height: calc(20px * var(--ui-font-scale, 1));
  letter-spacing: -0.13px;
}

.x {
  color: var(--text-base);
  padding: 4px;
  border-radius: var(--radius-md);
}

.x:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.label {
  margin-top: 8px;
  color: var(--text-base);
  font-size: calc(12.5px * var(--ui-font-scale, 1));
}

.field {
  /*
   * No border. opencode's shared `text-input-v2` is a 60% fill of bg-layer-02
   * that goes solid on focus, at radius 6 - `--surface-layer` and
   * `--radius-md` here. Focus used to move a border colour that no longer
   * exists.
   */
  height: calc(36px * var(--ui-font-scale, 1));
  padding: 0 12px;
  color: var(--text-strong);
  background: color-mix(in srgb, var(--surface-layer) 60%, transparent);
  border: 0;
  border-radius: var(--radius-md);
  font-size: calc(14px * var(--ui-font-scale, 1));
}

.field:focus {
  background: var(--surface-layer);
  outline: none;
}

.field:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: 2px;
}

.icon-row {
  display: flex;
  align-items: center;
  gap: 14px;
}

.preview,
.swatch {
  display: grid;
  place-items: center;
  background: hsl(var(--h) 42% 30%);
  color: hsl(var(--h) 70% 82%);
  border-radius: var(--radius-md);
  font-weight: 530;
  overflow: hidden;
}

.preview {
  width: calc(68px * var(--ui-font-scale, 1));
  height: calc(68px * var(--ui-font-scale, 1));
  font-size: calc(26px * var(--ui-font-scale, 1));
  border: 1px solid transparent;
}

.preview.dragging {
  border-color: var(--interactive);
}

.preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.icon-text {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
}

.hint {
  color: var(--text-weaker);
  font-size: calc(12.5px * var(--ui-font-scale, 1));
}

.hidden {
  display: none;
}

.swatches {
  display: flex;
  gap: 10px;
}

.swatch {
  width: calc(40px * var(--ui-font-scale, 1));
  height: calc(40px * var(--ui-font-scale, 1));
  font-size: calc(15px * var(--ui-font-scale, 1));
  border: 2px solid transparent;
}

.swatch.on {
  border-color: var(--text-strong);
}

.error {
  color: var(--text-critical);
  font-size: calc(12.5px * var(--ui-font-scale, 1));
}

footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 14px;
}

.ghost {
  height: calc(32px * var(--ui-font-scale, 1));
  padding: 0 14px;
  color: var(--text-base);
  border-radius: var(--radius-md);
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.ghost:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.go {
  height: calc(32px * var(--ui-font-scale, 1));
  padding: 0 18px;
  color: var(--surface-base);
  background: var(--text-strong);
  border-radius: var(--radius-md);
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 530;
}

.link {
  color: var(--text-base);
  font-size: calc(13px * var(--ui-font-scale, 1));
  text-decoration: underline;
  text-underline-offset: 2px;
}

.link:hover {
  color: var(--text-strong);
}
</style>
