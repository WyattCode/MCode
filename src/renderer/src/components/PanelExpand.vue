<script setup lang="ts">
import { t } from "../lib/i18n"

/**
 * MiMo's expand button for the side panel, the same on every panel that can
 * stand under the side panel toggle: 24px in the title bar's icon colour with
 * a 12px glyph, 展开面板 while the panel has its own width and 恢复面板宽度
 * while it covers the main column.
 */
defineProps<{ full?: boolean }>()
const emit = defineEmits<{ toggle: [] }>()
</script>

<template>
  <button
    type="button"
    class="panel-expand"
    data-panel-expand
    :aria-pressed="Boolean(full)"
    :aria-label="t(full ? 'launch.restoreWidth' : 'launch.expand')"
    v-tip="{ label: t(full ? 'launch.restoreWidth' : 'launch.expand') }"
    @click="emit('toggle')"
  >
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path v-if="full" d="M9 3v6H3M21 9h-6V3M15 21v-6h6M3 15h6v6" />
      <path v-else d="M3 9V3h6M15 3h6v6M21 15v6h-6M9 21H3v-6" />
    </svg>
  </button>
</template>

<style scoped>
.panel-expand {
  display: grid;
  flex: none;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  /* MiMo's title-bar icon colour: near the strongest text on dark, 60% of it on light. */
  color: color-mix(in srgb, var(--text-strong) 60%, transparent);
  background: transparent;
  border: 0;
  border-radius: 7px;
  -webkit-app-region: no-drag;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .panel-expand {
    color: var(--text-strong);
  }
}

:root[data-theme="dark"] .panel-expand {
  color: var(--text-strong);
}

/* MiMo on Windows: the title-bar glyphs in one solid colour on light and dark alike. */
.app[data-platform="win32"] .panel-expand {
  color: var(--text-strong);
}

.panel-expand:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.panel-expand:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: 2px;
}
</style>
