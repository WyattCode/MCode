<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue"
import PermissionDialog from "./PermissionDialog.vue"
import QuestionForm from "./parts/QuestionForm.vue"
import { useQuestions } from "../stores/questions"

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
    if (!option) return
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

watch(
  () => first.value?.id,
  (id) => {
    if (id) void nextTick(takeFocus)
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
      @keydown="onDockKey"
      @pointerdown="engage"
    >
      <PermissionDialog v-if="first.kind === 'permission'" :key="first.id" :request="first.request" :queue-total="total" />
      <QuestionForm v-else :key="first.id" :request="first.request" :queue-total="total" @page="takeFocus" />
    </div>
  </div>
</template>

<style scoped>
/* The composer's column: 776px centred inside the same 24px inset Composer draws. */
.confirm-wrap {
  padding-inline: 24px;
}

/*
 * MiMo's `.confirm-dock`: the composer's surface under a half-pixel input
 * border and a shadow lighter than the composer's own. A tall request scrolls
 * inside rather than pushing the composer off the screen.
 */
.confirm-dock {
  position: relative;
  max-width: 776px;
  max-height: 72vh;
  margin: 0 auto 10px;
  padding: 10px 14px;
  overflow-y: auto;
  background: var(--surface-raised);
  border: 0.5px solid #151c130f;
  border-radius: 20px;
  box-shadow: 0 2px 10px #0000000a;
  outline: none;
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
