<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import { MEDIA_SPEEDS, isEmbedAddress, playerBox, speedLabel, speedValue, type MediaMeta } from "@shared/media-platform"
import { loadErrorKind, type LoadErrorKind } from "@shared/browser-page"
import { claimPlayer, releasePlayer, revealPlayer } from "../../lib/media-embed"
import { t } from "../../lib/i18n"

/**
 * MiMo's inline player: the platform's own player page in a frame under the
 * reply, with its 倍速 menu and 收起播放器 over the top corner, and MiMo's
 * error panel (视频无法播放, the browser's reason, retry, open in browser)
 * when the page fails to load.
 *
 * The frame only ever gets a player address (`isEmbedAddress`, which the
 * content policy's frame-src also names). It is sandboxed without top
 * navigation; its popups go to the main process's window-open guard.
 */
const props = defineProps<{ meta: MediaMeta }>()
const emit = defineEmits<{ collapse: [] }>()

const root = ref<HTMLElement>()
const failure = ref<LoadErrorKind>()
const rate = ref(1)
const speedOpen = ref(false)
const attempt = ref(0)

const address = computed(() => (isEmbedAddress(props.meta.embedUrl) ? props.meta.embedUrl : ""))
const box = computed(() => playerBox(props.meta.aspect))

const collapse = () => emit("collapse")
let stopReveal: (() => void) | undefined
let stopFailed: (() => void) | undefined

function samePlayer(url: string): boolean {
  try {
    const failed = new URL(url)
    const shown = new URL(address.value)
    return failed.origin === shown.origin && failed.pathname === shown.pathname
  } catch {
    return false
  }
}

onMounted(() => {
  claimPlayer(collapse)
  if (root.value) stopReveal = revealPlayer(root.value)
  stopFailed = window.mcode?.onMediaFailed?.((reported) => {
    if (!samePlayer(reported.url)) return
    failure.value = loadErrorKind(reported.code, reported.description)
    speedOpen.value = false
  })
})

onBeforeUnmount(() => {
  releasePlayer(collapse)
  stopReveal?.()
  stopFailed?.()
})

async function readSpeed() {
  if (!address.value) return
  const value = await window.mcode.mediaSpeed(address.value).catch(() => null)
  if (value !== null) rate.value = speedValue(value)
}

function toggleSpeed() {
  speedOpen.value = !speedOpen.value
  void readSpeed()
}

async function pickSpeed(value: number) {
  speedOpen.value = false
  const set = await window.mcode.mediaSpeed(address.value, value).catch(() => null)
  if (set !== null) rate.value = speedValue(set)
}

function retry() {
  failure.value = undefined
  attempt.value += 1
}

function openInBrowser() {
  window.mcode.openExternal(props.meta.url)
}
</script>

<template>
  <div ref="root" class="media-player" data-media-live :data-media-url="meta.url">
    <div class="media-player-box" :style="box">
      <iframe
        v-if="address"
        :key="attempt"
        class="media-player-frame"
        :src="address"
        :title="meta.title || t(`mediaCard.platform.${meta.platform}`)"
        sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox"
        allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
        referrerpolicy="strict-origin-when-cross-origin"
        data-media-frame
        @load="readSpeed"
      />
    </div>
    <div v-if="failure" class="media-player-error" data-media-error role="alert">
      <div class="mpe-title">{{ t("mediaCard.playFailed") }}</div>
      <div class="mpe-desc">{{ t(`rp.browser.error.${failure}`) }}</div>
      <div class="mpe-actions">
        <button type="button" class="mpe-btn" data-media-retry @click="retry">{{ t("rp.browser.error.retry") }}</button>
        <button type="button" class="mpe-btn" data-media-open-ext @click="openInBrowser">{{ t("mediaCard.openInBrowser") }}</button>
      </div>
    </div>
    <div class="media-player-tools">
      <div v-if="!failure" class="media-speed">
        <button type="button" class="media-speed-button" :aria-label="t('mediaCard.speed')" :aria-expanded="speedOpen" data-media-speed @click="toggleSpeed">
          {{ speedLabel(rate) }}
        </button>
        <div v-if="speedOpen" class="media-speed-menu" role="menu" data-media-speed-menu>
          <button
            v-for="value in MEDIA_SPEEDS"
            :key="value"
            type="button"
            role="menuitemradio"
            :aria-checked="speedValue(value) === rate"
            :class="{ on: speedValue(value) === rate }"
            :data-media-speed-item="value"
            @click="pickSpeed(value)"
          >
            {{ speedLabel(value) }}
          </button>
        </div>
      </div>
      <button type="button" class="media-collapse" :title="t('mediaCard.collapse')" :aria-label="t('mediaCard.collapse')" data-media-collapse @click="collapse">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
/* MiMo's player: 12px corners on black, the tools 8px in from the top corner. */
.media-player {
  position: relative;
  margin-top: 10px;
  overflow: hidden;
  background: #000;
  border: 1px solid #f0ebe5;
  border-radius: 12px;
}

.media-player-frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
}

.media-player-error {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
  background: #000000b8;
  backdrop-filter: blur(2px);
}

.mpe-title {
  color: #fffffff5;
  font-size: calc(15px * var(--ui-font-scale, 1));
  font-weight: 600;
}

.mpe-desc {
  max-width: 340px;
  color: #ffffffc7;
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: 1.5;
}

.mpe-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

.mpe-btn {
  padding: 6px 16px;
  color: #ffffffeb;
  background: #ffffff1a;
  border: 1px solid #ffffff47;
  border-radius: 8px;
  font: inherit;
  font-size: calc(13px * var(--ui-font-scale, 1));
  cursor: pointer;
  transition: background-color 0.12s;
}

.mpe-btn:hover {
  background: #fff3;
}

.media-player-tools {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 6px;
}

.media-speed {
  position: relative;
}

.media-speed-button {
  display: flex;
  align-items: center;
  height: 26px;
  padding: 0 9px;
  color: #fff;
  background: rgb(0 0 0 / 0.55);
  border: 0;
  border-radius: 9999px;
  font: inherit;
  font-size: calc(11px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: 1;
  backdrop-filter: blur(4px);
  cursor: pointer;
  transition: background-color 0.12s;
}

.media-speed-button:hover,
.media-collapse:hover {
  background: rgb(0 0 0 / 0.75);
}

.media-speed-menu {
  position: absolute;
  top: 30px;
  right: 0;
  display: flex;
  flex-direction: column;
  padding: 3px 0;
  overflow: hidden;
  background: rgb(0 0 0 / 0.7);
  border-radius: 8px;
  backdrop-filter: blur(4px);
}

.media-speed-menu button {
  padding: 5px 12px;
  color: rgb(255 255 255 / 0.65);
  text-align: start;
  background: transparent;
  border: 0;
  font: inherit;
  font-size: calc(11px * var(--ui-font-scale, 1));
  line-height: 1;
  cursor: pointer;
  transition: background-color 0.12s;
}

.media-speed-menu button:hover {
  background: rgb(255 255 255 / 0.15);
}

.media-speed-menu button.on {
  color: #fff;
  font-weight: 600;
}

.media-collapse {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  color: #fff;
  background: rgb(0 0 0 / 0.55);
  border: 0;
  border-radius: 9999px;
  backdrop-filter: blur(4px);
  cursor: pointer;
  transition: background-color 0.12s;
}

:root[data-theme="dark"] .media-player {
  border-color: #2e2e2e;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .media-player {
    border-color: #2e2e2e;
  }
}
</style>
