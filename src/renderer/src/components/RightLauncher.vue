<script setup lang="ts">
import { t } from "../lib/i18n"

/**
 * MiMo's side panel with nothing chosen yet: a card for each thing it can hold.
 *
 * Review and files open the review panel on that tab, side chat opens the
 * conversation's side chat, browser a page, terminal the drawer under the
 * conversation. A card for something the current screen cannot hold - the
 * review on the home screen, say - stays in its place, greyed, rather than
 * leaving a gap that changes from screen to screen.
 */
type Tool = "review" | "files" | "chat" | "browser" | "terminal"

defineProps<{ available: Record<Tool, boolean> }>()
const emit = defineEmits<{ pick: [tool: Tool] }>()

const TOOLS: { id: Tool; label: string; kbd?: string; icon: string[] }[] = [
  {
    id: "review",
    label: "launch.review",
    icon: ["M4 2.5h8A1.5 1.5 0 0 1 13.5 4v8a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12V4A1.5 1.5 0 0 1 4 2.5z", "M5.5 8.2 7.2 9.9 10.5 6.3"],
  },
  {
    id: "files",
    label: "launch.files",
    kbd: "Ctrl+P",
    icon: ["M1.9 4.2c0-.6.5-1.1 1.1-1.1h2.6l1.3 1.5h6.1c.6 0 1.1.5 1.1 1.1v6.1c0 .6-.5 1.1-1.1 1.1H3c-.6 0-1.1-.5-1.1-1.1z"],
  },
  {
    id: "chat",
    label: "launch.chat",
    icon: ["M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z"],
  },
  {
    id: "browser",
    label: "launch.browser",
    kbd: "Ctrl+T",
    icon: [
      "M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z",
      "M2.5 8h11",
      "M8 2.5c1.6 1.6 2.4 3.4 2.4 5.5S9.6 11.9 8 13.5C6.4 11.9 5.6 10.1 5.6 8S6.4 4.1 8 2.5z",
    ],
  },
  {
    id: "terminal",
    label: "launch.terminal",
    icon: ["M3 3h10a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z", "M4.8 6.2 6.8 8l-2 1.8", "M8.5 10h2.7"],
  },
]
</script>

<template>
  <aside class="launcher" :aria-label="t('key.sidePanel')">
    <div class="launcher-head" />
    <div class="launcher-list">
      <button
        v-for="tool in TOOLS"
        :key="tool.id"
        class="card"
        :data-tool="tool.id"
        :disabled="!available[tool.id]"
        @click="emit('pick', tool.id)"
      >
        <svg class="card-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path v-for="d in tool.icon" :key="d" :d="d" />
        </svg>
        <span class="card-name">{{ t(tool.label) }}</span>
        <kbd v-if="tool.kbd" class="card-kbd">{{ tool.kbd }}</kbd>
      </button>
    </div>
  </aside>
</template>

<style scoped>
/* MiMo's panel: 380 wide on its own surface, a 46px head the title bar's button sits over. */
.launcher {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  width: 380px;
  min-height: 0;
  background: var(--surface-raised);
  border-inline-start: 1px solid var(--border-weak);
}

.launcher-head {
  flex: none;
  height: 46px;
  -webkit-app-region: drag;
}

.launcher-list {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  overflow: auto;
}

.card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  color: var(--text-strong);
  text-align: start;
  background: transparent;
  border: 0;
  border-radius: 12px;
  font: inherit;
  cursor: default;
}

.card:hover:not(:disabled) {
  background: var(--surface-hover);
}

.card:disabled {
  opacity: 0.45;
}

.card-icon {
  flex: none;
  width: 16px;
  height: 16px;
  margin: 0 2px;
}

.card-icon path {
  stroke: currentColor;
  stroke-width: 1.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.card-name {
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 400;
  white-space: nowrap;
}

.card-kbd {
  margin-inline-start: auto;
  padding: 1px 6px;
  color: var(--text-weak);
  background: var(--surface-layer);
  border: 1px solid var(--border-weak);
  border-radius: 4px;
  font-family: inherit;
  font-size: calc(11px * var(--ui-font-scale, 1));
}
</style>
