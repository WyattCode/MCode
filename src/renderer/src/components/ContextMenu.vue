<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue"
import type { MenuItem } from "../lib/menu"

/**
 * The right-click menu, wherever one is wanted.
 *
 * Three panels grew one of these independently, and each had to solve the same
 * things: staying on screen near an edge, closing on a click elsewhere or on
 * Escape, and sitting above every other layer. Those belong in one place; what
 * differs between them is only the list of actions.
 */
const props = defineProps<{
  x: number
  y: number
  items: MenuItem[]
  /** Opened from the keyboard, so it should take focus and be navigable. */
  keyboard?: boolean
}>()
const emit = defineEmits<{ pick: [key: string]; close: [] }>()

const box = ref<HTMLElement>()
const at = ref({ x: props.x, y: props.y })

onMounted(async () => {
  // Measured rather than guessed: the width depends on the language.
  await nextTick()
  const rect = box.value?.getBoundingClientRect()
  if (!rect) return
  const margin = 8
  /*
   * Flipped to the other side of the pointer rather than merely pushed back,
   * so the pointer never lands on top of the first item.
   */
  if (at.value.x + rect.width > window.innerWidth - margin) {
    at.value.x = Math.max(margin, at.value.x - rect.width)
  }
  if (at.value.y + rect.height > window.innerHeight - margin) {
    at.value.y = Math.max(margin, window.innerHeight - margin - rect.height)
  }

  // Only when the keyboard opened it: taking focus from a text field would
  // leave the editing commands acting on this menu instead.
  if (props.keyboard) box.value?.querySelector<HTMLButtonElement>(".item:not(:disabled)")?.focus()
})

function onKey(event: KeyboardEvent) {
  if (event.key === "Escape") {
    emit("close")
    return
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return

  const items = [...(box.value?.querySelectorAll<HTMLButtonElement>(".item:not(:disabled)") ?? [])]
  if (!items.length) return
  event.preventDefault()
  const at = items.indexOf(document.activeElement as HTMLButtonElement)
  const step = event.key === "ArrowDown" ? 1 : -1
  // Wraps, which is what a menu does at either end.
  items[(at + step + items.length) % items.length].focus()
}

onMounted(() => document.addEventListener("keydown", onKey))
onBeforeUnmount(() => document.removeEventListener("keydown", onKey))
</script>

<template>
  <!-- Closes on any click, takes the next right-click, and leaves nothing behind. -->
  <div class="scrim" @mousedown="emit('close')" @contextmenu.prevent="emit('close')" @wheel="emit('close')" />
  <div ref="box" class="menu" :style="{ left: `${at.x}px`, top: `${at.y}px` }">
    <template v-for="item in items" :key="item.key">
      <div v-if="item.divided" class="rule" />
      <div v-if="item.heading" class="heading">{{ item.label }}</div>
      <button
        v-else
        class="item"
        :class="{ ticked: item.checked }"
        :disabled="item.enabled === false"
        @mousedown.prevent
        @click="emit('pick', item.key)"
      >
        <span class="tick" aria-hidden="true">
          <svg v-if="item.checked" width="12" height="12" viewBox="0 0 20 20" fill="none">
            <path d="M4.5 10.5L8 14L15.5 6.5" stroke="currentColor" stroke-linecap="square" />
          </svg>
        </span>
        {{ item.label }}
      </button>
    </template>
  </div>
</template>

<style scoped>
/*
 * Above every other layer, tooltips included: this is opened by the user at a
 * moment of their choosing and has to be reachable wherever it lands.
 */
.scrim {
  position: fixed;
  inset: 0;
  z-index: 320;
}

.menu {
  position: fixed;
  z-index: 321;
  min-width: 160px;
  padding: 2px;
  /*
   * No border at all: the floating shadow ends in a half-pixel light ring, and
   * that ring is the edge. Drawing one on top of it framed the menu twice.
   */
  background: var(--surface-menu);
  border-radius: 6px;
  box-shadow: var(--shadow-md);
}

/* A group's name, the way opencode's DropdownMenu.GroupLabel reads. */
.heading {
  padding: 6px 10px 2px;
  color: var(--text-weak);
  font-size: 12px;
  font-weight: 500;
}

/*
 * The tick column is drawn only in a menu that has something ticked - an
 * ordinary menu has no `checked` on any item, so `.tick` collapses and every
 * label keeps the inset it had.
 */
.tick {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 0;
  margin-inline-end: 0;
  overflow: hidden;
  color: var(--text-strong);
  transition: none;
}

.item.ticked .tick,
.menu:has(.ticked) .tick {
  width: 14px;
  margin-inline-end: 4px;
}

.item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 28px;
  padding: 0 12px;
  color: var(--text-strong);
  text-align: start;
  border-radius: 4px;
  font-size: 13px;
  font-weight: 440;
  letter-spacing: -0.04px;
}

.item:hover:not(:disabled) {
  background: var(--surface-hover);
}

.item:disabled {
  opacity: 0.5;
  pointer-events: none;
}

.item:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: -2px;
}

/* Drawn out past the panel's padding, so it divides the whole menu. */
.rule {
  height: 1px;
  width: calc(100% + 4px);
  margin: 2px -2px;
  background: var(--border-muted);
}
</style>
