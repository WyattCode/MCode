<script setup lang="ts">
import { nextTick, ref, watch } from "vue"
import type { Effort, ModelInfo } from "@shared/protocol"
import { t } from "../lib/i18n"
import { effortFamily, effortLabelKey, isLatest, withoutLatest } from "../lib/model"
import { besideRow } from "../lib/submenu"
import ModelMark from "./ModelMark.vue"

/**
 * One model in the composer's model menu, as MiMo draws it: the model's
 * family mark, the name, and a check at the far end when it is the one in use.
 * A model with reasoning levels carries a chevron and opens them in a submenu
 * beside it - only the levels the model takes, named in the reader's language.
 */
const props = defineProps<{
  model: ModelInfo
  rowKey: string
  on: boolean
  hot: boolean
  /** The levels to offer; empty for no submenu. */
  efforts: Effort[]
  /** The level in use, when this is the model in use. */
  effort?: Effort
  subOpen: boolean
  /** The level the keyboard stands on inside the submenu. */
  effortHot?: Effort
}>()

const emit = defineEmits<{
  choose: []
  effort: [level: Effort]
  enter: []
  "effort-hover": [level: Effort]
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

/* MiMo's Claude 「高」 says it is the default; no other level does. */
function levelTitle(level: Effort): string | undefined {
  return level === "high" && effortFamily(props.model.id, props.model.name) === "claude" ? t("effort.default") : undefined
}
</script>

<template>
  <div ref="slot" class="slot" @mouseenter="emit('enter')">
    <button
      class="item model-item"
      tabindex="-1"
      :class="{ hot, on }"
      :data-key="rowKey"
      :aria-haspopup="efforts.length ? 'menu' : undefined"
      :aria-expanded="efforts.length ? subOpen : undefined"
      @click="emit('choose')"
    >
      <ModelMark :id="model.id" :name="model.name" />
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
        :key="entry"
        class="item model-item"
        tabindex="-1"
        :class="{ on: on && entry === effort, hot: entry === effortHot }"
        :data-effort="entry"
        :title="levelTitle(entry)"
        @mouseenter="emit('effort-hover', entry)"
        @click="emit('effort', entry)"
      >
        <span class="item-name">{{ t(effortLabelKey(model.id, model.name, entry)) }}</span>
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

/* MiMo's row: 13px, 6 by 10, 9 apart, an 11px corner. */
.item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-height: 32px;
  padding: 6px 10px;
  color: var(--text-strong);
  text-align: start;
  border-radius: 11px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 400;
  line-height: calc(20px * var(--ui-font-scale, 1));
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

.item-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tag {
  flex: none;
  padding: 0 5px;
  color: var(--text-weaker);
  border: 1px solid var(--border-weaker);
  border-radius: 4px;
  font-size: calc(10px * var(--ui-font-scale, 1));
  line-height: calc(15px * var(--ui-font-scale, 1));
}

svg path {
  stroke: currentColor;
  stroke-width: 1.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* MiMo's check is drawn in its send colour. */
.check {
  flex: none;
  width: 16px;
  height: 16px;
  color: var(--button-primary);
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

/* MiMo's submenu surface: 16 round, a half-pixel line, glass, 5 of padding, rows 1 apart. */
.sub {
  position: fixed;
  z-index: 70;
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 160px;
  padding: 5px;
  background: color-mix(in srgb, var(--surface-menu) 92%, transparent);
  border: 0.5px solid var(--border-weak);
  border-radius: 16px;
  box-shadow: var(--shadow-lg);
  backdrop-filter: blur(18px) saturate(150%);
  transform-origin: top left;
  animation: sub-in 0.15s ease-out;
}

@keyframes sub-in {
  from {
    opacity: 0;
    transform: translateX(-2px) scale(0.95);
  }
}

@media (prefers-reduced-motion: reduce) {
  .sub {
    animation: none;
  }
}
</style>
