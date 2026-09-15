<script setup lang="ts">
import { onErrorCaptured, ref, watch } from "vue"
import { t } from "../lib/i18n"

/**
 * MiMo's per-region error boundary.
 *
 * A region that fails to render shows a short red strip in its own place -
 * 渲染出错 and the message - instead of the whole window giving way to the
 * fatal error page. It tries again when its reset key changes, for example on
 * switching conversation. No wrapper element while healthy, so the region's
 * layout is exactly what it was.
 *
 * Only render, setup and lifecycle failures are taken; an event handler's error
 * still goes on to the app's own handler, as a React boundary would leave it.
 */
const props = defineProps<{ resetKey?: string }>()

const failure = ref<string>()

/* Vue names the source in development and gives a runtime code in production: 0 setup, 1 render. */
const RENDER = /render|setup|hook|#runtime-[01]$/

onErrorCaptured((error, _instance, info) => {
  if (!RENDER.test(String(info))) return undefined
  console.error("MCode: a region failed to render", error)
  failure.value = error instanceof Error ? error.message : String(error)
  // Into the day's log as well, where a packaged build can still be asked about it.
  window.mcode?.diagLog(`region failed to render: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
  return false
})

watch(
  () => props.resetKey,
  () => (failure.value = undefined),
)
</script>

<template>
  <div v-if="failure !== undefined" class="render-error" role="alert" data-render-error>
    <span class="label">{{ t("errorBoundary.inlineError") }}</span>
    <span v-if="failure" class="detail" :title="failure">{{ failure }}</span>
  </div>
  <slot v-else />
</template>

<style scoped>
/* MiMo's strip: 8 round on a red-300 line over red-50, 8 by 12 of padding. */
.render-error {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin: 8px;
  padding: 8px 12px;
  background: #fef2f2;
  border: 1px solid #fca5a5;
  border-radius: 8px;
}

.label {
  flex: none;
  color: #dc2626;
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.detail {
  min-width: 0;
  overflow: hidden;
  color: rgb(239 68 68 / 0.7);
  font-size: calc(12px * var(--ui-font-scale, 1));
  text-overflow: ellipsis;
  white-space: nowrap;
}

:root[data-theme="dark"] .render-error {
  background: rgb(69 10 10 / 0.3);
  border-color: #991b1b;
}

:root[data-theme="dark"] .label {
  color: #f87171;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .render-error {
    background: rgb(69 10 10 / 0.3);
    border-color: #991b1b;
  }

  :root:not([data-theme="light"]) .label {
    color: #f87171;
  }
}
</style>
