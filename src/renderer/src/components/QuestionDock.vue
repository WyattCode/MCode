<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue"
import PermissionDialog from "./PermissionDialog.vue"
import QuestionForm from "./parts/QuestionForm.vue"
import SubagentAvatar from "./parts/SubagentAvatar.vue"
import { useQuestions } from "../stores/questions"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"
import { announce, textOf } from "../lib/announce"

/**
 * MiMo's confirm dock, above the composer: the first undecided permission or
 * question for this session, in arrival order, with `1/N` counting both kinds.
 *
 * It owns the keyboard. The dock takes focus when a request arrives, unless
 * someone is part-way through writing in the composer. Arrow keys walk the
 * buttons, 1-9 pick an option, Enter gives the primary answer - but only once
 * the dock has really been engaged: focus borrowed from an empty composer goes
 * straight back on the first other key, so a person about to type loses
 * nothing and grants nothing. There is no Escape, as in MiMo.
 */
const questions = useQuestions()
const first = computed(() => questions.queue[0])
const total = computed(() => questions.queue.length)

/* subagents: a request a subagent raised names that subagent over the card. */
const app = useApp()
const asker = computed(() => {
  const request = first.value?.request
  if (!request || request.sessionID === app.currentID) return undefined
  const session = app.subagentSessions.find((entry) => entry.id === request.sessionID)
  if (!session) return undefined
  return { seed: session.subagent?.id ?? session.id, name: session.title || t("subagentActivity.fallbackName") }
})

const root = ref<HTMLElement>()
let engaged = false
let borrowedFrom: HTMLElement | null = null

function takeFocus() {
  const el = root.value
  if (!el) return
  const active = document.activeElement
  const field = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement
  if (field && active.value.length > 0) {
    engaged = false
    borrowedFrom = null
    return
  }
  engaged = !field
  borrowedFrom = field ? active : null
  el.focus()
}

function engage() {
  engaged = true
  borrowedFrom = null
}

function onDockKey(event: KeyboardEvent) {
  // A control inside the card that answered the key itself - a diff's file row or header - keeps it.
  if (event.defaultPrevented) return
  const target = event.target as HTMLElement
  if (target.tagName === "TEXTAREA" || target.tagName === "INPUT") return
  const el = root.value
  if (!el) return
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
    const buttons = [...el.querySelectorAll<HTMLButtonElement>("[data-cnav]")].filter((button) => !button.disabled)
    if (!buttons.length) return
    event.preventDefault()
    engage()
    const forward = event.key === "ArrowRight" || event.key === "ArrowDown"
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = at === -1 ? (forward ? 0 : buttons.length - 1) : (at + (forward ? 1 : -1) + buttons.length) % buttons.length
    buttons[next]!.focus()
    return
  }
  if (event.key === "Tab") {
    engage()
    return
  }
  if (!engaged && borrowedFrom) {
    const back = borrowedFrom
    borrowedFrom = null
    if (event.key === "Enter") event.preventDefault()
    if (back.isConnected) back.focus()
    return
  }
  if (/^[1-9]$/.test(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
    if (!engaged) return
    const option = el.querySelector<HTMLButtonElement>(`[data-confirm-optkey="${event.key}"]`)
    // A disabled option is not an answer: Enter already skips it, so digits must too.
    if (!option || option.disabled) return
    event.preventDefault()
    engage()
    option.click()
    return
  }
  if (event.key === "Enter" && !(document.activeElement instanceof HTMLButtonElement)) {
    event.preventDefault()
    if (!engaged) return
    el.querySelector<HTMLButtonElement>("[data-cnav-primary]:not([disabled])")?.click()
  }
}

/*
 * What the dock is called and what it describes, by the ids its cards give
 * their drawn title and subject. Only one card is drawn at a time.
 */
/*
 * Only ids that the drawn card actually mounts. A static list used to name
 * asker/chip even when those nodes were absent, which left the alertdialog
 * labelled by missing targets on Linux assistive tech.
 */
const labelledBy = computed(() => {
  const ids: string[] = []
  if (asker.value && !questions.guide) ids.push("confirm-dock-asker")
  ids.push("confirm-dock-title")
  return ids.join(" ")
})
const describedBy = computed(() => "confirm-dock-desc")

// A new request, or the guide giving way to its card, is taken up the same way.
watch(
  () => [first.value?.id, questions.guide] as const,
  ([id]) => {
    if (!id) return
    void nextTick(() => {
      takeFocus()
      /*
       * Beyond MiMo, whose dock is silent: the turn has stopped to wait, and
       * focus alone is not enough - it stays in a composer that holds a draft.
       */
      announce(textOf([...labelledBy.value.split(" ").filter(Boolean), describedBy.value]), "assertive")
    })
  },
  { immediate: true },
)
</script>

<template>
  <!--
    Anchored above the composer, in its column: the question is about the work
    still visible behind it, and a modal over the transcript would hide it.
  -->
  <div v-if="first" class="confirm-wrap">
    <div
      id="confirm-dock"
      ref="root"
      class="confirm-dock"
      data-confirm-dock
      tabindex="-1"
      role="alertdialog"
      :aria-labelledby="labelledBy"
      :aria-describedby="describedBy"
      @keydown="onDockKey"
      @pointerdown="engage"
    >
      <!-- subagents: which subagent is asking, when it is not the conversation itself. -->
      <div v-if="asker && !questions.guide" class="dock-subagent" data-dock-subagent>
        <SubagentAvatar :seed="asker.seed" compact />
        <span id="confirm-dock-asker" class="dock-subagent-name">{{ asker.name }}</span>
      </div>
      <!-- MiMo's guide, over a permission card after enough approvals by hand. No primary: Enter answers nothing here. -->
      <div v-if="questions.guide" :key="`guide-${first.id}`" class="perm-guide" data-perm-guide>
        <div class="guide-head">
          <span id="confirm-dock-title" class="guide-title" data-perm-guide-title>{{ t("perm.guide.title") }}</span>
          <span class="guide-count" data-perm-guide-count>{{ t("perm.guide.count", { n: questions.guideCount }) }}</span>
        </div>
        <p id="confirm-dock-desc" class="guide-body" data-perm-guide-body>{{ t("perm.guide.body") }}</p>
        <div class="guide-actions">
          <button type="button" class="guide-btn" data-cnav data-perm-guide-keep @click="questions.dismissGuide()">
            {{ t("perm.guide.keepManual") }}
          </button>
          <button type="button" class="guide-btn" data-cnav data-perm-guide-edits @click="questions.acceptEdits()">
            {{ t("perm.guide.acceptEdits") }}
          </button>
          <button
            type="button"
            class="guide-btn primary"
            data-cnav
            data-perm-guide-task
            :title="t('perm.guide.taskHint')"
            @click="questions.allowTask()"
          >
            {{ t("perm.guide.task") }}
          </button>
        </div>
      </div>
      <PermissionDialog v-else-if="first.kind === 'permission'" :key="first.id" :request="first.request" :queue-total="total" />
      <QuestionForm v-else :key="first.id" :request="first.request" :queue-total="total" @page="takeFocus" />
    </div>
  </div>
</template>

<style scoped>
/* The composer's column: 776px centred inside the same 24px inset Composer draws. */
.confirm-wrap {
  padding-inline: 24px;
}

/* subagents: the asking subagent's avatar and name, 12px muted, over the card. */
.dock-subagent {
  display: flex;
  gap: 6px;
  align-items: center;
  min-width: 0;
  padding: 10px 14px 0;
  color: color-mix(in srgb, var(--text-strong) 60%, transparent);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.dock-subagent-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/*
 * MiMo's `.confirm-dock`: the composer's surface under a half-pixel input
 * border and a shadow lighter than the composer's own. At most half the window
 * tall since 26.920 (it was 72vh): a question's body scrolls inside under its
 * head, and anything else taller scrolls the dock.
 */
.confirm-dock {
  position: relative;
  display: flex;
  flex-direction: column;
  /* The composer's column and fill (Composer.vue's `.shell` and `.box`), so the pair keeps one edge. */
  max-width: 712px;
  max-height: 50vh;
  margin: 0 auto 10px;
  padding: 10px 14px;
  overflow-y: auto;
  background: var(--surface-menu);
  border: 0.5px solid var(--border-input);
  border-radius: 20px;
  box-shadow: 0 2px 10px #0000000a;
  outline: none;
}

.perm-guide {
  min-width: 0;
}

.guide-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  color: var(--text-base);
  font-size: calc(14px * var(--ui-font-scale, 1));
  line-height: 1.5;
}

.guide-title {
  flex: none;
  font-weight: 500;
}

.guide-count {
  margin-inline-start: auto;
  color: #919191;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.guide-body {
  margin: 8px 0 0;
  color: #909091;
  font-size: calc(14px * var(--ui-font-scale, 1));
  line-height: 1.5;
}

.guide-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}

/* The permission card's own buttons. */
.guide-btn {
  padding: 5px 12px;
  color: var(--text-base);
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 400;
  line-height: 1.5;
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  cursor: pointer;
}

.guide-btn:hover {
  background: var(--surface-hover);
}

.guide-btn.primary {
  color: var(--surface-raised);
  background: var(--text-strong);
  border-color: var(--text-strong);
}

.guide-btn.primary:hover {
  opacity: 0.9;
}

.guide-btn:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: 1px;
}

:root[data-theme="dark"] .guide-count {
  color: #777777;
}

:root[data-theme="dark"] .guide-body {
  color: #b8b8b8;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .guide-count {
    color: #777777;
  }

  :root:not([data-theme="light"]) .guide-body {
    color: #b8b8b8;
  }
}

:root[data-theme="dark"] .confirm-dock {
  border-color: #2e2e2e;
  box-shadow: 0 1px 2px #0000004d;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .confirm-dock {
    border-color: #2e2e2e;
    box-shadow: 0 1px 2px #0000004d;
  }
}
</style>
