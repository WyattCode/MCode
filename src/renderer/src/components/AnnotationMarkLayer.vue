<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue"

/**
 * MiMo's in-document annotation marks: for each annotation, a 2px frame on a
 * faint fill over every line of its passage, and its number on the first
 * line's top-left corner (7 out, kept 6 inside the layer). A flashed one fills
 * more and its number grows with a ring. A batch just sent carries number 0:
 * frames without a number. Over a spreadsheet the frames are MiMo's cell
 * marks instead: 1px on a 10% fill, round 2, the number not kept inside.
 */
export interface MarkItem {
  id: string
  num: number
  rects: { left: number; top: number; w: number; h: number }[]
}

const props = defineProps<{ items: MarkItem[]; flashId: string | null; cells?: boolean }>()

const layer = ref<HTMLElement>()
const size = ref({ w: 0, h: 0 })
const observer = new ResizeObserver(() => {
  if (layer.value) size.value = { w: layer.value.clientWidth, h: layer.value.clientHeight }
})
onMounted(() => {
  if (!layer.value) return
  observer.observe(layer.value)
  size.value = { w: layer.value.clientWidth, h: layer.value.clientHeight }
})
onBeforeUnmount(() => observer.disconnect())

function badgeAt(rect: { left: number; top: number }) {
  if (props.cells) return { left: `${rect.left - 7}px`, top: `${rect.top - 7}px` }
  return {
    left: `${Math.min(Math.max(6, rect.left - 7), Math.max(6, size.value.w - 15 - 6))}px`,
    top: `${Math.min(Math.max(6, rect.top - 7), Math.max(6, size.value.h - 15 - 6))}px`,
  }
}
</script>

<template>
  <div ref="layer" class="mark-layer" aria-hidden="true">
    <template v-for="item in items" :key="item.id">
      <div
        v-for="(rect, at) in item.rects"
        :key="`${item.id}-${at}`"
        class="mark"
        :class="{ flash: item.id === flashId, cell: cells }"
        :data-ann-marker="item.num"
        :style="{ left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.w}px`, height: `${rect.h}px` }"
      />
    </template>
    <template v-if="size.w > 0">
      <template v-for="item in items" :key="`${item.id}-badge`">
        <span v-if="item.rects[0] && item.num > 0" class="badge" :class="{ flash: item.id === flashId }" :data-ann-marker-badge="item.num" :style="badgeAt(item.rects[0])">
          {{ item.num }}
        </span>
      </template>
    </template>
  </div>
</template>

<style scoped>
.mark-layer {
  position: absolute;
  inset: 0;
  z-index: 6;
  pointer-events: none;
}

.mark {
  position: absolute;
  box-sizing: border-box;
  background: rgba(50, 149, 251, 0.08);
  border: 2px solid #3295fb;
  border-radius: 3px;
  pointer-events: none;
}

.mark.flash {
  background: rgba(50, 149, 251, 0.22);
}

.mark.cell {
  background: rgba(50, 149, 251, 0.1);
  border-width: 1px;
  border-radius: 2px;
}

.badge {
  position: absolute;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  min-width: 15px;
  height: 15px;
  padding: 0 3px;
  color: #fff;
  background: #3295fb;
  border-radius: 999px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  pointer-events: none;
}

.badge.flash {
  transform: scale(1.25);
  box-shadow: 0 0 0 4px rgba(50, 149, 251, 0.35);
}
</style>
