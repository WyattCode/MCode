<script setup lang="ts">
import { computed } from "vue"
import "./steps.css"
import { t } from "../../lib/i18n"
import type { InlineError } from "../../lib/step-rows"

/**
 * An error the turn carried on past, where it happened among the steps.
 *
 * MiMo's 「错误：…」 row: a plain `!` in the icon column and the words in the
 * transcript's own colour. A failure that ends the turn keeps its card below.
 */
const props = defineProps<{ error: InlineError }>()

const text = computed(() => (props.error.errorCode ? t(props.error.errorCode, props.error.errorParams) : (props.error.error ?? "")))
</script>

<template>
  <div class="hstep hs-error" role="alert" data-step-error>
    <span class="hs-error-mark" aria-hidden="true">!</span>
    <div class="hs-body">
      <div class="hs-error-text">{{ t("stepList.errorPrefix", { text }) }}</div>
    </div>
  </div>
</template>
