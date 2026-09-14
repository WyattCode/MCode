<script setup lang="ts">
import { computed } from "vue"

/**
 * MiMo's diff viewer, shared by the review tab and the diff tab: a framed box of
 * rows, each with the line's number before and after, its sign and its text.
 * Added and removed rows are tinted with a 3px bar down their start; a hunk's
 * header is a row of its own. File headers carry nothing a reader needs here.
 */
const props = defineProps<{ diff: string }>()

interface Row {
  kind: "add" | "del" | "ctx" | "hunk"
  old?: number
  new?: number
  sign: string
  text: string
}

const rows = computed<Row[]>(() => {
  const out: Row[] = []
  let oldLine = 0
  let newLine = 0
  for (const line of props.diff.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      out.push({ kind: "hunk", sign: "", text: line })
      continue
    }
    if (!out.length) continue
    if (line.startsWith("\\")) continue
    if (line.startsWith("+")) out.push({ kind: "add", new: newLine++, sign: "+", text: line.slice(1) })
    else if (line.startsWith("-")) out.push({ kind: "del", old: oldLine++, sign: "-", text: line.slice(1) })
    else if (line.startsWith("diff --git")) continue
    else out.push({ kind: "ctx", old: oldLine++, new: newLine++, sign: "", text: line.slice(1) })
  }
  // A trailing empty line is the patch's own last newline, not a line of the file.
  if (out.length && out[out.length - 1].kind === "ctx" && out[out.length - 1].text === "") out.pop()
  return out
})
</script>

<template>
  <div class="rp-diff" data-rp-diff>
    <div v-for="(row, index) in rows" :key="index" class="row" :class="row.kind">
      <template v-if="row.kind === 'hunk'">
        <span class="hunk-text">{{ row.text }}</span>
      </template>
      <template v-else>
        <span class="num">{{ row.old ?? "" }}</span>
        <span class="num">{{ row.new ?? "" }}</span>
        <span class="sign">{{ row.sign }}</span>
        <span class="text">{{ row.text }}</span>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* MiMo's diff box: a 1px line on a 10px corner, 12px mono on a 1.55 line. */
.rp-diff {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: 10px;
  font-family: var(--font-mono);
  font-size: calc(12px * var(--code-font-scale, 1));
  line-height: 1.55;
}

.row {
  display: grid;
  grid-template-columns: 34px 34px 14px minmax(0, 1fr);
  border-inline-start: 3px solid transparent;
}

.num {
  padding-inline-end: 6px;
  color: var(--text-weaker);
  font-size: calc(11px * var(--code-font-scale, 1));
  text-align: end;
  user-select: none;
}

.sign {
  color: var(--text-weak);
  text-align: center;
  user-select: none;
}

.text {
  padding-inline-end: 10px;
  color: var(--text-strong);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.row.add {
  background: var(--surface-diff-add);
  border-inline-start-color: var(--diff-add);
}

.row.del {
  background: var(--surface-diff-delete);
  border-inline-start-color: var(--diff-delete);
}

.row.hunk {
  display: block;
  padding: 2px 10px;
  color: var(--text-interactive);
  background: var(--surface-sunken);
}

.hunk-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
