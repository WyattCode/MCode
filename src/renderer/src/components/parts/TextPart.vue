<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue"
import type { TextPart } from "@shared/protocol"
import { renderMarkdown } from "../../lib/markdown"
import { highlightWithin } from "../../lib/highlight"
import { t } from "../../lib/i18n"
import { notifyFailure } from "../../lib/toast"

const props = defineProps<{ part: TextPart }>()

// Safe to bind as HTML: renderMarkdown escapes the source before formatting it.
const html = computed(() =>
  renderMarkdown(props.part.text, {
    codeActions: { copy: t("code.copy"), copied: t("code.copied"), label: t("code.copyLabel") },
    tableActions: { label: t("table.actions"), preview: t("table.preview"), copy: t("table.copy") },
  }),
)

/*
 * MiMo's syntax colours on the reply's code blocks, once each render has landed.
 * A reply still streaming renders on every word, so the pass waits for a pause
 * of 120ms; blocks already coloured come back from the cache at once.
 */
const root = ref<HTMLElement>()
let colourTimer: ReturnType<typeof setTimeout> | undefined
watch(
  html,
  () => {
    clearTimeout(colourTimer)
    colourTimer = setTimeout(() => void nextTick(() => highlightWithin(root.value)), 120)
  },
  { immediate: true },
)

/*
 * MiMo's table copy: the table as a markdown pipe table for plain text and as
 * the bare table for anything that pastes HTML. Falls back to the text alone.
 */
function pipeTable(table: HTMLTableElement): string {
  const rows = [...table.rows]
  if (!rows.length) return ""
  const width = Math.max(...rows.map((row) => row.cells.length))
  const cell = (text: string) => text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim()
  const line = (row: HTMLTableRowElement) =>
    `| ${Array.from({ length: width }, (_, at) => cell(row.cells[at]?.textContent ?? "")).join(" | ")} |`
  return [line(rows[0]), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...rows.slice(1).map(line)].join("\n")
}

function bareTable(table: HTMLTableElement): string {
  const copy = table.cloneNode(true) as HTMLTableElement
  copy.removeAttribute("class")
  copy.querySelectorAll("[class]").forEach((node) => node.removeAttribute("class"))
  return copy.outerHTML
}

async function copyTable(button: HTMLElement) {
  const table = button.closest(".md-table-container")?.querySelector("table")
  if (!table) return
  const text = pipeTable(table)
  try {
    const Item = (globalThis as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem
    let written = false
    if (navigator.clipboard?.write && Item) {
      try {
        await navigator.clipboard.write([
          new Item({ "text/plain": new Blob([text], { type: "text/plain" }), "text/html": new Blob([bareTable(table)], { type: "text/html" }) }),
        ])
        written = true
      } catch {
        // Some clipboards take only text; that is tried next.
      }
    }
    if (!written) await navigator.clipboard.writeText(text)
    button.classList.add("copied")
    window.setTimeout(() => button.classList.remove("copied"), 2000)
  } catch {
    notifyFailure(t("table.copyFailed"))
  }
}

/* MiMo's table preview: the same table, wide, in a dialog of its own. */
const previewing = ref<string>()

function closePreview() {
  previewing.value = undefined
}

function onEscape(event: KeyboardEvent) {
  if (event.key === "Escape") closePreview()
}

watch(previewing, (open) => {
  if (open) window.addEventListener("keydown", onEscape)
  else window.removeEventListener("keydown", onEscape)
})

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onEscape)
  clearTimeout(colourTimer)
})

/*
 * The copy button on a code block, as MiMo has it: the block's text goes to the
 * clipboard and the button says so for two seconds. The markup is rendered as
 * HTML, so the click is caught here on the way up rather than on the button.
 */
async function onClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null
  const tableCopy = target?.closest<HTMLElement>("[data-table-copy]")
  if (tableCopy) {
    await copyTable(tableCopy)
    return
  }
  const tablePreview = target?.closest<HTMLElement>("[data-table-preview]")
  if (tablePreview) {
    previewing.value = tablePreview.closest(".md-table-container")?.querySelector("table")?.outerHTML
    return
  }
  const button = target?.closest<HTMLButtonElement>("[data-copy-code]")
  if (!button) return
  const code = button.closest(".md-codeblock")?.querySelector("pre code")?.textContent ?? ""
  try {
    await navigator.clipboard.writeText(code)
    button.classList.add("copied")
    window.setTimeout(() => button.classList.remove("copied"), 2000)
  } catch {
    notifyFailure(t("code.copyFailed"))
  }
}
</script>

<template>
  <div ref="root" class="text" v-html="html" @click="onClick" />
  <Teleport to="body">
    <div v-if="previewing" class="md-table-preview-overlay" data-table-preview-overlay @mousedown.self="closePreview">
      <div class="md-table-preview-dialog" role="dialog" aria-modal="true" :aria-label="t('table.previewTitle')">
        <div class="md-table-preview-header">
          <span>{{ t("table.previewTitle") }}</span>
          <button
            type="button"
            class="md-table-icon-button"
            data-table-preview-close
            :aria-label="t('table.previewClose')"
            :title="t('table.previewClose')"
            @click="closePreview"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
        <div class="md-table-preview-scroller text" v-html="previewing" />
      </div>
    </div>
  </Teleport>
</template>

<style>
/* Not scoped: these style markup produced by the renderer at runtime. */
/*
 * Fourteen on 22.4, measured off opencode's markdown block. The chrome around
 * a reply runs at thirteen; the reply itself is the thing being read, and it
 * is set a point larger.
 */
.text {
  overflow-wrap: anywhere;
  font-size: calc(14px * var(--ui-font-scale, 1));
  line-height: 22.4px;
}

/*
 * Tables, on opencode's own measurements.
 *
 * `[data-component="markdown"] table { border-collapse: collapse; width: 100%;
 * margin: 16px 0; display: block; overflow-x: auto }` with cells at
 * `padding: 12px; text-align: start; vertical-align: top` and a heavier rule
 * under the head. `display: block` is what lets a wide table scroll sideways
 * inside the reply instead of widening the whole column - a table with eight
 * columns would otherwise push the conversation off its own pane.
 */
.text .md-table {
  display: block;
  width: 100%;
  margin: 16px 0;
  overflow-x: auto;
  border-collapse: collapse;
  font-size: calc(13.5px * var(--ui-font-scale, 1));
}

.text .md-table th,
.text .md-table td {
  padding: 12px;
  text-align: start;
  vertical-align: top;
  border-bottom: 1px solid var(--border-weaker);
}

.text .md-table th {
  color: var(--text-strong);
  font-weight: 500;
  border-bottom: 1px solid var(--border-weak);
}

/* The last row's rule would otherwise draw a line under nothing. */
.text .md-table tbody tr:last-child td {
  border-bottom: none;
}

/* Only written when the delimiter row asked for it. */
.text .md-table .md-left {
  text-align: start;
}

.text .md-table .md-center {
  text-align: center;
}

.text .md-table .md-right {
  text-align: end;
}

.text .md-p {
  margin: 0 0 12px;
}

.text .md-p:last-child {
  margin-bottom: 0;
}

/*
 * Three sizes, not one.
 *
 * The renderer emits every heading two levels down so a reply cannot outrank
 * the page, but a reader is going by size - collapsing all of them to 13px
 * threw away the structure the author wrote.
 */
.text .md-h {
  color: var(--text-strong);
  line-height: 1.5;
}

.text .md-h[data-level="1"] {
  margin: 28px 0 12px;
  font-size: calc(17px * var(--ui-font-scale, 1));
  font-weight: 600;
}

.text .md-h[data-level="2"] {
  margin: 24px 0 10px;
  font-size: calc(15px * var(--ui-font-scale, 1));
  font-weight: 600;
}

.text .md-h[data-level="3"] {
  margin: 20px 0 8px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 500;
}

/*
 * Past the third level a heading stops being a size and becomes a label: same
 * size as the third, dimmed, so deep structure still reads as structure.
 */
.text .md-h[data-level="4"] {
  margin: 20px 0 8px;
  color: var(--text-base);
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 500;
}

.text .md-h:first-child {
  margin-top: 0;
}

.text .md-list {
  margin: 8px 0 12px;
  padding-inline-start: 32px;
  list-style-position: outside;
}

.text ol.md-list {
  padding-inline-start: 36px;
}

/* A nested list is a step, not another full indent. */
.text .md-list .md-list {
  margin: 4px 0;
  padding-inline-start: 16px;
}

.text ol.md-list ol.md-list {
  padding-inline-start: 28px;
}

/*
 * A quoted passage, marked by a hairline down its side rather than by a fill:
 * the quote is still prose and should read as prose.
 */
.text .md-quote {
  margin: 16px 0;
  padding-inline-start: 8px;
  border-inline-start: 0.5px solid var(--border-weak);
  color: var(--text-base);
  font-style: normal;
}

.text .md-quote .md-p:last-child {
  margin-bottom: 0;
}

.text .md-list li {
  margin: 0 0 8px;
}

.text .md-list li:last-child {
  margin-bottom: 0;
}

.text .md-rule {
  height: 0;
  margin: 32px 0;
  border: none;
}

/* A tint of the text itself rather than a boxed chip. */
.text code {
  padding: 1px 4px;
  color: var(--text-base);
  background: color-mix(in oklch, var(--text-base) 8%, transparent);
  border-radius: 4px;
  font-weight: 530;
}

.text .md-code {
  margin: 8px 0;
  padding: 12px;
  overflow-x: auto;
  background: var(--surface-raised);
  border: 0.5px solid var(--border-weak);
  border-radius: 6px;
  font-size: calc(13px * var(--code-font-scale, 1));
  line-height: 1.5;
}

.text .md-code code {
  padding: 0;
  background: none;
  border: none;
}

/*
 * A reply's code block, as MiMo frames it: a head with the language at the start
 * and a small copy button at the end, over the code itself. The button is quiet
 * until the block is hovered, and says "copied" in the success colour for two
 * seconds after a press.
 */
.text .md-codeblock {
  margin: 8px 0;
  overflow: hidden;
  background: var(--surface-raised);
  border: 0.5px solid var(--border-weak);
  border-radius: 6px;
}

.text .md-codeblock .md-code {
  margin: 0;
  border: 0;
  border-radius: 0;
}

.text .md-code-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px 4px 12px;
  border-bottom: 0.5px solid var(--border-weak);
}

.text .md-code-lang {
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 18px;
  text-transform: lowercase;
}

.text .md-code-copy {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 6px;
  color: var(--text-weak);
  background: transparent;
  border: 0;
  border-radius: 6px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  opacity: 0.7;
  transition: opacity 0.12s, background-color 0.12s;
}

.text .md-codeblock:hover .md-code-copy,
.text .md-code-copy:focus-visible {
  opacity: 1;
}

.text .md-code-copy:hover {
  background: color-mix(in srgb, var(--text-strong) 8%, transparent);
}

.text .md-code-copy .done,
.text .md-code-copy.copied .idle {
  display: none;
}

.text .md-code-copy.copied .done {
  display: inline;
}

.text .md-code-copy.copied .md-code-icon.done {
  color: var(--text-success);
}

.text .md-url {
  color: var(--text-weak);
  font-family: var(--font-mono);
  font-size: calc(11px * var(--code-font-scale, 1));
}

/*
 * 2.0: an answer set the way Xiaomi MiMo sets one, measured off its own
 * conversation view - the same system face at 14/500 on a 1.7 line, a 14px
 * step between paragraphs, 6px between list items, headings that are sized
 * like headings, and code chips that are a filled box rather than a tint.
 */
.text {
  color: color-mix(in srgb, var(--text-strong) 95%, transparent);
  font-weight: 500;
  line-height: 23.8px;
}

.text .md-p {
  margin: 0 0 14px;
}

.text .md-h {
  line-height: 1.4;
}

.text .md-h[data-level="1"] {
  margin: 20px 0 12px;
  font-size: calc(22px * var(--ui-font-scale, 1));
  font-weight: 600;
}

.text .md-h[data-level="2"] {
  margin: 18px 0 10px;
  font-size: calc(20px * var(--ui-font-scale, 1));
  font-weight: 600;
}

.text .md-h[data-level="3"] {
  margin: 16px 0 8px;
  font-size: calc(16px * var(--ui-font-scale, 1));
  font-weight: 600;
}

.text .md-h[data-level="4"] {
  margin: 14px 0 6px;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 600;
}

.text .md-list {
  margin: 0 0 14px;
  padding-inline-start: 22px;
}

.text ol.md-list {
  padding-inline-start: 28px;
}

.text .md-list li,
.text .md-list li:last-child {
  margin: 6px 0;
}

.text code {
  padding: 1.5px 5px;
  color: color-mix(in srgb, var(--text-strong) 90%, transparent);
  background: color-mix(in srgb, var(--text-strong) 9.5%, var(--surface-raised));
  border-radius: 5px;
  font-size: calc(13px * var(--code-font-scale, 1));
  font-weight: 500;
}

.text .md-code {
  padding: 10px 12px;
  font-size: calc(12.5px * var(--code-font-scale, 1));
  line-height: 1.7;
}

.text .md-table {
  font-size: calc(14px * var(--ui-font-scale, 1));
}

.text .md-table th {
  padding: 8px 24px 8px 0;
  font-weight: 600;
  line-height: 1.4;
}

.text .md-table td {
  max-width: 480px;
  padding: 10px 24px 10px 0;
}

/*
 * MiMo's table in a reply: it reaches 24px past the text on each side and
 * scrolls sideways in its own strip, with its two buttons 6px above its end,
 * out of sight until the table is hovered or focused.
 */
.text .md-table-container {
  --md-table-bleed: 24px;
  position: relative;
  width: calc(100% + var(--md-table-bleed) * 2);
  margin: 0 calc(-1 * var(--md-table-bleed)) 14px;
}

.text .md-table-container:focus {
  outline: none;
}

.text .md-table-scroller {
  margin-inline: var(--md-table-bleed);
  overflow-x: auto;
}

.text .md-table-container .md-table,
.md-table-preview-scroller .md-table {
  display: table;
  width: fit-content;
  min-width: 100%;
  margin: 0;
  overflow: visible;
  border-collapse: separate;
  border-spacing: 0;
}

.text .md-table-actions {
  position: absolute;
  bottom: calc(100% + 6px);
  inset-inline-end: var(--md-table-bleed);
  z-index: 10;
  display: flex;
  gap: 4px;
  width: 56px;
  height: 26px;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--motion-fast, 0.12s);
}

.text .md-table-container:hover .md-table-actions,
.text .md-table-container:focus-within .md-table-actions {
  opacity: 1;
}

.md-table-icon-button {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 26px;
  height: 26px;
  padding: 0;
  color: var(--text-weak);
  background: transparent;
  border: 0;
  border-radius: 6px;
  pointer-events: auto;
}

.md-table-icon-button:hover,
.md-table-icon-button:focus-visible {
  color: var(--text-strong);
  background: var(--surface-hover);
  outline: none;
}

.md-table-icon-button .md-table-copy-check,
.md-table-icon-button.copied .md-table-copy-idle {
  display: none;
}

.md-table-icon-button.copied .md-table-copy-check {
  display: block;
  color: var(--text-success);
}

/* The preview: a dim ground, and the table in a dialog up to 1120 wide under a 46px heading. */
.md-table-preview-overlay {
  position: fixed;
  inset: 0;
  z-index: 320;
  display: grid;
  place-items: center;
  padding: 28px;
  background: rgb(0 0 0 / 0.34);
}

.md-table-preview-dialog {
  display: flex;
  flex-direction: column;
  width: min(1120px, 100vw - 56px);
  max-height: calc(100vh - 56px);
  overflow: hidden;
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  box-shadow: 0 20px 60px rgb(0 0 0 / 0.2);
}

.md-table-preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 46px;
  padding-block: 8px;
  padding-inline: 18px 10px;
  color: var(--text-strong);
  border-bottom: 1px solid var(--border-weaker);
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 600;
}

.md-table-preview-scroller {
  padding: 18px 24px;
  overflow: auto;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: 1.7;
}
</style>
