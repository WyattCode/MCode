<script setup lang="ts">
import { ref } from "vue"
import { DIFF_LAYOUT_KEY, normalizeLayout, type DiffLayout } from "../../lib/diff-view"
import DiffBody from "../parts/DiffBody.vue"
import { t } from "../../lib/i18n"

/**
 * MiMo's diff tab: a bar choosing one column or two, over the diff itself.
 *
 * The diff is the same component a turn's step and a permission card draw,
 * filled to the pane here as MiMo fills its own - so a patch reads the same
 * wherever it is shown.
 */
defineProps<{ diff: string }>()

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

    <DiffBody :diff="diff" :layout="layout" fill />
  </div>
</template>

<style scoped>
/* MiMo's rp-diff-body is 14px in and fills the tab. */
.dt {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  padding: 14px;
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
  /* MiMo's bg-code-bg, which lifts in dark (#2e2e2e) rather than sinking. */
  background: var(--surface-layer);
  border-radius: 7px;
}

.dt-seg-btn {
  padding: 2px 8px;
  color: var(--text-base);
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
</style>
