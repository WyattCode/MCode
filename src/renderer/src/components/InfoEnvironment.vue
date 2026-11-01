<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue"
import type { GitSummary, PullRequestState } from "@shared/protocol"
import { t } from "../lib/i18n"
import { prRowState } from "../lib/pr-row"
import { useApp } from "../stores/app"
import { requestReview } from "../lib/review-request"
import { useBranchSwitch } from "../lib/branch-switch"
import InfoBranchMenu from "./InfoBranchMenu.vue"
import InfoCommitCard from "./InfoCommitCard.vue"

/**
 * MiMo's 环境信息 rows: what has changed (opening the review), where the work
 * runs, which branch it is on (with a menu to switch), and the commit or push
 * card. Only drawn for a project inside a repository.
 */
const props = defineProps<{ directory: string; sessionId?: string; summary: GitSummary; reloadKey?: string }>()
const emit = defineEmits<{ mutated: [] }>()
const app = useApp()

// ------------------------------------------------------------- pull request

/*
 * MiMo's last row: the branch's pull request. GitHub is asked at most once per
 * project and branch every 30 seconds (its unauthenticated limit is 60 an
 * hour), never twice at once, and a failure after a good answer keeps the good
 * one. A lookup that fails, or a detached HEAD, says the status is unavailable.
 */
const PR_INTERVAL = 30_000
const PR_LABEL = {
  open: "info.prStatus.open",
  draft: "info.prStatus.draft",
  closed: "info.prStatus.closed",
  merged: "info.prStatus.merged",
} as const
const prAsked = new Map<string, number>()
const prInFlight = new Set<string>()
const prGood = new Map<string, PullRequestState>()
const pr = ref<{ key: string; result: PullRequestState }>()
let prGeneration = 0
let prLastKey = ""
let alive = true

const prKey = () => `${props.directory}\0${props.summary.branch ?? ""}`

function loadPullRequest() {
  const key = prKey()
  if (prLastKey !== key) {
    prLastKey = key
    prGeneration += 1
    prInFlight.delete(key)
  }
  if (!props.summary.github) return
  if (!props.summary.branch) {
    pr.value = { key, result: { ok: false, code: "detached" } }
    return
  }
  if (prInFlight.has(key)) return
  if (pr.value?.key === key && Date.now() - (prAsked.get(key) ?? 0) < PR_INTERVAL) return
  const asking = app.client?.request({ type: "git.pullRequest", directory: props.directory })
  if (!asking) return
  const generation = prGeneration
  prAsked.set(key, Date.now())
  prInFlight.add(key)
  const settle = (result: PullRequestState) => {
    prInFlight.delete(key)
    if (!alive || prKey() !== key || generation !== prGeneration) return
    if (!result.ok && prGood.has(key)) return
    if (result.ok) prGood.set(key, result)
    pr.value = { key, result }
  }
  asking.then(settle, () => settle({ ok: false, code: "network" }))
}

watch([() => props.directory, () => props.summary.branch, () => props.summary.github, () => props.reloadKey], loadPullRequest, {
  immediate: true,
})
onBeforeUnmount(() => {
  alive = false
  prInFlight.clear()
})

const prResult = computed(() => (pr.value?.key === prKey() ? pr.value.result : undefined))
const prRow = computed(() => prRowState(Boolean(props.summary.github), prResult.value))
const prFound = computed(() => (prResult.value?.ok && prResult.value.kind !== "none" ? prResult.value : null))
const PR_LINE = { loading: "info.prLoading", none: "info.prNone", unavailable: "info.prUnavailable" } as const

function openPullRequest() {
  if (prFound.value) window.mcode.openExternal(prFound.value.url)
}

const branchRow = ref<HTMLElement>()
const commitRow = ref<HTMLElement>()
const menuOpen = ref(false)
const commitOpen = ref(false)

const { branches, current, loading, switching, pending, error, loadBranches, switchTo, clearPending } = useBranchSwitch(
  () => props.directory,
  () => emit("mutated"),
)

function toggleMenu() {
  menuOpen.value = !menuOpen.value
  if (menuOpen.value) void loadBranches()
}

function pick(branch: string) {
  menuOpen.value = false
  if (branch !== props.summary.branch) void switchTo(branch, props.summary.branch)
}

watch(
  () => props.directory,
  () => {
    menuOpen.value = false
    commitOpen.value = false
    clearPending()
    error.value = ""
  },
)
</script>

<template>
  <button
    v-if="summary.ok"
    type="button"
    class="row actionable"
    data-info-environment-changes
    @click="requestReview()"
  >
    <svg class="icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M5 2.5v6M2 5.5h6M8 11.5h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    </svg>
    <span class="label">{{ t("info.changes") }}</span>
    <span class="stats" :aria-label="t('info.changeStats', { add: summary.additions, del: summary.deletions })" data-info-environment-stats>
      <span class="add">+{{ summary.additions }}</span>
      <span class="del">-{{ summary.deletions }}</span>
    </span>
  </button>
  <div v-else class="row disabled" data-info-environment-changes-unavailable>
    <svg class="icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M5 2.5v6M2 5.5h6M8 11.5h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    </svg>
    <span class="label">{{ t("info.changesUnavailable") }}</span>
  </div>

  <div class="row" data-info-environment-local>
    <svg class="icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.75" y="3.25" width="10.5" height="7" rx="1.2" stroke="currentColor" stroke-width="1.3" />
      <path d="M1.5 12.75h13" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
    </svg>
    <span class="label">{{ t("info.local") }}</span>
  </div>

  <button
    ref="branchRow"
    type="button"
    class="row actionable"
    :class="{ disabled: !summary.branch }"
    :disabled="!summary.branch || switching"
    aria-haspopup="menu"
    :aria-expanded="menuOpen"
    data-info-environment-branch
    @click="toggleMenu"
  >
    <svg class="icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="4.5" cy="3.5" r="1.6" stroke="currentColor" stroke-width="1.2" />
      <circle cx="4.5" cy="12.5" r="1.6" stroke="currentColor" stroke-width="1.2" />
      <circle cx="11.5" cy="5.5" r="1.6" stroke="currentColor" stroke-width="1.2" />
      <path d="M4.5 5.1v5.8M11.5 7.1c0 2.6-2.2 3.4-5.4 3.9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
    </svg>
    <span class="label" :class="{ disabled: !summary.branch }">{{ summary.branch || t("info.unknownBranch") }}</span>
    <svg v-if="switching" class="end spin" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 2.5a5.5 5.5 0 1 1-5.5 5.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    </svg>
    <svg v-else class="end" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4.5 6.5 8 10l3.5-3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>
  <InfoBranchMenu
    v-if="menuOpen"
    :anchor="branchRow"
    :branches="branches"
    :current="current ?? summary.branch"
    :loading="loading"
    @pick="pick"
    @close="menuOpen = false"
  />
  <div v-if="pending" class="confirm" data-info-environment-branch-confirm>
    <span>{{ t("info.branchDirtyConfirm", { branch: pending }) }}</span>
    <div class="confirm-actions">
      <button type="button" class="confirm-go" data-info-environment-branch-force @click="switchTo(pending!, summary.branch, true)">
        {{ t("info.branchConfirmSwitch") }}
      </button>
      <button type="button" class="confirm-cancel" data-info-environment-branch-cancel @click="clearPending()">
        {{ t("info.branchCancel") }}
      </button>
    </div>
  </div>
  <p v-if="error" class="error" role="alert" data-info-environment-branch-error>{{ error }}</p>

  <button
    v-if="summary.ok"
    ref="commitRow"
    type="button"
    class="row actionable"
    aria-haspopup="dialog"
    :aria-expanded="commitOpen"
    data-info-environment-commit
    @click="commitOpen = !commitOpen"
  >
    <svg class="icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="2.6" stroke="currentColor" stroke-width="1.3" />
      <path d="M1.5 8h3.9M10.6 8h3.9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
    </svg>
    <span class="label">{{ t("info.commitOrPush") }}</span>
  </button>
  <div v-else class="row disabled" data-info-environment-commit-unavailable>
    <svg class="icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="2.6" stroke="currentColor" stroke-width="1.3" />
      <path d="M1.5 8h3.9M10.6 8h3.9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
    </svg>
    <span class="label">{{ t("info.commitUnavailable") }}</span>
  </div>
  <InfoCommitCard
    v-if="commitOpen && summary.ok"
    :anchor="commitRow"
    :directory="directory"
    :session-id="sessionId"
    :additions="summary.additions"
    :deletions="summary.deletions"
    :known-branch="summary.branch"
    @close="commitOpen = false"
    @mutated="emit('mutated')"
  />

  <!-- Keyed by the address, so the tip is bound again when the pull request changes. -->
  <button
    v-if="prFound"
    :key="prFound.url"
    v-tip="{ label: prFound.title, placement: 'top' }"
    type="button"
    class="row actionable"
    data-info-environment-pr
    :data-info-environment-pr-state="prFound.kind"
    @click="openPullRequest"
  >
    <svg class="icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="4" cy="3.5" r="1.6" stroke="currentColor" stroke-width="1.2" />
      <circle cx="4" cy="12.5" r="1.6" stroke="currentColor" stroke-width="1.2" />
      <circle cx="12" cy="12.5" r="1.6" stroke="currentColor" stroke-width="1.2" />
      <path d="M4 5.1v5.8M12 10.9V6.8a2 2 0 0 0-2-2H7.6M9.1 3.3 7.6 4.8l1.5 1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
    <span class="label">#{{ prFound.number }} · {{ t(PR_LABEL[prFound.kind]) }}</span>
  </button>
  <div
    v-else-if="prRow === 'loading' || prRow === 'none' || prRow === 'unavailable'"
    class="row disabled"
    data-info-environment-pr
    :data-info-environment-pr-state="prRow"
    aria-disabled="true"
  >
    <svg class="icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="4" cy="3.5" r="1.6" stroke="currentColor" stroke-width="1.2" />
      <circle cx="4" cy="12.5" r="1.6" stroke="currentColor" stroke-width="1.2" />
      <circle cx="12" cy="12.5" r="1.6" stroke="currentColor" stroke-width="1.2" />
      <path d="M4 5.1v5.8M12 10.9V6.8a2 2 0 0 0-2-2H7.6M9.1 3.3 7.6 4.8l1.5 1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
    <span class="label">{{ t(PR_LINE[prRow]) }}</span>
  </div>
</template>

<style scoped>
/* MiMo's environment row: 25 tall at least, 9 between icon and label, 2 by 4 of padding. */
.row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-height: 25px;
  margin: 0;
  padding-block: 2px;
  padding-inline: 4px;
  color: var(--text-base);
  background: transparent;
  border: 0;
  font: inherit;
  font-size: calc(14px * var(--ui-font-scale, 1));
  text-align: start;
}

.row.actionable {
  border-radius: 7px;
}

.row.actionable:hover:not(:disabled) {
  background: var(--surface-hover);
}

.row.actionable:focus-visible {
  outline: 2px solid var(--text-interactive);
  outline-offset: -2px;
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

.row.disabled,
.label.disabled {
  color: var(--text-weak);
}

.row.disabled .icon {
  opacity: 0.75;
}

.end {
  flex: none;
  margin-inline-start: auto;
  color: var(--text-weak);
}

.spin {
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.stats {
  display: flex;
  gap: 7px;
  margin-inline-start: auto;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* MiMo's --color-done and --color-del, the same in both schemes. */
.add {
  color: #21a366;
}

.del {
  color: #e5484d;
}

.confirm {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-inline: 8px;
  padding: 7px;
  color: var(--text-base);
  background: var(--surface-sunken);
  border-radius: 7px;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.confirm-actions {
  display: flex;
  gap: 8px;
}

.confirm-go,
.confirm-cancel {
  padding-block: 2px;
  padding-inline: 6px;
  background: transparent;
  border: 0;
  border-radius: 7px;
  font: inherit;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.confirm-go {
  color: var(--text-interactive);
}

.confirm-cancel {
  color: var(--text-base);
}

.confirm-go:hover,
.confirm-cancel:hover {
  background: var(--surface-hover);
}

.confirm-go:focus-visible,
.confirm-cancel:focus-visible {
  outline: 2px solid var(--text-interactive);
  outline-offset: 2px;
}

.error {
  margin: 0;
  padding-inline-start: 30px;
  color: var(--text-error);
  font-size: calc(11px * var(--ui-font-scale, 1));
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
