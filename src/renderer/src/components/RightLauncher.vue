<script setup lang="ts">
import { computed, ref } from "vue"
import type { MenuItem } from "../lib/menu"
import ContextMenu from "./ContextMenu.vue"
import PanelExpand from "./PanelExpand.vue"
import { t } from "../lib/i18n"

/**
 * MiMo's side panel with nothing chosen yet: a card for each thing it can hold.
 *
 * Review and files open the review panel on that tab, side chat opens the
 * conversation's side chat, browser a page, terminal the drawer under the
 * conversation. A card for something the current screen cannot hold - the
 * review on the home screen, say - stays in its place, greyed, rather than
 * leaving a gap that changes from screen to screen.
 *
 * Its head is MiMo's panel head: a plus at the start that lists the same tools
 * in a menu, and at the end the button that expands the panel over the main
 * column and puts it back.
 */
type Tool = "review" | "files" | "chat" | "browser" | "terminal"

const props = defineProps<{ available: Record<Tool, boolean>; full?: boolean }>()
const emit = defineEmits<{ pick: [tool: Tool]; fullscreen: [] }>()

const TOOLS: { id: Tool; label: string; kbd?: string; icon: string[] }[] = [
  {
    id: "review",
    label: "launch.review",
    icon: [
      "M8.5 13.5H4A1.5 1.5 0 0 1 2.5 12V4A1.5 1.5 0 0 1 4 2.5h8A1.5 1.5 0 0 1 13.5 4v3.5",
      "M5 5.5h6M5 8h3",
      "M11 9a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
      "M12.5 12.5 14 14",
    ],
  },
  {
    id: "files",
    label: "launch.files",
    kbd: "Ctrl+P",
    icon: [
      "M8.2 12.9H3c-.6 0-1.1-.5-1.1-1.1V4.2c0-.6.5-1.1 1.1-1.1h2.6l1.3 1.5h6.1c.6 0 1.1.5 1.1 1.1v2",
      "M11 8.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
      "M12.5 12 14 13.5",
    ],
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

/* The plus's menu, opened under the button the way MiMo drops it from the head. */
const addMenu = ref<{ x: number; y: number }>()

function openAdd(event: MouseEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  addMenu.value = { x: rect.left, y: rect.bottom + 4 }
}

const addItems = computed<MenuItem[]>(() =>
  TOOLS.map((tool) => ({
    key: tool.id,
    label: t(tool.label),
    icon: tool.icon.join(" "),
    hint: tool.kbd,
    enabled: props.available[tool.id],
  })),
)

function pickAdd(key: string) {
  addMenu.value = undefined
  emit("pick", key as Tool)
}
</script>

<template>
  <aside class="launcher" :aria-label="t('key.sidePanel')">
    <div class="launcher-head">
      <button
        type="button"
        class="head-add"
        data-launcher-add
        :aria-label="t('launch.newTool')"
        v-tip="{ label: t('launch.newTool'), placement: 'bottom' }"
        @click="openAdd"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
      <span class="head-spacer" />
      <PanelExpand :full="full" @toggle="emit('fullscreen')" />
    </div>
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

    <ContextMenu v-if="addMenu" :x="addMenu.x" :y="addMenu.y" :items="addItems" @pick="pickAdd" @close="addMenu = undefined" />
  </aside>
</template>

<style scoped>
/* MiMo's panel: 380 wide on its own surface. */
.launcher {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  width: 380px;
  min-height: 0;
  background: var(--surface-raised);
  border-inline-start: 1px solid var(--border-weak);
}

/*
 * MiMo's rp-head: 46 tall with its row four down, 10 in from the start, and at
 * the end clear of the caption buttons and the side panel toggle over it, so
 * the expand button ends 4px before that toggle.
 */
.launcher-head {
  display: flex;
  flex: none;
  box-sizing: border-box;
  align-items: center;
  gap: 4px;
  height: 46px;
  padding-block: 4px 0;
  padding-inline: 10px calc(37px + 100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw));
  -webkit-app-region: drag;
}

.head-spacer {
  flex: 1;
  min-width: 0;
}

/* The plus: MiMo's 26px icon button in the muted colour. */
.head-add {
  display: grid;
  flex: none;
  place-items: center;
  width: 26px;
  height: 26px;
  padding: 0;
  color: var(--text-weak);
  background: transparent;
  border: 0;
  border-radius: 7px;
  -webkit-app-region: no-drag;
}

.head-add:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.launcher-list {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  overflow: auto;
}

/* MiMo's launch-card: 14 by 16 of padding on a 22px line, 12 between icon, name and key. */
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
  line-height: 22px;
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

/* MiMo draws these on a 24 grid at a 2 stroke; at 16px that is a third less than one and a half. */
.card-icon path {
  stroke: currentColor;
  stroke-width: 1.33;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.card-name {
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 400;
  white-space: nowrap;
}

/* MiMo's key cap: 11px in the dim colour, 1 by 5 of padding inside a 1px line on a 5px corner. */
.card-kbd {
  margin-inline-start: auto;
  padding: 1px 5px;
  color: var(--text-weak);
  background: var(--surface-layer);
  border: 1px solid var(--border-weak);
  border-radius: 5px;
  font-family: inherit;
  font-size: calc(11px * var(--ui-font-scale, 1));
  line-height: 17px;
}
</style>
