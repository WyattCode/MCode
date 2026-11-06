<script setup lang="ts">
/**
 * 追求目标: the goal above the composer.
 *
 * MiMo's bar, in this app's own words. One row: a coloured mark, the state in
 * bold, the time the goal has been running, and the goal itself - one line
 * until it is expanded. What the row offers depends on whether the goal is
 * still being worked on:
 *
 * - being worked on, and the turn is running: stop the turn, or leave goal
 *   mode, which takes the goal off the conversation;
 * - being worked on but idle (the reader stopped the turn, or the app was
 *   restarted): the same two, and the state reads Paused;
 * - answered - met, out of reach, or out of tries: rewrite it, run it again,
 *   or put the row away.
 *
 * The chevron appears only when the one line is not enough for the goal, which
 * is measured rather than guessed.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch, useTemplateRef } from "vue"
import type { SessionInfo } from "@shared/protocol"
import { useApp } from "../stores/app"
import { composing } from "../lib/keys"
import { t } from "../lib/i18n"
import { notifyFailure } from "../lib/toast"

const props = defineProps<{ sessionID: string }>()
const app = useApp()

const session = computed(() => app.sessions.find((entry: SessionInfo) => entry.id === props.sessionID))
const goal = computed(() => session.value?.goal)
const running = computed(() => app.running.has(props.sessionID))
const restricted = computed(() => session.value?.reviewRestricted === true)

/** The four words MiMo's bar can say, in its order of precedence. */
const status = computed<"complete" | "blocked" | "active" | "paused">(() => {
  const done = goal.value?.done
  if (done) return done.status
  return running.value ? "active" : "paused"
})
/** Still being pursued: the row offers stopping, not rewriting. */
const live = computed(() => !goal.value?.done)

/*
 * The clock, MiMo's: how long the goal has been running, ticking while it is,
 * frozen at what it took once it is answered. Only the second matters to the
 * reader afterwards, so the interval is torn down as soon as the goal ends.
 */
const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | undefined
const stopTicker = () => {
  if (ticker) clearInterval(ticker)
  ticker = undefined
}
watch(
  () => status.value === "active",
  (on) => {
    stopTicker()
    if (!on) return
    now.value = Date.now()
    ticker = setInterval(() => (now.value = Date.now()), 1000)
  },
  { immediate: true },
)
// Left mid-flight (session switch remounts this bar): do not flash failure on another conversation.
let alive = true
onBeforeUnmount(() => {
  alive = false
  stopTicker()
})

const elapsed = computed(() => {
  const start = goal.value?.startedAt
  if (!start) return ""
  const end = goal.value?.done?.at ?? now.value
  const seconds = Math.max(0, Math.round((end - start) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
})

/** What the judge said, with this app's own words for the one case where it said nothing. */
const reason = computed(() => {
  const done = goal.value?.done
  if (!done) return ""
  return done.reason === "judge-failed" ? t("composer.goalBar.judgeFailed") : done.reason
})

const expanded = ref(false)
const editing = ref(false)
const draft = ref("")
const overflowing = ref(false)
const lineEl = useTemplateRef<HTMLElement>("lineEl")
const inputEl = useTemplateRef<HTMLInputElement>("inputEl")

/*
 * Whether the one line is cut off, measured on the element: the chevron is
 * offered only when there is something more to see. Re-measured whenever the
 * text, the state or the box can have changed size.
 */
let watcher: ResizeObserver | undefined
const measure = () => {
  const el = lineEl.value
  overflowing.value = Boolean(el && !expanded.value && el.scrollWidth - el.clientWidth > 1)
}
watch(
  [() => goal.value?.condition, () => status.value, expanded, editing, lineEl],
  async () => {
    await nextTick()
    watcher?.disconnect()
    measure()
    const el = lineEl.value
    if (!el || typeof ResizeObserver === "undefined") return
    watcher = new ResizeObserver(measure)
    watcher.observe(el)
  },
  { immediate: true },
)
onBeforeUnmount(() => watcher?.disconnect())

function startEdit() {
  if (live.value) return
  draft.value = goal.value?.condition ?? ""
  editing.value = true
  void nextTick(() => inputEl.value?.focus())
}

async function commitEdit() {
  if (!editing.value) return
  editing.value = false
  const next = draft.value.trim()
  if (!next || next === goal.value?.condition) return
  const held = props.sessionID
  try {
    await app.setGoal(held, next)
  } catch (err) {
    if (alive && props.sessionID === held) {
      notifyFailure(t("common.requestFailed"), err instanceof Error ? err.message : String(err))
    }
  }
}

const rerunning = ref(false)

/** MiMo's 重新执行: the goal goes in again as a message of its own, which sets it afresh. */
async function rerun() {
  const condition = goal.value?.condition
  if (!condition || restricted.value || rerunning.value) return
  rerunning.value = true
  const held = props.sessionID
  try {
    await app.setGoal(held, condition)
    await app.send(condition, [], held)
  } catch (err) {
    if (alive && props.sessionID === held) {
      notifyFailure(t("common.requestFailed"), err instanceof Error ? err.message : String(err))
    }
  } finally {
    // Always cleared: a throw here would otherwise leave the button dead for
    // the rest of the conversation.
    rerunning.value = false
  }
}

async function dismiss() {
  const held = props.sessionID
  try {
    await app.setGoal(held, null)
  } catch (err) {
    if (alive && props.sessionID === held) {
      notifyFailure(t("common.requestFailed"), err instanceof Error ? err.message : String(err))
    }
  }
}

async function leave() {
  const held = props.sessionID
  try {
    await app.leaveGoal(held)
  } catch (err) {
    if (alive && props.sessionID === held) {
      notifyFailure(t("common.requestFailed"), err instanceof Error ? err.message : String(err))
    }
  }
}
</script>

<template>
  <div v-if="goal" class="goal-bar" :aria-label="t('composer.goalBar.label')" data-goal-bar>
    <div class="goal-scroll">
      <div class="goal-item" :data-goal-item="status">
        <span class="goal-mark" :class="`is-${status}`" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="8" />
            <circle cx="12" cy="12" r="4" />
            <circle cx="12" cy="12" r="0.8" fill="currentColor" />
          </svg>
        </span>
        <span class="goal-body">
          <input
            v-if="editing"
            ref="inputEl"
            v-model="draft"
            class="goal-edit"
            :aria-label="t('composer.goalBar.edit')"
            type="text"
            spellcheck="false"
            data-goal-edit-box
            @blur="commitEdit"
            @keydown.enter="!composing($event) && commitEdit()"
            @keydown.esc="editing = false"
          />
          <span v-else ref="lineEl" class="goal-line" :class="{ open: expanded }" :title="reason || goal.condition">
            <span class="goal-state">{{ t(`composer.goalBar.${status}`) }}</span>
            <span v-if="elapsed" class="goal-clock"> · {{ elapsed }}</span>
            <span class="goal-text">{{ goal.condition }}</span>
          </span>
        </span>

        <template v-if="!live">
          <button class="goal-act" type="button" data-goal-edit :aria-label="t('composer.goalBar.edit')" v-tip="{ label: t('composer.goalBar.edit'), placement: 'top' }" @click="startEdit">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
          </button>
          <button
            class="goal-act"
            type="button"
            data-goal-rerun
            :aria-label="restricted ? t('composer.reviewRestricted') : t('composer.goalBar.resend')"
            :disabled="restricted || rerunning"
            v-tip="{ label: restricted ? t('composer.reviewRestricted') : t('composer.goalBar.resend'), placement: 'top' }"
            @click="rerun"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 1 2.3 5.6M4 12V7M4 12h5" /></svg>
          </button>
          <button class="goal-act" type="button" data-goal-dismiss :aria-label="t('composer.goalBar.dismiss')" v-tip="{ label: t('composer.goalBar.dismiss'), placement: 'top' }" @click="dismiss">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </template>
        <template v-else>
          <button class="goal-act" type="button" data-goal-remove :aria-label="t('composer.goalBar.remove')" v-tip="{ label: t('composer.goalBar.remove'), placement: 'top' }" @click="leave">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6.2h16M9 3h6M6.5 6.2 7 18.9a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l.5-12.7" /></svg>
          </button>
          <button v-if="running" class="goal-act" type="button" data-goal-stop :aria-label="t('composer.goalBar.stop')" v-tip="{ label: t('composer.goalBar.stop'), placement: 'top' }" @click="app.abort(props.sessionID)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="2" /></svg>
          </button>
        </template>

        <button
          v-if="!editing && (expanded || overflowing)"
          class="goal-act"
          type="button"
          :data-goal-toggle="expanded ? 'expanded' : 'collapsed'"
          :aria-label="t(expanded ? 'composer.goalBar.collapse' : 'composer.goalBar.expand')"
          v-tip="{ label: t(expanded ? 'composer.goalBar.collapse' : 'composer.goalBar.expand'), placement: 'top' }"
          @click="expanded = !expanded"
        >
          <svg class="goal-chev" :class="{ open: expanded }" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* MiMo's bar: the composer's own width, a 10px corner, and 12 either side. */
.goal-bar {
  width: 100%;
  margin-bottom: 6px;
  padding: 2px 12px;
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 10px;
}

/* Several answered goals can be waiting to be put away; the row scrolls rather than growing the composer. */
.goal-scroll {
  overflow-y: auto;
  max-height: 176px;
}

.goal-item {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  width: 100%;
  padding-block: 6px;
  color: var(--text-strong);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.goal-mark {
  display: grid;
  flex: none;
  place-items: center;
  height: calc(16px * var(--ui-font-scale, 1));
}

.goal-mark svg {
  width: 14px;
  height: 14px;
}

/* The state's colour, and the mark's: running, done, out of reach, waiting. */
.goal-mark.is-active {
  color: var(--text-interactive);
}

.goal-mark.is-complete {
  color: var(--text-success);
}

.goal-mark.is-blocked {
  color: var(--text-error);
}

.goal-mark.is-paused {
  color: var(--text-warning);
}

.goal-body {
  flex: 1;
  min-width: 0;
}

.goal-line {
  display: block;
  overflow: hidden;
  line-height: calc(16px * var(--ui-font-scale, 1));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.goal-line.open {
  overflow: visible;
  white-space: pre-wrap;
  overflow-wrap: break-word;
}

.goal-state {
  font-weight: 500;
}

.goal-clock {
  color: var(--text-weak);
  font-variant-numeric: tabular-nums;
}

.goal-text {
  margin-inline-start: 6px;
  color: var(--text-weak);
}

.goal-edit {
  width: 100%;
  padding: 2px 6px;
  color: var(--text-strong);
  background: transparent;
  border: 1px solid var(--border-weak);
  border-radius: 5px;
  outline: none;
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: calc(16px * var(--ui-font-scale, 1));
}

.goal-edit:focus {
  border-color: var(--interactive);
}

.goal-act {
  display: grid;
  flex: none;
  place-items: center;
  width: 20px;
  height: 20px;
  padding: 0;
  color: var(--text-weak);
  background: transparent;
  border: 0;
  border-radius: 6px;
  cursor: pointer;
}

.goal-act:hover:not(:disabled) {
  color: var(--text-strong);
  background: var(--surface-selected);
}

.goal-act:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.goal-act:focus-visible {
  outline: 2px solid var(--text-interactive);
  outline-offset: 2px;
}

.goal-act svg {
  width: 13px;
  height: 13px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.goal-chev {
  transition: transform 0.15s;
}

.goal-chev.open {
  transform: rotate(90deg);
}
</style>
