<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import MessageStream from "../MessageStream.vue"
import PaneBoundary from "./PaneBoundary.vue"
import { useApp } from "../../stores/app"
import { t } from "../../lib/i18n"

/**
 * MiMo's floating chat, over the foot of an expanded right panel.
 *
 * With the panel taking the conversation's room, the conversation is folded
 * down to what is still needed of it: the box to write in, and above it the
 * latest reply - a pill that says whether one is being written or is there to
 * read, and that opens into a card of the reply itself, drawn by the same turn
 * view as the transcript (head, steps, answer, error card) without its actions.
 *
 * The box is the app's own composer, moved in here while the panel is expanded
 * (App.vue sends it to `#float-dock`, which is why the dock is always in the
 * page). How tall all of this stands is told to the panel as `--fc-h`, so what
 * scrolls beneath can keep clear of it. Under a modal the whole overlay goes
 * inert; while the search overlay is open the box dims and takes no clicks.
 */
const props = defineProps<{ shown: boolean; covered?: boolean; searching?: boolean }>()
const app = useApp()

const collapsed = ref(true)
const running = computed(() => app.busy)
const hasReply = computed(() => running.value || app.visible.some((message) => message.role === "assistant"))

const root = ref<HTMLElement>()
const body = ref<HTMLElement>()
const content = ref<HTMLElement>()
let stuck = true

/* MiMo's scrollStick: the card follows the reply while within 64px of its end. */
const STICK_DISTANCE = 64

const heightObserver = new ResizeObserver(() => publishHeight())
const contentObserver = new ResizeObserver(() => {
  if (stuck && body.value) body.value.scrollTop = body.value.scrollHeight
})

function publishHeight() {
  const panel = root.value?.closest<HTMLElement>(".right-panel")
  if (!panel || !root.value) return
  panel.style.setProperty("--fc-h", `${Math.ceil(root.value.getBoundingClientRect().height)}px`)
}

function onBodyScroll() {
  const box = body.value
  if (box) stuck = box.scrollHeight - box.scrollTop - box.clientHeight <= STICK_DISTANCE
}

onMounted(() => {
  if (root.value) heightObserver.observe(root.value)
  publishHeight()
})

watch([collapsed, () => props.shown, hasReply], async () => {
  await nextTick()
  contentObserver.disconnect()
  if (content.value) contentObserver.observe(content.value)
  stuck = true
  if (body.value) body.value.scrollTop = body.value.scrollHeight
  publishHeight()
})

onBeforeUnmount(() => {
  heightObserver.disconnect()
  contentObserver.disconnect()
  root.value?.closest<HTMLElement>(".right-panel")?.style.removeProperty("--fc-h")
})
</script>

<template>
  <div
    v-show="shown"
    ref="root"
    class="fc-overlay"
    data-floating-chat
    :inert="Boolean(covered)"
    :aria-hidden="covered || undefined"
  >
    <div v-if="shown && hasReply && !collapsed" class="fc-win">
      <div class="fc-win-head">
        <span class="fc-label">{{ t(running ? "rp.floatingChat.generating" : "rp.floatingChat.latestReply") }}</span>
        <button type="button" class="fc-collapse" data-fc-collapse :title="t('rp.floatingChat.collapse')" :aria-label="t('rp.floatingChat.collapse')" @click="collapsed = true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
        </button>
      </div>
      <div ref="body" class="fc-win-body" @scroll.passive="onBodyScroll">
        <div ref="content" class="fc-content">
          <PaneBoundary reset-key="floating-chat">
            <MessageStream latest class="fc-stream" />
          </PaneBoundary>
        </div>
      </div>
    </div>
    <button v-if="shown && hasReply && collapsed" type="button" class="fc-strip" data-fc-expand @click="collapsed = false">
      <span v-if="running" class="fc-spin" aria-hidden="true" />
      <span>{{ t(running ? "rp.floatingChat.generating" : "rp.floatingChat.showOutput") }}</span>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 15l-6-6-6 6" /></svg>
    </button>
    <div id="float-dock" class="fc-dock" :class="{ searching }" :aria-hidden="searching || undefined" />
  </div>
</template>

<style scoped>
/* MiMo's overlay: across the panel's foot, 20 in and 14 up, letting clicks through except on its parts. */
.fc-overlay {
  position: absolute;
  inset-inline: 0;
  bottom: 0;
  z-index: 120;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 0 20px 14px;
  pointer-events: none;
}

/* The reply: at most 720 wide, 16 round, a line and a soft shadow. */
.fc-win {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 720px;
  min-height: 0;
  margin-bottom: 8px;
  overflow: hidden;
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 16px;
  box-shadow: 0 8px 28px rgb(0 0 0 / 0.14);
  pointer-events: auto;
}

.fc-win-head {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px 2px;
}

.fc-label {
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.fc-collapse {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  color: var(--text-weak);
  background: transparent;
  border: 0;
  border-radius: 6px;
}

.fc-collapse:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

/* At most 38% of the window tall, following the reply as it grows. */
.fc-win-body {
  min-height: 0;
  max-height: 38vh;
  padding: 0 16px 12px;
  overflow-x: hidden;
  overflow-y: auto;
}

.fc-content {
  min-width: 0;
}

/* The turn view as the card's content: the card scrolls, not the stream, and the column is the card's. */
.fc-content :deep(.stream) {
  flex: none;
  overflow: visible;
  scrollbar-gutter: auto;
}

.fc-content :deep(.inner) {
  max-width: none;
  margin: 0;
  padding: 0;
}

/* The pill: 5 by 12, fully round, 12px muted, lifted. */
.fc-strip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  padding: 5px 12px;
  color: var(--text-weak);
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 999px;
  box-shadow: 0 4px 14px rgb(0 0 0 / 0.12);
  font-size: calc(12px * var(--ui-font-scale, 1));
  pointer-events: auto;
}

.fc-strip:hover {
  color: var(--text-strong);
}

.fc-spin {
  width: 12px;
  height: 12px;
  border: 1.5px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: fc-spin 0.8s linear infinite;
}

@keyframes fc-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .fc-spin {
    animation: none;
  }
}

/* The box, docked beneath: as wide as the reply, and the one part always under the pointer. */
.fc-dock {
  width: 100%;
  max-width: 720px;
  pointer-events: auto;
  transition: opacity 0.12s;
}

/* MiMo dims the docked box to .4 and lets it take no clicks while the search overlay is open. */
.fc-dock.searching {
  opacity: 0.4;
  pointer-events: none;
}
</style>
