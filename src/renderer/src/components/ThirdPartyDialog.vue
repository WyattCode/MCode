<script setup lang="ts">
import { onMounted, reactive } from "vue"
import { t } from "../lib/i18n"
import { useEscapeLayer } from "../lib/escape-layer"
import { THIRD_PARTY } from "../lib/third-party"

/**
 * 第三方许可: each redistributed component with its version, licence, notice and
 * source address, and its licence text in full under a fold. MiMo has no such
 * dialog; it takes the shape of MCode's other settings sub-dialogs (the voice
 * usage one): a close button in the corner, Escape or a press outside closes it.
 */
const emit = defineEmits<{ close: [] }>()

const texts = reactive<Record<string, string>>({})

useEscapeLayer(() => emit("close"))

onMounted(() => {
  for (const notice of THIRD_PARTY) {
    void notice.text().then(
      (text) => (texts[notice.id] = text),
      () => undefined,
    )
  }
})
</script>

<template>
  <div class="scrim" @mousedown.self="emit('close')">
    <div v-modal class="dialog" data-third-party data-modal-keep-focus role="dialog" aria-labelledby="third-party-title">
      <h2 id="third-party-title">{{ t("licenses.title") }}</h2>
      <button class="close" type="button" :aria-label="t('common.close')" data-third-party-close @click="emit('close')">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
        </svg>
      </button>
      <p class="intro">{{ t("licenses.intro") }}</p>
      <div class="entries">
        <details v-for="notice in THIRD_PARTY" :key="notice.id" class="entry" :data-third-party-entry="notice.id">
          <summary>
            <span class="name">{{ notice.name }}</span>
            <span class="meta">{{ notice.version }} · {{ notice.license }}</span>
          </summary>
          <div class="about" dir="ltr">{{ notice.about }}</div>
          <div class="source" dir="ltr">{{ notice.source }}</div>
          <pre class="license" dir="ltr" :data-third-party-text="notice.id">{{ texts[notice.id] ?? "" }}</pre>
        </details>
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
  position: relative;
  box-sizing: border-box;
  width: min(560px, 90vw);
  max-height: 86vh;
  padding: 22px 24px;
  overflow-y: auto;
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 16px;
  box-shadow: var(--shadow-overlay);
}

h2 {
  margin: 0 0 8px;
  color: var(--text-strong);
  font-size: calc(16px * var(--ui-font-scale, 1));
  font-weight: 400;
}

.close {
  position: absolute;
  top: 14px;
  inset-inline-end: 14px;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  color: var(--text-weak);
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

.intro {
  margin: 0 0 14px;
  color: var(--text-weak);
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: 1.55;
}

.entries {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.entry {
  border: 1px solid var(--border-weak);
  border-radius: 10px;
}

summary {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
  padding: 9px 12px;
  border-radius: 10px;
  cursor: pointer;
  font-size: calc(13px * var(--ui-font-scale, 1));
}

summary:hover {
  background: var(--surface-hover);
}

.name {
  color: var(--text-strong);
  font-weight: 500;
}

.meta {
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.about,
.source {
  padding-inline: 12px;
  color: var(--text-base);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 1.55;
  white-space: pre-line;
  overflow-wrap: anywhere;
}

.source {
  padding-block-start: 4px;
  color: var(--text-weak);
}

.license {
  max-height: 260px;
  margin: 10px 12px 12px;
  padding: 10px;
  overflow: auto;
  color: var(--text-base);
  background: var(--surface-raised-hover);
  border-radius: 8px;
  font-size: calc(11px * var(--code-font-scale, 1));
  line-height: 1.5;
  white-space: pre-wrap;
  user-select: text;
}
</style>
