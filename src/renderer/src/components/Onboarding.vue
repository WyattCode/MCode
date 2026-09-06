<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue"
import type { AuthMethodKind, ProviderStatus } from "@shared/protocol"
import { useApp } from "../stores/app"
import { groupProviders, waysFor } from "../lib/connect"
import { t } from "../lib/i18n"
import CustomProviderForm from "./CustomProviderForm.vue"

const emit = defineEmits<{ done: [] }>()

const app = useApp()

/** The group card that is selected, and which mode within it. */
const selectedGroup = ref<string>("anthropic")
const selectedMode = ref<Record<string, string>>({})
const apiKey = ref("")
/**
 * The endpoint the user has typed for a local runtime, if any.
 *
 * Kept apart from the default so an untouched field stays in step with the
 * provider it belongs to when the selection changes.
 */
const endpoint = ref<string>()
const busy = ref(false)
const error = ref<string>()

const groups = computed(() => groupProviders(app.providers))

/** Everything past this rank lives behind "more" - the first screen stays short. */
const PRIMARY_LIMIT = 9

const expanded = ref(false)
/** The toggle itself, which sits directly under the grid. */
const rest = ref<HTMLElement>()

/**
 * The failure notice, which sits below the fold once the full provider list is
 * open. An error nobody scrolls to reads as the button having done nothing.
 */
const errorBox = ref<HTMLElement>()
watch(error, async (message) => {
  if (!message) return
  await nextTick()
  errorBox.value?.scrollIntoView({ behavior: "smooth", block: "center" })
})

const primary = computed(() => groups.value.filter((entry) => entry.order <= PRIMARY_LIMIT))
const secondary = computed(() => groups.value.filter((entry) => entry.order > PRIMARY_LIMIT))
const shown = computed(() => (expanded.value ? groups.value : primary.value))

async function toggleMore() {
  expanded.value = !expanded.value
  if (!expanded.value) return
  // Revealing rows below the fold is useless if the page stays put.
  await nextTick()
  rest.value?.scrollIntoView({ behavior: "smooth", block: "end" })
}

const group = computed(() => groups.value.find((entry) => entry.id === selectedGroup.value))
const modes = computed(() => group.value?.entries ?? [])

const ways = computed(() => waysFor(modes.value))

const way = computed(
  () => ways.value.find((entry) => entry.key === selectedMode.value[selectedGroup.value]) ?? ways.value[0],
)

const current = computed(() => way.value?.provider)
const method = computed<AuthMethodKind>(() => way.value?.method ?? "api-key")

/*
 * Both derived from the method rather than from a provider id. The id check
 * only ever knew about Ollama, so LM Studio and vLLM - equally local, equally
 * credential-free - were asked for an API key they do not have.
 */
const keyless = computed(() => method.value === "local")
const oauth = computed(() => method.value === "oauth-browser" || method.value === "oauth-headless")
/** What the endpoint field shows: what was typed, else where the runtime lives. */
const endpointValue = computed(() => endpoint.value ?? current.value?.baseURL ?? "")
const ready = computed(
  () => (keyless.value ? endpointValue.value.trim().length > 0 : apiKey.value.trim().length > 0),
)

const auth = computed(() => (app.authState?.provider === current.value?.id ? app.authState : undefined))
const signedIn = computed(() => Boolean(current.value?.authenticated))

// Switching away mid-login would otherwise leave a listener or poll running.
watch(way, (next, previous) => {
  if (previous && next?.key !== previous.key && app.authState?.stage === "waiting") {
    app.cancelAuth(previous.provider.id)
  }
  error.value = undefined
  // Everything typed belonged to the provider being left behind.
  endpoint.value = undefined
  apiKey.value = ""
})

/**
 * Signing in is the last thing asked of the user, so the wizard should not sit
 * there afterwards waiting to be dismissed - the API key path already moves on
 * by itself once the key lands.
 */
watch(
  () => app.authState?.stage,
  (stage) => {
    if (stage === "done") void finish()
  },
)

watch(
  () => app.authState?.message,
  (message) => {
    if (message) error.value = message
  },
)

async function login() {
  const target = current.value
  if (!target || busy.value) return
  busy.value = true
  error.value = undefined
  try {
    await app.beginAuth(target.id, method.value)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

function openLink() {
  if (auth.value?.url) window.open(auth.value.url, "_blank")
}

async function copyCode() {
  if (auth.value?.userCode) await navigator.clipboard.writeText(auth.value.userCode)
}

/*
 * The provider that is not on the list.
 *
 * Settings could always add an OpenAI-compatible endpoint, but the first-run
 * screen could not: someone whose provider is not one of the tiles had no way
 * past this page except "later", and then had to go find the setting. It is the
 * same form, reached from the place the question is actually being asked.
 */
const CUSTOM = "custom:new"
const choosingCustom = computed(() => selectedGroup.value === CUSTOM)

function pickGroup(id: string) {
  selectedGroup.value = id
  error.value = undefined
}

function pickWay(key: string) {
  selectedMode.value = { ...selectedMode.value, [selectedGroup.value]: key }
  error.value = undefined
}

async function connect() {
  if (!ready.value || busy.value) return
  busy.value = true
  error.value = undefined
  const target = current.value
  if (!target) return
  try {
    // Before connecting, not after: connecting is what checks the runtime is
    // reachable, and it has to check the address the user actually gave.
    if (keyless.value) await app.setProviderEndpoint(target.id, endpointValue.value)
    // setApiKey already repoints the default at this provider; it is the one
    // place that knows whether discovery produced anything usable.
    await app.setApiKey(target.id, keyless.value ? "local" : apiKey.value.trim())
    if (!app.providers.find((entry) => entry.id === target.id)?.configured) {
      throw new Error(t("onboard.connecting"))
    }
    await finish()
  } catch (err) {
    /*
     * For a runtime the server can only report that nothing answered, in
     * English and without naming where it looked. Both matter here: the address
     * is the field directly above, and it may be the thing to correct.
     */
    error.value = keyless.value
      ? t("auth.localDown", { name: target.name, url: endpointValue.value })
      : err instanceof Error
        ? err.message
        : String(err)
  } finally {
    busy.value = false
  }
}

async function finish() {
  await app.patchConfig({ onboarded: true })
  emit("done")
}

function openKeyPage() {
  const url = current.value?.keyURL
  if (url) window.open(url, "_blank")
}
</script>

<template>
  <div class="onboard">
    <div class="panel">
      <div class="mark" role="img" aria-label="MCode" />

      <h1>{{ t("onboard.title") }}</h1>
      <p class="sub">{{ t("onboard.sub") }}</p>

      <div class="step">
        <label class="label">{{ t("onboard.pick") }}</label>
        <div class="choices">
          <button
            v-for="entry in shown"
            :key="entry.id"
            class="choice"
            :class="{ on: entry.id === selectedGroup }"
            @click="pickGroup(entry.id)"
          >
            <span class="mono-mark">{{ entry.name.slice(0, 1) }}</span>
            <span class="choice-name">{{ entry.name }}</span>
            <span v-if="entry.recommended" class="tag">{{ t("provider.recommended") }}</span>
          </button>

          <button
            class="choice"
            :class="{ on: choosingCustom }"
            @click="pickGroup(CUSTOM)"
          >
            <span class="mono-mark">+</span>
            <span class="choice-name">{{ t("provider.custom.title") }}</span>
          </button>
        </div>

        <button v-if="secondary.length" ref="rest" class="more" @click="toggleMore">
          <span>{{ expanded ? t("onboard.less") : `${t("onboard.more")} (${secondary.length})` }}</span>
          <svg class="more-caret" :class="{ up: expanded }" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2.4 3.8 5 6.4l2.6-2.6" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" />
          </svg>
        </button>
      </div>

      <!-- The custom endpoint's own form, in place of everything below. -->
      <div v-if="choosingCustom" class="step">
        <CustomProviderForm @connected="finish" />
      </div>

      <!-- Only shown when the vendor actually offers more than one way in. -->
      <div v-else-if="ways.length > 1" class="step">
        <label class="label">{{ t("onboard.authPick") }}</label>
        <div class="ways">
          <button
            v-for="entry in ways"
            :key="entry.key"
            class="way"
            :class="{ on: entry.key === way?.key }"
            @click="pickWay(entry.key)"
          >
            <span class="radio" :class="{ on: entry.key === way?.key }" />
            <span>{{ entry.label }}</span>
          </button>
        </div>
      </div>

      <!-- Subscription login. -->
      <div v-if="oauth && !choosingCustom" class="step">
        <template v-if="signedIn">
          <div class="signed">
            <span class="dot" />
            <span>{{ t("auth.signedIn") }}</span>
            <button class="link" @click="app.signOut(current!.id)">{{ t("auth.signOut") }}</button>
          </div>
          <!-- Reopening onboarding while already signed in needs a way onward. -->
          <button class="go wide" @click="finish">{{ t("onboard.continue") }}</button>
        </template>

        <template v-else>
          <button v-if="!auth?.url" class="go wide" :disabled="busy" @click="login">
            {{ method === "oauth-browser" ? t("auth.openBrowser") : t("auth.startDevice") }}
          </button>

          <!-- Device flow: a code to type wherever a browser is available. -->
          <template v-if="auth?.userCode">
            <p class="steps">
              {{ t("auth.deviceLead") }}
              <button class="link inline" @click="openLink">{{ t("auth.thisLink") }}</button>
              {{ t("auth.deviceTail") }}
            </p>
            <label class="label">{{ t("auth.code") }}</label>
            <div class="code" @click="copyCode">
              <span>{{ auth.userCode }}</span>
              <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
                <rect x="4.5" y="4.5" width="8" height="8" rx="1.6" stroke="currentColor" fill="none" />
                <path d="M9.5 2.5h-7v7" stroke="currentColor" fill="none" stroke-linecap="round" />
              </svg>
            </div>
          </template>

          <div v-if="auth?.stage === 'waiting'" class="pending">
            <span class="spinner" />
            <span>{{ method === "oauth-browser" ? t("auth.waiting") : t("auth.waitingDevice") }}</span>
          </div>
        </template>

        <div class="hint">{{ current?.description ? t(current.description) : "" }}</div>
      </div>

      <!-- API key. -->
      <div v-else-if="!choosingCustom" class="step">
        <div class="label-row">
          <label class="label">{{ t("onboard.keyLabel") }}</label>
          <button v-if="current?.keyURL" class="link" @click="openKeyPage">{{ t("onboard.getKey") }}</button>
        </div>

        <input
          v-if="!keyless"
          v-model="apiKey"
          class="key"
          type="password"
          :placeholder="t('set.pasteKey')"
          spellcheck="false"
          v-enter="connect"
        />
        <template v-else>
          <div class="hint">{{ t("onboard.keyless") }}</div>
          <label class="sub-label" for="onboard-endpoint">{{ t("onboard.endpoint") }}</label>
          <input
            id="onboard-endpoint"
            :value="endpointValue"
            class="key"
            type="text"
            spellcheck="false"
            autocomplete="off"
            @input="endpoint = ($event.target as HTMLInputElement).value"
            v-enter="connect"
          />
          <div class="hint">{{ t("onboard.endpointHint") }}</div>
        </template>

        <div class="hint">{{ keyless ? t("onboard.moreInSettings") : (current?.description ? t(current.description) : "") }}</div>
      </div>

      <div v-if="error" ref="errorBox" class="error">{{ error }}</div>

      <div class="actions">
        <button class="skip" @click="finish">{{ t("onboard.skip") }}</button>
        <button v-if="!oauth && !choosingCustom" class="go" :disabled="!ready || busy" @click="connect">
          {{ busy ? t("onboard.connecting") : t("onboard.connect") }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/*
 * Deliberately not flex-centred. A scroll container that centres its item with
 * align-items leaves the overflow unreachable - scrollTop stays pinned at 0 even
 * though scrollHeight exceeds the client height. With the full provider list
 * expanded this content is taller than the window, so it has to scroll normally.
 */
.onboard {
  flex: 1;
  min-height: 0;
  padding: 8vh 24px 56px;
  overflow-y: auto;
}

.panel {
  width: 100%;
  max-width: 560px;
  margin: 0 auto;
}

.mark {
  width: 132px;
  aspect-ratio: 1200 / 252;
  margin-bottom: 26px;
  background: var(--wordmark) center / contain no-repeat;
}


h1 {
  margin: 0;
  color: var(--text-strong);
  font-size: 24px;
  font-weight: 530;
  letter-spacing: -0.01em;
}

.sub {
  margin: 10px 0 0;
  color: var(--text-base);
  font-size: 13px;
  line-height: 1.6;
}

.step {
  margin-top: 26px;
}

.label-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}

.label {
  display: block;
  margin-bottom: 8px;
  color: var(--text-weak);
  font-size: 13px;
}

.link {
  color: var(--text-interactive);
  font-size: 13px;
}

.link:hover {
  text-decoration: underline;
}

.choices {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.choice {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 12px;
  color: var(--text-base);
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: var(--radius-lg);
  font-size: 13px;
  transition: border-color 0.12s, color 0.12s, background 0.12s;
}

.choice:hover {
  color: var(--text-strong);
}

.choice.on {
  color: var(--text-strong);
  background: var(--surface-raised-hover);
  border-color: var(--border-strong);
}

.mono-mark {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  color: var(--text-weak);
  background: var(--surface-base);
  border-radius: var(--radius-sm);
  font-size: 11.5px;
  font-weight: 530;
}

.choice.on .mono-mark {
  color: var(--surface-base);
  background: var(--text-strong);
}

.tag {
  padding: 1px 7px;
  color: var(--primary);
  background: color-mix(in srgb, var(--primary) 14%, transparent);
  border-radius: 999px;
  font-size: 11px;
}

.more {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  padding: 6px 2px;
  color: var(--text-base);
  font-size: 13px;
}

.more:hover {
  color: var(--text-strong);
}

.more-caret {
  transition: transform 0.14s;
}

.more-caret.up {
  transform: rotate(180deg);
}

.ways {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.way {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 8px;
  color: var(--text-base);
  text-align: start;
  border-radius: var(--radius-md);
  font-size: 13px;
}

.way:hover {
  background: var(--surface-hover);
}

.way.on {
  color: var(--text-strong);
}

.radio {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  border: 1px solid var(--border-strong);
  border-radius: 50%;
}

.radio.on {
  border-color: var(--interactive);
  border-width: 4px;
}

.steps {
  margin: 0;
  color: var(--text-base);
  font-size: 13px;
  line-height: 1.6;
}

.link.inline {
  padding: 0;
  font-size: 13px;
}

.code {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 12px;
  height: 36px;
  color: var(--text-strong);
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: var(--radius-md);
  font-family: var(--font-mono);
  font-size: 15px;
  letter-spacing: 0.08em;
  cursor: pointer;
}

.code:hover {
  border-color: var(--border-strong);
}

.pending {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-weak);
  font-size: 13px;
}

.spinner {
  width: 11px;
  height: 11px;
  border: 1.5px solid var(--border-strong);
  border-top-color: var(--text-base);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.wide {
  width: 100%;
  justify-content: center;
}

.signed {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-base);
  font-size: 13px;
}

.signed .dot {
  width: 7px;
  height: 7px;
  background: var(--success);
  border-radius: 50%;
}

.segments {
  display: inline-flex;
  padding: 3px;
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: var(--radius-lg);
}

.segment {
  height: 30px;
  padding: 0 16px;
  color: var(--text-base);
  border-radius: var(--radius-md);
  font-size: 13px;
  transition: background 0.12s, color 0.12s;
}

.segment:hover {
  color: var(--text-strong);
}

.segment.on {
  color: var(--surface-base);
  background: var(--text-strong);
}

.key {
  width: 100%;
  height: 40px;
  padding: 0 12px;
  color: var(--text-strong);
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: var(--radius-lg);
  font-family: var(--font-mono);
  font-size: 13px;
  outline: none;
  transition: border-color 0.12s;
}

.key:focus {
  border-color: var(--border-strong);
}

.hint {
  margin-top: 8px;
  color: var(--text-weaker);
  font-size: 12px;
  line-height: 1.5;
}

/*
 * The label under the keyless note, rather than above the block: this field is
 * the second thing in the step, not the heading of it.
 */
.sub-label {
  display: block;
  margin-top: 16px;
  margin-bottom: 8px;
  color: var(--text-weak);
  font-size: 13px;
}

.error {
  margin-top: 16px;
  padding: 10px 12px;
  color: var(--text-error);
  background: var(--surface-critical);
  border-radius: var(--radius-md);
  font-size: 13px;
}

.actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 28px;
}

.skip {
  color: var(--text-weak);
  font-size: 13px;
}

.skip:hover {
  color: var(--text-base);
}

.go {
  margin-inline-start: auto;
  height: 40px;
  padding: 0 22px;
  color: var(--button-primary-text);
  background: var(--button-primary);
  border-radius: var(--radius-lg);
  font-size: 13px;
  transition: filter 0.12s;
}

.go:hover:not(:disabled) {
  filter: brightness(0.92);
}

.go:disabled {
  color: var(--text-weaker);
  background: var(--surface-raised-hover);
  cursor: default;
}
</style>
