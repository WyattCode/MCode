<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import { LAB_TASK_SET, type LabHistoryEntry, type LabState } from "@shared/lab"
import { t } from "../lib/i18n"
import { useApp } from "../stores/app"

const app = useApp()
const state = ref<LabState>()
const set = ref(LAB_TASK_SET)
const rounds = ref(1)
const concurrency = ref(2)
const pending = ref(false)
const error = ref("")
const pollError = ref("")
const historyID = ref("")
const run = computed(() => (state.value?.selected?.id === historyID.value && state.value.selected) || state.value?.current)
const busy = computed(() => state.value?.current?.status === "running" || state.value?.current?.status === "stopping")
const canStart = computed(() =>
  app.platform === "linux" && app.current && !app.current.scratch && state.value &&
  Number.isInteger(rounds.value) && rounds.value >= 1 && rounds.value <= state.value.taskCount &&
  Number.isInteger(concurrency.value) && concurrency.value >= 1 && concurrency.value <= state.value.maxConcurrency,
)
let timer: ReturnType<typeof setTimeout> | undefined
let disposed = false

async function refresh() {
  if (!app.client) return
  const id = historyID.value || undefined
  const result = await app.client.request({ type: "lab.state", id })
  if (!disposed && (historyID.value || undefined) === id) state.value = result
}

async function poll() {
  try {
    await refresh()
    pollError.value = ""
  } catch (failure) {
    pollError.value = String(failure)
  } finally {
    if (!disposed) timer = setTimeout(poll, 1000)
  }
}

onMounted(poll)
onBeforeUnmount(() => {
  disposed = true
  clearTimeout(timer)
})

async function action(work: () => Promise<void>) {
  if (pending.value) return
  pending.value = true
  error.value = ""
  try {
    await work()
    await refresh()
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure)
  } finally {
    pending.value = false
  }
}

function start() {
  const sessionID = app.current?.id
  if (!sessionID) return
  void action(async () => {
    await app.client?.request({ type: "lab.start", sessionID, set: set.value, rounds: rounds.value, concurrency: concurrency.value })
    historyID.value = ""
  })
}

function stop() {
  void action(async () => { await app.client?.request({ type: "lab.stop" }) })
}

function createPR(id: string) {
  void action(async () => {
    const result = await app.client?.request({ type: "lab.createPR", id })
    if (result?.url) window.mcode.openExternal(result.url)
  })
}

function selectHistory(id: string) {
  historyID.value = historyID.value === id ? "" : id
  void refresh().catch((failure) => { error.value = String(failure) })
}

function passRate(entry: LabHistoryEntry): string {
  return entry.taskCount ? Math.round(100 * entry.passed / entry.taskCount) + "%" : "0%"
}

function timestamp(time: number): string {
  return new Date(time).toLocaleString()
}
</script>

<template>
  <section class="evolve">
    <h3>{{ t("set.lab.evolve") }}</h3>
    <p v-if="app.platform !== 'linux'" class="hint">{{ t("set.lab.platform") }}</p>
    <p v-else-if="!app.current || app.current.scratch" class="hint">{{ t("set.lab.project") }}</p>
    <form class="options" @submit.prevent="start">
      <label>
        {{ t("set.lab.taskSet") }}
        <select v-model="set" :disabled="busy">
          <option :value="LAB_TASK_SET">{{ t("set.lab.builtin", { count: state?.taskCount ?? 0 }) }}</option>
        </select>
      </label>
      <label>
        {{ t("set.lab.rounds") }}
        <input v-model.number="rounds" type="number" min="1" :max="state?.taskCount" :disabled="busy" required />
      </label>
      <label>
        {{ t("set.lab.workers") }}
        <input v-model.number="concurrency" type="number" min="1" :max="state?.maxConcurrency" :disabled="busy" required />
      </label>
      <div class="actions">
        <button type="submit" :disabled="!canStart || busy || pending">{{ t("set.lab.start") }}</button>
        <button type="button" :disabled="state?.current?.status !== 'running' || pending" @click="stop">{{ t("set.lab.stop") }}</button>
      </div>
    </form>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="pollError" class="error" role="alert">{{ pollError }}</p>

    <template v-if="run">
      <div class="summary" aria-live="polite">
        <strong>{{ t(`set.lab.run.${run.status}`) }}</strong>
        <code v-if="run.branch">{{ run.branch }}</code>
        <button v-if="run.canCreatePR" type="button" :disabled="pending || busy" @click="createPR(run.id)">{{ t("set.lab.createPR") }}</button>
      </div>
      <p v-if="run.branch && !run.changed" class="hint">{{ t("set.lab.reproduced") }}</p>
      <p v-if="run.error" class="error" role="alert">{{ run.error }}</p>
      <div class="cards">
        <article v-for="card in run.cards" :key="`${run.id}-${card.round}-${card.worker}`" class="worker">
          <span class="hint">{{ t("set.lab.slot", { round: card.round, worker: card.worker }) }}</span>
          <strong>{{ card.task }} · {{ card.title }}</strong>
          <div class="result">
            <span class="badge" :class="card.stage">{{ t(`set.lab.stage.${card.stage}`) }}</span>
            <span v-if="card.score !== undefined">{{ Math.round(card.score * 100) }}%</span>
          </div>
          <pre v-if="card.diff">{{ card.diff }}</pre>
          <details v-if="card.error"><summary>{{ t("set.lab.details") }}</summary><pre>{{ card.error }}</pre></details>
        </article>
      </div>
    </template>

    <template v-if="state?.history.length">
      <h3>{{ t("set.lab.history") }}</h3>
      <div class="history">
        <button v-for="entry in state.history" :key="entry.id" type="button" :aria-pressed="historyID === entry.id"
          @click="selectHistory(entry.id)">
          <time :datetime="new Date(entry.started).toISOString()">{{ timestamp(entry.started) }}</time>
          <span>{{ t("set.lab.historyStats", { count: entry.taskCount, rate: passRate(entry) }) }}</span>
          <code v-if="entry.branch">{{ entry.branch }}</code>
        </button>
      </div>
    </template>
  </section>
</template>

<style scoped>
/*
 * The settings pages' own look - title, sub-line, card and button - repeated
 * here: SettingsDialog's rules are scoped and do not reach this component's
 * markup, so this page used to draw with bare borders and browser defaults.
 */
.evolve {
  --set-btn: #f1f1f1;
  --set-btn-hover: #f1f0ec;
  --set-btn-ink: #151c13;
  --set-card: #ffffff;
  --set-card-edge: #f3efeb;
  --set-field-edge: #e3e3e0;
  --set-field: transparent;
  --set-title: var(--text-strong);
}

:root[data-theme="dark"] .evolve {
  --set-btn: #2e2e2e;
  --set-btn-hover: #ffffff1a;
  --set-btn-ink: var(--text-strong);
  --set-card: #282828;
  --set-card-edge: #3d3d3d;
  --set-field-edge: #3a3a3a;
  --set-field: rgb(58 58 58 / 0.3);
  --set-title: #f4f4f5;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .evolve {
    --set-btn: #2e2e2e;
    --set-btn-hover: #ffffff1a;
    --set-btn-ink: var(--text-strong);
    --set-card: #282828;
    --set-card-edge: #3d3d3d;
    --set-field-edge: #3a3a3a;
    --set-field: rgb(58 58 58 / 0.3);
    --set-title: #f4f4f5;
  }
}

.evolve {
  display: grid;
  gap: 12px;
  margin-bottom: 24px;
}

h3,
p,
pre {
  margin: 0;
}

h3 {
  color: var(--text-strong);
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: calc(22.4px * var(--ui-font-scale, 1));
}

.options,
.actions,
.summary,
.result {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.options {
  align-items: end;
}

label {
  display: grid;
  gap: 5px;
  color: var(--text-base);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

input {
  width: 76px;
}

button {
  flex-shrink: 0;
  height: calc(28px * var(--ui-font-scale, 1));
  padding: 0 12px;
  color: var(--set-btn-ink);
  background: var(--set-btn);
  border: 0;
  border-radius: 8px;
  font: inherit;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
  white-space: nowrap;
}

button:not(:disabled) {
  cursor: pointer;
}

button:hover:not(:disabled) {
  background: var(--set-btn-hover);
}

button:disabled {
  opacity: 0.4;
}

input,
select {
  box-sizing: border-box;
  height: calc(30px * var(--ui-font-scale, 1));
  padding: 0 10px;
  color: var(--text-strong);
  background: var(--set-field);
  border: 1px solid var(--set-field-edge);
  border-radius: 8px;
  outline: none;
  font: inherit;
  font-size: calc(13px * var(--ui-font-scale, 1));
}

input:focus-visible,
select:focus-visible {
  border-color: var(--text-base);
}

button[aria-pressed="true"] {
  outline: 1px solid var(--interactive);
}

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 230px), 1fr));
  gap: 8px;
}

.worker {
  display: grid;
  align-content: start;
  gap: 6px;
  min-width: 0;
  padding: 12px;
  background: var(--set-card);
  border: 1px solid var(--set-card-edge);
  border-radius: 12px;
}

.badge {
  padding: 1px 6px;
  border: 1px solid currentColor;
  border-radius: 999px;
}

.accepted {
  color: var(--text-success);
}

.discarded,
.error {
  color: var(--text-error);
}

.hint {
  color: var(--text-base);
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.error,
pre {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.history {
  display: grid;
  gap: 4px;
}

.history button {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  height: auto;
  padding: 6px 12px;
  text-align: start;
}
</style>
