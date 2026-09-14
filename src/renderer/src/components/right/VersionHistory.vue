<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import { useOfficeVersions } from "../../stores/office-versions"
import { t } from "../../lib/i18n"
import LucideIcon from "../LucideIcon.vue"

/**
 * MiMo's version history list for a document: under the history button, 320
 * wide, newest change first (the first version is where the history starts,
 * so it is not a row). Each row says who made the change and when, marks the
 * current one, and "revert" goes back to the version before that change.
 */
const props = defineProps<{ path: string; anchor: DOMRect }>()
const emit = defineEmits<{ close: [] }>()
const versions = useOfficeVersions()

const state = computed(() => versions.byPath[props.path])
const rows = computed(() => {
  const list = state.value?.versions ?? []
  return list.map((version, index) => ({ version, index })).filter((row) => row.index >= 1).reverse()
})

const style = computed(() => ({
  left: `${Math.max(8, Math.min(props.anchor.right - 320, window.innerWidth - 328))}px`,
  top: `${Math.min(props.anchor.bottom + 6, window.innerHeight - 120)}px`,
}))

function when(ts: number) {
  const seconds = Math.floor((Date.now() - ts) / 1000)
  if (seconds < 60) return t("office.timeJustNow")
  if (seconds < 3600) return t("office.timeMinAgo", { n: Math.floor(seconds / 60) })
  if (seconds < 86400) return t("office.timeHourAgo", { n: Math.floor(seconds / 3600) })
  if (seconds < 7 * 86400) return t("office.timeDayAgo", { n: Math.floor(seconds / 86400) })
  return new Date(ts).toLocaleDateString()
}

function noteOf(source: string, note: string) {
  if (source === "ai" || source === "ai_local") return !note || note === t("office.versionNoteAi") ? t("office.versionNoteAi") : `${t("office.versionSourceAi")}${note}`
  if (source === "user") return note ? `${t("office.versionSourceUser")}${note}` : t("office.versionNoteUser")
  if (source === "external") return t("office.versionSourceExternal")
  return t("office.versionSourceInitial")
}

function iconOf(source: string) {
  if (source === "ai" || source === "ai_local") return { name: "bot", color: "#7c4dff" }
  if (source === "user") return { name: "pencil", color: "#2b6cb0" }
  return { name: "file-clock", color: source === "external" ? "#c43e1c" : "var(--text-weak)" }
}

function revert(index: number) {
  const list = state.value?.versions ?? []
  const before = list[index - 1]
  if (before) void versions.restore(props.path, before.id)
  emit("close")
}

/* The whole note, when the row cuts it short. */
const tip = ref<{ text: string; left: number; top: number } | null>(null)
function hover(event: MouseEvent, text: string) {
  const note = event.currentTarget as HTMLElement
  if (note.scrollWidth <= note.clientWidth + 1) return
  const row = (note.closest("[data-version-row]") as HTMLElement).getBoundingClientRect()
  tip.value = { text, left: Math.max(8, Math.min(row.left, window.innerWidth - 320)), top: Math.min(row.bottom + 4, window.innerHeight - 60) }
}

function onKey(event: KeyboardEvent) {
  if (event.key === "Escape") emit("close")
}

function onDown(event: MouseEvent) {
  if (!(event.target as Element | null)?.closest?.("[data-version-pop]")) emit("close")
}

onMounted(() => {
  document.addEventListener("keydown", onKey)
  document.addEventListener("mousedown", onDown, true)
})
onBeforeUnmount(() => {
  document.removeEventListener("keydown", onKey)
  document.removeEventListener("mousedown", onDown, true)
})
</script>

<template>
  <Teleport to="body">
    <div class="version-pop" data-version-pop :style="style">
      <div class="vp-head">
        <span class="vp-title">{{ t("office.history") }}</span>
        <button type="button" class="vp-close" :aria-label="t('office.historyClose')" @click="emit('close')">
          <LucideIcon name="x" :size="14" />
        </button>
      </div>
      <div class="vp-list">
        <div v-if="!rows.length" class="vp-empty">{{ t("office.versionEmpty") }}</div>
        <div v-for="row in rows" :key="row.version.id" class="vp-row" data-version-row>
          <div class="vp-left">
            <span class="vp-icon" :style="{ color: iconOf(row.version.source).color }">
              <LucideIcon :name="iconOf(row.version.source).name" :size="15" />
            </span>
            <span class="vp-time">{{ when(row.version.ts) }}</span>
          </div>
          <div class="vp-middle">
            <span class="vp-note" data-note @mouseenter="hover($event, noteOf(row.version.source, row.version.note))" @mouseleave="tip = null">
              {{ noteOf(row.version.source, row.version.note) }}
            </span>
            <span v-if="row.index === state?.cursor" class="vp-current" data-current-badge>{{ t("office.versionCurrent") }}</span>
          </div>
          <button type="button" class="vp-restore" @click="revert(row.index)">{{ t("office.versionRestore") }}</button>
        </div>
        <div v-if="state?.cursor === 0" class="vp-empty vp-initial">{{ t("office.versionAtInitial") }}</div>
      </div>
    </div>
    <div v-if="tip" class="vp-tip" :style="{ left: `${tip.left}px`, top: `${tip.top}px` }">{{ tip.text }}</div>
  </Teleport>
</template>

<style scoped>
.version-pop {
  position: fixed;
  z-index: 4000;
  display: flex;
  flex-direction: column;
  width: 320px;
  max-height: 420px;
  overflow: hidden;
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 12px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18);
}

.vp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 12px;
  border-bottom: 1px solid var(--border-weak);
}

.vp-title {
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 600;
}

.vp-close {
  display: grid;
  place-items: center;
  padding: 2px;
  color: var(--text-weak);
  background: transparent;
  border: none;
}

.vp-list {
  padding: 4px 0;
  overflow: auto;
}

.vp-empty {
  padding: 18px 12px;
  color: var(--text-weak);
  font-size: 13px;
  text-align: center;
}

.vp-initial {
  font-size: 12px;
}

.vp-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
}

.vp-left {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  align-items: center;
  gap: 2px;
  width: 40px;
}

.vp-icon {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
}

.vp-time {
  color: var(--text-weak);
  font-size: 10px;
  white-space: nowrap;
}

.vp-middle {
  display: flex;
  flex: 1;
  align-items: center;
  min-width: 0;
}

.vp-note {
  overflow: hidden;
  color: var(--text-strong);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vp-current {
  flex-shrink: 0;
  margin-left: 6px;
  padding: 0 4px;
  color: #ff6a2b;
  border: 1px solid #ff6a2b;
  border-radius: 4px;
  font-size: 10px;
  white-space: nowrap;
}

.vp-restore {
  flex-shrink: 0;
  padding: 3px 9px;
  color: var(--text-strong);
  background: transparent;
  border: 1px solid var(--border-weak);
  border-radius: 7px;
  font-size: 12px;
}

.vp-tip {
  position: fixed;
  z-index: 4001;
  max-width: 300px;
  padding: 6px 10px;
  color: var(--text-strong);
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
  font-size: 12px;
  line-height: 1.5;
  white-space: normal;
  pointer-events: none;
}
</style>
