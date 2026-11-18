<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import type { CustomModel, CustomProvider, Effort, ModelInfo } from "@shared/protocol"
import { THINKING_LEVELS } from "@shared/effort-menu"
import { modelLimitProblem, normalizeBaseURL, normalizeModelId, normalizeProviderProtocol, PROVIDER_PRESETS } from "@shared/custom-endpoint"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"
import { notice, notifyFailure } from "../lib/toast"
import { useEscapeLayerWhile } from "../lib/escape-layer"
import ConfirmDialog from "./ConfirmDialog.vue"
import SelectMenu from "./SelectMenu.vue"
import { LIMIT_PRESETS, MODALITIES, comboEnterValue, limitLabel, limitOf, modalitySummary, providerIdError, validEndpoint, type Modality } from "../lib/custom-model"
import { providerIdProblem } from "@shared/provider-id"

/**
 * A custom provider, laid out as MiMo 26.920's models page lays one out: the
 * provider's connection fields, then a model picker and an editor per model.
 * A preset supplies the provider identity, endpoint and protocol.
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
  preset?: keyof typeof PROVIDER_PRESETS
  /** In the connect dialog: a save button of its own, and the saved model is selected. */
  standalone?: boolean
  /** The id field takes the keys when the form opens. */
  autofocus?: boolean
}>()
const emit = defineEmits<{ connected: [providerID: string]; saved: [providerID: string] }>()

const app = useApp()

type Mods = Record<Modality, boolean>

/** A model's own word on thinking, as the form holds it: `on` is "this model thinks"; the rest only count when it does. */
interface Thinking {
  on: boolean
  efforts: Effort[]
  canOff: boolean
  default?: Effort
}

/** What a model that is just being switched to thinking starts with: every level, and able to be turned off. */
const blankThinking = (): Thinking => ({ on: false, efforts: [...THINKING_LEVELS], canOff: true })

interface ModelRow {
  key: number
  id: string
  name: string
  context: string
  output: string
  mods: Mods
  thinking: Thinking
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
    context: String(model.limit?.context ?? ""),
    output: String(model.limit?.output ?? ""),
    mods: {
      image: model.attachment ?? effective?.image ?? false,
      audio: model.inputs?.audio ?? effective?.audio ?? false,
      video: model.inputs?.video ?? effective?.video ?? false,
      pdf: model.inputs?.pdf ?? effective?.pdf ?? false,
    },
    thinking: model.thinking
      ? { on: true, efforts: [...model.thinking.efforts], canOff: model.thinking.canOff === true, ...(model.thinking.default ? { default: model.thinking.default } : {}) }
      : blankThinking(),
    touched: false,
    stored: model,
  }
}

function newRow(id: string): ModelRow {
  const hint = known(id)
  const context = String(hint?.contextWindow || "")
  const output = String(hint?.maxOutput || "")
  const defaults = modelLimitProblem(context, output) === undefined
  return {
    key: nextKey++,
    id,
    name: hint && hint.name !== hint.id ? hint.name : "",
    context: defaults ? context : "",
    output: defaults ? output : "",
    mods: { image: hint?.inputs.image ?? false, audio: hint?.inputs.audio ?? false, video: hint?.inputs.video ?? false, pdf: hint?.inputs.pdf ?? false },
    thinking: blankThinking(),
    // A model the catalog knows arrives with its inputs stated; one it does not is left for the backend's catalog.
    touched: Boolean(hint),
  }
}

const editing = props.editing
type Probe = { status: "idle" | "busy" | "ok" | "fail"; modelIds: string[]; text: string }
const idleProbe = (): Probe => ({ status: "idle", modelIds: [], text: "" })
const preset = computed(() => {
  if (!editing) return props.preset ?? "custom"
  return editing.preset && Object.hasOwn(PROVIDER_PRESETS, editing.preset) ? editing.preset : "custom"
})
const takenIds = computed(() => [
  ...app.providers.map((entry) => entry.id),
  ...(app.config?.customProviders ?? []).map((entry) => entry.id),
  ...(app.config?.disabledProviders ?? []),
])

function presetDraft(key: keyof typeof PROVIDER_PRESETS) {
  const entry = PROVIDER_PRESETS[key]
  let providerId: string = key
  if (key === "custom") providerId = ""
  else {
    for (let n = 1; providerIdProblem(providerId, takenIds.value); n++) {
      providerId = n === 1 ? `${key}-custom` : `${key}-custom-${n}`
    }
  }
  return { providerId, name: key === "custom" ? "" : entry.label, baseURL: entry.baseURL, protocol: entry.protocol }
}

const form = ref({
  ...presetDraft(preset.value),
  ...(editing ? {
    providerId: editing.id,
    name: editing.name === editing.id ? "" : editing.name,
    baseURL: editing.baseURL,
    protocol: normalizeProviderProtocol(editing.protocol),
  } : {}),
  apiKey: editing?.environment ? `{env:${editing.environment}}` : "",
  models: (editing?.models ?? []).map(storedRow),
  probe: idleProbe(),
  headers: Object.keys(editing?.headers ?? {}).length
    ? Object.entries(editing?.headers ?? {}).map(([key, value]) => ({ ...headerRow(), key, value }))
    : [headerRow()],
})
/*
 * The form as it was last saved (first, as it was drawn), so an edit knows
 * whether anything changed since: MiMo's save clears its dirty flag, and so
 * does a model removed, which is saved at once.
 */
const snapshot = () => JSON.stringify(form.value, (key, value) => key === "probe" ? undefined : value)
const pristine = ref(snapshot())
const dirty = computed(() => snapshot() !== pristine.value)

const protocolOptions = computed(() =>
  (["chat-completions", "messages", "responses"] as const).map((value) => ({ value, label: t(`set.models.protocol.${value}`) })),
)

const busy = ref(false)
const tried = ref(false)
const idTouched = ref(false)
const endpointTouched = ref(false)
/* A variable name is only a name, so an edit shows it; a typed key starts hidden. */
const keyShown = ref(Boolean(editing?.environment))

watch(preset, (key) => {
  if (editing) return
  Object.assign(form.value, presetDraft(key), { apiKey: "", headers: [headerRow()] })
  keyShown.value = false
  idTouched.value = false
  endpointTouched.value = false
}, { flush: "sync" })

/*
 * The eye. Hiding is free; showing a key is showing a secret, so when the
 * Windows Hello gate is on the OS is asked first - the same gate the settings
 * page puts in front of the MCP secrets. A canceled prompt leaves the field as
 * it was, a failed one says so, and a machine without Hello never asks.
 */
async function toggleKeyShown() {
  if (keyShown.value) {
    keyShown.value = false
    return
  }
  const status = await Promise.resolve(window.mcode.userVerifyStatus?.()).catch(() => undefined)
  if (status?.supported && status.requireGate && !status.unlocked) {
    const result = await window.mcode.userVerifyUnlock(t("set.userVerify")).catch(() => ({ ok: false, outcome: "failed" }))
    if (!result.ok) {
      if (result.outcome === "unavailable" || result.outcome === "unsupported") notifyFailure(t("set.userVerifyUnavailable"))
      else if (result.outcome !== "canceled") notifyFailure(t("set.userVerifyFailed"))
      return
    }
  }
  keyShown.value = true
}

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
        form.value.providerId,
        takenIds.value,
      ),
)

const idError = computed(() => {
  const problem = idProblem.value
  if (!problem || (problem === "empty" && !idTouched.value && !tried.value)) return undefined
  return providerIdError(problem)
})

const endpointBad = computed(() => preset.value === "custom" && (endpointTouched.value || tried.value || Boolean(form.value.baseURL.trim())) && !validEndpoint(form.value.baseURL))

function limitProblem(row: ModelRow) {
  const problem = modelLimitProblem(row.context, row.output)
  const legacy = row.stored?.id === normalizeModelId(row.id) && row.stored.limit?.output === undefined &&
    row.context === String(row.stored.limit?.context) && !row.output.trim()
  return problem === "pair" && legacy ? undefined : problem
}

function modelIdError(row: ModelRow) {
  const id = normalizeModelId(row.id)
  if (!id) return t("set.models.modelIdRequired")
  if (form.value.models.some((other) => other.key !== row.key && normalizeModelId(other.id) === id)) return t("set.models.modelExists")
}

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
  if (idProblem.value || !value.providerId.trim() || !validEndpoint(value.baseURL)) return false
  if (!value.models.length || value.models.some((row) => limitProblem(row) || modelIdError(row))) return false
  return headerProblems.value.every((problem) => !problem.key && !problem.value)
})

/* ------------------------------------------------------------ 连接测试 */

const probe = computed(() => form.value.probe)
let probeTurn = 0
watch(() => [form.value.baseURL, form.value.apiKey, form.value.protocol, form.value.headers], () => {
  probeTurn++
  form.value.probe = idleProbe()
}, { deep: true, flush: "sync" })

function headersOf(): Record<string, string> {
  return Object.fromEntries(form.value.headers.map((row) => [row.key.trim(), row.value.trim()] as const).filter(([key, value]) => key && value))
}

async function testConnection(quiet = false) {
  if (!validEndpoint(form.value.baseURL)) {
    if (!quiet) form.value.probe = { status: "fail", modelIds: [], text: t("set.models.probeNetwork", { message: t("model.endpointInvalid") }) }
    return
  }
  const turn = ++probeTurn
  form.value.probe = { ...probe.value, status: "busy", text: t("set.models.probeBusy") }
  try {
    const result = await app.probeProvider({
      baseURL: normalizeBaseURL(form.value.baseURL),
      apiKey: form.value.apiKey.trim(),
      ...(editing ? { provider: editing.id } : {}),
      headers: headersOf(),
      protocol: form.value.protocol,
    })
    if (turn !== probeTurn) return
    form.value.probe = result.ok
      ? { status: "ok", modelIds: result.modelIds, text: t("set.models.probeOk", { n: result.modelIds.length }) }
      : {
          status: "fail",
          modelIds: [],
          text:
            result.reason === "http"
              ? t("set.models.probeHttp", { status: result.status ?? 0 })
              : result.reason === "json"
                ? t("set.models.probeJson")
                : result.reason === "timeout"
                  ? t("set.models.probeTimeout")
                  : t("set.models.probeNetwork", { message: t("set.models.probeUnavailable") }),
        }
  } catch {
    if (turn !== probeTurn) return
    form.value.probe = { status: "fail", modelIds: [], text: t("set.models.probeNetwork", { message: t("set.models.probeUnavailable") }) }
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
const queryError = ref(false)
const expandedModel = ref<number>()
watch(query, () => (queryError.value = false))
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
  for (const id of probe.value.modelIds) merged.set(id, known(id)?.name ?? "")
  for (const provider of app.providers) {
    if (provider.id === props.editing?.id) continue
    for (const model of provider.models) if (!merged.has(model.id)) merged.set(model.id, model.name)
  }
  const needle = query.value.trim().toLowerCase()
  const added = new Set(form.value.models.map((row) => normalizeModelId(row.id)))
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
  if (!id) {
    queryError.value = true
    return
  }
  if (form.value.models.some((row) => normalizeModelId(row.id) === id)) {
    notice.warning(t("set.models.modelExists"))
    return
  }
  const row = newRow(id)
  form.value.models.push(row)
  expandedModel.value = row.key
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
 * model leaves the saved provider straight away when other models remain.
 * Replacing the last saved model takes effect with the next form save.
 */
const removingModel = ref<ModelRow>()

async function confirmRemoveModel() {
  const row = removingModel.value
  if (!row) return
  const saved = JSON.parse(pristine.value) as typeof form.value
  const stored = row.stored
  const removeNow = saved.models.length > 1
  if (editing && stored && removeNow) {
    try {
      await app.removeCustomModel(editing.id, stored.id)
    } catch (err) {
      notice.danger((err instanceof Error ? err.message : String(err)) || t("set.models.removeFailed"))
      return
    }
  }
  form.value.models = form.value.models.filter((entry) => entry.key !== row.key)
  if (editing && stored && removeNow) {
    // Keep the rest of the draft dirty after an immediate removal.
    saved.models = saved.models.filter((entry) => entry.key !== row.key)
    pristine.value = JSON.stringify(saved)
  }
  removingModel.value = undefined
}

/* ------------------------------------------------------------ limits and inputs */

function toggleMod(row: ModelRow, key: Modality, on: boolean) {
  row.mods[key] = on
  row.touched = true
}

/* ------------------------------------------------------------ thinking */

const levelLabel = (level: Effort) => t(`effort.gpt.${level}`)

const standardEfforts: Effort[] = ["low", "medium", "high"]

function setEfforts(row: ModelRow, efforts: readonly Effort[]) {
  row.thinking.on = efforts.length > 0
  if (!efforts.length) return
  row.thinking.efforts = [...efforts]
  if (row.thinking.default && !efforts.includes(row.thinking.default)) row.thinking.default = undefined
}

function toggleLevel(row: ModelRow, level: Effort) {
  const efforts = THINKING_LEVELS.filter((one) => (one === level) !== row.thinking.efforts.includes(one))
  if (efforts.length) setEfforts(row, efforts)
}

/* "Thinking only" and "may be turned off" are the two ends of one switch: the model either can be told not to think or cannot. */
function setCanOff(row: ModelRow, canOff: boolean) {
  row.thinking.canOff = canOff
}

/* The default is "auto" (the model's first fallback, medium) or one of the levels the model takes. */
const defaultOptions = (row: ModelRow) => [
  { value: "auto", label: t("set.models.thinkingAuto") },
  ...row.thinking.efforts.map((level) => ({ value: level, label: levelLabel(level) })),
]

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
  const id = normalizeModelId(row.id)
  const model: CustomModel = { id, name: row.name.trim() || id }
  const context = limitOf(row.context).value
  const output = limitOf(row.output).value
  if (context !== undefined) model.limit = output === undefined ? { context } : { context, output }
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
  if (row.thinking.on) {
    model.thinking = {
      efforts: [...row.thinking.efforts],
      ...(row.thinking.canOff ? { canOff: true } : {}),
      ...(row.thinking.default ? { default: row.thinking.default } : {}),
    }
  }
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
  const id = form.value.providerId.trim()
  const entry = {
    id,
    name: form.value.name.trim() || id,
    baseURL: normalizeBaseURL(form.value.baseURL),
    apiKey: form.value.apiKey.trim(),
    headers: headersOf(),
    models: form.value.models.map(modelOf),
    protocol: form.value.protocol,
    ...(preset.value !== "custom" ? { preset: preset.value } : {}),
  }
  const target = app.currentID
  try {
    if (editing) await app.updateCustomProvider(entry)
    else await app.addCustomProvider(entry)
    form.value.models.forEach((row, index) => {
      row.id = entry.models[index].id
      row.stored = entry.models[index]
    })
    pristine.value = snapshot()
    if (props.standalone) {
      const model = { provider: id, model: entry.models[0].id }
      if (target) await app.setModel(model, target)
      else await app.patchConfig({ model })
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
  <form class="cp" :inert="busy" data-custom-provider-form @submit.prevent="submit">
    <div class="cp-card">
      <div v-if="preset === 'custom'" class="cp-row">
        <label class="cp-label" for="cp-provider-id">{{ t("provider.custom.field.providerID.label") }}</label>
        <div class="cp-control">
          <input
            id="cp-provider-id"
            v-model="form.providerId"
            class="cp-in"
            :class="{ bad: idError }"
            ref="providerIdEl"
            :readonly="Boolean(editing)"
            :placeholder="t('provider.custom.field.providerID.placeholder')"
            spellcheck="false"
            autocomplete="off"
            data-provider-id
            @blur="idTouched = true"
          />
          <div v-if="idError" class="cp-error" data-provider-id-error>{{ idError }}</div>
        </div>
      </div>

      <div v-if="preset === 'custom'" class="cp-row">
        <label class="cp-label" for="cp-name">{{ t("provider.custom.field.name.label") }}</label>
        <div class="cp-control">
          <input
            id="cp-name"
            v-model="form.name"
            class="cp-in"
            :placeholder="form.providerId.trim() || 'my-provider'"
            spellcheck="false"
            data-provider-name
          />
        </div>
      </div>

      <!-- The hint always under it, replaced by the red line while the URL is not valid. -->
      <div v-if="preset === 'custom'" class="cp-row">
        <label class="cp-label" for="cp-base-url">{{ t("provider.custom.field.baseURL.label") }}</label>
        <div class="cp-control">
          <input
            id="cp-base-url"
            v-model="form.baseURL"
            class="cp-in"
            :class="{ bad: endpointBad }"
            :placeholder="t('set.models.endpointPlaceholder')"
            spellcheck="false"
            autocomplete="off"
            data-custom-endpoint
            @blur="endpointTouched = true; form.baseURL = normalizeBaseURL(form.baseURL)"
          />
          <div v-if="endpointBad" class="cp-error" data-endpoint-invalid>{{ t("model.endpointInvalid") }}</div>
        </div>
      </div>

      <div v-if="preset === 'custom'" class="cp-row">
        <label class="cp-label" for="cp-protocol">{{ t("provider.custom.field.protocol.label") }}</label>
        <div class="cp-control">
          <!-- Drawn in-app: a native select pops the OS list (system blue, grey, square) over this card. -->
          <SelectMenu
            id="cp-protocol"
            v-model="form.protocol"
            class="cp-select"
            :options="protocolOptions"
            match-width
            data-custom-protocol
          />
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
              @click="toggleKeyShown"
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
          <span class="cp-probe-text" :class="probe.status" role="status" aria-live="polite" data-probe-text>{{ probe.text }}</span>
          <!-- The light repeats the words beside it; a reader hears those, not "ok" or "busy". -->
          <span class="cp-light" :class="probe.status" data-probe-light aria-hidden="true" />
          <button type="button" class="cp-btn" data-provider-probe :disabled="probe.status === 'busy'" @click="testConnection()">
            {{ t(probe.status === "busy" ? "set.models.probeBusy" : "set.models.probe") }}
          </button>
        </div>
      </div>
    </div>

    <div class="cp-section">{{ t("set.models.modelList") }}</div>
    <div class="cp-combo" data-menu-anchor="combo">
      <input
        v-model="query"
        class="cp-in"
        role="combobox"
        :aria-expanded="openMenu === 'combo'"
        :aria-label="t('set.models.comboPlaceholder')"
        :aria-controls="openMenu === 'combo' ? 'cp-combo-menu' : undefined"
        :aria-activedescendant="openMenu === 'combo' && choices[highlight] ? `cp-combo-option-${highlight}` : undefined"
        aria-autocomplete="list"
        :placeholder="t('set.models.comboPlaceholder')"
        spellcheck="false"
        autocomplete="off"
        data-model-combo
        @focus="openMenu = 'combo'"
        @input="openMenu = 'combo'"
        @keydown="comboKey"
      />
      <button type="button" class="cp-btn" data-model-add @click="addModel(query)">{{ t("provider.custom.models.add") }}</button>
      <div v-if="openMenu === 'combo'" id="cp-combo-menu" ref="comboMenuEl" class="cp-menu combo" role="listbox" data-model-combo-menu>
        <div v-if="!choices.length" class="cp-menu-empty" data-model-combo-empty>{{ t("set.models.comboEmpty") }}</div>
        <button
          v-for="(choice, at) in choices"
          :key="choice.id"
          :id="`cp-combo-option-${at}`"
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
    <div v-if="queryError" class="cp-error" role="alert">{{ t("set.models.modelIdRequired") }}</div>
    <div v-if="!form.models.length" class="cp-menu-empty">{{ t("set.models.modelEmpty") }}</div>
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
      <div class="cp-model-heading">
        <span>{{ row.name.trim() || row.id }}</span>
        <button type="button" class="cp-btn" :aria-expanded="expandedModel === row.key" @click="expandedModel = expandedModel === row.key ? undefined : row.key">
          {{ t("set.models.editModel") }}
        </button>
      </div>
      <template v-if="expandedModel === row.key">
        <div class="cp-model-names">
          <label class="cp-cell">
            {{ t("set.models.modelId") }}
            <input v-model="row.id" class="cp-in small" spellcheck="false" :data-model-id="row.id" />
          </label>
          <label class="cp-cell">
            {{ t("set.models.displayName") }}
            <input v-model="row.name" class="cp-in small" :placeholder="row.id" spellcheck="false" :data-model-name="row.id" />
          </label>
        </div>
        <div class="cp-model-options">
          <div v-for="field in (['context', 'output'] as const)" :key="field" class="cp-pick" :data-menu-anchor="`${field}:${row.key}`">
            <button type="button" class="cp-pick-btn" :data-model-limit="field" :aria-expanded="openMenu === `${field}:${row.key}`" aria-haspopup="menu" @click="toggleMenu(`${field}:${row.key}`)">
              <span class="cp-pick-label">{{ t(field === "context" ? "set.models.limitContext" : "set.models.limitOutput") }}</span>
              <span class="cp-pick-value">
                {{ limitLabel(limitOf(row[field]).value) }}
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
                :aria-checked="row[field] === String(value)"
                :data-model-limit-option="`${field}-${value}`"
                @click="(row[field] = String(value)), (openMenu = undefined)"
              >
                <span>{{ value }} ({{ limitLabel(value) }})</span>
                <span v-if="row[field] === String(value)" class="cp-check">✓</span>
              </button>
              <!-- The number itself, preset or not, as MiMo's field shows it: typing 128000 never blanks it. -->
              <div class="cp-menu-custom">
                <input
                  class="cp-in tiny"
                  inputmode="numeric"
                  v-model="row[field]"
                  :placeholder="t('set.models.limitCustom')"
                  :aria-label="t('set.models.limitCustom')"
                  :data-model-limit-custom="field"
                />
              </div>
            </div>
          </div>
          <div class="cp-pick" :data-menu-anchor="`mods:${row.key}`">
            <button type="button" class="cp-pick-btn wide" data-model-modality-menu :aria-expanded="openMenu === `mods:${row.key}`" aria-haspopup="menu" @click="toggleMenu(`mods:${row.key}`)">
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
        <!-- WB's layout: the switches in a row, the default as a drop-down, the levels in three columns - all in the card, not behind a button. -->
        <div class="cp-think" data-model-thinking-block>
          <div class="cp-think-switches">
            <button type="button" class="cp-chip" :aria-pressed="!row.thinking.on" @click="setEfforts(row, [])">{{ t("set.models.reasoningNone") }}</button>
            <button type="button" class="cp-chip" :aria-pressed="row.thinking.on && row.thinking.efforts.join() === standardEfforts.join()" @click="setEfforts(row, standardEfforts)">low·medium·high</button>
            <button type="button" class="cp-chip" :aria-pressed="row.thinking.on && row.thinking.efforts.join() === THINKING_LEVELS.join()" @click="setEfforts(row, THINKING_LEVELS)">{{ t("set.models.reasoningAll") }}</button>
          </div>
          <div class="cp-think-switches">
            <label class="cp-tick">
              <input v-model="row.thinking.on" type="checkbox" data-model-thinking="on" />
              {{ t("set.models.thinkingOn") }}
            </label>
            <template v-if="row.thinking.on">
              <label class="cp-tick">
                <input type="checkbox" :checked="!row.thinking.canOff" data-model-thinking="only" @change="setCanOff(row, !($event.target as HTMLInputElement).checked)" />
                {{ t("set.models.thinkingOnly") }}
              </label>
              <label class="cp-tick">
                <input type="checkbox" :checked="row.thinking.canOff" data-model-thinking="canOff" @change="setCanOff(row, ($event.target as HTMLInputElement).checked)" />
                {{ t("set.models.thinkingCanOff") }}
              </label>
            </template>
          </div>
          <template v-if="row.thinking.on">
            <div class="cp-think-field">
              <div class="cp-think-label">{{ t("set.models.thinkingDefault") }}</div>
              <SelectMenu
                class="cp-select"
                :model-value="row.thinking.default ?? 'auto'"
                :options="defaultOptions(row)"
                match-width
                :data-model-effort-default="row.id"
                @update:model-value="row.thinking.default = $event === 'auto' ? undefined : ($event as Effort)"
              />
            </div>
            <div class="cp-think-field">
              <div class="cp-think-label">{{ t("set.models.thinkingEfforts") }}</div>
              <div class="cp-think-grid">
                <button v-for="level in THINKING_LEVELS" :key="level" type="button" class="cp-chip" :aria-pressed="row.thinking.efforts.includes(level)" :disabled="row.thinking.efforts.length === 1 && row.thinking.efforts.includes(level)" :data-model-effort="level" @click="toggleLevel(row, level)">
                  {{ levelLabel(level) }}
                </button>
              </div>
            </div>
          </template>
        </div>
      </template>
      <div v-if="modelIdError(row)" class="cp-error" role="alert">{{ modelIdError(row) }}</div>
      <div v-if="limitProblem(row)" class="cp-error" data-model-limit-error>{{ t(limitProblem(row) === "integer" ? "provider.custom.limitInvalid" : "set.models.limitPair") }}</div>
    </div>

    <details class="cp-headers" :open="preset === 'custom' || Boolean(editing?.headers)">
      <summary class="cp-section">{{ t("provider.custom.headers.label") }}</summary>
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
    </details>

    <button v-if="standalone" class="cp-submit" type="submit" :disabled="busy || !canSave || (editing && !dirty)" data-custom-save>
      {{ busy ? t("common.saving") : editing && !dirty ? t("common.saved") : t("common.save") }}
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
.cp-headers > .cp-header,
.cp-headers > .cp-add {
  margin-top: 8px;
}

.cp-model-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  overflow-wrap: anywhere;
}

.cp-chip {
  padding: 4px 8px;
  border: 1px solid var(--text-weaker);
  border-radius: 999px;
  background: transparent;
  color: var(--text-base);
  cursor: pointer;
}

.cp-chip[aria-pressed="true"] {
  color: var(--text-strong);
  border-color: var(--text-strong);
  background: var(--surface-hover);
}

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
 * The protocol picker wears the field above it: the same 36 tall, 6 round, 1px
 * rule and dim-on-focus border, full width, the value at 13 in the field's
 * colour. `.cp` in front outranks SelectMenu's own `.select` / `.trigger` rules
 * and the settings page's `.content .trigger`, which is 28 tall and 8 round.
 */
.cp .cp-select {
  width: 100%;
}

.cp .cp-select :deep(.trigger) {
  justify-content: space-between;
  width: 100%;
  height: calc(36px * var(--ui-font-scale, 1));
  padding-block: 0;
  padding-inline: 12px 8px;
  color: var(--text-strong);
  background: transparent;
  border: 1px solid #e3e3e0;
  border-radius: 6px;
  outline: none;
  box-shadow: var(--shadow-xs);
  font-family: var(--font-sans);
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.cp .cp-select :deep(.trigger .label) {
  font-weight: 400;
}

.cp .cp-select :deep(.trigger .caret) {
  color: currentColor;
  opacity: 0.5;
}

.cp .cp-select :deep(.trigger:focus-visible),
.cp .cp-select :deep(.trigger.open) {
  border-color: var(--text-weak);
}

/* A field does not light up under the pointer; the settings page's ghost trigger does. */
.cp .cp-select :deep(.trigger:hover),
.cp .cp-select :deep(.trigger.open) {
  background: transparent;
}

:root[data-theme="dark"] .cp .cp-select :deep(.trigger),
:root[data-theme="dark"] .cp .cp-select :deep(.trigger:hover),
:root[data-theme="dark"] .cp .cp-select :deep(.trigger.open) {
  background: rgb(58 58 58 / 0.3);
  border-color: #3a3a3a;
}

:root[data-theme="dark"] .cp .cp-select :deep(.trigger:focus-visible),
:root[data-theme="dark"] .cp .cp-select :deep(.trigger.open) {
  border-color: var(--text-weak);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .cp .cp-select :deep(.trigger),
  :root:not([data-theme="light"]) .cp .cp-select :deep(.trigger:hover),
  :root:not([data-theme="light"]) .cp .cp-select :deep(.trigger.open) {
    background: rgb(58 58 58 / 0.3);
    border-color: #3a3a3a;
  }

  :root:not([data-theme="light"]) .cp .cp-select :deep(.trigger:focus-visible),
  :root:not([data-theme="light"]) .cp .cp-select :deep(.trigger.open) {
    border-color: var(--text-weak);
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
.cp-think {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.cp-think-switches {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 20px;
}

.cp-tick {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--text-strong);
  font-size: calc(13px * var(--ui-font-scale, 1));
  cursor: pointer;
}

.cp-think-label {
  margin-block-end: 6px;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.cp-think-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px 12px;
}

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

.cp-btn:focus-visible,
.cp-pick-btn:focus-visible,
.cp-eye:focus-visible,
.cp-model-remove:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: 2px;
}
</style>
