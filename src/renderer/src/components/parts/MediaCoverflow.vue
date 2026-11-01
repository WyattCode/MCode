<script setup lang="ts">
import { computed, ref } from "vue"
import { PLATFORM_COLOURS, coverflowSlot, stepIndex, type MediaMeta } from "@shared/media-platform"
import { audioClock } from "../../lib/media-card"
import { t } from "../../lib/i18n"

/**
 * MiMo's coverflow for several video cards: the covers fanned in 3D around the
 * one in front, its title and platform beneath, and ‹ n / N › to step. A press
 * on a side cover brings it forward; a press on the front one opens it. Left
 * and right arrows step, Enter opens.
 */
const props = defineProps<{ metas: MediaMeta[]; active: number }>()
const emit = defineEmits<{ select: [index: number]; play: [url: string] }>()

const failedCovers = ref(new Set<string>())

const index = computed(() => Math.max(0, Math.min(props.active, props.metas.length - 1)))
const current = computed(() => props.metas[index.value])

const platformName = (meta: MediaMeta) => t(`mediaCard.platform.${meta.platform}`)
const badge = (meta: MediaMeta) => ({ color: PLATFORM_COLOURS[meta.platform].fg, background: PLATFORM_COLOURS[meta.platform].bg })

function coverStyle(at: number) {
  const slot = coverflowSlot(at - index.value)
  return { transform: `translate(-50%, -50%) ${slot.transform}`, zIndex: slot.zIndex, opacity: slot.opacity, pointerEvents: slot.pointerEvents, transformStyle: "preserve-3d" as const }
}

function step(by: number) {
  emit("select", stepIndex(index.value, by, props.metas.length))
}

function press(at: number) {
  if (at === index.value) emit("play", props.metas[at].url)
  else emit("select", at)
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "ArrowLeft") {
    event.preventDefault()
    step(-1)
  } else if (event.key === "ArrowRight") {
    event.preventDefault()
    step(1)
  } else if (event.key === "Enter" && current.value) {
    event.preventDefault()
    emit("play", current.value.url)
  }
}

function coverFailed(url: string) {
  failedCovers.value = new Set([...failedCovers.value, url])
}
</script>

<template>
  <div v-if="current" class="media-coverflow" role="group" :aria-label="t('mediaCard.openInBrowser')" data-media-coverflow data-selectable="none" tabindex="0" @keydown="onKeydown">
    <div class="media-coverflow-stage">
      <button
        v-for="(meta, at) in metas"
        :key="meta.url"
        type="button"
        class="media-coverflow-cover"
        :style="coverStyle(at)"
        :title="meta.title"
        :aria-label="`${platformName(meta)}: ${meta.title || t('mediaCard.openInBrowser')}`"
        data-media-card
        :data-media-url="meta.url"
        :aria-current="at === index ? 'true' : undefined"
        @click="press(at)"
      >
        <img v-if="meta.coverUrl && !failedCovers.has(meta.url)" :src="meta.coverUrl" alt="" draggable="false" referrerpolicy="no-referrer" data-media-cover @error="coverFailed(meta.url)" />
        <span v-else class="media-coverflow-plate" :style="badge(meta)">{{ platformName(meta) }}</span>
        <span v-if="meta.durationSec" class="media-coverflow-duration" data-media-duration>{{ audioClock(meta.durationSec) }}</span>
        <span v-if="at === index" class="media-coverflow-play" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l10.5-6.5L8 5.5Z" /></svg>
        </span>
      </button>
    </div>
    <div class="media-coverflow-caption">
      <span class="media-coverflow-title" data-media-title>{{ current.title || t("mediaCard.openInBrowser") }}</span>
      <span class="media-coverflow-meta">
        <span class="media-coverflow-badge" :style="badge(current)" data-media-platform>{{ platformName(current) }}</span>
        <span v-if="current.author" class="media-coverflow-author">{{ current.author }}</span>
      </span>
    </div>
    <div class="media-coverflow-nav">
      <button type="button" class="media-coverflow-step" :aria-label="t('mediaCard.prevCard')" :disabled="index === 0" data-media-prev @click="step(-1)">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
      </button>
      <span class="media-coverflow-counter" data-media-counter>{{ index + 1 }} / {{ metas.length }}</span>
      <button type="button" class="media-coverflow-step" :aria-label="t('mediaCard.nextCard')" :disabled="index === metas.length - 1" data-media-next @click="step(1)">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.media-coverflow {
  margin-top: 10px;
  overscroll-behavior: contain;
  border-radius: 8px;
}

.media-coverflow:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: 3px;
}

/* MiMo's stage: 176 high with a 1000px perspective, the covers 280 by 158. */
.media-coverflow-stage {
  position: relative;
  height: 176px;
  margin: 0 auto;
  overflow: clip visible;
  perspective: 1000px;
}

.media-coverflow-cover {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 280px;
  height: 158px;
  padding: 0;
  overflow: hidden;
  background: #f8f7f5;
  border: 1px solid #f0ebe5;
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
  cursor: pointer;
  transition:
    transform 0.2s cubic-bezier(0.16, 1, 0.3, 1),
    opacity 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}

.media-coverflow-cover:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: 2px;
}

.media-coverflow-cover img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.media-coverflow-plate {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 600;
}

.media-coverflow-duration {
  position: absolute;
  right: 6px;
  bottom: 6px;
  padding: 1px 5px;
  color: #fff;
  background: rgb(0 0 0 / 0.65);
  border-radius: 5px;
  font-family: var(--font-mono);
  font-size: calc(11px * var(--code-font-scale, 1));
}

.media-coverflow-play {
  position: absolute;
  top: 50%;
  left: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  color: #fff;
  background: rgb(0 0 0 / 0.5);
  border-radius: 9999px;
  backdrop-filter: blur(4px);
  opacity: 0;
  transform: translate(-50%, -50%);
  transition: opacity 0.12s;
}

.media-coverflow-cover:hover .media-coverflow-play {
  opacity: 1;
}

.media-coverflow-caption {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  margin-top: 12px;
  padding: 0 12px;
  text-align: center;
}

.media-coverflow-title {
  display: -webkit-box;
  max-width: 420px;
  overflow: hidden;
  color: var(--text-strong);
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 600;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 1;
}

.media-coverflow-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.media-coverflow-badge {
  padding: 1px 4px;
  border-radius: 4px;
  font-size: calc(11px * var(--ui-font-scale, 1));
  font-weight: 500;
}

.media-coverflow-author {
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.media-coverflow-nav {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-top: 8px;
  color: var(--text-base);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.media-coverflow-step {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  color: inherit;
  background: transparent;
  border: 1px solid #f0ebe5;
  border-radius: 9999px;
  cursor: pointer;
  transition: border-color 0.12s;
}

.media-coverflow-step:hover:not(:disabled) {
  border-color: #3295fb;
}

.media-coverflow-step:disabled {
  cursor: default;
  opacity: 0.35;
}

.media-coverflow-step:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: 2px;
}

.media-coverflow-counter {
  font-variant-numeric: tabular-nums;
}

:root[data-theme="dark"] .media-coverflow-cover {
  background: #141414;
  border-color: #2e2e2e;
}

/*
 * The state is repeated here, and its absence was invisible in light.
 *
 * This is the *equal* specificity form of the trap round 23 found: both
 * `.media-coverflow-step:hover:not(:disabled)` and this rule are (0,3,0), so
 * the theme rule does not outrank the state rule - it simply comes later and
 * wins on source order. The border is the only thing this button's hover
 * changes, so in dark the arrows did nothing at all under the pointer (R25-D1).
 */
:root[data-theme="dark"] .media-coverflow-step {
  border-color: #2e2e2e;
}

:root[data-theme="dark"] .media-coverflow-step:hover:not(:disabled) {
  border-color: #3295fb;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .media-coverflow-cover {
    background: #141414;
    border-color: #2e2e2e;
  }

  :root:not([data-theme="light"]) .media-coverflow-step {
    border-color: #2e2e2e;
  }

  :root:not([data-theme="light"]) .media-coverflow-step:hover:not(:disabled) {
    border-color: #3295fb;
  }
}
</style>
