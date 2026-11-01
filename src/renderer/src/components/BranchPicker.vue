<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import type { BranchState, CheckoutResult } from "@shared/protocol"
import { useApp } from "../stores/app"
import { notify, notifyFailure } from "../lib/toast"
import { t } from "../lib/i18n"
import { readBranches, switchBranch } from "../lib/branch-switch"
import { onMenuRowKey } from "../lib/menu-keys"
import { useEscapeLayerWhile } from "../lib/escape-layer"

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
    const next = await readBranches(directory)
    if (props.directory === directory) state.value = next
  } catch {
    if (props.directory === directory) state.value = undefined
  }
}

watch(() => props.directory, refresh, { immediate: true })
/* A branch changed from the info card, or by this chip, is shown at once. */
watch(() => app.branchNonce, refresh)

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
  if (!directory) return
  const outcome = await switchBranch(directory, branch, state.value?.branch, force)
  if (props.directory !== directory) return
  if (outcome.kind === "unchanged") return
  if (outcome.kind === "switched") {
    if (outcome.conflicts) notifyFailure(t("home.branchSwitchedConflicts", { branch: outcome.branch }))
    else notify(t("home.branchSwitched", { branch: outcome.branch }))
    await refresh()
    return
  }
  if (outcome.kind === "worktree") {
    emit("worktree", outcome.directory)
    notify(t("home.branchToWorktree", { branch, name: outcome.name }))
    return
  }
  if (outcome.kind === "dirty") {
    pending.value = branch
    return
  }
  if (outcome.result) report(outcome.result, branch)
  else notifyFailure(t("home.branchSwitchFailed", { error: outcome.error }))
}

async function create() {
  const directory = props.directory
  const branch = draft.value.trim()
  if (busy.value || !directory || !branch) return
  busy.value = true
  try {
    const result = await app.client?.request({ type: "git.checkout", directory, branch, create: true })
    if (props.directory !== directory) return
    if (!result) {
      notifyFailure(t("home.branchCreateFailed", { error: t("common.requestFailed") }))
      return
    }
    if (result.ok) {
      // MiMo leaves the menu up and redraws it with the new branch ticked; only the field goes.
      creating.value = false
      draft.value = ""
      notify(t("home.branchCreated", { branch }))
      app.branchesChanged()
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
  }
}

function onPointerDown(event: MouseEvent) {
  if (open.value && !root.value?.contains(event.target as Node)) open.value = false
}

/* MiMo's branch menu is a non-modal popover: focus moving anywhere outside it and its chip closes it. */
function onFocusOut(event: FocusEvent) {
  const next = event.relatedTarget
  if (open.value && next instanceof Node && !root.value?.contains(next)) open.value = false
}

/* MiMo's menu keys over the rows; the two fields keep their own keys. */
function onMenuKey(event: KeyboardEvent) {
  onMenuRowKey(event, [...(root.value?.querySelectorAll<HTMLElement>(".menu button.row:not(:disabled)") ?? [])])
}

/*
 * Escape closes the menu wherever focus is inside it, the search included,
 * which is where focus lands on open; the field for a new branch backs out of
 * creating first. The switch confirmation is a layer of its own.
 */
useEscapeLayerWhile(
  () => open.value,
  () => {
    if (!creating.value) {
      open.value = false
      return
    }
    creating.value = false
    draft.value = ""
    search.value?.focus()
  },
  () => (open.value = false),
)
useEscapeLayerWhile(
  () => pending.value,
  () => (pending.value = undefined),
)

/* MiMo re-reads the home branch when the window comes back: a switch made in a terminal shows on return. */
const onFocus = () => void refresh()

onMounted(() => {
  window.addEventListener("mousedown", onPointerDown, true)
  window.addEventListener("focus", onFocus)
})
onBeforeUnmount(() => {
  window.removeEventListener("mousedown", onPointerDown, true)
  window.removeEventListener("focus", onFocus)
})
</script>

<template>
  <div v-if="visible" ref="root" class="branch-picker" data-branch-picker @focusout="onFocusOut">
    <button class="chip" data-branch-chip aria-haspopup="menu" :aria-expanded="open" @click="open = !open">
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

    <div v-if="open" class="menu" role="menu" data-branch-menu @keydown="onMenuKey">
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
        <!-- MiMo focuses nothing when this opens, so Enter cannot switch over uncommitted work by accident. -->
        <div v-modal class="dialog" data-branch-switch-dialog data-modal-keep-focus role="dialog" aria-labelledby="branch-switch-title">
          <div class="dialog-head">
            <h2 id="branch-switch-title" class="dialog-title">{{ t("home.branchSwitchTitle", { branch: pending }) }}</h2>
            <button
              type="button"
              class="dialog-close"
              data-branch-switch-close
              :aria-label="t('common.close')"
              v-tip="t('common.close')"
              @click="pending = undefined"
            >
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
  color: var(--text-base);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 8px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 400;
  line-height: calc(20px * var(--ui-font-scale, 1));
}

/* Hover only, as MiMo's is: it has no rule holding the chip lit while its menu is open. */
.chip:hover {
  color: var(--text-body);
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

/* MiMo's caret: the chip's 15px icon size, held back to 55%. */
.caret {
  flex: none;
  width: 15px;
  height: 15px;
  opacity: 0.55;
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
  border: 0.5px solid var(--border-input);
  border-radius: 16px;
  box-shadow: var(--shadow-composer);
  backdrop-filter: blur(18px) saturate(150%);
  transform-origin: top;
  animation: menu-in 0.15s ease-out;
}

/* MiMo animates every popover in: a fade, a 95% zoom and an 8px slide from its trigger. */
@keyframes menu-in {
  from {
    opacity: 0;
    transform: translateY(-8px) scale(0.95);
  }
}

@media (prefers-reduced-motion: reduce) {
  .menu {
    animation: none;
  }
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
  color: var(--text-body);
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
  color: var(--text-body);
  background: transparent;
  border-radius: 11px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 400;
  line-height: calc(20px * var(--ui-font-scale, 1));
  text-align: start;
  cursor: default;
}

.row:hover,
.row:focus-visible {
  background: var(--surface-hover);
  outline: none;
}

/* MiMo's --color-icon: #5c5c57 on light, #d0d0d0 on dark (below). */
.row .i {
  flex: none;
  width: 17px;
  height: 17px;
  color: #5c5c57;
}

.name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* MiMo's tick is its --color-send: #151c13 on light, #ececec on dark (below). */
.check {
  flex: none;
  width: 16px;
  height: 16px;
  margin-inline-start: auto;
  color: #151c13;
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
  background: var(--surface-page);
  border: 1px solid var(--border-weak);
  border-radius: 16px;
  box-shadow: var(--shadow-pop);
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
  color: var(--text-base);
  background: transparent;
  border: 0;
  border-radius: 7px;
  cursor: pointer;
}

.dialog-close:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

/* MiMo's permc-desc: 14px in --color-txt. */
.dialog-desc {
  margin: 0 0 20px;
  color: var(--text-body);
  font-size: calc(14px * var(--ui-font-scale, 1));
  line-height: 1.65;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

/* MiMo's np-btn: the page ground (#fffefd, #1a1a1a dark) with the menu hover. */
.dialog-btn {
  padding: 8px 18px;
  color: var(--text-base);
  font: inherit;
  font-size: calc(14px * var(--ui-font-scale, 1));
  background: #fffefd;
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  cursor: pointer;
}

.dialog-btn:hover {
  color: var(--text-strong);
  background: #f1f0ec;
}

/* 仍然切换 is MiMo's light red pair, not a solid fill. */
.dialog-btn.danger {
  color: #d93025;
  background: #fdecea;
  border-color: #fdecea;
}

.dialog-btn.danger:hover {
  color: #d93025;
  background: #fadbd8;
  border-color: #fadbd8;
}

/*
 * MiMo's --color-icon and --color-send on the dark scheme. Neither has a token
 * of its own, so both are written out.
 */

:root[data-theme="dark"] .row .i {
  color: #d0d0d0;
}

:root[data-theme="dark"] .check {
  color: #ececec;
}

:root[data-theme="dark"] .dialog-btn {
  background: #1a1a1a;
}

:root[data-theme="dark"] .dialog-btn:hover {
  background: #ffffff0f;
}

:root[data-theme="dark"] .dialog-btn.danger {
  color: #ff9b7f;
  background: #3a2320;
  border-color: #3a2320;
}

:root[data-theme="dark"] .dialog-btn.danger:hover {
  background: #4a2c27;
  border-color: #4a2c27;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .row .i {
    color: #d0d0d0;
  }

  :root:not([data-theme="light"]) .check {
    color: #ececec;
  }

  :root:not([data-theme="light"]) .dialog-btn {
    background: #1a1a1a;
  }

  :root:not([data-theme="light"]) .dialog-btn:hover {
    background: #ffffff0f;
  }

  :root:not([data-theme="light"]) .dialog-btn.danger {
    color: #ff9b7f;
    background: #3a2320;
    border-color: #3a2320;
  }

  :root:not([data-theme="light"]) .dialog-btn.danger:hover {
    background: #4a2c27;
    border-color: #4a2c27;
  }
}
</style>
