<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue"
import {
  DIFF_LAYOUT_KEY,
  capDiff,
  normalizeLayout,
  parseDiffFiles,
  splitPath,
  splitRows,
  type DiffLayout,
} from "../../lib/diff-view"
import { t } from "../../lib/i18n"

/**
 * MiMo's diff tab, drawn by MCode's own renderer rather than diff2html: a bar
 * choosing one column or two, the list of files, and each file under a header
 * that folds it away, naming its folder dimly before its name with its +N and
 * -M beside. Past 1200 lines only the start is drawn, and a note says how much
 * was left out.
 */
const props = defineProps<{ diff: string }>()

function readLayout(): DiffLayout {
  try {
    return normalizeLayout(localStorage.getItem(DIFF_LAYOUT_KEY))
  } catch {
    return "unified"
  }
}

const layout = ref<DiffLayout>(readLayout())

function setLayout(next: DiffLayout) {
  layout.value = next
  try {
    localStorage.setItem(DIFF_LAYOUT_KEY, next)
  } catch {
    /* Kept for this run only. */
  }
}

const capped = computed(() => capDiff(props.diff))
const files = computed(() =>
  parseDiffFiles(capped.value.text).map((file) => ({
    ...file,
    path: splitPath(file.name),
    rows: file.hunks.map((hunk) => ({ header: hunk.header, lines: hunk.lines, split: splitRows(hunk.lines) })),
  })),
)

/* Folded files, by name, so a new patch for the same tab keeps what was folded. */
const collapsed = ref(new Set<string>())
watch(files, (list) => {
  const names = new Set(list.map((file) => file.name))
  collapsed.value = new Set([...collapsed.value].filter((name) => names.has(name)))
})

function toggle(name: string) {
  const next = new Set(collapsed.value)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  collapsed.value = next
}

const scroller = ref<HTMLElement>()

/* A file in the list: unfolded, and brought to the top of the scroll. */
async function reveal(index: number) {
  const name = files.value[index]?.name
  if (name !== undefined && collapsed.value.has(name)) toggle(name)
  await nextTick()
  const box = scroller.value
  const target = box?.querySelector<HTMLElement>(`[data-diff-file="${index}"]`)
  if (box && target) box.scrollTop += target.getBoundingClientRect().top - box.getBoundingClientRect().top
}
</script>

<template>
  <div class="dt" data-rp-diff-tab>
    <div class="dt-bar" data-diff-layout-bar>
      <div class="dt-seg" role="group">
        <button type="button" class="dt-seg-btn" :class="{ on: layout === 'unified' }" data-diff-layout="unified" :aria-pressed="layout === 'unified'" @click="setLayout('unified')">
          {{ t("rp.diff.layoutUnified") }}
        </button>
        <button type="button" class="dt-seg-btn" :class="{ on: layout === 'split' }" data-diff-layout="split" :aria-pressed="layout === 'split'" @click="setLayout('split')">
          {{ t("rp.diff.layoutSplit") }}
        </button>
      </div>
    </div>

    <div ref="scroller" class="dt-scroll" data-selectable="content">
      <pre v-if="!files.length" class="dt-raw">{{ capped.text }}</pre>
      <template v-else>
        <ol class="dt-list" data-diff-file-list>
          <li v-for="(file, index) in files" :key="`list:${file.name}:${index}`" class="dt-list-line" @click="reveal(index)">
            <span class="dt-name" :title="file.name">
              <span v-if="file.path.dir" class="dt-dir">{{ file.path.dir }}</span><span class="dt-base">{{ file.path.base }}</span>
            </span>
            <span class="dt-stats">
              <span class="dt-added">+{{ file.added }}</span>
              <span class="dt-deleted">-{{ file.deleted }}</span>
            </span>
          </li>
        </ol>

        <section
          v-for="(file, index) in files"
          :key="`file:${file.name}:${index}`"
          class="dt-file"
          :class="{ collapsed: collapsed.has(file.name) }"
          :data-diff-file="index"
        >
          <div class="dt-head" @click="toggle(file.name)">
            <span class="dt-name-wrap">
              <span class="dt-name" :title="file.name">
                <span v-if="file.path.dir" class="dt-dir">{{ file.path.dir }}</span><span class="dt-base">{{ file.path.base }}</span>
              </span>
            </span>
            <span class="dt-stats">
              <span class="dt-added">+{{ file.added }}</span>
              <span class="dt-deleted">-{{ file.deleted }}</span>
            </span>
          </div>

          <div v-if="!collapsed.has(file.name) && layout === 'unified'" class="dt-body">
            <div class="dt-table">
              <template v-for="(hunk, h) in file.rows" :key="h">
                <div class="dt-row info">
                  <span class="dt-ln" /><span class="dt-ln" />
                  <span class="dt-code">{{ hunk.header }}</span>
                </div>
                <div v-for="(line, l) in hunk.lines" :key="`${h}:${l}`" class="dt-row" :class="line.kind">
                  <span class="dt-ln">{{ line.old ?? "" }}</span>
                  <span class="dt-ln">{{ line.new ?? "" }}</span>
                  <span class="dt-code"><span class="dt-prefix">{{ line.kind === "add" ? "+" : line.kind === "del" ? "-" : " " }}</span>{{ line.text }}</span>
                </div>
              </template>
            </div>
          </div>

          <div v-else-if="!collapsed.has(file.name)" class="dt-sides">
            <div v-for="side in (['left', 'right'] as const)" :key="side" class="dt-side">
              <div class="dt-table">
                <template v-for="(hunk, h) in file.rows" :key="h">
                  <div class="dt-row info">
                    <span class="dt-ln" />
                    <span class="dt-code">{{ side === "left" ? hunk.header : "" }}&#8203;</span>
                  </div>
                  <div
                    v-for="(pair, p) in hunk.split"
                    :key="`${h}:${p}`"
                    class="dt-row"
                    :class="pair[side] ? pair[side]!.kind : 'empty'"
                  >
                    <span class="dt-ln">{{ pair[side] ? (side === "left" ? pair[side]!.old : pair[side]!.new) : "" }}</span>
                    <span class="dt-code"><span class="dt-prefix">{{ pair[side]?.kind === "add" ? "+" : pair[side]?.kind === "del" ? "-" : " " }}</span>{{ pair[side]?.text ?? "" }}&#8203;</span>
                  </div>
                </template>
              </div>
            </div>
          </div>
        </section>
      </template>
    </div>
    <div v-if="capped.truncated" class="dt-cap" data-diff-truncated>{{ t("rp.diff.truncated", { n: capped.omitted }) }}</div>
  </div>
</template>

<style scoped>
/*
 * MiMo's rp-diff-body is 14px in and fills the tab. The diff colours are
 * diff2html's, which MiMo keeps in its light theme, and MiMo's GitHub-dark set
 * under the dark theme.
 */
.dt {
  --d2h-bg: #fff;
  --d2h-color: #000;
  --d2h-dim: rgb(0 0 0 / 0.3);
  --d2h-border: #ddd;
  --d2h-line-border: #eee;
  --d2h-head-bg: #f7f7f7;
  --d2h-head-border: #d8d8d8;
  --d2h-ins-bg: #dfd;
  --d2h-ins-border: #b4e2b4;
  --d2h-ins-label: #399839;
  --d2h-del-bg: #fee8e9;
  --d2h-del-border: #e9aeae;
  --d2h-del-label: #c33;
  --d2h-info-bg: #f8fafd;
  --d2h-info-border: #d5e4f2;
  --d2h-empty-bg: #f1f1f1;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  padding: 14px;
}

:global(:root[data-theme="dark"]) .dt {
  --d2h-bg: #0d1117;
  --d2h-color: #e6edf3;
  --d2h-dim: #6e7681;
  --d2h-border: #30363d;
  --d2h-line-border: #21262d;
  --d2h-head-bg: #161b22;
  --d2h-head-border: #30363d;
  --d2h-ins-bg: #2ea04326;
  --d2h-ins-border: #2ea04366;
  --d2h-ins-label: #3fb950;
  --d2h-del-bg: #f851491a;
  --d2h-del-border: #f8514966;
  --d2h-del-label: #f85149;
  --d2h-info-bg: #388bfd1a;
  --d2h-info-border: #388bfd66;
  --d2h-empty-bg: #6e76811a;
}

@media (prefers-color-scheme: dark) {
  :global(:root:not([data-theme="light"])) .dt {
    --d2h-bg: #0d1117;
    --d2h-color: #e6edf3;
    --d2h-dim: #6e7681;
    --d2h-border: #30363d;
    --d2h-line-border: #21262d;
    --d2h-head-bg: #161b22;
    --d2h-head-border: #30363d;
    --d2h-ins-bg: #2ea04326;
    --d2h-ins-border: #2ea04366;
    --d2h-ins-label: #3fb950;
    --d2h-del-bg: #f851491a;
    --d2h-del-border: #f8514966;
    --d2h-del-label: #f85149;
    --d2h-info-bg: #388bfd1a;
    --d2h-info-border: #388bfd66;
    --d2h-empty-bg: #6e76811a;
  }
}

/* The layout bar: right-aligned, 8 above the diff. */
.dt-bar {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: flex-end;
  padding-bottom: 8px;
}

.dt-seg {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  background: var(--surface-sunken);
  border-radius: 7px;
}

.dt-seg-btn {
  padding: 2px 8px;
  color: var(--text-weak);
  background: transparent;
  border: 0;
  border-radius: 5px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 1.6;
  transition: color 0.15s, background-color 0.15s;
}

.dt-seg-btn:hover {
  color: var(--text-strong);
}

.dt-seg-btn.on {
  color: var(--text-strong);
  background: var(--surface-raised);
  box-shadow: 0 0 0 1px var(--border-weak);
}

.dt-scroll {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: auto;
  color: var(--d2h-color);
  background: var(--d2h-bg);
  border-radius: 8px;
}

.dt-raw {
  margin: 0;
  padding: 9px 12px;
  font-family: var(--font-mono);
  font-size: calc(12px * var(--code-font-scale, 1));
  white-space: pre-wrap;
}

/* The file list: a line per file, a rule between. */
.dt-list {
  margin: 0 0 10px;
  padding: 0;
  list-style: none;
  border: 1px solid var(--d2h-border);
  border-radius: 8px;
}

.dt-list-line {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-bottom: 1px solid var(--d2h-border);
  font-size: calc(13px * var(--ui-font-scale, 1));
  cursor: pointer;
}

.dt-list-line:last-child {
  border-bottom: 0;
}

.dt-name {
  display: flex;
  min-width: 0;
}

.dt-dir {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.6;
}

.dt-base {
  flex: none;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* MiMo's +N / -M pills: 600 weight on a 12% tint. */
.dt-stats {
  display: flex;
  flex: none;
  align-items: center;
  gap: 5px;
  margin-inline-start: auto;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.dt-added,
.dt-deleted {
  padding: 1px 7px;
  border-radius: 6px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  line-height: 1.5;
}

.dt-added {
  color: var(--d2h-ins-label);
  background: color-mix(in srgb, var(--d2h-ins-label) 12%, transparent);
}

.dt-deleted {
  color: var(--d2h-del-label);
  background: color-mix(in srgb, var(--d2h-del-label) 12%, transparent);
}

.dt-file + .dt-file {
  border-top: 1px solid var(--d2h-head-border);
}

.dt-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  background: var(--d2h-head-bg);
  border-bottom: 1px solid var(--d2h-head-border);
  font-size: calc(13px * var(--ui-font-scale, 1));
  cursor: pointer;
}

/* The fold triangle: 5px, turned down while open, over .12s. */
.dt-name-wrap {
  display: flex;
  flex: 1;
  align-items: center;
  min-width: 0;
}

.dt-name-wrap::before {
  content: "";
  flex: none;
  width: 0;
  height: 0;
  margin-inline-end: 6px;
  border-block: 4px solid transparent;
  border-inline-start: 5px solid;
  opacity: 0.5;
  transform: rotate(90deg);
  transition: transform 0.12s;
}

.dt-file.collapsed .dt-name-wrap::before {
  transform: rotate(0);
}

:global([dir="rtl"]) .dt-name-wrap::before {
  transform: rotate(-90deg);
}

:global([dir="rtl"]) .dt-file.collapsed .dt-name-wrap::before {
  transform: rotate(0);
}

.dt-body,
.dt-side {
  overflow-x: auto;
}

.dt-sides {
  display: flex;
}

.dt-side {
  flex: 1 1 50%;
  min-width: 0;
}

.dt-side + .dt-side {
  border-inline-start: 1px solid var(--d2h-line-border);
}

.dt-table {
  min-width: max-content;
  font-family: var(--font-mono);
  font-size: calc(13px * var(--code-font-scale, 1));
  line-height: 1.5;
}

.dt-row {
  display: flex;
}

.dt-ln {
  position: sticky;
  inset-inline-start: 0;
  box-sizing: border-box;
  flex: none;
  width: 3.5em;
  padding: 0 0.5em;
  overflow: hidden;
  color: var(--d2h-dim);
  text-align: end;
  text-overflow: ellipsis;
  background: var(--d2h-bg);
  border-inline-end: 1px solid var(--d2h-line-border);
  user-select: none;
}

.dt-ln + .dt-ln {
  inset-inline-start: 3.5em;
}

.dt-side .dt-ln {
  width: 4em;
}

.dt-code {
  flex: 1;
  padding: 0 0.5em;
  white-space: pre;
}

.dt-prefix {
  display: inline-block;
  width: 1.2em;
  user-select: none;
}

.dt-row.add,
.dt-row.add .dt-ln {
  background: var(--d2h-ins-bg);
  border-color: var(--d2h-ins-border);
}

.dt-row.del,
.dt-row.del .dt-ln {
  background: var(--d2h-del-bg);
  border-color: var(--d2h-del-border);
}

.dt-row.info,
.dt-row.info .dt-ln {
  color: var(--d2h-dim);
  background: var(--d2h-info-bg);
  border-color: var(--d2h-info-border);
}

.dt-row.empty,
.dt-row.empty .dt-ln {
  background: var(--d2h-empty-bg);
}

/* The diff-marks setting, as MiMo reads it: colour alone keeps the prefix's room but blanks it. */
:global(html[data-diff-marks="color"]) .dt-prefix {
  visibility: hidden;
}

:global(html[data-diff-marks="signs"]) .dt-row.add,
:global(html[data-diff-marks="signs"]) .dt-row.del {
  background: transparent;
}

/* MiMo's cap note: 12px muted, 4 below the diff. */
.dt-cap {
  flex: none;
  margin-top: 4px;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 1.6;
}
</style>
