<script setup lang="ts">
import { computed, nextTick, ref } from "vue"
import { useApp } from "../stores/app"
import { sessionTitle, t } from "../lib/i18n"

/**
 * The bar across the top of an open conversation.
 *
 * The title used to live only in the window's own chrome, which the new design
 * gives over to tabs - so the session states its own name here, next to how
 * much of the model's context it has used and the things that can be done to
 * it.
 */
const app = useApp()

/**
 * Whether the Context view this header's ring opens is currently up, and
 * whether the info card beside the conversation is.
 */
defineProps<{ infoOpen?: boolean; bottomOpen?: boolean }>()

const emit = defineEmits<{ rename: [title: string]; menu: [x: number, y: number]; info: []; bottom: [] }>()

const title = computed(() => (app.current ? sessionTitle(app.current.title) : ""))

/*
 * Renaming happens here, in the title itself.
 *
 * The reference turns this exact box into a focused input - measured at
 * `18,56 42x24` with `4px 8px` of padding and 13px/530 type, which is the
 * static title's own geometry - so the name is edited where it is read. A modal
 * used to open instead: a scrim, a heading and two buttons to change one word.
 */
const editing = ref(false)
const draft = ref("")
const field = ref<HTMLInputElement>()

async function begin() {
  if (!app.current) return
  draft.value = title.value
  editing.value = true
  await nextTick()
  field.value?.focus()
  field.value?.select()
}

function commit() {
  if (!editing.value) return
  editing.value = false
  const next = draft.value.trim()
  // An empty name is a cancel: a session with no title cannot be found again.
  if (next && next !== title.value) emit("rename", next)
}

function cancel() {
  editing.value = false
}

defineExpose({ begin })

function openMenu(event: MouseEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  emit("menu", rect.right, rect.bottom + 4)
}
</script>

<template>
  <div class="head">
    <div class="left">
      <input
        v-if="editing"
        ref="field"
        v-model="draft"
        class="title title-field"
        spellcheck="false"
        @keydown.enter="commit"
        @keydown.esc="cancel"
        @blur="commit"
      />
      <h1 v-else class="title" :title="title" @click="begin">{{ title }}</h1>

      <!--
        Beside the name rather than at the far end of the bar: it is this
        conversation's menu, and MiMo keeps it against the title it belongs to.
        The buttons at the other end drive the panels, which are not the
        conversation.
      -->
      <button class="ico options" v-tip="{ label: t('session.options'), placement: 'bottom' }" @click="openMenu">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M2.5 7.5H3.5V8.5H2.5V7.5Z" stroke="currentColor" stroke-width="1" /><path d="M7.5 7.5H8.5V8.5H7.5V7.5Z" stroke="currentColor" stroke-width="1" /><path d="M12.5 7.5H13.5V8.5H12.5V7.5Z" stroke="currentColor" stroke-width="1" />
        </svg>
      </button>
    </div>

    <div class="right">
      <!-- The info card beside the conversation; lit while it is up, as MiMo's toggle is. -->
      <button
        class="ico info"
        :aria-pressed="Boolean(infoOpen)"
        :aria-label="t('info.toggle')"
        v-tip="{ label: t('info.toggle'), placement: 'bottom' }"
        @click="emit('info')"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="2" y="2.5" width="12" height="11" rx="2" stroke="currentColor" stroke-width="1.2" />
          <path d="M10 2.5v11" stroke="currentColor" stroke-width="1.2" />
        </svg>
      </button>

      <!--
        The bottom panel, MiMo's second tool here: the terminal docked under the
        conversation, also on Ctrl+J. The context ring this slot used to hold
        lives in the composer, where MiMo keeps it.
      -->
      <button
        class="ico bottom"
        :aria-pressed="Boolean(bottomOpen)"
        :aria-label="t('key.bottomPanel')"
        v-tip="{ label: t('key.bottomPanel'), hint: 'Ctrl+J', placement: 'bottom' }"
        @click="emit('bottom')"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="2" y="2.5" width="12" height="11" rx="2" stroke="currentColor" stroke-width="1.2" />
          <path d="M2 10h12" stroke="currentColor" stroke-width="1.2" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 48px;
  padding-block: 0;
  /* The narrower inset goes where the title starts and the wider where the row
     of icons runs out, so the pair follows the reading rather than the window. */
  padding-inline: 10px 20px;
}

.left {
  display: flex;
  flex: 1;
  align-items: center;
  min-width: 0;
}

/*
 * Padded and rounded rather than plain text: it is the rename control, and the
 * hover background is the only thing that says so.
 */
.title {
  overflow: hidden;
  width: fit-content;
  max-width: 100%;
  margin: 0;
  padding: 4px 8px;
  color: var(--text-strong);
  border-radius: 6px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 530;
  line-height: 16px;
  letter-spacing: -0.04px;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.12s;
}

/*
 * The same box, now typeable. The reference's editor measures identically to
 * its static title - `42x24` on `4px 8px`, transparent, no ring - so the name
 * is edited exactly where it sat rather than the line reflowing around a field.
 *
 * `field-sizing` is what keeps that true: an input is 20-odd characters wide by
 * default, which would push the header's controls sideways the moment editing
 * began.
 */
.title-field {
  field-sizing: content;
  min-width: 6ch;
  background: transparent;
  border: 0;
  outline: none;
  cursor: text;
}

.title:hover {
  background: var(--surface-hover);
}

.right {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
}

.ico {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  color: var(--text-weak);
  border-radius: 6px;
  transition: background 0.12s, color 0.12s;
}

.ico:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

/*
 * 2.0 has no title strip, so the conversation's own header is what drags the
 * window, and it has to stay clear of the caption buttons Windows draws over
 * its top-right corner. env(titlebar-area-*) describes exactly that band when
 * the overlay is present - the width it leaves for content - and is absent on
 * macOS, where the traffic lights sit over the side column instead; so the
 * reserve below is the caption buttons' width where they exist and nothing
 * where they do not.
 */
.head {
  /* MiMo's header: 46 tall with its row pushed four down, so the title sits
     on the same line as the side column's buttons. */
  height: 46px;
  padding-block: 4px 0;
  padding-inline-end: calc(20px + 100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw));
  -webkit-app-region: drag;
}

/* 14 on regular weight, and the same 26px box the 4/8 padding makes of it. */
.title {
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 400;
  line-height: 18px;
  letter-spacing: 0;
}

.ico {
  width: 26px;
  height: 26px;
  border-radius: 7px;
}

/* Against the title, and never squeezed by a long one. */
.options {
  flex-shrink: 0;
  margin-inline-start: 2px;
}

/* A toggle that is on stays lit while its panel is up. */
.ico[aria-pressed="true"] {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.left > *,
.right {
  -webkit-app-region: no-drag;
}
</style>
