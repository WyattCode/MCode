<script setup lang="ts">
import { computed } from "vue"
import type { TextPart } from "@shared/protocol"
import { renderMarkdown } from "../../lib/markdown"

const props = defineProps<{ part: TextPart }>()

// Safe to bind as HTML: renderMarkdown escapes the source before formatting it.
const html = computed(() => renderMarkdown(props.part.text))
</script>

<template>
  <div class="text" v-html="html" />
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
</style>
