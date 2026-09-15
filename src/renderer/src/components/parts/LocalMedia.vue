<script lang="ts">
/* Kept across mounts: a reply that is still streaming mounts its cards again on every word. */
const served = new Map<string, { file: string; url: string }>()
const loaded = new Set<string>()
</script>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { t } from "../../lib/i18n"
import { openImagePreview } from "../../lib/image-preview"
import { openNative, pathCandidates } from "../../lib/path-open"

/**
 * MiMo's card for a picture, video or sound named by its path in a reply. The
 * window cannot read the disk, so the file is found through the main process
 * and shown from the local preview server. A file that is gone falls back to
 * the path as plain code; one that is there but will not load offers to open
 * it with the default program.
 */
const props = defineProps<{ kind: "image" | "video" | "audio"; path: string; directory?: string }>()

type State = "resolving" | "missing" | "loading" | "ok" | "error"
const key = computed(() => `${props.directory ?? ""}\n${props.path}`)
const entry = ref(served.get(key.value))
const state = ref<State>(entry.value ? (loaded.has(entry.value.url) ? "ok" : "loading") : "resolving")
const duration = ref(0)
const name = computed(() => (entry.value?.file ?? props.path).split(/[\\/]/).pop() || props.path)

/* MiMo's player grows with the sound's length: 148 + 30 + 3.2px a second, between 178 and 590. */
const audioWidth = computed(() => `${Math.round(Math.max(178, Math.min(590, 178 + 3.2 * duration.value)))}px`)

async function resolve(): Promise<void> {
  const found = await window.mcode.resolveExistingPath(pathCandidates(props.path, props.directory)).catch(() => null)
  if (!found || found.directory) {
    served.delete(key.value)
    entry.value = undefined
    state.value = "missing"
    return
  }
  const address = await window.mcode.officeServe(found.path).catch(() => null)
  if (!address?.ok) {
    entry.value = { file: found.path, url: "" }
    state.value = "error"
    return
  }
  entry.value = { file: found.path, url: address.url }
  served.set(key.value, entry.value)
  state.value = loaded.has(address.url) ? "ok" : "loading"
}

onMounted(() => {
  if (state.value === "resolving") void resolve()
})

function ready() {
  if (entry.value?.url) loaded.add(entry.value.url)
  state.value = "ok"
}

/* A load that fails is checked again: a deleted file becomes plain code, anything else the open button. */
async function broken() {
  if (entry.value?.url) loaded.delete(entry.value.url)
  const found = await window.mcode.resolveExistingPath(pathCandidates(props.path, props.directory)).catch(() => null)
  state.value = found ? "error" : "missing"
  if (!found) served.delete(key.value)
}

function preview() {
  if (entry.value?.url && state.value === "ok") openImagePreview(entry.value.url, { name: name.value })
}

function openWithDefault() {
  void openNative(entry.value?.file ?? props.path)
}

const failedLabel = computed(() =>
  props.kind === "image" ? t("markdown.imageLoadFailed") : props.kind === "video" ? t("markdown.videoLoadFailed") : t("markdown.audioLoadFailed"),
)
</script>

<template>
  <code v-if="state === 'missing'">{{ path }}</code>
  <div
    v-else
    class="md-media-card"
    :data-media-card="kind"
    :data-media-state="state"
    :data-path="entry?.file ?? path"
    data-path-kind="open"
    :data-path-image="kind === 'image' ? '' : undefined"
  >
    <button v-if="state === 'error'" type="button" class="md-media-failed" :title="t('markdown.openWithDefaultTip')" data-media-failed @click="openWithDefault">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path v-if="kind === 'image'" d="M2 2l20 20M10.4 10.4a2 2 0 1 1-2.8-2.8M13.5 13.5 6 21M18 12l3 3M3.6 3.6A2 2 0 0 0 3 5v14a2 2 0 0 0 2 2h14a2 2 0 0 0 1.4-.6M21 15V5a2 2 0 0 0-2-2H9" />
        <path v-else-if="kind === 'video'" d="M10.7 6H14a2 2 0 0 1 2 2v2.5l5.2-3.1a.5.5 0 0 1 .8.4v8.2M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2M2 2l20 20" />
        <path v-else d="M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6A1.4 1.4 0 0 1 5.4 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5zM22 9l-6 6M16 9l6 6" />
      </svg>
      <span>{{ failedLabel }}</span>
      <span class="md-media-name">{{ name }}</span>
    </button>

    <template v-else-if="kind === 'image'">
      <div v-if="state !== 'ok'" class="md-media-skeleton" data-media-loading>{{ t("markdown.imageLoading") }}</div>
      <img
        v-if="entry?.url"
        v-show="state === 'ok'"
        class="md-media-image"
        :src="entry.url"
        :alt="name"
        :title="t('markdown.previewImageTip')"
        role="button"
        tabindex="0"
        @load="ready"
        @error="broken"
        @click="preview"
        @keydown.enter.prevent="preview"
        @keydown.space.prevent="preview"
      />
      <span v-if="state === 'ok'" class="md-media-name">{{ name }}</span>
    </template>

    <template v-else-if="kind === 'video'">
      <div v-if="!entry?.url" class="md-media-skeleton" />
      <video v-else class="md-media-video" :src="entry.url" controls preload="metadata" playsinline @loadedmetadata="ready" @error="broken" />
      <span class="md-media-name">{{ name }}</span>
    </template>

    <template v-else>
      <audio
        v-if="entry?.url"
        class="md-media-audio"
        :style="{ width: audioWidth }"
        :src="entry.url"
        controls
        preload="metadata"
        @loadedmetadata="duration = ($event.target as HTMLAudioElement).duration || 0; ready()"
        @error="broken"
      />
      <span class="md-media-name">{{ name }}</span>
    </template>
  </div>
</template>

<style>
/* Not scoped: the card is mounted into the reply's rendered markup at runtime. */
.text .md-media[data-mounted] {
  display: block;
}

.text .md-media-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: fit-content;
  max-width: 100%;
  margin: 12px 0;
}

.text .md-media-skeleton {
  display: grid;
  place-items: center;
  width: 180px;
  height: 120px;
  color: var(--text-weak);
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 10px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  animation: md-media-pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}

@keyframes md-media-pulse {
  50% {
    opacity: 0.5;
  }
}

.text .md-media-image {
  box-sizing: border-box;
  max-width: 100%;
  max-height: 320px;
  padding: 2px;
  object-fit: contain;
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: 10px;
  cursor: zoom-in;
}

.text .md-media-image:focus-visible {
  outline: 2px solid #2f6fed;
  outline-offset: 2px;
}

.text .md-media-video {
  max-width: 100%;
  max-height: 480px;
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: 10px;
}

.text .md-media-audio {
  max-width: 100%;
}

.text .md-media-name {
  max-width: 360px;
  overflow: hidden;
  color: var(--text-weak);
  font-family: var(--font-mono);
  font-size: calc(11px * var(--code-font-scale, 1));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.text .md-media-failed {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  max-width: 100%;
  padding: 8px 11px;
  color: var(--text-weak);
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 10px;
  font: inherit;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.text .md-media-failed:hover {
  background: var(--surface-hover);
}

.text .md-media-failed svg {
  flex: none;
}
</style>
