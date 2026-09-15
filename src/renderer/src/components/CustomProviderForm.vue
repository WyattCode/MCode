<script setup lang="ts">
import { ref } from "vue"
import type { CustomModel, CustomProvider } from "@shared/protocol"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"

/**
 * Adding an OpenAI-compatible provider by base URL.
 *
 * One component because there are two ways in - the Providers page in settings
 * and the pinned first row of the connect dialog - and the reference does the
 * same thing for the same reason: its `CustomProviderForm` is referenced from
 * three chunks and constructed fresh at every one of them.
 *
 * Fresh matters. There is no edit path here, in the reference either: the store
 * is hardcoded to empty strings and changing a provider means adding it again
 * under the same id.
 *
 * Every rule below is the reference's `validateCustomProvider`, transcribed:
 * the two regexes, the per-row Required/Duplicate checks, the case-insensitive
 * header keys, the blank-header-row skip, and the `{env:VAR}` match on the key
 * field. Errors are computed on submit and cleared on the next keystroke in
 * that field - never on blur - which is why every input writes through
 * `setField` rather than binding with v-model.
 *
 * Each model row also carries MiMo's 高级配置: a three-state 图片输入 and the
 * input and output token limits, behind a disclosure because this form holds
 * many models where MiMo's holds one.
 */

const props = defineProps<{
  autofocus?: boolean
  /**
   * The provider being edited - MiMo's 编辑 on a saved custom model. Its id is
   * locked, and the key field starts blank (the window is never sent the key)
   * unless the key comes from a variable, which is only a name.
   */
  editing?: CustomProvider
}>()
const emit = defineEmits<{ connected: [] }>()

const app = useApp()

const PROVIDER_ID = /^[a-z0-9][a-z0-9-_]*$/
const HTTP_URL = /^https?:\/\//

/* MiMo's preset suggestions, in tokens with K meaning 1024. */
const CONTEXT_PRESETS = ["32K", "64K", "128K", "256K"]
const OUTPUT_PRESETS = ["8K", "16K", "32K", "64K"]

interface ModelRow {
  id: string
  name: string
  /** MiMo's three-state 图片输入: undefined follows the provider or catalog default. */
  attachment?: boolean
  /** The two limits as typed: blank, a whole number, or a number with K. */
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

/* A saved limit shows in the unit it was most likely typed in. */
function limitText(value?: number): string {
  if (!value) return ""
  return value % 1024 === 0 ? `${value / 1024}K` : String(value)
}

/*
 * Both repeaters start with one row and refuse to drop below it. For models
 * that is the point - at least one is mandatory, because nothing discovers
 * them for a custom provider - and for headers it means the form always shows
 * one empty pair that may simply be left blank. That is what the reference
 * does; the empty row is skipped at validation rather than prevented.
 */
const editing = props.editing
const form = ref({
  providerID: editing?.id ?? "",
  name: editing?.name ?? "",
  baseURL: editing?.baseURL ?? "",
  apiKey: editing?.environment ? `{env:${editing.environment}}` : "",
  models: editing?.models?.length
    ? editing.models.map((model) => ({
        ...modelRow(),
        id: model.id,
        name: model.name,
        attachment: model.attachment,
        context: limitText(model.limit?.context),
        output: limitText(model.limit?.output),
        advanced: model.attachment !== undefined || Boolean(model.limit),
      }))
    : [modelRow()],
  headers: Object.keys(editing?.headers ?? {}).length
    ? Object.entries(editing?.headers ?? {}).map(([key, value]) => ({ ...headerRow(), key, value }))
    : [headerRow()],
  err: {} as { providerID?: string; name?: string; baseURL?: string },
})

const busy = ref(false)
const failure = ref<string>()

type Field = "providerID" | "name" | "baseURL" | "apiKey"

function setField(field: Field, value: string) {
  form.value[field] = value
  // The key field has no error to clear: it is never validated, because
  // `{env:VAR}`, a literal key and nothing at all are all legitimate.
  if (field === "apiKey") return
  form.value.err[field] = undefined
}

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

/**
 * A limit as typed: blank is the provider default; otherwise a positive whole
 * number of tokens, where a trailing K means 1024.
 */
function parseLimit(text: string): { ok: boolean; value?: number } {
  const trimmed = text.trim()
  if (!trimmed) return { ok: true }
  const match = /^(\d+)\s*([kK])?$/.exec(trimmed)
  if (!match) return { ok: false }
  const value = Number(match[1]) * (match[2] ? 1024 : 1)
  return Number.isSafeInteger(value) && value > 0 ? { ok: true, value } : { ok: false }
}

interface Resolved {
  id: string
  name: string
  baseURL: string
  apiKey: string
  headers: Record<string, string>
  models: CustomModel[]
}

/**
 * The form's answer, or undefined when something is wrong.
 *
 * Writes each message under the field it belongs to instead of raising one
 * sentence at the top: with four scalars and two repeaters, "something is
 * required" leaves the reader hunting.
 */
function validate(): Resolved | undefined {
  const providerID = form.value.providerID.trim()
  const name = form.value.name.trim()
  const baseURL = form.value.baseURL.trim()
  /*
   * Every provider's id, not only the custom ones: taking a built-in's id
   * would shadow it with no way back. The reference lets an id sitting in its
   * `disabled_providers` list through, which is how it re-adds a provider that
   * was removed - this app deletes rather than disabling, so a removed id is
   * free again and that exception has nothing to apply to.
   */
  const taken = new Set(app.providers.map((entry) => entry.id))
  const err: { providerID?: string; name?: string; baseURL?: string } = {
    providerID: !providerID
      ? t("provider.custom.error.providerID.required")
      : !PROVIDER_ID.test(providerID)
        ? t("provider.custom.error.providerID.format")
        : !editing && taken.has(providerID)
          ? t("provider.custom.error.providerID.exists")
          : undefined,
    name: !name ? t("provider.custom.error.name.required") : undefined,
    baseURL: !baseURL
      ? t("provider.custom.error.baseURL.required")
      : !HTTP_URL.test(baseURL)
        ? t("provider.custom.error.baseURL.format")
        : undefined,
  }
  form.value.err = err
  let ok = !err.providerID && !err.name && !err.baseURL

  const models: CustomModel[] = []
  const seenModels = new Set<string>()
  for (const row of form.value.models) {
    const id = row.id.trim()
    const label = row.name.trim()
    const context = parseLimit(row.context)
    const output = parseLimit(row.output)
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
  return { id: providerID, name, baseURL, apiKey: form.value.apiKey.trim(), headers, models }
}

async function submit() {
  if (busy.value) return
  const result = validate()
  // The messages are already under their fields; nothing more to announce.
  if (!result) return
  busy.value = true
  failure.value = undefined
  try {
    if (editing) await app.updateCustomProvider(result)
    else await app.addCustomProvider(result)
    emit("connected")
  } catch (err) {
    failure.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <!--
    In the reference's own DOM order: description, four labelled scalars, the
    models repeater, the headers repeater, then submit. Nothing here is
    discovered - the models are the ones typed in - so the form is longer than
    the three boxes it replaces, on purpose.
  -->
  <form class="cpform" @submit.prevent="submit">
    <p class="cpintro">
      {{ t("provider.custom.description.prefix")
      }}<a
        class="cplink"
        href="https://opencode.ai/docs/providers/#custom-provider"
        target="_blank"
        rel="noreferrer"
        >{{ t("provider.custom.description.link") }}</a
      >{{ t("provider.custom.description.suffix") }}
    </p>

    <div class="cpfields">
      <div class="cpfield">
        <label class="cplabel" for="cp-provider-id">{{ t("provider.custom.field.providerID.label") }}</label>
        <input
          id="cp-provider-id"
          class="cpin"
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

      <div class="cpfield">
        <label class="cplabel" for="cp-base-url">{{ t("provider.custom.field.baseURL.label") }}</label>
        <input
          id="cp-base-url"
          class="cpin"
          :value="form.baseURL"
          :placeholder="t('provider.custom.field.baseURL.placeholder')"
          spellcheck="false"
          autocomplete="off"
          @input="setField('baseURL', ($event.target as HTMLInputElement).value)"
        />
        <div v-if="form.err.baseURL" class="cperror">{{ form.err.baseURL }}</div>
      </div>

      <!--
        Plain text, not a password box. This field is where {env:VAR} is typed,
        and a reader who cannot see what they wrote cannot tell an indirection
        from a mistyped one - which is why the reference passes no type here.
      -->
      <div class="cpfield">
        <label class="cplabel" for="cp-api-key">{{ t("provider.custom.field.apiKey.label") }}</label>
        <input
          id="cp-api-key"
          class="cpin"
          :value="form.apiKey"
          :placeholder="editing ? t('provider.custom.field.apiKey.keep') : t('provider.custom.field.apiKey.placeholder')"
          spellcheck="false"
          autocomplete="off"
          @input="setField('apiKey', ($event.target as HTMLInputElement).value)"
        />
        <div class="cphelp">{{ t("provider.custom.field.apiKey.description") }}</div>
      </div>
    </div>

    <div class="cpgroup">
      <span class="cplabel">{{ t("provider.custom.models.label") }}</span>
      <div v-for="(row, at) in form.models" :key="`model-${at}`" class="cpmodel" :data-custom-model="at">
        <div class="cprow">
          <div class="cpcell">
            <input
              class="cpin"
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
            <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">
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
              <label class="cplimit">
                <span class="cplimit-label">{{ t("provider.custom.contextLimit") }}</span>
                <input
                  class="cpin"
                  data-model-context
                  :list="`cp-context-presets-${at}`"
                  :value="row.context"
                  :placeholder="t('provider.custom.limitDefault')"
                  spellcheck="false"
                  autocomplete="off"
                  @input="(row.context = ($event.target as HTMLInputElement).value), (row.err.limit = undefined)"
                />
                <datalist :id="`cp-context-presets-${at}`">
                  <option v-for="preset in CONTEXT_PRESETS" :key="preset" :value="preset" />
                </datalist>
              </label>
              <label class="cplimit">
                <span class="cplimit-label">{{ t("provider.custom.outputLimit") }}</span>
                <input
                  class="cpin"
                  data-model-output
                  :list="`cp-output-presets-${at}`"
                  :value="row.output"
                  :placeholder="t('provider.custom.limitDefault')"
                  spellcheck="false"
                  autocomplete="off"
                  @input="(row.output = ($event.target as HTMLInputElement).value), (row.err.limit = undefined)"
                />
                <datalist :id="`cp-output-presets-${at}`">
                  <option v-for="preset in OUTPUT_PRESETS" :key="preset" :value="preset" />
                </datalist>
              </label>
            </div>
            <div v-if="row.err.limit" class="cperror cplimit-error" data-model-limit-error>{{ row.err.limit }}</div>
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
            class="cpin"
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
            class="cpin"
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
          <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">
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

    <div v-if="failure" class="cperror">{{ failure }}</div>

    <button class="cpsubmit" type="submit" :disabled="busy">
      {{ busy ? t("common.saving") : editing ? t("common.save") : t("common.submit") }}
    </button>
  </form>
</template>

<style scoped>
/* Every field carries a label, because six of the eight inputs are
   indistinguishable from each other by placeholder alone, and two repeaters of
   unlabelled boxes would be unreadable. */
.cpform {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.cpintro {
  margin: 0;
  color: var(--text-weak);
  font-size: calc(12.5px * var(--ui-font-scale, 1));
  line-height: 1.6;
}

.cplink {
  color: var(--primary);
  text-decoration: none;
}

.cplink:hover {
  text-decoration: underline;
}

.cpfields {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.cpfield {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

/*
 * The label is the quiet half, and the helper under it is the loud one.
 *
 * That reads backwards until you see opencode's own rule -
 * `[data-slot="input-label"] { color: var(--text-weak); font-size:
 * var(--font-size-small); font-weight: var(--font-weight-medium);
 * line-height: 18px }` - which this had inverted: a --text-strong label over
 * a --text-weak helper, so every field shouted its name and murmured the thing
 * the reader actually needed to know. The helper follows the same system's
 * description slots, which are --text-base (e.g. checkbox-checkbox-description).
 */
.cplabel {
  color: var(--text-weak);
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: 18px;
}

.cpin {
  width: 100%;
  height: 30px;
  padding: 0 10px;
  color: var(--text-strong);
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: var(--radius-md);
  font-family: var(--font-mono);
  font-size: calc(12.5px * var(--ui-font-scale, 1));
  outline: none;
}

.cpin:focus {
  border-color: var(--border-strong);
}

.cphelp {
  color: var(--text-base);
  font-size: calc(11.5px * var(--ui-font-scale, 1));
  line-height: 1.5;
}

.cperror {
  color: var(--text-critical);
  font-size: calc(11.5px * var(--ui-font-scale, 1));
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
  gap: 6px;
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
  width: 30px;
  height: 30px;
  color: var(--text-weak);
  background: none;
  border: 1px solid var(--border-weak);
  border-radius: var(--radius-md);
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
  gap: 10px;
  margin-block-start: 8px;
}

.cpcheck {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-base);
  font-size: calc(12px * var(--ui-font-scale, 1));
  cursor: pointer;
}

/* Two limits side by side, 16 apart, stacking once the form is narrow. */
.cplimits {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 16px;
}

.cplimit {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 5px;
}

.cplimit-label {
  color: var(--text-weak);
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
}

.cplimit-error {
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.cpadd {
  align-self: flex-start;
  color: var(--text-base);
  background: none;
  border: none;
  font-size: calc(12.5px * var(--ui-font-scale, 1));
  cursor: pointer;
}

.cpadd:hover {
  color: var(--text-strong);
}

.cpsubmit {
  align-self: flex-start;
  min-width: 96px;
  height: 30px;
  padding: 0 14px;
  color: var(--text-strong);
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: var(--radius-md);
  font-size: calc(12.5px * var(--ui-font-scale, 1));
  cursor: pointer;
}

.cpsubmit:disabled {
  color: var(--text-weaker);
  cursor: default;
}
</style>
