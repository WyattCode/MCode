<script setup lang="ts">
import { computed, ref, watch } from "vue"
import type { AssistantPart } from "@shared/protocol"
import ToolPart from "./ToolPart.vue"
import ReasoningPart from "./ReasoningPart.vue"
import AnimatedNumber from "./AnimatedNumber.vue"
import StatusLabel from "./StatusLabel.vue"
import { t } from "../../lib/i18n"
import { stepsEpoch, stepsOpen } from "../../lib/steps"

/**
 * A run of finished tool calls, shown as one line.
 *
 * A transcript that gives every call its own card turns a normal piece of work
 * into a wall of near-identical boxes, and the model's own words get lost
 * between them. What matters at a glance is that it looked at some things and
 * what it concluded - so the calls collapse into a count and open on demand.
 */
const props = defineProps<{ parts: AssistantPart[] }>()

/*
 * Starts where the steps command left things, and follows it when it runs
 * again - but a group opened by hand stays open, because the command sets a
 * starting point rather than holding every group to one.
 */
const open = ref(stepsOpen.value)
watch(stepsEpoch, () => {
  open.value = stepsOpen.value
})

/** Buckets that read naturally in a sentence, rather than raw tool names. */
const BUCKETS: Record<string, string> = {
  read: "read",
  glob: "search",
  grep: "search",
  list: "search",
  bash: "run",
  edit: "edit",
  write: "edit",
  webfetch: "fetch",
  todowrite: "plan",
}

const counts = computed(() => {
  const tally = new Map<string, number>()
  for (const part of props.parts) {
    if (part.type !== "tool") continue
    const bucket = BUCKETS[part.name] ?? "run"
    tally.set(bucket, (tally.get(bucket) ?? 0) + 1)
  }
  return [...tally.entries()]
})

const running = computed(() =>
  props.parts.some((part) => part.type === "tool" && part.status === "running"),
)

/** "Explored" only fits looking around; anything that acted needs a plainer verb. */
const looking = computed(() =>
  counts.value.every(([bucket]) => bucket === "read" || bucket === "search"),
)

/** What the line says while it is working, and what it settles into. */
const runningVerb = computed(() => (looking.value ? t("stream.exploring") : t("stream.running")))
const doneVerb = computed(() => (looking.value ? t("stream.explored") : t("stream.ran")))

/** The one actually on screen, for the line's own accessible text. */
const verb = computed(() => (running.value ? runningVerb.value : doneVerb.value))

/**
 * The counts, split around the number so it can roll.
 *
 * The phrasing differs per language - "3 reads" against "3 次读取" - so the
 * number's place in the sentence is found by rendering the string with a
 * marker in it rather than by assuming it comes first.
 */
const MARK = "\u0000"

const countParts = computed(() =>
  counts.value.map(([bucket, n]) => {
    const [before, after] = t(`stream.count.${bucket}`, { n: MARK }).split(MARK)
    return { bucket, n, before, after: after ?? "" }
  }),
)

const join = computed(() => t("stream.countJoin"))

const summary = computed(() =>
  counts.value.map(([bucket, n]) => t(`stream.count.${bucket}`, { n })).join(t("stream.countJoin")),
)
</script>

<template>
  <div class="group">
    <button class="line" @click="open = !open">
      <span class="verb" :class="{ live: running }">
        <StatusLabel :active-text="runningVerb" :done-text="doneVerb" :active="running" />
      </span>
      <span class="a11y-only">{{ summary }}</span>
      <span class="counts" aria-hidden="true">
        <template v-for="(part, at) in countParts" :key="part.bucket">
          <span v-if="at > 0" aria-hidden="true">{{ join }}</span>
          <span aria-hidden="true">{{ part.before }}</span>
          <AnimatedNumber :value="part.n" aria-hidden="true" />
          <span aria-hidden="true">{{ part.after }}</span>
        </template>
      </span>
      <!-- Trailing, so this line starts at the same edge as the rows around it. -->
      <span class="grow" />
      <svg class="caret" :class="{ open }" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M5 6.5L8 9.5L11 6.5" stroke="currentColor" stroke-width="1" />
      </svg>
    </button>

    <div v-if="open" class="items">
      <template v-for="part in parts" :key="part.id">
        <ToolPart v-if="part.type === 'tool'" :part="part" />
        <ReasoningPart v-else-if="part.type === 'reasoning'" :part="part" />
      </template>
    </div>
  </div>
</template>

<style scoped>
.group {
  margin: 2px 0;
}

.line {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  color: var(--text-base);
  font-size: 14px;
  line-height: 21px;
}

.line:hover {
  color: var(--text-base);
}

/*
 * The whole summary line is one weight; only the colour separates the verb from
 * the counts trailing it. Measured on the running reference: both its
 * `tool-status-title` and its `tool-count-label` are 14px/500/21px. The counts
 * here had no weight of their own and inherited the interface's 440, so the
 * line read as two different types set beside each other.
 *
 * Five hundred rather than the interface's 530 because that is what the
 * reference sets its tool rows in.
 */
.verb {
  color: var(--text-strong);
  font-weight: 500;
}

.counts {
  font-weight: 500;
}

/* Still running: the whole line steps back rather than growing a spinner. */
.verb.live,
.verb.live ~ .counts {
  color: var(--text-weak);
}

/* Still working: the same line, quietly breathing. */
.verb.live {
  animation: breathe 1.4s ease-in-out infinite;
}

@keyframes breathe {
  50% {
    opacity: 0.55;
  }
}

.grow {
  flex: 1;
}

.caret {
  flex-shrink: 0;
  width: 24px;
  color: var(--text-weaker);
  transition: transform 0.14s, color 0.14s;
}

.line:hover .caret {
  color: var(--text-base);
}

/* Closed lies on its side; open faces the rows it reveals. */
.caret:not(.open) {
  transform: rotate(-90deg);
}

/*
 * Indented under the line that summarises it, so an opened group reads as
 * belonging to its heading rather than as a new run of rows.
 */
.items {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 4px 0 10px;
  padding-inline-start: 12px;
}
</style>
