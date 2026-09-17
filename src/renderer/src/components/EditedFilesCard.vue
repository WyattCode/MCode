<script setup lang="ts">
import { computed, ref, watch } from "vue"
import type { AssistantPart, ToolPart } from "@shared/protocol"
import { parseUnifiedDiff } from "@shared/unified-diff"
import { useApp } from "../stores/app"
import { useRightPanel } from "../stores/right-panel"
import { editedFiles } from "../lib/edited-files"
import { requestFile } from "../lib/review-request"
import { notify, notifyFailure } from "../lib/toast"
import type { MenuItem } from "../lib/menu"
import { t } from "../lib/i18n"
import ContextMenu from "./ContextMenu.vue"

/*
 * MiMo's card at the end of a turn that changed files: "已编辑 N 个文件" with
 * the lines added and removed, 撤销 and 审阅, and the files themselves under
 * it. Taking the turn back asks first, then puts the card into its reverted
 * form, which stays: the transcript is kept, only the files moved.
 */
const props = defineProps<{
  parts: AssistantPart[]
  /** The turn's assistant messages, which name the turn to the server. */
  messageIds: string[]
  sessionId?: string
  directory?: string
  reverted?: boolean
  /** Whether 撤销 and 审阅 are offered; not in a side conversation. */
  actions?: boolean
}>()

const app = useApp()
const rp = useRightPanel()
const edited = computed(() => editedFiles(props.parts, props.directory))
const files = computed(() => edited.value.files)
const single = computed(() => (files.value.length === 1 ? files.value[0] : undefined))

const expanded = ref(false)
const confirming = ref(false)
const reverting = ref(false)

/*
 * MiMo counts the files as they stand now, so an edit made later or a revert
 * outside the turn moves the figures. Asked once the card is shown and not
 * reverted; the counts the turn's tools recorded stand where there is no
 * repository, the ask fails, or a file has no answer.
 */
const current = ref<Map<string, { add: number; del: number }>>()

function counts(patch: string) {
  let add = 0
  let del = 0
  for (const section of parseUnifiedDiff(patch)) {
    for (const hunk of section.hunks) {
      add += hunk.added
      del += hunk.removed
    }
  }
  return { add, del }
}

function keep(answer: { repo: boolean; files: { path: string; patch: string }[] } | undefined) {
  if (answer?.repo) current.value = new Map(answer.files.map((entry) => [entry.path, counts(entry.patch)]))
}

let asking = ""
watch(
  () => (props.reverted || !props.directory ? "" : [props.directory, ...files.value.map((file) => file.path)].join("\n")),
  async (key) => {
    asking = key
    current.value = undefined
    if (!key || !props.directory) return
    const answer = await app.turnDiff(props.directory, files.value.map((file) => file.path)).catch(() => undefined)
    if (asking === key) keep(answer)
  },
  { immediate: true },
)

const rows = computed(() => files.value.map((file) => ({ ...file, ...(current.value?.get(file.path) ?? {}) })))
const shownRows = computed(() => (expanded.value ? rows.value : rows.value.slice(0, 3)))
const hiddenCount = computed(() => Math.max(0, rows.value.length - shownRows.value.length))
const total = computed(() =>
  rows.value.reduce((sum, file) => ({ add: sum.add + file.add, del: sum.del + file.del }), { add: 0, del: 0 }),
)

function baseName(file: string) {
  return file.split(/[\\/]/).pop() || file
}

async function revert() {
  confirming.value = false
  if (!props.sessionId) return
  reverting.value = true
  try {
    const result = await app.revertTurn(props.sessionId, props.messageIds)
    // MiMo's refusal: taking a turn back goes through git, and this project has no repository.
    if (result.noRepo) {
      notifyFailure(t("stream.revertNoRepo"))
      return
    }
    const done = result.restored + result.removed
    if (done === 0) {
      if (result.outside > 0) notifyFailure(t("stream.revertCancelledOutside", { n: result.outside }))
      else if (result.failed > 0) notifyFailure(t("stream.revertFailedSome", { n: result.failed }))
      else notifyFailure(t("stream.revertFailed"))
      return
    }
    const extra = [
      result.failed > 0 ? t("stream.revertExtraFailed", { n: result.failed }) : "",
      result.outside > 0 ? t("stream.revertExtraOutside", { n: result.outside }) : "",
    ]
      .filter(Boolean)
      .join(t("stream.revertExtraSep"))
    notify(extra ? t("stream.revertedWithExtra", { n: done, extra }) : t("stream.revertedCard", { n: done }))
  } catch (err) {
    notifyFailure(t("stream.revertFailed"), err instanceof Error ? err.message : String(err))
  } finally {
    reverting.value = false
  }
}

/* The diffs the turn's own edit, write and patch calls recorded. */
function toolPatch(): string {
  const diffs: string[] = []
  for (const part of props.parts) {
    if (part.type !== "tool" || !["edit", "multiedit", "write", "patch"].includes(part.name) || part.status === "error") continue
    const diff = (part as ToolPart).metadata?.diff
    if (typeof diff === "string" && diff) diffs.push(diff)
  }
  return diffs.join("\n")
}

/* A patch with at least one hunk; headers alone show nothing. */
function changes(patch: string) {
  return parseUnifiedDiff(patch).some((section) => section.hunks.length > 0)
}

/*
 * MiMo's 审阅: a 审阅 diff tab of just this card's files as they stand now,
 * else the turn's recorded diffs, else a note that there is nothing to show.
 */
const reviewing = ref(false)
async function review() {
  if (reviewing.value) return
  reviewing.value = true
  try {
    let patch = ""
    if (props.directory) {
      const answer = await app.turnDiff(props.directory, files.value.map((file) => file.path), true).catch(() => undefined)
      keep(answer)
      if (answer?.repo) patch = answer.files.map((entry) => entry.patch).filter(changes).join("\n")
    }
    if (!changes(patch)) patch = toolPatch()
    if (!changes(patch)) {
      notify(t("stream.noDiff"))
      return
    }
    rp.openDiff(t("stream.reviewFiles"), patch)
  } finally {
    reviewing.value = false
  }
}

/* MiMo's file menu on a row, or on the whole card when it names one file. */
const menu = ref<{ x: number; y: number; path: string }>()
const menuItems = computed<MenuItem[]>(() => [
  { key: "open", label: t("rp.files.open") },
  { key: "reveal", label: t("files.reveal") },
  { key: "copyPath", label: t("rp.files.copyPath") },
  { key: "copyRelPath", label: t("rp.files.copyRelPath") },
])

function openMenu(event: MouseEvent, file: string) {
  event.preventDefault()
  menu.value = { x: event.clientX, y: event.clientY, path: file }
}

const root = computed(() => props.directory?.replace(/[\\/]+$/, "") ?? "")

function absolute(file: string) {
  return /^([a-zA-Z]:)?[\\/]/.test(file) || !root.value ? file : `${root.value}/${file}`
}

function relative(file: string) {
  const base = root.value
  const inside = base && file.toLowerCase().startsWith(base.toLowerCase()) && /[\\/]/.test(file.charAt(base.length))
  return inside ? file.slice(base.length + 1) : file
}

async function pickMenu(key: string) {
  const file = menu.value?.path
  menu.value = undefined
  if (!file) return
  if (key === "open") requestFile(file)
  else if (key === "reveal") {
    const result = await window.mcode.revealPath(absolute(file)).catch((error: unknown) => ({ ok: false, error: String(error) }))
    if (result.ok) return
    if (!result.error || /ENOENT|not exist|no such file|cannot find/i.test(result.error)) notifyFailure(t("harnessRow.pathNotExist"))
    else notifyFailure(t("harnessRow.revealFailed", { error: result.error }))
  } else if (key === "copyPath" || key === "copyRelPath") {
    window.mcode.setClipboardText(key === "copyPath" ? absolute(file) : relative(file))
    notify(t("rp.files.pathCopied"))
  }
}
</script>

<template>
  <!-- MiMo draws the card only for a turn that changed files. -->
  <div v-if="files.length && reverted" class="file-card reverted" data-fc-reverted>
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
      <path d="M3 7v6h6M3 13a9 9 0 1 0 3-7.7L3 8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
    {{ t("stream.revertedCard", { n: files.length }) }}
  </div>
  <template v-else-if="files.length">
    <div class="file-card" data-edited-card @contextmenu="single ? openMenu($event, single.path) : undefined">
      <div class="fc-head" data-fc-header>
        <span class="fc-icon" :data-fc-icon="files.length > 1 ? 'multiple' : single?.created ? 'new' : 'edited'">
          <svg v-if="files.length > 1" width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M8 3h7l4 4v10a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" />
            <path d="M15 3v4h4M3 8v11a2 2 0 0 0 2 2h9" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <svg v-else-if="single?.created" width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" />
            <path d="M14 3v5h5M12 11v6M9 14h6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <svg v-else width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M14 3v5h5v2M19.4 13.6a1.9 1.9 0 0 1 0 2.7L15 20.7l-3 .8.8-3 4.4-4.4a1.9 1.9 0 0 1 2.2-.5Z" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
        <span class="fc-info">
          <span class="fc-title" data-fc-title>
            <template v-if="single">
              <span class="fc-prefix">{{ t("stream.editedPrefix") }}&nbsp;</span>
              <button type="button" class="fc-file" :title="single.path" data-fc-reveal @click="requestFile(single.path)">
                {{ baseName(single.path) }}
              </button>
            </template>
            <span v-else class="fc-truncate">{{ t("stream.editedCard", { n: files.length }) }}</span>
          </span>
          <span class="fc-stat" data-fc-diffstat :data-fc-source="current ? 'current' : 'tools'">
            <span class="fc-add">+{{ total.add }}</span>
            <span class="fc-del">-{{ total.del }}</span>
          </span>
        </span>
        <span v-if="actions" class="fc-actions">
          <button type="button" class="fc-revert" data-fc-action="revert" :disabled="reverting" @click="confirming = true">
            {{ t("stream.revertFiles") }}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M9 14 4 9l5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
              <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <button type="button" class="fc-review" data-fc-action="review" :disabled="reviewing" @click="review">
            {{ t("stream.reviewFiles") }}
          </button>
        </span>
      </div>
      <div v-if="files.length > 1" class="fc-files" data-fc-files>
        <button
          v-for="(file, index) in shownRows"
          :key="file.path"
          type="button"
          class="fc-row"
          :data-fc-file-row="index"
          v-tip="{ label: file.path, placement: 'bottom' }"
          @click="requestFile(file.path)"
          @contextmenu="openMenu($event, file.path)"
        >
          <!-- MiMo writes each row relative to the project, keeping the whole path for the tooltip. -->
          <span class="fc-name">{{ relative(file.path) }}</span>
          <span class="fc-stat" data-fc-file-stats>
            <span class="fc-add">+{{ file.add }}</span>
            <span class="fc-del">-{{ file.del }}</span>
          </span>
        </button>
        <button
          v-if="files.length > 3"
          type="button"
          class="fc-more"
          data-fc-files-toggle
          :aria-expanded="expanded"
          @click="expanded = !expanded"
        >
          {{ expanded ? t("stream.collapseFiles") : t("stream.showMoreFiles", { n: hiddenCount }) }}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path :d="expanded ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>
    </div>
    <div v-if="actions && confirming" class="fc-confirm" data-fc-confirm>
      <div class="fc-question">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 2 3 7v6c0 5 3.8 8.5 9 9 5.2-.5 9-4 9-9V7z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
          <path d="M12 8v4M12 16h.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
        </svg>
        {{ t("stream.confirmRevert", { n: files.length }) }}
      </div>
      <div class="fc-confirm-actions">
        <button type="button" class="fc-confirm-btn allow" data-fc-confirm-yes @click="revert">{{ t("stream.confirmRevertYes") }}</button>
        <button type="button" class="fc-confirm-btn" data-fc-confirm-no @click="confirming = false">{{ t("common.cancel") }}</button>
      </div>
    </div>
    <ContextMenu v-if="menu" :x="menu.x" :y="menu.y" :items="menuItems" @pick="pickMenu" @close="menu = undefined" />
  </template>
</template>

<style scoped>
/* MiMo's card: its page fill and warm line, #fffefd / #f0ebe5, and #181818 / #2e2e2e in the dark. */
.file-card {
  width: 100%;
  margin-top: 12px;
  overflow: hidden;
  font-weight: 400;
  background: #fffefd;
  border: 1px solid #f0ebe5;
  border-radius: 10px;
}

/* Taken back: the code-block fill, a little faded, in the muted colour. */
.file-card.reverted {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 11px 14px;
  color: #151c1399;
  font-size: calc(14px * var(--ui-font-scale, 1));
  background: #f0f0f2;
  opacity: 0.85;
}

.fc-head {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 66px;
  padding: 10px 12px;
}

.fc-icon {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  color: var(--text-weak);
  background: #f0f0f2;
  border-radius: 10px;
}

.fc-info {
  flex: 1;
  min-width: 0;
}

.fc-title {
  display: flex;
  align-items: center;
  min-width: 0;
  color: var(--text-strong);
  font-size: calc(14px * var(--ui-font-scale, 1));
  line-height: 20px;
}

.fc-prefix {
  flex: none;
}

.fc-file {
  min-width: 0;
  padding: 0;
  overflow: hidden;
  color: inherit;
  font: inherit;
  text-align: start;
  white-space: nowrap;
  text-overflow: ellipsis;
  background: transparent;
  border: 0;
  cursor: pointer;
}

.fc-file:hover,
.fc-file:focus-visible {
  color: var(--text-interactive);
  outline: none;
}

.fc-truncate {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.fc-stat {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
  font-family: var(--font-mono);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 18px;
}

/* MiMo writes the card's counts in these two colours whatever the theme. */
.fc-add {
  color: #1a7f37;
}

.fc-del {
  color: #e5484d;
}

.fc-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
  margin-inline-start: auto;
}

.fc-revert,
.fc-review {
  display: inline-flex;
  flex: none;
  align-items: center;
  height: 26px;
  color: var(--text-base);
  font: inherit;
  font-size: calc(14px * var(--ui-font-scale, 1));
  line-height: 20px;
  border-radius: 8px;
  cursor: pointer;
}

.fc-revert {
  gap: 5px;
  padding: 0 8px;
  background: transparent;
  border: 0;
}

.fc-review {
  padding: 0 11px;
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
}

.fc-revert:hover {
  background: #f1f0ec;
}

.fc-review:hover {
  background: var(--surface-hover);
}

.fc-revert:disabled {
  cursor: default;
  opacity: 0.55;
}

.fc-files {
  padding: 2px 12px;
  border-top: 1px solid #f0ebe5;
}

.fc-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: calc(100% + 16px);
  min-height: 36px;
  margin: 0 -8px;
  padding: 0 9px;
  font: inherit;
  text-align: start;
  background: transparent;
  border: 0;
  border-radius: 8px;
  cursor: pointer;
}

.fc-row:hover,
.fc-row:focus-visible {
  background: #f0f0f2;
  outline: none;
}

.fc-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: #151c1399;
  font-size: calc(14px * var(--ui-font-scale, 1));
  line-height: 20px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.fc-more {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding: 0 1px;
  color: var(--text-base);
  font: inherit;
  font-size: calc(14px * var(--ui-font-scale, 1));
  line-height: 20px;
  background: transparent;
  border: 0;
  border-radius: 6px;
  cursor: pointer;
}

.fc-more:hover,
.fc-more:focus-visible {
  color: var(--text-interactive);
  outline: none;
}

/*
 * The question before taking a turn back, on MiMo's permission card: an orange
 * tint and edge in both themes, since what it asks cannot be undone, with the
 * two answers under it.
 */
.fc-confirm {
  margin-top: 10px;
  padding: 14px 16px;
  background: #ff6a2b0f;
  border: 1px solid #ff6a2b59;
  border-radius: 12px;
}

.fc-question {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  color: var(--text-strong);
  font-size: calc(14px * var(--ui-font-scale, 1));
  line-height: 1.55;
}

.fc-question svg {
  flex: none;
  margin-top: 1px;
  color: #ff6a2b;
}

.fc-confirm-actions {
  display: flex;
  gap: 10px;
  margin-top: 12px;
}

.fc-confirm-btn {
  padding: 7px 18px;
  color: var(--text-base);
  font: inherit;
  font-size: calc(13px * var(--ui-font-scale, 1));
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  cursor: pointer;
}

.fc-confirm-btn:hover {
  background: var(--surface-hover);
}

/* MiMo's send colours: near-black with white, and near-white with near-black in the dark. */
.fc-confirm-btn.allow {
  color: #ffffff;
  background: #151c13;
  border-color: #151c13;
}

.fc-confirm-btn.allow:hover {
  background: #151c13;
  opacity: 0.9;
}

:root[data-theme="dark"] .file-card {
  background: #181818;
  border-color: #2e2e2e;
}

:root[data-theme="dark"] .file-card.reverted,
:root[data-theme="dark"] .fc-icon,
:root[data-theme="dark"] .fc-row:hover,
:root[data-theme="dark"] .fc-row:focus-visible {
  background: #2e2e2e;
}

:root[data-theme="dark"] .file-card.reverted,
:root[data-theme="dark"] .fc-name {
  color: #b8b8b8;
}

:root[data-theme="dark"] .fc-revert:hover {
  background: #ffffff0f;
}

:root[data-theme="dark"] .fc-files {
  border-top-color: #2e2e2e;
}

:root[data-theme="dark"] .fc-confirm-btn.allow,
:root[data-theme="dark"] .fc-confirm-btn.allow:hover {
  color: #151c13;
  background: #ececec;
  border-color: #ececec;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .file-card {
    background: #181818;
    border-color: #2e2e2e;
  }

  :root:not([data-theme="light"]) .file-card.reverted,
  :root:not([data-theme="light"]) .fc-icon,
  :root:not([data-theme="light"]) .fc-row:hover,
  :root:not([data-theme="light"]) .fc-row:focus-visible {
    background: #2e2e2e;
  }

  :root:not([data-theme="light"]) .file-card.reverted,
  :root:not([data-theme="light"]) .fc-name {
    color: #b8b8b8;
  }

  :root:not([data-theme="light"]) .fc-revert:hover {
    background: #ffffff0f;
  }

  :root:not([data-theme="light"]) .fc-files {
    border-top-color: #2e2e2e;
  }

  :root:not([data-theme="light"]) .fc-confirm-btn.allow,
  :root:not([data-theme="light"]) .fc-confirm-btn.allow:hover {
    color: #151c13;
    background: #ececec;
    border-color: #ececec;
  }
}
</style>
