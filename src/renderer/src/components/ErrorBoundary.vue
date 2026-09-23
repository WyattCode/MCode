<script setup lang="ts">
import { onErrorCaptured, ref, watch } from "vue"
import { t } from "../lib/i18n"

/**
 * MiMo's per-region error boundary.
 *
 * A region that fails to render shows a short red strip in its own place -
 * 渲染出错, the message and 重试 - instead of the whole window giving way to the
 * fatal error page. It tries again on 重试, or when its reset key changes, for
 * example on switching conversation. No wrapper element while healthy, so the
 * region's layout is exactly what it was.
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
    <button type="button" class="retry" data-error-retry @click="failure = undefined">{{ t("common.retry") }}</button>
  </div>
  <slot v-else />
</template>

<style scoped>
/*
 * MiMo's strip: 8 round on a red-300 line over red-50, 8 by 12 of padding and
 * no margin of its own - its fallback carries none, and no call site of its
 * boundary passes one that does. The pane boundary draws the same strip.
 */
.render-error {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
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

/* MiMo's retry: at the strip's end, 6 round on the same red line over white. */
.retry {
  flex: none;
  margin-inline-start: auto;
  padding: 2px 8px;
  color: #dc2626;
  background: #ffffff;
  border: 1px solid #fca5a5;
  border-radius: 6px;
  cursor: pointer;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.retry:hover {
  background: #fee2e2;
}

:root[data-theme="dark"] .render-error {
  background: rgb(69 10 10 / 0.3);
  border-color: #991b1b;
}

:root[data-theme="dark"] .label {
  color: #f87171;
}

:root[data-theme="dark"] .detail {
  color: rgb(248 113 113 / 0.5);
}

:root[data-theme="dark"] .retry {
  color: #f87171;
  background: rgb(127 29 29 / 0.3);
  border-color: #b91c1c;
}

:root[data-theme="dark"] .retry:hover {
  background: rgb(127 29 29 / 0.5);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .render-error {
    background: rgb(69 10 10 / 0.3);
    border-color: #991b1b;
  }

  :root:not([data-theme="light"]) .label {
    color: #f87171;
  }

  :root:not([data-theme="light"]) .detail {
    color: rgb(248 113 113 / 0.5);
  }

  :root:not([data-theme="light"]) .retry {
    color: #f87171;
    background: rgb(127 29 29 / 0.3);
    border-color: #b91c1c;
  }

  :root:not([data-theme="light"]) .retry:hover {
    background: rgb(127 29 29 / 0.5);
  }
}
</style>
