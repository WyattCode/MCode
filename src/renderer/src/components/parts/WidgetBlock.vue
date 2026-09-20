<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { t } from "../../lib/i18n"
import { useApp } from "../../stores/app"
import {
  WIDGET_MIN_HEIGHT,
  WIDGET_SANDBOX,
  WIDGET_START,
  widgetCap,
  widgetHeight,
  widgetReport,
  widgetResize,
  type WidgetSize,
} from "@shared/widget"

/**
 * MiMo's interactive widget: a ```sci-widget fence's document, live in the
 * reply. The card is the width of the message and as tall as what the widget
 * drew, with nothing around it - no tabs, no copy, no expand - so the widget
 * is the whole of it, as MiMo's is.
 *
 * The document never reaches this component as markup. It goes to the main
 * process (see shared/widget.ts for why and under what policy), which answers
 * an address on an origin of its own; the frame loads that address sandboxed, so
 * it has an opaque origin with no storage, no cookies, no way to read this
 * window or its preload bridge, and no route to the network or the disk.
 *
 * Its height cannot be read from here - the frame is another origin - so the
 * served document carries a reporter that posts what it drew, and those reports
 * are turned into the card's height. A widget that throws still gets measured:
 * the reporter is its own script after the widget's.
 */
const props = defineProps<{ code: string }>()
const app = useApp()

const src = ref("")
const failed = ref(false)
const size = ref<WidgetSize>(WIDGET_START)
const frame = ref<HTMLIFrameElement>()
/* The last height the widget claimed, so a resized window can be answered without waiting for another report. */
let content = WIDGET_MIN_HEIGHT

const source = computed(() => props.code.replace(/\n+$/, ""))

/* The app's reduced-motion setting as it stands, which the widget is asked to keep to as well. */
const damping = window.matchMedia("(prefers-reduced-motion: reduce)")
const systemDamped = ref(damping.matches)
const reduceMotion = computed(() => {
  const setting = app.config?.reduceMotion ?? "system"
  return setting === "on" || (setting === "system" && systemDamped.value)
})

let generation = 0

async function serve() {
  const mine = ++generation
  size.value = WIDGET_START
  content = WIDGET_MIN_HEIGHT
  failed.value = false
  src.value = ""
  const served = await window.mcode.widgetServe(source.value, reduceMotion.value)
  if (mine !== generation) return
  if (!served.ok) {
    failed.value = true
    return
  }
  src.value = served.url
}

function onMessage(event: MessageEvent) {
  const window_ = frame.value?.contentWindow
  if (!window_ || event.source !== window_) return
  const report = widgetReport(event.data)
  if (!report) return
  content = report.content
  size.value = widgetHeight(size.value, report, { cap: widgetCap(window.innerHeight), windowHeight: window.innerHeight })
}

const onResize = () => (size.value = widgetResize(size.value, content, window.innerHeight))
const onSystemDamping = (event: MediaQueryListEvent) => (systemDamped.value = event.matches)

onMounted(() => {
  window.addEventListener("message", onMessage)
  window.addEventListener("resize", onResize)
  damping.addEventListener("change", onSystemDamping)
  void serve()
})

onBeforeUnmount(() => {
  generation += 1
  window.removeEventListener("message", onMessage)
  window.removeEventListener("resize", onResize)
  damping.removeEventListener("change", onSystemDamping)
})

watch([source, reduceMotion], () => void serve())
</script>

<template>
  <div class="md-widget" data-widget-block>
    <div v-if="failed" class="md-widget-failed" data-widget-failed>{{ t("widget.failed") }}</div>
    <iframe
      v-else-if="src"
      ref="frame"
      class="md-widget-frame"
      data-widget-frame
      :title="t('widget.label')"
      :src="src"
      :sandbox="WIDGET_SANDBOX"
      referrerpolicy="no-referrer"
      loading="lazy"
      :style="{ height: `${size.height}px` }"
    />
  </div>
</template>

<style>
/* Not scoped: the card sits inside a reply's .text, beside the code block rules. */
.text .md-widget {
  margin: 8px 0;
  overflow: clip;
  background: #fff;
  border: 1px solid #f0ebe5;
  border-radius: 8px;
}

.text .md-widget-frame {
  display: block;
  width: 100%;
  background: #fff;
  border: 0;
}

.text .md-widget-failed {
  padding: 12px;
  color: var(--text-weak);
  font-size: calc(13px * var(--ui-font-scale, 1));
}

/*
 * The frame stays white in either theme: the widget paints its own page and
 * cannot be asked for a second set of colours, so only the card around it
 * follows the theme - as the score block does.
 */
:root[data-theme="dark"] .text .md-widget {
  background: #2e2e2e;
  border-color: #3a3a3a;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .text .md-widget {
    background: #2e2e2e;
    border-color: #3a3a3a;
  }
}
</style>
