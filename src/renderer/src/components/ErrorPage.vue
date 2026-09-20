<script setup lang="ts">
import { onMounted, ref } from "vue"
import { getActivePinia } from "pinia"
import { formatError } from "../lib/format-error"
import { language, t } from "../lib/i18n"

/**
 * What is left when the interface itself has failed.
 *
 * Until now a render error emptied the window and that was the end of it: no
 * message, no version, no way to restart short of killing the process, and
 * nothing the person could send us. This is the panel that takes the window in
 * that case - the reference's error page, minus the two parts MCode has no
 * counterpart for (its Discord link and updating from here).
 *
 * Everything in this file has to survive the app being broken around it. It
 * takes no store, no injected state and no directives, it reads the version
 * without waking anything, and every call out to the preload bridge is guarded
 * - a second failure while reporting the first would leave the same blank
 * window this exists to replace.
 */
const props = defineProps<{ error: unknown }>()

/** Formatting is itself code that can throw, and here of all places. */
function describe(error: unknown): string {
  try {
    return formatError(error)
  } catch {
    return t("error.chain.unknown")
  }
}

const details = describe(props.error)

/*
 * A textarea cannot size itself to its content, and a fixed height is wrong at
 * both ends: a one-line message left in a tall empty box, a chain of four
 * errors squeezed into a slot the size of one. The row count follows the text,
 * with a floor so the box still reads as a box and a ceiling that hands the
 * rest to the scrollbar.
 */
const rows = Math.min(18, Math.max(6, details.split("\n").length))

/**
 * The running version, taken without touching the store.
 *
 * `useApp()` would build the store if it did not exist yet, which - when the
 * store is what failed, or the failure happened before boot got that far -
 * means running the very code that is broken in order to print a version
 * number. Reading the state pinia is already holding cannot do that: it either
 * finds a version there or it does not, and the line is dropped if it does not,
 * exactly as the reference drops it.
 */
function runningVersion(): string {
  try {
    const state = getActivePinia()?.state.value["app"] as { version?: unknown } | undefined
    return typeof state?.version === "string" ? state.version : ""
  } catch {
    return ""
  }
}

const version = runningVersion()

/** The bridge may be absent - in a plain browser tab, or if preload failed. */
type Bridge = { relaunch?: () => unknown; saveText?: (name: string, text: string) => Promise<string | undefined> }
const bridge = window.mcode as unknown as Bridge | undefined

const canExport = typeof bridge?.saveText === "function"

/** Either where the log landed, or why it could not be written. */
const note = ref<{ text: string; failed: boolean }>()
const copied = ref(false)
const field = ref<HTMLTextAreaElement>()

/**
 * Restart, or the next best thing.
 *
 * The relaunch bridge is reached for defensively rather than assumed: if it is
 * missing, or the main process refuses, reloading the window still rebuilds the
 * whole interface from nothing, which is most of what a restart buys. A button
 * that quietly does nothing would be worse than either.
 */
function restart() {
  try {
    if (typeof bridge?.relaunch === "function") {
      void Promise.resolve(bridge.relaunch()).catch(() => window.location.reload())
      return
    }
  } catch {
    // Falls through to the reload below.
  }
  window.location.reload()
}

/**
 * Writes the failure out as a file to attach to a report.
 *
 * The workspace keeps a ring buffer of log lines, but it keeps it inside the
 * component that has just failed, so none of it is reachable from here. What
 * can be written is the part that matters most anyway: the formatted chain,
 * plus the facts needed to reproduce it.
 */
async function exportLogs() {
  if (typeof bridge?.saveText !== "function") return
  try {
    const header = [
      "MCode fatal error",
      `exported ${new Date().toISOString()}`,
      `platform ${navigator.userAgent}`,
      `language ${language.value}`,
    ]
    if (version) header.push(`version ${version}`)
    const saved = await bridge.saveText("mcode-error.txt", [...header, "", details].join("\n"))
    // Cancelling the save dialog is not a failure, and says nothing.
    if (saved) note.value = { text: `${t("log.saved")} - ${saved}`, failed: false }
  } catch (error) {
    note.value = { text: describe(error), failed: true }
  }
}

/**
 * The clipboard can be refused - it is permission-gated, and refused outright
 * when the document is not focused. Selecting the text instead leaves the
 * person one keystroke away from the same result.
 */
async function copy() {
  try {
    await navigator.clipboard.writeText(details)
    copied.value = true
    setTimeout(() => (copied.value = false), 1600)
  } catch {
    field.value?.select()
  }
}

/*
 * Focus lands on the error text, not on a button.
 *
 * Something has to take focus or the keyboard has nowhere to start, and the
 * read-only field is the only thing here that cannot act: a stray Enter on
 * Restart would throw away whatever the person had not yet copied.
 */
onMounted(() => {
  const box = field.value
  if (!box) return
  box.focus()
  /*
   * Focusing a textarea leaves the caret after the last character, and the
   * browser scrolls to wherever the caret is. On a chain longer than the box -
   * which is most of them, since one stack trace already overflows it - the
   * panel therefore opened showing the tail of the last frame, with the line
   * naming what actually went wrong scrolled off the top. The reference does
   * not focus this field at all, and dropping the focus would be one way out;
   * putting the caret back at the start is the other, and it keeps the panel
   * reachable from the keyboard.
   */
  box.setSelectionRange(0, 0)
  box.scrollTop = 0
})
</script>

<template>
  <div class="page">
    <div class="panel">
      <div class="wordmark" aria-hidden="true" />

      <header>
        <h1>{{ t("error.page.title") }}</h1>
        <p>{{ t("error.page.description") }}</p>
      </header>

      <div class="details">
        <!--
          Not class="field". That name belongs to the app's single-line text
          input, which base.css gives a fixed 28px height, no border and an
          input's focus ring - and a global rule outranks a scoped one that
          never mentions height at all. Wearing it collapsed this box to a
          single visible line of a stack trace, scrolled to the bottom, with
          the reference's quiet border replaced by a blue focus outline.
        -->
        <textarea
          ref="field"
          class="chain"
          readonly
          spellcheck="false"
          :rows="rows"
          :aria-label="t('error.page.details.label')"
          :value="details"
        />
        <button class="copy" :aria-label="t('edit.copy')" @click="copy">
          <svg v-if="copied" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3.53613 8.17857L6.39328 11.75L12.4647 4.25" stroke="currentColor" stroke-width="1" />
          </svg>
          <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M4.14908 11.0081H1.76282V1.51758H9.1038V2.55588M14.2225 4.99681H6.75397V14.4873H14.2225V4.99681Z"
              stroke="currentColor"
              stroke-width="1"
            />
          </svg>
        </button>
      </div>

      <div class="actions">
        <button class="action" @click="restart">{{ t("error.page.action.restart") }}</button>
        <button v-if="canExport" class="action ghost" @click="exportLogs">
          {{ t("error.page.action.exportLogs") }}
        </button>
      </div>

      <p v-if="note" class="note" :class="{ failed: note.failed }">{{ note.text }}</p>

      <footer v-if="version">
        <p>{{ t("error.page.version", { version }) }}</p>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/*
 * The window has no frame of its own, so with the workspace gone there would be
 * nothing left to drag it by. The whole page is the drag handle, and every
 * control on it opts back out - a drag region swallows clicks, so a button that
 * forgot to would not be pressable.
 */
.page {
  position: fixed;
  inset: 0;
  /* Above the tooltip layer, the menus and the toasts: nothing the workspace
     had open should be left sitting on top of the thing that replaced it. */
  z-index: 900;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px;
  overflow: auto;
  color: var(--text-base);
  background: var(--surface-base);
  font-family: var(--font-sans);
  -webkit-app-region: drag;
}

.panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 32px;
  inline-size: 66%;
  max-inline-size: 768px;
}

/* Set almost to the background, the way the app's own hero sets it. */
.wordmark {
  flex-shrink: 0;
  inline-size: 234px;
  block-size: 74px;
  background-image: var(--wordmark);
  background-repeat: no-repeat;
  background-position: center;
  background-size: contain;
  opacity: 0.12;
}

header {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  text-align: center;
}

h1 {
  margin: 0;
  color: var(--text-strong);
  font-size: calc(18px * var(--ui-font-scale, 1));
  font-weight: 530;
  line-height: calc(24px * var(--ui-font-scale, 1));
}

header p {
  margin: 0;
  color: var(--text-weak);
  font-size: calc(13.5px * var(--ui-font-scale, 1));
  line-height: 1.6;
}

.details {
  position: relative;
  inline-size: 100%;
}

.chain {
  display: block;
  inline-size: 100%;
  /* Sized by the `rows` the script works out, and capped at the twenty-four
     rems the reference caps its own field at. */
  max-block-size: 384px;
  padding: 10px 12px;
  /* Room for the copy button, which floats over the top corner of the field. */
  padding-inline-end: 38px;
  overflow: auto;
  color: var(--text-base);
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: var(--radius-lg);
  font-family: var(--font-mono);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 1.55;
  /* Stack frames carry long absolute paths. Wrapping them keeps the field to
     one axis of scrolling, which is the one a person expects to use. */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  resize: none;
  user-select: text;
  -webkit-app-region: no-drag;
}

.copy {
  position: absolute;
  inset-block-start: 6px;
  inset-inline-end: 6px;
  display: grid;
  place-items: center;
  inline-size: 24px;
  block-size: 24px;
  color: var(--icon-weak);
  background: var(--surface-raised);
  border-radius: var(--radius-sm);
  -webkit-app-region: no-drag;
}

.copy:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

/*
 * The reference holds this row to sixteen rems and lets it wrap, so a long
 * translation stacks the buttons rather than running them off the panel.
 */
.actions {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 12px;
  max-inline-size: 256px;
}

.action {
  padding: 8px 18px;
  color: var(--button-primary-text);
  background: var(--button-primary);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  font-size: calc(13px * var(--ui-font-scale, 1));
  -webkit-app-region: no-drag;
}

.action:hover {
  filter: brightness(1.12);
}

.ghost {
  color: var(--text-strong);
  background: var(--surface-raised);
  border-color: var(--border-weak);
}

.ghost:hover {
  filter: none;
  background: var(--surface-hover);
  border-color: var(--border-strong);
}

.note {
  max-inline-size: 672px;
  margin: 0;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
  text-align: center;
  overflow-wrap: anywhere;
}

.note.failed {
  color: var(--text-error);
}

footer {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

footer p {
  margin: 0;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
}
</style>
