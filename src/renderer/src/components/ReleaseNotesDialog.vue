<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import { t } from "../lib/i18n"
import type { Highlight } from "../lib/changelog"

/**
 * What changed since the version last run, one highlight at a time.
 *
 * Paged rather than listed, which is opencode's shape: a fixed 720x400 that
 * does not grow with the number of notes, a secondary Next until the last one
 * and then a primary that dismisses. Left and right arrows page it, and the
 * way out of ever seeing it again is on the dialog itself rather than only in
 * settings - a popup that appears unasked should carry its own off switch.
 */
const props = defineProps<{ highlights: Highlight[] }>()
const emit = defineEmits<{ close: []; disable: [] }>()

const index = ref(0)
const last = computed(() => Math.max(0, props.highlights.length - 1))
const feature = computed(() => props.highlights[index.value] ?? props.highlights[last.value])
const paged = computed(() => props.highlights.length > 1)
const isFirst = computed(() => index.value === 0)
const isLast = computed(() => index.value >= last.value)

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault()
    emit("close")
    return
  }
  if (!paged.value) return
  if (event.key === "ArrowLeft" && !isFirst.value) {
    event.preventDefault()
    index.value -= 1
  }
  if (event.key === "ArrowRight" && !isLast.value) {
    event.preventDefault()
    index.value += 1
  }
}

onMounted(() => window.addEventListener("keydown", onKeydown))
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown))
</script>

<template>
  <div class="scrim" @mousedown.self="emit('close')">
    <div v-modal class="dialog" role="dialog" aria-modal="true">
      <div class="media">
        <!--
          Only when the release carries one. A note with no picture keeps the
          same box rather than collapsing it, so paging does not resize the
          dialog under the pointer.
        -->
        <video
          v-if="feature?.media?.type === 'video'"
          class="shot"
          :src="feature.media.src"
          autoplay
          loop
          muted
          playsinline
          :aria-label="t('rel.alt')"
        />
        <img v-else-if="feature?.media" class="shot" :src="feature.media.src" :alt="feature.media.alt || t('rel.alt')" />
      </div>

      <div class="text">
        <h2>{{ feature?.title ?? "" }}</h2>
        <p>{{ feature?.description ?? "" }}</p>
      </div>

      <footer>
        <button class="hide" @click="emit('disable')">{{ t("rel.hide") }}</button>
        <!-- The dots say how many are left, which the buttons alone do not. -->
        <div v-if="paged" class="dots">
          <span v-for="(_, at) in highlights" :key="at" class="dot" :class="{ on: at === index }" />
        </div>
        <button v-if="isLast" class="go" @click="emit('close')">{{ t("rel.start") }}</button>
        <button v-else class="next" @click="index += 1">{{ t("rel.next") }}</button>
      </footer>
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

/*
 * 720x400 with a 20px margin against a small window, sitting above centre -
 * measured off opencode's own `w-[min(calc(100vw-40px),720px)]
 * h-[min(calc(100vh-40px),400px)] -mt-20`.
 */
.dialog {
  display: flex;
  flex-direction: column;
  width: min(720px, calc(100vw - 40px));
  height: min(400px, calc(100vh - 40px));
  margin-top: -80px;
  overflow: hidden;
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-lg);
}

.media {
  display: grid;
  flex: 1;
  place-items: center;
  min-height: 0;
  background: var(--surface-raised-hover);
}

.shot {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.text {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  gap: 6px;
  padding: 20px 24px 0;
}

h2 {
  margin: 0;
  color: var(--text-strong);
  font-size: calc(16px * var(--ui-font-scale, 1));
  font-weight: 560;
  line-height: 20px;
}

p {
  margin: 0;
  color: var(--text-base);
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: 18px;
}

footer {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 12px;
  padding: 16px 24px 20px;
}

.dots {
  display: flex;
  gap: 6px;
  margin-inline-start: auto;
}

.dot {
  width: 6px;
  height: 6px;
  background: color-mix(in srgb, var(--text-strong) 24%, var(--surface-raised));
  border-radius: 50%;
}

.dot.on {
  background: var(--text-strong);
}

.hide {
  padding: 0;
  color: var(--text-weak);
  background: none;
  border: 0;
  font-size: calc(12px * var(--ui-font-scale, 1));
  cursor: pointer;
}

.hide:hover {
  color: var(--text-base);
}

/* No dots means nothing has pushed the action to the trailing edge yet. */
.go,
.next {
  height: 32px;
  padding: 0 16px;
  border: 0;
  border-radius: 8px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 500;
  cursor: pointer;
}

.dots ~ .go,
.dots ~ .next {
  margin-inline-start: 0;
}

.hide + .go,
.hide + .next {
  margin-inline-start: auto;
}

.go {
  color: var(--surface-base);
  background: var(--text-strong);
}

.next {
  color: var(--text-strong);
  background: var(--surface-selected);
}
</style>
