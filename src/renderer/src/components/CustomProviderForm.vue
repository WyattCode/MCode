<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import type { CustomModel, CustomProvider, ModelInfo } from "@shared/protocol"
import { normalizeBaseURL, normalizeModelId } from "@shared/custom-endpoint"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"
import { notice } from "../lib/toast"
import { useEscapeLayerWhile } from "../lib/escape-layer"
import ConfirmDialog from "./ConfirmDialog.vue"
import { LIMIT_PRESETS, MODALITIES, comboEnterValue, limitLabel, limitOf, modalitySummary, providerIdError, validEndpoint, type Modality } from "../lib/custom-model"
import { providerIdProblem } from "@shared/provider-id"

/**
 * A custom provider, laid out as MiMo 26.920's models page lays one out: the
 * provider's fields in a card - id, name, endpoint, protocol, key and a
 * connection test - then 来自此供应商的模型, a field that picks from what the
 * test found or takes an id typed in, and a card per model with its display
 * name, its context and output limits and the inputs it reads.
 *
 * Two hosts: the models page, which draws its own action bar and calls
 * `submit`, and the connect dialog's custom step, where the form keeps a save
 * button of its own and the saved model becomes the one in use.
 *
 * MCode's own, kept: the key may be `{env:VAR}` and is never sent to the
 * window (a blank key on an edit keeps the one held), extra request headers,
 * and at least one model, because nothing here discovers them for a provider
 * whose endpoint has no `/models`.
 */

const props = defineProps<{
  /** The provider being edited: its id is locked, and the key field starts blank. */
  editing?: CustomProvider
  /** In the connect dialog: a save button of its own, and the saved model is selected. */
  standalone?: boolean
  /** The id field takes the keys when the form opens. */
  autofocus?: boolean
}>()
const emit = defineEmits<{ connected: [providerID: string]; saved: [providerID: string] }>()

const app = useApp()

type Mods = Record<Modality, boolean>

interface ModelRow {
  key: number
  id: string
  name: string
  context?: number
  output?: number
  mods: Mods
  /** Whether the inputs were chosen here; untouched, what was stored (or the catalog) decides. */
  touched: boolean
  stored?: CustomModel
}

interface HeaderRow {
  key: string
  value: string
  err: { key?: string; value?: string }
}

let nextKey = 0
const headerRow = (): HeaderRow => ({ key: "", value: "", err: {} })

/** What a model this app already knows reads, by id - the catalog behind every other provider. */
function known(id: string): ModelInfo | undefined {
  const wanted = id.trim().toLowerCase()
  const tail = wanted.includes("/") ? wanted.slice(wanted.lastIndexOf("/") + 1) : wanted
  for (const provider of app.providers) {
    if (provider.id === props.editing?.id) continue
    const hit = provider.models.find((model) => model.id.toLowerCase() === wanted) ?? provider.models.find((model) => model.id.toLowerCase() === tail)
    if (hit) return hit
  }
  return undefined
}

function storedRow(model: CustomModel): ModelRow {
  const effective = app.providers.find((provider) => provider.id === props.editing?.id)?.models.find((entry) => entry.id === model.id)?.inputs
  return {
    key: nextKey++,
    id: model.id,
    name: model.name === model.id ? "" : model.name,
    context: model.limit?.context,
    output: model.limit?.output,
    mods: {
      image: model.attachment ?? effective?.image ?? false,
      audio: model.inputs?.audio ?? effective?.audio ?? false,
      video: model.inputs?.video ?? effective?.video ?? false,
      pdf: model.inputs?.pdf ?? effective?.pdf ?? false,
    },
    touched: false,
    stored: model,
  }
}

function newRow(id: string): ModelRow {
  const hint = known(id)
  return {
    key: nextKey++,
    id,
    name: hint && hint.name !== hint.id ? hint.name : "",
    context: hint?.contextWindow || undefined,
    output: hint?.maxOutput || undefined,
    mods: { image: hint?.inputs.image ?? false, audio: hint?.inputs.audio ?? false, video: hint?.inputs.video ?? false, pdf: hint?.inputs.pdf ?? false },
    // A model the catalog knows arrives with its inputs stated; one it does not is left for the backend's catalog.
    touched: Boolean(hint),
  }
}

const editing = props.editing
const form = ref({
  providerID: editing?.id ?? "",
  name: editing?.name && editing.name !== editing.id ? editing.name : "",
  baseURL: editing?.baseURL ?? "",
  protocol: (editing?.protocol ?? "openai") as NonNullable<CustomProvider["protocol"]>,
  apiKey: editing?.environment ? `{env:${editing.environment}}` : "",
  models: (editing?.models ?? []).map(storedRow),
  headers: Object.keys(editing?.headers ?? {}).length
    ? Object.entries(editing?.headers ?? {}).map(([key, value]) => ({ ...headerRow(), key, value }))
    : [headerRow()],
})
/*
 * The form as it was last saved (first, as it was drawn), so an edit knows
 * whether anything changed since: MiMo's save clears its dirty flag, and so
 * does a model removed, which is saved at once.
 */
const pristine = ref(JSON.stringify(form.value))
const dirty = computed(() => JSON.stringify(form.value) !== pristine.value)

const busy = ref(false)
const tried = ref(false)
/* A variable name is only a name, so an edit shows it; a typed key starts hidden. */
const keyShown = ref(Boolean(editing?.environment))

/* ------------------------------------------------------------ the checks */

/*
 * MiMo 26.920's rule: not empty, no `/`, and not an id any provider already
 * has, compared without case. Every provider's id, not only the custom ones:
 * taking a built-in's id would shadow it with no way back.
 */
const idProblem = computed(() =>
  editing
    ? undefined
    : providerIdProblem(
        form.value.providerID,
        app.providers.map((entry) => entry.id),
      ),
)

const idError = computed(() => {
  const problem = idProblem.value
  if (!problem || (problem === "empty" && !tried.value)) return undefined
  return providerIdError(problem)
})

const endpointBad = computed(() => Boolean(form.value.baseURL.trim()) && !validEndpoint(form.value.baseURL))

/* MiMo's rule, which the backend keeps too: an output limit only beside a context limit. */
const limitBad = (row: ModelRow) => row.output !== undefined && row.context === undefined

const headerProblems = computed(() =>
  form.value.headers.map((row) => {
    const key = row.key.trim()
    const value = row.value.trim()
    if (!key && !value) return {}
    return { key: key ? undefined : t("provider.custom.error.required"), value: value ? undefined : t("provider.custom.error.required") }
  }),
)

const canSave = computed(() => {
  const value = form.value
  if (idProblem.value || !value.providerID.trim() || !validEndpoint(value.baseURL)) return false
  if (!value.models.length || value.models.some(limitBad)) return false
  return headerProblems.value.every((problem) => !problem.key && !problem.value)
})

/* ------------------------------------------------------------ 连接测试 */

const probe = ref<{ status: "idle" | "busy" | "ok" | "fail"; models: string[]; text: string }>({ status: "idle", models: [], text: "" })
let probeTurn = 0

function headersOf(): Record<string, string> {
  return Object.fromEntries(form.value.headers.map((row) => [row.key.trim(), row.value.trim()] as const).filter(([key, value]) => key && value))
}

async function testConnection(quiet = false) {
  if (!validEndpoint(form.value.baseURL)) {
    if (!quiet) probe.value = { status: "fail", models: [], text: t("model.endpointInvalid") }
    return
  }
  const turn = ++probeTurn
  probe.value = { ...probe.value, status: "busy", text: t("set.models.probeBusy") }
  try {
    const result = await app.probeProvider({
      baseURL: normalizeBaseURL(form.value.baseURL),
      apiKey: form.value.apiKey.trim(),
      ...(editing ? { provider: editing.id } : {}),
      headers: headersOf(),
      protocol: form.value.protocol,
    })
    if (turn !== probeTurn) return
    probe.value = result.ok
      ? { status: "ok", models: result.models, text: t("set.models.probeOk", { n: result.models.length }) }
      : {
          status: "fail",
          models: [],
          text:
            result.reason === "http"
              ? t("set.models.probeHttp", { status: result.status ?? 0 })
              : result.reason === "json"
                ? t("set.models.probeJson")
                : result.reason === "timeout"
                  ? t("set.models.probeTimeout")
                  : t("set.models.probeNetwork", { message: result.message ?? "" }),
        }
  } catch (err) {
    if (turn !== probeTurn) return
    probe.value = { status: "fail", models: [], text: t("set.models.probeNetwork", { message: err instanceof Error ? err.message : String(err) }) }
  }
}

/* A saved provider is tested as soon as it opens, as MiMo tests one with an address and a key. */
onMounted(() => {
  if (editing && validEndpoint(editing.baseURL)) void testConnection(true)
})

/*
 * Asked to (the connect dialog's custom step), the id field takes the keys on
 * opening. Focused here: Chromium skips an `autofocus` while anything else in
 * the page holds focus, and the dialog's search box still does when this opens.
 */
const providerIdEl = ref<HTMLInputElement>()
onMounted(() => {
  if (props.autofocus) providerIdEl.value?.focus()
})

/* ------------------------------------------------------------ the model picker */

const query = ref("")
const openMenu = ref<string>()
/* The suggestion moved to; none until the arrows or the pointer pick one. */
const highlight = ref(-1)

/**
 * What the picker offers, as MiMo fills its own: everything the connection test
 * found, then every model this app already knows - so a provider whose endpoint
 * has no /models still has a list to pick from - each with the display name to
 * show beside its id. Ids already added drop out, and the typed text narrows on
 * either part.
 */
const choices = computed(() => {
  const merged = new Map<string, string>()
  for (const id of probe.value.models) merged.set(id, known(id)?.name ?? "")
  for (const provider of app.providers) {
    if (provider.id === props.editing?.id) continue
    for (const model of provider.models) if (!merged.has(model.id)) merged.set(model.id, model.name)
  }
  const needle = query.value.trim().toLowerCase()
  const added = new Set(form.value.models.map((row) => row.id))
  return [...merged]
    .filter(([id, name]) => !added.has(id) && (!needle || id.toLowerCase().includes(needle) || name.toLowerCase().includes(needle)))
    .map(([id, name]) => ({ id, name: name === id ? "" : name }))
})

/* Synchronous, so an ArrowDown that opens the list lands on its first row rather than being reset after. */
watch([query, () => openMenu.value === "combo"], () => (highlight.value = -1), { flush: "sync" })
const comboMenuEl = ref<HTMLElement>()

/* The row the keyboard moved to is scrolled into the list's view; a row under the pointer is already in it. */
function revealHighlight() {
  void nextTick(() => comboMenuEl.value?.querySelector<HTMLElement>(".cp-option.on")?.scrollIntoView({ block: "nearest" }))
}

function addModel(raw: string) {
  const id = normalizeModelId(raw)
  if (!id) return
  if (form.value.models.some((row) => row.id === id)) {
    notice.warning(t("set.models.modelExists"))
    return
  }
  form.value.models.push(newRow(id))
  query.value = ""
  openMenu.value = undefined
}

function comboKey(event: KeyboardEvent) {
  if (event.isComposing) return
  if (event.key === "ArrowDown") {
    event.preventDefault()
    openMenu.value = "combo"
    highlight.value = Math.min(highlight.value + 1, Math.max(choices.value.length - 1, 0))
    revealHighlight()
  } else if (event.key === "ArrowUp") {
    event.preventDefault()
    if (highlight.value > 0) highlight.value -= 1
    revealHighlight()
  } else if (event.key === "Enter") {
    event.preventDefault()
    addModel(comboEnterValue(openMenu.value === "combo" ? highlight.value : -1, choices.value.map((choice) => choice.id), query.value))
  }
}

/*
 * MiMo 26.920's 删除自定义模型: the trash button asks first, and on yes the
 * model leaves the saved provider straight away (the backend ignores one that
 * was never saved) before its card is dropped from the form.
 */
const removingModel = ref<ModelRow>()

async function confirmRemoveModel() {
  const row = removingModel.value
  removingModel.value = undefined
  if (!row) return
  const removed = editing ? await app.removeCustomModel(editing.id, row.id).then(() => true, () => false) : false
  form.value.models = form.value.models.filter((entry) => entry.key !== row.key)
  if (removed) {
    // Saved already: the model leaves the saved form too, and every other unsaved change stays unsaved.
    const saved = JSON.parse(pristine.value) as typeof form.value
    saved.models = saved.models.filter((entry) => entry.key !== row.key)
    pristine.value = JSON.stringify(saved)
  }
}

/* ------------------------------------------------------------ limits and inputs */

function setLimit(row: ModelRow, field: "context" | "output", value: number | undefined) {
  row[field] = value
}

function typeLimit(row: ModelRow, field: "context" | "output", event: Event) {
  const input = event.target as HTMLInputElement
  const digits = input.value.replace(/\D/g, "")
  if (digits !== input.value) input.value = digits
  row[field] = limitOf(digits).value
}

function toggleMod(row: ModelRow, key: Modality, on: boolean) {
  row.mods[key] = on
  row.touched = true
}

const modLabel = (key: Modality | "omni") =>
  t(
    key === "omni"
      ? "set.models.modalityOmni"
      : key === "image"
        ? "set.models.modalityImage"
        : key === "audio"
          ? "set.models.modalityAudio"
          : key === "video"
            ? "set.models.modalityVideo"
            : "set.models.modalityPdf",
  )

/* One menu open at a time; a press outside its anchor closes it, and Escape closes it alone. */
function onOutside(event: MouseEvent) {
  const key = openMenu.value
  if (!key) return
  const anchor = (event.target as Element | null)?.closest?.("[data-menu-anchor]")
  if (anchor?.getAttribute("data-menu-anchor") !== key) openMenu.value = undefined
}
onMounted(() => document.addEventListener("mousedown", onOutside, true))
onBeforeUnmount(() => document.removeEventListener("mousedown", onOutside, true))
useEscapeLayerWhile(
  () => openMenu.value,
  () => (openMenu.value = undefined),
  () => (openMenu.value = undefined),
)

function toggleMenu(key: string) {
  openMenu.value = openMenu.value === key ? undefined : key
}

/* ------------------------------------------------------------ headers */

function addHeader() {
  form.value.headers.push(headerRow())
}

function removeHeader(at: number) {
  if (form.value.headers.length <= 1) return
  form.value.headers.splice(at, 1)
}

/* ------------------------------------------------------------ saving */

function modelOf(row: ModelRow): CustomModel {
  const model: CustomModel = { id: row.id, name: row.name.trim() || row.id }
  if (row.context !== undefined) model.limit = row.output !== undefined ? { context: row.context, output: row.output } : { context: row.context }
  if (row.touched) {
    model.attachment = row.mods.image
    model.inputs = { audio: row.mods.audio, video: row.mods.video, pdf: row.mods.pdf }
  } else if (row.stored) {
    // Untouched, whatever was stored stays as it was - including "the catalog decides".
    if (row.stored.attachment !== undefined) model.attachment = row.stored.attachment
    if (row.stored.inputs) model.inputs = row.stored.inputs
  }
  if (row.stored?.cacheTTL) model.cacheTTL = row.stored.cacheTTL
  if (row.stored?.interleaved) model.interleaved = row.stored.interleaved
  return model
}

/*
 * Saves. On the models page that is all (MiMo 26.920 toasts and stays on the
 * provider); from the connect dialog the saved model also becomes the one in
 * use, the open conversation's or the default for the next one.
 */
async function submit(): Promise<boolean> {
  tried.value = true
  if (busy.value || !canSave.value) {
    if (!form.value.models.length) notice.warning(t("set.models.needModel"))
    return false
  }
  busy.value = true
  const id = form.value.providerID.trim()
  const entry = {
    id,
    name: form.value.name.trim() || id,
    baseURL: normalizeBaseURL(form.value.baseURL),
    apiKey: form.value.apiKey.trim(),
    headers: headersOf(),
    models: form.value.models.map(modelOf),
    protocol: form.value.protocol,
  }
  try {
    if (editing) await app.updateCustomProvider(entry)
    else await app.addCustomProvider(entry)
    pristine.value = JSON.stringify(form.value)
    if (props.standalone) {
      const model = { provider: id, model: entry.models[0].id }
      if (app.currentID) await app.setModel(model)
      else await app.patchConfig({ model, smart: false })
    }
    if (editing) notice.success(t("model.changesSaved"))
    else notice.success(t("set.models.providerAdded"))
    emit("saved", id)
    emit("connected", id)
    return true
  } catch (err) {
    notice.danger((err instanceof Error ? err.message : String(err)) || t("model.addFailed"))
    return false
  } finally {
    busy.value = false
  }
}

defineExpose({ submit, canSave, busy, dirty, testConnection })
</script>

<template>
  <form class="cp" data-custom-provider-form @submit.prevent="submit">
    <div class="cp-card">
      <div class="cp-row">
        <label class="cp-label" for="cp-provider-id">{{ t("provider.custom.field.providerID.label") }}</label>
        <div class="cp-control">
          <input
            id="cp-provider-id"
            v-model="form.providerID"
            class="cp-in"
            :class="{ bad: idError }"
            ref="providerIdEl"
            :readonly="Boolean(editing)"
            :placeholder="t('provider.custom.field.providerID.placeholder')"
            spellcheck="false"
            autocomplete="off"
            data-provider-id
          />
          <div v-if="idError" class="cp-error" data-provider-id-error>{{ idError }}</div>
        </div>
      </div>

      <div class="cp-row">
        <label class="cp-label" for="cp-name">{{ t("provider.custom.field.name.label") }}</label>
        <div class="cp-control">
          <input
            id="cp-name"
            v-model="form.name"
            class="cp-in"
            :placeholder="form.providerID.trim() || 'my-provider'"
            spellcheck="false"
            data-provider-name
          />
        </div>
      </div>

      <!-- The hint always under it, replaced by the red line while the URL is not valid. -->
      <div class="cp-row">
        <label class="cp-label" for="cp-base-url">{{ t("model.endpoint") }}</label>
        <div class="cp-control">
          <input
            id="cp-base-url"
            v-model="form.baseURL"
            class="cp-in"
            :class="{ bad: endpointBad }"
            placeholder="https://api.example.com/v1"
            spellcheck="false"
            autocomplete="off"
            data-custom-endpoint
            @blur="form.baseURL = normalizeBaseURL(form.baseURL)"
          />
          <div v-if="endpointBad" class="cp-error" data-endpoint-invalid>{{ t("model.endpointInvalid") }}</div>
        </div>
      </div>

      <div class="cp-row">
        <label class="cp-label" for="cp-protocol">{{ t("provider.custom.field.protocol.label") }}</label>
        <div class="cp-control">
          <select id="cp-protocol" v-model="form.protocol" class="cp-in" data-custom-protocol>
            <option value="openai">{{ t("provider.custom.protocol.openai") }}</option>
            <option value="anthropic">{{ t("provider.custom.protocol.anthropic") }}</option>
            <option value="responses">{{ t("provider.custom.protocol.responses") }}</option>
          </select>
        </div>
      </div>

      <!-- A password field with an eye; `{env:VAR}` still works, and the eye shows what was written. -->
      <div class="cp-row">
        <label class="cp-label" for="cp-api-key">API Key</label>
        <div class="cp-control">
          <div class="cp-secret">
            <input
              id="cp-api-key"
              v-model="form.apiKey"
              class="cp-in"
              :type="keyShown ? 'text' : 'password'"
              :placeholder="editing ? t('provider.custom.field.apiKey.keep') : t('model.apiKeyPlaceholder')"
              spellcheck="false"
              autocomplete="off"
              data-custom-key
            />
            <button
              type="button"
              class="cp-eye"
              :title="t(keyShown ? 'model.hideKey' : 'model.showKey')"
              :aria-label="t(keyShown ? 'model.hideKey' : 'model.showKey')"
              data-custom-key-toggle
              @click="keyShown = !keyShown"
            >
              <svg v-if="keyShown" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M10.7 5.1A10.4 10.4 0 0 1 12 5c7 0 10 7 10 7a13 13 0 0 1-1.7 2.7M6.6 6.6C3.5 8.7 2 12 2 12s3 7 10 7a9.7 9.7 0 0 0 5.4-1.6M2 2l20 20M9.9 9.9a3 3 0 0 0 4.2 4.2" />
              </svg>
              <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      <!-- MiMo 26.920's 连接测试: what came back, a light, and the button. -->
      <div class="cp-row">
        <span class="cp-label">{{ t("set.models.probeTitle") }}</span>
        <div class="cp-probe">
          <span class="cp-probe-text" :class="probe.status" data-probe-text>{{ probe.text }}</span>
          <!-- The light repeats the words beside it; a reader hears those, not "ok" or "busy". -->
          <span class="cp-light" :class="probe.status" data-probe-light aria-hidden="true" />
          <button type="button" class="cp-btn" data-provider-probe :disabled="probe.status === 'busy'" @click="testConnection()">
            {{ t("set.models.probe") }}
          </button>
        </div>
      </div>
    </div>

    <div class="cp-section">{{ t("set.models.fromProvider") }}</div>
    <div class="cp-combo" data-menu-anchor="combo">
      <input
        v-model="query"
        class="cp-in"
        role="combobox"
        :aria-expanded="openMenu === 'combo'"
        aria-autocomplete="list"
        :placeholder="t('set.models.comboPlaceholder')"
        spellcheck="false"
        autocomplete="off"
        data-model-combo
        @focus="openMenu = 'combo'"
        @input="openMenu = 'combo'"
        @keydown="comboKey"
      />
      <button type="button" class="cp-btn" data-model-add :disabled="!query.trim()" @click="addModel(query)">{{ t("provider.custom.models.add") }}</button>
      <div v-if="openMenu === 'combo'" ref="comboMenuEl" class="cp-menu combo" role="listbox" data-model-combo-menu>
        <div v-if="!choices.length" class="cp-menu-empty" data-model-combo-empty>{{ t("set.models.comboEmpty") }}</div>
        <button
          v-for="(choice, at) in choices"
          :key="choice.id"
          type="button"
          role="option"
          class="cp-option"
          :class="{ on: at === highlight }"
          :aria-selected="at === highlight"
          :data-model-combo-option="choice.id"
          @mouseenter="highlight = at"
          @click="addModel(choice.id)"
        >
          <span class="cp-option-id">{{ choice.id }}</span>
          <span v-if="choice.name" class="cp-option-name" data-model-combo-name>{{ choice.name }}</span>
        </button>
      </div>
    </div>
    <div v-if="tried && !form.models.length" class="cp-error" data-model-needed>{{ t("set.models.needModel") }}</div>

    <div v-for="row in form.models" :key="row.key" class="cp-model" :data-model-card="row.id">
      <button
        type="button"
        class="cp-model-remove"
        :aria-label="t('provider.custom.models.remove')"
        :title="t('provider.custom.models.remove')"
        :data-model-remove="row.id"
        @click="removingModel = row"
      >
        <svg width="15" height="15" viewBox="0 0 14 14" aria-hidden="true">
          <path d="M3 3.6h8M5.6 3.6V2.4h2.8v1.2M4.2 3.6l.5 7.4h4.6l.5-7.4" stroke="currentColor" stroke-width="1.1" fill="none" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <div class="cp-model-names">
        <input class="cp-in small" :value="row.id" readonly :aria-label="t('provider.custom.models.id.label')" :data-model-id="row.id" />
        <input
          v-model="row.name"
          class="cp-in small"
          :placeholder="t('provider.custom.models.name.placeholder')"
          :aria-label="t('provider.custom.models.name.label')"
          spellcheck="false"
          :data-model-name="row.id"
        />
      </div>
      <div class="cp-model-options">
        <div v-for="field in (['context', 'output'] as const)" :key="field" class="cp-pick" :data-menu-anchor="`${field}:${row.key}`">
          <button type="button" class="cp-pick-btn" :data-model-limit="field" @click="toggleMenu(`${field}:${row.key}`)">
            <span class="cp-pick-label">{{ t(field === "context" ? "set.models.limitContext" : "set.models.limitOutput") }}</span>
            <span class="cp-pick-value">
              {{ limitLabel(row[field]) }}
              <svg class="cp-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="m6 9.5 6 6 6-6" />
              </svg>
            </span>
          </button>
          <div v-if="openMenu === `${field}:${row.key}`" class="cp-menu" role="menu" :data-model-limit-menu="field">
            <button
              v-for="value in LIMIT_PRESETS[field]"
              :key="value"
              type="button"
              role="menuitemradio"
              class="cp-option"
              :aria-checked="row[field] === value"
              :data-model-limit-option="`${field}-${value}`"
              @click="setLimit(row, field, value), (openMenu = undefined)"
            >
              <span>{{ value }} ({{ limitLabel(value) }})</span>
              <span v-if="row[field] === value" class="cp-check">✓</span>
            </button>
            <!-- The number itself, preset or not, as MiMo's field shows it: typing 128000 never blanks it. -->
            <div class="cp-menu-custom">
              <input
                class="cp-in tiny"
                inputmode="numeric"
                :value="row[field] !== undefined ? String(row[field]) : ''"
                :placeholder="t('set.models.limitCustom')"
                :data-model-limit-custom="field"
                @input="typeLimit(row, field, $event)"
              />
            </div>
          </div>
        </div>
        <div class="cp-pick" :data-menu-anchor="`mods:${row.key}`">
          <button type="button" class="cp-pick-btn wide" data-model-modality-menu @click="toggleMenu(`mods:${row.key}`)">
            <span class="cp-pick-label">{{ t("set.models.modalities") }}</span>
            <span class="cp-pick-value">
              <span data-model-modality-summary>{{ modalitySummary(row.mods, modLabel) }}</span>
              <svg class="cp-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="m6 9.5 6 6 6-6" />
              </svg>
            </span>
          </button>
          <div v-if="openMenu === `mods:${row.key}`" class="cp-menu" role="menu" data-model-modality-panel>
            <label v-for="key in MODALITIES" :key="key" class="cp-option">
              <input type="checkbox" :checked="row.mods[key]" :data-model-modality="key" @change="toggleMod(row, key, ($event.target as HTMLInputElement).checked)" />
              {{ modLabel(key) }}
            </label>
          </div>
        </div>
      </div>
      <div v-if="limitBad(row)" class="cp-error" data-model-limit-error>{{ t("provider.custom.limitInvalid") }}</div>
    </div>

    <div class="cp-section">{{ t("provider.custom.headers.label") }}</div>
    <div v-for="(row, at) in form.headers" :key="`header-${at}`" class="cp-header">
      <div class="cp-cell">
        <input
          v-model="row.key"
          class="cp-in small"
          :aria-label="t('provider.custom.headers.key.label')"
          :placeholder="t('provider.custom.headers.key.placeholder')"
          spellcheck="false"
          autocomplete="off"
        />
        <div v-if="headerProblems[at]?.key" class="cp-error">{{ headerProblems[at].key }}</div>
      </div>
      <div class="cp-cell">
        <input
          v-model="row.value"
          class="cp-in small"
          :aria-label="t('provider.custom.headers.value.label')"
          :placeholder="t('provider.custom.headers.value.placeholder')"
          spellcheck="false"
          autocomplete="off"
        />
        <div v-if="headerProblems[at]?.value" class="cp-error">{{ headerProblems[at].value }}</div>
      </div>
      <button
        type="button"
        class="cp-drop"
        :disabled="form.headers.length <= 1"
        :aria-label="t('provider.custom.headers.remove')"
        :title="t('provider.custom.headers.remove')"
        @click="removeHeader(at)"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path d="M3 3.6h8M5.6 3.6V2.4h2.8v1.2M4.2 3.6l.5 7.4h4.6l.5-7.4" stroke="currentColor" stroke-width="1.1" fill="none" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>
    <button type="button" class="cp-add" @click="addHeader">+ {{ t("provider.custom.headers.add") }}</button>

    <button v-if="standalone" class="cp-submit" type="submit" :disabled="busy || !canSave" data-custom-save>
      {{ busy ? t("common.saving") : t("common.save") }}
    </button>

    <Teleport to="body">
      <ConfirmDialog
        v-if="removingModel"
        :title="t('set.models.deleteModelTitle')"
        :body="t('set.models.deleteBody', { name: removingModel.name.trim() || removingModel.id })"
        :confirm-label="t('set.models.remove')"
        @confirm="confirmRemoveModel"
        @close="removingModel = undefined"
      />
    </Teleport>
  </form>
</template>

<style scoped>
/* MiMo's page body: 16 between the blocks, 8 between one model card and the next. */
.cp {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.cp-model + .cp-model {
  margin-top: -8px;
}

/*
 * The provider's fields are MiMo's set-card of sr rows: a 16px corner on the
 * settings card colour, rows 16 deep divided by the card's own rule, and titles
 * at 14/500. Every row here is a title and a control with nothing under it, so
 * they are centred the way MiMo centres its sr-single.
 */
.cp-card {
  padding: 0 16px;
  background: #ffffff;
  border: 1px solid #f3efeb;
  border-radius: 16px;
}

.cp-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  padding: 16px 0;
  border-bottom: 1px solid #f3efeb;
}

.cp-row:last-child {
  border-bottom: none;
}

.cp-label {
  color: var(--text-strong);
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
}

:root[data-theme="dark"] .cp-card {
  background: #282828;
  border-color: #3d3d3d;
}

:root[data-theme="dark"] .cp-row {
  border-color: #3d3d3d;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .cp-card {
    background: #282828;
    border-color: #3d3d3d;
  }

  :root:not([data-theme="light"]) .cp-row {
    border-color: #3d3d3d;
  }
}

.cp-control {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 420px;
  max-width: 100%;
}

/*
 * MiMo's shared input, which every field on this page uses: a 6px corner over
 * nothing at all, 12 in, the button rule around it and an input's small lip
 * under it, focusing on dim. Every field takes the interface font - an id is
 * not set in monospace here - and a read-only field is not greyed, because the
 * provider id on an edit is a fact rather than a disabled control.
 */
.cp-in {
  box-sizing: border-box;
  width: 100%;
  height: calc(36px * var(--ui-font-scale, 1));
  padding: 0 12px;
  color: var(--text-strong);
  background: transparent;
  border: 1px solid #e3e3e0;
  border-radius: 6px;
  box-shadow: var(--shadow-xs);
  font-family: var(--font-sans);
  font-size: calc(13px * var(--ui-font-scale, 1));
  outline: none;
}

.cp-in::placeholder {
  color: var(--text-base);
}

.cp-in.small {
  height: calc(32px * var(--ui-font-scale, 1));
}

/* MiMo's custom-limit field is the shortest of the three. */
.cp-in.tiny {
  height: calc(28px * var(--ui-font-scale, 1));
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.cp-in:focus {
  border-color: var(--text-weak);
}

/*
 * The dark fill is written on the plain element, which outranks the two rules
 * above it - one class and a pseudo-class against one class inside :root and a
 * theme attribute - so both the focus ring and the refusal ring were computed
 * away in the dark. The field also sets `outline: none`, so its border is the
 * only mark focus has: tabbing through this form in the dark showed nothing at
 * all. Each state is repeated here rather than cut out of the rule above,
 * because a focused field keeps the dark fill.
 */
:root[data-theme="dark"] .cp-in {
  background: rgb(58 58 58 / 0.3);
  border-color: #3a3a3a;
}

:root[data-theme="dark"] .cp-in:focus {
  border-color: var(--text-weak);
}

:root[data-theme="dark"] .cp-in.bad {
  border-color: #ff6467;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .cp-in {
    background: rgb(58 58 58 / 0.3);
    border-color: #3a3a3a;
  }

  :root:not([data-theme="light"]) .cp-in:focus {
    border-color: var(--text-weak);
  }

  :root:not([data-theme="light"]) .cp-in.bad {
    border-color: #ff6467;
  }
}

/*
 * MiMo rings a field it will not accept in red-400 and says why in red-500.
 * MiMo's red-400, which is not its --color-err, so --text-critical does not fit.
 */
.cp-in.bad {
  border-color: #ff6467;
}

.cp-secret {
  position: relative;
}

.cp-secret .cp-in {
  padding-inline-end: 36px;
}

.cp-eye {
  position: absolute;
  top: 50%;
  inset-inline-end: 5px;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  color: var(--text-base);
  background: transparent;
  border: 0;
  border-radius: 6px;
  transform: translateY(-50%);
  cursor: pointer;
}

.cp-eye:hover {
  color: var(--text-strong);
}

.cp-error {
  color: #fb2c36;
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 1.5;
}

.cp-probe {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: calc(36px * var(--ui-font-scale, 1));
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.cp-probe-text {
  color: var(--text-base);
}

/*
 * MiMo draws the failed probe's sentence in its muted colour, which says the
 * same thing as the grey line beside it and nothing more. MCode keeps it red:
 * the words are the only place the reason is written, and a reader who cannot
 * tell the light's colours apart has nothing else to go on. (2026-09-23.)
 */
.cp-probe-text.fail {
  color: #fb2c36;
}

/* MiMo's 10px light: green once it answered, red when it did not, a line colour before. */
.cp-light {
  flex: none;
  width: 10px;
  height: 10px;
  background: var(--border-weak);
  border-radius: 50%;
}

.cp-light.ok {
  background: var(--text-success);
}

.cp-light.fail {
  background: #fb2c36;
}

/*
 * MiMo's secondary Button at size sm: 26 tall, 8 round, 12 in, 14/500 on the
 * secondary fill with no rule at all, hovering to side-active. In a settings
 * row it is the 28 every control in a row takes.
 */
.cp-btn {
  flex: none;
  height: calc(26px * var(--ui-font-scale, 1));
  padding: 0 12px;
  color: #151c13;
  background: #f1f1f1;
  border: 0;
  border-radius: 8px;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
}

.cp-probe .cp-btn {
  height: calc(28px * var(--ui-font-scale, 1));
}

.cp-btn:hover:not(:disabled) {
  background: #f1f0ec;
}

:root[data-theme="dark"] .cp-btn {
  color: var(--text-strong);
  background: #2e2e2e;
}

:root[data-theme="dark"] .cp-btn:hover:not(:disabled) {
  background: #ffffff1a;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .cp-btn {
    color: var(--text-strong);
    background: #2e2e2e;
  }

  :root:not([data-theme="light"]) .cp-btn:hover:not(:disabled) {
    background: #ffffff1a;
  }
}

.cp-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.cp-section {
  margin-top: 10px;
  color: var(--text-strong);
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 500;
}

.cp-combo {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 420px;
  max-width: 100%;
}

.cp-menu {
  position: absolute;
  top: calc(100% + 4px);
  inset-inline-start: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  gap: 2px;
  box-sizing: border-box;
  min-width: 200px;
  max-height: 240px;
  padding: 6px;
  overflow-y: auto;
  background: #fffefd;
  border: 1px solid #f0ebe5;
  border-radius: 10px;
  box-shadow: 0 12px 40px #00000024;
}

/* MiMo's picker list is the tighter of the two: 4 of padding, and full width. */
.cp-menu.combo {
  inset-inline-end: 0;
  padding: 4px;
}

:root[data-theme="dark"] .cp-menu {
  background: #282828;
  border-color: #2e2e2e;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .cp-menu {
    background: #282828;
    border-color: #2e2e2e;
  }
}

/* MiMo rules the number off from the presets above it. */
.cp-menu-custom {
  margin-top: 4px;
  padding-top: 6px;
  border-top: 1px solid #f0ebe5;
}

:root[data-theme="dark"] .cp-menu-custom {
  border-color: #2e2e2e;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .cp-menu-custom {
    border-color: #2e2e2e;
  }
}

.cp-menu-empty {
  padding: 8px;
  color: var(--text-base);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.cp-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  padding: 6px 8px;
  color: var(--text-base);
  background: transparent;
  border: 0;
  border-radius: 6px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  text-align: start;
  cursor: pointer;
}

/* A row in the picker: the id, medium and truncated, then its name at the end. */
.cp-menu.combo .cp-option {
  padding: 7px 8px;
}

.cp-option-id {
  overflow: hidden;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cp-option-name {
  flex: none;
  max-width: 45%;
  overflow: hidden;
  color: var(--text-base);
  text-overflow: ellipsis;
  white-space: nowrap;
}

label.cp-option {
  justify-content: flex-start;
}

.cp-option:hover,
.cp-option.on {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.cp-check {
  color: var(--text-weak);
}

/* One card per model: the id and its display name, then the three menus; the bin in the corner. */
.cp-model {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 48px 12px 14px;
  background: #fffefd;
  border: 1px solid #f0ebe5;
  border-radius: 12px;
}

:root[data-theme="dark"] .cp-model {
  background: #282828;
  border-color: #2e2e2e;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .cp-model {
    background: #282828;
    border-color: #2e2e2e;
  }
}

.cp-model-remove {
  position: absolute;
  top: 10px;
  inset-inline-end: 10px;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  color: var(--text-base);
  background: transparent;
  border: 0;
  border-radius: 6px;
  cursor: pointer;
}

.cp-model-remove:hover {
  color: #fb2c36;
}

.cp-model-names,
.cp-model-options {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.cp-model-names .cp-in {
  width: 220px;
  max-width: 100%;
}

/* MiMo's chevron after a picker's value: 14 square in the muted colour. */
.cp-caret {
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--text-base);
}

.cp-pick {
  position: relative;
}

.cp-pick-btn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 148px;
  height: calc(32px * var(--ui-font-scale, 1));
  padding: 0 10px;
  background: #fffefd;
  border: 1px solid #f0ebe5;
  border-radius: 8px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  cursor: pointer;
}

:root[data-theme="dark"] .cp-pick-btn {
  background: #282828;
  border-color: #2e2e2e;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .cp-pick-btn {
    background: #282828;
    border-color: #2e2e2e;
  }
}

.cp-pick-btn.wide {
  min-width: 180px;
}

/* The explicit-dark twin was written and the media one was not, so this hover worked for someone who picked Dark and not for the default, which follows the system. */
.cp-pick-btn:hover,
:root[data-theme="dark"] .cp-pick-btn:hover {
  border-color: var(--text-weak);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .cp-pick-btn:hover {
    border-color: var(--text-weak);
  }
}

.cp-pick-label {
  color: var(--text-base);
}

.cp-pick-value {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--text-strong);
  font-weight: 500;
}

.cp-header {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.cp-cell {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}

.cp-drop {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  color: var(--text-base);
  background: none;
  border: 1px solid #e3e3e0;
  border-radius: 6px;
  cursor: pointer;
}

:root[data-theme="dark"] .cp-drop {
  border-color: #3a3a3a;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .cp-drop {
    border-color: #3a3a3a;
  }
}

.cp-drop:hover:not(:disabled) {
  color: #fb2c36;
}

.cp-drop:disabled {
  color: var(--text-weaker);
  cursor: default;
}

.cp-add {
  align-self: flex-start;
  padding: 0;
  color: var(--text-base);
  background: none;
  border: none;
  font-size: calc(13px * var(--ui-font-scale, 1));
  cursor: pointer;
}

.cp-add:hover {
  color: var(--text-strong);
}

.cp-submit {
  align-self: flex-end;
  height: calc(26px * var(--ui-font-scale, 1));
  padding: 0 12px;
  color: #ffffff;
  background: #151c13;
  border: 0;
  border-radius: 8px;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
  cursor: pointer;
}

:root[data-theme="dark"] .cp-submit {
  color: #0d0d0d;
  background: #ececec;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .cp-submit {
    color: #0d0d0d;
    background: #ececec;
  }
}

.cp-submit:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
