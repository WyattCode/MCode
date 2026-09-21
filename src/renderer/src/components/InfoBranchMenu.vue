<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { t } from "../lib/i18n"
import { onMenuRowKey } from "../lib/menu-keys"

/**
 * The info card's branch dropdown, after MiMo's non-modal menu: the local
 * branches with a check beside the current one, read afresh each time it opens.
 *
 * Put on the page's own layer, because the card scrolls and would clip it.
 * Marked `data-info-popover` so a click inside it does not count as a click
 * outside the floating card.
 */
const props = defineProps<{ anchor?: HTMLElement; branches: string[]; current?: string; loading: boolean }>()
const emit = defineEmits<{ pick: [branch: string]; close: [] }>()

const menu = ref<HTMLElement>()
const place = ref({ top: 0, left: 0, minWidth: 200 })

/* From getBoundingClientRect, which is physical; below the row, or above it when there is no room. */
function position() {
  const rect = props.anchor?.getBoundingClientRect()
  if (!rect) return
  const height = menu.value?.offsetHeight ?? 0
  const width = menu.value?.offsetWidth ?? 200
  let top = rect.bottom + 4
  if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - 4 - height)
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - 8 - width))
  place.value = { top, left, minWidth: Math.max(200, Math.round(rect.width)) }
}

watch(
  () => [props.loading, props.branches.length],
  () => void nextTick(position),
)

/* MiMo's menu takes focus on its first row once there are rows to take it. */
watch(
  () => props.loading,
  async (loading) => {
    if (loading) return
    await nextTick()
    rows()[0]?.focus({ preventScroll: true })
  },
  { immediate: true },
)

function rows(): HTMLElement[] {
  return [...(menu.value?.querySelectorAll<HTMLElement>("button.item:not(:disabled)") ?? [])]
}

function onPointerDown(event: MouseEvent) {
  const target = event.target as Node | null
  if (!target || menu.value?.contains(target) || props.anchor?.contains(target)) return
  emit("close")
}

/* On the capture pass, so the card underneath never also reads this Escape as its own. */
function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape" || event.isComposing) return
  event.preventDefault()
  event.stopPropagation()
  emit("close")
}

const onResize = () => emit("close")

onMounted(() => {
  position()
  void nextTick(position)
  window.addEventListener("mousedown", onPointerDown, true)
  window.addEventListener("keydown", onKeydown, true)
  window.addEventListener("resize", onResize)
})
onBeforeUnmount(() => {
  window.removeEventListener("mousedown", onPointerDown, true)
  window.removeEventListener("keydown", onKeydown, true)
  window.removeEventListener("resize", onResize)
})
</script>

<template>
  <Teleport to="body">
    <div
      ref="menu"
      class="menu"
      role="menu"
      data-info-popover
      data-info-branch-menu
      :style="{ top: `${place.top}px`, left: `${place.left}px`, minWidth: `${place.minWidth}px` }"
      @keydown="onMenuRowKey($event, rows())"
    >
      <div v-if="loading" class="item muted" role="menuitem" aria-disabled="true" data-info-branch-loading>
        {{ t("info.loadingBranches") }}
      </div>
      <template v-else>
        <button
          v-for="branch in branches"
          :key="branch"
          type="button"
          class="item"
          role="menuitemradio"
          :aria-checked="branch === current"
          :data-info-branch-item="branch"
          @click="emit('pick', branch)"
        >
          <span class="slot">
            <svg v-if="branch === current" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3.5 8.2 6.4 11.1 12.5 5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </span>
          <span class="name">{{ branch }}</span>
        </button>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.menu {
  position: fixed;
  z-index: 120;
  max-width: min(320px, 100vw - 16px);
  max-height: min(300px, 100vh - 16px);
  padding: 5px;
  overflow-y: auto;
  background: color-mix(in srgb, var(--surface-menu) 92%, transparent);
  border: 0.5px solid var(--border-weak);
  border-radius: 12px;
  box-shadow: var(--shadow-lg);
  backdrop-filter: blur(18px) saturate(150%);
}

.item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  padding-block: 6px;
  padding-inline: 8px;
  color: var(--text-strong);
  background: transparent;
  border: 0;
  border-radius: 8px;
  font: inherit;
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: calc(18px * var(--ui-font-scale, 1));
  text-align: start;
}

.item:hover:not(.muted),
.item:focus-visible {
  background: var(--surface-hover);
  outline: none;
}

.muted {
  color: var(--text-weak);
}

.slot {
  display: inline-grid;
  flex: none;
  place-items: center;
  width: 14px;
  height: 14px;
}

.name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
