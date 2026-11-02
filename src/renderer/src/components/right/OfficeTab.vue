<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue"
import type { RightTab } from "../../stores/right-panel"
import { useOfficeVersions } from "../../stores/office-versions"
import { useApp } from "../../stores/app"
import { notify, notifyFailure } from "../../lib/toast"
import { fileManagerName } from "../../lib/path-open"
import { t } from "../../lib/i18n"
import LucideIcon from "../LucideIcon.vue"
import PdfView from "./PdfView.vue"
import DocxView from "./DocxView.vue"
import PptxView from "./PptxView.vue"
import XlsxView from "./XlsxView.vue"
import OfficeFallback from "./OfficeFallback.vue"
import VersionHistory from "./VersionHistory.vue"

/**
 * MiMo's Office tab: a head naming the document - its kind's icon, the name,
 * "· Word · 1.2 MB" - with undo, redo and the version history for the kinds
 * that keep one, "present" for slides, and "open folder"; under it the
 * document's own view, or the structured fallback when that view gives up.
 */
const props = defineProps<{ tab: RightTab; active: boolean }>()
const versions = useOfficeVersions()
const app = useApp()

const TYPES = {
  xlsx: { icon: "file-spreadsheet", color: "#21a366", label: "Excel" },
  docx: { icon: "file-text", color: "#2b6cb0", label: "Word" },
  pptx: { icon: "presentation", color: "#c43e1c", label: "PPT" },
  pdf: { icon: "file-type", color: "#d93831", label: "PDF" },
} as const

const path = computed(() => props.tab.filePath ?? "")
const type = computed(() => props.tab.fileType)
const info = computed(() => (type.value ? TYPES[type.value] : undefined))
const fallback = reactive({ xlsx: false, docx: false, pptx: false })
watch(path, () => {
  fallback.xlsx = false
  fallback.docx = false
  fallback.pptx = false
})

/* MiMo keeps a spreadsheet's undo, redo and history even on the structured fallback. */
const versioned = computed(
  () => type.value === "xlsx" || (type.value === "docx" && !fallback.docx) || (type.value === "pptx" && !fallback.pptx) || type.value === "pdf",
)

function sizeText(bytes: number | undefined) {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return ""
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const meta = computed(() => {
  const size = sizeText(props.tab.size)
  return `  · ${info.value?.label ?? ""}${size ? ` · ${size}` : ""}`
})

const history = ref<DOMRect | null>(null)
function toggleHistory(event: MouseEvent) {
  history.value = history.value ? null : (event.currentTarget as HTMLElement).getBoundingClientRect()
}

const viewer = ref<{ enterPresent?: () => void }>()

async function reveal() {
  // Hold the toast to the place the person started from; leaving mid-await
  // must not flash the reveal outcome onto another conversation.
  const held = app.currentID
  const result = await window.mcode.revealPath(path.value)
  if (app.currentID !== held) return
  // MiMo names the platform's file manager; the generic wording is only for a platform not yet known.
  if (result.ok) notify(app.platform ? t("menu.revealedIn", { manager: fileManagerName(app.platform) }) : t("office.revealed"))
  else notifyFailure(t("office.revealFail", { err: result.error ?? "" }))
}
</script>

<template>
  <div class="office-tab" data-office-tab>
    <div v-if="tab.converting" class="office-message">{{ t("office.convertingLegacy") }}</div>
    <div v-else-if="!path || !info" class="office-message">{{ t("office.noFile") }}</div>
    <template v-else>
      <div class="office-head">
        <span class="office-type" :style="{ color: info.color }"><LucideIcon :name="info.icon" :size="16" /></span>
        <span class="office-title">
          <span class="office-name">{{ tab.name }}</span>
          <span class="office-meta" data-office-meta>{{ meta }}</span>
        </span>
        <template v-if="versioned">
          <button
            type="button"
            class="fc-btn"
            data-office-undo
            :title="t('office.undo')"
            :disabled="!versions.canUndo(path)"
            :style="versions.canUndo(path) ? undefined : { opacity: 0.4 }"
            @click="versions.undo(path)"
          >
            <LucideIcon name="undo-2" :size="15" />
          </button>
          <button
            type="button"
            class="fc-btn"
            data-office-redo
            :title="t('office.redo')"
            :disabled="!versions.canRedo(path)"
            :style="versions.canRedo(path) ? undefined : { opacity: 0.4 }"
            @click="versions.redo(path)"
          >
            <LucideIcon name="redo-2" :size="15" />
          </button>
          <button type="button" class="fc-btn" data-office-history :title="t('office.history')" @click="toggleHistory">
            <LucideIcon name="history" :size="15" />
          </button>
        </template>
        <button v-if="type === 'pptx' && !fallback.pptx" type="button" class="fc-btn" :title="t('office.pptxPresent')" @click="viewer?.enterPresent?.()">
          <LucideIcon name="play" :size="15" />
        </button>
        <button type="button" class="fc-btn" data-office-folder :title="t('office.openFolder')" @click="reveal">
          <LucideIcon name="folder-open" :size="15" />
        </button>
      </div>
      <div class="office-body">
        <PdfView v-if="type === 'pdf'" :path="path" :name="tab.name ?? ''" :origin="tab.origin" :active="active" />
        <DocxView v-else-if="type === 'docx' && !fallback.docx" :path="path" :name="tab.name ?? ''" :origin="tab.origin" :active="active" @fallback="fallback.docx = true" />
        <XlsxView v-else-if="type === 'xlsx' && !fallback.xlsx" :path="path" :name="tab.name ?? ''" :origin="tab.origin" :active="active" @fallback="fallback.xlsx = true" />
        <PptxView
          v-else-if="type === 'pptx' && !fallback.pptx"
          ref="viewer"
          :path="path"
          :name="tab.name ?? ''"
          :origin="tab.origin"
          :active="active"
          @fallback="fallback.pptx = true"
        />
        <OfficeFallback v-else :type="type" />
      </div>
      <VersionHistory v-if="history" :path="path" :anchor="history" @close="history = null" />
    </template>
  </div>
</template>

<style scoped>
.office-tab {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  color: var(--text-strong);
  background: var(--surface-raised);
}

.office-message {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  width: 100%;
  padding: 20px;
  color: var(--text-base);
  font-size: 13px;
  text-align: center;
}

.office-head {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-weak);
}

.office-type {
  display: flex;
  flex-shrink: 0;
}

.office-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.office-name {
  font-weight: 600;
}

/*
 * MiMo writes the two spaces before the separator into its markup and lets
 * normal white-space collapse them; holding them with `pre` printed a double
 * space nothing in MiMo has.
 */
.office-meta {
  color: var(--text-base);
  font-size: 12px;
}

/* MiMo's .fc-btn with the tab's override: 5 by 8, a 1px line on an 8px corner. */
.fc-btn {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  color: var(--text-body);
  background: var(--surface-page);
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  font: inherit;
  font-size: calc(12px * var(--ui-font-scale, 1));
  white-space: nowrap;
}

/* As MiMo's rule, which also fills a disabled button under the pointer. */
.fc-btn:hover {
  background: var(--surface-hover);
}

.fc-btn:disabled {
  opacity: 0.55;
  cursor: default;
}

.office-body {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: var(--surface-raised);
}

</style>
