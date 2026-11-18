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
  } catch (failure) {
    error.value = String(failure)
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
.evolve { display: grid; gap: 12px; margin-bottom: 24px; }
h3, p, pre { margin: 0; }
.options, .actions, .summary, .result { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.options { align-items: end; }
label { display: grid; gap: 5px; }
input { width: 76px; }
button, input, select {
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  padding: 5px 8px;
  color: inherit;
  background: var(--surface-raised, transparent);
  font: inherit;
}
button:not(:disabled) { cursor: pointer; }
button:disabled { opacity: .5; }
button[aria-pressed="true"] { border-color: var(--interactive); }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 230px), 1fr)); gap: 8px; }
.worker { display: grid; align-content: start; gap: 6px; border: 1px solid var(--border-strong); border-radius: 8px; padding: 10px; min-width: 0; }
.badge { border: 1px solid currentColor; border-radius: 999px; padding: 1px 6px; }
.accepted { color: var(--text-success); }
.discarded, .error { color: var(--text-error); }
.hint { color: var(--text-weak); }
.error, pre { white-space: pre-wrap; overflow-wrap: anywhere; }
.history { display: grid; gap: 4px; }
.history button { display: flex; flex-wrap: wrap; gap: 4px 10px; text-align: start; }
</style>
