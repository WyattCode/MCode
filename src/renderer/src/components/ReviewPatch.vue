<script setup lang="ts">
import { computed, nextTick, ref } from "vue"
import { useApp } from "../stores/app"
import { language, t } from "../lib/i18n"

/**
 * A diff you can write on.
 *
 * Reading a change and reacting to it are the same activity, so the remark
 * belongs against the line that prompted it rather than in a prompt written
 * afterwards from memory. Notes are gathered per line and handed over together.
 */
const props = defineProps<{
  file: string
  patch: string
  layout?: "unified" | "split"
  /**
   * Whether this file's large-diff guard has already been pressed through.
   *
   * Handed in rather than remembered here, because this component does not
   * outlive the question. See the note on the guard below.
   */
  forced?: boolean
}>()

const emit = defineEmits<{ "render-anyway": [] }>()

const app = useApp()

interface Row {
  kind: "add" | "del" | "ctx" | "hunk"
  text: string
  /** Where the line sits in the file before the change, if it is there at all. */
  oldLine?: number
  /** And where it sits after, which is the number a remark is filed under. */
  newLine?: number
}

/**
 * How many changed lines this component will draw before it refuses.
 *
 * Five hundred, which is the reference's own `MAX_DIFF_CHANGED_LINES = 500`
 * (main-8t-QUXax.js @5158470). It is a count of changed lines - additions plus
 * deletions - and not of the diff's total length, so a large file with a
 * one-line edit still renders however much context git chose to include.
 */
const MAX_CHANGED_LINES = 500

/**
 * Changed lines, counted without building anything.
 *
 * Deliberately not derived from `rows`: the point of the guard is that an
 * enormous diff is never turned into objects and then into DOM, and a count
 * taken off the parsed rows would have done both before anyone asked whether it
 * should. This walks the same string under the same rules and allocates
 * nothing.
 *
 * Those rules have to be the parser's rules, and not the rules a fresh count
 * would have been written with, or the number in the message would describe a
 * different diff from the one the reader gets when they press through. So the
 * preamble before the first hunk is skipped and git's `\ No newline` note is
 * not counted, and - like the parser, and for the reason written out there - a
 * line beginning `---` or `+++` past the first hunk is counted as the changed
 * line it is rather than mistaken for a file header.
 */
const changedLines = computed(() => {
  let count = 0
  let started = false
  for (const raw of props.patch.split("\n")) {
    if (!started && !raw.startsWith("@@")) continue
    started = true
    if (raw.startsWith("@@") || raw.startsWith("\\")) continue
    if (raw.startsWith("+") || raw.startsWith("-")) count += 1
  }
  return count
})

/**
 * Whether this diff is too big to draw.
 *
 * The reference's condition, minus the arm MCode cannot reach: it also excludes
 * images, and this component is only ever handed a text patch - a binary file
 * comes through as git's one-line "Binary files differ" with no changed lines
 * at all, so it is under the limit by construction rather than by exemption.
 *
 * WHY `forced` COMES FROM OUTSIDE. It was a list kept here, on the reasoning
 * that one instance is reused as `file` changes underneath it - but the panel
 * mounts this with `v-if="patches[selected]"`, and a file whose patch has not
 * been fetched yet has no entry, so moving to a new file unmounts this
 * component and takes the list with it. Pressing through a huge diff, looking
 * at the file beside it and coming back therefore asked again. The reference
 * has no such gap: its `force` record lives in the SessionReview store
 * (main-8t-QUXax.js @5161752), one level above the per-file diffs, and dies
 * with the review rather than with a file. The panel is that level here.
 */
const tooLarge = computed(() => !props.forced && changedLines.value > MAX_CHANGED_LINES)

/*
 * Thousands separators in the language the app is set to.
 *
 * The reference calls a bare `toLocaleString()` at this one site, which follows
 * the machine rather than the app - but it passes its own locale at every other
 * site that prints a number, the context tooltip included. Following the
 * machine here would leave two numbers in one window written to two different
 * conventions, so this follows what the rest of MCode already does.
 */
const counts = computed(() => ({
  limit: MAX_CHANGED_LINES.toLocaleString(language.value),
  current: changedLines.value.toLocaleString(language.value),
}))

function renderAnyway() {
  emit("render-anyway")
}

/**
 * Line numbers come from the hunk headers.
 *
 * A unified diff only says where each hunk starts; every row after that
 * advances the side it exists on - a removal moves the old file's counter and
 * not the new one's, an addition the reverse, and context moves both.
 */
const rows = computed<Row[]>(() => {
  // Nothing is parsed for a diff that is not going to be drawn. This is the
  // whole of the guard's cost saving; the message above it is only the part the
  // reader sees.
  if (tooLarge.value) return []
  const out: Row[] = []
  let oldAt = 0
  let newAt = 0
  /*
   * Everything before the first hunk is git's own preamble - "diff --git", the
   * blob hashes, mode changes. It is not part of the file and carries no line
   * numbers, so a remark could never be attached to it.
   */
  let started = false
  /*
   * A patch ends in a newline, so splitting it leaves a final empty string.
   * Read as a row that became a context line at whatever number the hunk had
   * reached - which on a deleted file is zero, and a remark filed against
   * "line 0" is a remark about nothing.
   */
  const raws = props.patch.split("\n")
  if (raws.length && raws[raws.length - 1] === "") raws.pop()
  for (const raw of raws) {
    if (!started && !raw.startsWith("@@")) continue
    started = true
    /*
     * No test for `---` / `+++` here, on purpose.
     *
     * git writes the two file headers before the first hunk, and the loop above
     * has already thrown away everything before the first `@@`. Past that point
     * a line beginning `---` can only be a deletion whose own text starts `--`,
     * and `+++` an addition whose text starts `++`. Skipping them made those
     * rows vanish from the diff - a deleted SQL comment, an added `++i;`, a
     * markdown rule, YAML front matter - and, because the counter was not
     * advanced either, put every line number after them in that hunk out by
     * one, which files a review remark against the wrong line. Measured in the
     * running app: a patch touching four such lines drew four rows fewer and
     * numbered the rest of the hunk short.
     *
     * Safe because one patch is one file: git.ts fetches the diff a file at a
     * time, so there is never a second file header mid-stream to protect from.
     */
    // git's own note about a missing final newline; not a line of the file.
    if (raw.startsWith("\\")) continue
    if (raw.startsWith("@@")) {
      const removed = raw.match(/-(\d+)/)
      const added = raw.match(/\+(\d+)/)
      oldAt = removed ? Number(removed[1]) : 0
      newAt = added ? Number(added[1]) : 0
      out.push({ kind: "hunk", text: raw })
      continue
    }
    if (raw.startsWith("-")) {
      out.push({ kind: "del", text: raw.slice(1), oldLine: oldAt })
      oldAt += 1
      continue
    }
    if (raw.startsWith("+")) {
      out.push({ kind: "add", text: raw.slice(1), newLine: newAt })
      newAt += 1
      continue
    }
    out.push({ kind: "ctx", text: raw.slice(1), oldLine: oldAt, newLine: newAt })
    oldAt += 1
    newAt += 1
  }
  return out
})

/**
 * The same rows, laid out as facing pages.
 *
 * A run of removals followed by a run of additions is one edit written twice;
 * pairing them by position is what puts the before and the after of a line on
 * the same row. Where the runs are uneven the shorter side simply runs out.
 */
const pairs = computed<{ left?: Row; right?: Row; hunk?: Row }[]>(() => {
  const out: { left?: Row; right?: Row; hunk?: Row }[] = []
  const all = rows.value
  let at = 0
  while (at < all.length) {
    const row = all[at]
    if (row.kind === "hunk") {
      out.push({ hunk: row })
      at += 1
      continue
    }
    if (row.kind === "ctx") {
      out.push({ left: row, right: row })
      at += 1
      continue
    }
    const before = at
    const dels: Row[] = []
    const adds: Row[] = []
    while (at < all.length && all[at].kind === "del") dels.push(all[at++])
    while (at < all.length && all[at].kind === "add") adds.push(all[at++])
    /*
     * Consuming nothing would spin forever. There is no fifth kind of row, but
     * a patch is input, and input is never quite what it claims to be.
     */
    if (at === before) {
      at += 1
      continue
    }
    for (let index = 0; index < Math.max(dels.length, adds.length); index += 1) {
      out.push({ left: dels[index], right: adds[index] })
    }
  }
  return out
})

const split = computed(() => props.layout === "split")

/** Which line is being written against, if any. */
const composing = ref<number>()
const draft = ref("")
/*
 * A string template ref inside a v-for is collected as an array, however few
 * of them ever exist - so focusing it threw, and opening the editor never put
 * the cursor in it. A function ref names the one that is actually mounted.
 */
const field = ref<HTMLTextAreaElement>()
const setField = (element: unknown) => {
  field.value = (element as HTMLTextAreaElement | null) ?? undefined
}

const notesHere = computed(() => app.sessionNotes.filter((note) => note.file === props.file))

function notesOn(line: number | undefined) {
  return line === undefined ? [] : notesHere.value.filter((note) => note.line === line)
}

async function begin(line: number) {
  composing.value = line
  draft.value = ""
  await nextTick()
  field.value?.focus()
}

function save() {
  if (composing.value === undefined) return
  app.addNote(props.file, composing.value, draft.value)
  composing.value = undefined
  draft.value = ""
}

function cancel() {
  composing.value = undefined
  draft.value = ""
}
</script>

<template>
  <!--
    Too much to draw, so it is not drawn.

    Three parts in the reference's own order - a title, a line saying what the
    limit is and how far over it this file goes, and a way through anyway:
    `<div data-slot=session-review-large-diff>` holding `-title`, `-meta` and
    `-actions` (main-8t-QUXax.js @5158470). The escape hatch matters as much as
    the refusal: the reader came here to read this change, and an app that
    simply declines is an app that cannot show them their own diff.
  -->
  <div v-if="tooLarge" class="large-diff">
    <div class="large-diff-title">{{ t("ui.sessionReview.largeDiff.title") }}</div>
    <div class="large-diff-meta">{{ t("ui.sessionReview.largeDiff.meta", counts) }}</div>
    <div class="large-diff-actions">
      <button class="large-diff-btn" @click="renderAnyway">
        {{ t("ui.sessionReview.largeDiff.renderAnyway") }}
      </button>
    </div>
  </div>

  <div v-else class="patch-lines" :class="{ split }">
    <!-- Facing pages: the file as it was on the left, as it is on the right. -->
    <template v-if="split">
      <template v-for="(pair, index) in pairs" :key="index">
        <div v-if="pair.hunk" class="line hunk">
          <span class="code">{{ pair.hunk.text }}</span>
        </div>

        <div v-else class="pair">
          <div class="side" :class="pair.left ? pair.left.kind : 'blank'">
            <span class="num">{{ pair.left?.oldLine ?? "" }}</span>
            <span class="code">{{ pair.left?.text ?? "" }}</span>
          </div>
          <div class="side right" :class="pair.right ? pair.right.kind : 'blank'">
            <span class="num">{{ pair.right?.newLine ?? "" }}</span>
            <span class="code">{{ pair.right?.text ?? "" }}</span>
            <button
              v-if="pair.right && pair.right.newLine !== undefined"
              class="note-add"
              v-tip="{ label: t('review.addNote'), placement: 'left' }"
              @click="begin(pair.right.newLine)"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 2.88867V13.1109" stroke="currentColor" stroke-width="1" stroke-linejoin="round" />
                <path d="M2.88867 8H13.1109" stroke="currentColor" stroke-width="1" stroke-linejoin="round" />
              </svg>
            </button>
          </div>
        </div>

        <div v-for="note in notesOn(pair.right?.newLine)" :key="note.id" class="note display">
          <div class="note-column">
            <p class="note-text">{{ note.text }}</p>
            <span class="note-meta">{{ t("review.noteAt", { line: String(note.line) }) }}</span>
          </div>
          <button
            class="note-overflow"
            v-tip="{ label: t('review.removeNote'), placement: 'left' }"
            @click="app.removeNote(note.id)"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4.25 11.75L11.75 4.25M11.75 11.75L4.25 4.25" stroke="currentColor" stroke-width="1" />
            </svg>
          </button>
        </div>

        <div v-if="pair.right && composing === pair.right.newLine" class="note editor">
          <div class="note-field">
            <span class="note-label">{{ t("review.noteAt", { line: String(pair.right.newLine) }) }}</span>
            <textarea
              :ref="setField"
              v-model="draft"
              :placeholder="t('review.notePlaceholder')"
              spellcheck="false"
              @keydown.esc.prevent="cancel"
              @keydown.enter.meta.prevent="save"
              @keydown.enter.ctrl.prevent="save"
            />
          </div>
          <div class="note-footer">
            <span class="note-footer-meta">{{ t("review.noteHint") }}</span>
            <div class="note-footer-actions">
              <button class="note-btn" @click="cancel">{{ t("common.cancel") }}</button>
              <button class="note-btn go" :disabled="!draft.trim()" @click="save">{{ t("review.saveNote") }}</button>
            </div>
          </div>
        </div>
      </template>
    </template>

    <template v-else>
      <template v-for="(row, index) in rows" :key="index">
        <div class="line" :class="row.kind">
          <span class="num">{{ row.newLine ?? "" }}</span>
          <span class="sign">{{ row.kind === "add" ? "+" : row.kind === "del" ? "-" : " " }}</span>
          <span class="code">{{ row.text }}</span>
          <!-- Only lines that still exist can be written against. -->
          <button
            v-if="row.newLine !== undefined"
            class="note-add"
            v-tip="{ label: t('review.addNote'), placement: 'left' }"
            @click="begin(row.newLine)"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 2.88867V13.1109" stroke="currentColor" stroke-width="1" stroke-linejoin="round" />
              <path d="M2.88867 8H13.1109" stroke="currentColor" stroke-width="1" stroke-linejoin="round" />
            </svg>
          </button>
        </div>

        <!-- Saved remarks sit under the line they are about. -->
        <div v-for="note in notesOn(row.newLine)" :key="note.id" class="note display">
          <div class="note-column">
            <p class="note-text">{{ note.text }}</p>
            <span class="note-meta">{{ t("review.noteAt", { line: String(note.line) }) }}</span>
          </div>
          <button
            class="note-overflow"
            v-tip="{ label: t('review.removeNote'), placement: 'left' }"
            @click="app.removeNote(note.id)"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4.25 11.75L11.75 4.25M11.75 11.75L4.25 4.25" stroke="currentColor" stroke-width="1" />
            </svg>
          </button>
        </div>

        <div v-if="row.newLine !== undefined && composing === row.newLine" class="note editor">
          <div class="note-field">
            <span class="note-label">{{ t("review.noteAt", { line: String(row.newLine) }) }}</span>
            <textarea
              :ref="setField"
              v-model="draft"
              :placeholder="t('review.notePlaceholder')"
              spellcheck="false"
              @keydown.esc.prevent="cancel"
              @keydown.enter.meta.prevent="save"
              @keydown.enter.ctrl.prevent="save"
            />
          </div>
          <div class="note-footer">
            <span class="note-footer-meta">{{ t("review.noteHint") }}</span>
            <div class="note-footer-actions">
              <button class="note-btn" @click="cancel">{{ t("common.cancel") }}</button>
              <button class="note-btn go" :disabled="!draft.trim()" @click="save">{{ t("review.saveNote") }}</button>
            </div>
          </div>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
/*
 * The refusal reads as prose, not as code.
 *
 * It steps out of the monospace column the diff would have filled and takes the
 * app's own type, because it is the app talking about the file rather than the
 * file itself. The measurements are the reference's: 12px of padding on a
 * raised ground, a 13px title at weight 500 with 4px under it, 13px of weaker
 * meta that may break mid-word, and the actions 10px below.
 *
 * Raised rather than flush, because `--background-stronger` is what the
 * reference fills it with, and that token is a step up from the page ground in
 * both its themes (#fcfcfc over #f8f8f8 light, #151515 over #101010 dark) -
 * which is what --surface-raised is here.
 */
.large-diff {
  padding: 12px;
  background: var(--surface-raised);
  font-family: var(--font-sans, inherit);
}

.large-diff-title {
  margin-block-end: 4px;
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
}

.large-diff-meta {
  color: var(--text-weak);
  font-size: 13px;
  /* Two long numbers in a narrow panel: better broken than overflowing. */
  word-break: break-word;
}

.large-diff-actions {
  display: flex;
  gap: 8px;
  margin-block-start: 10px;
}

/*
 * The reference's secondary button, in the shape MCode already draws one: its
 * edge arrives with the shadow rather than from a border, so the control reads
 * as lifted off the block behind it rather than outlined on top of it.
 */
.large-diff-btn {
  height: 28px;
  padding: 0 12px;
  color: var(--text-strong);
  background: var(--surface-raised);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs-border);
  font-size: 13px;
  font-weight: 500;
  transition: background 0.12s;
}

.large-diff-btn:hover {
  background: var(--surface-raised-hover);
}

.patch-lines {
  display: flex;
  flex-direction: column;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.6;
}

.line {
  position: relative;
  display: flex;
  gap: 8px;
  /* Room kept clear at the end of the line for the button that opens a note. */
  padding-inline-end: 28px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/*
 * A solid fill rather than a tint of the foreground colour. Laying a
 * translucent green over the line muddies the very text the fill exists to
 * draw attention to; opencode uses opaque surfaces for the same reason.
 */
.line.add,
.side.add {
  background: var(--surface-diff-add);
}

.line.del,
.side.del {
  background: var(--surface-diff-delete);
}

.line.hunk {
  color: var(--text-weaker);
  background: var(--surface-hover);
}

/*
 * The digits are pushed up against the code they number, so the column reads
 * as a ruler beside the text rather than as a second thing to read.
 */
.num {
  flex-shrink: 0;
  width: 46px;
  padding-inline-start: 12px;
  color: var(--text-weaker);
  text-align: end;
  user-select: none;
}

.sign {
  flex-shrink: 0;
  width: 8px;
  color: var(--text-weak);
  user-select: none;
}

.code {
  min-width: 0;
}

/*
 * Facing pages. The halves are one grid rather than two scrollers, because a
 * pairing that can drift out of alignment is not a pairing.
 */
.pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
}

.side {
  position: relative;
  display: flex;
  gap: 8px;
  min-width: 0;
  padding-inline-end: 28px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* The seam belongs between the two pages, so it sits on the second one's spine. */
.side.right {
  border-inline-start: 1px solid var(--border-weaker);
}

/* Nothing to show opposite a line the other side does not have. */
.side.blank {
  background: var(--surface-hover);
}

.split .num {
  width: 40px;
  padding-inline-start: 8px;
}

.split .line.hunk {
  padding-inline-start: 12px;
}

/* Out of the way until the line is under the pointer. */
.note-add {
  position: absolute;
  top: 1px;
  inset-inline-end: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  color: var(--text-weak);
  border-radius: var(--radius-sm);
  opacity: 0;
  transition: opacity 0.12s, background 0.12s;
}

.line:hover .note-add,
.side:hover .note-add,
.note-add:focus-visible {
  opacity: 1;
}

.note-add:hover {
  color: var(--text-strong);
  background: var(--surface-selected);
}

/*
 * The note itself is not code, so it steps out of the monospace column and
 * takes the app's own type - it is something a person wrote.
 */
.note {
  width: 100%;
  max-width: 400px;
  /* Indented clear of the number column, so it hangs off the code it is about. */
  margin-block: 6px;
  margin-inline: 54px 0;
  background: var(--surface-raised);
  border-radius: 6px;
  box-shadow: var(--shadow-md);
  font-family: var(--font-sans, inherit);
}

.note.display {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 12px;
}

.note-column {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
}

.note-text {
  width: 100%;
  margin: 0;
  color: var(--text-base);
  font-size: 13px;
  font-weight: 440;
  line-height: 1.4;
  letter-spacing: -0.04px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.note-meta,
.note-footer-meta {
  color: var(--text-weaker);
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
  letter-spacing: 0.05px;
}

.note-overflow {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 2px;
  color: var(--text-weak);
  border-radius: 4px;
  transition: background 0.12s, color 0.12s;
}

.note-overflow:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.note.editor {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  padding: 12px;
}

.note-field {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  min-width: 0;
}

.note-label {
  width: 100%;
  color: var(--text-base);
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
  letter-spacing: -0.04px;
  user-select: none;
}

.note-field textarea {
  display: block;
  width: 100%;
  min-width: 0;
  min-height: 80px;
  padding: 8px;
  color: var(--text-strong);
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: 6px;
  outline: none;
  font: inherit;
  font-size: 13px;
  resize: vertical;
}

.note-field textarea:focus {
  border-color: var(--interactive);
}

.note-field textarea::placeholder {
  color: var(--text-weaker);
  user-select: none;
}

.note-footer {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  min-width: 0;
}

.note-footer-actions {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
}

.note-btn {
  height: 24px;
  padding: 0 10px;
  color: var(--text-base);
  border-radius: var(--radius-sm);
  font-size: 12px;
}

.note-btn:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.note-btn.go {
  color: var(--button-primary-text);
  background: var(--button-primary);
}

.note-btn.go:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
