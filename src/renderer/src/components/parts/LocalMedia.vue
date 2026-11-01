<script lang="ts">
/* Kept across mounts: a reply that is still streaming mounts its cards again on every word. */
const served = new Map<string, { file: string; url: string }>()
const loaded = new Set<string>()
/* An SVG file's text by its served address, once read. */
const svgTexts = new Map<string, string>()
/* MiMo plays one inline clip at a time: starting one pauses the one before. */
let playingAudio: HTMLAudioElement | undefined
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import { t } from "../../lib/i18n"
import { openImagePreview } from "../../lib/image-preview"
import { audioBubbleWidth, audioClock } from "../../lib/media-card"
import { openNative, pathCandidates } from "../../lib/path-open"
import { isSvgFile } from "../../lib/svg-safe"
import SvgFileCard from "./SvgFileCard.vue"

/**
 * MiMo's card for a picture, video or sound named by its path in a reply. The
 * window cannot read the disk, so the file is found through the main process
 * and shown from the local preview server. A file that is gone falls back to
 * the path as plain code; one that is there but will not load offers to open
 * it with the default program. An .svg file becomes MiMo's SVG file card once
 * its text has been read, and a sound is MiMo's voice bubble.
 */
const props = defineProps<{ kind: "image" | "video" | "audio"; path: string; directory?: string }>()

type State = "resolving" | "missing" | "loading" | "ok" | "error"
const key = computed(() => `${props.directory ?? ""}\n${props.path}`)
const entry = ref(served.get(key.value))
const state = ref<State>(entry.value ? (loaded.has(entry.value.url) ? "ok" : "loading") : "resolving")
const svgText = ref(entry.value ? svgTexts.get(entry.value.url) : undefined)
const name = computed(() => (entry.value?.file ?? props.path).split(/[\\/]/).pop() || props.path)

/* MiMo reads the file's text for the card; if that fails the plain picture card stays. */
async function readSvg(url: string) {
  const known = svgTexts.get(url)
  if (known !== undefined) {
    svgText.value = known
    return
  }
  try {
    const response = await fetch(url)
    const text = response.ok ? await response.text() : ""
    if (!/<svg[\s>]/i.test(text)) return
    svgTexts.set(url, text)
    if (entry.value?.url === url) svgText.value = text
  } catch {
    // The plain picture card stays.
  }
}

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
  if (props.kind === "image" && isSvgFile(found.path)) void readSvg(address.url)
}

onMounted(() => {
  if (state.value === "resolving") void resolve()
  else if (props.kind === "image" && entry.value?.url && isSvgFile(entry.value.file) && svgText.value === undefined) void readSvg(entry.value.url)
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

function svgMissing() {
  served.delete(key.value)
  state.value = "missing"
}

/* The preview zooms out of the picture that was pressed. */
function preview(event: Event) {
  if (!entry.value?.url || state.value !== "ok") return
  openImagePreview(entry.value.url, { name: name.value, rect: (event.currentTarget as HTMLElement).getBoundingClientRect() })
}

function openWithDefault() {
  void openNative(entry.value?.file ?? props.path)
}

const failedLabel = computed(() =>
  props.kind === "image" ? t("markdown.imageLoadFailed") : props.kind === "video" ? t("markdown.videoLoadFailed") : t("markdown.audioLoadFailed"),
)

/*
 * MiMo's voice bubble: a play button, a track that seeks where it is pressed,
 * the clip's total length, and a "…" for the path menu; the bubble grows with
 * the clip. The audio element itself is hidden.
 */
const audio = ref<HTMLAudioElement>()
const track = ref<HTMLElement>()
const playing = ref(false)
const position = ref(0)
const duration = ref(0)
const bubbleWidth = computed(() => `${audioBubbleWidth(duration.value)}px`)
// The length, as MiMo shows it; the position only while the length is not known.
const clock = computed(() => audioClock(duration.value > 0 ? duration.value : position.value))
const progress = computed(() => (duration.value > 0 ? `${Math.min(100, (position.value / duration.value) * 100)}%` : "0%"))

function onMetadata() {
  const element = audio.value
  duration.value = element && Number.isFinite(element.duration) ? element.duration : 0
  ready()
}

function togglePlay() {
  const element = audio.value
  if (!element) return
  if (!element.paused) {
    element.pause()
    return
  }
  // A clip that refuses to play becomes the open-with-your-player card.
  element.play().catch(() => void broken())
}

function onPlay() {
  const element = audio.value
  if (playingAudio && playingAudio !== element) playingAudio.pause()
  playingAudio = element
  playing.value = true
}

function onPause() {
  if (playingAudio === audio.value) playingAudio = undefined
  playing.value = false
}

function seek(event: MouseEvent) {
  const element = audio.value
  const bar = track.value
  if (!element || !bar || duration.value <= 0) return
  const box = bar.getBoundingClientRect()
  const ratio = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width))
  element.currentTime = ratio * duration.value
  position.value = element.currentTime
}

/* The track from the keyboard: the arrows on the focused bubble step five seconds, Home and End go to the ends. */
function nudge(event: KeyboardEvent) {
  const element = audio.value
  if (!element || duration.value <= 0) return
  const rtl = getComputedStyle(event.currentTarget as HTMLElement).direction === "rtl"
  const steps: Record<string, number> = { ArrowLeft: rtl ? 5 : -5, ArrowRight: rtl ? -5 : 5, Home: -Infinity, End: Infinity }
  const step = steps[event.key]
  if (step === undefined) return
  event.preventDefault()
  element.currentTime = Math.min(duration.value, Math.max(0, element.currentTime + step))
  position.value = element.currentTime
}

/* The "…" opens the reply's path menu where MiMo puts it: 80px before the button, 4px under it. */
function openMore(event: MouseEvent) {
  const button = event.currentTarget as HTMLElement
  const box = button.getBoundingClientRect()
  button.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.left - 80, clientY: box.bottom + 4 }))
}

onBeforeUnmount(() => {
  if (playingAudio && playingAudio === audio.value) playingAudio = undefined
})
</script>

<template>
  <code v-if="state === 'missing'">{{ path }}</code>
  <SvgFileCard
    v-else-if="kind === 'image' && svgText !== undefined && entry?.url && state !== 'error'"
    :text="svgText"
    :url="entry.url"
    :file="entry.file"
    :name="name"
    @loaded="ready"
    @missing="svgMissing"
  />
  <div
    v-else
    class="md-media-card"
    :data-media-card="kind"
    :data-media-state="state"
    :data-path="entry?.file ?? path"
    data-path-kind="open"
    :data-path-image="kind === 'image' ? '' : undefined"
    :data-inline-audio="kind === 'audio' ? '' : undefined"
  >
    <button
      v-if="state === 'error'"
      type="button"
      class="md-media-failed"
      :title="t('markdown.openWithDefaultTip')"
      :aria-label="`${failedLabel}: ${name}. ${t('markdown.openWithDefaultTip')}`"
      data-media-failed
      @click="openWithDefault"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <template v-if="kind === 'image'">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="m21 15-5-5L5 21" />
        </template>
        <template v-else-if="kind === 'video'">
          <path d="m22 8-6 4 6 4V8Z" />
          <rect x="2" y="6" width="14" height="12" rx="2" />
        </template>
        <template v-else>
          <path d="M9 18V5l12-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="16" r="3" />
        </template>
        <path d="M3 3l18 18" />
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
        :aria-label="`${t('markdown.previewImageTip')}: ${name}`"
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
        ref="audio"
        :src="entry.url"
        preload="metadata"
        @loadedmetadata="onMetadata"
        @durationchange="onMetadata"
        @timeupdate="position = ($event.target as HTMLAudioElement).currentTime"
        @play="onPlay"
        @pause="onPause"
        @ended="onPause"
        @error="broken"
      />
      <div
        class="md-voice"
        role="button"
        tabindex="0"
        :title="name"
        :aria-label="`${playing ? t('videoPreview.pause') : t('videoPreview.play')}: ${name}`"
        :style="{ width: bubbleWidth }"
        data-voice-bubble
        @click="togglePlay"
        @keydown.enter.self.prevent="togglePlay"
        @keydown.space.self.prevent="togglePlay"
        @keydown.self="nudge"
      >
        <span class="md-voice-play" :data-playing="playing" aria-hidden="true">
          <svg v-if="playing" width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
          <svg v-else class="md-voice-glyph" width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
        </span>
        <span ref="track" class="md-voice-track" data-voice-track @click.stop="seek">
          <span class="md-voice-progress" :style="{ width: progress }" />
        </span>
        <span class="md-voice-time" data-voice-time>{{ clock }}</span>
        <button type="button" class="md-voice-more" :title="t('header.moreTip')" :aria-label="t('header.moreTip')" data-voice-more @click.stop="openMore">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="1.8" />
            <circle cx="12" cy="12" r="1.8" />
            <circle cx="19" cy="12" r="1.8" />
          </svg>
        </button>
      </div>
      <!-- MiMo's line under the bubble, as wide as it: the file's name, then the small AI-generated marker. -->
      <span class="md-voice-foot" :style="{ width: bubbleWidth }" data-voice-foot>
        <span class="md-media-name md-voice-name">{{ name }}</span>
        <span class="md-voice-aigc" data-voice-aigc>{{ t("markdown.aiGenerated") }}</span>
      </span>
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
  align-items: flex-start;
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
  color: var(--text-base);
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
  outline: 2px solid var(--interactive);
  outline-offset: 2px;
}

.text .md-media-video {
  max-width: 100%;
  max-height: 480px;
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: 10px;
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
  color: var(--text-base);
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 10px;
  font: inherit;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.text .md-media-failed:hover {
  background: var(--surface-hover);
}

.text .md-media-failed:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: 2px;
  border-radius: 10px;
}

.text .md-media-failed svg {
  flex: none;
}

/* MiMo's voice bubble: 44 high and round, on the sunken ground with a line that turns blue on hover. */
.text .md-voice {
  display: flex;
  box-sizing: border-box;
  align-items: center;
  gap: 10px;
  max-width: 100%;
  height: 44px;
  padding: 0 10px;
  background: #f8f7f5;
  border: 1px solid #f0ebe5;
  border-radius: 9999px;
  cursor: pointer;
  transition: border-color 0.15s cubic-bezier(0.4, 0, 0.2, 1);
}

.text .md-voice:hover {
  border-color: #3295fb;
}

.text .md-voice:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: 2px;
}

.text .md-voice-play {
  display: grid;
  flex: none;
  place-items: center;
  width: 28px;
  height: 28px;
  color: #fffefd;
  background: #151c13;
  border-radius: 50%;
}

/* The play triangle sits a pixel off centre, as MiMo nudges it. */
.text .md-voice-glyph {
  margin-inline-start: 1px;
}

.text .md-voice-track {
  position: relative;
  flex: 1;
  min-width: 24px;
  height: 4px;
  background: #f0ebe5;
  border-radius: 9999px;
  cursor: pointer;
}

.text .md-voice-progress {
  position: absolute;
  inset-block: 0;
  left: 0;
  background: #151c13;
  border-radius: 9999px;
}

.text .md-voice-time {
  flex: none;
  color: #151c1399;
  font-family: var(--font-mono);
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-variant-numeric: tabular-nums;
}

.text .md-voice-more {
  display: grid;
  flex: none;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  color: #151c1399;
  background: transparent;
  border: 0;
  border-radius: 50%;
}

.text .md-voice-more:hover {
  color: var(--text-body);
  background: #f1f0ec;
}

.text .md-voice-more:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: 2px;
}

.text .md-voice-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
}

.text .md-voice-name {
  flex: 1;
  min-width: 0;
  max-width: none;
  color: #151c1366;
}

/* MiMo's marker: a fixed 10px on a 1.2 line in the dim colour, never shrunk and never selected. */
.text .md-voice-aigc {
  flex: none;
  color: #151c1366;
  font-size: 10px;
  line-height: 1.2;
  user-select: none;
}

:root[data-theme="dark"] .text .md-voice {
  background: #2e2e2e;
  border-color: #2e2e2e;
}

:root[data-theme="dark"] .text .md-voice:hover {
  border-color: #3295fb;
}

:root[data-theme="dark"] .text .md-voice-play {
  color: #181818;
  background: #fff;
}

:root[data-theme="dark"] .text .md-voice-track {
  background: #2e2e2e;
}

:root[data-theme="dark"] .text .md-voice-progress {
  background: #fff;
}

:root[data-theme="dark"] .text .md-voice-time,
:root[data-theme="dark"] .text .md-voice-more {
  color: #b8b8b8;
}

:root[data-theme="dark"] .text .md-voice-more:hover {
  color: #f4f4f5;
  background: #ffffff0f;
}

:root[data-theme="dark"] .text .md-voice-name,
:root[data-theme="dark"] .text .md-voice-aigc {
  color: #777;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .text .md-voice {
    background: #2e2e2e;
    border-color: #2e2e2e;
  }

  :root:not([data-theme="light"]) .text .md-voice:hover {
    border-color: #3295fb;
  }

  :root:not([data-theme="light"]) .text .md-voice-play {
    color: #181818;
    background: #fff;
  }

  :root:not([data-theme="light"]) .text .md-voice-track {
    background: #2e2e2e;
  }

  :root:not([data-theme="light"]) .text .md-voice-progress {
    background: #fff;
  }

  :root:not([data-theme="light"]) .text .md-voice-time,
  :root:not([data-theme="light"]) .text .md-voice-more {
    color: #b8b8b8;
  }

  :root:not([data-theme="light"]) .text .md-voice-more:hover {
    color: #f4f4f5;
    background: #ffffff0f;
  }

  :root:not([data-theme="light"]) .text .md-voice-name,
  :root:not([data-theme="light"]) .text .md-voice-aigc {
    color: #777;
  }
}
</style>
