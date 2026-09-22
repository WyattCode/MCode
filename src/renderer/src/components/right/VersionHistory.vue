<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import { useOfficeVersions } from "../../stores/office-versions"
import { dateIn, t, tn } from "../../lib/i18n"
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
  if (seconds < 60) return t("time.justNow")
  if (seconds < 3600) return tn("time.minutesAgo", Math.floor(seconds / 60))
  if (seconds < 86400) return tn("time.hoursAgo", Math.floor(seconds / 3600))
  if (seconds < 7 * 86400) return tn("time.daysAgo", Math.floor(seconds / 86400))
  // The date in the interface language, like every other date in the app, not the OS locale.
  return dateIn(ts)
}

function noteOf(source: string, raw: string) {
  // A note of blanks is no note: the row falls back to the default wording.
  const note = (raw ?? "").trim()
  if (source === "ai" || source === "ai_local") return !note || note === t("office.versionNoteAi") ? t("office.versionNoteAi") : `${t("office.versionSourceAi")}${note}`
  if (source === "user") return note ? `${t("office.versionSourceUser")}${note}` : t("office.versionNoteUser")
  if (source === "external") return t("office.versionSourceExternal")
  return t("office.versionSourceInitial")
}

function iconOf(source: string) {
  if (source === "ai" || source === "ai_local") return { name: "bot", color: "#7c4dff" }
  if (source === "user") return { name: "pencil", color: "#2b6cb0" }
  return { name: "file-clock", color: source === "external" ? "#c43e1c" : "var(--text-base)" }
}

function revert(index: number) {
  const list = state.value?.versions ?? []
  const before = list[index - 1]
  if (before) void versions.restore(props.path, before.id)
  emit("close")
}

/* The whole note, when the row cuts it short: under the note's column (note and badge), as MiMo places it. */
const tip = ref<{ text: string; left: number; top: number } | null>(null)
function hover(event: MouseEvent, text: string) {
  const middle = event.currentTarget as HTMLElement
  const note = middle.querySelector<HTMLElement>("[data-note]")
  if (!note || note.scrollWidth <= note.clientWidth + 1) return
  const box = middle.getBoundingClientRect()
  tip.value = { text, left: Math.max(8, Math.min(box.left, window.innerWidth - 300 - 8)), top: Math.min(box.bottom + 4, window.innerHeight - 60) }
}

function onKey(event: KeyboardEvent) {
  if (event.key === "Escape") emit("close")
}

/*
 * A press anywhere else closes the list - except on the history button, which
 * closes it itself. Closing here first would leave that button's own click
 * looking at a shut list and open it again, so the button could never shut it.
 */
function onDown(event: MouseEvent) {
  const target = event.target as Element | null
  if (target?.closest?.("[data-version-pop]") || target?.closest?.("[data-office-history]")) return
  emit("close")
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
          <div class="vp-middle" @mouseenter="hover($event, noteOf(row.version.source, row.version.note))" @mouseleave="tip = null">
            <span class="vp-note" data-note>
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
  z-index: 10000;
  display: flex;
  flex-direction: column;
  width: 340px;
  max-height: 320px;
  padding: 8px;
  overflow: hidden;
  /* MiMo --color-txt (#151c13cc / #f4f4f5); lane F1 is adding the token. */
  color: #151c13cc;
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.12);
}

/* MiMo's head carries no rule under it: the 8 below the title is all there is. */
.vp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 6px 8px;
}

.vp-title {
  font-size: 13px;
  font-weight: 600;
}

.vp-close {
  display: grid;
  place-items: center;
  padding: 4px;
  color: var(--text-base);
  background: transparent;
  border: none;
}

.vp-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow: auto;
}

.vp-empty {
  padding: 16px;
  color: var(--text-base);
  font-size: 13px;
  text-align: center;
}

.vp-initial {
  font-size: 12px;
}

.vp-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 4px;
  border-radius: 8px;
}

.vp-left {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  align-items: center;
  gap: 2px;
  width: 44px;
}

.vp-icon {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
}

.vp-time {
  color: var(--text-base);
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
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* MiMo's pill keeps its one teal pair in both themes. */
.vp-current {
  flex-shrink: 0;
  margin-left: 6px;
  padding: 1px 6px;
  color: #0f766e;
  background: #e8f5f3;
  border-radius: 999px;
  font-size: 10px;
  white-space: nowrap;
}

.vp-restore {
  flex-shrink: 0;
  padding: 4px 8px;
  color: inherit;
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: 6px;
  font-size: 12px;
}

.vp-tip {
  position: fixed;
  z-index: 10001;
  max-width: 300px;
  padding: 6px 8px;
  color: #fff;
  background: rgba(15, 23, 42, 0.92);
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.5;
  white-space: normal;
  /* A long unbroken note (a path, an address) wraps inside the box. */
  word-break: break-word;
  overflow-wrap: anywhere;
  pointer-events: none;
}

/* MiMo's --color-txt is #f4f4f5 in dark, not a translucent white. */
:root[data-theme="dark"] .version-pop {
  color: #f4f4f5;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .version-pop {
    color: #f4f4f5;
  }
}
</style>
