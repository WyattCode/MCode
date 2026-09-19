<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue"
import MessageStream from "../MessageStream.vue"
import SubagentAvatar from "../parts/SubagentAvatar.vue"
import { useApp } from "../../stores/app"
import { useRightPanel, type RightTab } from "../../stores/right-panel"
import { t, tn } from "../../lib/i18n"
import { COMPLETED_CAP, subagentItems, subagentTime, type SubagentItem } from "../../lib/subagents"

/**
 * subagents: MiMo's 子智能体 tab.
 *
 * The overview lists the conversation's subagents in two groups - 已开启 for
 * the ones at work, 完成 for the rest, ten at a time - each row an avatar with
 * its status dot, the name, 「状态 · 摘要」 and a time. A row opens that
 * subagent's own transcript, drawn with the side chat's stream, under a head
 * with a way back, the name, 执行记录 and a status chip.
 */
const props = defineProps<{ tab: RightTab; active: boolean }>()
const app = useApp()
const rp = useRightPanel()

const items = computed(() => subagentItems(app.messages, app.subagentSessions))
const working = computed(() => items.value.filter((item) => item.status === "running"))
const finished = computed(() => items.value.filter((item) => item.status !== "running"))
const showAll = ref(false)
const shownFinished = computed(() => (showAll.value ? finished.value : finished.value.slice(0, COMPLETED_CAP)))
const detail = computed(() => (props.tab.subagentKey ? items.value.find((item) => item.key === props.tab.subagentKey) : undefined))

/* A clock for the seconds column, ticking only while something works and the tab is on show. */
const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | undefined
watch(
  () => props.active && working.value.length > 0,
  (on) => {
    clearInterval(ticker)
    now.value = Date.now()
    if (on) ticker = setInterval(() => (now.value = Date.now()), 1000)
  },
  { immediate: true },
)

const nameOf = (item: SubagentItem) => item.name || t("subagentActivity.fallbackName")
const statusOf = (item: SubagentItem) => t(`subagents.status.${item.status}`)
/* MiMo leaves the summary out when it only repeats the name or the status. */
const summaryOf = (item: SubagentItem) => (item.summary && item.summary !== nameOf(item) && item.summary !== statusOf(item) ? item.summary : "")
function timeOf(item: SubagentItem): string {
  const { key, n, counted } = subagentTime(item, now.value)
  // The relative times are counted keys, one per plural form (tn).
  if (counted && n !== undefined) return tn(key, n)
  return n === undefined ? t(key) : t(key, { n })
}

/**
 * A row opens its transcript - once there is one.
 *
 * MiMo's detail view needs the subagent's own conversation id and stays on the
 * overview until the row has one (`p?.agentId ? transcript : overview`), so a
 * pill pressed the moment work starts does nothing rather than opening a page
 * with a back button and no content.
 */
function open(key?: string) {
  if (key && !items.value.find((item) => item.key === key)?.sessionID) return
  rp.update(props.tab.id, { subagentKey: key })
}

/* The transcript: read once, then kept current by its events; a failed read tries again every 2 s, as MiMo's does. */
const loadState = ref<"ready" | "loading" | "error">("loading")
let retry: ReturnType<typeof setTimeout> | undefined
async function load() {
  clearTimeout(retry)
  const id = detail.value?.sessionID
  if (!id) return
  if (!app.sideMessagesOf(id).length) loadState.value = "loading"
  const ok = await app.loadSide(id)
  if (detail.value?.sessionID !== id) return
  loadState.value = ok ? "ready" : "error"
  if (!ok) retry = setTimeout(() => void load(), 2000)
}
watch(
  () => [detail.value?.sessionID, props.active] as const,
  ([id, active]) => {
    if (id && active) void load()
  },
  { immediate: true },
)
const transcript = computed(() => (detail.value?.sessionID ? app.sideMessagesOf(detail.value.sessionID) : []))

onBeforeUnmount(() => {
  clearInterval(ticker)
  clearTimeout(retry)
})
</script>

<template>
  <div class="rp-subagents" :data-subagents-view="detail ? 'transcript' : 'overview'">
    <template v-if="detail">
      <div class="rp-subagent-detail-head" data-subagent-detail-head>
        <button
          type="button"
          class="rp-subagent-back"
          data-subagent-back
          :aria-label="t('subagents.back')"
          v-tip="t('subagents.back')"
          @click="open(undefined)"
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M10 3.5 5.5 8l4.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <SubagentAvatar :seed="detail.seed" :status="detail.status" show-status />
        <span class="rp-subagent-detail-copy">
          <span class="rp-subagent-detail-name" data-subagent-detail-name>{{ nameOf(detail) }}</span>
          <span class="rp-subagent-detail-subtitle">{{ t("subagents.transcript") }}</span>
        </span>
        <span class="rp-subagent-detail-status" :class="detail.status" data-subagent-detail-status>
          <span class="rp-subagent-dot" />{{ statusOf(detail) }}
        </span>
      </div>
      <div class="rp-subagent-transcript" data-subagent-transcript>
        <div v-if="!detail.sessionID" class="rp-subagent-note">{{ t("subagentDetail.empty") }}</div>
        <div v-else-if="loadState === 'error' && !transcript.length" class="rp-subagent-note">{{ t("subagentDetail.error") }}</div>
        <div v-else-if="loadState === 'loading' && !transcript.length" class="rp-subagent-note">{{ t("subagentDetail.loading") }}</div>
        <div v-else-if="!transcript.length" class="rp-subagent-note">{{ t("subagentDetail.empty") }}</div>
        <MessageStream v-else class="rp-subagent-stream" side subagent :sideId="detail.sessionID" />
      </div>
    </template>

    <div v-else class="rp-subagent-scroll">
      <div class="rp-subagent-section-head" data-subagent-section="active">
        <span>{{ t("subagents.active") }} · {{ working.length }}</span>
      </div>
      <div class="rp-subagent-group" :class="{ empty: !working.length }">
        <button
          v-for="item in working"
          :key="item.key"
          type="button"
          class="rp-subagent-row"
          :data-subagent-row="item.key"
          @click="open(item.key)"
        >
          <SubagentAvatar :seed="item.seed" :status="item.status" show-status />
          <span class="rp-subagent-copy">
            <span class="rp-subagent-name">{{ nameOf(item) }}</span>
            <span class="rp-subagent-summary">
              <span class="rp-subagent-state" :class="item.status">{{ statusOf(item) }}</span>
              <template v-if="summaryOf(item)"> · {{ summaryOf(item) }}</template>
            </span>
          </span>
          <span class="rp-subagent-time">
            {{ timeOf(item) }}
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </span>
        </button>
        <div v-if="!working.length" class="rp-subagent-empty">{{ t("subagents.noActive") }}</div>
      </div>

      <div class="rp-subagent-section-head" data-subagent-section="completed">
        <span>{{ t("subagents.completedGroup") }} · {{ finished.length }}</span>
      </div>
      <div class="rp-subagent-group" :class="{ empty: !finished.length }">
        <button
          v-for="item in shownFinished"
          :key="item.key"
          type="button"
          class="rp-subagent-row"
          :data-subagent-row="item.key"
          @click="open(item.key)"
        >
          <SubagentAvatar :seed="item.seed" :status="item.status" show-status />
          <span class="rp-subagent-copy">
            <span class="rp-subagent-name">{{ nameOf(item) }}</span>
            <span class="rp-subagent-summary">
              <span class="rp-subagent-state" :class="item.status">{{ statusOf(item) }}</span>
              <template v-if="summaryOf(item)"> · {{ summaryOf(item) }}</template>
            </span>
          </span>
          <span class="rp-subagent-time" :class="{ error: item.status === 'error' }">
            {{ timeOf(item) }}
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </span>
        </button>
        <div v-if="!finished.length" class="rp-subagent-empty">{{ t("subagents.noCompleted") }}</div>
      </div>
      <button v-if="finished.length > COMPLETED_CAP" type="button" class="rp-subagent-show-all" @click="showAll = !showAll">
        {{ showAll ? t("subagents.collapse") : t("subagents.showAll", { count: finished.length }) }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.rp-subagents {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  color: color-mix(in srgb, var(--text-strong) 80%, transparent);
  background: var(--surface-raised);
}

/* MiMo's scroll: 14 / 16 / 28 inside. */
.rp-subagent-scroll {
  flex: 1;
  min-height: 0;
  padding: 14px 16px 28px;
  overflow: auto;
}

/* Section heads: 12px muted 500 with tabular numbers, 15 above and 7 below (3 above the first). */
.rp-subagent-section-head {
  display: flex;
  align-items: center;
  margin: 15px 3px 7px;
  color: color-mix(in srgb, var(--text-strong) 60%, transparent);
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.rp-subagent-section-head:first-child {
  margin-top: 3px;
}

/* Groups: a 1px line on an 11px corner, on the near-white MiMo gives them. */
.rp-subagent-group {
  overflow: hidden;
  background: #fefefd;
  border: 1px solid var(--border-weak);
  border-radius: 11px;
}

.rp-subagent-group.empty {
  background: transparent;
  border-color: transparent;
}

/* Rows: avatar, words and time on a 28 / 1fr / auto grid, at least 56 tall, a line between. */
.rp-subagent-row {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto;
  column-gap: 10px;
  align-items: center;
  box-sizing: border-box;
  width: 100%;
  min-height: 56px;
  padding: 8px 10px;
  color: inherit;
  text-align: start;
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--border-weak);
  border-radius: 0;
  font: inherit;
  cursor: pointer;
}

.rp-subagent-row:last-of-type {
  border-bottom: 0;
}

.rp-subagent-row:hover {
  background: var(--surface-hover);
}

.rp-subagent-row:focus-visible,
.rp-subagent-back:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: 1px;
}

.rp-subagent-copy {
  min-width: 0;
}

.rp-subagent-name,
.rp-subagent-summary {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rp-subagent-name {
  color: var(--text-strong);
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
}

.rp-subagent-summary {
  margin-top: 2px;
  color: color-mix(in srgb, var(--text-strong) 40%, transparent);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.rp-subagent-time {
  display: flex;
  gap: 5px;
  align-items: center;
  color: color-mix(in srgb, var(--text-strong) 40%, transparent);
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.rp-subagent-time > svg {
  opacity: 0.55;
}

.rp-subagent-time.error {
  color: #e5484d;
}

.rp-subagent-empty {
  padding: 7px 3px;
  color: color-mix(in srgb, var(--text-strong) 40%, transparent);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.rp-subagent-show-all {
  margin: 7px 6px;
  padding: 4px 0;
  color: var(--text-interactive);
  background: transparent;
  border: 0;
  font: inherit;
  font-size: calc(12px * var(--ui-font-scale, 1));
  cursor: pointer;
}

/* Detail head: back, avatar, words and status on a 30 / 30 / 1fr / auto grid, at least 58 tall, 8 by 16 inside. */
.rp-subagent-detail-head {
  display: grid;
  flex: none;
  grid-template-columns: 30px 30px minmax(0, 1fr) auto;
  gap: 9px;
  align-items: center;
  box-sizing: border-box;
  min-height: 58px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border-weak);
}

.rp-subagent-back {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  padding: 0;
  color: color-mix(in srgb, var(--text-strong) 80%, transparent);
  background: transparent;
  border: 0;
  border-radius: 8px;
  font: inherit;
  cursor: pointer;
}

.rp-subagent-back:hover {
  background: var(--surface-hover);
}

.rp-subagent-detail-copy {
  min-width: 0;
}

.rp-subagent-detail-name,
.rp-subagent-detail-subtitle {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rp-subagent-detail-name {
  color: var(--text-strong);
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 550;
}

.rp-subagent-detail-subtitle {
  margin-top: 1px;
  color: color-mix(in srgb, var(--text-strong) 40%, transparent);
  font-size: calc(11px * var(--ui-font-scale, 1));
}

/* The status chip: 12px muted on side-active, 4 by 7 inside, a 6px dot. */
.rp-subagent-detail-status {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  padding: 4px 7px;
  color: color-mix(in srgb, var(--text-strong) 60%, transparent);
  background: var(--surface-selected);
  border-radius: 999px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  white-space: nowrap;
}

.rp-subagent-dot {
  flex: none;
  width: 6px;
  height: 6px;
  background: color-mix(in srgb, var(--text-strong) 40%, transparent);
  border-radius: 50%;
}

.rp-subagent-detail-status.running .rp-subagent-dot {
  background: #2f8f5b;
  box-shadow: 0 0 0 3px #2f8f5b1f;
}

.rp-subagent-detail-status.completed .rp-subagent-dot {
  background: #6f766f;
}

.rp-subagent-detail-status.error .rp-subagent-dot {
  background: #e5484d;
}

.rp-subagent-detail-status.rejected .rp-subagent-dot {
  background: #d28a32;
}

.rp-subagent-detail-status.skipped .rp-subagent-dot {
  background: #8b918b;
}

.rp-subagent-transcript {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

.rp-subagent-note {
  padding: 16px;
  color: color-mix(in srgb, var(--text-strong) 40%, transparent);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.rp-subagent-stream {
  flex: 1;
  min-height: 0;
}

/* The stream was laid out for the middle of the window; here it takes MiMo's 14 / 16 / 28. */
.rp-subagent-stream :deep(.inner) {
  max-width: none;
  padding: 14px 16px 28px;
}

/* Dark: groups on MiMo's panel mixed 92% with side-active. */
:root[data-theme="dark"] .rp-subagent-group:not(.empty) {
  background: color-mix(in srgb, var(--surface-raised) 92%, var(--surface-selected));
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .rp-subagent-group:not(.empty) {
    background: color-mix(in srgb, var(--surface-raised) 92%, var(--surface-selected));
  }
}
</style>
