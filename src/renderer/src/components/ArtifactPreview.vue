<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import type { ResponseMap } from "@shared/protocol"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"
import { renderMarkdown } from "../lib/markdown"

/**
 * One artifact, previewed where it was found - MiMo's 打开预览.
 *
 * Read through the backend the way the file panel reads, so what shows here is
 * what the panel would show: markdown rendered with the reply styles, other
 * text as it is, images and audio from their bytes. Anything else says it
 * cannot be shown and offers the desktop's own app instead. The header keeps
 * the page's other two actions, so a file looked at can be downloaded or its
 * conversation opened without closing first.
 */
const props = defineProps<{ directory: string; path: string; name: string }>()
const emit = defineEmits<{ close: []; download: []; enter: []; "open-default": [] }>()

const app = useApp()
const file = ref<ResponseMap["file.read"]>()
const failure = ref("")

const markdown = computed(() => /\.(md|markdown|mdx)$/i.test(props.name))
// Safe to bind as HTML: renderMarkdown escapes the source before formatting it.
const html = computed(() => (file.value?.kind === "text" && markdown.value ? renderMarkdown(file.value.content) : ""))
const media = computed(() => (file.value?.data ? `data:${file.value.mime ?? "application/octet-stream"};base64,${file.value.data}` : ""))

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") emit("close")
}

onMounted(async () => {
  window.addEventListener("keydown", onKeydown)
  try {
    const result = await app.client?.request({ type: "file.read", path: `${props.directory}/${props.path}` })
    if (result) file.value = result
    else failure.value = t("art.previewFailed", { error: "" })
  } catch (err) {
    failure.value = t("art.previewFailed", { error: err instanceof Error ? err.message : String(err) })
  }
})
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown))
</script>

<template>
  <div class="scrim" @mousedown.self="emit('close')">
    <div v-modal class="preview" role="dialog" :aria-label="name">
      <header class="head">
        <div class="head-text">
          <span class="name">{{ name }}</span>
          <span class="where" :title="path">{{ path }}</span>
        </div>
        <div class="head-acts">
          <button class="head-btn" data-act="download" :aria-label="t('art.download')" v-tip="{ label: t('art.download') }" @click="emit('download')">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 2.5v7M5 6.8l3 3 3-3M3 11.5v2h10v-2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <button class="head-btn" data-act="open-default" :aria-label="t('art.openDefault')" v-tip="{ label: t('art.openDefault') }" @click="emit('open-default')">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5M12 9.5v4H2.5V4h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <button class="head-btn" data-act="enter" :aria-label="t('art.back')" v-tip="{ label: t('art.back') }" @click="emit('enter')">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
            </svg>
          </button>
          <button class="head-btn" data-act="close" :aria-label="t('common.close')" @click="emit('close')">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
          </button>
        </div>
      </header>

      <div class="body">
        <p v-if="failure" class="notice error">{{ failure }}</p>
        <template v-else-if="file">
          <p v-if="file.truncated" class="notice">{{ t("art.previewTruncated") }}</p>
          <div v-if="html" class="text doc" v-html="html" />
          <pre v-else-if="file.kind === 'text'" class="code">{{ file.content }}</pre>
          <img v-else-if="file.kind === 'image' && media" class="image" :src="media" :alt="name" />
          <audio v-else-if="file.kind === 'audio' && media" class="audio" controls :src="media" />
          <div v-else class="unsupported">
            <p class="notice">{{ t("art.previewUnsupported") }}</p>
            <button class="open-default" @click="emit('open-default')">{{ t("art.openDefault") }}</button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 130;
  display: grid;
  place-items: center;
  background: var(--scrim);
}

/* Wide enough to read a page of text at the reply's measure, and never past the window. */
.preview {
  display: flex;
  flex-direction: column;
  width: min(960px, 92vw);
  height: min(760px, 84vh);
  overflow: hidden;
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 14px;
  box-shadow: var(--shadow-lg);
}

.head {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 12px;
  padding: 12px 12px 12px 18px;
  border-bottom: 1px solid var(--border-weak);
}

.head-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.name,
.where {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.name {
  color: var(--text-strong);
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 600;
  line-height: 20px;
}

.where {
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 16px;
}

.head-acts {
  display: flex;
  flex-shrink: 0;
  gap: 6px;
}

/* The page's own action buttons: framed, a 7px corner around a 15px glyph. */
.head-btn {
  display: grid;
  place-items: center;
  padding: 6px;
  color: var(--text-weak);
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 7px;
  transition: box-shadow 0.12s, color 0.12s;
}

.head-btn:hover {
  color: var(--text-base);
  box-shadow: var(--shadow-xs-border);
}

.body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 16px 20px 20px;
}

.notice {
  margin: 0 0 12px;
  color: var(--text-weak);
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: 20px;
}

.notice.error {
  color: var(--error);
}

.doc {
  color: var(--text-strong);
}

.code {
  margin: 0;
  color: var(--text-strong);
  font-family: var(--font-mono);
  font-size: calc(12px * var(--code-font-scale, 1));
  line-height: 18px;
  white-space: pre;
}

.image {
  display: block;
  max-width: 100%;
  margin: 0 auto;
}

.audio {
  width: 100%;
}

.unsupported {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}

.open-default {
  height: 30px;
  padding: 0 14px;
  color: var(--text-base);
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: var(--radius-md);
  font-size: calc(12.5px * var(--ui-font-scale, 1));
}

.open-default:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}
</style>
