<script setup lang="ts">
import { computed, h, ref, watch, type FunctionalComponent, type VNode } from "vue"
import type { QuestionRequest } from "@shared/protocol"
import StepIcon from "./StepIcon.vue"
import { t } from "../../lib/i18n"
import { useQuestions } from "../../stores/questions"
import { isAnswered, mergeCustom, nextStop, toggleChoice } from "../../lib/confirm-queue"

/**
 * A question put by the model, in the dock above the composer, as MiMo draws it.
 *
 * One page per question. A single-choice click moves on by itself; 跳过 and an
 * icon button carry the rest; the X gives up on the set by replying empty. The
 * dock around it owns focus and the keys - digits, arrows and Enter.
 */
const props = defineProps<{ request: QuestionRequest; queueTotal: number }>()
const emit = defineEmits<{ page: [] }>()

const questions = useQuestions()

const prompts = computed(() => props.request.questions)
const total = computed(() => prompts.value.length)
const page = ref(0)
const current = computed(() => prompts.value[page.value] ?? prompts.value[0]!)
const multiple = computed(() => current.value.multiple === true)
const last = computed(() => page.value === total.value - 1)
const allowCustom = computed(() => current.value.custom !== false)
const sending = computed(() => questions.busy(props.request.id))

/** Chosen labels, typed text and skip marks, one entry per question. */
const chosen = ref<string[][]>(prompts.value.map(() => []))
const custom = ref<string[]>(prompts.value.map(() => ""))
const skipped = ref<boolean[]>(prompts.value.map(() => false))

const doneList = (ch: string[][], cu: string[], sk: boolean[]) =>
  prompts.value.map((prompt, index) => sk[index] === true || isAnswered(prompt, ch[index], cu[index]))

const allDone = computed(() => doneList(chosen.value, custom.value, skipped.value).every(Boolean))
const answeredHere = computed(() => isAnswered(current.value, chosen.value[page.value], custom.value[page.value]))
const typed = computed(() => Boolean((custom.value[page.value] ?? "").trim()))

const title = computed(() => {
  if (total.value > 1) return t(multiple.value ? "questionDock.qMulti" : "questionDock.qSingle", { n: page.value + 1 })
  return t(multiple.value ? "questionDock.multi" : "questionDock.single")
})

function picked(label: string): boolean {
  return chosen.value[page.value]?.includes(label) ?? false
}

function submit(ch: string[][], cu: string[]): void {
  if (sending.value) return
  void questions.reply(props.request.id, mergeCustom(ch, cu))
}

/* Submit once everything is answered or skipped; otherwise the next page, then the first gap. */
function advance(ch: string[][], cu: string[], sk: boolean[]): void {
  const done = doneList(ch, cu, sk)
  if (done.every(Boolean)) {
    submit(ch, cu)
    return
  }
  const stop = nextStop(done, page.value)
  if (stop !== "submit") page.value = stop
}

function choose(label: string, event: MouseEvent): void {
  if (sending.value) return
  const next = chosen.value.map((entry) => entry.slice())
  next[page.value] = toggleChoice(next[page.value] ?? [], label, multiple.value)
  chosen.value = next
  if (multiple.value) {
    // A mouse click leaves no focus ring behind; a key press keeps its place.
    if (event.detail > 0) (event.currentTarget as HTMLElement | null)?.blur()
    return
  }
  if ((next[page.value]?.length ?? 0) > 0) advance(next, custom.value, skipped.value)
}

function skip(): void {
  if (sending.value) return
  const ch = chosen.value.map((entry, index) => (index === page.value ? [] : entry.slice()))
  const cu = custom.value.map((entry, index) => (index === page.value ? "" : entry))
  const sk = skipped.value.map((entry, index) => (index === page.value ? true : entry))
  chosen.value = ch
  custom.value = cu
  skipped.value = sk
  if (total.value === 1) {
    submit(ch, cu)
    return
  }
  if (page.value < total.value - 1) page.value += 1
}

function onCustom(event: Event): void {
  const field = event.target as HTMLTextAreaElement
  const value = field.value
  custom.value = custom.value.map((entry, index) => (index === page.value ? value : entry))
  // Typing a single-choice answer replaces the option picked for it.
  if (!multiple.value && value.trim()) {
    chosen.value = chosen.value.map((entry, index) => (index === page.value ? [] : entry))
  }
  field.style.height = "auto"
  field.style.height = `${field.scrollHeight}px`
}

function onCustomKey(event: KeyboardEvent): void {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  if (allDone.value) submit(chosen.value, custom.value)
  else if (answeredHere.value) advance(chosen.value, custom.value, skipped.value)
}

function dismiss(): void {
  if (sending.value) return
  void questions.dismiss(props.request)
}

// Each page change hands focus back to the dock, which decides whether to take it.
watch(page, () => emit("page"))

/*
 * The action buttons. They sit at the end of the custom row, or in a row of
 * their own when there is no custom row, so they are built once here.
 */
const ARROW_RIGHT = ["M5 12h14", "m12 5 7 7-7 7"]
const ARROW_UP = ["m5 12 7-7 7 7", "M12 19V5"]

const icon = (paths: string[], size: number, stroke: number, cls?: string): VNode =>
  h(
    "svg",
    { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": stroke, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: cls },
    paths.map((d) => h("path", { d })),
  )

const Actions: FunctionalComponent = () => {
  const skipButton = h(
    "button",
    { type: "button", class: "q-skip", "data-cnav": "", "data-confirm-skip": "", disabled: sending.value, onClick: skip },
    t("questionDock.skip"),
  )
  const label = allDone.value ? t("perm.submit") : t(last.value ? "questionDock.goFill" : "questionDock.next")
  const advanceButton = h(
    "button",
    {
      type: "button",
      class: ["q-advance", allDone.value ? "submit" : "next"],
      "data-cnav": "",
      "data-confirm-advance": "",
      title: label,
      "aria-label": label,
      disabled: sending.value,
      onClick: () => advance(chosen.value, custom.value, skipped.value),
    },
    [icon(allDone.value ? ARROW_UP : ARROW_RIGHT, 17, 2.6)],
  )
  const ready = answeredHere.value || allDone.value
  if (multiple.value) return ready ? [skipButton, advanceButton] : [skipButton]
  return [ready ? advanceButton : skipButton]
}
</script>

<template>
  <div class="confirm-question" data-confirm-question>
    <div class="q-head">
      <span class="q-icon" aria-hidden="true"><StepIcon name="question" :size="15" /></span>
      <span class="q-title" data-confirm-qtitle>{{ title }}</span>
      <template v-if="current.header">
        <span class="q-dim">·</span>
        <span class="q-header" data-confirm-qheader :title="current.header">{{ current.header }}</span>
      </template>
      <span class="q-right">
        <span v-if="queueTotal > 1" class="q-queue" data-confirm-queue :title="t('perm.queueTitle', { total: queueTotal })">
          1/{{ queueTotal }}
        </span>
        <span v-if="total > 1" class="q-pager" data-confirm-pager>
          <button
            type="button"
            class="q-page"
            data-confirm-pager-prev
            :disabled="page === 0"
            :title="t('questionDock.prevQ')"
            :aria-label="t('questionDock.prevQ')"
            @click="page -= 1"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
          <span class="q-count">{{ page + 1 }} / {{ total }}</span>
          <button
            type="button"
            class="q-page"
            data-confirm-pager-next
            :disabled="last"
            :title="t('questionDock.next')"
            :aria-label="t('questionDock.next')"
            @click="page += 1"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m9 18 6-6-6-6" />
            </svg>
          </button>
        </span>
        <button
          type="button"
          class="q-dismiss"
          data-confirm-dismiss
          :disabled="sending"
          :title="t('questionDock.dismissTitle')"
          :aria-label="t('questionDock.dismissTitle')"
          @click="dismiss"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      </span>
    </div>

    <div :key="page" class="confirm-q-body" data-confirm-qbody>
      <div class="q-text" data-confirm-qtext>{{ current.question }}</div>
      <div class="q-opts" data-confirm-opts :role="multiple ? 'group' : 'radiogroup'" :aria-label="current.question">
        <template v-for="(option, index) in current.options" :key="index">
          <div v-if="index > 0" class="q-sep" aria-hidden="true" />
          <button
            type="button"
            class="q-opt"
            :class="{ on: picked(option.label) }"
            data-cnav
            :data-confirm-optkey="index < 9 ? index + 1 : undefined"
            :disabled="(!multiple && typed) || sending"
            :role="multiple ? 'checkbox' : 'radio'"
            :aria-checked="picked(option.label)"
            :title="option.description || undefined"
            @click="choose(option.label, $event)"
          >
            <span v-if="multiple" class="q-check" :class="{ on: picked(option.label) }" aria-hidden="true">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </span>
            <span v-else class="q-num" :class="{ on: picked(option.label) }" aria-hidden="true">{{ index + 1 }}</span>
            <span class="q-label-col">
              <span class="q-label">{{ option.label }}</span>
              <span v-if="option.description" class="q-desc" data-confirm-optdesc>{{ option.description }}</span>
            </span>
            <span class="q-end" aria-hidden="true">
              <template v-if="!multiple">
                <svg v-if="picked(option.label)" class="q-mark" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                <svg v-else class="q-ret" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M5 12h14" />
                  <path d="m12 5 7 7-7 7" />
                </svg>
              </template>
            </span>
          </button>
        </template>

        <template v-if="allowCustom">
          <div v-if="current.options.length > 0" class="q-sep" aria-hidden="true" />
          <div class="q-custom" data-confirm-custom>
            <span v-if="multiple" role="checkbox" :aria-checked="typed" class="q-check" :class="{ on: typed }" data-confirm-custom-check>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </span>
            <span v-else class="q-pencil" aria-hidden="true">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
                <path d="m15 5 4 4" />
              </svg>
            </span>
            <textarea
              rows="1"
              class="q-field"
              data-confirm-custom-input
              :value="custom[page] ?? ''"
              :placeholder="t('questionDock.customPlaceholder')"
              :disabled="sending"
              @input="onCustom"
              @keydown="onCustomKey"
            />
            <span class="q-actions"><Actions /></span>
          </div>
        </template>
      </div>
    </div>

    <div v-if="!allowCustom" class="q-actions q-actions-row"><Actions /></div>
    <!-- Enter's target once every question is answered; out of sight and out of the tab order. -->
    <button
      v-if="allDone"
      type="button"
      class="q-primary"
      data-cnav-primary
      aria-hidden="true"
      tabindex="-1"
      @click="submit(chosen, custom)"
    />
  </div>
</template>

<style scoped>
.confirm-question {
  min-width: 0;
}

.q-head {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-base);
  font-size: calc(14px * var(--ui-font-scale, 1));
  line-height: 1.5;
}

.q-icon {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 16px;
  color: #909091;
}

.q-title {
  flex: none;
  font-weight: 500;
}

.q-dim {
  flex: none;
  color: #919191;
}

.q-header {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-weight: 500;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.q-right {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  margin-inline-start: auto;
}

.q-queue {
  color: #919191;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.q-pager {
  display: flex;
  align-items: center;
  gap: 4px;
  color: #919191;
  font-size: calc(14px * var(--ui-font-scale, 1));
}

.q-count {
  font-variant-numeric: tabular-nums;
}

.q-page,
.q-dismiss {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  padding: 0;
  color: #909091;
  background: transparent;
  border: 0;
  cursor: pointer;
}

.q-page {
  width: 26px;
  height: 26px;
  border-radius: 7px;
}

.q-dismiss {
  width: 20px;
  height: 20px;
  border-radius: 6px;
}

.q-page:hover,
.q-dismiss:hover {
  color: var(--text-base);
  background: #f8f7f5;
}

.q-page:disabled,
.q-dismiss:disabled {
  cursor: default;
  opacity: 0.35;
}

.confirm-q-body {
  margin-top: 6px;
  animation: confirm-q-in 0.18s ease;
}

@keyframes confirm-q-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.q-text {
  color: var(--text-base);
  font-size: calc(14px * var(--ui-font-scale, 1));
  line-height: 1.5;
  overflow-wrap: anywhere;
  user-select: text;
}

.q-opts {
  display: flex;
  flex-direction: column;
  margin-top: 6px;
}

.q-sep {
  flex: none;
  height: 1px;
  margin-inline: 12px;
  background: #f5f5f5;
}

.q-opt {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 7px 12px;
  color: var(--text-strong);
  font-size: calc(14px * var(--ui-font-scale, 1));
  line-height: 1.5;
  text-align: start;
  background: transparent;
  border: 0;
  border-radius: 9px;
  outline: none;
  cursor: pointer;
  transition: background-color 0.15s;
}

.q-opt:hover,
.q-opt:focus-visible {
  background: #f1f0ec;
}

.q-opt.on {
  font-weight: 500;
  background: #eeedec;
}

.q-opt:disabled {
  opacity: 0.4;
  pointer-events: none;
}

.q-num,
.q-check {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  background: #f8f7f5;
  border: 1px solid #f0ebe5;
  transition: background-color 0.15s, border-color 0.15s, color 0.15s;
}

.q-num {
  width: 22px;
  height: 22px;
  color: #909091;
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  border-radius: 6px;
}

.q-opt:hover .q-num,
.q-opt:focus-visible .q-num {
  color: var(--text-strong);
}

.q-check {
  width: 20px;
  height: 20px;
  border-radius: 5px;
}

.q-check svg {
  opacity: 0;
}

.q-num.on,
.q-check.on {
  color: #ffffff;
  background: #151c13;
  border-color: #151c13;
}

.q-opt:hover .q-num.on {
  color: #ffffff;
}

.q-check.on svg {
  opacity: 1;
}

.q-label-col {
  flex: 1;
  min-width: 0;
}

.q-label {
  display: block;
}

.q-desc {
  display: block;
  margin-top: 1px;
  color: #909091;
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-weight: 400;
}

.q-end {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: flex-end;
  width: 24px;
  height: 26px;
}

.q-mark {
  color: #151c13;
}

.q-ret {
  color: #919191;
  opacity: 0;
  transition: opacity 0.15s;
}

.q-opt:hover .q-ret,
.q-opt:focus-visible .q-ret {
  opacity: 1;
}

.q-custom {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 7px 12px;
  border-radius: 9px;
  transition: background-color 0.15s;
}

.q-custom:has(textarea:focus) {
  background: #f1f0ec;
}

.q-pencil {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  color: #919191;
}

.q-field {
  flex: 1;
  min-width: 0;
  padding: 0;
  overflow: hidden;
  color: var(--text-strong);
  font-family: inherit;
  font-size: calc(14px * var(--ui-font-scale, 1));
  line-height: 22px;
  background: transparent;
  border: 0;
  outline: none;
  resize: none;
}

.q-field::placeholder {
  color: #919191;
}

.q-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
}

.q-actions-row {
  justify-content: flex-end;
  margin-top: 6px;
}

.q-actions :deep(.q-skip) {
  display: flex;
  flex: none;
  align-items: center;
  height: 30px;
  padding: 0 14px;
  color: var(--text-base);
  font-size: calc(13px * var(--ui-font-scale, 1));
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 9px;
  cursor: pointer;
}

.q-actions :deep(.q-skip:hover) {
  background: var(--surface-hover);
}

.q-actions :deep(.q-advance) {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 0;
  border-radius: 9px;
  cursor: pointer;
}

.q-actions :deep(.q-advance.next) {
  color: var(--surface-raised);
  background: var(--text-strong);
}

.q-actions :deep(.q-advance.next:hover) {
  opacity: 0.9;
}

/* Submitting is MiMo's accent, the one orange control in the dock. */
.q-actions :deep(.q-advance.submit) {
  color: #ffffff;
  background: #ff6a2b;
}

.q-actions :deep(.q-advance.submit:hover) {
  background: color-mix(in srgb, #ff6a2b 90%, transparent);
}

.q-actions :deep(button:disabled) {
  cursor: default;
  opacity: 0.4;
}

.q-actions :deep(button:focus-visible) {
  outline: 2px solid var(--border-selected);
  outline-offset: 1px;
}

.q-primary {
  position: absolute;
  width: 0;
  height: 0;
  padding: 0;
  overflow: hidden;
  border: 0;
  opacity: 0;
  pointer-events: none;
}

:root[data-theme="dark"] .q-icon, :root[data-theme="dark"] .q-desc {
  color: #b8b8b8;
}

:root[data-theme="dark"] .q-dim, :root[data-theme="dark"] .q-queue, :root[data-theme="dark"] .q-pager, :root[data-theme="dark"] .q-pencil, :root[data-theme="dark"] .q-ret {
  color: #777777;
}

:root[data-theme="dark"] .q-page, :root[data-theme="dark"] .q-dismiss, :root[data-theme="dark"] .q-num {
  color: #b8b8b8;
}

:root[data-theme="dark"] .q-page:hover, :root[data-theme="dark"] .q-dismiss:hover {
  background: #2e2e2e;
}

:root[data-theme="dark"] .q-sep {
  background: #2e2e2e;
}

:root[data-theme="dark"] .q-opt:hover, :root[data-theme="dark"] .q-opt:focus-visible, :root[data-theme="dark"] .q-custom:has(textarea:focus) {
  background: #ffffff0f;
}

:root[data-theme="dark"] .q-opt.on {
  background: #ffffff1a;
}

:root[data-theme="dark"] .q-num, :root[data-theme="dark"] .q-check {
  background: #2e2e2e;
  border-color: #2e2e2e;
}

:root[data-theme="dark"] .q-num.on, :root[data-theme="dark"] .q-check.on {
  color: #ffffff;
  background: #151c13;
  border-color: #151c13;
}

:root[data-theme="dark"] .q-mark {
  color: #ffffff;
}

:root[data-theme="dark"] .q-field::placeholder {
  color: #777777;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .q-icon, :root:not([data-theme="light"]) .q-desc {
    color: #b8b8b8;
  }

  :root:not([data-theme="light"]) .q-dim, :root:not([data-theme="light"]) .q-queue, :root:not([data-theme="light"]) .q-pager, :root:not([data-theme="light"]) .q-pencil, :root:not([data-theme="light"]) .q-ret {
    color: #777777;
  }

  :root:not([data-theme="light"]) .q-page, :root:not([data-theme="light"]) .q-dismiss, :root:not([data-theme="light"]) .q-num {
    color: #b8b8b8;
  }

  :root:not([data-theme="light"]) .q-page:hover, :root:not([data-theme="light"]) .q-dismiss:hover {
    background: #2e2e2e;
  }

  :root:not([data-theme="light"]) .q-sep {
    background: #2e2e2e;
  }

  :root:not([data-theme="light"]) .q-opt:hover, :root:not([data-theme="light"]) .q-opt:focus-visible, :root:not([data-theme="light"]) .q-custom:has(textarea:focus) {
    background: #ffffff0f;
  }

  :root:not([data-theme="light"]) .q-opt.on {
    background: #ffffff1a;
  }

  :root:not([data-theme="light"]) .q-num, :root:not([data-theme="light"]) .q-check {
    background: #2e2e2e;
    border-color: #2e2e2e;
  }

  :root:not([data-theme="light"]) .q-num.on, :root:not([data-theme="light"]) .q-check.on {
    color: #ffffff;
    background: #151c13;
    border-color: #151c13;
  }

  :root:not([data-theme="light"]) .q-mark {
    color: #ffffff;
  }

  :root:not([data-theme="light"]) .q-field::placeholder {
    color: #777777;
  }
}
</style>
