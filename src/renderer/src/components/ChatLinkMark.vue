<script setup lang="ts">
/**
 * session chat: MiMo's mark before a conversation's title while it is messaging
 * another one - a dot rippling out while it waits for a reply, a small solid dot
 * while it handles a message or a reply - named for a screen reader by the words
 * of every message in flight.
 */
import type { ChatLink } from "@shared/protocol"
import { computed } from "vue"
import { chatLinkText, sortedChatLinks } from "../lib/convo-card"

const props = defineProps<{ links: ChatLink[] }>()

const sorted = computed(() => sortedChatLinks(props.links))
// Waiting on someone outranks being waited on, as MiMo draws it.
const direction = computed(() => (props.links.some((link) => link.direction === "outbound") ? "outbound" : "inbound"))
const label = computed(() => sorted.value.map(chatLinkText).join("; "))
const peer = computed(() => (sorted.value.find((link) => link.peerID) ?? sorted.value[0])?.peerID ?? undefined)
</script>

<template>
  <span
    class="chat-link"
    role="img"
    :aria-label="label"
    data-chat-link
    :data-chatlink-count="links.length"
    :data-chatlink-direction="direction"
    :data-chatlink-peer="peer"
  >
    <template v-if="direction === 'outbound'">
      <span class="chat-link-ripple" aria-hidden="true" />
      <span class="chat-link-halo" aria-hidden="true" />
      <span class="chat-link-dot" aria-hidden="true" />
    </template>
    <span v-else class="chat-link-dot inbound" aria-hidden="true" />
  </span>
</template>

<style scoped>
/* A 12px square, 4 before the title: the row's own 6px gap, less 2. */
.chat-link {
  position: relative;
  display: grid;
  flex: none;
  place-items: center;
  width: 12px;
  height: 12px;
  margin-inline-end: -2px;
}

.chat-link-ripple,
.chat-link-halo {
  position: absolute;
  inset: 1px;
  background: currentColor;
  border-radius: 50%;
}

/* MiMo's 1.6s ripple: from 30% at full size out to nothing at 1.7 times. */
.chat-link-ripple {
  animation: chat-link-ripple 1.6s ease-out infinite;
}

.chat-link-halo {
  opacity: 0.25;
}

.chat-link-dot {
  position: relative;
  width: 6px;
  height: 6px;
  background: currentColor;
  border-radius: 50%;
}

.chat-link-dot.inbound {
  width: 5px;
  height: 5px;
}

@keyframes chat-link-ripple {
  0% {
    opacity: 0.3;
    transform: scale(1);
  }

  to {
    opacity: 0;
    transform: scale(1.7);
  }
}

/* MiMo drops the ripple when motion is reduced: the appearance setting first, then the system's. */
:root[data-motion="on"] .chat-link-ripple {
  display: none;
}

@media (prefers-reduced-motion: reduce) {
  :root:not([data-motion="off"]) .chat-link-ripple {
    display: none;
  }
}
</style>
