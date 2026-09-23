<script lang="ts">
import { reactive } from "vue"
import type { UpdateReason } from "@shared/update-reason"
// Aliased: the setup block below imports `t` itself.
import { t as translate } from "../lib/i18n"
import { notifyFailure } from "../lib/toast"

/** Where a downloaded update stands; the capsule shows only for the last three. */
export type UpdatePhase = "idle" | "ready" | "installing" | "failed"

/*
 * Shared rather than passed down: the app finds the update, the side column's
 * footer shows it, and threading four props through the column is more wiring
 * than the state is worth.
 */
export const updateState = reactive({ phase: "idle" as UpdatePhase, version: "", notes: "", error: "" })

export function markUpdateReady(version: string, notes: string): void {
  updateState.version = version
  updateState.notes = notes
  updateState.error = ""
  updateState.phase = "ready"
}

/* MiMo's start watchdog: an installer that has not taken over by then never will. */
export const INSTALL_WATCHDOG = 8000
let watchdog: ReturnType<typeof setTimeout> | undefined

/* MiMo 26.920's nine reasons, each its own sentence. */
export const UPDATE_REASON_KEYS: Record<UpdateReason, string> = {
  "no-ready": "update.reason.noReady",
  staging: "update.reason.staging",
  "read-only-volume": "update.reason.readOnlyVolume",
  "install-failed": "update.reason.installFailed",
  "not-started": "update.reason.notStarted",
  "version-mismatch": "update.reason.versionMismatch",
  stale: "update.reason.stale",
  disabled: "update.reason.disabled",
  unknown: "update.reason.unknown",
}

/** The sentence for a reason, with the detail on a line of its own when there is one. */
export function updateFailureText(reason: UpdateReason, hint = ""): string {
  const said = translate(UPDATE_REASON_KEYS[reason] ?? UPDATE_REASON_KEYS.unknown)
  return hint ? `${said}\n${hint}` : said
}

/*
 * An electron IPC reply lost because the app is already going away - the
 * install began and quit took the window with it. Not a failure to report.
 */
function goneAway(message: string): boolean {
  const said = message.toLowerCase()
  return said.includes("reply was never sent") || said.includes("render frame was disposed") || said.includes("object has been destroyed")
}

/* The capsule turns to 重试 with the reason, and MiMo's danger notice says it too. */
export function markUpdateFailed(reason: UpdateReason, hint = "", version?: string): void {
  if (watchdog) clearTimeout(watchdog)
  watchdog = undefined
  if (version) updateState.version = version
  updateState.error = updateFailureText(reason, hint)
  updateState.phase = "failed"
  notifyFailure(translate(UPDATE_REASON_KEYS[reason] ?? UPDATE_REASON_KEYS.unknown), hint || undefined)
}

/** Runs the installer the main process fetched; a failure stays on the capsule as 重试. */
export async function installUpdate(): Promise<void> {
  if (updateState.phase === "installing") return
  updateState.phase = "installing"
  updateState.error = ""
  if (watchdog) clearTimeout(watchdog)
  watchdog = setTimeout(() => {
    watchdog = undefined
    if (updateState.phase === "installing") markUpdateFailed("not-started")
  }, INSTALL_WATCHDOG)
  try {
    const answer = await window.mcode.installUpdate()
    if (!answer.ok && updateState.phase === "installing") markUpdateFailed(answer.reason, answer.hint)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (goneAway(message)) return
    /*
     * As MiMo 26.920: a thrown call says only the reason's sentence, on the
     * capsule and in the notice. The raw IPC error is for the console, never
     * the reader; only the main process's own {ok: false} answer carries a hint.
     */
    console.warn("MCode: installing the update failed:", message)
    markUpdateFailed("install-failed")
  }
}
</script>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue"
import { t } from "../lib/i18n"

/**
 * MiMo's update capsule and its bubble.
 *
 * The capsule sits in the side column's footer while an update is ready,
 * installing or failed. Pressing it opens a non-modal bubble above it with the
 * version, the release notes and two buttons; nothing ever interrupts with a
 * modal for an update that is merely ready.
 */
const WIDTH = 360
const EDGE = 8

const pill = ref<HTMLButtonElement>()
const bubble = ref<HTMLElement>()
const open = ref(false)
const spot = ref({ left: 0, bottom: 0 })

const visible = computed(() => updateState.phase !== "idle")
const label = computed(() =>
  updateState.phase === "installing"
    ? t("update.pillInstalling")
    : updateState.phase === "failed"
      ? t("update.pillRetry")
      : t("update.pill"),
)
const tip = computed(() => (updateState.phase === "failed" ? updateState.error : t("update.readyTip", { version: updateState.version })))
/* One row per non-empty line of the notes, as MiMo lists them. */
const notes = computed(() =>
  updateState.notes
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*·•]\s*/, "").trim())
    .filter(Boolean),
)

/* Above the capsule, its end edge on the capsule's end edge, kept inside the window. */
function place() {
  const rect = pill.value?.getBoundingClientRect()
  if (!rect) return
  const rtl = document.documentElement.dir === "rtl"
  const wanted = rtl ? rect.left : rect.right - WIDTH
  spot.value = {
    left: Math.max(EDGE, Math.min(wanted, window.innerWidth - WIDTH - EDGE)),
    bottom: window.innerHeight - rect.top + 8,
  }
}

async function toggle() {
  open.value = !open.value
  if (!open.value) return
  place()
  await nextTick()
}

function onPointerDown(event: MouseEvent) {
  if (!open.value) return
  const target = event.target as Node
  if (bubble.value?.contains(target) || pill.value?.contains(target)) return
  open.value = false
}

function onKeydown(event: KeyboardEvent) {
  if (open.value && event.key === "Escape") {
    event.stopPropagation()
    open.value = false
  }
}

onMounted(() => {
  window.addEventListener("mousedown", onPointerDown, true)
  window.addEventListener("keydown", onKeydown, true)
  window.addEventListener("resize", place)
})
onBeforeUnmount(() => {
  window.removeEventListener("mousedown", onPointerDown, true)
  window.removeEventListener("keydown", onKeydown, true)
  window.removeEventListener("resize", place)
})
</script>

<template>
  <div v-if="visible" class="update-pill-row">
    <button
      ref="pill"
      class="update-pill"
      :class="updateState.phase"
      type="button"
      data-update-pill
      :disabled="updateState.phase === 'installing'"
      :title="tip"
      :aria-expanded="open"
      @click="toggle"
    >
      {{ label }}
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        ref="bubble"
        class="update-bubble"
        data-update-bubble
        role="dialog"
        :aria-label="t('update.panelTitle', { version: updateState.version })"
        :style="{ left: `${spot.left}px`, bottom: `${spot.bottom}px` }"
      >
        <!--
          The 87px band MiMo draws above the bubble, with MCode's own art: an
          upward arrow on a filled disc inside two faint rings.
        -->
        <div class="ub-hero" data-update-hero aria-hidden="true">
          <svg class="ub-art" width="360" height="87" viewBox="0 0 360 87" fill="none">
            <circle class="ub-ring" cx="180" cy="44" r="60" />
            <circle class="ub-ring" cx="180" cy="44" r="40" />
            <circle class="ub-disc" cx="180" cy="44" r="22" />
            <path class="ub-arrow" d="M180 54.5V33.5M171 42.5l9-9 9 9" />
          </svg>
        </div>
        <div class="ub-body">
          <div class="ub-title">{{ t("update.panelTitle", { version: updateState.version }) }}</div>
          <ul v-if="notes.length" class="ub-notes">
            <li v-for="(line, index) in notes" :key="index"><span class="ub-dot" aria-hidden="true">·</span>{{ line }}</li>
          </ul>
          <p v-else class="ub-notes-empty">{{ t("update.notesEmpty") }}</p>
          <p v-if="updateState.phase === 'failed' && updateState.error" class="ub-error">{{ updateState.error }}</p>
          <p class="ub-hint">{{ t("update.installHint") }}</p>
          <div class="ub-actions">
            <button class="ub-btn secondary" type="button" data-update-later @click="open = false">
              {{ t("update.later") }}
            </button>
            <button
              class="ub-btn primary"
              type="button"
              data-update-now
              :disabled="updateState.phase === 'installing'"
              @click="installUpdate"
            >
              {{ updateState.phase === "installing" ? t("update.pillInstalling") : t("update.restartNow") }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* Beside the side column's bottom row, as MiMo sets its capsule: no box of its own. */
.update-pill-row {
  display: flex;
  flex: none;
}

/* MiMo's capsule: 24 tall, 6 round, 12px on 8px of side padding. */
.update-pill {
  box-sizing: border-box;
  height: calc(24px * var(--ui-font-scale, 1));
  padding: 0 8px;
  color: #fff;
  background: #0077fa;
  border: 1px solid transparent;
  border-radius: 6px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-weight: 400;
  white-space: nowrap;
  cursor: pointer;
  -webkit-app-region: no-drag;
}

.update-pill:hover:not(:disabled) {
  opacity: 0.9;
}

.update-pill:disabled {
  opacity: 0.6;
  cursor: default;
}

.update-pill.failed {
  color: #fff;
  background: #d93025;
}

:root[data-theme="dark"] .update-pill:not(.failed) {
  color: #6ea8fe;
  background: #2f6fed38;
  background: color-mix(in srgb, #2f6fed 22%, transparent);
  border-color: var(--border-weak);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .update-pill:not(.failed) {
    color: #6ea8fe;
    background: #2f6fed38;
    background: color-mix(in srgb, #2f6fed 22%, transparent);
    border-color: var(--border-weak);
  }
}
</style>

<style>
/* Unscoped: the bubble is teleported to <body>. */
.update-bubble {
  position: fixed;
  z-index: 140;
  box-sizing: border-box;
  width: 360px;
  max-width: calc(100vw - 16px);
  padding: 0;
  overflow: hidden;
  background: var(--surface-page);
  border: 0;
  border-radius: 20px;
  box-shadow: var(--shadow-composer);
}

/* MiMo's 87px hero band across the top; the art is MCode's own. */
.update-bubble .ub-hero {
  display: grid;
  place-items: center;
  height: 87px;
  overflow: hidden;
  background: #eef4ff;
}

.update-bubble .ub-art {
  display: block;
  flex: none;
}

.update-bubble .ub-ring {
  stroke: #0077fa;
  stroke-opacity: 0.16;
  stroke-width: 1.5;
}

.update-bubble .ub-disc {
  fill: #0077fa;
}

.update-bubble .ub-arrow {
  stroke: #fff;
  stroke-width: 2.4;
  stroke-linecap: round;
  stroke-linejoin: round;
}

:root[data-theme="dark"] .update-bubble .ub-hero {
  background: #1b2230;
}

:root[data-theme="dark"] .update-bubble .ub-ring {
  stroke: #6ea8fe;
  stroke-opacity: 0.24;
}

:root[data-theme="dark"] .update-bubble .ub-disc {
  fill: #2f6fed;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .update-bubble .ub-hero {
    background: #1b2230;
  }

  :root:not([data-theme="light"]) .update-bubble .ub-ring {
    stroke: #6ea8fe;
    stroke-opacity: 0.24;
  }

  :root:not([data-theme="light"]) .update-bubble .ub-disc {
    fill: #2f6fed;
  }
}

.update-bubble .ub-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 20px 20px 16px;
}

.update-bubble .ub-title {
  color: var(--text-strong);
  font-size: calc(16px * var(--ui-font-scale, 1));
  font-weight: 500;
  text-align: center;
}

.update-bubble .ub-notes {
  max-height: 200px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

/*
 * MiMo's update panel writes a note in --color-txt and puts only its bullet in
 * --color-mut; the empty line and the install hint are --color-mut whole. All
 * three are 12px over 1.6.
 */
.update-bubble .ub-notes li,
.update-bubble .ub-notes-empty,
.update-bubble .ub-hint {
  margin: 0;
  color: var(--text-base);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 1.6;
}

.update-bubble .ub-notes li {
  color: var(--text-body);
}

.update-bubble .ub-dot {
  margin-inline-end: 6px;
  color: var(--text-base);
}

/* The reason, then any detail on its own line. */
.update-bubble .ub-error {
  margin: 0;
  white-space: pre-line;
  color: #d93025;
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 1.6;
}

:root[data-theme="dark"] .update-bubble .ub-error {
  color: #ff9b7f;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .update-bubble .ub-error {
    color: #ff9b7f;
  }
}

.update-bubble .ub-actions {
  display: flex;
  justify-content: flex-end;
  gap: 7px;
  margin-block-start: 4px;
}

/* Both buttons: 28 tall pills with 16px of side padding. */
.update-bubble .ub-btn {
  height: calc(28px * var(--ui-font-scale, 1));
  padding: 0 16px;
  border: 1px solid transparent;
  border-radius: 999px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  cursor: pointer;
}

.update-bubble .ub-btn.secondary {
  color: var(--text-strong);
  background: var(--surface-base);
  border-color: var(--border-weak);
}

.update-bubble .ub-btn.secondary:hover {
  background: var(--surface-hover);
}

.update-bubble .ub-btn.primary {
  color: var(--button-primary-text);
  background: var(--button-primary);
}

.update-bubble .ub-btn.primary:hover:not(:disabled) {
  opacity: 0.9;
}

.update-bubble .ub-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
</style>
