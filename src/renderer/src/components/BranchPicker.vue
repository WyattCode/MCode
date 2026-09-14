<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import type { BranchState, CheckoutResult } from "@shared/protocol"
import { useApp } from "../stores/app"
import { notify, notifyFailure } from "../lib/toast"
import { t } from "../lib/i18n"

/**
 * The home screen's branch chip and its menu, laid out from MiMo's.
 *
 * Beside the project chip, and only for a project that is a repository on a
 * branch. The menu searches the local branches, switches to one, and makes a
 * new one from a field at its foot. Switching over uncommitted work asks first;
 * a branch already checked out in another worktree opens that worktree instead.
 */
const props = defineProps<{ directory?: string }>()
const emit = defineEmits<{ worktree: [directory: string] }>()

const app = useApp()
const state = ref<BranchState>()
const open = ref(false)
const query = ref("")
const creating = ref(false)
const draft = ref("")
const busy = ref(false)
/** A branch waiting on the reader's word, because the working tree has uncommitted changes. */
const pending = ref<string>()
const root = ref<HTMLElement>()
const search = ref<HTMLInputElement>()
const newField = ref<HTMLInputElement>()

const visible = computed(() => Boolean(state.value?.repo && !state.value.detached && state.value.branch))
const branches = computed(() => state.value?.branches ?? [])
const matches = computed(() => {
  const needle = query.value.trim().toLowerCase()
  return needle ? branches.value.filter((branch) => branch.toLowerCase().includes(needle)) : branches.value
})

async function refresh() {
  const directory = props.directory
  if (!directory) {
    state.value = undefined
    return
  }
  try {
    const next = await app.client?.request({ type: "git.branches", directory })
    if (props.directory === directory) state.value = next
  } catch {
    if (props.directory === directory) state.value = undefined
  }
}

watch(() => props.directory, refresh, { immediate: true })

watch(open, async (value) => {
  query.value = ""
  creating.value = false
  draft.value = ""
  if (!value) return
  void refresh()
  await nextTick()
  search.value?.focus()
})

watch(creating, async (value) => {
  if (!value) return
  await nextTick()
  newField.value?.focus()
})

function report(result: CheckoutResult, branch: string) {
  if (result.code === "untracked-overwrite") notifyFailure(t("home.branchSwitchUntracked", { branch }))
  else if (result.code === "local-overwrite") notifyFailure(t("home.branchSwitchOverwrite", { branch }))
  else notifyFailure(t("home.branchSwitchFailed", { error: result.error ?? "" }))
}

async function checkout(branch: string, force = false) {
  open.value = false
  pending.value = undefined
  const directory = props.directory
  if (!directory || (!force && branch === state.value?.branch)) return
  let result: CheckoutResult | undefined
  try {
    result = await app.client?.request({ type: "git.checkout", directory, branch, force })
  } catch (err) {
    notifyFailure(t("home.branchSwitchFailed", { error: err instanceof Error ? err.message : String(err) }))
    return
  }
  if (!result) return
  if (result.ok) {
    const now = result.branch ?? branch
    if (result.conflicts) notifyFailure(t("home.branchSwitchedConflicts", { branch: now }))
    else notify(t("home.branchSwitched", { branch: now }))
    await refresh()
    return
  }
  if (result.worktree) {
    emit("worktree", result.worktree.directory)
    notify(t("home.branchToWorktree", { branch, name: result.worktree.name }))
    return
  }
  if (result.dirty) {
    pending.value = branch
    return
  }
  report(result, branch)
}

async function create() {
  const directory = props.directory
  const branch = draft.value.trim()
  if (busy.value || !directory || !branch) return
  busy.value = true
  try {
    const result = await app.client?.request({ type: "git.checkout", directory, branch, create: true })
    if (!result) return
    if (result.ok) {
      open.value = false
      notify(t("home.branchCreated", { branch }))
      await refresh()
    } else if (result.code === "branch-exists") notifyFailure(t("home.branchCreateExists", { branch }))
    else if (result.code === "branch-invalid") notifyFailure(t("home.branchCreateInvalid", { branch }))
    else notifyFailure(t("home.branchCreateFailed", { error: result.error ?? "" }))
  } catch (err) {
    notifyFailure(t("home.branchCreateFailed", { error: err instanceof Error ? err.message : String(err) }))
  } finally {
    busy.value = false
  }
}

function onNewKey(event: KeyboardEvent) {
  event.stopPropagation()
  if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault()
    void create()
  } else if (event.key === "Escape") {
    event.preventDefault()
    creating.value = false
    draft.value = ""
  }
}

function onPointerDown(event: MouseEvent) {
  if (open.value && !root.value?.contains(event.target as Node)) open.value = false
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape") return
  if (pending.value) {
    event.preventDefault()
    pending.value = undefined
  } else if (open.value) {
    event.preventDefault()
    open.value = false
  }
}

onMounted(() => {
  window.addEventListener("mousedown", onPointerDown, true)
  window.addEventListener("keydown", onKeydown)
})
onBeforeUnmount(() => {
  window.removeEventListener("mousedown", onPointerDown, true)
  window.removeEventListener("keydown", onKeydown)
})
</script>

<template>
  <div v-if="visible" ref="root" class="branch-picker" data-branch-picker>
    <button class="chip" :class="{ open }" data-branch-chip aria-haspopup="menu" :aria-expanded="open" @click="open = !open">
      <svg class="i" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="4.5" cy="3.5" r="1.6" />
        <circle cx="4.5" cy="12.5" r="1.6" />
        <circle cx="11.5" cy="5.5" r="1.6" />
        <path d="M4.5 5.1v5.8M11.5 7.1c0 2.6-2.2 3.4-5.4 3.9" />
      </svg>
      <span class="chip-name" data-branch-chip-name>{{ state?.branch ?? t("home.branchLabel") }}</span>
      <svg class="caret" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M5 6.5L8 9.5L11 6.5" />
      </svg>
    </button>

    <div v-if="open" class="menu" role="menu" data-branch-menu>
      <div class="search">
        <svg class="i" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M7.2 2.8a4.4 4.4 0 1 0 0 8.8 4.4 4.4 0 0 0 0-8.8z" />
          <path d="M13.2 13.2l-2.8-2.8" />
        </svg>
        <input ref="search" v-model="query" spellcheck="false" :placeholder="t('home.branchSearch')" @keydown.stop />
      </div>

      <div class="list" data-branch-list>
        <div v-if="!branches.length" class="row muted">
          <span class="name">{{ t("home.branchNone") }}</span>
        </div>
        <div v-else-if="!matches.length" class="row muted">
          <span class="name">{{ t("home.branchNoMatch") }}</span>
        </div>
        <button
          v-for="branch in matches"
          :key="branch"
          class="row"
          role="menuitemradio"
          :aria-checked="branch === state?.branch"
          :data-branch="branch"
          @click="checkout(branch)"
        >
          <svg class="i" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="4.5" cy="3.5" r="1.6" />
            <circle cx="4.5" cy="12.5" r="1.6" />
            <circle cx="11.5" cy="5.5" r="1.6" />
            <path d="M4.5 5.1v5.8M11.5 7.1c0 2.6-2.2 3.4-5.4 3.9" />
          </svg>
          <span class="name">{{ branch }}</span>
          <svg v-if="branch === state?.branch" class="check" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3.5 8.2 6.4 11.1 12.5 5" />
          </svg>
        </button>
      </div>

      <div class="rule" role="separator" />

      <button v-if="!creating" class="row" data-branch-create @click="creating = true">
        <svg class="i" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 3v10M3 8h10" />
        </svg>
        <span class="name">{{ t("home.branchCreateNew") }}</span>
      </button>
      <input
        v-else
        ref="newField"
        v-model="draft"
        class="new-branch"
        data-branch-create-input
        spellcheck="false"
        :placeholder="t('home.branchCreatePlaceholder')"
        :disabled="busy"
        @keydown="onNewKey"
      />
    </div>

    <Teleport to="body">
      <div v-if="pending" class="scrim" @mousedown.self="pending = undefined">
        <div v-modal class="dialog" data-branch-switch-dialog role="dialog" aria-labelledby="branch-switch-title">
          <div class="dialog-head">
            <h2 id="branch-switch-title" class="dialog-title">{{ t("home.branchSwitchTitle", { branch: pending }) }}</h2>
            <button type="button" class="dialog-close" data-branch-switch-close :aria-label="t('common.close')" @click="pending = undefined">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
              </svg>
            </button>
          </div>
          <p class="dialog-desc">{{ t("home.branchSwitchDesc", { branch: pending }) }}</p>
          <div class="dialog-actions">
            <button type="button" class="dialog-btn" data-branch-switch-cancel @click="pending = undefined">{{ t("common.cancel") }}</button>
            <button type="button" class="dialog-btn danger" data-branch-switch-ok @click="checkout(pending!, true)">
              {{ t("home.branchSwitchConfirm") }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.branch-picker {
  position: relative;
  min-width: 0;
  max-width: 100%;
}

svg path,
svg circle {
  stroke: currentColor;
  stroke-width: 1.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* The same ghost chip as the project's, with a 17px branch mark. */
.chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  max-width: 100%;
  padding: 4px 12px;
  color: var(--text-weak);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 8px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 400;
  line-height: 20px;
}

.chip:hover,
.chip.open {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.chip .i {
  flex: none;
  width: 17px;
  height: 17px;
}

.chip-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.caret {
  flex: none;
  width: 16px;
  height: 16px;
}

.caret path {
  stroke-width: 1;
}

/* MiMo's branch menu: narrower than the project menu, 240 to 320 wide. */
.menu {
  position: absolute;
  top: calc(100% + 4px);
  inset-inline-start: 0;
  z-index: 50;
  min-width: 240px;
  max-width: min(320px, 100vw - 40px);
  padding: 5px;
  background: color-mix(in srgb, var(--surface-menu) 92%, transparent);
  border: 0.5px solid var(--border-weak);
  border-radius: 16px;
  box-shadow: var(--shadow-lg);
  backdrop-filter: blur(18px) saturate(150%);
}

.search {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 4px;
  padding: 6px 10px;
  color: var(--text-weak);
  border-bottom: 1px solid var(--border-weak);
}

.search .i {
  flex: none;
  width: 15px;
  height: 15px;
}

.search input {
  flex: 1;
  min-width: 0;
  color: var(--text-strong);
  background: transparent;
  border: 0;
  outline: none;
  font: inherit;
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.search input::placeholder {
  color: var(--text-weak);
}

.search input:not(:placeholder-shown) {
  font-weight: 500;
}

.list {
  max-height: 210px;
  overflow-y: auto;
}

.row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-width: 0;
  padding: 6px 10px;
  color: var(--text-strong);
  background: transparent;
  border-radius: 8px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 400;
  line-height: 20px;
  text-align: start;
  cursor: default;
}

.row:hover,
.row:focus-visible {
  background: var(--surface-hover);
  outline: none;
}

.row .i {
  flex: none;
  width: 17px;
  height: 17px;
  color: color-mix(in srgb, var(--text-base) 87%, transparent);
}

.name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.check {
  flex: none;
  width: 16px;
  height: 16px;
  margin-inline-start: auto;
  color: var(--text-strong);
}

.muted,
.muted:hover {
  background: transparent;
  opacity: 0.6;
}

.rule {
  height: 1px;
  margin: 4px 6px;
  background: var(--border-weak);
}

.new-branch {
  display: block;
  box-sizing: border-box;
  width: calc(100% - 12px);
  margin: 0 6px 3px;
  padding: 6px 9px;
  color: var(--text-strong);
  font: inherit;
  font-size: calc(13px * var(--ui-font-scale, 1));
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  outline: none;
}

.new-branch::placeholder {
  color: var(--text-weak);
}

.new-branch:focus {
  border-color: var(--interactive);
}

/* MiMo's switch confirmation: 430 wide, the question, why, and 取消 / 仍然切换. */
.scrim {
  position: fixed;
  inset: 0;
  z-index: 130;
  display: grid;
  place-items: center;
  background: var(--scrim);
}

.dialog {
  width: min(430px, 90vw);
  padding: 22px 24px;
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 16px;
  box-shadow: var(--shadow-overlay);
}

.dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.dialog-title {
  margin: 0;
  color: var(--text-strong);
  font-size: calc(16px * var(--ui-font-scale, 1));
  font-weight: 400;
}

.dialog-close {
  display: grid;
  flex: none;
  place-items: center;
  width: 30px;
  height: 30px;
  margin-inline-end: -4px;
  color: var(--text-weak);
  background: transparent;
  border: 0;
  border-radius: 7px;
  cursor: pointer;
}

.dialog-close:hover {
  background: var(--surface-hover);
}

.dialog-desc {
  margin: 0 0 20px;
  color: var(--text-base);
  font-size: calc(14px * var(--ui-font-scale, 1));
  line-height: 1.65;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.dialog-btn {
  padding: 8px 18px;
  color: var(--text-base);
  font: inherit;
  font-size: calc(14px * var(--ui-font-scale, 1));
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  cursor: pointer;
}

.dialog-btn:hover {
  background: var(--surface-hover);
}

.dialog-btn.danger {
  color: #ffffff;
  background: var(--error);
  border-color: var(--error);
}

.dialog-btn.danger:hover {
  opacity: 0.9;
}
</style>
