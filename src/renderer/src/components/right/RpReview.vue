<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue"
import type { GitChange, GitStatus } from "@shared/protocol"
import RpDiff from "./RpDiff.vue"
import { useApp } from "../../stores/app"
import { t } from "../../lib/i18n"

/**
 * MiMo's review tab: the project's unstaged changes. A pill with their count
 * and a refresh at the head, the files beneath it with git's letter for each,
 * and the chosen file's diff filling the rest. The first file is chosen by
 * itself and stays chosen while it is still changed.
 *
 * It reads again whenever the conversation moves on - a message, the end of a
 * turn, an undo - as well as on the refresh, which then rests for 400ms.
 */
const props = defineProps<{ root?: string }>()
const app = useApp()

const status = ref<GitStatus>()
const failed = ref(false)
const loading = ref(false)
const selected = ref<string>()
const patch = ref<string>()
const patchLoading = ref(false)
const resting = ref(false)
let restTimer: ReturnType<typeof setTimeout> | undefined

const entries = computed<GitChange[]>(() => status.value?.entries ?? [])

async function load() {
  const root = props.root
  if (!root) return
  loading.value = true
  try {
    status.value = await app.gitStatus(root, "worktree")
    failed.value = false
  } catch {
    failed.value = true
  } finally {
    loading.value = false
  }
  const files = entries.value.map((entry) => entry.path)
  if (!selected.value || !files.includes(selected.value)) selected.value = files[0]
  else void loadPatch(selected.value)
}

async function loadPatch(file: string | undefined) {
  const root = props.root
  if (!root || !file) {
    patch.value = undefined
    return
  }
  patchLoading.value = true
  try {
    const text = await app.gitDiff(root, file, undefined, "worktree")
    if (selected.value === file) patch.value = text
  } catch {
    if (selected.value === file) patch.value = ""
  } finally {
    patchLoading.value = false
  }
}

function refresh() {
  if (resting.value) return
  resting.value = true
  restTimer = setTimeout(() => (resting.value = false), 400)
  void load()
}

watch(selected, (file) => void loadPatch(file))
watch(() => props.root, () => {
  status.value = undefined
  selected.value = undefined
  void load()
}, { immediate: true })
watch(
  () => [app.messages.length, app.busy, app.history.undo, app.history.redo] as const,
  () => void load(),
)
onBeforeUnmount(() => clearTimeout(restTimer))

const LETTER: Record<GitChange["kind"], string> = { added: "A", deleted: "D", modified: "M" }
</script>

<template>
  <div class="rv-wrap" data-rp-review>
    <div v-if="!root" class="rv-empty">
      <div class="rv-empty-title">{{ t("rp.review.noProjectTitle") }}</div>
      <div class="rv-empty-desc">{{ t("rp.review.noProjectDesc") }}</div>
    </div>
    <div v-else-if="!status && loading" class="rv-empty">
      <div class="rv-empty-desc">{{ t("rp.review.loading") }}</div>
    </div>
    <div v-else-if="failed && !status" class="rv-empty">
      <div class="rv-empty-title">{{ t("rp.review.readStatusFailed") }}</div>
    </div>
    <div v-else-if="status && (!status.installed || !status.repo)" class="rv-empty">
      <div class="rv-empty-title">{{ t("rp.review.notRepoTitle") }}</div>
      <div class="rv-empty-desc">{{ t("rp.review.notRepoDesc") }}</div>
    </div>
    <div v-else-if="status && !entries.length" class="rv-empty" data-rv-clean>
      <div class="rv-empty-title">{{ t("rp.review.cleanTitle") }}</div>
      <div class="rv-empty-desc">{{ t("rp.review.cleanDesc") }}</div>
      <button type="button" class="rv-empty-refresh" :disabled="resting" @click="refresh">{{ t("rp.review.refresh") }}</button>
    </div>
    <template v-else-if="status">
      <div class="rv-head">
        <span class="rv-pill">{{ t("rp.review.unstaged", { count: entries.length }) }}</span>
        <button
          type="button"
          class="rv-refresh"
          :disabled="resting"
          :aria-label="t('rp.review.refresh')"
          v-tip="{ label: t('rp.review.refresh'), placement: 'bottom' }"
          @click="refresh"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" />
          </svg>
        </button>
      </div>
      <div class="rv-list">
        <button
          v-for="entry in entries"
          :key="entry.path"
          type="button"
          class="rv-row"
          :class="{ on: entry.path === selected }"
          :title="entry.path"
          @click="selected = entry.path"
        >
          <span class="rv-letter" :class="entry.kind">{{ LETTER[entry.kind] }}</span>
          <span class="rv-path">{{ entry.path }}</span>
        </button>
      </div>
      <div v-if="patch === undefined && patchLoading" class="rv-diff-note">{{ t("rp.review.diffLoading") }}</div>
      <div v-else-if="patch !== undefined && !patch.trim()" class="rv-diff-note">{{ t("rp.review.noTextDiff") }}</div>
      <RpDiff v-else-if="patch" :diff="patch" />
    </template>
  </div>
</template>

<style scoped>
/* MiMo's rv-wrap: a column 10 / 12 / 12 in, the whole height. */
.rv-wrap {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  padding: 10px 12px 12px;
}

.rv-head {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  padding: 2px 2px 10px;
}

.rv-pill {
  padding: 3px 10px;
  color: var(--text-weak);
  background: var(--surface-sunken);
  border-radius: 7px;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.rv-refresh {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  padding: 0;
  color: var(--text-weak);
  background: transparent;
  border: 0;
  border-radius: 7px;
}

.rv-refresh:hover:not(:disabled) {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.rv-refresh:disabled {
  opacity: 0.5;
}

/* The files: at most 30% of the tab or 280px, scrolling past that. */
.rv-list {
  display: flex;
  flex: none;
  flex-direction: column;
  max-height: min(30%, 280px);
  margin-bottom: 10px;
  overflow: auto;
}

.rv-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 5px 9px;
  color: var(--text-strong);
  text-align: start;
  background: transparent;
  border: 0;
  border-radius: 7px;
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.rv-row:hover {
  background: var(--surface-hover);
}

.rv-row.on {
  background: var(--surface-selected);
}

.rv-letter {
  flex: none;
  width: 16px;
  font-family: var(--font-mono);
  font-size: calc(12px * var(--code-font-scale, 1));
  text-align: center;
}

.rv-letter.modified {
  color: var(--text-warning);
}

.rv-letter.added {
  color: var(--text-success);
}

.rv-letter.deleted {
  color: var(--text-error);
}

.rv-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rv-diff-note {
  padding: 16px;
  color: var(--text-weak);
  font-size: calc(13px * var(--ui-font-scale, 1));
  text-align: center;
}

/* MiMo's empty states: centred, a 14px title over a 13px muted line. */
.rv-empty {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 24px;
  text-align: center;
}

.rv-empty-title {
  color: var(--text-strong);
  font-size: calc(14px * var(--ui-font-scale, 1));
}

.rv-empty-desc {
  color: var(--text-weak);
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.rv-empty-refresh {
  margin-top: 8px;
  padding: 5px 13px;
  color: var(--text-strong);
  background: transparent;
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.rv-empty-refresh:hover:not(:disabled) {
  background: var(--surface-hover);
}
</style>
