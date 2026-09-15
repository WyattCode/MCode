<script setup lang="ts">
import StepIcon from "./StepIcon.vue"
import "./steps.css"
import { t } from "../../lib/i18n"

/**
 * MiMo's in-turn reconnecting row: 「正在重新连接 2」, the attempt alone in the
 * dim colour, then 「· 」 and why it is retrying when the attempt says. The
 * reason is cut to the row's width with the whole of it on hover. Not a
 * countdown and not expandable; it goes as soon as the stream resumes.
 */
defineProps<{ attempt: number; reason?: string }>()
</script>

<template>
  <div class="hstep" role="status" data-harness-retry>
    <span class="hs-ic tall mut"><StepIcon name="reconnect" /></span>
    <span class="hs-retry-label">
      <span>{{ t("harnessRow.reconnecting") }}</span>
      <span class="hs-retry-count" data-retry-attempt>{{ attempt }}</span>
      <template v-if="reason">
        <span class="hs-retry-dot" aria-hidden="true">·</span>
        <span class="hs-retry-reason" v-tip="reason" data-retry-reason>{{ reason }}</span>
      </template>
    </span>
  </div>
</template>
