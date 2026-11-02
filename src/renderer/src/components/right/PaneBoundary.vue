<script setup lang="ts">
import { onErrorCaptured, ref } from "vue"
import { t } from "../../lib/i18n"

/**
 * MiMo's error boundary around a right panel pane and the floating chat.
 *
 * A pane that throws while drawing is replaced by one inline strip - 渲染出错,
 * the message, and 重试 - instead of going blank, and the error goes no further
 * up. 重试 draws the pane again from scratch. `resetKey` is the tab's id, so a
 * strip never outlives the tab it belonged to.
 */
const props = defineProps<{ resetKey?: string }>()
const failure = ref<string>()
const generation = ref(0)
let failedFor: string | undefined

onErrorCaptured((error) => {
  failure.value = error instanceof Error ? error.message : String(error)
  failedFor = props.resetKey
  return false
})

function retry() {
  failure.value = undefined
  generation.value += 1
}
</script>

<template>
  <div class="pane-boundary">
    <div v-if="failure && failedFor === resetKey" class="pane-error" role="alert" data-pane-error>
      <span class="pe-title">{{ t("rp.error.inline") }}</span>
      <span class="pe-message" :title="failure">{{ failure }}</span>
      <button type="button" class="pe-retry" data-pane-retry @click="retry">{{ t("stream.retry") }}</button>
    </div>
    <div v-else :key="`${resetKey ?? ''}:${generation}`" class="pb-body">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.pane-boundary,
.pb-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.pb-body > :slotted(*) {
  flex: 1;
  min-height: 0;
}

/* MiMo's inline error: red-300 on red-50, 8 by 12 inside an 8px corner, no margin. */
.pane-error {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: #fef2f2;
  border: 1px solid #fca5a5;
  border-radius: 8px;
}

:root[data-theme="dark"] .pane-error {
  background: rgb(69 10 10 / 0.3);
  border-color: #991b1b;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .pane-error {
    background: rgb(69 10 10 / 0.3);
    border-color: #991b1b;
  }
}

.pe-title {
  flex: none;
  color: #dc2626;
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.pe-message {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: rgb(239 68 68 / 0.7);
  font-size: calc(12px * var(--ui-font-scale, 1));
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* MiMo's retry: at the strip's end, 6 round on the same red line over white. */
.pe-retry {
  flex: none;
  padding: 2px 8px;
  color: #dc2626;
  background: #ffffff;
  border: 1px solid #fca5a5;
  border-radius: 6px;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.pe-retry:hover {
  background: #fee2e2;
}

.pe-retry:focus-visible {
  outline: 2px solid var(--text-interactive);
  outline-offset: -2px;
}

:root[data-theme="dark"] .pe-title {
  color: #f87171;
}

:root[data-theme="dark"] .pe-message {
  color: rgb(248 113 113 / 0.5);
}

:root[data-theme="dark"] .pe-retry {
  color: #f87171;
  background: rgb(127 29 29 / 0.3);
  border-color: #b91c1c;
}

:root[data-theme="dark"] .pe-retry:hover {
  background: rgb(127 29 29 / 0.5);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .pe-title {
    color: #f87171;
  }

  :root:not([data-theme="light"]) .pe-message {
    color: rgb(248 113 113 / 0.5);
  }

  :root:not([data-theme="light"]) .pe-retry {
    color: #f87171;
    background: rgb(127 29 29 / 0.3);
    border-color: #b91c1c;
  }

  :root:not([data-theme="light"]) .pe-retry:hover {
    background: rgb(127 29 29 / 0.5);
  }
}
</style>
