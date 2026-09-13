<script setup lang="ts">
import { nextTick, ref, watch } from "vue"
import type { Effort, ModelInfo } from "@shared/protocol"
import { t } from "../lib/i18n"
import { isLatest, withoutLatest } from "../lib/model"
import { besideRow } from "../lib/submenu"
import ProviderIcon from "./ProviderIcon.vue"

/**
 * One model in the composer's model menu, as MiMo draws it: the provider's
 * mark, the name, and a check at the far end when it is the one in use. A model
 * with reasoning levels carries a chevron and opens them in a submenu beside it.
 */
const props = defineProps<{
  model: ModelInfo
  provider: { id: string; name: string }
  rowKey: string
  on: boolean
  hot: boolean
  /** The levels to offer, "follow the default" first; empty for no submenu. */
  efforts: (Effort | undefined)[]
  /** The level in use, when this is the model in use. */
  effort?: Effort
  subOpen: boolean
}>()

const emit = defineEmits<{
  choose: []
  effort: [level: Effort | undefined]
  enter: []
}>()

const slot = ref<HTMLElement>()
const sub = ref<HTMLElement>()
const place = ref({ left: 0, top: 0 })

watch(
  () => props.subOpen,
  async (open) => {
    if (!open) return
    await nextTick()
    const row = slot.value?.getBoundingClientRect()
    if (!row || !sub.value) return
    place.value = besideRow(row, sub.value.offsetWidth, sub.value.offsetHeight)
  },
  { immediate: true },
)
</script>

<template>
  <div ref="slot" class="slot" @mouseenter="emit('enter')">
    <button
      class="item model-item"
      :class="{ hot, on }"
      :data-key="rowKey"
      :aria-haspopup="efforts.length ? 'menu' : undefined"
      :aria-expanded="efforts.length ? subOpen : undefined"
      @click="emit('choose')"
    >
      <ProviderIcon :id="provider.id" :name="provider.name" class="model-mark" />
      <span class="item-name">{{ withoutLatest(model.name) }}</span>
      <span v-if="isLatest(model.name)" class="tag">{{ t("model.tag.latest") }}</span>
      <svg class="check" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M3.5 8.2 6.4 11.1 12.5 5" />
      </svg>
      <svg v-if="efforts.length" class="chev" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M6.5 4.5 10 8l-3.5 3.5" />
      </svg>
    </button>
    <div
      v-if="subOpen && efforts.length"
      ref="sub"
      class="sub"
      role="menu"
      :style="{ left: `${place.left}px`, top: `${place.top}px` }"
    >
      <button
        v-for="entry in efforts"
        :key="entry ?? 'default'"
        class="item model-item"
        :class="{ on: on && entry === effort }"
        :data-effort="entry ?? 'default'"
        @click="emit('effort', entry)"
      >
        <span class="item-name" :class="{ level: entry }">{{ entry ?? t("effort.default") }}</span>
        <svg class="check" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3.5 8.2 6.4 11.1 12.5 5" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.slot {
  position: relative;
}

.item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-height: 32px;
  padding: 6px 10px;
  color: var(--text-strong);
  text-align: start;
  border-radius: 8px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 400;
  line-height: 20px;
  cursor: default;
}

.item:hover,
.item.hot {
  background: var(--surface-hover);
}

.item.on {
  background: var(--surface-selected);
}

.item:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: -2px;
}

/* MiMo's 20px mark with a 6px corner, in place of the provider list's larger one. */
.model-mark {
  width: 20px;
  height: 20px;
  border-radius: 6px;
  font-size: calc(11px * var(--ui-font-scale, 1));
}

.model-mark :deep(.glyph) {
  width: 14px;
  height: 14px;
}

.item-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.level {
  text-transform: capitalize;
}

.tag {
  flex: none;
  padding: 0 5px;
  color: var(--text-weaker);
  border: 1px solid var(--border-weaker);
  border-radius: 4px;
  font-size: calc(10px * var(--ui-font-scale, 1));
  line-height: 15px;
}

svg path {
  stroke: currentColor;
  stroke-width: 1.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.check {
  flex: none;
  width: 16px;
  height: 16px;
  color: var(--text-strong);
  opacity: 0;
}

.item.on .check {
  opacity: 1;
}

.chev {
  flex: none;
  width: 14px;
  height: 14px;
  opacity: 0.5;
}

.sub {
  position: fixed;
  z-index: 70;
  min-width: 160px;
  padding: 4px;
  background: var(--surface-menu);
  border: 0.5px solid var(--border-weak);
  border-radius: 12px;
  box-shadow: var(--shadow-lg);
}
</style>
