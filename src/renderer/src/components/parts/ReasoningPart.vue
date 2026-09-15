<script setup lang="ts">
import type { ReasoningPart } from "@shared/protocol"

/*
 * MiMo draws no reasoning: its row for one returns nothing. The transcript no
 * longer mounts this; it stays, empty, only while the floating chat still
 * imports it, and goes once that stops.
 */
defineProps<{ part: ReasoningPart }>()
</script>

<template>
  <template v-if="false" />
</template>
