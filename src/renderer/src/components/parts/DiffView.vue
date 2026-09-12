<script setup lang="ts">
import { computed } from "vue"

const props = defineProps<{ diff: string }>()

interface Row {
  kind: "add" | "del" | "ctx" | "hunk"
  text: string
}

/** Turns a unified diff into rows the template can style per kind. */
const rows = computed<Row[]>(() =>
  props.diff
    .split("\n")
    .filter((line) => !line.startsWith("---") && !line.startsWith("+++"))
    .map((line) => {
      if (line.startsWith("@@")) return { kind: "hunk", text: line }
      if (line.startsWith("+")) return { kind: "add", text: line.slice(1) }
      if (line.startsWith("-")) return { kind: "del", text: line.slice(1) }
      return { kind: "ctx", text: line.slice(1) }
    }),
)

const stat = computed(() => ({
  added: rows.value.filter((row) => row.kind === "add").length,
  removed: rows.value.filter((row) => row.kind === "del").length,
}))
</script>

<template>
  <div class="diff">
    <div class="stat">
      <span class="plus">+{{ stat.added }}</span>
      <span class="minus">-{{ stat.removed }}</span>
    </div>
    <div class="rows">
      <div v-for="(row, index) in rows" :key="index" class="row" :class="row.kind">
        <span class="gutter">{{ row.kind === "add" ? "+" : row.kind === "del" ? "-" : " " }}</span>
        <span class="code">{{ row.text }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.diff {
  border: 1px solid var(--border-weak);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.stat {
  display: flex;
  gap: 8px;
  padding: 4px 10px;
  background: var(--surface-raised-hover);
  border-bottom: 1px solid var(--border-weak);
  font-family: var(--font-mono);
  font-size: calc(10px * var(--code-font-scale, 1));
}

.plus {
  color: var(--success);
}

.minus {
  color: var(--error);
}

.rows {
  max-height: 380px;
  overflow: auto;
  background: var(--surface-raised);
}

.row {
  display: flex;
  font-family: var(--font-mono);
  font-size: calc(11.5px * var(--code-font-scale, 1));
  line-height: 1.6;
  white-space: pre;
}

/* A folded line keeps its sign column: the text is what indents, not the row. */
html[data-wrap="on"] .row {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.gutter {
  width: 20px;
  flex-shrink: 0;
  color: var(--text-weak);
  text-align: center;
  user-select: none;
}

.code {
  padding-inline-end: 10px;
}

.row.add {
  background: var(--surface-diff-add);
}

.row.add .gutter {
  color: var(--diff-add);
}

.row.del {
  background: var(--surface-diff-delete);
}

.row.del .gutter {
  color: var(--diff-delete);
}

.row.hunk {
  color: var(--text-weak);
  background: var(--surface-raised-hover);
}

.row.hunk .gutter {
  display: none;
}

/* No sign column on a hunk header, so the lead-in it would have given is spelt out. */
.row.hunk .code {
  padding-inline-start: 10px;
}
/*
 * Marked by ground, or marked by sign - one or the other, never both.
 *
 * Both at once is what this used to draw, and it is not the reading either
 * setting asks for: a reader who chose signs did so because the two grounds
 * are hard to tell apart, and leaving them under the signs keeps the problem.
 * The sign keeps its hue, which is the marker itself rather than the ground.
 */
html[data-diff-marks="color"] .gutter {
  display: none;
}

html[data-diff-marks="color"] .row .code {
  padding-inline-start: 10px;
}

html[data-diff-marks="signs"] .row.add,
html[data-diff-marks="signs"] .row.del {
  background: transparent;
}
</style>
