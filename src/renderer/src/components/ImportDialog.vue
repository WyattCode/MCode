<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { IMPORT_SOURCES, type ImportRun, type ImportScan, type ImportSource } from "@shared/protocol"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"
import { useEscapeLayer } from "../lib/escape-layer"

/**
 * MiMo's 从其他 AI 应用导入, shown once on a first run.
 *
 * Four states, in its order: detecting the apps, choosing which of them to take
 * from, the import itself (which keeps going if this window is closed), and
 * what each source gave. The apps' own data is only ever read; what this window
 * is shown is counts, never a title or a path out of another app.
 */
const emit = defineEmits<{ close: [] }>()

const app = useApp()

type State =
  | { name: "scanning" }
  | { name: "select"; scan: ImportScan }
  | { name: "running" }
  | { name: "done"; result: ImportRun; sources: ImportSource[] }
  | { name: "error"; message: string }

const state = ref<State>({ name: "scanning" })
const on = ref<Record<ImportSource, boolean>>({ cc: false, codex: false, opencode: false })

/** The three apps in MiMo's order, each with the mark it draws for them. */
const APPS: { key: ImportSource; name: string; mark: string }[] = [
  { key: "cc", name: "Claude Code", mark: "</>" },
  { key: "codex", name: "Codex", mark: "◎" },
  { key: "opencode", name: "OpenCode", mark: "⌬" },
]

const found = computed(() => (state.value.name === "select" ? APPS.filter((entry) => state.value.name === "select" && (state.value as { scan: ImportScan }).scan[entry.key].available) : []))

const chosen = computed(() => IMPORT_SOURCES.filter((source) => on.value[source]))

const title = computed(() => {
  if (state.value.name === "running") return t("import.titleImporting")
  if (state.value.name === "done") return t("import.titleDone")
  if (state.value.name === "error") return t("import.titleError")
  return t("import.title")
})

async function scan() {
  state.value = { name: "scanning" }
  try {
    const answer = await app.client?.request({ type: "import.scan" })
    if (!answer) throw new Error(t("common.requestFailed"))
    // Every app that has something is offered ticked, as MiMo offers them.
    on.value = {
      cc: answer.scan.cc.sessions > 0,
      codex: answer.scan.codex.sessions > 0,
      opencode: answer.scan.opencode.sessions > 0,
    }
    state.value = { name: "select", scan: answer.scan }
  } catch (failure) {
    state.value = { name: "error", message: failure instanceof Error ? failure.message : String(failure) }
  }
}

async function run() {
  const sources = chosen.value
  if (!sources.length) {
    emit("close")
    return
  }
  state.value = { name: "running" }
  try {
    const answer = await app.client?.request({ type: "import.run", sources: [...sources] })
    if (!answer) throw new Error(t("common.requestFailed"))
    // Each conversation announced itself as it was written, so the side column already has them.
    state.value = { name: "done", result: answer.result, sources: [...sources] }
  } catch (failure) {
    state.value = { name: "error", message: failure instanceof Error ? failure.message : String(failure) }
  }
}

function counts(source: ImportSource) {
  const scan = state.value.name === "select" ? state.value.scan : undefined
  return scan?.[source] ?? { available: false, sessions: 0, imported: 0 }
}

function resultOf(source: ImportSource) {
  const result = state.value.name === "done" ? state.value.result[source] : undefined
  return result ?? { scanned: 0, imported: 0, resynced: 0, skipped: 0, errors: [] }
}

const doneRows = computed(() => (state.value.name === "done" ? APPS.filter((entry) => (state.value as { sources: ImportSource[] }).sources.includes(entry.key)) : []))

function toggle(source: ImportSource) {
  on.value = { ...on.value, [source]: !on.value[source] }
}

// Escape closes it, as it closes every other dialog; an import already running keeps going.
useEscapeLayer(() => emit("close"))

onMounted(() => void scan())
</script>

<template>
  <div class="scrim" @mousedown.self="emit('close')">
    <div v-modal class="card" data-import-dialog :data-import-state="state.name" role="dialog" aria-labelledby="import-title">
      <div class="head">
        <h2 id="import-title" class="title" data-import-title>{{ title }}</h2>
        <button type="button" class="close" data-import-close :aria-label="t('common.close')" @click="emit('close')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          </svg>
        </button>
      </div>

      <div v-if="state.name === 'scanning'" class="waiting">
        <span class="spinner" aria-hidden="true" />
        <span class="hint">{{ t("import.scanning") }}</span>
      </div>

      <div v-else-if="state.name === 'error'" class="hint" data-import-error>{{ state.message }}</div>

      <template v-else-if="state.name === 'select'">
        <template v-if="found.length">
          <div class="section">{{ t("import.foundApps") }}</div>
          <div v-for="entry in found" :key="entry.key" class="row" :data-import-row="entry.key">
            <span class="mark" :class="entry.key" aria-hidden="true">{{ entry.mark }}</span>
            <span class="copy">
              <span class="name">{{ entry.name }}</span>
              <span class="desc" :data-import-counts="entry.key">
                {{ t("import.sessions", { count: String(counts(entry.key).sessions) }) }}
                <template v-if="counts(entry.key).imported > 0">
                  {{ t("import.alreadyImported", { count: String(counts(entry.key).imported) }) }}
                </template>
                <template v-if="counts(entry.key).imported > counts(entry.key).sessions">
                  {{ t("import.importedExceeds") }}
                </template>
              </span>
            </span>
            <button
              type="button"
              class="switch"
              :class="{ on: on[entry.key] }"
              role="switch"
              :aria-checked="on[entry.key]"
              :aria-label="entry.name"
              :data-import-toggle="entry.key"
              @click="toggle(entry.key)"
            >
              <span class="knob" />
            </button>
          </div>
          <div class="note">{{ t("import.note") }}</div>
        </template>
        <div v-else class="hint" data-import-none>{{ t("import.noApps") }}</div>
      </template>

      <div v-else-if="state.name === 'running'" class="waiting">
        <span class="spinner" aria-hidden="true" />
        <span class="hint">{{ t("import.running") }}</span>
        <span class="hint weak">{{ t("import.runningHint") }}</span>
      </div>

      <template v-else-if="state.name === 'done'">
        <div v-for="entry in doneRows" :key="entry.key" class="row done" :data-import-done="entry.key">
          <span class="mark" :class="entry.key" aria-hidden="true">{{ entry.mark }}</span>
          <span class="copy">
            <span class="name">{{ entry.name }}</span>
            <span class="desc" :data-import-stats="entry.key">
              {{
                t("import.stats", {
                  scanned: String(resultOf(entry.key).scanned),
                  imported: String(resultOf(entry.key).imported),
                  resynced: String(resultOf(entry.key).resynced),
                  skipped: String(resultOf(entry.key).skipped),
                })
              }}
              <span v-if="resultOf(entry.key).errors.length" class="errors">
                {{ t("import.errors", { count: String(resultOf(entry.key).errors.length) }) }}
              </span>
            </span>
          </span>
          <span class="tick" aria-hidden="true">✓</span>
        </div>
        <div class="note" data-import-where>{{ t("import.doneWhere") }}</div>
      </template>

      <div class="actions">
        <template v-if="state.name === 'select'">
          <button type="button" class="btn" data-import-cancel @click="emit('close')">{{ t("common.cancel") }}</button>
          <button type="button" class="btn primary" data-import-continue @click="run">{{ t("import.continue") }}</button>
        </template>
        <template v-else-if="state.name === 'error'">
          <button type="button" class="btn" data-import-close-error @click="emit('close')">{{ t("common.close") }}</button>
          <button type="button" class="btn primary" data-import-retry @click="scan">{{ t("common.retry") }}</button>
        </template>
        <button v-else-if="state.name === 'done'" type="button" class="btn primary" data-import-done-close @click="emit('close')">
          {{ t("import.done") }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 130;
  display: grid;
  place-items: center;
  background: var(--scrim);
}

/* MiMo's import card: 520 wide on a 16px corner, 24 inside. */
.card {
  box-sizing: border-box;
  width: min(520px, 92vw);
  padding: 24px;
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 16px;
  box-shadow: var(--shadow-overlay);
}

.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 16px;
}

.title {
  margin: 0;
  color: var(--text-strong);
  font-size: calc(17px * var(--ui-font-scale, 1));
  font-weight: 400;
}

.close {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  color: var(--text-weak);
  background: transparent;
  border: 0;
  border-radius: 6px;
  cursor: pointer;
}

.close:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.waiting {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding-block: 12px;
}

.spinner {
  width: 18px;
  height: 18px;
  border: 2px solid var(--border-weak);
  border-top-color: var(--text-weak);
  border-radius: 50%;
  animation: import-spin 0.9s linear infinite;
}

@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation: none;
  }
}

@keyframes import-spin {
  to {
    transform: rotate(360deg);
  }
}

.hint {
  color: var(--text-weak);
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: 1.6;
  text-align: center;
}

.hint.weak {
  opacity: 0.8;
}

.section {
  margin-bottom: 8px;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.row {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 10px 0;
  border-top: 1px solid var(--border-weak);
}

.row:first-of-type {
  border-top: 0;
}

/* The three apps' marks: a square of the sunken ground with the sign MiMo draws for each. */
.mark {
  display: grid;
  flex: none;
  place-items: center;
  width: 32px;
  height: 32px;
  color: var(--text-weak);
  font-family: var(--font-mono);
  font-size: calc(13px * var(--code-font-scale, 1));
  background: var(--surface-sunken);
  border-radius: 8px;
}

.copy {
  flex: 1;
  min-width: 0;
}

.name {
  display: block;
  color: var(--text-strong);
  font-size: calc(14px * var(--ui-font-scale, 1));
}

.desc {
  display: block;
  margin-top: 2px;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.errors {
  color: var(--error);
}

.switch {
  position: relative;
  flex: none;
  width: 38px;
  height: 22px;
  padding: 0;
  background: var(--surface-sunken);
  border: 1px solid var(--border-weak);
  border-radius: 999px;
  cursor: pointer;
  transition: background-color 0.15s;
}

.switch.on {
  background: var(--button-primary);
  border-color: var(--button-primary);
}

.knob {
  position: absolute;
  inset-block-start: 2px;
  inset-inline-start: 2px;
  width: 16px;
  height: 16px;
  background: var(--surface-raised);
  border-radius: 50%;
  transition: inset-inline-start 0.15s;
}

.switch.on .knob {
  inset-inline-start: 18px;
}

.tick {
  flex: none;
  color: var(--success);
  font-size: calc(14px * var(--ui-font-scale, 1));
}

.note {
  margin-top: 12px;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 1.6;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 6px;
  padding-top: 16px;
}

.btn {
  padding: 8px 18px;
  color: var(--text-base);
  font: inherit;
  font-size: calc(14px * var(--ui-font-scale, 1));
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  cursor: pointer;
}

.btn:hover {
  background: var(--surface-hover);
}

.btn.primary {
  color: var(--button-primary-text);
  background: var(--button-primary);
  border-color: var(--button-primary);
}

.btn.primary:hover {
  opacity: 0.9;
}
</style>
