<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import type { CommitResult, CommitState, PushResult } from "@shared/protocol"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"
import { useBranchSwitch } from "../lib/branch-switch"
import InfoBranchMenu from "./InfoBranchMenu.vue"

/**
 * MiMo's 提交或推送 card, beside the info card's row: a message (left blank, the
 * conversation's model writes one), whether to take in unstaged work, and
 * commit, commit and push, or push. What happened is said inside the card.
 *
 * Nothing here runs unless the reader presses a button, and push only ever
 * sends the checked-out branch, unforced (see git.push on the server).
 */
const props = defineProps<{ anchor?: HTMLElement; directory: string; sessionId?: string; additions: number; deletions: number; knownBranch?: string }>()
const emit = defineEmits<{ close: []; mutated: [] }>()

const app = useApp()
const card = ref<HTMLElement>()
const field = ref<HTMLTextAreaElement>()
const pickerButton = ref<HTMLElement>()
const place = ref({ top: 0, left: 0 })

const message = ref("")
const includeUnstaged = ref(true)
const state = ref<CommitState>()
const stateLoading = ref(false)
type Action = "commit" | "commitPush" | "push"
const action = ref<Action | null>(null)
const phase = ref<"gen" | "commit" | "push" | null>(null)
const error = ref("")
const done = ref("")
const pickerOpen = ref(false)

const busy = computed(() => action.value !== null)

async function loadState() {
  const directory = props.directory
  stateLoading.value = true
  try {
    const next = await app.client?.request({ type: "git.commitState", directory })
    // A null client answers undefined; keep what was shown rather than blank the card.
    if (!next) return
    if (props.directory === directory) state.value = next
  } catch (err) {
    if (props.directory === directory) state.value = { ...(state.value ?? blankState()), ok: false, error: String(err) }
  } finally {
    stateLoading.value = false
  }
}

function blankState(): CommitState {
  return {
    ok: false,
    isDetached: false,
    hasHead: false,
    hasChanges: false,
    hasStaged: false,
    stagedAdditions: 0,
    stagedDeletions: 0,
    hasUpstream: false,
    ahead: 0,
    behind: 0,
    hasOrigin: false,
    hasOriginBranch: false,
    changedPaths: [],
  }
}

const switcher = useBranchSwitch(
  () => props.directory,
  () => {
    void loadState()
    emit("mutated")
  },
)
const { branches, loading: branchesLoading, switching, pending, error: branchError, loadBranches, switchTo, clearPending } = switcher

/* MiMo's rules: commit with something to take in; push when on a branch with commits the target lacks. */
const canCommit = computed(() => {
  const current = state.value
  if (!current?.ok || busy.value) return false
  return includeUnstaged.value ? current.hasChanges : current.hasStaged
})

const canPush = computed(() => {
  const current = state.value
  if (!current?.ok || busy.value || !current.branch || current.isDetached || !current.hasHead) return false
  // A push only ever goes to origin's branch of the same name, so that branch alone decides.
  if (!current.hasOrigin) return false
  return current.hasOriginBranch ? current.ahead > 0 : true
})

const stats = computed(() =>
  includeUnstaged.value
    ? { additions: props.additions, deletions: props.deletions }
    : { additions: state.value?.stagedAdditions ?? 0, deletions: state.value?.stagedDeletions ?? 0 },
)

/*
 * MiMo's own order: a detached HEAD says so, otherwise the branch the state
 * named, otherwise the one the environment row already knows - so opening the
 * card does not flash the name away and back - and only with none of those a
 * word about why. A state that came back without a branch (no HEAD yet, a read
 * that failed) is unknownBranch; loadingBranch is for the read still running.
 */
const branchLabel = computed(() => {
  if (state.value?.isDetached) return t("info.detachedHead")
  return state.value?.branch ?? props.knownBranch ?? t(stateLoading.value && !state.value ? "info.loadingBranch" : "info.unknownBranch")
})

const shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘⏎" : "Ctrl+⏎"

function busyLabel(which: Action, idle: string): string {
  if (action.value !== which || !phase.value) return t(idle)
  // Queued behind another git write on the same repository: waiting rather than committing yet (N11-14).
  if (phase.value !== "gen" && app.gitWaiting.has(props.directory)) return t("info.gitWaiting")
  return t(phase.value === "gen" ? "info.genBusy" : phase.value === "commit" ? "info.commitBusy" : "info.pushBusy")
}

function commitError(result: CommitResult): string {
  if (result.code === "nothing-to-commit") return t("info.commitError.nothingToCommit")
  if (result.code === "ident-missing") return t("info.commitError.identMissing")
  if (result.code === "hook-rejected") return t("info.commitError.hookRejected")
  return result.error ? `${t("info.commitError.generic")}: ${result.error}` : t("info.commitError.generic")
}

function pushError(result: PushResult): string {
  if (result.code === "auth") return t("info.pushError.auth")
  if (result.code === "rejected") return t("info.pushError.rejected")
  if (result.code === "no-remote") return t("info.pushError.noRemote")
  if (result.code === "detached") return t("info.pushError.detached")
  return result.error ? `${t("info.pushError.generic")}: ${result.error}` : t("info.pushError.generic")
}

async function runPush(which: Action): Promise<void> {
  action.value = which
  phase.value = "push"
  try {
    const result = await app.client?.request({ type: "git.push", directory: props.directory })
    if (!result) {
      error.value = t("info.pushError.generic")
      return
    }
    if (result.ok) done.value = t("info.pushDone")
    else error.value = pushError(result)
  } catch (err) {
    error.value = `${t("info.pushError.generic")}: ${err instanceof Error ? err.message : String(err)}`
  }
}

async function commit(andPush: boolean) {
  if (!canCommit.value || !state.value) return
  const which: Action = andPush ? "commitPush" : "commit"
  error.value = ""
  done.value = ""
  action.value = which
  try {
    let text = message.value.trim()
    if (!text) {
      phase.value = "gen"
      try {
        const generated = await app.client?.request({
          type: "git.commitMessage",
          directory: props.directory,
          ...(props.sessionId ? { sessionID: props.sessionId } : {}),
          paths: state.value.changedPaths,
        })
        text = generated?.message ?? ""
      } catch {
        text = ""
      }
      // Gen failed or never arrived: refuse a silent "update" commit; surface the miss.
      if (!text) {
        error.value = t("common.requestFailed")
        return
      }
    }
    phase.value = "commit"
    let result: CommitResult | undefined
    try {
      result = await app.client?.request({
        type: "git.commit",
        directory: props.directory,
        message: text,
        includeUnstaged: includeUnstaged.value,
      })
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    if (!result) {
      error.value = t("info.commitError.generic")
      return
    }
    if (!result.ok) {
      error.value = commitError(result)
      return
    }
    done.value = t("info.commitDone", { hash: result.hash ?? "" })
    message.value = ""
    emit("mutated")
    if (andPush) {
      await loadState()
      await runPush(which)
    }
  } finally {
    action.value = null
    phase.value = null
    void loadState()
  }
}

async function push() {
  if (!canPush.value) return
  error.value = ""
  done.value = ""
  try {
    await runPush("push")
    emit("mutated")
  } finally {
    action.value = null
    phase.value = null
    void loadState()
  }
}

function onFieldKey(event: KeyboardEvent) {
  if (event.key === "Escape") return
  // Typing here is not a shortcut for the rest of the window.
  event.stopPropagation()
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !event.isComposing && canCommit.value) {
    event.preventDefault()
    void commit(false)
  }
}

function togglePicker() {
  pickerOpen.value = !pickerOpen.value
  if (pickerOpen.value) void loadBranches()
}

function pickBranch(branch: string) {
  pickerOpen.value = false
  if (branch !== state.value?.branch) void switchTo(branch, state.value?.branch)
}

/* MiMo's popover: left of the row, top-aligned, 8 away, kept 8 inside the window. Physical, from the row's rect. */
function position() {
  const rect = props.anchor?.getBoundingClientRect()
  if (!rect || !card.value) return
  const width = card.value.offsetWidth
  const height = card.value.offsetHeight
  let left = rect.left - 8 - width
  if (left < 8) left = Math.max(8, Math.min(rect.right + 8, window.innerWidth - 8 - width))
  const top = Math.max(8, Math.min(rect.top, window.innerHeight - 8 - height))
  place.value = { top, left }
}

function onPointerDown(event: MouseEvent) {
  const target = event.target as Element | null
  if (!target || card.value?.contains(target) || props.anchor?.contains(target)) return
  if (target.closest?.("[data-info-branch-menu]")) return
  emit("close")
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape" || event.isComposing || pickerOpen.value) return
  event.preventDefault()
  event.stopPropagation()
  if (pending.value) clearPending()
  else emit("close")
}

let observer: ResizeObserver | undefined
const onResize = () => position()

onMounted(() => {
  void loadState()
  void loadBranches()
  position()
  void nextTick(() => {
    position()
    field.value?.focus()
  })
  if (card.value) {
    observer = new ResizeObserver(() => position())
    observer.observe(card.value)
  }
  window.addEventListener("mousedown", onPointerDown, true)
  window.addEventListener("keydown", onKeydown, true)
  window.addEventListener("resize", onResize)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  window.removeEventListener("mousedown", onPointerDown, true)
  window.removeEventListener("keydown", onKeydown, true)
  window.removeEventListener("resize", onResize)
})

watch(
  () => props.directory,
  () => emit("close"),
)
</script>

<template>
  <Teleport to="body">
    <div
      ref="card"
      class="card"
      role="dialog"
      :aria-label="t('info.commitOrPush')"
      data-info-popover
      data-info-commit-card
      :style="{ top: `${place.top}px`, left: `${place.left}px` }"
    >
      <button
        ref="pickerButton"
        type="button"
        class="picker"
        :disabled="!state?.branch || switching || busy"
        aria-haspopup="menu"
        :aria-expanded="pickerOpen"
        data-info-commit-branch
        @click="togglePicker"
      >
        <svg class="picker-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="4.5" cy="3.5" r="1.6" stroke="currentColor" stroke-width="1.2" />
          <circle cx="4.5" cy="12.5" r="1.6" stroke="currentColor" stroke-width="1.2" />
          <circle cx="11.5" cy="5.5" r="1.6" stroke="currentColor" stroke-width="1.2" />
          <path d="M4.5 5.1v5.8M11.5 7.1c0 2.6-2.2 3.4-5.4 3.9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
        </svg>
        <span class="picker-name">{{ branchLabel }}</span>
        <svg v-if="switching" class="spin" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 2.5a5.5 5.5 0 1 1-5.5 5.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
        <svg v-else width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4.5 6.5 8 10l3.5-3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <InfoBranchMenu
        v-if="pickerOpen"
        :anchor="pickerButton"
        :branches="branches"
        :current="state?.branch"
        :loading="branchesLoading"
        @pick="pickBranch"
        @close="pickerOpen = false"
      />

      <div v-if="state && !state.ok && !stateLoading" class="state-error" data-info-commit-state-error>
        <span class="state-error-text">{{ t("info.stateUnavailable") }}</span>
        <button type="button" class="retry" :title="t('info.retryState')" :aria-label="t('info.retryState')" data-info-commit-retry @click="loadState()">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>

      <div v-if="pending" class="dirty" data-info-commit-dirty-confirm>
        <span>{{ t("info.branchDirtyConfirm", { branch: pending }) }}</span>
        <div class="dirty-actions">
          <button type="button" class="dirty-go" data-info-commit-dirty-force @click="switchTo(pending!, state?.branch, true)">
            {{ t("info.branchConfirmSwitch") }}
          </button>
          <button type="button" class="dirty-cancel" data-info-commit-dirty-cancel @click="clearPending()">
            {{ t("info.branchCancel") }}
          </button>
        </div>
      </div>

      <textarea
        ref="field"
        v-model="message"
        rows="3"
        class="message"
        :disabled="busy"
        :placeholder="t('info.commitPlaceholder')"
        spellcheck="false"
        data-info-commit-message
        @keydown="onFieldKey"
      />

      <button
        type="button"
        class="row actionable"
        role="checkbox"
        :aria-checked="includeUnstaged"
        :disabled="busy"
        data-info-commit-include-unstaged
        @click="includeUnstaged = !includeUnstaged"
      >
        <span class="check">
          <svg v-if="includeUnstaged" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3.5 8.2 6.4 11.1 12.5 5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
        <span class="label">{{ t("info.includeUnstaged") }}</span>
        <span class="stats" data-info-commit-stats>
          <span class="add">+{{ stats.additions }}</span>
          <span class="del">-{{ stats.deletions }}</span>
        </span>
      </button>

      <div class="rule" role="separator" />

      <button type="button" class="row actionable" :disabled="!canCommit" data-info-commit-action="commit" @click="commit(false)">
        <svg v-if="action === 'commit'" class="icon spin" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 2.5a5.5 5.5 0 1 1-5.5 5.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
        <svg v-else class="icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="2.6" stroke="currentColor" stroke-width="1.3" />
          <path d="M1.5 8h3.9M10.6 8h3.9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
        </svg>
        <span class="label">{{ busyLabel("commit", "info.commitAction") }}</span>
        <kbd class="kbd">{{ shortcut }}</kbd>
      </button>
      <button type="button" class="row actionable" :disabled="!canCommit" data-info-commit-action="commit-push" @click="commit(true)">
        <svg v-if="action === 'commitPush'" class="icon spin" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 2.5a5.5 5.5 0 1 1-5.5 5.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
        <svg v-else class="icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 13V3.5M4 7.2 8 3.2l4 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span class="label">{{ busyLabel("commitPush", "info.commitAndPush") }}</span>
      </button>
      <button type="button" class="row actionable" :disabled="!canPush" data-info-commit-action="push" @click="push()">
        <svg v-if="action === 'push'" class="icon spin" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 2.5a5.5 5.5 0 1 1-5.5 5.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
        <svg v-else class="icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 13V3.5M4 7.2 8 3.2l4 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span class="label">{{ busyLabel("push", "info.pushAction") }}</span>
      </button>

      <p v-if="error || branchError" class="line error" role="alert" data-info-commit-error>{{ error || branchError }}</p>
      <p v-else-if="done" class="line done" data-info-commit-done>{{ done }}</p>
    </div>
  </Teleport>
</template>

<style scoped>
.card {
  position: fixed;
  z-index: 110;
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 300px;
  max-width: calc(100vw - 16px);
  padding: 10px;
  background: color-mix(in srgb, var(--surface-menu) 92%, transparent);
  border: 0.5px solid var(--border-input);
  border-radius: 16px;
  box-shadow: var(--shadow-composer);
  backdrop-filter: blur(18px) saturate(150%);
}

.picker {
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  gap: 5px;
  max-width: 100%;
  padding-block: 2px;
  padding-inline: 4px;
  color: var(--text-base);
  background: transparent;
  border: 0;
  border-radius: 7px;
  font: inherit;
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.picker:hover:not(:disabled) {
  background: var(--surface-hover);
}

.picker-icon {
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--text-weak);
}

.picker-name {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.state-error {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-block: 7px;
  padding-inline: 8px;
  color: var(--text-base);
  background: var(--surface-sunken);
  border-radius: 7px;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.state-error-text {
  flex: 1;
  min-width: 0;
}

.retry {
  display: inline-grid;
  flex: none;
  place-items: center;
  width: 24px;
  height: 24px;
  color: var(--text-weak);
  background: transparent;
  border: 0;
  border-radius: 6px;
}

.retry:hover {
  color: var(--text-base);
  background: var(--surface-hover);
}

.dirty {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  color: var(--text-base);
  background: var(--surface-sunken);
  border-radius: 10px;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.dirty-actions {
  display: flex;
  gap: 8px;
}

.dirty-go,
.dirty-cancel {
  padding-block: 2px;
  padding-inline: 6px;
  background: transparent;
  border: 0;
  border-radius: 7px;
  font: inherit;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.dirty-go {
  color: var(--text-interactive);
}

.dirty-cancel {
  color: var(--text-base);
}

.dirty-go:hover,
.dirty-cancel:hover {
  background: var(--surface-hover);
}

.message {
  width: 100%;
  padding: 4px;
  color: var(--text-base);
  background: transparent;
  border: 0;
  outline: none;
  resize: none;
  font: inherit;
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.message::placeholder {
  color: var(--text-weak);
}

.row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-height: 25px;
  padding-block: 2px;
  padding-inline: 4px;
  color: var(--text-base);
  background: transparent;
  border: 0;
  border-radius: 7px;
  font: inherit;
  font-size: calc(14px * var(--ui-font-scale, 1));
  text-align: start;
}

.row:hover:not(:disabled) {
  background: var(--surface-hover);
}

/* MiMo's disabled button: faded, refusing, and without a hover. */
.row:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}

.check {
  display: inline-grid;
  flex: none;
  place-items: center;
  width: 15px;
  height: 15px;
}

.icon {
  flex: none;
  width: 15px;
  height: 15px;
  color: var(--text-weak);
}

.label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stats {
  display: flex;
  gap: 7px;
  margin-inline-start: auto;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.add {
  color: #21a366;
}

.del {
  color: #e5484d;
}

.kbd {
  margin-inline-start: auto;
  color: var(--text-weak);
  font: inherit;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.rule {
  height: 1px;
  background: var(--border-weak);
}

.spin {
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.line {
  margin: 0;
  padding-inline: 4px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  overflow-wrap: anywhere;
}

.line.error {
  color: var(--text-error);
}

.line.done {
  color: var(--text-base);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .add {
    color: #21a366;
  }

  :root:not([data-theme="light"]) .del {
    color: #e5484d;
  }
}

:root[data-theme="dark"] .add {
  color: #21a366;
}

:root[data-theme="dark"] .del {
  color: #e5484d;
}
</style>
