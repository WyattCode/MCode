<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue"
import { t } from "../lib/i18n"

/**
 * MiMo's 智能编辑用法示例: what the smart voice mode understands, with examples.
 *
 * 480 wide on a 16px corner with the standard close button. Nothing takes focus
 * when it opens, as MiMo's special dialogs do not; Escape or a press outside closes it.
 */
const emit = defineEmits<{ close: [] }>()

const ENTRIES = [
  { id: "dictate", examples: false },
  { id: "edit", examples: true },
  { id: "place", examples: true },
  { id: "correct", examples: true },
  { id: "filler", examples: false },
] as const

function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape") return
  // The settings dialog underneath listens for Escape too; this layer closes alone.
  event.stopImmediatePropagation()
  emit("close")
}

onMounted(() => window.addEventListener("keydown", onKeydown, true))
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown, true))
</script>

<template>
  <div class="scrim" @mousedown.self="emit('close')">
    <div v-modal class="dialog" data-voice-usage data-modal-keep-focus role="dialog" aria-labelledby="voice-usage-title">
      <div class="head">
        <h2 id="voice-usage-title">{{ t("voice.usage.title") }}</h2>
        <button class="close" type="button" :aria-label="t('common.close')" @click="emit('close')">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
          </svg>
        </button>
      </div>
      <div class="entries">
        <section v-for="entry in ENTRIES" :key="entry.id" class="entry" :data-voice-usage-entry="entry.id">
          <div class="entry-title">{{ t(`voice.usage.${entry.id}`) }}</div>
          <div class="entry-desc">{{ t(`voice.usage.${entry.id}Desc`) }}</div>
          <div v-if="entry.examples" class="entry-examples">{{ t(`voice.usage.${entry.id}Examples`) }}</div>
        </section>
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

.dialog {
  box-sizing: border-box;
  width: min(480px, 90vw);
  max-height: 86vh;
  padding: 22px 24px;
  overflow-y: auto;
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 16px;
  box-shadow: var(--shadow-overlay);
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-block-end: 16px;
}

h2 {
  margin: 0;
  color: var(--text-strong);
  font-size: calc(16px * var(--ui-font-scale, 1));
  font-weight: 400;
}

.close {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 30px;
  height: 30px;
  color: var(--text-weak);
  background: transparent;
  border: 0;
  border-radius: 7px;
}

.close:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.entries {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.entry {
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: 1.55;
}

.entry-title {
  color: var(--text-strong);
  font-weight: 500;
}

.entry-desc {
  color: var(--text-weak);
}

/* Examples sit on a 2px rule in the link blue at 35%. */
.entry-examples {
  margin-block-start: 6px;
  padding-inline-start: 10px;
  color: var(--text-weak);
  border-inline-start: 2px solid color-mix(in srgb, #0077fa 35%, transparent);
  font-size: calc(12px * var(--ui-font-scale, 1));
  white-space: pre-line;
}
</style>
