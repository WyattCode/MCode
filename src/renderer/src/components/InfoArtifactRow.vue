<script setup lang="ts">
import type { SessionArtifact } from "../lib/session-info"
import { baseName } from "../lib/session-info"

/** One produced file in the info card: a 14px row with MiMo's type icon and the file's name. */
defineProps<{ artifact: SessionArtifact }>()
const emit = defineEmits<{ open: [artifact: SessionArtifact] }>()
</script>

<template>
  <button type="button" class="artifact" :title="artifact.path" :data-info-artifact="artifact.role" @click="emit('open', artifact)">
    <span class="kind" :data-kind="artifact.kind" aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <path d="M4 1.8h5.2L12.5 5v9.2H4z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
        <path d="M9 1.8V5.2h3.4" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
        <path v-if="artifact.kind === 'xlsx'" d="M5.8 8h4.9M5.8 10.4h4.9M8.2 7v5" stroke="currentColor" stroke-width="1" />
        <path v-else-if="artifact.kind === 'docx'" d="M5.8 8h4.9M5.8 10h4.9M5.8 12h3" stroke="currentColor" stroke-width="1" stroke-linecap="round" />
        <path v-else-if="artifact.kind === 'pptx'" d="M5.8 7.6h4.9v3.6H5.8z" stroke="currentColor" stroke-width="1" />
        <path v-else-if="artifact.kind === 'pdf'" d="M5.8 11.8V8h1.6a1.1 1.1 0 0 1 0 2.2H5.8" stroke="currentColor" stroke-width="1" stroke-linecap="round" />
        <path v-else-if="artifact.kind === 'html'" d="M7 8 5.6 9.6 7 11.2M9.4 8l1.4 1.6-1.4 1.6" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" />
        <path v-else-if="artifact.kind === 'image'" d="M5.4 12.2 7.6 9.6l1.5 1.6 1-1 1.4 2" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" />
        <path v-else-if="artifact.kind === 'video'" d="M7 8.2v3.6l3-1.8z" stroke="currentColor" stroke-width="1" stroke-linejoin="round" />
      </svg>
    </span>
    <span class="title">{{ baseName(artifact.path) }}</span>
  </button>
</template>

<style scoped>
/* MiMo's artifact row: a hit area 3 by 6 larger than its text, 7 round. */
.artifact {
  display: flex;
  align-items: center;
  gap: 7px;
  width: calc(100% + 12px);
  margin-block: -3px;
  margin-inline: -6px;
  padding-block: 3px;
  padding-inline: 6px;
  color: var(--text-base);
  background: transparent;
  border: 0;
  border-radius: 7px;
  font: inherit;
  font-size: calc(14px * var(--ui-font-scale, 1));
  text-align: start;
}

.artifact:hover {
  background: var(--surface-hover);
}

.artifact:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: 1px;
}

.kind {
  display: inline-grid;
  flex: none;
  place-items: center;
  width: 14px;
  height: 14px;
  color: var(--text-weak);
}

.title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
