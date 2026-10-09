<script setup lang="ts">
import { computed } from "vue"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"
import type { OperationKind } from "@shared/operation-kind"
const props = defineProps<{ sessionId: string; working: boolean }>()
const app = useApp()
const kinds = computed(() => {
  if (!props.working) return []
  const kinds = new Set<OperationKind>()
  for (const [id, operations] of app.appOperations) {
    if (app.rootOf(id) !== props.sessionId) continue
    for (const kind of operations.values()) kinds.add(kind)
  }
  return [...kinds].sort()
})
</script>
<template>
  <span v-if="kinds.length" class="operation-badges" :data-operation-badges="sessionId">
    <span v-for="kind in kinds" :key="kind" role="img" :aria-label="t(`side.operation.${kind}`)" :data-operation-kind="kind" v-tip="{ label: t(`side.operation.${kind}`), placement: 'top' }">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
        <template v-if="kind === 'computer'"><rect x="1.5" y="2" width="13" height="9" rx="1.5" /><path d="M8 11v3M4.5 14h7" /></template>
        <template v-else><circle cx="8" cy="8" r="6" /><ellipse cx="8" cy="8" rx="2.5" ry="6" /><path d="M2 8h12" /></template>
      </svg>
    </span>
  </span>
</template>
<style scoped>
.operation-badges { display: inline-flex; gap: 4px; align-self: center; margin-inline: 4px; color: var(--text-weak); }
.operation-badges > span { display: flex; }
</style>
