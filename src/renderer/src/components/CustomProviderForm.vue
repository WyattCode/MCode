<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from "vue"
import type { CustomModel, CustomProvider, Effort, ModelCandidate, ModelInfo } from "@shared/protocol"
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
 * A custom provider's connection fields and model list with a modal editor.
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

const catalog = computed(() => app.providers
  .filter((provider) => provider.id !== props.editing?.id)
  .map((provider) => {
    const byId = new Map<string, ModelInfo>()
    for (const model of provider.models) {
      const id = model.id.toLowerCase()
      if (!byId.has(id)) byId.set(id, model)
    }
    return byId
  }))

/** Look up the full or gateway-qualified id in provider order. */
function known(id: string): ModelInfo | undefined {
  const wanted = id.trim().toLowerCase()
  const tail = wanted.slice(wanted.lastIndexOf("/") + 1)
  for (const provider of catalog.value) {
    const hit = provider.get(wanted) ?? provider.get(tail)
    if (hit) return hit
  }
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

const blankMods = (): Mods => ({ image: false, audio: false, video: false, pdf: false })

function newRow(): ModelRow {
  return {
    key: nextKey++,
    id: "",
    name: "",
    context: "",
    output: "",
    mods: blankMods(),
    thinking: blankThinking(),
    touched: false,
  }
}

const editing = props.editing
type Probe = { status: "idle" | "busy" | "ok" | "fail"; modelIds: (string | ModelCandidate)[]; text: string }
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

/* ------------------------------------------------------------ the model editor */

type ModelField = "name" | "context" | "output" | "modalities"
type ErrorField = "modelId" | "context" | "output"
const editor = ref<ModelRow>()
const editorMode = ref<"add" | "edit">("add")
const fieldErrors = ref<Partial<Record<ErrorField, string>>>({})
const dirtyFields = new Set<ModelField>()
const autoFilled = new Set<ModelField>()
let selectedId: string | undefined
const comboOpen = ref(false)
const composing = ref(false)
const highlight = ref(-1)
const comboEl = ref<HTMLInputElement>()
const comboMenuEl = ref<HTMLElement>()
const recommendation = computed<Thinking | undefined>(() => {
  const row = editor.value
  if (!row) return
  const hint = known(row.id)
  const efforts = THINKING_LEVELS.filter((level) => hint?.variants.includes(level))
  if (efforts.length) return { on: true, efforts, canOff: hint?.variants.includes("none") ?? false, default: efforts.find((level) => level === hint?.defaultEffort) }
})
const reasoningChanged = ref(false)
const currentThinking = computed(() => {
  if (editorMode.value === "add" && !reasoningChanged.value && recommendation.value) return recommendation.value
  return editor.value?.thinking ?? blankThinking()
})

const probeModelIds = computed(() => probe.value.modelIds)
const candidateIndex = computed(() => {
  const candidates = new Map<string, ModelCandidate>()
  if (probeModelIds.value.length) {
    for (const result of probeModelIds.value) {
      const candidate = typeof result === "string" ? { id: result } : result
      const hint = known(candidate.id)
      candidates.set(candidate.id, {
        id: candidate.id,
        name: candidate.name ?? hint?.name,
        contextWindow: candidate.contextWindow ?? hint?.contextWindow,
        maxOutput: candidate.maxOutput ?? hint?.maxOutput,
        inputs: hint?.inputs ? { ...hint.inputs, ...candidate.inputs } : candidate.inputs,
      })
    }
  } else {
    for (const provider of catalog.value) {
      for (const model of provider.values()) {
        if (!candidates.has(model.id)) candidates.set(model.id, model)
      }
    }
  }
  return Array.from(candidates.values(), (candidate) => ({
    candidate,
    id: candidate.id.toLowerCase(),
    name: candidate.name?.toLowerCase(),
  }))
})
const query = computed(() => editor.value?.id.trim().toLowerCase() ?? "")
const choices = computed(() => {
  const needle = query.value
  const matches: ModelCandidate[] = []
  for (const { candidate, id, name } of candidateIndex.value) {
    if (!needle || id.includes(needle) || name?.includes(needle)) matches.push(candidate)
  }
  return matches
})
const emptyQueryLimit = 200
const optionHeight = 30
const menuScrollTop = ref(0)
const windowedChoices = computed(() => !query.value && choices.value.length > emptyQueryLimit)
const choiceStart = computed(() => windowedChoices.value
  ? Math.min(Math.max(0, Math.floor(menuScrollTop.value / optionHeight) - 10), choices.value.length - emptyQueryLimit)
  : 0)
const choiceEnd = computed(() => windowedChoices.value ? choiceStart.value + emptyQueryLimit : choices.value.length)
const visibleChoices = computed(() => windowedChoices.value ? choices.value.slice(choiceStart.value, choiceEnd.value) : choices.value)

watch(choices, () => (highlight.value = -1), { flush: "sync" })
watch(choices, () => {
  menuScrollTop.value = 0
  if (comboMenuEl.value) comboMenuEl.value.scrollTop = 0
}, { flush: "sync" })

function onComboScroll(event: Event) {
  menuScrollTop.value = (event.currentTarget as HTMLElement).scrollTop
  if (highlight.value >= 0 && (highlight.value < choiceStart.value || highlight.value >= choiceEnd.value)) highlight.value = -1
}

function closeCombo() {
  comboOpen.value = false
  highlight.value = -1
  menuScrollTop.value = 0
}

function closeEditor() {
  closeCombo()
  editor.value = undefined
  composing.value = false
}

useEscapeLayerWhile(() => editor.value, () => {
  if (comboOpen.value) closeCombo()
  else closeEditor()
})

function openEditor(row?: ModelRow) {
  editorMode.value = row ? "edit" : "add"
  editor.value = row
    ? { ...row, mods: { ...row.mods }, thinking: { ...row.thinking, efforts: [...row.thinking.efforts] } }
    : newRow()
  dirtyFields.clear()
  autoFilled.clear()
  selectedId = undefined
  fieldErrors.value = {}
  reasoningChanged.value = false
  void nextTick(() => (row ? nameEl.value : comboEl.value)?.focus())
}

const nameEl = ref<HTMLInputElement>()
const dialogId = useId()
const comboId = `${dialogId}-combo`
const limitFields = ["context", "output"] as const

function setModelId(row: ModelRow, id: string) {
  if (selectedId !== undefined && normalizeModelId(id) !== normalizeModelId(selectedId)) {
    for (const field of autoFilled) {
      if (dirtyFields.has(field)) continue
      if (field === "modalities") {
        row.mods = blankMods()
        row.touched = Boolean(row.stored)
      } else {
        row[field] = ""
        if (field !== "name") delete fieldErrors.value[field]
      }
    }
    selectedId = undefined
    autoFilled.clear()
  }
  row.id = id
  delete fieldErrors.value.modelId
}

function inputModelId(row: ModelRow, event: Event) {
  if (composing.value) return
  setModelId(row, (event.target as HTMLInputElement).value)
  comboOpen.value = true
}

function endComposition(row: ModelRow, event: CompositionEvent) {
  composing.value = false
  inputModelId(row, event)
}

function pickModel(row: ModelRow, candidate: ModelCandidate) {
  setModelId(row, candidate.id)
  selectedId = candidate.id
  if (candidate.name) {
    row.name = candidate.name
    autoFilled.add("name")
    dirtyFields.delete("name")
  }
  for (const [field, value] of [["context", candidate.contextWindow], ["output", candidate.maxOutput]] as const) {
    if (value !== undefined && value > 0) {
      row[field] = String(value)
      delete fieldErrors.value.context
      delete fieldErrors.value.output
      autoFilled.add(field)
      dirtyFields.delete(field)
    }
  }
  if (candidate.inputs) {
    row.mods = { ...blankMods(), ...candidate.inputs }
    row.touched = true
    autoFilled.add("modalities")
    dirtyFields.delete("modalities")
  }
  closeCombo()
}

function comboKey(row: ModelRow, event: KeyboardEvent) {
  if (composing.value || event.isComposing || event.keyCode === 229) return
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault()
    comboOpen.value = true
    if (!choices.value.length) return
    const step = event.key === "ArrowDown" ? 1 : -1
    highlight.value = Math.max(0, Math.min(highlight.value + step, choices.value.length - 1))
    if (highlight.value < choiceStart.value || highlight.value >= choiceEnd.value) {
      menuScrollTop.value = highlight.value * optionHeight
      if (comboMenuEl.value) comboMenuEl.value.scrollTop = menuScrollTop.value
    }
    void nextTick(() => comboMenuEl.value?.querySelector<HTMLElement>(".cp-option.on")?.scrollIntoView?.({ block: "nearest" }))
  } else if (event.key === "Enter") {
    event.preventDefault()
    const index = comboOpen.value ? highlight.value : -1
    const choice = choices.value[index]
    if (choice) pickModel(row, choice)
    else {
      const value = comboEnterValue(index, choices.value.map((pick) => pick.id), row.id)
      setModelId(row, value)
      closeCombo()
    }
  }
}

function onOutside(event: MouseEvent) {
  if (!(event.target as Element | null)?.closest?.("[data-model-combo-root]")) closeCombo()
}
onMounted(() => document.addEventListener("mousedown", onOutside, true))
onBeforeUnmount(() => document.removeEventListener("mousedown", onOutside, true))

function setLimit(row: ModelRow, field: (typeof limitFields)[number], value: string) {
  row[field] = value
  dirtyFields.add(field)
  delete fieldErrors.value.context
  delete fieldErrors.value.output
}

function commitModel() {
  const row = editor.value
  if (!row) return
  const errors: Partial<Record<ErrorField, string>> = {}
  const idError = modelIdError(row)
  if (idError) errors.modelId = idError
  for (const field of limitFields) {
    if (!limitOf(row[field]).ok) errors[field] = t("set.models.limitInvalid")
  }
  if (limitProblem(row) === "pair") errors[row.context.trim() ? "output" : "context"] = t("set.models.limitPair")
  fieldErrors.value = errors
  if (Object.keys(errors).length) return

  row.id = normalizeModelId(row.id)
  row.name = row.name.trim()
  row.thinking = { ...currentThinking.value, efforts: [...currentThinking.value.efforts], default: activeDefault.value }
  const index = form.value.models.findIndex((model) => model.key === row.key)
  if (index < 0) form.value.models.push(row)
  else form.value.models.splice(index, 1, row)
  closeEditor()
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

function toggleMod(row: ModelRow, key: Modality, on: boolean) {
  row.mods[key] = on
  row.touched = true
  dirtyFields.add("modalities")
}

const reasoningPresets = [
  { id: "none", efforts: [], label: () => t("set.models.reasoningNone") },
  { id: "low-high", efforts: ["low", "medium", "high"], label: () => "low–high" },
  { id: "low-max", efforts: THINKING_LEVELS, label: () => "low–max" },
] as const

const selectedEfforts = computed(() => currentThinking.value.on ? currentThinking.value.efforts : [])
const activeDefault = computed(() => selectedEfforts.value.find((level) => level === currentThinking.value.default))

function sameEfforts(efforts: readonly Effort[]): boolean {
  return selectedEfforts.value.length === efforts.length && efforts.every((level) => selectedEfforts.value.includes(level))
}

function setEfforts(row: ModelRow, efforts: readonly Effort[]) {
  const settings = currentThinking.value
  reasoningChanged.value = true
  // Keep the preferred level in the draft so removing and readding it restores it.
  row.thinking = { ...settings, on: efforts.length > 0, efforts: [...efforts] }
}

function setCanOff(row: ModelRow, canOff: boolean) {
  row.thinking = { ...currentThinking.value, canOff }
  reasoningChanged.value = true
}

const preferredLevel = computed({
  get: () => activeDefault.value ?? "auto",
  set: (value: string) => {
    const row = editor.value
    if (!row) return
    row.thinking = { ...currentThinking.value, default: selectedEfforts.value.find((level) => level === value) }
    reasoningChanged.value = true
  },
})

function toggleLevel(row: ModelRow, level: Effort) {
  const efforts = THINKING_LEVELS.filter((one) => (one === level) !== selectedEfforts.value.includes(one))
  if (efforts.length) setEfforts(row, efforts)
}

function resetRecommendation(row: ModelRow) {
  const settings = recommendation.value
  if (!settings) return
  reasoningChanged.value = true
  row.thinking = { ...settings, efforts: [...settings.efforts] }
}

const usesRecommendation = computed(() => {
  const recommended = recommendation.value
  return Boolean(recommended && sameEfforts(recommended.efforts) && recommended.default === activeDefault.value &&
    recommended.canOff === currentThinking.value.canOff)
})

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
  if (busy.value || editor.value || !canSave.value) {
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

    <section class="cp-model-section" data-model-section>
      <header class="cp-model-list-header" data-model-list-header>
        <h3>{{ t("set.models.modelList") }}</h3>
        <button type="button" class="cp-btn cp-model-add" data-model-add @click="openEditor()">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 2v10M2 7h10" stroke="currentColor" stroke-linecap="round" /></svg>
          {{ t("set.models.addModel") }}
        </button>
      </header>

      <div v-if="form.models.length" class="cp-model-list" data-model-list>
        <div v-for="row in form.models" :key="row.key" class="cp-model" :data-model-card="row.id">
          <div class="cp-model-copy">
            <div class="cp-model-meta">
              <span class="cp-model-id" :data-model-id="row.id" :title="row.id">{{ row.id }}</span>
              <span v-if="limitOf(row.context).value !== undefined" class="cp-badge cp-limit-badge" :title="`${t('set.models.limitContext')} ${limitLabel(limitOf(row.context).value)}`">{{ limitLabel(limitOf(row.context).value) }}</span>
              <span v-if="limitOf(row.output).value !== undefined" class="cp-badge cp-limit-badge">{{ t("set.models.limitOutput") }} {{ limitLabel(limitOf(row.output).value) }}</span>
              <span v-if="MODALITIES.some((key) => row.mods[key])" class="cp-badge cp-mod-badge" data-model-modality-summary>{{ modalitySummary(row.mods, modLabel, " · ") }}</span>
            </div>
            <span v-if="row.name && row.name !== row.id" class="cp-model-name" :title="row.name">{{ row.name }}</span>
          </div>
          <div class="cp-model-actions">
            <button type="button" class="cp-model-icon" :data-model-edit="row.id" :title="t('set.models.editModel')" :aria-label="t('set.models.editModel')" @click="openEditor(row)">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8.8 3.2 2 2M2 12l.5-3.1 7-7a1.4 1.4 0 0 1 2 2l-7 7L2 12Z" /></svg>
            </button>
            <button type="button" class="cp-model-icon danger" :data-model-rm="row.id" :title="t('set.models.remove')" :aria-label="t('set.models.remove')" @click="removingModel = row">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 3.5h9M5.5 3.5V2h3v1.5M4 3.5l.5 8.5h5l.5-8.5M6 5.5v4.5M8 5.5v4.5" /></svg>
            </button>
          </div>
        </div>
      </div>
      <div v-else class="cp-model-empty" data-model-list-empty>{{ t("set.models.modelEmpty") }}</div>
      <div v-if="tried && !form.models.length" class="cp-error" data-model-needed>{{ t("set.models.needModel") }}</div>
    </section>

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
      <div v-if="editor" class="cp-model-scrim" @mousedown.self="closeEditor">
        <div v-modal class="cp-model-dialog" data-model-editor-dialog :data-model-editor-mode="editorMode" role="dialog" aria-modal="true" :aria-labelledby="`${dialogId}-title`">
          <h2 :id="`${dialogId}-title`">{{ t(editorMode === "add" ? "set.models.addModel" : "set.models.editModel") }}</h2>
          <div class="cp-model-fields">
            <div>
              <label class="cp-field-label" :for="comboId">{{ t("set.models.modelId") }}</label>
              <div class="cp-combo" data-model-combo-root>
                <input
                  :id="comboId"
                  ref="comboEl"
                  :value="editor.id"
                  class="cp-in"
                  :class="{ bad: fieldErrors.modelId }"
                  :placeholder="t('set.models.comboPlaceholder')"
                  :aria-invalid="Boolean(fieldErrors.modelId)"
                  :aria-describedby="fieldErrors.modelId ? `${comboId}-error` : undefined"
                  :aria-controls="comboOpen ? `${comboId}-menu` : undefined"
                  :aria-activedescendant="comboOpen && choices[highlight] ? `${comboId}-${highlight}` : undefined"
                  :aria-expanded="comboOpen"
                  role="combobox"
                  aria-autocomplete="list"
                  autocomplete="off"
                  spellcheck="false"
                  data-model-combo
                  @focus="comboOpen = true"
                  @blur="closeCombo"
                  @input="inputModelId(editor, $event)"
                  @compositionstart="composing = true"
                  @compositionend="endComposition(editor, $event)"
                  @keydown="comboKey(editor, $event)"
                />
                <div v-if="comboOpen" :id="`${comboId}-menu`" ref="comboMenuEl" class="cp-menu combo" role="listbox" data-model-combo-menu :aria-label="t('set.models.modelId')" @scroll="onComboScroll">
                  <div v-if="!choices.length" class="cp-menu-empty" data-model-combo-empty>{{ t("set.models.comboEmpty") }}</div>
                  <div v-if="choiceStart" role="presentation" aria-hidden="true" :style="{ height: `${choiceStart * optionHeight}px` }"></div>
                  <button v-for="(choice, index) in visibleChoices" :id="`${comboId}-${choiceStart + index}`" :key="choice.id" type="button" role="option" tabindex="-1"
                    class="cp-option" :class="{ on: highlight === choiceStart + index }" :aria-selected="highlight === choiceStart + index"
                    :style="windowedChoices ? { height: `${optionHeight}px` } : undefined"
                    :aria-posinset="windowedChoices ? choiceStart + index + 1 : undefined"
                    :aria-setsize="windowedChoices ? choices.length : undefined"
                    :data-model-combo-option="choice.id" @mouseenter="highlight = choiceStart + index" @mousedown.prevent @click="pickModel(editor, choice)">
                    <span class="cp-option-id">{{ choice.id }}</span>
                    <span v-if="choice.name" class="cp-option-name" data-model-combo-name>{{ choice.name }}</span>
                  </button>
                  <div v-if="choiceEnd < choices.length" role="presentation" aria-hidden="true"
                    :style="{ height: `${(choices.length - choiceEnd) * optionHeight}px` }"></div>
                </div>
              </div>
              <div v-if="fieldErrors.modelId" :id="`${comboId}-error`" role="alert" class="cp-error" data-model-field-error="modelId">{{ fieldErrors.modelId }}</div>
            </div>
            <div>
              <label class="cp-field-label" :for="`${dialogId}-name`">{{ t("set.models.displayName") }}</label>
              <input :id="`${dialogId}-name`" ref="nameEl" v-model="editor.name" class="cp-in" spellcheck="false" data-model-name-editor @input="dirtyFields.add('name')" />
            </div>
            <div class="cp-limits">
              <div v-for="field in limitFields" :key="field">
                <label class="cp-field-label" :for="`${dialogId}-${field}`">{{ t(field === "context" ? "set.models.limitContext" : "set.models.limitOutput") }}</label>
                <input
                  :id="`${dialogId}-${field}`"
                  :value="editor[field]"
                  class="cp-in cp-limit-input"
                  :class="{ bad: fieldErrors[field] }"
                  inputmode="numeric"
                  :placeholder="t('set.models.limitCustom')"
                  :aria-invalid="Boolean(fieldErrors[field])"
                  :aria-describedby="fieldErrors[field] ? `${dialogId}-${field}-error` : undefined"
                  :data-model-limit="field"
                  :data-model-limit-custom="field"
                  @input="setLimit(editor, field, ($event.target as HTMLInputElement).value)"
                />
                <div class="cp-limit-presets" role="group" :aria-label="t(field === 'context' ? 'set.models.limitContext' : 'set.models.limitOutput')">
                  <button v-for="value in LIMIT_PRESETS[field]" :key="value" type="button" class="cp-chip cp-limit-chip"
                    :data-model-limit-option="`${field}-${value}`" :aria-pressed="limitOf(editor[field]).value === value"
                    :title="`${value} (${limitLabel(value)})`" @click="setLimit(editor, field, String(value))">{{ limitLabel(value) }}</button>
                </div>
                <div v-if="fieldErrors[field]" :id="`${dialogId}-${field}-error`" role="alert" class="cp-error" :data-model-field-error="field">{{ fieldErrors[field] }}</div>
              </div>
            </div>
            <fieldset>
              <legend>{{ t("set.models.inputTypes") }}</legend>
              <div class="cp-modalities" data-model-input-types>
                <label class="cp-mod-card" data-model-modality-card="text" data-state="checked">
                  <input type="checkbox" checked disabled data-model-modality="text" />
                  {{ t("set.models.modalityText") }}
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" aria-hidden="true"><rect x="3" y="6" width="8" height="6" rx="1" /><path d="M5 6V4a2 2 0 0 1 4 0v2" /></svg>
                </label>
                <label v-for="key in MODALITIES" :key="key" class="cp-mod-card" :data-model-modality-card="key" :data-state="editor.mods[key] ? 'checked' : 'unchecked'">
                  <input type="checkbox" :checked="editor.mods[key]" :data-model-modality="key" @change="toggleMod(editor, key, ($event.target as HTMLInputElement).checked)" />
                  {{ modLabel(key) }}
                </label>
              </div>
            </fieldset>
            <fieldset data-model-reasoning>
              <legend>
                <span class="cp-reasoning-legend">
                  <span>{{ t("set.models.reasoning") }}</span>
                  <span v-if="recommendation" class="cp-recommendation">
                    <span data-model-reasoning-state>{{ t(usesRecommendation ? "set.models.reasoningRecommended" : "set.models.reasoningCustom") }}</span>
                    <button v-if="!usesRecommendation" type="button" class="cp-reset" data-model-reasoning-reset @click="resetRecommendation(editor)">{{ t("set.models.reasoningReset") }}</button>
                  </span>
                </span>
              </legend>
              <div class="cp-quick-settings">
                <span>{{ t("set.models.reasoningPresets") }}</span>
                <button v-for="option in reasoningPresets" :key="option.id" type="button" class="cp-chip" :data-model-reasoning-preset="option.id"
                  :aria-pressed="sameEfforts(option.efforts)" @click="setEfforts(editor, option.efforts)">{{ option.label() }}</button>
              </div>
              <div class="cp-efforts" role="group" :aria-label="t('set.models.reasoning')">
                <button v-for="level in THINKING_LEVELS" :key="level" type="button" class="cp-chip" :data-model-reasoning-level="level"
                  :aria-pressed="selectedEfforts.includes(level)" :disabled="selectedEfforts.length === 1 && selectedEfforts.includes(level)"
                  @click="toggleLevel(editor, level)">{{ level }}</button>
              </div>
              <details v-if="currentThinking.on" class="cp-thinking-advanced">
                <summary>{{ t("set.advanced") }}</summary>
                <label class="cp-tick">
                  <input type="checkbox" :checked="currentThinking.canOff" data-model-thinking="canOff"
                    @change="setCanOff(editor, ($event.target as HTMLInputElement).checked)" />
                  {{ t("set.permAllow") }} {{ t("set.motion.off") }}
                </label>
                <label class="cp-thinking-default">
                  {{ t("effort.default") }}
                  <select v-model="preferredLevel" data-model-effort-default>
                    <option value="auto">{{ t("effort.default") }}</option>
                    <option v-for="level in selectedEfforts" :key="level" :value="level">{{ level }}</option>
                  </select>
                </label>
              </details>
            </fieldset>
          </div>
          <footer class="cp-model-footer" data-model-editor-footer>
            <button type="button" class="cp-chip" data-model-editor-cancel @click="closeEditor">{{ t("common.cancel") }}</button>
            <button type="button" class="cp-submit" data-model-editor-save @click="commitModel">{{ t("common.save") }}</button>
          </footer>
        </div>
      </div>
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

/* Spacing between the provider fields, model list and request headers. */
.cp {
  display: flex;
  flex-direction: column;
  gap: 16px;
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

.cp-model-list-header,
.cp-model-add,
.cp-model-actions,
.cp-model-meta {
  display: flex;
  align-items: center;
  gap: 6px;
}

.cp-model-list-header {
  justify-content: space-between;
  margin-bottom: 8px;
}

.cp-model-list-header h3 {
  margin: 0;
  color: var(--text-base);
  font-size: 13px;
  font-weight: 500;
}

.cp-model-list,
.cp-model-empty {
  background: var(--surface-page);
  border: 1px solid var(--border-weak);
  border-radius: 10px;
}

.cp-model-empty {
  padding: 16px;
  border-style: dashed;
  color: var(--text-base);
  font-size: 12px;
}

.cp-model {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 52px;
  padding: 8px 12px;
}

.cp-model + .cp-model {
  border-top: 1px solid var(--border-weak);
}

.cp-model-copy {
  flex: 1;
  min-width: 0;
}

.cp-model-meta {
  flex-wrap: wrap;
}

.cp-model-id,
.cp-model-name,
.cp-option-id,
.cp-option-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cp-model-id {
  font: 500 13px var(--font-mono);
  color: var(--text-strong);
  max-width: 100%;
}

.cp-model-name {
  display: block;
  margin-top: 3px;
  color: var(--text-base);
  font-size: 12px;
}

.cp-badge {
  padding: 1px 6px;
  border-radius: 4px;
  color: var(--text-base);
  font-size: 11px;
  white-space: nowrap;
}

.cp-limit-badge {
  border: 1px solid var(--border-weak);
  font-family: var(--font-mono);
}

.cp-mod-badge {
  background: var(--surface-hover);
}

.cp-model-icon {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-base);
  cursor: pointer;
}

.cp-model-icon:hover {
  background: var(--surface-hover);
}

.cp-model-icon.danger:hover {
  color: var(--text-critical);
}

.cp-model-scrim {
  position: fixed;
  inset: 0;
  z-index: 130;
  display: grid;
  place-items: center;
  background: #00000080;
}

.cp-model-dialog {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  width: min(600px, 100vw - 32px);
  max-height: min(720px, 100vh - 32px);
  box-sizing: border-box;
  padding: 20px;
  border: 1px solid var(--border-weak);
  border-radius: 12px;
  background: var(--surface-page);
  box-shadow: var(--shadow-pop);
  color: var(--text-strong);
}

.cp-model-dialog h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}

.cp-model-fields {
  display: grid;
  align-content: start;
  gap: 16px;
  margin-top: 16px;
  padding: 2px 4px 2px 2px;
  overflow-y: auto;
}

.cp-model-fields .cp-in {
  width: 100%;
  min-width: 0;
}

.cp-model-fields .cp-limit-input {
  font: 500 13px var(--font-mono);
}

.cp-model-fields fieldset {
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}

.cp-field-label,
.cp-model-fields legend {
  display: block;
  box-sizing: border-box;
  width: 100%;
  padding: 0;
  margin-bottom: 6px;
  font-size: 13px;
  font-weight: 500;
}

.cp-combo {
  position: relative;
}

.cp-menu.combo {
  position: absolute;
  z-index: 2;
  inset: calc(100% + 4px) 0 auto;
  box-sizing: border-box;
  max-height: 220px;
  padding: 4px;
  overflow-y: auto;
  background: var(--surface-page);
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  box-shadow: var(--shadow-pop);
}

.cp-menu-empty,
.cp-option,
.cp-model-fields .cp-error {
  font-size: 12px;
}

.cp-menu-empty {
  padding: 8px;
  color: var(--text-base);
}

.cp-option {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 7px 8px;
  border: 0;
  border-radius: 4px;
  color: var(--text-strong);
  background: transparent;
  cursor: pointer;
}

.cp-option-id {
  font-weight: 500;
}

.cp-option-name {
  flex: none;
  max-width: 45%;
  color: var(--text-base);
}

.cp-option:hover,
.cp-option.on {
  background: var(--surface-hover);
}

.cp-thinking-advanced {
  margin-top: 8px;
}

.cp-thinking-advanced > summary {
  cursor: pointer;
}

.cp-thinking-advanced label {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.cp-thinking-default select {
  color: inherit;
  background: var(--surface-page);
  border: 1px solid var(--border-weak);
  border-radius: 6px;
  padding: 4px 8px;
}

.cp-limits,
.cp-limit-presets,
.cp-efforts {
  display: grid;
  gap: 6px;
}

.cp-limits {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

@media (max-width: 480px) {
  .cp-limits {
    grid-template-columns: minmax(0, 1fr);
  }
}

.cp-limit-presets {
  margin-top: 6px;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.cp-chip {
  min-height: 26px;
  padding: 3px 5px;
  border: 1px solid var(--border-weak);
  border-radius: 6px;
  background: transparent;
  color: var(--text-base);
  font-size: 12px;
  cursor: pointer;
}

.cp-limit-chip {
  font-family: var(--font-mono);
}

.cp-chip[aria-pressed="true"],
.cp-mod-card[data-state="checked"] {
  color: var(--text-strong);
  border-color: var(--interactive);
  background: color-mix(in srgb, var(--interactive) 9%, var(--surface-page));
}

.cp-reasoning-legend,
.cp-recommendation,
.cp-modalities,
.cp-quick-settings,
.cp-model-footer {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.cp-reasoning-legend {
  justify-content: space-between;
}

.cp-recommendation,
.cp-quick-settings > span {
  color: var(--text-base);
  font-size: 12px;
  font-weight: 400;
}

.cp-reset {
  padding: 0;
  border: 0;
  color: var(--interactive);
  background: transparent;
  font-size: inherit;
  text-decoration: underline;
  cursor: pointer;
}

.cp-efforts {
  margin-top: 8px;
  grid-template-columns: repeat(5, minmax(0, 1fr));
}

.cp-mod-card {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border: 1px solid var(--border-weak);
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
}

.cp-mod-card input {
  margin: 0;
  accent-color: var(--interactive);
}

.cp-mod-card:has(:disabled),
.cp-chip:disabled {
  cursor: default;
}

.cp-model-footer {
  justify-content: flex-end;
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--border-weak);
}

.cp-model-footer button {
  height: auto;
  min-height: 32px;
  padding: 6px 14px;
  font-size: 13px;
}

.cp-model-icon:focus-visible,
.cp-model-dialog button:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: 2px;
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
.cp-eye:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: 2px;
}
</style>
