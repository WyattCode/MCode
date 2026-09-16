<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, nextTick, ref } from "vue"
import { t } from "../lib/i18n"
import { isRovingKey } from "../lib/composer-menu"
import { focusRow } from "../lib/menu-keys"

/**
 * The application menu, drawn in the window.
 *
 * The window has no title bar of its own to hang a menu bar from, so the menu
 * the platform would have shown is opened from the bar's first button instead.
 * The items are the same ones the native menu carries - this is a second way
 * to reach them, not a second set.
 */
const emit = defineEmits<{ close: []; run: [command: string] }>()

/*
 * Which rows cannot do anything where the user is. The dispatcher already turns
 * them away, so without this they took the click and did nothing - which reads
 * as the menu being broken rather than the item being unavailable.
 */
const props = defineProps<{ x: number; y: number; disabled?: Set<string> }>()

interface Item {
  key: string
  label: string
  hint?: string
  divided?: boolean
}

interface Group {
  key: string
  label: string
  items: Item[]
}

const groups = computed<Group[]>(() => [
  {
    key: "file",
    label: t("menu.file"),
    items: [
      { key: "new-session", label: t("side.newTask"), hint: "Ctrl+N" },
      { key: "open-project", label: t("menu.openProject"), hint: "Ctrl+O" },
      { key: "settings", label: t("menu.settings"), hint: "Ctrl+," },
      { key: "close", label: t("menu.close"), divided: true },
      { key: "quit", label: t("menu.quit") },
    ],
  },
  {
    key: "edit",
    label: t("menu.edit"),
    items: [
      { key: "undo", label: t("menu.undo"), hint: "Ctrl+Z" },
      { key: "redo", label: t("menu.redo"), hint: "Ctrl+Y" },
      { key: "cut", label: t("edit.cut"), hint: "Ctrl+X", divided: true },
      { key: "copy", label: t("edit.copy"), hint: "Ctrl+C" },
      { key: "paste", label: t("edit.paste"), hint: "Ctrl+V" },
      { key: "delete", label: t("edit.delete") },
      { key: "selectAll", label: t("edit.selectAll"), hint: "Ctrl+A" },
    ],
  },
  {
    key: "view",
    label: t("menu.view"),
    items: [
      { key: "sidebar", label: t("menu.sidebar"), hint: "Ctrl+B", divided: true },
      { key: "terminal", label: t("menu.terminal"), hint: "Ctrl+`" },
      { key: "reload", label: t("menu.reload"), divided: true },
      { key: "devtools", label: t("menu.devTools") },
      { key: "zoom-reset", label: t("menu.resetZoom"), hint: "Ctrl+0", divided: true },
      { key: "zoom-in", label: t("menu.zoomIn"), hint: "Ctrl+=" },
      { key: "zoom-out", label: t("menu.zoomOut"), hint: "Ctrl+-" },
      { key: "fullscreen", label: t("menu.fullscreen"), divided: true },
    ],
  },
  {
    key: "session",
    label: t("key.groupConversation"),
    items: [
      { key: "abort", label: t("menu.stop"), hint: "Ctrl+." },
      { key: "model", label: t("menu.switchModel"), hint: "Ctrl+Shift+M" },
      { key: "delete-session", label: t("menu.delete"), divided: true },
    ],
  },
  {
    key: "go",
    label: t("menu.go"),
    items: [
      { key: "back", label: t("menu.back"), hint: "Ctrl+[" },
      { key: "forward", label: t("menu.forward"), hint: "Ctrl+]" },
      { key: "prev-session", label: t("conv.prev"), hint: "Alt+Up", divided: true },
      { key: "next-session", label: t("conv.next"), hint: "Alt+Down" },
      { key: "prev-project", label: t("menu.prevProject"), hint: "Ctrl+Alt+Up", divided: true },
      { key: "next-project", label: t("menu.nextProject"), hint: "Ctrl+Alt+Down" },
    ],
  },
  {
    key: "window",
    label: t("menu.window"),
    items: [
      { key: "minimize", label: t("menu.minimize") },
      { key: "maximize", label: t("menu.zoom") },
      { key: "close", label: t("menu.close") },
    ],
  },
  {
    /*
     * opencode's Help menu is five links into its own documentation, forum and
     * issue tracker. MCode has none of those, and pointing its Help menu at
     * another product's would be worse than having no menu - so this carries
     * the two things MCode can actually answer.
     */
    key: "help",
    label: t("rail.help"),
    items: [
      { key: "shortcuts", label: t("set.shortcuts") },
      { key: "check-updates", label: t("update.check") },
    ],
  },
])

/** Which group's submenu is showing, and where its panel should sit. */
const open = ref<string>()
const panel = ref<HTMLElement>()
const submenuTop = ref(0)

async function show(group: string, event: MouseEvent) {
  await showFrom(event.currentTarget as HTMLElement, group)
}

/** Opens the group a row stands for, wherever the row came from. */
async function showFrom(row: HTMLElement, group = row.dataset.group) {
  if (!group) return
  open.value = group
  const host = panel.value?.getBoundingClientRect()
  const rect = row.getBoundingClientRect()
  await nextTick()
  submenuTop.value = host ? rect.top - host.top : 0
}

function pick(item: Item) {
  emit("run", item.key)
  emit("close")
}

function onKey(event: KeyboardEvent) {
  const rows = [...(panel.value?.querySelectorAll<HTMLElement>(".row") ?? [])]
  const items = [...(panel.value?.querySelectorAll<HTMLButtonElement>(".sub .item:not(:disabled)") ?? [])]
  const active = document.activeElement as HTMLElement | null
  const inSub = Boolean(active && items.includes(active as HTMLButtonElement))

  if (event.key === "Escape") {
    // The submenu closes first: one Escape per level, as a menu does.
    if (open.value) {
      const row = rows.find((entry) => entry.dataset.group === open.value)
      open.value = undefined
      row?.focus()
      return
    }
    emit("close")
    return
  }

  if (isRovingKey(event.key)) {
    const walk: HTMLElement[] = inSub ? items : rows
    if (!walk.length) return
    event.preventDefault()
    // Wraps at either end; Home and End jump there.
    focusRow(walk, event.key)
    // Focusing a group opens it, the same way hovering one does.
    if (!inSub && document.activeElement instanceof HTMLElement) showFrom(document.activeElement)
    return
  }

  if ((event.key === "ArrowRight" || event.key === "Enter") && !inSub && active?.classList.contains("row")) {
    event.preventDefault()
    showFrom(active)
    void nextTick(() => panel.value?.querySelector<HTMLButtonElement>(".sub .item:not(:disabled)")?.focus())
    return
  }

  if (event.key === "ArrowLeft" && inSub) {
    event.preventDefault()
    rows.find((entry) => entry.dataset.group === open.value)?.focus()
  }
}

onMounted(() => document.addEventListener("keydown", onKey))
onBeforeUnmount(() => document.removeEventListener("keydown", onKey))
</script>

<template>
  <div class="scrim" @mousedown="emit('close')" @wheel="emit('close')" />

  <div ref="panel" class="menu" :style="{ insetInlineStart: `${props.x}px`, top: `${props.y}px` }">
    <div class="brand">MCode</div>

    <div
      v-for="group in groups"
      :key="group.key"
      class="row"
      :class="{ on: open === group.key }"
      :data-group="group.key"
      tabindex="-1"
      @mouseenter="show(group.key, $event)"
      @click="show(group.key, $event)"
    >
      <span>{{ group.label }}</span>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M6.5 5L9.5 8L6.5 11" stroke="currentColor" stroke-width="1" />
      </svg>
    </div>

    <div v-if="open" class="sub" :style="{ top: `${submenuTop}px` }" @mouseleave="open = undefined">
      <template v-for="item in groups.find((g) => g.key === open)?.items ?? []" :key="item.key">
        <div v-if="item.divided" class="rule" />
        <button class="item" :disabled="props.disabled?.has(item.key)" @click="pick(item)">
          <span class="item-label">{{ item.label }}</span>
          <span v-if="item.hint" class="keys">{{ item.hint }}</span>
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 320;
}

.menu {
  position: fixed;
  z-index: 321;
  min-width: 160px;
  width: 160px;
  padding: 2px;
  background: var(--surface-menu);
  border-radius: 6px;
  box-shadow: var(--shadow-lg);
}

/* Names the app the menu belongs to, the way the platform's own menu does. */
.brand {
  display: flex;
  align-items: center;
  height: 28px;
  padding: 0 12px;
  color: var(--text-weak);
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 530;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 28px;
  padding: 0 12px;
  color: var(--text-strong);
  border-radius: 4px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  cursor: default;
}

.row:hover,
.row.on {
  background: var(--surface-hover);
}

.row svg {
  flex-shrink: 0;
  margin-inline-end: -4px;
  color: var(--icon-base);
}

/*
 * Opens beside the row it belongs to rather than below it, which is what keeps
 * the parent list readable while a submenu is showing.
 */
.sub {
  position: absolute;
  inset-inline-start: calc(100% + 4px);
  width: max-content;
  min-width: 240px;
  max-width: min(320px, calc(100vw - 24px));
  padding: 2px;
  background: var(--surface-menu);
  border-radius: 6px;
  box-shadow: var(--shadow-lg);
}

/* Unavailable where the user is: dimmed, and not a hover target. */
.item:disabled {
  color: var(--text-weaker);
}

.item:disabled:hover {
  background: none;
}

.item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  width: 100%;
  height: 28px;
  padding: 0 12px;
  color: var(--text-strong);
  border-radius: 4px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  text-align: start;
}

.item:hover {
  background: var(--surface-hover);
}

.item-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/*
 * A menu spells its shortcut out rather than drawing key caps. Caps are for
 * teaching a key; this menu is read by someone who already knows it, and the
 * reference draws it as plain text for that reason.
 */
.keys {
  flex-shrink: 0;
  margin-inline-start: auto;
  color: var(--text-weak);
  white-space: nowrap;
}

.rule {
  height: 1px;
  width: calc(100% + 4px);
  margin: 2px -2px;
  background: var(--border-muted);
}
</style>
