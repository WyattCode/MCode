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
  font-size: 10px;
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
  font-size: 11.5px;
  line-height: 1.6;
  white-space: pre;
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
</style>
