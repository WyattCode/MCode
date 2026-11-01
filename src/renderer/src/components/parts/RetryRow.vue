<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue"
import StepIcon from "./StepIcon.vue"
import "./steps.css"
import { t } from "../../lib/i18n"

/**
 * MiMo's in-turn reconnecting row: 正在重新连接 2, the attempt alone in the dim
 * colour, then the separator and why it is retrying when the attempt says. The
 * reason is cut to the row's width with the whole of it on hover.
 *
 * N11-19: a wait the provider named may now be half an hour long, so the row
 * counts it down and offers to stop waiting. Without the countdown a turn sat
 * there with nothing but an attempt number for up to thirty minutes, and the
 * only way out was the composer's Stop, which is not where the reader is
 * looking.
 */
const props = defineProps<{ attempt: number; reason?: string; next?: number }>()
const emit = defineEmits<{ stop: [] }>()

const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined

function tick() {
  now.value = Date.now()
}

watch(
  () => props.next,
  (next) => {
    if (timer) clearInterval(timer)
    timer = undefined
    if (next === undefined) return
    tick()
    timer = setInterval(tick, 1000)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})

/** Seconds still to wait, never below zero; nothing when the wait is not known. */
const left = computed(() => (props.next === undefined ? undefined : Math.max(0, Math.round((props.next - now.value) / 1000))))

/**
 * The wait as MiMo writes a duration: seconds on their own under a minute,
 * m:ss above it. Not translated, the way the turn clock is not.
 */
const clock = computed(() => {
  const seconds = left.value
  if (seconds === undefined) return undefined
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
})

/* Only worth a countdown and a way out when there is a real wait left. */
const waiting = computed(() => (left.value ?? 0) >= 2)
</script>

<template>
  <div class="hstep" role="status" data-harness-retry>
    <span class="hs-ic tall mut"><StepIcon name="reconnect" /></span>
    <span class="hs-retry-label">
      <span>{{ t("harnessRow.reconnecting") }}</span>
      <span class="hs-retry-count" data-retry-attempt>{{ attempt }}</span>
      <template v-if="reason">
        <span class="hs-retry-dot" aria-hidden="true">·</span>
        <span class="hs-retry-reason" v-tip="reason" data-retry-reason>{{ reason }}</span>
      </template>
      <template v-if="waiting && clock">
        <span class="hs-retry-dot" aria-hidden="true">·</span>
        <span class="hs-retry-count" data-retry-countdown>{{ t("harnessRow.retryIn", { time: clock }) }}</span>
        <button type="button" class="hs-retry-stop" data-retry-stop @click="emit('stop')">{{ t("harnessRow.stopWaiting") }}</button>
      </template>
    </span>
  </div>
</template>

<style scoped>
.hs-retry-stop {
  margin-inline-start: 8px;
  border: 0;
  padding: 0;
  background: none;
  color: var(--accent);
  font-size: calc(13px * var(--ui-font-scale, 1));
  cursor: pointer;
}

.hs-retry-stop:hover {
  text-decoration: underline;
}

.hs-retry-stop:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: 1px;
}
</style>
