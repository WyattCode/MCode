<script setup lang="ts">
import { t } from "../lib/i18n"
import { useEscapeLayer } from "../lib/escape-layer"

/**
 * MiMo's 智能编辑用法示例: what the smart voice mode understands, with examples.
 *
 * 480 wide on a 16px corner with MiMo's standard close button in the corner.
 * Nothing takes focus when it opens, as MiMo's special dialogs do not; Escape or
 * a press outside closes it.
 */
const emit = defineEmits<{ close: [] }>()

const ENTRIES = [
  { id: "dictate", examples: false },
  { id: "edit", examples: true },
  { id: "place", examples: true },
  { id: "correct", examples: true },
  { id: "filler", examples: false },
] as const

useEscapeLayer(() => emit("close"))
</script>

<template>
  <div class="scrim" @mousedown.self="emit('close')">
    <div v-modal class="dialog" data-voice-usage data-modal-keep-focus role="dialog" aria-labelledby="voice-usage-title">
      <h2 id="voice-usage-title">{{ t("voice.usage.title") }}</h2>
      <button class="close" type="button" :aria-label="t('common.close')" data-voice-usage-close @click="emit('close')">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
        </svg>
      </button>
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
  /* MiMo's dialog scrim is bg-black/50 in both schemes, not a lighter one in light. */
  background: #00000080;
}

/* The max height is MCode's safety net for short windows; MiMo's dialog has none. */
.dialog {
  position: relative;
  box-sizing: border-box;
  width: min(480px, 90vw);
  max-height: 86vh;
  padding: 22px 24px;
  overflow-y: auto;
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 16px;
  box-shadow: var(--shadow-pop);
}

h2 {
  margin: 0 0 16px;
  color: var(--text-strong);
  font-size: calc(16px * var(--ui-font-scale, 1));
  font-weight: 400;
}

/* MiMo's u-modal-close: absolute 14/14, 28 square, radius 8, muted. */
.close {
  position: absolute;
  top: 14px;
  inset-inline-end: 14px;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  color: var(--text-base);
  background: transparent;
  border: 0;
  border-radius: 8px;
}

.close:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.close:focus-visible {
  outline: 2px solid var(--text-strong);
  outline-offset: -2px;
}

.entries {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.entry {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: 1.55;
}

.entry-title {
  color: var(--text-body);
  font-weight: 500;
}

.entry-desc {
  color: var(--text-weak);
}

/* Examples sit on a 2px rule in MiMo's blue at 35%. */
.entry-examples {
  padding-inline-start: 10px;
  color: var(--text-base);
  border-inline-start: 2px solid color-mix(in srgb, #2f6fed 35%, transparent);
  font-size: calc(12px * var(--ui-font-scale, 1));
  white-space: pre-line;
}

:root[data-theme="dark"] .entry-examples {
  border-color: color-mix(in srgb, #5a9cff 35%, transparent);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .entry-examples {
    border-color: color-mix(in srgb, #5a9cff 35%, transparent);
  }
}
</style>
