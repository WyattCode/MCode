<script setup lang="ts">
import { computed, ref } from "vue"
import type { QuestionPrompt, ToolPart } from "@shared/protocol"
import StepIcon from "./StepIcon.vue"
import StepCollapse from "./StepCollapse.vue"
import "./steps.css"
import { t } from "../../lib/i18n"
import { openPlan, planHeader, planOf, planOptionLabel, planQuestionText } from "../../lib/plan-question"
import { useApp } from "../../stores/app"

/**
 * A question call in the transcript, on its own row and never inside a group.
 *
 * Answered, MiMo draws a quiet box of each question over what was chosen, with
 * no heading. Dismissed or stopped, it draws 需要你确认 · 已取消, folded, with the
 * questions behind the chevron. While it is still waiting nothing is drawn
 * here: the question lives in the dock above the composer.
 */
const props = defineProps<{ part: ToolPart }>()

/*
 * plan: plan_exit carries no questions in its input - it writes its own - so
 * the card falls back to what the call recorded, which is what lets an
 * approved plan redraw itself after a reload.
 */
const asked = computed(() => {
  const raw = props.part.input?.questions ?? props.part.metadata?.questions
  return Array.isArray(raw) ? (raw as QuestionPrompt[]) : []
})

const app = useApp()

const answers = computed(() => {
  const stored = props.part.metadata?.answers
  return Array.isArray(stored) ? (stored as unknown[]) : []
})

const chosen = (index: number) => {
  const entry = answers.value[index]
  return Array.isArray(entry) ? entry.map((value) => String(value)).filter((value) => value.trim()) : []
}

const settled = computed(() => props.part.status === "completed" || props.part.status === "error")
/* Answered if anything at all was chosen; a stop, a dismissal or an empty reply is a cancel. */
const answered = computed(() => props.part.status === "completed" && asked.value.some((_, index) => chosen(index).length > 0))

function answerText(index: number) {
  const prompt = asked.value[index]
  const values = chosen(index).map((value) => (prompt ? planOptionLabel(prompt, value) : value))
  return values.length ? values.join("、") : t("question.notSelected")
}

const open = ref(false)
const animate = ref(false)

function toggle() {
  animate.value = true
  open.value = !open.value
}
</script>

<template>
  <div v-if="settled && answered" class="hs-q-card" data-answer-state="answered" :data-question-card="part.id">
    <div v-for="(entry, index) in asked" :key="index" class="hs-q">
      <div class="hs-q-text">{{ planQuestionText(entry) }}</div>
      <!-- plan: MiMo's 查看方案 under the question, which opens the plan file. -->
      <button
        v-if="planOf(entry)"
        type="button"
        class="hs-q-plan"
        data-question-plan
        :title="planOf(entry)"
        @click="openPlan(planOf(entry)!, app.current?.directory)"
      >
        {{ t("question.viewPlan") }}
      </button>
      <div class="hs-q-answer" data-question-answer>{{ answerText(index) }}</div>
    </div>
  </div>
  <div v-else-if="settled" class="hs-q-card hs-q-cancelled" data-answer-state="cancelled" :data-question-card="part.id">
    <button type="button" class="hs-q-head" :aria-expanded="open" data-question-head @click="toggle">
      <span class="hs-ic tall mut"><StepIcon name="question" :size="15" /></span>
      <span class="hs-q-need">{{ t("question.needConfirm") }}</span>
      <span class="hs-tag" data-question-tag><span class="hs-tag-dot" />{{ t("question.cancelled") }}</span>
      <span class="hs-q-grow" />
      <span v-if="asked.length > 1" class="hs-q-count" data-question-count>{{ t("question.count", { n: asked.length }) }}</span>
      <span class="hs-chev" :class="{ open }">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="m9 18 6-6-6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </span>
    </button>
    <StepCollapse :show="open" :animate="animate">
      <div class="hs-q-list">
        <div v-for="(entry, index) in asked" :key="index" class="hs-q-item">
          <div v-if="entry.header" class="hs-q-header">{{ planHeader(entry) }}</div>
          <div class="hs-q-text">{{ planQuestionText(entry) }}</div>
          <button
            v-if="planOf(entry)"
            type="button"
            class="hs-q-plan"
            data-question-plan
            :title="planOf(entry)"
            @click="openPlan(planOf(entry)!, app.current?.directory)"
          >
            {{ t("question.viewPlan") }}
          </button>
        </div>
      </div>
    </StepCollapse>
  </div>
</template>
