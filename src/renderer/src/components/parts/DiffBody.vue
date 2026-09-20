<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue"
import { capDiff, displayName, markWords, parseDiffFiles, splitPath, splitRows, type DiffLayout } from "../../lib/diff-view"
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
}>()

const capped = computed(() => capDiff(props.diff))
const files = computed(() =>
  parseDiffFiles(capped.value.text).map((file) => ({
    ...file,
    path: splitPath(displayName(file)),
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

/* Folded files, by name, so a new patch for the same tab keeps what was folded. */
const collapsed = ref(new Set<string>())

/*
 * The files ticked off as read.
 *
 * MiMo's tick is diff2html's own checkbox and nothing more: it is not written
 * down anywhere, it does not fold the file, and the whole diff is drawn again
 * whenever the patch or the layout changes, which clears every tick. So it is
 * held here for this drawing of this patch alone.
 */
const viewed = ref(new Set<string>())

function markViewed(name: string, on: boolean) {
  const next = new Set(viewed.value)
  if (on) next.add(name)
  else next.delete(name)
  viewed.value = next
}

watch(
  () => `${props.layout ?? ""}:${capped.value.text}`,
  () => {
    viewed.value = new Set()
  },
)

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
      <ol v-if="fill" class="db-list" data-diff-file-list>
        <li
          v-for="(file, index) in files"
          :key="`list:${file.name}:${index}`"
          class="db-list-line"
          role="button"
          tabindex="0"
          @click="reveal(index)"
          @keydown.enter.space.self.prevent="reveal(index, true)"
        >
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
          <label class="db-viewed" data-diff-viewed @click.stop @keydown.stop>
            <input type="checkbox" :checked="viewed.has(file.name)" @change="markViewed(file.name, ($event.target as HTMLInputElement).checked)" />
            {{ t("rp.diff.viewed") }}
          </label>
        </div>

        <div v-if="!collapsed.has(file.name) && layout !== 'split'" class="db-body" :data-diff-scroll="`${file.name}\u0000u`">
          <div class="db-table">
            <template v-for="(hunk, h) in file.rows" :key="h">
              <div class="db-row info">
                <span class="db-ln" /><span class="db-ln" />
                <span class="db-code">{{ hunk.header }}</span>
              </div>
              <div v-for="(line, l) in hunk.lines" :key="`${h}:${l}`" class="db-row" :class="[line.kind, { marked: Boolean(line.marks) }]">
                <span class="db-ln">{{ line.old ?? "" }}</span>
                <span class="db-ln">{{ line.new ?? "" }}</span>
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
                  :class="[pair[side] ? pair[side]!.kind : 'empty', { marked: Boolean(pair[side]?.marks) }]"
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
 * MiMo's GitHub-dark set under the dark theme.
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
  background: var(--d2h-bg);
  border: 1px solid var(--d2h-border);
  border-radius: 8px;
}

.db-scroll.fill {
  flex: 1;
  max-height: none;
  min-height: 0;
  border: 0;
}

:root[data-theme="dark"] .db-scroll {
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
  :root:not([data-theme="light"]) .db-scroll {
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

.db-raw {
  margin: 0;
  padding: 9px 12px;
  font-family: var(--font-mono);
  font-size: calc(12px * var(--code-font-scale, 1));
  white-space: pre-wrap;
}

/* The file list: a line per file, a rule between. */
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

/* The word for what the patch did, beside the name. */
.db-tag {
  flex: none;
  margin-inline-start: 8px;
  padding: 1px 6px;
  border: 1px solid currentcolor;
  border-radius: 6px;
  font-size: calc(11px * var(--ui-font-scale, 1));
  line-height: 1.5;
  text-transform: uppercase;
  white-space: nowrap;
  opacity: 0.85;
}

.db-tag.added {
  color: var(--d2h-ins-label);
}

.db-tag.deleted {
  color: var(--d2h-del-label);
}

/* Ticked off as read: MiMo's own box, which does nothing but stay ticked. */
.db-viewed {
  display: flex;
  flex: none;
  gap: 5px;
  align-items: center;
  margin-inline-start: auto;
  color: var(--d2h-dim);
  font-size: calc(12px * var(--ui-font-scale, 1));
  cursor: pointer;
  user-select: none;
}

.db-viewed input {
  margin: 0;
  cursor: pointer;
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

.db-table {
  min-width: max-content;
  font-family: var(--font-mono);
  font-size: calc(13px * var(--code-font-scale, 1));
  line-height: 1.5;
}

.db-row {
  display: flex;
}

.db-ln {
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

.db-ln + .db-ln {
  inset-inline-start: 3.5em;
}

.db-side .db-ln {
  width: 4em;
}

.db-code {
  flex: 1;
  padding: 0 0.5em;
  white-space: pre;
}

.db-prefix {
  display: inline-block;
  width: 1.2em;
  user-select: none;
}

.db-row.add,
.db-row.add .db-ln {
  background: var(--d2h-ins-bg);
  border-color: var(--d2h-ins-border);
}

.db-row.del,
.db-row.del .db-ln {
  background: var(--d2h-del-bg);
  border-color: var(--d2h-del-border);
}

/*
 * A pair that was marked word by word: the line itself steps back so the words
 * only one side has are what the eye lands on, MiMo's own emphasis drawn in
 * this app's diff colours.
 */
.db-row.add.marked,
.db-row.add.marked .db-ln {
  background: color-mix(in srgb, var(--d2h-ins-bg) 55%, var(--d2h-bg));
}

.db-row.del.marked,
.db-row.del.marked .db-ln {
  background: color-mix(in srgb, var(--d2h-del-bg) 55%, var(--d2h-bg));
}

.db-row.add .db-mark {
  background: color-mix(in srgb, var(--d2h-ins-label) 32%, transparent);
  border-radius: 0.2em;
}

.db-row.del .db-mark {
  background: color-mix(in srgb, var(--d2h-del-label) 32%, transparent);
  border-radius: 0.2em;
}

.db-row.info,
.db-row.info .db-ln {
  color: var(--d2h-dim);
  background: var(--d2h-info-bg);
  border-color: var(--d2h-info-border);
}

.db-row.empty,
.db-row.empty .db-ln {
  background: var(--d2h-empty-bg);
}

/* The diff-marks setting, as MiMo reads it: colour alone keeps the prefix's room but blanks it. */
html[data-diff-marks="color"] .db-prefix {
  visibility: hidden;
}

html[data-diff-marks="signs"] .db-row.add,
html[data-diff-marks="signs"] .db-row.del,
html[data-diff-marks="signs"] .db-row.marked,
html[data-diff-marks="signs"] .db-mark {
  background: transparent;
}

/* MiMo's cap note: 12px muted, under the diff. */
.db-cap {
  padding: 4px 10px;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 1.6;
}
</style>
