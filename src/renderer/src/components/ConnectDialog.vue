<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue"
import type { ProviderStatus } from "@shared/protocol"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"
import { localDownMessage, offMachine } from "../lib/local-runtime"
import { composing } from "../lib/keys"
import { notifyFailure } from "../lib/toast"
import { useEscapeLayer } from "../lib/escape-layer"
import { connectableProviders, groupConnected, groupProviders, waysFor, type Group, type Way } from "../lib/connect"
import ProviderIcon from "./ProviderIcon.vue"
import CustomProviderForm from "./CustomProviderForm.vue"
import { writeText } from "./../lib/clipboard"

/**
 * Connecting a provider, as its own dialog.
 *
 * The page used to expand a key field under whichever row was clicked, which
 * only ever suited one of the ways in: a subscription has no key to paste, and
 * a device flow needs room for a code. Three steps - which vendor, which way,
 * then that way's form - keep each screen to one question.
 */

const props = defineProps<{
  /** Opened against one brand, or undefined to browse them all. */
  group?: Group
}>()
const emit = defineEmits<{ close: [] }>()

const app = useApp()

const target = ref<Group | undefined>(props.group)
const query = ref("")
const key = ref("")
/* MiMo's eye on the key field; hidden by default. */
const keyShown = ref(false)
/** The endpoint typed for a local runtime; unset means "wherever it lives now". */
const endpoint = ref<string>()
const busy = ref(false)
const error = ref<string>()
const copied = ref(false)

const endpointValue = computed(() => endpoint.value ?? provider.value?.baseURL ?? "")

const ways = computed<Way[]>(() => (target.value ? waysFor(target.value.entries) : []))
const way = ref<Way | undefined>(props.group ? waysFor(props.group.entries)[0] : undefined)

type Step = "browse" | "methods" | "form" | "custom"
const step = ref<Step>(
  props.group ? (waysFor(props.group.entries).length > 1 ? "methods" : "form") : "browse",
)

/*
 * The list's search takes the keys whenever the list is shown - on opening and
 * back from the custom form. Focused here: Chromium skips an `autofocus` while
 * anything else in the page holds focus - the composer the dialog was opened
 * from, or the row that led back to the list.
 */
const searchEl = ref<HTMLInputElement>()
watch(
  step,
  (now) => {
    if (now === "browse") void nextTick(() => searchEl.value?.focus())
  },
  { immediate: true },
)

/**
 * The pinned row for "any OpenAI-compatible endpoint".
 *
 * The reference puts this first in the browse list rather than at the bottom of
 * a settings page, and force-sorts it there (`if (a.id === CUSTOM_ID) return
 * -1`) so it never drifts down among the vendors. It is where someone who
 * cannot find their provider in the list looks next, which is exactly why it
 * belongs above the list rather than after it.
 */
const customLabel = computed(() => t("dialog.provider.custom.label"))
const customMatches = computed(() => {
  const needle = query.value.trim().toLowerCase()
  return !needle || customLabel.value.toLowerCase().includes(needle)
})

/* MiMo's quick-add vendors (and MCode's ChatGPT sign-in); anything else goes through the custom form. */
const groups = computed(() => groupProviders(connectableProviders(app.providers)))

const results = computed(() => {
  const needle = query.value.trim().toLowerCase()
  if (!needle) return groups.value
  return groups.value.filter(
    (entry) =>
      entry.name.toLowerCase().includes(needle) ||
      entry.entries.some((provider) => provider.name.toLowerCase().includes(needle)),
  )
})

const recommended = computed(() => results.value.filter((entry) => entry.recommended))
const others = computed(() => results.value.filter((entry) => !entry.recommended))

const provider = computed<ProviderStatus | undefined>(() => way.value?.provider)
const auth = computed(() => (app.authState?.provider === provider.value?.id ? app.authState : undefined))

/** The live attempt has to be abandoned whenever this screen stops showing it. */
function dropPending() {
  const pending = app.authState
  if (pending?.stage === "waiting" || pending?.stage === "starting") app.cancelAuth(pending.provider)
}

/**
 * What a vendor row says about getting in, next to its name.
 *
 * Naming the subscription is the useful half - "connect with an API key" on a
 * row that also takes a Pro account tells the wrong one.
 */
function describe(entry: Group): string {
  const options = waysFor(entry.entries)
  const account = options.find((way) => way.method === "oauth-browser" || way.method === "oauth-headless")
  const keyed = options.some((way) => way.method === "api-key")
  if (account && keyed) return t("connect.descBoth", { name: account.provider.name })
  if (account) return t("connect.descAccount", { name: account.provider.name })
  if (options.every((way) => way.method === "local")) return t("auth.local")
  return t(entry.entries[0].description)
}

function pickGroup(entry: Group) {
  target.value = entry
  error.value = undefined
  forget()
  const available = waysFor(entry.entries)
  if (available.length > 1) {
    step.value = "methods"
    return
  }
  way.value = available[0]
  step.value = "form"
}

function openCustom() {
  dropPending()
  error.value = undefined
  forget()
  target.value = undefined
  way.value = undefined
  step.value = "custom"
}

function pickWay(entry: Way) {
  dropPending()
  way.value = entry
  error.value = undefined
  forget()
  step.value = "form"
}

/** Drops anything typed against the provider being left behind. */
function forget() {
  key.value = ""
  endpoint.value = undefined
}

function back() {
  dropPending()
  error.value = undefined
  // The custom form hangs off the list, not off a vendor, so it always has the
  // list behind it - even when this dialog was opened against one brand.
  if (step.value === "custom") {
    step.value = "browse"
    return
  }
  if (step.value === "form" && ways.value.length > 1) {
    step.value = "methods"
    return
  }
  // Opened against one brand, so there is no list behind this to go back to.
  if (props.group) {
    emit("close")
    return
  }
  target.value = undefined
  way.value = undefined
  step.value = "browse"
}

async function submitKey() {
  const value = key.value.trim()
  const entry = provider.value
  if (!entry || !value || busy.value) return
  busy.value = true
  error.value = undefined
  try {
    await app.setApiKey(entry.id, value)
    emit("close")
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure)
  } finally {
    busy.value = false
  }
}

async function connectLocal() {
  const entry = provider.value
  if (!entry || busy.value) return
  busy.value = true
  error.value = undefined
  try {
    // Before connecting: connecting is what checks the runtime answers, and it
    // has to check the address the user gave rather than the default.
    await app.setProviderEndpoint(entry.id, endpointValue.value)
    await app.setApiKey(entry.id, "local")
    emit("close")
  } catch (failure) {
    /*
     * The server can only say nothing answered. What is worth saying is that
     * having the application open is not the same as its API server running,
     * and - off loopback on macOS - that the Local Network permission is
     * another reason a runtime that is running goes quiet.
     */
    error.value = localDownMessage(entry.name, endpointValue.value, app.platform === "darwin" && offMachine(endpointValue.value))
    void failure
  } finally {
    busy.value = false
  }
}

async function login() {
  const entry = provider.value
  if (!entry || !way.value || busy.value) return
  busy.value = true
  error.value = undefined
  try {
    await app.beginAuth(entry.id, way.value.method)
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure)
  } finally {
    busy.value = false
  }
}

function openKeyPage() {
  if (provider.value?.keyURL) window.open(provider.value.keyURL, "_blank")
}

function openVerification() {
  if (auth.value?.url) window.open(auth.value.url, "_blank")
}

async function copyCode() {
  if (!auth.value?.userCode) return
  // A refused clipboard is a notice, never the error page.
  try {
    await writeText(auth.value.userCode)
  } catch {
    notifyFailure(t("code.copyFailed"))
    return
  }
  copied.value = true
  setTimeout(() => (copied.value = false), 1600)
}

// Signing in finishes elsewhere - the server reports it - so close on success.
watch(
  () => provider.value && app.providers.find((entry) => entry.id === provider.value?.id)?.configured,
  (connected, was) => {
    if (connected && !was) emit("close")
  },
)

function dismiss() {
  dropPending()
  emit("close")
}

/*
 * Escape closes, as it does in every other dialog here. The back arrow is the
 * way to step back; a key that sometimes closes and sometimes retreats is a key
 * nobody presses with confidence.
 */
useEscapeLayer(dismiss)
</script>

<template>
  <div class="scrim" @mousedown.self="dismiss">
    <div v-modal class="dialog">
      <header class="bar">
        <button v-if="step !== 'browse'" type="button" class="icon" v-tip="{ label: t('common.back'), placement: 'bottom' }" @click="back">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M9.6 3.4 5 8l4.6 4.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <span class="gap" />
        <button type="button" class="icon" v-tip="{ label: t('common.close'), placement: 'bottom' }" @click="dismiss">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
        </button>
      </header>

      <!-- 1. Which vendor. -->
      <template v-if="step === 'browse'">
        <h2 class="title">{{ t("connect.title") }}</h2>

        <div class="search">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="7.2" cy="7.2" r="4.4" stroke="currentColor" stroke-width="1.3" />
            <path d="M10.6 10.6 13.4 13.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
          </svg>
          <input ref="searchEl" v-model="query" class="search-in" :placeholder="t('connect.search')" spellcheck="false" />
          <button v-if="query" type="button" class="icon small" v-tip="{ label: t('common.clear'), placement: 'bottom' }" @click="query = ''">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.2" />
              <path d="M6 6l4 4M10 6l-4 4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
          </button>
        </div>

        <div class="list">
          <div v-if="!results.length && !customMatches" class="empty">{{ t("connect.noMatch") }}</div>

          <!--
            Pinned above the vendors, never sorted among them: this is the row
            for a provider that is not on the list at all.
          -->
          <button v-if="customMatches" type="button" class="row" @click="openCustom">
            <span class="row-mark">+</span>
            <span class="row-name">{{ customLabel }}</span>
            <span class="row-desc">{{ t("settings.providers.custom.description") }}</span>
            <span class="row-tag">{{ t("settings.providers.tag.custom") }}</span>
          </button>

          <template v-if="recommended.length">
            <div class="group-head">{{ t("provider.recommended") }}</div>
            <button v-for="entry in recommended" :key="entry.id" type="button" class="row" @click="pickGroup(entry)">
              <ProviderIcon :id="entry.entries[0].id" :name="entry.name" />
              <span class="row-name">{{ entry.name }}</span>
              <span class="row-desc">{{ describe(entry) }}</span>
              <span v-if="groupConnected(entry)" class="row-state">{{ t("connect.connected") }}</span>
              <span v-else class="row-add">+</span>
            </button>
          </template>

          <template v-if="others.length">
            <div class="group-head">{{ t("connect.other") }}</div>
            <button v-for="entry in others" :key="entry.id" type="button" class="row" @click="pickGroup(entry)">
              <ProviderIcon :id="entry.entries[0].id" :name="entry.name" />
              <span class="row-name">{{ entry.name }}</span>
              <span class="row-desc">{{ describe(entry) }}</span>
              <span v-if="groupConnected(entry)" class="row-state">{{ t("connect.connected") }}</span>
              <span v-else class="row-add">+</span>
            </button>
          </template>
        </div>
      </template>

      <!-- 1b. Or an endpoint that is not on the list. -->
      <template v-else-if="step === 'custom'">
        <div class="head">
          <span class="row-mark big">+</span>
          <h2 class="title">{{ t("provider.custom.title") }}</h2>
        </div>
        <CustomProviderForm standalone autofocus @connected="emit('close')" />
      </template>

      <!-- 2. Which way in. -->
      <template v-else-if="step === 'methods'">
        <div class="head">
          <ProviderIcon v-if="target" :id="target.entries[0].id" :name="target.name" big />
          <h2 class="title">{{ t("connect.to", { name: target?.name ?? "" }) }}</h2>
        </div>
        <p class="lead">{{ t("connect.pickMethod", { name: target?.name ?? "" }) }}</p>

        <div class="ways">
          <button v-for="entry in ways" :key="entry.key" type="button" class="way" @click="pickWay(entry)">
            <span class="way-name">{{ entry.label }}</span>
            <span v-if="entry.provider.configured" class="row-state">{{ t("connect.connected") }}</span>
          </button>
        </div>
      </template>

      <!-- 3. That way's form. -->
      <template v-else>
        <div class="head">
          <ProviderIcon v-if="target" :id="target.entries[0].id" :name="target.name" big />
          <h2 class="title">{{ t("connect.to", { name: provider?.name ?? "" }) }}</h2>
        </div>

        <template v-if="way?.method === 'api-key'">
          <p class="lead">{{ t("connect.keyLead", { name: provider?.name ?? "" }) }}</p>
          <!-- MiMo's key field: the literal label, a password box with a 28px eye at its end. -->
          <label class="label" for="connect-key">API Key</label>
          <div class="secret">
            <input
              id="connect-key"
              v-model="key"
              class="field"
              :type="keyShown ? 'text' : 'password'"
              :placeholder="t('model.apiKeyPlaceholder')"
              spellcheck="false"
              data-connect-key
              @keydown.enter="!composing($event) && submitKey()"
            />
            <button
              type="button"
              class="eye"
              :title="t(keyShown ? 'model.hideKey' : 'model.showKey')"
              :aria-label="t(keyShown ? 'model.hideKey' : 'model.showKey')"
              data-connect-key-toggle
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
          <div class="actions">
            <button type="button" class="go" :disabled="!key.trim() || busy" @click="submitKey">{{ t("common.save") }}</button>
            <button v-if="provider?.keyURL" type="button" class="link" @click="openKeyPage">
              {{ t("onboard.getKey") }}
            </button>
          </div>
        </template>

        <template v-else-if="way?.method === 'local'">
          <p class="lead">{{ t("onboard.keyless") }}</p>
          <label class="label" for="connect-endpoint">{{ t("onboard.endpoint") }}</label>
          <input
            id="connect-endpoint"
            :value="endpointValue"
            class="field"
            type="text"
            spellcheck="false"
            autocomplete="off"
            @input="endpoint = ($event.target as HTMLInputElement).value"
            @keydown.enter="!composing($event) && connectLocal()"
          />
          <p class="lead soft">{{ t("onboard.endpointHint") }}</p>
          <div class="actions">
            <button type="button" class="go" :disabled="busy || !endpointValue.trim()" @click="connectLocal">
              {{ t("set.connect") }}
            </button>
          </div>
        </template>

        <template v-else>
          <p class="lead">
            {{ way?.method === "oauth-browser" ? t("auth.browserNote") : t("auth.headlessNote") }}
          </p>

          <div v-if="!auth?.url" class="actions">
            <button type="button" class="go" :disabled="busy" @click="login">
              {{ way?.method === "oauth-browser" ? t("auth.openBrowser") : t("auth.startDevice") }}
            </button>
          </div>

          <template v-if="auth?.userCode">
            <p class="lead">
              {{ t("auth.deviceLead") }}
              <button type="button" class="link inline" @click="openVerification">{{ t("auth.thisLink") }}</button>
              {{ t("auth.deviceTail") }}
            </p>
            <label class="label">{{ t("auth.code") }}</label>
            <button type="button" class="code" @click="copyCode">
              <span>{{ auth.userCode }}</span>
              <span class="code-hint">{{ copied ? t("code.copied") : t("edit.copy") }}</span>
            </button>
          </template>

          <div v-if="auth?.stage === 'waiting'" class="pending">
            <span class="spinner" />
            <span>{{ way?.method === "oauth-browser" ? t("auth.waiting") : t("auth.waitingDevice") }}</span>
            <button type="button" class="link" @click="app.cancelAuth(provider!.id)">{{ t("common.cancel") }}</button>
          </div>
        </template>
      </template>

      <div v-if="error" class="error">{{ error }}</div>
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

.dialog {
  display: flex;
  flex-direction: column;
  width: min(560px, calc(100vw - 64px));
  max-height: min(620px, calc(100vh - 96px));
  padding: 10px 26px 26px;
  background: var(--surface-page);
  border: 1px solid var(--border-weak);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-pop);
  outline: none;
}

.bar {
  display: flex;
  align-items: center;
  margin: 0 -8px 4px;
}

.gap {
  flex: 1;
}

/* Twenty square, pulled two pixels out of the header's padding so the glyph
   lines up with the title rather than the button's box doing. */
.icon {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 20px;
  height: 20px;
  margin-top: -2px;
  margin-inline-end: -2px;
  color: var(--icon-weak);
  border-radius: 4px;
}

.icon:hover {
  background: var(--surface-hover);
}

.icon:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.icon.small {
  width: 22px;
  height: 22px;
}

.head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}

.title {
  margin: 0;
  color: var(--text-strong);
  font-size: calc(15px * var(--ui-font-scale, 1));
  font-weight: 530;
  line-height: calc(20px * var(--ui-font-scale, 1));
  letter-spacing: -0.13px;
}

.lead {
  margin: 4px 0 18px;
  color: var(--text-base);
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 440;
  line-height: calc(20px * var(--ui-font-scale, 1));
  letter-spacing: -0.04px;
}

/* Guidance under a field, which should not compete with the field's own label. */
.lead.soft {
  margin: 8px 0 0;
  color: var(--text-weaker);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 1.5;
}

/* --- browse ------------------------------------------------------------- */

.search {
  /*
   * No border. opencode's shared `text-input-v2` is a 60% fill of bg-layer-02
   * that goes solid on focus, at radius 6 - `--surface-layer` and
   * `--radius-md` here. Focus used to move a border colour that no longer
   * exists.
   */
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 14px 0 6px;
  padding: 0 12px;
  height: 36px;
  flex-shrink: 0;
  color: var(--text-weaker);
  background: color-mix(in srgb, var(--surface-layer) 60%, transparent);
  border: 0;
  border-radius: var(--radius-md);
}

.search:focus-within {
  background: var(--surface-layer);
}

.search-in {
  flex: 1;
  color: var(--text-strong);
  background: none;
  border: none;
  font-size: calc(13.5px * var(--ui-font-scale, 1));
  outline: none;
}

.list {
  margin: 0 -6px;
  overflow-y: auto;
}

.group-head {
  padding: 14px 6px 6px;
  color: var(--text-weaker);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.row {
  display: flex;
  align-items: center;
  gap: 11px;
  width: 100%;
  padding: 8px 10px;
  /* Transparent at rest so gaining an outline on hover shifts nothing. */
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  text-align: start;
  transition:
    background 0.12s,
    border-color 0.12s;
}

/* Drawn inside the row: it is as wide as the scroller, so a ring set outside
   it is clipped away at both edges. */
.row:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: -2px;
}

.row:hover {
  background: var(--surface-hover);
  border-color: var(--border-weak);
}

.row-name {
  flex-shrink: 0;
  color: var(--text-strong);
  font-size: calc(13.5px * var(--ui-font-scale, 1));
}

/* Trails the name, and gives way first when the dialog is narrow. */
.row-desc {
  flex: 1;
  overflow: hidden;
  color: var(--text-weaker);
  font-size: calc(12.5px * var(--ui-font-scale, 1));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-state {
  color: var(--text-weaker);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.row-add {
  color: var(--text-weaker);
  font-size: calc(15px * var(--ui-font-scale, 1));
}

/* Stands where a vendor's logo would, so the pinned row lines up with the
   list under it instead of starting further left. */
.row-mark {
  display: flex;
  align-items: center;
  justify-content: center;
  width: calc(22px * var(--ui-font-scale, 1));
  height: calc(22px * var(--ui-font-scale, 1));
  flex-shrink: 0;
  color: var(--text-base);
  background: var(--surface-raised-hover);
  border-radius: var(--radius-md);
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.row-mark.big {
  width: calc(34px * var(--ui-font-scale, 1));
  height: calc(34px * var(--ui-font-scale, 1));
  font-size: calc(17px * var(--ui-font-scale, 1));
}

.row-tag {
  padding: 1px 7px;
  color: var(--text-weak);
  background: var(--surface-raised-hover);
  border-radius: 999px;
  font-size: calc(11px * var(--ui-font-scale, 1));
}

.empty {
  padding: 24px 6px;
  color: var(--text-weaker);
  font-size: calc(13px * var(--ui-font-scale, 1));
  text-align: center;
}

/* --- methods ------------------------------------------------------------ */

.ways {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0 -6px;
}

.way {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  text-align: start;
  transition:
    background 0.12s,
    border-color 0.12s;
}

.way:hover {
  background: var(--surface-hover);
  border-color: var(--border-weak);
}

.way:focus-visible,
.go:focus-visible,
.link:focus-visible,
.code:focus-visible {
  outline: 2px solid var(--text-strong);
  outline-offset: -2px;
}

.way-name {
  flex: 1;
  color: var(--text-strong);
  font-size: calc(13.5px * var(--ui-font-scale, 1));
}

/* --- form --------------------------------------------------------------- */

.label {
  display: block;
  margin-bottom: 7px;
  color: var(--text-base);
  font-size: calc(12.5px * var(--ui-font-scale, 1));
}

.field {
  width: 100%;
  height: calc(38px * var(--ui-font-scale, 1));
  padding: 0 12px;
  color: var(--text-strong);
  background: color-mix(in srgb, var(--surface-layer) 60%, transparent);
  border: 0;
  border-radius: var(--radius-md);
  font-family: var(--font-mono);
  font-size: calc(13px * var(--ui-font-scale, 1));
  outline: none;
}

.field:focus {
  background: var(--surface-layer);
}

/* MiMo's key field: 40 tall at 14px with room at the end for the eye. */
.secret {
  position: relative;
}

.secret .field {
  height: calc(40px * var(--ui-font-scale, 1));
  padding-inline-end: 36px;
  font-family: var(--font-sans);
  font-size: calc(14px * var(--ui-font-scale, 1));
}

.eye {
  position: absolute;
  top: 50%;
  inset-inline-end: 2px;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  color: var(--text-base);
  border-radius: 6px;
  transform: translateY(-50%);
}

.eye:hover {
  color: var(--text-strong);
}

.actions {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 18px;
}

.go {
  height: calc(34px * var(--ui-font-scale, 1));
  padding: 0 18px;
  color: var(--surface-base);
  background: var(--text-strong);
  border-radius: var(--radius-md);
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 530;
}

.go:disabled {
  color: var(--text-weaker);
  background: var(--surface-hover);
  cursor: default;
}

.link {
  color: var(--text-base);
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.link:hover {
  color: var(--text-strong);
}

.link.inline {
  font-size: inherit;
}

.code {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 11px 16px;
  color: var(--text-strong);
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: var(--radius-md);
  font-family: var(--font-mono);
  font-size: calc(19px * var(--ui-font-scale, 1));
  letter-spacing: 0.18em;
}

.code:hover {
  border-color: var(--border-strong);
}

.code-hint {
  color: var(--text-weaker);
  font-family: var(--font-sans);
  font-size: calc(12px * var(--ui-font-scale, 1));
  letter-spacing: 0;
}

.pending {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 16px;
  color: var(--text-base);
  font-size: calc(12.5px * var(--ui-font-scale, 1));
}

.spinner {
  width: 11px;
  height: 11px;
  border: 1.5px solid var(--border-strong);
  border-top-color: var(--text-base);
  border-radius: 50%;
  animation: connect-spin 0.7s linear infinite;
}

@keyframes connect-spin {
  to {
    transform: rotate(360deg);
  }
}

/* MiMo's red-500, which is not its --color-err, so --text-critical does not fit. */
.error {
  margin-top: 16px;
  color: #fb2c36;
  font-size: calc(12.5px * var(--ui-font-scale, 1));
  line-height: 1.6;
}
</style>
