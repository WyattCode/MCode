<script setup lang="ts">
import { computed, onMounted, watch } from "vue"
import MessageStream from "../MessageStream.vue"
import Composer from "../Composer.vue"
import { useApp } from "../../stores/app"
import { useRightPanel } from "../../stores/right-panel"
import { SIDE_SCOPE } from "../../stores/annotations"
import { t } from "../../lib/i18n"

/**
 * MiMo's side chat tab: a conversation of its own beside the one in the
 * middle, with no header - the transcript, or a line saying what the tab is
 * for while it is empty, and a box at the foot.
 *
 * The tab stays mounted while another tab is on show or the panel is put away,
 * as MiMo's does, so its transcript, scroll place and following survive, and a
 * reply keeps streaming into it. Every tab keeps its own box, which speaks for
 * that tab's conversation by id; a tab with none yet makes it on the first
 * send, as MiMo's does, so an unused tab leaves no empty conversation behind.
 */
const props = defineProps<{ convoId?: string; parentID?: string; active: boolean }>()
const emit = defineEmits<{
  created: [convoId: string]
  "open-settings": [section?: "models"]
  connect: []
  shell: [command: string]
  terminal: []
}>()
const app = useApp()
const rp = useRightPanel()

const messages = computed(() => app.sideMessagesOf(props.convoId))

/* Shown: focus and load this tab's conversation, if it has one yet. */
async function take() {
  if (props.active && props.convoId) await app.showSide(props.convoId)
}

/* The box's first send in a tab with no conversation makes one; the message goes to it. */
async function createOnSend() {
  // Another chat tab's empty conversation is that tab's, not one to take up again.
  const taken = rp.tabs.flatMap((tab) => (tab.type === "chat" && tab.convoId ? [tab.convoId] : []))
  const id = props.parentID ? await app.openSide(props.parentID, taken) : undefined
  if (id) emit("created", id)
  return id
}

onMounted(() => {
  if (props.convoId) void app.loadSide(props.convoId)
  void take()
})
watch(
  () => props.active,
  (on) => {
    if (on) void take()
  },
)
</script>

<template>
  <!-- Annotations made in here go to this tab's box, not the main one. -->
  <div class="rp-chat" data-rp-chat :data-annotate-scope="convoId ?? SIDE_SCOPE">
    <div v-if="!messages.length" class="rp-chat-empty">{{ t("rp.chat.empty") }}</div>
    <MessageStream v-else class="rp-chat-stream" side :sideId="convoId" />
    <div class="rp-chat-dock">
      <Composer
        side
        :resizable="false"
        :sideId="convoId"
        :createSide="convoId ? undefined : createOnSend"
        @open-settings="emit('open-settings', $event)"
        @connect="emit('connect')"
        @shell="emit('shell', $event)"
        @terminal="emit('terminal')"
      />
    </div>
  </div>
</template>

<style scoped>
.rp-chat {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* MiMo's side-empty: 13px, dim (40% ink), centred, 30 from the top. */
.rp-chat-empty {
  flex: 1;
  padding: 30px 16px 0;
  color: color-mix(in srgb, var(--text-strong) 40%, transparent);
  font-size: calc(13px * var(--ui-font-scale, 1));
  text-align: center;
}

:root[data-theme="dark"] .rp-chat-empty {
  color: #777;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .rp-chat-empty {
    color: #777;
  }
}

.rp-chat-stream {
  flex: 1;
  min-height: 0;
}

/* MiMo's composer-wrap in a side chat: 28 each side, 6 below, at most 768 and centred. */
.rp-chat-dock {
  flex: none;
  box-sizing: border-box;
  width: 100%;
  max-width: 768px;
  margin-inline: auto;
  padding: 0 28px 6px;
}

/*
 * The transcript and the box were laid out for the middle of the window; in a
 * tab they take MiMo's 16px sides and leave the reading width to the panel.
 */
.rp-chat-stream :deep(.inner) {
  max-width: none;
  padding: 18px 16px 18px;
}
</style>
