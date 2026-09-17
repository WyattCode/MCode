<script setup lang="ts">
import "./steps.css"
import { t } from "../../lib/i18n"

/**
 * MiMo's in-turn "i" row: a monospaced i in the icon column and a quiet
 * sentence from the app about the step above it - here, that a command asking
 * for input was not run. It sits in that step's group, like an error row.
 */
defineProps<{ textKey: string }>()
</script>

<template>
  <div class="hstep hs-notice" role="note" data-step-notice>
    <span class="hs-notice-mark" aria-hidden="true">i</span>
    <div class="hs-body hs-notice-text">{{ t(textKey) }}</div>
  </div>
</template>
