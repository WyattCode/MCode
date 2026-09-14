<script setup lang="ts">
import { computed, ref } from "vue"
import type { AssistantPart } from "@shared/protocol"
import { useApp } from "../stores/app"
import { editedFiles } from "../lib/edited-files"
import { requestFile, requestReview } from "../lib/review-request"
import { notify, notifyFailure } from "../lib/toast"
import { t } from "../lib/i18n"

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
const edited = computed(() => editedFiles(props.parts, props.directory))
const files = computed(() => edited.value.files)
const single = computed(() => (files.value.length === 1 ? files.value[0] : undefined))

const expanded = ref(false)
const shownFiles = computed(() => (expanded.value ? files.value : files.value.slice(0, 3)))
const hiddenCount = computed(() => Math.max(0, files.value.length - shownFiles.value.length))

const confirming = ref(false)
const reverting = ref(false)

function baseName(file: string) {
  return file.split(/[\\/]/).pop() || file
}

async function revert() {
  confirming.value = false
  if (!props.sessionId) return
  reverting.value = true
  try {
    const result = await app.revertTurn(props.sessionId, props.messageIds)
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
</script>

<template>
  <div v-if="reverted" class="file-card reverted" data-fc-reverted>
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
      <path d="M3 7v6h6M3 13a9 9 0 1 0 3-7.7L3 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
    {{ t("stream.revertedCard", { n: files.length }) }}
  </div>
  <template v-else>
    <div class="file-card" data-edited-card>
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
          <span class="fc-stat" data-fc-diffstat>
            <span class="fc-add">+{{ edited.add }}</span>
            <span class="fc-del">-{{ edited.del }}</span>
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
          <button type="button" class="fc-review" data-fc-action="review" @click="requestReview()">
            {{ t("stream.reviewFiles") }}
          </button>
        </span>
      </div>
      <div v-if="files.length > 1" class="fc-files" data-fc-files>
        <button
          v-for="(file, index) in shownFiles"
          :key="file.path"
          type="button"
          class="fc-row"
          :data-fc-file-row="index"
          v-tip="{ label: file.path, placement: 'bottom' }"
          @click="requestFile(file.path)"
        >
          <span class="fc-name">{{ file.path }}</span>
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
  </template>
</template>

<style scoped>
.file-card {
  width: 100%;
  margin-top: 12px;
  overflow: hidden;
  font-weight: 400;
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: 10px;
}

.file-card.reverted {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 11px 14px;
  color: var(--text-weak);
  font-size: calc(14px * var(--ui-font-scale, 1));
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
  background: var(--surface-sunken);
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

.fc-add {
  color: var(--diff-add);
}

.fc-del {
  color: var(--diff-delete);
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

.fc-revert:hover,
.fc-review:hover {
  background: var(--surface-hover);
}

.fc-revert:disabled {
  cursor: default;
  opacity: 0.55;
}

.fc-files {
  padding: 2px 12px;
  border-top: 1px solid var(--border-weak);
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
  background: var(--surface-sunken);
  outline: none;
}

.fc-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--text-weak);
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
 * The question before taking a turn back: a warm tint and edge, since what it
 * asks cannot be undone, with the two answers under it.
 */
.fc-confirm {
  margin-top: 10px;
  padding: 14px 16px;
  background: color-mix(in srgb, var(--warning) 6%, transparent);
  border: 1px solid color-mix(in srgb, var(--warning) 35%, transparent);
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
  color: var(--warning);
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

.fc-confirm-btn.allow {
  color: var(--button-primary-text);
  background: var(--button-primary);
  border-color: var(--button-primary);
}

.fc-confirm-btn.allow:hover {
  opacity: 0.9;
}
</style>
