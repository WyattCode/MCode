<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue"
import { absoluteName, capDiff, displayName, markWords, parseDiffFiles, splitPath, splitRows, type DiffLayout } from "../../lib/diff-view"
import { t } from "../../lib/i18n"

/**
 * One patch, drawn the same way everywhere.
 *
 * MiMo has a single diff component: the 审阅 tab fills the pane with it, and a
 * turn's step and a permission card draw the same component unfilled. This is
 * that component - a header per file that folds it away, the words only one
 * side of a changed pair has, line numbers on both sides, and MiMo's note once
 * a patch runs past its cap - so a patch reads the same in a step as it does in
 * the tab. The list of files above them belongs to the filled tab alone, as it
 * does in MiMo.
 *
 * Each file's sideways scroll is remembered by name and put back after the
 * patch is drawn again, as MiMo restores `scrollLeft` per file: a turn that
 * keeps updating its diff used to drag a long line back to its start.
 */
const props = defineProps<{
  diff: string
  layout?: DiffLayout
  /** Fills its parent (the tab); otherwise it takes MiMo's height for a step. */
  fill?: boolean
  /** The project a step's patch was made in: its headers then name each file in full. */
  root?: string
}>()

const capped = computed(() => capDiff(props.diff))
const files = computed(() =>
  parseDiffFiles(capped.value.text).map((file) => ({
    ...file,
    path: splitPath(
      displayName(props.root === undefined ? file : { name: absoluteName(file.name, props.root), oldName: file.oldName && absoluteName(file.oldName, props.root) }),
    ),
    rows: file.hunks.map((hunk) => {
      const lines = markWords(hunk.lines)
      return { header: hunk.header, lines, split: splitRows(lines) }
    }),
  })),
)

/* The mark in front of a file's name, for what the patch does to it. */
const SHEET = "M4 2.5h5.5L12.5 5.5v8H4z"
const CORNER = "M9.5 2.5v3h3"
const STATUS_ICON: Record<string, string[]> = {
  added: [SHEET, CORNER, "M8 7.6v4M6 9.6h4"],
  deleted: [SHEET, CORNER, "M6 9.6h4"],
  renamed: [SHEET, CORNER, "M6 9.6h4M8.6 8.2 10 9.6l-1.4 1.4"],
  changed: [SHEET, CORNER, "M6 8.6h4M6 11h2.6"],
}

/*
 * The square in front of a name in the file list, marked for what the patch
 * does to the file; a changed file's square holds a dot, drawn in the markup.
 */
const LIST_MARK: Record<string, string | undefined> = {
  added: "M7 5.4v5.2M4.4 8h5.2",
  deleted: "M4.4 8h5.2",
  renamed: "M4.4 8h4.8M7.4 5.8 9.6 8l-2.2 2.2",
}

/* Folded files, by name, so a new patch for the same tab keeps what was folded. */
const collapsed = ref(new Set<string>())

function toggle(name: string) {
  const next = new Set(collapsed.value)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  collapsed.value = next
}

const scroller = ref<HTMLElement>()

/* Where each file's own box was scrolled sideways, by the key on that box. */
const offsets = new Map<string, number>()

function remember(event: Event) {
  const box = event.target as HTMLElement | null
  const key = box?.dataset?.diffScroll
  if (key) offsets.set(key, box!.scrollLeft)
}

function restore() {
  for (const box of scroller.value?.querySelectorAll<HTMLElement>("[data-diff-scroll]") ?? []) {
    const left = offsets.get(box.dataset.diffScroll ?? "")
    if (left) box.scrollLeft = left
  }
}

watch(files, async (list) => {
  const names = new Set(list.map((file) => file.name))
  collapsed.value = new Set([...collapsed.value].filter((name) => names.has(name)))
  for (const key of [...offsets.keys()]) {
    if (!names.has(key.split("\u0000")[0]!)) offsets.delete(key)
  }
  // The rows are rebuilt from scratch, so the places they were read at are put back after.
  await nextTick()
  restore()
})

/*
 * A file in the list: unfolded, and brought to the top of the scroll. From the
 * keyboard, focus follows to that file's header, where Enter folds it.
 */
async function reveal(index: number, focus = false) {
  const name = files.value[index]?.name
  if (name !== undefined && collapsed.value.has(name)) toggle(name)
  await nextTick()
  const box = scroller.value
  const target = box?.querySelector<HTMLElement>(`[data-diff-file="${index}"]`)
  if (box && target) box.scrollTop += target.getBoundingClientRect().top - box.getBoundingClientRect().top
  if (focus) target?.querySelector<HTMLElement>(".db-head")?.focus({ preventScroll: true })
}

defineExpose({ reveal })
</script>

<template>
  <div ref="scroller" class="db-scroll" :class="{ fill }" data-selectable="content" data-diff-body @scroll.capture="remember">
    <pre v-if="!files.length" class="db-raw">{{ capped.text }}</pre>
    <template v-else>
      <!-- MiMo draws the list only where the diff fills the panel; a step's diff and a permission card's go without it. -->
      <div v-if="fill" class="db-list-title" data-diff-files-heading>{{ t("rp.diff.filesChanged", { n: files.length }) }}</div>
      <ol v-if="fill" class="db-list" data-diff-file-list>
        <li
          v-for="(file, index) in files"
          :key="`list:${file.name}:${index}`"
          class="db-list-line"
          role="button"
          tabindex="0"
          :aria-label="`${file.path.dir}${file.path.base} +${file.added} -${file.deleted}`"
          @click="reveal(index)"
          @keydown.enter.space.self.prevent="reveal(index, true)"
        >
          <svg class="db-list-icon" :class="file.status" viewBox="0 0 14 16" width="14" height="16" :data-diff-list-icon="file.status" aria-hidden="true">
            <rect x="1.6" y="2.6" width="10.8" height="10.8" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.2" />
            <path v-if="LIST_MARK[file.status]" :d="LIST_MARK[file.status]" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
            <circle v-else cx="7" cy="8" r="2" fill="currentColor" />
          </svg>
          <span class="db-name" :title="`${file.path.dir}${file.path.base}`">
            <span v-if="file.path.dir" class="db-dir">{{ file.path.dir }}</span><span class="db-base">{{ file.path.base }}</span>
          </span>
          <span class="db-stats">
            <span class="db-added">+{{ file.added }}</span>
            <span class="db-deleted">-{{ file.deleted }}</span>
          </span>
        </li>
      </ol>

      <section
        v-for="(file, index) in files"
        :key="`file:${file.name}:${index}`"
        class="db-file"
        :class="{ collapsed: collapsed.has(file.name) }"
        :data-diff-file="index"
      >
        <div
          class="db-head"
          role="button"
          tabindex="0"
          :aria-expanded="!collapsed.has(file.name)"
          :aria-label="`${file.path.dir}${file.path.base}, ${t(`rp.diff.tag.${file.status}`)}`"
          @click="toggle(file.name)"
          @keydown.enter.space.self.prevent="toggle(file.name)"
        >
          <span class="db-name-wrap">
            <svg class="db-status" :class="file.status" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round" :data-diff-status="file.status" aria-hidden="true">
              <path v-for="d in STATUS_ICON[file.status]" :key="d" :d="d" />
            </svg>
            <span class="db-name" :title="`${file.path.dir}${file.path.base}`">
              <span v-if="file.path.dir" class="db-dir">{{ file.path.dir }}</span><span class="db-base">{{ file.path.base }}</span>
            </span>
            <span class="db-tag" :class="file.status" data-diff-tag>{{ t(`rp.diff.tag.${file.status}`) }}</span>
          </span>
        </div>

        <div v-if="!collapsed.has(file.name) && layout !== 'split'" class="db-body" :data-diff-scroll="`${file.name}\u0000u`">
          <div class="db-table">
            <template v-for="(hunk, h) in file.rows" :key="h">
              <div class="db-row info">
                <span class="db-ln" />
                <span class="db-code">{{ hunk.header }}</span>
              </div>
              <div v-for="(line, l) in hunk.lines" :key="`${h}:${l}`" class="db-row" :class="[line.kind, { paired: line.paired }]">
                <span class="db-ln"><span class="db-num">{{ line.old ?? "" }}</span><span class="db-num">{{ line.new ?? "" }}</span></span>
                <span class="db-code"><span class="db-prefix">{{ line.kind === "add" ? "+" : line.kind === "del" ? "-" : " " }}</span><template v-if="line.marks"><span v-for="(mark, m) in line.marks" :key="m" :class="{ 'db-mark': mark.changed }">{{ mark.text }}</span></template><template v-else>{{ line.text }}</template></span>
              </div>
            </template>
          </div>
        </div>

        <div v-else-if="!collapsed.has(file.name)" class="db-sides">
          <div v-for="side in (['left', 'right'] as const)" :key="side" class="db-side" :data-diff-scroll="`${file.name}\u0000${side}`">
            <div class="db-table">
              <template v-for="(hunk, h) in file.rows" :key="h">
                <div class="db-row info">
                  <span class="db-ln" />
                  <span class="db-code">{{ side === "left" ? hunk.header : "" }}&#8203;</span>
                </div>
                <div
                  v-for="(pair, p) in hunk.split"
                  :key="`${h}:${p}`"
                  class="db-row"
                  :class="[pair[side] ? pair[side]!.kind : 'empty', { paired: pair[side]?.paired }]"
                >
                  <span class="db-ln">{{ pair[side] ? (side === "left" ? pair[side]!.old : pair[side]!.new) : "" }}</span>
                  <span class="db-code"><span class="db-prefix">{{ pair[side]?.kind === "add" ? "+" : pair[side]?.kind === "del" ? "-" : " " }}</span><template v-if="pair[side]?.marks"><span v-for="(mark, m) in pair[side]!.marks" :key="m" :class="{ 'db-mark': mark.changed }">{{ mark.text }}</span></template><template v-else>{{ pair[side]?.text ?? "" }}</template>&#8203;</span>
                </div>
              </template>
            </div>
          </div>
        </div>
      </section>
    </template>
    <div v-if="capped.truncated" class="db-cap" data-diff-truncated>{{ t("rp.diff.truncated", { n: capped.omitted }) }}</div>
  </div>
</template>

<style scoped>
/*
 * The diff colours are diff2html's, which MiMo keeps in its light theme, and
 * MiMo's GitHub-dark set under the dark theme, laid over the panel's own
 * surface - so a dark diff's lines sit on the panel and only the gutter is
 * GitHub's near-black, as measured on MiMo 26.920.
 *
 * diff2html has four colours this component has no names for: a pair's two
 * sides, and the words inside them. They are the same roles one level down,
 * so the line colours are named again inside a pair and again inside a marked
 * word, rather than given names of their own.
 */
.db-scroll {
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
  position: relative;
  /* Unfilled, this is a step's diff: MiMo's 480 at most. */
  max-height: 480px;
  overflow: auto;
  color: var(--d2h-color);
  background: var(--surface-raised);
  border: 1px solid var(--d2h-border);
  border-radius: 8px;
}

.db-scroll .paired {
  --d2h-del-bg: #fdf2d0;
  --d2h-ins-bg: #ded;
}

.db-scroll .db-mark {
  --d2h-del-bg: #ffb6ba;
  --d2h-ins-bg: #97f295;
}

.db-scroll.fill {
  flex: 1;
  max-height: none;
  min-height: 0;
  border: 0;
}

:root[data-theme="dark"] .db-scroll .paired {
  --d2h-del-bg: #d2992233;
  --d2h-ins-bg: #2ea04340;
}

:root[data-theme="dark"] .db-scroll .db-mark {
  --d2h-del-bg: #f8514966;
  --d2h-ins-bg: #2ea04366;
}

:root[data-theme="dark"] .db-scroll {
  --d2h-bg: #0d1117;
  --d2h-color: #f4f4f5;
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
  :root:not([data-theme="light"]) .db-scroll .paired {
    --d2h-del-bg: #d2992233;
    --d2h-ins-bg: #2ea04340;
  }

  :root:not([data-theme="light"]) .db-scroll .db-mark {
    --d2h-del-bg: #f8514966;
    --d2h-ins-bg: #2ea04366;
  }

  :root:not([data-theme="light"]) .db-scroll {
    --d2h-bg: #0d1117;
    --d2h-color: #f4f4f5;
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

.db-raw {
  margin: 0;
  padding: 9px 12px;
  font-family: var(--font-mono);
  font-size: calc(12px * var(--code-font-scale, 1));
  white-space: pre-wrap;
}

/* The file list under diff2html's bold count, a line per file, a rule between. */
.db-list-title {
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 700;
  line-height: 1.5;
}

.db-list {
  margin: 0 0 10px;
  padding: 0;
  list-style: none;
  border-bottom: 1px solid var(--d2h-border);
}

.db-list-line {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-bottom: 1px solid var(--d2h-border);
  font-size: calc(13px * var(--ui-font-scale, 1));
  cursor: pointer;
}

.db-list-line:last-child {
  border-bottom: 0;
}

/* A row reached from the keyboard keeps MiMo's ring, rounded as the row is. */
.db-list-line:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: 2px;
  border-radius: 6px;
}

/* A name in the list is diff2html's link blue in either theme, its folders dimmed. */
.db-list .db-name {
  --d2h-color: #3572b0;

  color: var(--d2h-color);
}

.db-name {
  display: flex;
  min-width: 0;
}

.db-dir {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.6;
}

.db-base {
  flex: none;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* MiMo's +N / -M pills: 600 weight on a 12% tint. */
.db-stats {
  display: flex;
  flex: none;
  align-items: center;
  gap: 5px;
  margin-inline-start: auto;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.db-added,
.db-deleted {
  padding: 1px 7px;
  border-radius: 6px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  line-height: 1.5;
}

.db-added {
  color: var(--d2h-ins-label);
  background: color-mix(in srgb, var(--d2h-ins-label) 12%, transparent);
}

.db-deleted {
  color: var(--d2h-del-label);
  background: color-mix(in srgb, var(--d2h-del-label) 12%, transparent);
}

.db-file + .db-file {
  border-top: 1px solid var(--d2h-head-border);
}

.db-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  background: var(--d2h-head-bg);
  border-bottom: 1px solid var(--d2h-head-border);
  font-size: calc(13px * var(--ui-font-scale, 1));
  cursor: pointer;
}

/* A fold head reached from the keyboard keeps MiMo's ring. */
.db-head:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: 2px;
}

/* The fold triangle: 5px, turned down while open, over .12s. */
.db-name-wrap {
  display: flex;
  flex: 1;
  align-items: center;
  min-width: 0;
}

.db-name-wrap::before {
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

.db-file.collapsed .db-name-wrap::before {
  transform: rotate(0);
}

[dir="rtl"] .db-name-wrap::before {
  transform: rotate(-90deg);
}

[dir="rtl"] .db-file.collapsed .db-name-wrap::before {
  transform: rotate(0);
}

/* The file's mark, in the colour of what the patch did to it. */
.db-status {
  flex: none;
  margin-inline-end: 6px;
  opacity: 0.75;
}

.db-status.added {
  color: var(--d2h-ins-label);
}

.db-status.deleted {
  color: var(--d2h-del-label);
}

/*
 * The word for what the patch did, beside the name, and the square before it
 * in the list: diff2html's status colours - green, red, yellow for a change and
 * blue for a move. The last two have no name here, so the foreground is named
 * again on the element that wears them; MiMo's dark set does not restate them,
 * so they are the light values in either theme, as measured on 26.920.
 */
.db-tag {
  flex: none;
  margin-inline-start: 8px;
  padding: 1px 6px;
  color: var(--d2h-color);
  border: 1px solid currentcolor;
  border-radius: 6px;
  font-size: calc(11px * var(--ui-font-scale, 1));
  line-height: 1.5;
  text-transform: uppercase;
  white-space: nowrap;
}

.db-list-icon {
  flex: none;
  margin-inline-end: 2px;
  color: var(--d2h-color);
}

.db-scroll :is(.db-tag, .db-list-icon).changed {
  --d2h-color: #d0b44c;
}

.db-scroll :is(.db-tag, .db-list-icon).renamed {
  --d2h-color: #3572b0;
}

:is(.db-tag, .db-list-icon).added {
  color: var(--d2h-ins-label);
}

:is(.db-tag, .db-list-icon).deleted {
  color: var(--d2h-del-label);
}

.db-body,
.db-side {
  overflow-x: auto;
}

.db-sides {
  display: flex;
}

.db-side {
  flex: 1 1 50%;
  min-width: 0;
}

.db-side + .db-side {
  border-inline-start: 1px solid var(--d2h-line-border);
}

/*
 * diff2html's gutter as MiMo lays it out: a table cell that scrolls with the
 * code. Its 7.5em is a preferred width, so once the longest line needs the room
 * the cell gives way down to its least - one number's 3.5em and its borders -
 * and the two numbers, floated to either side of it, drop one under the other.
 * A grid whose columns every row shares keeps that, where a flex row would
 * squeeze each line on its own.
 */
.db-table {
  display: grid;
  grid-template-columns: minmax(min-content, 7.5em) minmax(max-content, 1fr);
  font-family: var(--font-mono);
  font-size: calc(13px * var(--code-font-scale, 1));
  line-height: 1.5;
}

.db-side .db-table {
  grid-template-columns: 4em minmax(max-content, 1fr);
}

.db-row {
  display: grid;
  grid-column: 1 / -1;
  grid-template-columns: subgrid;
}

.db-ln {
  box-sizing: border-box;
  overflow: hidden;
  color: var(--d2h-dim);
  text-align: end;
  background: var(--d2h-bg);
  border: solid var(--d2h-line-border);
  border-width: 0 1px;
  user-select: none;
}

/* diff2html's zero-width space, so a cell with no number still holds a line. */
.db-ln::after {
  content: "\200b";
}

.db-side .db-ln {
  padding: 0 0.5em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.db-num {
  float: inline-start;
  box-sizing: border-box;
  width: 3.5em;
  padding: 0 0.5em;
  overflow: hidden;
  text-overflow: ellipsis;
}

.db-num + .db-num {
  float: inline-end;
}

/* A line beside a gutter that stacked its two numbers sits between them, as in a table cell. */
.db-code {
  align-self: center;
  padding: 0 0.5em;
  white-space: pre;
}

.db-prefix {
  display: inline-block;
  width: 1.2em;
  user-select: none;
}

/*
 * A coloured line is coloured once, gutter and code alike, over the panel: the
 * gutter lets the row's colour through rather than laying its own on top, as
 * diff2html colours each cell once. A pair - diff2html's "change" - takes its
 * own colours, and a word only one side of it has takes the brighter pair.
 */
.db-row.add {
  background: var(--d2h-ins-bg);
}

.db-row.del {
  background: var(--d2h-del-bg);
}

.db-row.info {
  color: var(--d2h-dim);
  background: var(--d2h-info-bg);
}

.db-row.empty {
  background: var(--d2h-empty-bg);
}

.db-row:is(.add, .del, .info, .empty) .db-ln {
  background: transparent;
}

.db-row.add .db-ln {
  border-color: var(--d2h-ins-border);
}

.db-row.del .db-ln {
  border-color: var(--d2h-del-border);
}

.db-row.info .db-ln {
  border-color: var(--d2h-info-border);
}

.db-row.add .db-mark {
  background: var(--d2h-ins-bg);
  border-radius: 0.2em;
}

.db-row.del .db-mark {
  background: var(--d2h-del-bg);
  border-radius: 0.2em;
}

/*
 * The diff-marks setting, as MiMo reads it: colour alone keeps the prefix's
 * room but fades it. Faded rather than hidden, so the + or - stays in the
 * accessibility tree instead of colour being the only carrier of add/del.
 */
html[data-diff-marks="color"] .db-prefix {
  opacity: 0;
}

/* Signs alone: the lines go plain and only the gutter keeps the colour. */
html[data-diff-marks="signs"] .db-row.add,
html[data-diff-marks="signs"] .db-row.del,
html[data-diff-marks="signs"] .db-mark {
  background: transparent;
}

html[data-diff-marks="signs"] .db-row.add .db-ln {
  background: var(--d2h-ins-bg);
}

html[data-diff-marks="signs"] .db-row.del .db-ln {
  background: var(--d2h-del-bg);
}

/* MiMo's cap note: 12px muted, under the diff. */
.db-cap {
  padding: 4px 10px;
  color: var(--text-base);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 1.6;
}
</style>
