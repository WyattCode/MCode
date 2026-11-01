<script setup lang="ts">
import { computed } from "vue"
import type { SessionInfo, SubagentNotice, ToolPart } from "@shared/protocol"
import SubagentAvatar from "./SubagentAvatar.vue"
import { t } from "../../lib/i18n"
import { actionOf, childFor, noticeStatus, pillStatus } from "../../lib/subagents"
import { answerSummary, operationInput, subagentAnswer } from "@shared/subagent"
import { useApp } from "../../stores/app"
import { useRightPanel } from "../../stores/right-panel"

/**
 * subagents: MiMo's subagent activity row. One pill per subagent - its avatar
 * and name - and after them where they stand. For actor calls that is 开始工作
 * while any works, 已完成 once every one is a run that answered; for the notices
 * background subagents send back it is their outcome - 已完成, 失败, 已取消,
 * 可能停滞 - or 已结束 when a row's notices disagree. A pill opens the 子智能体
 * tab on that subagent.
 */
const props = defineProps<{ parts?: ToolPart[]; notices?: SubagentNotice[]; agents?: SessionInfo[] }>()

const app = useApp()
const rp = useRightPanel()

const status = computed(() => (props.agents?.length ? "running" : props.notices?.length ? noticeStatus(props.notices) : pillStatus(props.parts ?? [])))
const statusText = computed(() => t(`subagentActivity.status.${status.value}`))

const pills = computed(() => {
  if (props.agents?.length) return props.agents.map((child) => ({
    key: child.parentCallID,
    id: child.id,
    seed: child.subagent?.id ?? child.id,
    name: child.title || t("subagentActivity.fallbackName"),
    summary: undefined,
  }))
  if (props.notices?.length) {
    return props.notices.map((notice) => {
      const child = app.subagentSessions.find((session) => session.id === notice.sessionID)
      return {
        // The tab is keyed by the call that started the subagent; a notice whose subagent is gone opens nothing.
        key: child?.parentCallID,
        id: notice.sessionID,
        seed: notice.subagentID,
        name: notice.description || child?.title || t("subagentActivity.fallbackName"),
        summary: notice.summary,
      }
    })
  }
  return (props.parts ?? []).map((part) => {
    const child = childFor(part.callID, app.subagentSessions)
    const given = operationInput(part.input).description
    const described = typeof given === "string" ? given.trim() : ""
    return {
      key: part.callID as string | undefined,
      id: part.callID,
      seed: child?.subagent?.id ?? part.callID,
      name: described || child?.title || t("subagentActivity.fallbackName"),
      summary: part.status === "completed" && actionOf(part) === "run" ? answerSummary(subagentAnswer(part.output)) : undefined,
    }
  })
})
</script>

<template>
  <div class="subagent-activity" role="group" data-subagent-activity :data-subagent-status="status" :data-subagent-notice="notices?.length ? '' : undefined">
    <div class="subagent-pill-list">
      <button
        v-for="pill in pills"
        :key="pill.id"
        type="button"
        class="subagent-pill"
        data-subagent-pill
        :data-call-id="pill.key"
        :disabled="!pill.key"
        :aria-label="pill.key ? t('subagentActivity.open', { name: pill.name, status: statusText }) : `${pill.name}${statusText}`"
        :title="pill.summary"
        @click="pill.key && rp.openSubagents(pill.key)"
      >
        <SubagentAvatar :seed="pill.seed" compact />
        <span>{{ pill.name }}</span>
      </button>
    </div>
    <span class="subagent-activity-state" role="status" aria-live="polite" :class="{ failed: status === 'failed' }">{{ statusText }}</span>
  </div>
</template>

<style scoped>
/* MiMo's subagent-activity: wrapping, 7 by 9 apart, 5 above and below. */
.subagent-activity {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px 9px;
  max-width: 100%;
  padding-block: 5px;
  color: color-mix(in srgb, var(--text-strong) 80%, transparent);
}

.subagent-pill-list {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

/* MiMo's pill: 30 tall, 3 / 10 / 3 / 5 inside, 7 between avatar and name, at most 240, a 20% ink line. */
.subagent-pill {
  display: inline-flex;
  box-sizing: border-box;
  align-items: center;
  gap: 7px;
  min-width: 0;
  max-width: 240px;
  height: calc(30px * var(--ui-font-scale, 1));
  padding-block: 3px;
  padding-inline: 5px 10px;
  color: color-mix(in srgb, var(--text-strong) 60%, transparent);
  background: #fefefd;
  border: 1px solid color-mix(in srgb, var(--text-strong) 20%, transparent);
  border-radius: 999px;
  font: inherit;
  font-size: calc(13px * var(--ui-font-scale, 1));
  text-align: start;
  cursor: pointer;
}

.subagent-pill:disabled {
  cursor: default;
}

.subagent-pill > span:last-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.subagent-pill:not(:disabled):hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.subagent-pill:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: 1px;
}

/* The words after the pills: 13px dim; a failure in MiMo's delete red. */
.subagent-activity-state {
  flex: none;
  color: color-mix(in srgb, var(--text-strong) 40%, transparent);
  font-size: calc(13px * var(--ui-font-scale, 1));
  white-space: nowrap;
}

.subagent-activity-state.failed {
  color: #e5484d;
}

/*
 * Dark: the pill takes MiMo's panel mixed 92% with side-active.
 *
 * The hover is repeated below because this rule and it are both (0,3,0) - the
 * theme rule wins on source order alone, and the fill under the pointer went
 * missing in dark while the ink still brightened (R25-D5).
 */
:root[data-theme="dark"] .subagent-pill {
  background: color-mix(in srgb, var(--surface-raised) 92%, var(--surface-selected));
}

:root[data-theme="dark"] .subagent-pill:not(:disabled):hover {
  background: var(--surface-hover);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .subagent-pill {
    background: color-mix(in srgb, var(--surface-raised) 92%, var(--surface-selected));
  }

  :root:not([data-theme="light"]) .subagent-pill:not(:disabled):hover {
    background: var(--surface-hover);
  }
}
</style>
