<script setup lang="ts">
import { computed, ref } from "vue"
import type { CustomModel, CustomProvider } from "@shared/protocol"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"
import { notice } from "../lib/toast"
import { LIMIT_PRESETS, limitOf, validEndpoint } from "../lib/custom-model"

/**
 * Adding an OpenAI-compatible provider by base URL - MiMo's add / edit model
 * form, holding several models where MiMo's holds one.
 *
 * Two hosts: the 640px add / edit model dialog on the models page, and the
 * connect dialog's custom step. In the dialog the host draws the footer and
 * calls `submit`; elsewhere the form keeps its own save button.
 *
 * As MiMo's: the endpoint carries its hint and turns red the moment it is not
 * an http(s) URL with a host, Save stays off until the required fields are
 * valid, the key is a password field with an eye, each limit is digits with a
 * row of preset pills, and a save toasts and selects the saved model.
 *
 * MCode's own: the key is optional (a provider may authenticate with headers
 * only) and `{env:VAR}` still works in it; each model row carries the
 * 高级配置 disclosure because the form holds many models.
 */

const props = defineProps<{
  autofocus?: boolean
  /**
   * The provider being edited - MiMo's 编辑 on a saved custom model. Its id is
   * locked, and the key field starts blank (the window is never sent the key)
   * unless the key comes from a variable, which is only a name.
   */
  editing?: CustomProvider
  /** Drawn inside a dialog that supplies its own footer. */
  framed?: boolean
}>()
const emit = defineEmits<{ connected: [providerID: string] }>()

const app = useApp()

const PROVIDER_ID = /^[a-z0-9][a-z0-9-_]*$/

interface ModelRow {
  id: string
  name: string
  /** MiMo's three-state 图片输入: undefined follows the provider or catalog default. */
  attachment?: boolean
  /** The two limits as typed: blank or a whole number of tokens. */
  context: string
  output: string
  /** Whether this row's 高级配置 is open. */
  advanced: boolean
  err: { id?: string; name?: string; limit?: string }
}

interface HeaderRow {
  key: string
  value: string
  err: { key?: string; value?: string }
}

const modelRow = (): ModelRow => ({ id: "", name: "", context: "", output: "", advanced: false, err: {} })
const headerRow = (): HeaderRow => ({ key: "", value: "", err: {} })

/*
 * Both repeaters start with one row and refuse to drop below it. For models
 * that is the point - at least one is mandatory, because nothing discovers
 * them for a custom provider - and for headers it means the form always shows
 * one empty pair that may simply be left blank.
 */
const editing = props.editing
const form = ref({
  providerID: editing?.id ?? "",
  name: editing?.name ?? "",
  baseURL: editing?.baseURL ?? "",
  /* Which API the gateway speaks; a provider stored before this existed is OpenAI-compatible. */
  protocol: (editing?.protocol ?? "openai") as NonNullable<CustomProvider["protocol"]>,
  apiKey: editing?.environment ? `{env:${editing.environment}}` : "",
  models: editing?.models?.length
    ? editing.models.map((model) => ({
        ...modelRow(),
        id: model.id,
        name: model.name,
        attachment: model.attachment,
        context: model.limit?.context ? String(model.limit.context) : "",
        output: model.limit?.output ? String(model.limit.output) : "",
        advanced: model.attachment !== undefined || Boolean(model.limit),
      }))
    : [modelRow()],
  headers: Object.keys(editing?.headers ?? {}).length
    ? Object.entries(editing?.headers ?? {}).map(([key, value]) => ({ ...headerRow(), key, value }))
    : [headerRow()],
  err: {} as { providerID?: string; name?: string },
})

const busy = ref(false)
/* A variable name is only a name, so an edit shows it; a typed key starts hidden. */
const keyShown = ref(Boolean(editing?.environment))

type Field = "providerID" | "name" | "baseURL" | "apiKey"

function setField(field: Field, value: string) {
  form.value[field] = value
  if (field === "providerID" || field === "name") form.value.err[field] = undefined
}

/* MiMo's live check: red as soon as the text stops being an http(s) URL with a host. */
const endpointBad = computed(() => Boolean(form.value.baseURL.trim()) && !validEndpoint(form.value.baseURL))

/* Save is available only when everything required is valid, as MiMo's is. */
const canSave = computed(() => {
  const value = form.value
  if (!PROVIDER_ID.test(value.providerID.trim()) || !value.name.trim() || !validEndpoint(value.baseURL)) return false
  return value.models.every((row) => {
    const context = limitOf(row.context)
    const output = limitOf(row.output)
    return (
      row.id.trim() &&
      row.name.trim() &&
      context.ok &&
      output.ok &&
      !(output.value !== undefined && context.value === undefined)
    )
  })
})

function addModel() {
  form.value.models.push(modelRow())
}

function removeModel(at: number) {
  if (form.value.models.length <= 1) return
  form.value.models.splice(at, 1)
}

function addHeader() {
  form.value.headers.push(headerRow())
}

function removeHeader(at: number) {
  if (form.value.headers.length <= 1) return
  form.value.headers.splice(at, 1)
}

/* MiMo's cycle for 图片输入: default, then on, then off, then default again. */
function cycleImage(row: ModelRow) {
  row.attachment = row.attachment === undefined ? true : row.attachment ? false : undefined
}

/* MiMo's pills write the token count itself; digits are all the field takes. */
function typeLimit(row: ModelRow, field: "context" | "output", event: Event) {
  const input = event.target as HTMLInputElement
  const digits = input.value.replace(/\D/g, "")
  if (digits !== input.value) input.value = digits
  row[field] = digits
  row.err.limit = undefined
}

interface Resolved {
  id: string
  name: string
  baseURL: string
  apiKey: string
  headers: Record<string, string>
  models: CustomModel[]
  protocol: NonNullable<CustomProvider["protocol"]>
}

/**
 * The form's answer, or undefined when something is wrong.
 *
 * Writes each message under the field it belongs to: with four scalars and two
 * repeaters, "something is required" leaves the reader hunting.
 */
function validate(): Resolved | undefined {
  const providerID = form.value.providerID.trim()
  const name = form.value.name.trim()
  const baseURL = form.value.baseURL.trim()
  /*
   * Every provider's id, not only the custom ones: taking a built-in's id
   * would shadow it with no way back.
   */
  const taken = new Set(app.providers.map((entry) => entry.id))
  const err: { providerID?: string; name?: string } = {
    providerID: !providerID
      ? t("provider.custom.error.providerID.required")
      : !PROVIDER_ID.test(providerID)
        ? t("provider.custom.error.providerID.format")
        : !editing && taken.has(providerID)
          ? t("provider.custom.error.providerID.exists")
          : undefined,
    name: !name ? t("provider.custom.error.name.required") : undefined,
  }
  form.value.err = err
  let ok = !err.providerID && !err.name && validEndpoint(baseURL)

  const models: CustomModel[] = []
  const seenModels = new Set<string>()
  for (const row of form.value.models) {
    const id = row.id.trim()
    const label = row.name.trim()
    const context = limitOf(row.context)
    const output = limitOf(row.output)
    // MiMo's rule: whole positive numbers, and an output limit only beside an input limit.
    const limitBad = !context.ok || !output.ok || (output.value !== undefined && context.value === undefined)
    row.err = {
      id: !id
        ? t("provider.custom.error.required")
        : seenModels.has(id)
          ? t("provider.custom.error.duplicate")
          : undefined,
      name: !label ? t("provider.custom.error.required") : undefined,
      limit: limitBad ? t("provider.custom.limitInvalid") : undefined,
    }
    // A limit error inside a closed disclosure would be invisible, so it opens.
    if (limitBad) row.advanced = true
    if (row.err.id || row.err.name || row.err.limit) ok = false
    else {
      seenModels.add(id)
      const model: CustomModel = { id, name: label }
      if (row.attachment !== undefined) model.attachment = row.attachment
      if (context.value !== undefined) {
        model.limit = output.value !== undefined ? { context: context.value, output: output.value } : { context: context.value }
      }
      models.push(model)
    }
  }

  const headers: Record<string, string> = {}
  const seenHeaders = new Set<string>()
  for (const row of form.value.headers) {
    const key = row.key.trim()
    const value = row.value.trim()
    // A wholly blank row is the untouched one the repeater always shows.
    if (!key && !value) {
      row.err = {}
      continue
    }
    row.err = {
      key: !key
        ? t("provider.custom.error.required")
        : seenHeaders.has(key.toLowerCase())
          ? t("provider.custom.error.duplicate")
          : undefined,
      value: !value ? t("provider.custom.error.required") : undefined,
    }
    if (row.err.key || row.err.value) ok = false
    else {
      seenHeaders.add(key.toLowerCase())
      headers[key] = value
    }
  }

  if (!ok) return undefined
  return { id: providerID, name, baseURL, apiKey: form.value.apiKey.trim(), headers, models, protocol: form.value.protocol }
}

/*
 * Saves, then as MiMo does: a toast, and the saved model becomes the one in use
 * - the open conversation's, or the default for the next one on home.
 */
async function submit(): Promise<boolean> {
  if (busy.value || !canSave.value) return false
  const result = validate()
  if (!result) return false
  busy.value = true
  try {
    if (editing) await app.updateCustomProvider(result)
    else await app.addCustomProvider(result)
    const model = { provider: result.id, model: result.models[0].id }
    if (app.currentID) await app.setModel(model)
    else await app.patchConfig({ model, smart: false })
    if (editing) notice.info(t("model.changesSaved"))
    else notice.success(t("model.added"))
    emit("connected", result.id)
    return true
  } catch (err) {
    notice.danger((err instanceof Error ? err.message : String(err)) || t("model.addFailed"))
    return false
  } finally {
    busy.value = false
  }
}

defineExpose({ submit, canSave, busy })
</script>

<template>
  <!--
    Four labelled scalars, the models repeater, the headers repeater, then (when
    not in a dialog) save. Nothing here is discovered - the models are the ones
    typed in - so the form is longer than MiMo's single-model one, on purpose.
  -->
  <form class="cpform" data-custom-provider-form @submit.prevent="submit">
    <div class="cpfield">
      <label class="cplabel" for="cp-provider-id">{{ t("provider.custom.field.providerID.label") }}</label>
      <input
        id="cp-provider-id"
        class="cpin mono"
        :value="form.providerID"
        :disabled="Boolean(editing)"
        :autofocus="props.autofocus !== false"
        :placeholder="t('provider.custom.field.providerID.placeholder')"
        spellcheck="false"
        autocomplete="off"
        @input="setField('providerID', ($event.target as HTMLInputElement).value)"
      />
      <div class="cphelp">{{ t("provider.custom.field.providerID.description") }}</div>
      <div v-if="form.err.providerID" class="cperror">{{ form.err.providerID }}</div>
    </div>

    <div class="cpfield">
      <label class="cplabel" for="cp-name">{{ t("provider.custom.field.name.label") }}</label>
      <input
        id="cp-name"
        class="cpin"
        :value="form.name"
        :placeholder="t('provider.custom.field.name.placeholder')"
        spellcheck="false"
        @input="setField('name', ($event.target as HTMLInputElement).value)"
      />
      <div v-if="form.err.name" class="cperror">{{ form.err.name }}</div>
    </div>

    <!-- MiMo's 接口地址: the hint always under it, replaced by the red line while the URL is not valid. -->
    <div class="cpfield">
      <label class="cplabel" for="cp-base-url">{{ t("model.endpoint") }}</label>
      <input
        id="cp-base-url"
        class="cpin"
        :value="form.baseURL"
        placeholder="https://api.example.com/v1"
        spellcheck="false"
        autocomplete="off"
        data-custom-endpoint
        @input="setField('baseURL', ($event.target as HTMLInputElement).value)"
      />
      <div v-if="endpointBad" class="cperror" data-endpoint-invalid>{{ t("model.endpointInvalid") }}</div>
      <div v-else class="cphelp" data-endpoint-hint>{{ t("model.endpointHint") }}</div>
    </div>

    <!-- Which API the gateway speaks: MiMo names an SDK in its config; MCode, which has no such file, asks here. -->
    <div class="cpfield">
      <label class="cplabel" for="cp-protocol">{{ t("provider.custom.field.protocol.label") }}</label>
      <select id="cp-protocol" v-model="form.protocol" class="cpin" data-custom-protocol>
        <option value="openai">{{ t("provider.custom.protocol.openai") }}</option>
        <option value="anthropic">{{ t("provider.custom.protocol.anthropic") }}</option>
      </select>
      <div class="cphelp">{{ t("provider.custom.field.protocol.description") }}</div>
    </div>

    <!-- A password field with MiMo's eye; `{env:VAR}` still works, and the eye shows what was written. -->
    <div class="cpfield">
      <label class="cplabel" for="cp-api-key">API Key</label>
      <div class="cpsecret">
        <input
          id="cp-api-key"
          class="cpin"
          :type="keyShown ? 'text' : 'password'"
          :value="form.apiKey"
          :placeholder="editing ? t('provider.custom.field.apiKey.keep') : t('model.apiKeyPlaceholder')"
          spellcheck="false"
          autocomplete="off"
          data-custom-key
          @input="setField('apiKey', ($event.target as HTMLInputElement).value)"
        />
        <button
          type="button"
          class="cpeye"
          :title="t(keyShown ? 'model.hideKey' : 'model.showKey')"
          :aria-label="t(keyShown ? 'model.hideKey' : 'model.showKey')"
          data-custom-key-toggle
          @click="keyShown = !keyShown"
        >
          <svg v-if="keyShown" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M10.7 5.1A10.4 10.4 0 0 1 12 5c7 0 10 7 10 7a13 13 0 0 1-1.7 2.7M6.6 6.6C3.5 8.7 2 12 2 12s3 7 10 7a9.7 9.7 0 0 0 5.4-1.6M2 2l20 20M9.9 9.9a3 3 0 0 0 4.2 4.2" />
          </svg>
          <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
      </div>
      <div class="cphelp">{{ t("provider.custom.field.apiKey.description") }}</div>
    </div>

    <div class="cpgroup">
      <span class="cplabel">{{ t("provider.custom.models.label") }}</span>
      <div v-for="(row, at) in form.models" :key="`model-${at}`" class="cpmodel" :data-custom-model="at">
        <div class="cprow">
          <div class="cpcell">
            <input
              class="cpin mono"
              :value="row.id"
              :aria-label="t('provider.custom.models.id.label')"
              :placeholder="t('provider.custom.models.id.placeholder')"
              spellcheck="false"
              autocomplete="off"
              @input="(row.id = ($event.target as HTMLInputElement).value), (row.err.id = undefined)"
            />
            <div v-if="row.err.id" class="cperror">{{ row.err.id }}</div>
          </div>
          <div class="cpcell">
            <input
              class="cpin"
              :value="row.name"
              :aria-label="t('provider.custom.models.name.label')"
              :placeholder="t('provider.custom.models.name.placeholder')"
              spellcheck="false"
              @input="(row.name = ($event.target as HTMLInputElement).value), (row.err.name = undefined)"
            />
            <div v-if="row.err.name" class="cperror">{{ row.err.name }}</div>
          </div>
          <button
            type="button"
            class="cpdrop"
            :disabled="form.models.length <= 1"
            :aria-label="t('provider.custom.models.remove')"
            :title="t('provider.custom.models.remove')"
            @click="removeModel(at)"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path
                d="M3 3.6h8M5.6 3.6V2.4h2.8v1.2M4.2 3.6l.5 7.4h4.6l.5-7.4"
                stroke="currentColor"
                stroke-width="1.1"
                fill="none"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </div>

        <!-- MiMo's 高级配置, one per model here, behind its own legend. -->
        <fieldset class="cpadvanced">
          <legend class="cplegend">
            <button
              type="button"
              class="cpdisclose"
              :aria-expanded="row.advanced"
              data-model-advanced
              @click="row.advanced = !row.advanced"
            >
              <svg class="cpchevron" :class="{ open: row.advanced }" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M4.5 3 7.5 6l-3 3" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              {{ t("provider.custom.advanced") }}
            </button>
          </legend>
          <div v-if="row.advanced" class="cpadvanced-body">
            <label class="cpcheck">
              <input
                type="checkbox"
                data-model-image
                :checked="row.attachment === true"
                :indeterminate.prop="row.attachment === undefined"
                :aria-checked="row.attachment === undefined ? 'mixed' : row.attachment ? 'true' : 'false'"
                @click.prevent="cycleImage(row)"
              />
              <span>{{ t("provider.custom.imageInput") }}</span>
            </label>
            <div class="cplimits">
              <div v-for="field in (['context', 'output'] as const)" :key="field" class="cplimit">
                <label class="cplabel">{{ t(field === "context" ? "provider.custom.contextLimit" : "provider.custom.outputLimit") }}</label>
                <input
                  class="cpin"
                  :data-model-limit="field"
                  inputmode="numeric"
                  :value="row[field]"
                  :placeholder="t('provider.custom.limitDefault')"
                  spellcheck="false"
                  autocomplete="off"
                  @input="typeLimit(row, field, $event)"
                />
                <!-- MiMo's preset pills, 8px under the field; the one matching the value is pressed. -->
                <div class="cppills">
                  <button
                    v-for="preset in LIMIT_PRESETS[field]"
                    :key="preset.value"
                    type="button"
                    class="cppill"
                    :aria-pressed="row[field] === String(preset.value)"
                    :data-limit-preset="preset.value"
                    @click="(row[field] = String(preset.value)), (row.err.limit = undefined)"
                  >
                    {{ preset.label }}
                  </button>
                </div>
              </div>
            </div>
            <div v-if="row.err.limit" class="cperror" data-model-limit-error>{{ row.err.limit }}</div>
          </div>
        </fieldset>
      </div>
      <button type="button" class="cpadd" @click="addModel">+ {{ t("provider.custom.models.add") }}</button>
    </div>

    <div class="cpgroup">
      <span class="cplabel">{{ t("provider.custom.headers.label") }}</span>
      <div v-for="(row, at) in form.headers" :key="`header-${at}`" class="cprow">
        <div class="cpcell">
          <input
            class="cpin mono"
            :value="row.key"
            :aria-label="t('provider.custom.headers.key.label')"
            :placeholder="t('provider.custom.headers.key.placeholder')"
            spellcheck="false"
            autocomplete="off"
            @input="(row.key = ($event.target as HTMLInputElement).value), (row.err.key = undefined)"
          />
          <div v-if="row.err.key" class="cperror">{{ row.err.key }}</div>
        </div>
        <div class="cpcell">
          <input
            class="cpin mono"
            :value="row.value"
            :aria-label="t('provider.custom.headers.value.label')"
            :placeholder="t('provider.custom.headers.value.placeholder')"
            spellcheck="false"
            autocomplete="off"
            @input="(row.value = ($event.target as HTMLInputElement).value), (row.err.value = undefined)"
          />
          <div v-if="row.err.value" class="cperror">{{ row.err.value }}</div>
        </div>
        <button
          type="button"
          class="cpdrop"
          :disabled="form.headers.length <= 1"
          :aria-label="t('provider.custom.headers.remove')"
          :title="t('provider.custom.headers.remove')"
          @click="removeHeader(at)"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path
              d="M3 3.6h8M5.6 3.6V2.4h2.8v1.2M4.2 3.6l.5 7.4h4.6l.5-7.4"
              stroke="currentColor"
              stroke-width="1.1"
              fill="none"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </div>
      <button type="button" class="cpadd" @click="addHeader">+ {{ t("provider.custom.headers.add") }}</button>
    </div>

    <button v-if="!framed" class="cpsubmit" type="submit" :disabled="busy || !canSave" data-custom-save>
      {{ busy ? t("common.saving") : t("common.save") }}
    </button>
  </form>
</template>

<style scoped>
/* MiMo's add-model form: 20 between fields, 14/500 muted labels 8 above 40px 14px inputs. */
.cpform {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.cpfield {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.cplabel {
  color: var(--text-weak);
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: 20px;
}

.cpin {
  box-sizing: border-box;
  width: 100%;
  height: 40px;
  padding: 0 12px;
  color: var(--text-strong);
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  font-family: var(--font-sans);
  font-size: calc(14px * var(--ui-font-scale, 1));
  outline: none;
}

/* Ids and header cells stay monospace: they are identifiers, not prose. */
.cpin.mono {
  font-family: var(--font-mono);
  font-size: calc(13px * var(--code-font-scale, 1));
}

.cpin:focus {
  border-color: var(--border-strong);
}

.cpin:disabled {
  color: var(--text-weak);
}

/* MiMo's eye: a 28px button 2 from the field's end, the key field padded 36 to make room. */
.cpsecret {
  position: relative;
}

.cpsecret .cpin {
  padding-inline-end: 36px;
}

.cpeye {
  position: absolute;
  top: 50%;
  inset-inline-end: 2px;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  color: var(--text-weak);
  background: transparent;
  border: 0;
  border-radius: 6px;
  transform: translateY(-50%);
  cursor: pointer;
}

.cpeye:hover {
  color: var(--text-strong);
}

.cphelp {
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 1.5;
}

.cperror {
  color: var(--text-critical);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 1.5;
}

.cpgroup {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.cpmodel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* The two cells share the width evenly and the trash button keeps its own
   column, so an error under one cell does not shift the other. */
.cprow {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.cpcell {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}

.cpdrop {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  color: var(--text-weak);
  background: none;
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  cursor: pointer;
}

.cpdrop:hover:not(:disabled) {
  color: var(--text-critical);
}

.cpdrop:disabled {
  color: var(--text-weaker);
  cursor: default;
}

/* MiMo's 高级配置: a borderless fieldset whose legend is 14px medium in the muted colour. */
.cpadvanced {
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}

.cplegend {
  padding: 0;
}

.cpdisclose {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  color: var(--text-weak);
  background: none;
  border: 0;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
  cursor: pointer;
}

.cpdisclose:hover {
  color: var(--text-strong);
}

.cpchevron {
  transition: transform 0.12s;
}

.cpchevron.open {
  transform: rotate(90deg);
}

:root[dir="rtl"] .cpchevron:not(.open) {
  transform: scaleX(-1);
}

.cpadvanced-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-block-start: 12px;
}

.cpcheck {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-base);
  font-size: calc(14px * var(--ui-font-scale, 1));
  cursor: pointer;
}

/* Two limits side by side, 16 apart, stacking once the form is narrow. */
.cplimits {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 16px;
}

.cplimit {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 8px;
}

/* MiMo's preset row: 32px round pills at 12px, 8 apart; pressed has a line, a soft fill and strong text. */
.cppills {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.cppill {
  height: 32px;
  padding: 0 6px;
  min-width: 44px;
  color: var(--text-weak);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 999px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  cursor: pointer;
}

.cppill:hover,
.cppill[aria-pressed="true"] {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.cppill[aria-pressed="true"] {
  border-color: var(--border-weak);
}

.cpadd {
  align-self: flex-start;
  color: var(--text-base);
  background: none;
  border: none;
  font-size: calc(14px * var(--ui-font-scale, 1));
  cursor: pointer;
}

.cpadd:hover {
  color: var(--text-strong);
}

.cpsubmit {
  align-self: flex-end;
  padding: 8px 18px;
  color: var(--button-primary-text);
  background: var(--button-primary);
  border: 1px solid var(--button-primary);
  border-radius: 8px;
  font-size: calc(14px * var(--ui-font-scale, 1));
  cursor: pointer;
}

.cpsubmit:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
