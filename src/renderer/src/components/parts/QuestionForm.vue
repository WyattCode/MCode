<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue"
import type { QuestionRequest } from "@shared/protocol"
import { t } from "../../lib/i18n"
import { useQuestions } from "../../stores/questions"

/**
 * The form a `question` tool call puts on screen.
 *
 * A transcription of the reference's `SessionQuestionDock`
 * (main-8t-QUXax.js @4687200): one question at a time, a strip of numbered
 * dots to jump between them and to show which are answered, radio or checkbox
 * marks depending on `multiple`, a "Type your own answer" row with a free-text
 * field, and a footer of Dismiss / Back / (Next | Submit). Escape dismisses,
 * Cmd or Ctrl with Enter advances, and the arrow keys move between options.
 *
 * WHERE IT SITS IS THE ONE DELIBERATE DIFFERENCE. The reference docks this
 * above the composer, immediately before the permission prompt
 * (`Show when={controller.state.questionRequest()}` @4757888). Doing that here
 * means mounting a component in App.vue, which this parcel does not own, so
 * the form is drawn inside the tool card that raised it instead - which is
 * what the request's `tool: {messageID, callID}` field exists to make possible.
 * See the report: the dock placement is a one-line change in App.vue and this
 * component is written to be mounted either way.
 */
const props = defineProps<{ request: QuestionRequest }>()

const questions = useQuestions()

const total = computed(() => props.request.questions.length)
const tab = ref(0)
const current = computed(() => props.request.questions[tab.value])
const options = computed(() => current.value?.options ?? [])
const multiple = computed(() => current.value?.multiple === true)

/** Chosen labels, one array per question, in the order they were asked. */
const answers = ref<string[][]>([])
/** The text typed into the custom row, kept per question. */
const custom = ref<string[]>([])
/** Whether the custom row is the chosen answer, kept per question. */
const customOn = ref<boolean[]>([])
const editing = ref(false)
const minimized = ref(false)
const field = ref<HTMLTextAreaElement>()

const sending = computed(() => questions.busy(props.request.id))
const last = computed(() => tab.value >= total.value - 1)

/*
 * The reference always draws the custom row - its option count is
 * `options().length + 1` with nothing guarding it, and it never reads
 * `question.custom` at all. The flag is honoured here anyway, because it is in
 * the schema; the two can only differ for a value the tool's input schema
 * cannot produce, since `custom` is not a field the model is allowed to send.
 */
const allowCustom = computed(() => current.value?.custom !== false)

const summary = computed(() =>
  t("session.question.progress", { current: Math.min(tab.value + 1, total.value), total: total.value }),
)

function picked(label: string): boolean {
  return answers.value[tab.value]?.includes(label) ?? false
}

/** Whether a question has something to submit - a chosen label or typed text. */
function answered(index: number): boolean {
  if ((answers.value[index]?.length ?? 0) > 0) return true
  return customOn.value[index] === true && (custom.value[index] ?? "").trim().length > 0
}

function setAnswer(index: number, value: string[]): void {
  const next = [...answers.value]
  next[index] = value
  answers.value = next
}

function choose(label: string): void {
  if (sending.value) return
  if (multiple.value) {
    const currently = answers.value[tab.value] ?? []
    setAnswer(tab.value, currently.includes(label) ? currently.filter((item) => item !== label) : [...currently, label])
    editing.value = false
    return
  }
  setAnswer(tab.value, [label])
  const flags = [...customOn.value]
  flags[tab.value] = false
  customOn.value = flags
  editing.value = false
}

/**
 * Folds the typed text into the answers.
 *
 * The previous text has to come out as the new one goes in, or a reader who
 * types, ticks, retypes and ticks again submits both attempts. That is the
 * reference's `customUpdate`, and it is why the old value is filtered rather
 * than the array simply appended to.
 */
function commitCustom(selected = customOn.value[tab.value] === true): void {
  const previous = (custom.value[tab.value] ?? "").trim()
  const typed = (field.value?.value ?? custom.value[tab.value] ?? "").trim()
  const buffer = [...custom.value]
  buffer[tab.value] = field.value?.value ?? custom.value[tab.value] ?? ""
  custom.value = buffer
  if (!selected) return

  if (multiple.value) {
    const kept = (answers.value[tab.value] ?? []).filter((item) => item.trim() !== previous)
    setAnswer(tab.value, typed && !kept.some((item) => item.trim() === typed) ? [...kept, typed] : kept)
    return
  }
  setAnswer(tab.value, typed ? [typed] : [])
}

function toggleCustom(): void {
  if (sending.value) return
  const flags = [...customOn.value]
  if (!multiple.value) {
    flags[tab.value] = true
    customOn.value = flags
    editing.value = true
    commitCustom(true)
    void nextTick(() => field.value?.focus())
    return
  }
  const next = flags[tab.value] !== true
  flags[tab.value] = next
  customOn.value = flags
  if (next) {
    editing.value = true
    commitCustom(true)
    void nextTick(() => field.value?.focus())
    return
  }
  const typed = (custom.value[tab.value] ?? "").trim()
  if (typed) setAnswer(tab.value, (answers.value[tab.value] ?? []).filter((item) => item.trim() !== typed))
  editing.value = false
}

function jump(index: number): void {
  if (sending.value) return
  tab.value = index
  editing.value = false
}

function back(): void {
  if (sending.value || tab.value <= 0) return
  jump(tab.value - 1)
}

function submit(): void {
  if (sending.value) return
  void questions.reply(
    props.request.id,
    props.request.questions.map((_, index) => answers.value[index] ?? []),
  )
}

function next(): void {
  if (sending.value) return
  if (editing.value) commitCustom()
  if (last.value) {
    submit()
    return
  }
  jump(tab.value + 1)
}

function dismiss(): void {
  if (sending.value) return
  void questions.dismiss(props.request.id)
}

function onKey(event: KeyboardEvent): void {
  if (event.defaultPrevented) return
  if (event.key === "Escape") {
    event.preventDefault()
    dismiss()
    return
  }
  const modifier = (event.metaKey || event.ctrlKey) && !event.altKey
  if (modifier && event.key === "Enter") {
    if (event.repeat) return
    event.preventDefault()
    next()
  }
}

/*
 * A fresh request starts over. The same component instance is reused when one
 * question is answered and the model immediately asks another, and carrying
 * the previous answers across would pre-tick options nobody chose.
 */
watch(
  () => props.request.id,
  () => {
    tab.value = 0
    answers.value = []
    custom.value = []
    customOn.value = []
    editing.value = false
    minimized.value = false
  },
)
</script>

<template>
  <div class="question" @keydown="onKey">
    <div class="head">
      <span class="summary">{{ summary }}</span>
      <div v-if="total > 1" class="dots">
        <button
          v-for="(_, index) in request.questions"
          :key="index"
          type="button"
          class="dot"
          :class="{ active: index === tab, done: answered(index) }"
          :disabled="sending"
          :aria-label="t('ui.tool.questions.numbered', { number: index + 1 })"
          @click="jump(index)"
        />
      </div>
      <button
        type="button"
        class="chevron"
        :class="{ up: minimized }"
        :disabled="sending"
        :aria-label="t(minimized ? 'session.question.restore' : 'session.question.minimize')"
        @click="minimized = !minimized"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M5 6.5L8 9.5L11 6.5" stroke="currentColor" stroke-width="1" />
        </svg>
      </button>
    </div>

    <template v-if="!minimized">
      <p class="prompt">{{ current?.question }}</p>
      <p class="hint">{{ t(multiple ? "ui.question.multiHint" : "ui.question.singleHint") }}</p>

      <div class="options">
        <button
          v-for="option in options"
          :key="option.label"
          type="button"
          class="option"
          :role="multiple ? 'checkbox' : 'radio'"
          :aria-checked="picked(option.label)"
          :data-picked="picked(option.label)"
          :disabled="sending"
          @click="choose(option.label)"
        >
          <span class="mark" :class="{ multi: multiple, on: picked(option.label) }" aria-hidden="true" />
          <span class="text">
            <span class="label">{{ option.label }}</span>
            <span v-if="option.description" class="desc">{{ option.description }}</span>
          </span>
        </button>

        <div v-if="allowCustom" class="option custom" :data-picked="customOn[tab] === true">
          <button
            type="button"
            class="mark-button"
            :disabled="sending"
            :aria-label="t('ui.messagePart.option.typeOwnAnswer')"
            @click="toggleCustom"
          >
            <span class="mark" :class="{ multi: multiple, on: customOn[tab] === true }" aria-hidden="true" />
          </button>
          <span class="text">
            <span class="label">{{ t("ui.messagePart.option.typeOwnAnswer") }}</span>
            <textarea
              ref="field"
              rows="1"
              class="field"
              :value="custom[tab] ?? ''"
              :placeholder="t('ui.question.custom.placeholder')"
              :disabled="sending"
              @focus="editing = true"
              @input="commitCustom()"
              @blur="editing = false"
            />
          </span>
        </div>
      </div>
    </template>

    <div class="foot">
      <button type="button" class="ghost" :disabled="sending" @click="dismiss">
        {{ t("ui.common.dismiss") }}
      </button>
      <span class="spacer" />
      <button v-if="tab > 0" type="button" class="ghost" :disabled="sending" @click="back">
        {{ t("common.back") }}
      </button>
      <button type="button" class="primary" :disabled="sending" @click="next">
        {{ last ? t("common.submit") : t("ui.common.next") }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.question {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.summary {
  color: var(--text-weak);
  font-size: 11.5px;
}

.dots {
  display: flex;
  flex: 1;
  gap: 4px;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--border-weak);
}

.dot.done {
  background: var(--text-weak);
}

.dot.active {
  background: var(--interactive);
}

.chevron {
  margin-inline-start: auto;
  color: var(--text-weaker);
  transition: transform 0.12s;
}

.chevron.up {
  transform: rotate(180deg);
}

.prompt {
  margin: 0;
  color: var(--text-strong);
  font-size: 13px;
  line-height: 1.5;
}

.hint {
  margin: 0;
  color: var(--text-weak);
  font-size: 11px;
}

.options {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.option {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  width: 100%;
  padding: 6px 8px;
  border: 0.5px solid var(--border-weak);
  border-radius: 6px;
  text-align: start;
}

.option[data-picked="true"] {
  border-color: var(--interactive);
}

.mark {
  flex-shrink: 0;
  width: 12px;
  height: 12px;
  margin-top: 3px;
  border: 1px solid var(--border-strong);
  border-radius: 50%;
}

.mark.multi {
  border-radius: 3px;
}

.mark.on {
  border-color: var(--interactive);
  background: var(--interactive);
}

.mark-button {
  padding: 0;
}

.text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.label {
  color: var(--text-strong);
  font-size: 12.5px;
}

.desc {
  color: var(--text-weak);
  font-size: 11px;
  line-height: 1.4;
}

/*
 * Grows with what is typed rather than scrolling inside two lines: an answer
 * the reader cannot see all of is one they cannot check before sending.
 */
.field {
  width: 100%;
  padding: 2px 0;
  border: none;
  background: transparent;
  color: var(--text-base);
  font: inherit;
  font-size: 12px;
  resize: none;
  field-sizing: content;
}

.field:focus {
  outline: none;
}

.foot {
  display: flex;
  align-items: center;
  gap: 8px;
}

.spacer {
  flex: 1;
}

.ghost,
.primary {
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 12px;
}

.ghost {
  color: var(--text-weak);
}

.ghost:hover:not(:disabled) {
  color: var(--text-base);
}

.primary {
  background: var(--interactive);
  color: var(--text-on-primary);
}

button:disabled {
  opacity: 0.5;
}
</style>
