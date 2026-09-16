<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue"
import { PLATFORM_COLOURS, platformLinksIn, type MediaMeta } from "@shared/media-platform"
import { enrichMedia } from "../../lib/media-embed"
import { audioClock } from "../../lib/media-card"
import { t } from "../../lib/i18n"
import { useRightPanel } from "../../stores/right-panel"
import MediaCoverflow from "./MediaCoverflow.vue"

/**
 * MiMo's video cards under a finished reply: its links to the fourteen video
 * platforms, looked up by the main process. One link is a card beside its
 * cover; several are a coverflow. A card opens its video page in a browser tab
 * of the right panel - for all fourteen, as MiMo's shipped build does, taking
 * up a browser tab already on that address.
 */
const props = defineProps<{ text: string }>()
const rp = useRightPanel()

/* MiMo shows at most thirty. */
const MAX_CARDS = 30

const metas = ref<MediaMeta[]>([])
const active = ref(0)
const coverFailed = ref(false)
let generation = 0

watch(
  () => props.text,
  async (text) => {
    const mine = ++generation
    const urls = platformLinksIn(text)
    if (!urls.length) {
      metas.value = []
      return
    }
    const found = await enrichMedia(urls)
    if (mine === generation) metas.value = found.slice(0, MAX_CARDS)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  generation += 1
})

const single = computed(() => (metas.value.length === 1 ? metas.value[0] : undefined))

watch(single, () => (coverFailed.value = false))

const platformName = (meta: MediaMeta) => t(`mediaCard.platform.${meta.platform}`)
const badge = (meta: MediaMeta) => ({ color: PLATFORM_COLOURS[meta.platform].fg, background: PLATFORM_COLOURS[meta.platform].bg })

/* MiMo's browser switch in settings does not stop a card: its press always opens the tab. */
function play(url: string) {
  if (metas.value.some((entry) => entry.url === url)) rp.openBrowser(url, { reuse: true })
}
</script>

<template>
  <div v-if="metas.length" class="media-strip" :class="{ 'media-strip-multi': metas.length > 1 }" data-media-strip>
    <button
      v-if="single"
      type="button"
      class="media-card"
      :title="single.title || t('mediaCard.openInBrowser')"
      data-media-card
      :data-media-url="single.url"
      @click="play(single.url)"
    >
      <span class="media-card-thumb">
        <img v-if="single.coverUrl && !coverFailed" :src="single.coverUrl" alt="" draggable="false" referrerpolicy="no-referrer" data-media-cover @error="coverFailed = true" />
        <span v-else class="media-card-plate" :style="badge(single)">{{ platformName(single) }}</span>
        <span class="media-card-play" aria-hidden="true">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l10.5-6.5L8 5.5Z" /></svg>
        </span>
        <span v-if="single.durationSec" class="media-card-duration" data-media-duration>{{ audioClock(single.durationSec) }}</span>
      </span>
      <span class="media-card-body">
        <span class="media-card-title">{{ single.title || t("mediaCard.openInBrowser") }}</span>
        <span class="media-card-meta">
          <span class="media-card-badge" :style="badge(single)" data-media-platform>{{ platformName(single) }}</span>
          <span v-if="single.author" class="media-card-author">{{ single.author }}</span>
        </span>
      </span>
    </button>
    <MediaCoverflow v-else :metas="metas" :active="active" @select="active = $event" @play="play" />
  </div>
</template>

<style scoped>
/* MiMo's card: up to 420 wide, a 168px 16:9 cover, 12px corners on the side ground, a line that turns blue on hover. */
.media-card {
  display: flex;
  box-sizing: border-box;
  align-items: stretch;
  width: 100%;
  max-width: 420px;
  margin-top: 10px;
  padding: 0;
  overflow: hidden;
  color: inherit;
  text-align: start;
  background: #f8f7f5;
  border: 1px solid #f0ebe5;
  border-radius: 12px;
  font: inherit;
  cursor: pointer;
  transition: border-color 0.12s;
}

.media-card:hover {
  border-color: #3295fb;
}

.media-card:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: 2px;
}

.media-card-thumb {
  position: relative;
  display: block;
  flex: none;
  align-self: stretch;
  width: 168px;
  aspect-ratio: 16 / 9;
}

.media-card-thumb img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.media-card-plate {
  display: flex;
  box-sizing: border-box;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  padding: 8px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-weight: 500;
}

.media-card-play {
  position: absolute;
  top: 50%;
  left: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  color: #fff;
  background: rgb(0 0 0 / 0.55);
  border-radius: 9999px;
  backdrop-filter: blur(4px);
  transform: translate(-50%, -50%);
  transition: transform 0.12s;
}

.media-card:hover .media-card-play {
  transform: translate(-50%, -50%) scale(1.1);
}

.media-card-duration {
  position: absolute;
  right: 5px;
  bottom: 5px;
  padding: 1px 5px;
  color: #fff;
  background: rgb(0 0 0 / 0.65);
  border-radius: 5px;
  font-family: var(--font-mono);
  font-size: calc(11px * var(--code-font-scale, 1));
}

.media-card-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  justify-content: space-between;
  gap: 6px;
  min-width: 0;
  padding: 10px 12px;
}

.media-card-title {
  display: -webkit-box;
  overflow: hidden;
  color: var(--text-strong);
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: 1.45;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.media-card-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.media-card-badge {
  flex: none;
  padding: 1px 4px;
  border-radius: 4px;
  font-size: calc(11px * var(--ui-font-scale, 1));
  font-weight: 500;
}

.media-card-author {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:root[data-theme="dark"] .media-card {
  background: #141414;
  border-color: #2e2e2e;
}

:root[data-theme="dark"] .media-card:hover {
  border-color: #3295fb;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .media-card {
    background: #141414;
    border-color: #2e2e2e;
  }

  :root:not([data-theme="light"]) .media-card:hover {
    border-color: #3295fb;
  }
}
</style>
