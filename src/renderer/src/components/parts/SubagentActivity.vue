<script setup lang="ts">
import { computed } from "vue"
import type { ToolPart } from "@shared/protocol"
import SubagentAvatar from "./SubagentAvatar.vue"
import { t } from "../../lib/i18n"
import { childFor, pillStatus } from "../../lib/subagents"
import { subagentAnswer } from "@shared/subagent"
import { useApp } from "../../stores/app"
import { useRightPanel } from "../../stores/right-panel"

/**
 * subagents: MiMo's subagent activity row. One pill per subagent - its avatar
 * and name - and after them where they stand: 开始工作 while any works, 已完成
 * once all are done. A pill opens the 子智能体 tab on that subagent.
 */
const props = defineProps<{ parts: ToolPart[] }>()

const app = useApp()
const rp = useRightPanel()

const status = computed(() => pillStatus(props.parts))
const statusText = computed(() => t(`subagentActivity.status.${status.value}`))

const pills = computed(() =>
  props.parts.map((part) => {
    const child = childFor(part.callID, app.subagentSessions)
    const described = typeof part.input?.description === "string" ? part.input.description.trim() : ""
    return {
      key: part.callID,
      seed: child?.subagent?.id ?? part.callID,
      name: described || child?.title || t("subagentActivity.fallbackName"),
      summary: part.status === "completed" ? subagentAnswer(part.output) : undefined,
    }
  }),
)
</script>

<template>
  <div class="subagent-activity" data-subagent-activity :data-subagent-status="status">
    <div class="subagent-pill-list">
      <button
        v-for="pill in pills"
        :key="pill.key"
        type="button"
        class="subagent-pill"
        data-subagent-pill
        :data-call-id="pill.key"
        :aria-label="t('subagentActivity.open', { name: pill.name, status: statusText })"
        :title="pill.summary"
        @click="rp.openSubagents(pill.key)"
      >
        <SubagentAvatar :seed="pill.seed" compact />
        <span>{{ pill.name }}</span>
      </button>
    </div>
    <span class="subagent-activity-state">{{ statusText }}</span>
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
  height: 30px;
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

.subagent-pill > span:last-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.subagent-pill:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.subagent-pill:focus-visible {
  outline: 2px solid var(--text-interactive);
  outline-offset: 1px;
}

/* The words after the pills: 13px dim. */
.subagent-activity-state {
  flex: none;
  color: color-mix(in srgb, var(--text-strong) 40%, transparent);
  font-size: calc(13px * var(--ui-font-scale, 1));
  white-space: nowrap;
}

/* Dark: the pill takes MiMo's panel mixed 92% with side-active. */
:root[data-theme="dark"] .subagent-pill {
  background: color-mix(in srgb, var(--surface-raised) 92%, var(--surface-selected));
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .subagent-pill {
    background: color-mix(in srgb, var(--surface-raised) 92%, var(--surface-selected));
  }
}
</style>
