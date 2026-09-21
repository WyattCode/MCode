<script setup lang="ts">
import DiffBody from "./DiffBody.vue"

/**
 * A patch inside a turn's step, and inside a permission card.
 *
 * MiMo draws the same diff component here as in the 审阅 tab, only unfilled, so
 * a multi-file patch is split per file with its own header and counts and the
 * cap note instead of running together as one list of lines. A step hands over
 * its project, and its headers then name each file in full, as MiMo's do.
 */
defineProps<{ diff: string; root?: string }>()
</script>

<template>
  <DiffBody :diff="diff" :root="root" />
</template>
