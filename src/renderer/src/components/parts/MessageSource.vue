<script setup lang="ts">
/**
 * Who sent a message nobody typed, drawn over it.
 *
 * One row for both senders, from the message's `inbox`: a subagent's parent, as
 * MiMo's 来自 {source} 的消息 line; or - session chat - another conversation, by
 * its title, as MiMo's 来自「X」 / 「X」的回信 button that opens it, with a toast
 * when it is gone.
 */
import type { MessageSource } from "@shared/protocol"
import { computed } from "vue"
import { sessionTitle, t } from "../../lib/i18n"
import { notify } from "../../lib/toast"
import { useApp } from "../../stores/app"

const props = defineProps<{ source: MessageSource }>()
const app = useApp()

const label = computed(() =>
  t(props.source.direction === "reply" ? "stream.chatReply" : "stream.chatFrom", { title: sessionTitle(props.source.from) }),
)

async function openSource() {
  const id = props.source.sessionID
  if (!id || !app.sessions.some((session) => session.id === id)) {
    notify(t("stream.chatSourceGone"))
    return
  }
  await app.open(id)
}
</script>

<template>
  <!-- automation: MiMo's automation-message-source line, 13px quiet words after a 14px clock; its page is not shown in MiMo's release, so nothing opens. -->
  <div v-if="source.automationID" class="chat-source automation-source" :data-automation-source="source.automationID">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
    <span>{{ t("stream.automationSource") }}</span>
  </div>
  <button
    v-else-if="source.sessionID"
    type="button"
    class="chat-source"
    :data-sessionchat-source="source.sessionID"
    :data-sessionchat-direction="source.direction ?? 'request'"
    :aria-label="label"
    @click="openSource"
  >
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M4 6h9.5a2 2 0 0 1 2 2v4.5a2 2 0 0 1-2 2H9.5l-3 2.5v-2.5H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z" />
      <path d="M18.5 9.5H20a2 2 0 0 1 2 2V16a2 2 0 0 1-2 2h-1v2.5L16 18h-3.5" />
    </svg>
    <span>{{ label }}</span>
  </button>
  <div v-else class="subagent-initial" data-subagent-inbox>{{ t("subagentDetail.inboxSource", { source: source.from }) }}</div>
</template>

<style scoped>
/*
 * MiMo's session-chat source: 13px quiet words after a 14px mark, 6 apart, at the
 * end of the column 6 over the bubble, clearer under the pointer or in focus.
 */
.chat-source {
  display: flex;
  align-items: center;
  gap: 6px;
  width: max-content;
  max-width: 78%;
  margin-block-end: 6px;
  margin-inline-start: auto;
  padding: 0;
  color: color-mix(in srgb, var(--text-strong) 40%, transparent);
  background: none;
  border: 0;
  font-size: calc(13px * var(--ui-font-scale, 1));
  text-align: start;
  overflow-wrap: anywhere;
  cursor: pointer;
}

.chat-source svg {
  flex: none;
}

.automation-source {
  cursor: default;
}

.chat-source:not(.automation-source):hover,
.chat-source:focus-visible {
  color: color-mix(in srgb, var(--text-strong) 95%, transparent);
  outline: none;
}
</style>
