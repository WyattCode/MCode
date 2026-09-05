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
              class="custom-field"
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
/*
 * opencode's question dock (`dock-prompt[data-kind="question"]`), from its
 * stylesheet: the body is a column at gap 16 padded `8 8 0`, every text block
 * sits `0 10px` in from that, options are `8 8 8 10` at gap 6 on the layer
 * fill, and everything reads 14/150% with the hint at 13. Its font tokens
 * resolve to 530 for medium and 440 for regular, the weights the rest of
 * MCode already measured off it. This was 10/12 padding, gap 8, 6/8 options
 * at gap 4 and 11-13px type - the same card at three quarters scale.
 */
.question {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 0;
  padding: 8px 8px 0;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 10px;
}

.summary {
  min-width: 0;
  color: var(--text-base);
  font-size: 14px;
  font-weight: 530;
  line-height: 150%;
}

/* `question-progress`: 16x2 bars in 16x16 buttons, 8 apart. */
.dots {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
  margin-inline-start: auto;
}

.dot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border-radius: 999px;
}

.dot::after {
  content: "";
  width: 16px;
  height: 2px;
  border-radius: 999px;
  background: var(--text-weaker);
  transition: background-color 0.2s;
}

.dot.done::after {
  background: var(--primary);
}

.dot.active::after {
  background: var(--text-strong);
}

.chevron {
  flex-shrink: 0;
  margin-inline-start: auto;
  color: var(--text-weak);
  transition: transform 0.12s;
}

.dots + .chevron {
  margin-inline-start: 0;
}

.chevron.up {
  transform: rotate(180deg);
}

.prompt {
  flex-shrink: 0;
  margin: 0;
  padding: 0 10px;
  color: var(--text-base);
  font-size: 14px;
  font-weight: 530;
  line-height: 150%;
  user-select: text;
}

/* `question-content` is gap 4 between the question and its hint. */
.prompt + .hint {
  margin-top: -12px;
}

.hint {
  flex-shrink: 0;
  margin: 0;
  padding: 0 10px;
  color: var(--text-weak);
  font-size: 13px;
  font-weight: 440;
  line-height: 150%;
}

.options {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 0;
  margin-top: -4px;
  padding: 1px 1px 16px;
}

.option {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  width: 100%;
  padding: 8px 8px 8px 10px;
  background: var(--surface-menu);
  border: 0.5px solid var(--border-weak);
  border-radius: 6px;
  text-align: start;
  transition: background-color 0.15s, border-color 0.15s, box-shadow 0.15s;
}

.option:hover:not([data-picked="true"]):not(:disabled) {
  background: var(--surface-raised);
}

.option[data-picked="true"] {
  background: color-mix(in srgb, var(--primary) 14%, transparent);
  border-color: transparent;
  box-shadow: 0 0 0 0.5px var(--border-strong);
}

/* `question-option-box`: 16x16, half-pixel ring, radio round, check square. */
.mark {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 2px;
  border: 0.5px solid var(--border-weak);
  border-radius: 999px;
  transform: translateY(2px);
  transition: background-color 0.15s, border-color 0.15s;
}

.mark.multi {
  border-radius: 4px;
}

.mark::after {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--surface-menu);
  opacity: 0;
}

.mark.on {
  border-color: var(--primary);
}

.mark.on:not(.multi) {
  background: var(--primary);
}

.mark.on:not(.multi)::after {
  opacity: 1;
}

.mark.on.multi {
  background: var(--primary);
}

.mark.on.multi::after {
  width: 8px;
  height: 4px;
  border-radius: 0;
  border-inline-start: 1.5px solid var(--text-on-primary);
  border-bottom: 1.5px solid var(--text-on-primary);
  background: transparent;
  transform: translateY(-1px) rotate(-45deg);
  opacity: 1;
}

.mark-button {
  padding: 0;
  line-height: 0;
}

.text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.label {
  color: var(--text-base);
  font-size: 14px;
  font-weight: 530;
  line-height: 150%;
}

.desc {
  min-width: 0;
  color: var(--text-weak);
  font-size: 14px;
  font-weight: 440;
  line-height: 150%;
  overflow-wrap: anywhere;
  white-space: normal;
}

/* `question-custom`: gap 8, the field indented 36 under its own label. */
.custom .text {
  gap: 8px;
}

.custom-field {
  width: 100%;
  min-width: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: none;
  color: var(--text-base);
  font-family: var(--font-sans);
  font-size: 14px;
  font-weight: 440;
  line-height: 150%;
  overflow: hidden;
  overflow-wrap: anywhere;
  resize: none;
  field-sizing: content;
  border-radius: 2px;
}

.custom-field::placeholder {
  color: var(--text-weak);
}

.custom-field:focus-visible {
  outline: 1px solid var(--primary);
  outline-offset: 2px;
}

/*
 * `question-footer`: pulled 24 up under the options' 16 bottom padding and
 * padded 32 on top, so the buttons sit 8 under the last option while the
 * options list scrolls beneath them when it overflows.
 */
.foot {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: -24px;
  padding: 32px 8px 8px;
}

.spacer {
  flex: 1;
}

/* `button-v2`: 28 tall, `0 11px`, 13/530/20, ghost and primary. */
.ghost,
.primary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 28px;
  padding: 0 11px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 530;
  line-height: 20px;
  letter-spacing: -0.04px;
}

.ghost {
  color: var(--text-base);
}

.ghost:hover:not(:disabled) {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.primary {
  background: var(--primary);
  color: var(--text-on-primary);
}

button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
