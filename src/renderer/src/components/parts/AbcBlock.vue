<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { t } from "../../lib/i18n"
import { notifyFailure } from "../../lib/toast"
import { prepareScoreAudio, renderScore, type RenderedScore, type ScoreAudio } from "../../lib/abc"
import { claimScoreAudio, progressAt, releaseScoreAudio } from "../../lib/abc-play"

/**
 * MiMo's ABC block: an ```abc fence (or an .abc file in the files tab) drawn
 * as a score in the code block's frame, with 播放, 乐谱/代码 tabs and copy.
 * A source abcjs cannot read as music falls back to the code with MiMo's note.
 * While a tune plays, a thin progress bar sits over the score, the sounding
 * notes are lit, and a press on the bar or on a note seeks.
 *
 * abcjs's markup is sanitised in lib/abc before it reaches the page.
 */
const props = defineProps<{ code: string }>()

const tab = ref<"score" | "code">("score")
const ready = ref(false)
const failed = ref(false)
const state = ref<"idle" | "loading" | "playing" | "paused">("idle")
const progress = ref(0)
const copied = ref(false)
const score = ref<HTMLElement>()

const source = computed(() => props.code.replace(/\n+$/, ""))
const lines = computed(() => source.value.split("\n"))
const showingScore = computed(() => tab.value === "score" && !failed.value)
const playLabel = computed(() => (state.value === "playing" ? t("abc.pause") : state.value === "loading" ? t("abc.loading") : t("abc.play")))

let rendered: RenderedScore | undefined
let audio: ScoreAudio | undefined
let lit: Element[] = []
let generation = 0
let copiedTimer: ReturnType<typeof setTimeout> | undefined

/* abcjs names its own elements; the lit ones are their copies on the page. */
function light(elements: Element[]) {
  for (const element of lit) element.classList.remove("abc-note-active")
  lit = []
  for (const element of elements) {
    const copy = rendered?.copies.get(element)
    if (!copy) continue
    copy.classList.add("abc-note-active")
    lit.push(copy)
  }
}

function stop() {
  audio?.stop()
  audio = undefined
  light([])
  progress.value = 0
  state.value = "idle"
}

async function draw() {
  const mine = ++generation
  stop()
  releaseScoreAudio(stop)
  rendered = undefined
  ready.value = false
  failed.value = false
  const host = score.value
  if (!host) return
  try {
    const result = await renderScore(host, source.value)
    if (mine !== generation) return
    rendered = result
    ready.value = true
  } catch {
    if (mine !== generation) return
    host.innerHTML = ""
    failed.value = true
    tab.value = "code"
  }
}

watch(source, () => void draw())
onMounted(() => void draw())

onBeforeUnmount(() => {
  generation += 1
  stop()
  releaseScoreAudio(stop)
  clearTimeout(copiedTimer)
})

function ended() {
  audio = undefined
  light([])
  progress.value = 0
  state.value = "idle"
}

async function togglePlay() {
  if (state.value === "playing") {
    audio?.pause()
    state.value = "paused"
    return
  }
  if (state.value === "paused") {
    claimScoreAudio(stop)
    audio?.resume()
    state.value = "playing"
    return
  }
  if (state.value === "loading" || !rendered) return
  state.value = "loading"
  const mine = generation
  try {
    claimScoreAudio(stop)
    const prepared = await prepareScoreAudio(rendered.tune, ended, { onEvent: light, onProgress: (share) => (progress.value = share) })
    // Another score started, or this one was redrawn, while the audio was being made.
    if (mine !== generation || state.value !== "loading") {
      prepared.stop()
      return
    }
    audio = prepared
    await prepared.start()
    state.value = "playing"
  } catch {
    releaseScoreAudio(stop)
    state.value = "idle"
    notifyFailure(t("abc.playFailed"))
  }
}

/* The bar seeks where it is pressed and follows the pointer until it is let go. */
function seekFrom(event: PointerEvent) {
  const bar = event.currentTarget as HTMLElement
  if (!audio) return
  const box = bar.getBoundingClientRect()
  const seekTo = (x: number) => {
    const share = progressAt(x, box.left, box.width)
    if (share === undefined || !audio) return
    audio.seek(share)
    progress.value = share
  }
  bar.setPointerCapture?.(event.pointerId)
  seekTo(event.clientX)
  const move = (next: PointerEvent) => seekTo(next.clientX)
  const up = () => {
    window.removeEventListener("pointermove", move)
    window.removeEventListener("pointerup", up)
  }
  window.addEventListener("pointermove", move)
  window.addEventListener("pointerup", up)
}

/* MiMo's note press while a tune plays: the tune jumps to that note. */
function onScoreClick(event: MouseEvent) {
  const player = audio
  if (!player || !rendered || player.durationMs <= 0) return
  for (let node = event.target instanceof Element ? event.target : null; node && node !== score.value; node = node.parentElement) {
    const original = rendered.originals.get(node)
    if (!original) continue
    const hit = player.timings.find((timing) => timing.elements?.some((group) => group.some((element) => element === original)))
    if (!hit) continue
    const share = Math.min(1, Math.max(0, hit.milliseconds / player.durationMs))
    player.seek(share)
    progress.value = share
    return
  }
}

async function copy() {
  try {
    await navigator.clipboard.writeText(source.value)
    copied.value = true
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => (copied.value = false), 2000)
  } catch {
    notifyFailure(t("code.copyFailed"))
  }
}

const lineEnd = (index: number) => (index < lines.value.length - 1 ? "\n" : "")
</script>

<template>
  <div class="md-codeblock md-abc" data-abc-block>
    <div class="md-code-head md-abc-head">
      <span class="md-code-lang">abc</span>
      <div class="md-abc-tools">
        <button
          v-if="ready && !failed"
          type="button"
          class="md-code-copy md-abc-play"
          data-abc-play
          :data-state="state"
          :aria-label="state === 'playing' ? t('abc.pauseAria') : t('abc.playAria')"
          @click="togglePlay"
        >
          <svg v-if="state === 'loading'" class="md-abc-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-6.22-8.56" />
          </svg>
          <svg v-else-if="state === 'playing'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true">
            <rect x="6" y="4" width="4" height="16" rx="1" />
            <rect x="14" y="4" width="4" height="16" rx="1" />
          </svg>
          <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true">
            <path d="M6 3.5v17l14-8.5-14-8.5Z" />
          </svg>
          <span>{{ playLabel }}</span>
        </button>
        <div class="md-abc-tabs" role="tablist">
          <button type="button" role="tab" data-abc-tab="score" :aria-selected="showingScore" :class="{ on: showingScore }" :disabled="failed" @click="tab = 'score'">
            {{ t("abc.score") }}
          </button>
          <button type="button" role="tab" data-abc-tab="code" :aria-selected="!showingScore" :class="{ on: !showingScore }" @click="tab = 'code'">
            {{ t("abc.code") }}
          </button>
        </div>
        <button type="button" class="md-code-copy" :class="{ copied }" data-abc-copy :aria-label="t('code.copyLabel')" @click="copy">
          <svg class="md-code-icon idle" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.2" />
            <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" stroke="currentColor" stroke-width="1.2" />
          </svg>
          <svg class="md-code-icon done" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3.5 8.5 6.5 11.5 12.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span class="md-code-word idle">{{ t("code.copy") }}</span>
          <span class="md-code-word done">{{ t("code.copied") }}</span>
        </button>
      </div>
    </div>

    <div v-show="showingScore" class="md-abc-view">
      <div v-if="state === 'playing' || state === 'paused'" class="md-abc-progress" data-abc-progress @pointerdown="seekFrom">
        <div class="md-abc-track">
          <div class="md-abc-fill" :style="{ width: `${progress * 100}%` }" />
          <div class="md-abc-knob" :style="{ insetInlineStart: `${progress * 100}%` }" />
        </div>
      </div>
      <div v-if="!ready && !failed" class="md-abc-rendering" data-abc-rendering>{{ t("abc.rendering") }}</div>
      <!-- abcjs's markup, sanitised by lib/abc (svg-safe and DOMPurify) before it is put here. -->
      <div ref="score" class="md-abc-score" data-abc-score @click="onScoreClick" />
    </div>
    <template v-if="!showingScore">
      <div v-if="failed" class="md-abc-error" data-abc-error>{{ t("abc.parseError") }}</div>
      <pre class="md-code md-lined md-abc-source" data-abc-source><code><template v-for="(line, index) in lines" :key="index"><span class="line">{{ line }}</span>{{ lineEnd(index) }}</template></code></pre>
    </template>
  </div>
</template>

<style>
/* Not scoped: the block sits inside a reply's (or the files tab's) .text, beside the code block rules it shares. */
.text .md-abc-head {
  gap: 12px;
}

.text .md-abc-tools {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
}

/* MiMo's segmented tabs, as on the diagram block. */
.text .md-abc-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  background: rgba(0, 0, 0, 0.06);
  border-radius: 7px;
}

.text .md-abc-tabs button {
  padding: 1px 8px;
  color: var(--text-weak);
  background: transparent;
  border: 0;
  border-radius: 5px;
  font: inherit;
  font-size: calc(12px * var(--ui-font-scale, 1));
  transition: color 0.12s;
}

.text .md-abc-tabs button:hover {
  color: var(--text-strong);
}

.text .md-abc-tabs button.on {
  color: var(--text-strong);
  background: var(--surface-raised);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}

.text .md-abc-tabs button:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}

.text .md-abc-spin {
  animation: md-abc-spin 1s linear infinite;
}

@keyframes md-abc-spin {
  to {
    transform: rotate(360deg);
  }
}

/* MiMo's bar: 10 high to press, a 3px track that thickens to 5 with a 9px knob on hover. */
.text .md-abc-progress {
  display: flex;
  align-items: center;
  width: 100%;
  height: 10px;
  cursor: pointer;
  touch-action: none;
}

.text .md-abc-track {
  position: relative;
  width: 100%;
  height: 3px;
  background: rgba(0, 0, 0, 0.08);
  transition: height 0.12s;
}

.text .md-abc-progress:hover .md-abc-track {
  height: 5px;
}

.text .md-abc-fill {
  height: 100%;
  background: #2f6fed;
}

.text .md-abc-knob {
  position: absolute;
  top: 50%;
  width: 9px;
  height: 9px;
  background: #2f6fed;
  border-radius: 50%;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
  opacity: 0;
  transform: translate(-50%, -50%);
  transition: opacity 0.12s;
}

.text .md-abc-progress:hover .md-abc-knob {
  opacity: 1;
}

.text .md-abc-rendering {
  padding: 12px;
  color: var(--text-weak);
  font-size: calc(13px * var(--ui-font-scale, 1));
}

/* The score is always ink on white, in either theme, as MiMo draws it. */
.text .md-abc-score {
  padding: 12px;
  overflow-x: auto;
  color: #151c13;
  background: #fff;
}

.text .md-abc-score svg {
  max-width: 100%;
  height: auto;
}

.text .md-abc-score .abc-note-active {
  fill: #2f6fed;
  stroke: #2f6fed;
}

.text .md-abc-error {
  padding: 8px 12px 0;
  color: #ef4444;
  font-size: calc(13px * var(--ui-font-scale, 1));
}

:root[data-theme="dark"] .text .md-abc-tabs {
  background: rgba(255, 255, 255, 0.08);
}

:root[data-theme="dark"] .text .md-abc-track {
  background: rgba(255, 255, 255, 0.1);
}

:root[data-theme="dark"] .text .md-abc-fill,
:root[data-theme="dark"] .text .md-abc-knob {
  background: #5a9cff;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .text .md-abc-tabs {
    background: rgba(255, 255, 255, 0.08);
  }

  :root:not([data-theme="light"]) .text .md-abc-track {
    background: rgba(255, 255, 255, 0.1);
  }

  :root:not([data-theme="light"]) .text .md-abc-fill,
  :root:not([data-theme="light"]) .text .md-abc-knob {
    background: #5a9cff;
  }
}
</style>
