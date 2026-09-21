<script setup lang="ts">
import { computed } from "vue"
import { providerColor, providerMonogram, providerPaths } from "../lib/provider-icon"

/**
 * The mark shown against a provider wherever one is listed.
 *
 * One component so the settings list, the connect dialog and the model menu
 * cannot end up showing the same vendor three different ways.
 */
const props = defineProps<{
  id: string
  name: string
  /** Larger, for a dialog heading rather than a list row. */
  big?: boolean
}>()

const paths = computed(() => providerPaths(props.id))
const text = computed(() => providerMonogram(props.name))
const color = computed(() => providerColor(props.id))
</script>

<template>
  <span class="mark" :class="{ big }" :style="{ color }" aria-hidden="true">
    <!-- Every mark is drawn on a 24x24 grid, in the current colour. -->
    <svg v-if="paths" class="glyph" viewBox="0 0 24 24" fill="currentColor">
      <path
        v-for="(part, index) in paths"
        :key="index"
        :d="part.d"
        :fill-opacity="part.fillOpacity"
        :clip-rule="part.clipRule"
        :fill-rule="part.fillRule"
      />
    </svg>
    <!-- A custom provider is a base URL someone typed; there is no logo. -->
    <template v-else>{{ text }}</template>
  </span>
</template>

<style scoped>
.mark {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: calc(26px * var(--ui-font-scale, 1));
  height: calc(26px * var(--ui-font-scale, 1));
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  /* Sized to sit level with a drawn mark rather than to fit the box. */
  font-size: calc(15px * var(--ui-font-scale, 1));
  font-weight: 530;
  line-height: 1;
}

.glyph {
  width: 18px;
  height: 18px;
}

.mark.big {
  width: calc(30px * var(--ui-font-scale, 1));
  height: calc(30px * var(--ui-font-scale, 1));
  font-size: calc(17px * var(--ui-font-scale, 1));
}

.mark.big .glyph {
  width: 20px;
  height: 20px;
}
</style>
