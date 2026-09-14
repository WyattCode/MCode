<script setup lang="ts">
import { onMounted } from "vue"
import MessageStream from "../MessageStream.vue"
import Composer from "../Composer.vue"
import { useApp } from "../../stores/app"
import { t } from "../../lib/i18n"

/**
 * MiMo's side chat tab: a conversation of its own beside the one in the
 * middle, with no header - the transcript, or a line saying what the tab is
 * for while it is empty, and a box at the foot.
 *
 * The conversation is the tab's: made (or an empty one taken up again) the
 * first time the tab is shown, and shown again each time the tab comes back.
 * The stream and the box read the store's side conversation, so only the tab
 * on show is mounted.
 */
const props = defineProps<{ convoId?: string; parentID?: string }>()
const emit = defineEmits<{
  created: [convoId: string]
  "open-settings": [section?: "models"]
  connect: []
  shell: [command: string]
  terminal: []
}>()
const app = useApp()

onMounted(async () => {
  if (props.convoId) {
    await app.showSide(props.convoId)
    return
  }
  if (!props.parentID) return
  const id = await app.openSide(props.parentID)
  if (id) emit("created", id)
})
</script>

<template>
  <div class="rp-chat" data-rp-chat>
    <div v-if="!app.sideMessages.length" class="rp-chat-empty">{{ t("rp.chat.empty") }}</div>
    <MessageStream v-else class="rp-chat-stream" side />
    <div class="rp-chat-dock">
      <Composer
        side
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

/* MiMo's empty line: 13px, dim, centred, 30 from the top. */
.rp-chat-empty {
  flex: 1;
  padding: 30px 16px 0;
  color: var(--text-weaker);
  font-size: calc(13px * var(--ui-font-scale, 1));
  text-align: center;
}

.rp-chat-stream {
  flex: 1;
  min-height: 0;
}

.rp-chat-dock {
  flex: none;
  padding: 0 8px 10px;
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
