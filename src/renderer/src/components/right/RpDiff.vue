<script setup lang="ts">
import { computed } from "vue"
import { reviewRows } from "../../lib/diff-view"

/**
 * MiMo's review diff: a framed box of rows, each with the line's number before
 * and after, its sign and its text. Added and removed rows are tinted with a
 * 3px bar down their start; a hunk's header is a row of its own that keeps the
 * two empty number cells. A patch of several files reads each hunk by its
 * counts, so the next file's headers never show as changed lines.
 */
const props = defineProps<{ diff: string }>()

const rows = computed(() => reviewRows(props.diff))
</script>

<template>
  <div class="rp-diff" data-rp-diff>
    <div v-for="(row, index) in rows" :key="index" class="row" :class="row.kind">
      <span class="num">{{ row.old ?? "" }}</span>
      <span class="num">{{ row.new ?? "" }}</span>
      <span v-if="row.kind !== 'hunk'" class="sign">{{ row.sign }}</span>
      <span class="text">{{ row.text }}</span>
    </div>
  </div>
</template>

<style scoped>
/*
 * MiMo's diff box: a 1px line on a 10px corner, 12px mono on a 1.55 line, in
 * its own diff colours - fixed bars and signs, backgrounds that darken with the
 * theme.
 */
.rp-diff {
  --rv-bg: #fffefd;
  --rv-add-bg: #e6ffec;
  --rv-del-bg: #ffebe9;
  --rv-hunk-bg: #f6f8fa;
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: var(--rv-bg);
  border: 1px solid var(--border-weak);
  border-radius: 10px;
  font-family: var(--font-mono);
  font-size: calc(12px * var(--code-font-scale, 1));
  line-height: 1.55;
}

:global(:root[data-theme="dark"]) .rp-diff {
  --rv-bg: #1e1e1e;
  --rv-add-bg: #2ea04726;
  --rv-del-bg: #cf222e26;
  --rv-hunk-bg: #1c2128;
}

@media (prefers-color-scheme: dark) {
  :global(:root:not([data-theme="light"])) .rp-diff {
    --rv-bg: #1e1e1e;
    --rv-add-bg: #2ea04726;
    --rv-del-bg: #cf222e26;
    --rv-hunk-bg: #1c2128;
  }
}

.row {
  display: grid;
  grid-template-columns: 34px 34px 14px minmax(0, 1fr);
  align-items: start;
  border-inline-start: 3px solid transparent;
}

/* A hunk header's text starts where a line's sign would. */
.row.hunk {
  grid-template-columns: 34px 34px minmax(0, 1fr);
  color: #8250df;
  background: var(--rv-hunk-bg);
}

.num {
  box-sizing: border-box;
  padding: 0 6px;
  color: #bbb;
  font-size: calc(11px * var(--code-font-scale, 1));
  text-align: end;
  user-select: none;
}

.sign {
  color: #999;
  text-align: center;
  user-select: none;
}

.text {
  padding-inline-end: 10px;
  color: var(--text-strong);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.row.hunk .text {
  color: #8250df;
}

.row.add {
  background: var(--rv-add-bg);
  border-inline-start-color: #2da44e;
}

.row.add .sign {
  color: #2da44e;
}

.row.del {
  background: var(--rv-del-bg);
  border-inline-start-color: #cf222e;
}

.row.del .sign {
  color: #cf222e;
}

/* The diff-marks setting: colour alone blanks the sign but keeps its column; signs alone drop the tint. */
:global(html[data-diff-marks="color"]) .sign {
  visibility: hidden;
}

:global(html[data-diff-marks="signs"]) .row.add,
:global(html[data-diff-marks="signs"]) .row.del {
  background: transparent;
}
</style>
