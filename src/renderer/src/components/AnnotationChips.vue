<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue"
import type { Annotation } from "@shared/protocol"
import { useAnnotations } from "../stores/annotations"
import { useApp } from "../stores/app"
import { jumpToAnnotation, requestAnnotationFlash, requestPdfLocate } from "../lib/annotate"
import { officeTypeOf, openDocument } from "../lib/office-open"
import { t } from "../lib/i18n"

/**
 * MiMo's annotation chips, over the box and under a sent message.
 *
 * Annotations with a note gather into one chip - "N annotations" - whose list
 * opens on hover; the ones that only point at something show one by one (the
 * first three, numbered, by their range) and the rest behind "+N more". Over
 * the box each can be removed and a note changed in place; under a sent
 * message they are read only.
 */
const props = defineProps<{ list: readonly Annotation[]; scope?: string; readOnly?: boolean }>()
const store = useAnnotations()

const REFS_SHOWN = 3

interface Entry {
  note: Annotation
  num: number
  index: number
}

const entries = computed<Entry[]>(() => props.list.map((note, index) => ({ note, num: index + 1, index })))
const notes = computed(() => entries.value.filter((entry) => entry.note.text))
const refs = computed(() => entries.value.filter((entry) => !entry.note.text))
const refsShown = computed(() => refs.value.slice(0, REFS_SHOWN))
const refsMore = computed(() => refs.value.slice(REFS_SHOWN))

function short(text: string, max = 24) {
  const folded = text.replace(/\s+/g, " ").trim()
  return folded.length > max ? `${folded.slice(0, max)}…` : folded
}

function rangeOf(note: Annotation) {
  if (note.kind === "file") return t("annotations.rangeFile")
  if (note.kind === "pdf") return t("annotations.rangePdf", { page: note.page ?? 1, text: short(note.quote ?? "") })
  return t("annotations.rangeSelection", { text: short(note.quote ?? "") })
}

function sourceOf(note: Annotation) {
  if (note.kind === "answer") return t("annotations.sourceAnswer")
  if (note.kind === "code") return t("annotations.sourceCode")
  return note.name ?? note.path ?? ""
}

/*
 * MiMo's click on an annotation: a passage is scrolled to and lit where it is
 * on screen; under a sent message, a whole file opens in the files tab.
 */
const app = useApp()
const root = ref<HTMLElement>()

/*
 * MiMo's chip click: under a sent message a document (xlsx, docx, pptx, pdf)
 * opens in the Office tab - a PDF passage is found again on its page; otherwise
 * the view that holds the annotation scrolls to it and flashes it.
 */
function activate(note: Annotation) {
  if (props.readOnly && note.path && officeTypeOf(note.path)) {
    void openDocument({ path: note.path, name: note.name }, app.current?.directory)
    if (note.kind === "pdf" && note.quote) requestPdfLocate({ path: note.path, snippet: note.quote, page: note.page, occ: note.occ })
    return
  }
  if (note.kind === "answer" || note.kind === "code") jumpToAnnotation(note, root.value ?? null)
  requestAnnotationFlash(note.id)
}

function remove(items: readonly Entry[]) {
  if (props.readOnly || !props.scope) return
  store.remove(
    props.scope,
    items.map((entry) => entry.index),
  )
}

/* The hover list: opens after 200ms on a chip, stays while the pointer is on it or a note is being changed. */
const open = ref<"notes" | "more" | null>(null)
const anchor = ref<DOMRect>()
const editing = ref<number | null>(null)
const draft = ref("")
let openTimer: ReturnType<typeof setTimeout> | undefined
let closeTimer: ReturnType<typeof setTimeout> | undefined

const shown = computed(() => (open.value === "notes" ? notes.value : open.value === "more" ? refsMore.value : []))

function hover(which: "notes" | "more", event: MouseEvent) {
  clearTimeout(closeTimer)
  const target = event.currentTarget as HTMLElement
  if (open.value === which) return
  clearTimeout(openTimer)
  openTimer = setTimeout(() => {
    anchor.value = target.getBoundingClientRect()
    open.value = which
  }, 200)
}

function leave() {
  clearTimeout(openTimer)
  if (editing.value !== null) return
  clearTimeout(closeTimer)
  closeTimer = setTimeout(() => (open.value = null), 150)
}

function stay() {
  clearTimeout(closeTimer)
}

watch(shown, (list) => {
  if (open.value && !list.length) open.value = null
})

onBeforeUnmount(() => {
  clearTimeout(openTimer)
  clearTimeout(closeTimer)
})

const popStyle = computed(() => {
  const rect = anchor.value
  if (!rect) return {}
  const width = 320
  const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8))
  return { left: `${left}px`, bottom: `${window.innerHeight - rect.top + 6}px` }
})

const editor = ref<HTMLTextAreaElement[]>()

function grow(field: HTMLTextAreaElement | undefined) {
  if (!field) return
  field.style.height = "auto"
  field.style.height = `${field.scrollHeight}px`
}

function startEdit(entry: Entry) {
  if (props.readOnly) return
  editing.value = entry.index
  draft.value = entry.note.text
  void nextTick(() => {
    const field = editor.value?.[0]
    if (!field) return
    field.focus()
    field.setSelectionRange(field.value.length, field.value.length)
    grow(field)
  })
}

function saveEdit() {
  if (editing.value === null || !props.scope) return
  store.update(props.scope, editing.value, draft.value)
  editing.value = null
}

function onEditKey(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault()
    saveEdit()
  } else if (event.key === "Escape") {
    event.preventDefault()
    event.stopPropagation()
    editing.value = null
  }
}
</script>

<template>
  <div ref="root" class="ann-chips" :data-ann-chips="readOnly ? 'history' : 'composer'">
    <span v-if="notes.length" class="cchip" data-chip="annotations" @mouseenter="hover('notes', $event)" @mouseleave="leave">
      <svg class="cchip-mark" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
        <rect x="2" y="2" width="12" height="12" rx="2.5" />
        <path d="M5.5 8h5M8 5.5v5" />
      </svg>
      <span class="cchip-name">{{ t("annotations.chip", { count: notes.length }) }}</span>
      <button v-if="!readOnly" type="button" class="cchip-rm" data-chip-rm="annotations" :aria-label="t('annotations.clearAll')" v-tip="{ label: t('annotations.clearAll'), placement: 'top' }" @click="remove(notes)">✕</button>
    </span>

    <span v-for="entry in refsShown" :key="entry.note.id" class="cchip" data-chip="ann-ref" :data-ann-num="entry.num" v-tip="{ label: `${sourceOf(entry.note)} · ${rangeOf(entry.note)}`, placement: 'top' }">
      <span class="cchip-go" role="button" tabindex="0" data-ann-go @click="activate(entry.note)" @keydown.enter.space.prevent="activate(entry.note)">
        <span class="ann-num">{{ entry.num }}</span>
        <span class="cchip-name cchip-ref">{{ rangeOf(entry.note) }}</span>
      </span>
      <button v-if="!readOnly" type="button" class="cchip-rm" :data-ann-rm="entry.index" :aria-label="t('annotations.removeRef')" @click="remove([entry])">✕</button>
    </span>

    <span v-if="refsMore.length" class="cchip" data-chip="ann-refs-more" @mouseenter="hover('more', $event)" @mouseleave="leave">
      <span class="cchip-name">{{ t("annotations.refsMore", { count: refsMore.length }) }}</span>
      <button v-if="!readOnly" type="button" class="cchip-rm" data-chip-rm="ann-refs-more" :aria-label="t('annotations.clearRefs')" v-tip="{ label: t('annotations.clearRefs'), placement: 'top' }" @click="remove(refsMore)">✕</button>
    </span>

    <Teleport to="body">
      <div v-if="open && shown.length" class="ann-pop" :data-ann-pop="open" :style="popStyle" @mouseenter="stay" @mouseleave="leave">
        <div v-for="entry in shown" :key="entry.note.id" class="ann-item">
          <span class="ann-go" role="button" tabindex="0" data-ann-go @click="activate(entry.note)" @keydown.enter.space.self.prevent="activate(entry.note)">
          <span class="ann-num ann-num-list">{{ entry.num }}</span>
          <span class="ann-body">
            <span class="ann-title">{{ sourceOf(entry.note) }}</span>
            <span class="ann-range">{{ t("annotations.range", { range: rangeOf(entry.note) }) }}</span>
            <template v-if="readOnly">
              <span v-if="entry.note.text" class="ann-note">{{ entry.note.text }}</span>
            </template>
            <textarea
              v-else-if="editing === entry.index"
              ref="editor"
              v-model="draft"
              class="ann-edit-input"
              :data-ann-edit-input="entry.index"
              rows="1"
              :placeholder="t('annotations.editPlaceholder')"
              @input="grow($event.target as HTMLTextAreaElement)"
              @blur="saveEdit"
              @keydown="onEditKey"
              @click.stop
            />
            <span v-else class="ann-note ann-note-edit" :data-ann-edit="entry.index" v-tip="{ label: t('annotations.editHint'), placement: 'top' }" @click.stop="startEdit(entry)">
              <template v-if="entry.note.text">{{ entry.note.text }}</template>
              <span v-else class="ann-muted">{{ t("annotations.editHint") }}</span>
            </span>
          </span>
          </span>
          <button v-if="!readOnly" type="button" class="ann-rm" :aria-label="entry.note.text ? t('annotations.removeOne') : t('annotations.removeRef')" @click="remove([entry])">✕</button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* MiMo's chip row: wrapping, 6 apart, 2 in and 6 below. */
.ann-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 2px 2px 6px;
}

/* MiMo's chip: 24 high, a pill on a faint fill, 13px, 5 between its parts. */
.cchip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 480px;
  height: 24px;
  padding: 0 6px 0 8px;
  overflow: hidden;
  white-space: nowrap;
  background: color-mix(in srgb, var(--text-strong) 6%, transparent);
  border-radius: 999px;
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.cchip-mark {
  flex: none;
  color: var(--text-strong);
}

.cchip-name {
  color: var(--text-success);
  font-weight: 400;
}

.cchip-go {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  cursor: pointer;
}

.ann-go {
  display: flex;
  flex: 1;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
  cursor: pointer;
}

.cchip-ref {
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cchip-rm,
.ann-rm {
  padding: 2px;
  color: var(--text-weak);
  background: none;
  border: 0;
  font-size: calc(11px * var(--ui-font-scale, 1));
  line-height: 1;
}

.cchip-rm:hover,
.ann-rm:hover {
  color: var(--text-strong);
}

/* MiMo's number: a 14px accent pill, 9px bold. */
.ann-num {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  color: #fff;
  background: #3295fb;
  border-radius: 999px;
  font-size: 9px;
  font-weight: 700;
  line-height: 1;
}

.ann-num-list {
  margin-top: 2px;
}

/* MiMo's list: 320 wide, up to 300 high, 6 in, on a 10px corner. */
.ann-pop {
  position: fixed;
  z-index: 300;
  width: 320px;
  max-height: 300px;
  padding: 6px;
  overflow-y: auto;
  background: var(--surface-menu);
  border: 1px solid var(--border-weak);
  border-radius: 10px;
  box-shadow: var(--shadow-md);
}

.ann-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 7px 8px;
  border-radius: 8px;
}

.ann-item:hover {
  background: var(--surface-hover);
}

.ann-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.ann-title,
.ann-range {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ann-title {
  color: var(--text-strong);
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.ann-range {
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.ann-note {
  color: var(--text-strong);
  font-size: calc(12px * var(--ui-font-scale, 1));
  overflow-wrap: anywhere;
}

.ann-note-edit {
  margin-top: 1px;
  padding: 3px 6px;
  border: 1px solid transparent;
  border-radius: 6px;
  cursor: text;
}

.ann-note-edit:hover {
  background: var(--surface-base);
  border-color: #3295fb;
  box-shadow: 0 0 0 2px color-mix(in srgb, #3295fb 18%, transparent);
}

.ann-muted {
  color: var(--text-weak);
}

.ann-edit-input {
  width: 100%;
  margin-top: 2px;
  padding: 3px 6px;
  color: var(--text-strong);
  background: var(--surface-base);
  border: 1px solid #3295fb;
  border-radius: 6px;
  outline: none;
  resize: none;
  font: inherit;
  font-size: calc(12px * var(--ui-font-scale, 1));
}
</style>
