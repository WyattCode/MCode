<script setup lang="ts">
import { computed } from "vue"
import { PROVIDER_MARKS } from "../lib/provider-marks"
import { modelFamily, type ModelFamily } from "../lib/model"

/**
 * A model's mark in the composer's model menu, as MiMo draws it: the model's
 * family - not the provider serving it - as a 20px disc in the vendor colour
 * with the glyph in white, and anything else as its name's first letter on a
 * soft rounded square.
 */
const props = defineProps<{ id: string; name: string }>()

/* Each family's glyph (from the provider marks) and its disc. */
const BADGE: Record<ModelFamily, { mark: string; fill: string; glyph?: string }> = {
  claude: { mark: "anthropic", fill: "#d97757" },
  openai: { mark: "openai", fill: "#000000" },
  // White on white would vanish, so Gemini's glyph keeps its own colour on the white disc.
  gemini: { mark: "google", fill: "#ffffff", glyph: "#3186ff" },
  deepseek: { mark: "deepseek", fill: "#4d6bfe" },
  kimi: { mark: "moonshot", fill: "#000000" },
  glm: { mark: "zhipu", fill: "#3859ff" },
  minimax: { mark: "minimax", fill: "linear-gradient(135deg, #e2167e, #fe603c)" },
  qwen: { mark: "dashscope", fill: "#615ced" },
  hunyuan: { mark: "hunyuan", fill: "#0053e0" },
}

const badge = computed(() => {
  const family = modelFamily(props.id, props.name)
  const entry = family ? BADGE[family] : undefined
  const paths = entry ? PROVIDER_MARKS[entry.mark]?.paths : undefined
  return entry && paths ? { ...entry, paths } : undefined
})

const initial = computed(() => (props.name.trim() || props.id).slice(0, 1).toUpperCase())
</script>

<template>
  <span
    v-if="badge"
    class="model-mark disc"
    :data-family="modelFamily(id, name)"
    :style="{ background: badge.fill, color: badge.glyph ?? '#ffffff' }"
    aria-hidden="true"
  >
    <svg class="glyph" viewBox="0 0 24 24" fill="currentColor">
      <path
        v-for="(part, index) in badge.paths"
        :key="index"
        :d="part.d"
        :fill-opacity="part.fillOpacity"
        :clip-rule="part.clipRule"
        :fill-rule="part.fillRule"
      />
    </svg>
  </span>
  <span v-else class="model-mark letter" aria-hidden="true">{{ initial }}</span>
</template>

<style scoped>
.model-mark {
  display: grid;
  flex: none;
  place-items: center;
  width: 20px;
  height: 20px;
  /* MiMo's 8px after the mark, on top of the row's 9px gap: names start 17 past it. */
  margin-inline-end: 8px;
}

.disc {
  border-radius: 50%;
  /* Gemini's white disc needs an edge against a light menu. */
  box-shadow: inset 0 0 0 0.5px rgb(0 0 0 / 0.08);
}

.glyph {
  width: 12px;
  height: 12px;
}

/* MiMo's fallback: the first letter, 11/500 in its --color-txt, on a 6px-cornered square of the hover fill. */
.letter {
  color: var(--text-body);
  background: var(--surface-hover);
  border-radius: 6px;
  font-size: calc(11px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: 1;
}
</style>
