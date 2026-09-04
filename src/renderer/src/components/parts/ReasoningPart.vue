<script setup lang="ts">
import { computed, ref } from "vue"
import type { ReasoningPart } from "@shared/protocol"
import { useApp } from "../../stores/app"
import { t } from "../../lib/i18n"

/**
 * The model's own note about what it is about to do.
 *
 * Shown as a plain grey line rather than a collapsible "thought for 5s" strip:
 * the summary is a sentence worth reading, and a row of identical toggles
 * between every tool call turned the transcript into scaffolding.
 */
const props = defineProps<{ part: ReasoningPart }>()
const app = useApp()

/*
 * Off unless asked for.
 *
 * The setting was already doing most of its job: the backend passes it to the
 * provider, which is what decides whether the model is asked for reasoning
 * summaries at all ("summarized" against "omitted"). What it did not reach was
 * this - so parts that had already arrived went on being drawn after it was
 * switched off, and a session begun with it on kept showing them for its whole
 * length. The reference draws none of this: while a turn runs it says
 * "thinking", and when the turn is done that line goes away.
 */
const shown = computed(() => app.config?.showReasoning === true)

const LIMIT = 160

const full = computed(() => props.part.text.trim())

/** Summaries arrive as prose; only the first line belongs on one row. */
const line = computed(() => {
  const text = full.value
  if (!text) return undefined
  const [first] = text.split("\n")
  return first.length > LIMIT ? `${first.slice(0, LIMIT)}...` : first
})

/**
 * Whether anything is being held back.
 *
 * Models differ: one opens each step with a short header that fits on the line,
 * another writes three paragraphs. The first needs no affordance at all - which
 * is why there is none unless there is something behind it.
 */
const more = computed(() => {
  const text = full.value
  if (!text || !line.value) return false
  return text.length > line.value.length || text.includes("\n")
})

const open = ref(false)
</script>

<template>
  <!--
    Nothing at all until there is something to read.
    The model opens every step with an empty reasoning part, so a placeholder
    here appeared and vanished on every single tool call - a flicker under the
    summary line that said nothing the progress bar was not already saying.
  -->
  <div v-if="shown && line" class="reasoning" :class="{ open }">
    <button v-if="more" class="text more" :title="t('stream.reasoningMore')" @click="open = !open">
      <span>{{ open ? full : line }}</span>
      <svg class="caret" :class="{ up: open }" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path d="M2.4 3.8 5 6.4l2.6-2.6" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" />
      </svg>
    </button>
    <span v-else class="text">{{ line }}</span>
  </div>
</template>

<style scoped>
.reasoning {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 10px 0 6px;
  color: var(--text-base);
  font-size: 13px;
  line-height: 1.3;
}

/* Expanded it is a paragraph, so it stops pretending to be a row. */
.reasoning.open {
  align-items: flex-start;
}

.text {
  text-align: start;
}

.more {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  color: inherit;
  font: inherit;
  text-align: start;
}

.more:hover {
  color: var(--text-strong);
}

.reasoning.open .more span {
  white-space: pre-wrap;
}

.caret {
  flex-shrink: 0;
  opacity: 0.7;
  transition: transform 0.12s;
}

.caret.up {
  transform: rotate(180deg);
}
</style>
