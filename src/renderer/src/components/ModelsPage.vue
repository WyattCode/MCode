<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue"
import type { ProviderStatus } from "@shared/protocol"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"
import { notify, notifyFailure } from "../lib/toast"
import { groupProviders, providerLabel, quickAddGroups, type Group } from "../lib/connect"
import { cloneId } from "../lib/custom-model"
import ProviderIcon from "./ProviderIcon.vue"
import ConnectDialog from "./ConnectDialog.vue"
import ConfirmDialog from "./ConfirmDialog.vue"
import CustomProviderForm from "./CustomProviderForm.vue"
import ProviderCloneDialog from "./ProviderCloneDialog.vue"

/**
 * Settings → 模型, as MiMo 26.920 redid it: the title and intro, a row of
 * tabs - refresh, 添加供应商, then one per provider - and under it the chosen
 * tab's page. Adding shows the vendor chips and the custom form; a custom
 * provider's tab is its form, with delete and clone beside save in the bar
 * under it; its separate profile page and add-model dialog are gone.
 *
 * Kept as MCode has them (deliberate differences, round nine): a vendor chip
 * opens the connect dialog, which takes the key and finds the models through
 * `/models`, and a connected vendor's tab lists what it found, with refresh,
 * the endpoint it is reached at, and disconnect.
 */

const app = useApp()

/* Everything configured, and every custom provider whether or not it has a key yet. */
const listed = computed(() => app.providers.filter((provider) => provider.configured || provider.custom))

const ADD = "+add"
const selected = ref<string>(listed.value[0]?.id ?? ADD)
const current = computed(() => listed.value.find((provider) => provider.id === selected.value))
const customEntry = computed(() => app.config?.customProviders?.find((entry) => entry.id === selected.value))

/* A provider that goes away takes its tab with it; the first one left is shown instead. */
watch(listed, (list) => {
  if (selected.value !== ADD && !list.some((provider) => provider.id === selected.value)) selected.value = list[0]?.id ?? ADD
})

/* MiMo's seven presets, listed whether or not one is added; a connected vendor's chip opens on 已连接. */
const presetGroups = computed(() => quickAddGroups(app.providers))

const form = ref<InstanceType<typeof CustomProviderForm>>()
const saving = computed(() => Boolean(form.value?.busy))

/*
 * The shell the action bar is portalled into, as MiMo portals its own into
 * .settings-full: the bar is then positioned against the dialog rather than
 * carried by the page, so it stays put while the page scrolls under it. Found
 * after mounting, because the shell is this page's own ancestor.
 */
const dockHost = ref<HTMLElement>()
onMounted(() => {
  dockHost.value = document.querySelector<HTMLElement>("[data-settings-overlay] .dialog") ?? undefined
})

/* ------------------------------------------------------------ connect dialog */

const connectTarget = ref<Group>()
const connectOpen = ref(false)

function openConnect(group?: Group) {
  connectTarget.value = group
  connectOpen.value = true
}

/* Back from connecting a vendor, its tab is the one shown. */
function closeConnect() {
  const connected = connectTarget.value?.entries.find((entry) => listed.value.some((provider) => provider.id === entry.id))
  connectOpen.value = false
  connectTarget.value = undefined
  if (connected) selected.value = connected.id
}

function manage(provider: ProviderStatus) {
  openConnect(groupProviders(app.providers).find((group) => group.entries.some((entry) => entry.id === provider.id)))
}

/* ------------------------------------------------------------ a connected vendor */

/**
 * Whether a variable in the user's shell is the only thing connecting this
 * provider: there is then nothing here to disconnect, and the page says so
 * where the button would be. A subscription signed in here is the app's to
 * remove whatever the environment says.
 */
function fromEnvironment(provider: ProviderStatus): boolean {
  return Boolean(provider.environment) && !provider.authenticated
}

/* The endpoint being edited, per provider: what was typed, else the one in force. */
const endpoints = ref<Record<string, string>>({})

function endpointValue(provider: ProviderStatus): string {
  return endpoints.value[provider.id] ?? provider.baseURL ?? ""
}

function endpointChanged(provider: ProviderStatus): boolean {
  const typed = endpoints.value[provider.id]?.trim()
  return Boolean(typed) && typed !== (provider.baseURL ?? "")
}

async function saveEndpoint(provider: ProviderStatus) {
  const value = endpoints.value[provider.id]?.trim()
  if (!value) return
  await app.patchConfig({ providerEndpoints: { ...(app.config?.providerEndpoints ?? {}), [provider.id]: value } })
  delete endpoints.value[provider.id]
  notify(t("set.saved"))
}

/** A better answer than the network's own for a runtime on this machine that is not running its server. */
function localFailure(provider: ProviderStatus): string | undefined {
  if (!provider.authMethods?.includes("local")) return undefined
  return t("auth.localDown", { name: provider.name, url: provider.baseURL ?? "" })
}

const refreshing = ref(false)

/*
 * MiMo's refresh at the head of the tabs: the shown provider's models again -
 * `/models` for a connected vendor, the connection test for a custom one.
 */
async function refresh() {
  if (refreshing.value) return
  refreshing.value = true
  try {
    const provider = current.value
    if (provider?.custom) await form.value?.testConnection()
    else if (provider && provider.kind === "openai-compatible") {
      try {
        const found = await app.discoverModels(provider.id)
        notify(t("provider.refreshed", { n: found }), { level: "success" })
      } catch (err) {
        notifyFailure(localFailure(provider) ?? (err instanceof Error ? err.message : String(err)))
      }
    } else notify(t("set.models.refreshed"), { level: "success" })
  } finally {
    refreshing.value = false
  }
}

/* ------------------------------------------------------------ saving, removing, cloning */

async function save() {
  await form.value?.submit()
}

/* A provider just added becomes the shown tab, as MiMo moves to it. */
function saved(id: string) {
  selected.value = id
}

/*
 * MiMo asks before deleting a provider, and toasts the result; a built-in
 * provider's disconnect asks the same way. If the model in use goes, the store
 * falls back to another usable one.
 */
const removing = ref<{ id: string; name: string; custom: boolean }>()

async function confirmRemove() {
  const target = removing.value
  removing.value = undefined
  if (!target) return
  try {
    if (target.custom) {
      await app.removeCustomProvider(target.id)
      notify(t("set.models.removed", { name: target.name }), { level: "success" })
    } else {
      // Both credentials, because a provider can hold either.
      const entry = app.providers.find((item) => item.id === target.id)
      if (entry?.authenticated) await app.signOut(target.id)
      await app.setApiKey(target.id, "")
      notify(t("set.models.disconnected", { name: target.name }), { level: "success" })
    }
    await app.ensureUsableModel()
  } catch {
    notifyFailure(t(target.custom ? "set.models.removeFailed" : "set.models.disconnectFailed"))
  }
}

/* MiMo 26.920's 克隆供应商: a new id, asked for first; the copy opens once it is made. */
const cloning = ref<{ id: string; name: string; initial: string; taken: Set<string> }>()

function startClone(provider: ProviderStatus) {
  const taken = new Set([...app.providers.map((entry) => entry.id), ...(app.config?.customProviders ?? []).map((entry) => entry.id)])
  cloning.value = { id: provider.id, name: providerLabel(provider), initial: cloneId(provider.id, taken), taken }
}

async function confirmClone(id: string) {
  const source = cloning.value
  cloning.value = undefined
  if (!source) return
  try {
    const made = await app.copyCustomProvider(source.id, t("set.models.copyName", { name: source.name }), id)
    selected.value = made
    notify(t("set.models.copied"), { level: "success" })
  } catch {
    notifyFailure(t("set.models.copyFailed"))
  }
}
</script>

<template>
  <div class="models-page" data-models-page>
    <h2>{{ t("set.models") }}</h2>
    <p class="note">{{ t("set.models.intro") }}</p>

    <!-- MiMo 26.920's tab row: refresh, 添加供应商, then one per provider. -->
    <div class="tabs" data-provider-tabs>
      <button
        type="button"
        class="tab square"
        :title="t('provider.refresh')"
        :aria-label="t('provider.refresh')"
        :disabled="refreshing"
        data-provider-refresh-all
        @click="refresh"
      >
        <svg :class="{ spin: refreshing }" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M13 8a5 5 0 1 1-1.5-3.55M13 2.5v2.5h-2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <button type="button" class="tab" :class="{ on: selected === ADD }" data-provider-add @click="selected = ADD">
        + {{ t("set.models.addProvider") }}
      </button>
      <button
        v-for="provider in listed"
        :key="provider.id"
        type="button"
        class="tab"
        :class="{ on: selected === provider.id }"
        :data-provider-tab="provider.id"
        @click="selected = provider.id"
      >
        <ProviderIcon :id="provider.id" :name="provider.name" />
        <span class="tab-name">{{ providerLabel(provider) }}</span>
      </button>
    </div>

    <!-- Adding: the vendor chips, then the custom form, which is what 自定义 stands for. -->
    <template v-if="selected === ADD">
      <div class="presets" data-provider-presets>
        <button v-for="group in presetGroups" :key="group.id" type="button" class="preset" :data-preset="group.id" @click="openConnect(group)">
          <ProviderIcon :id="group.entries[0].id" :name="group.name" class="preset-mark" />
          <span>{{ group.name }}</span>
        </button>
        <!-- MiMo's literal label, the same in every language. -->
        <span class="preset on" data-preset="custom">
          <svg class="preset-plus" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 3v10M3 8h10" />
          </svg>
          <span>自定义 / Custom</span>
        </span>
      </div>
      <CustomProviderForm key="add" ref="form" @saved="saved" />
    </template>

    <!-- A custom provider: its own form, with delete and clone beside save. -->
    <template v-else-if="current?.custom && customEntry">
      <CustomProviderForm :key="current.id" ref="form" :editing="customEntry" @saved="saved" />
    </template>

    <!-- A connected vendor: where it is reached, what it serves, and the way out. -->
    <template v-else-if="current && !current.custom">
      <div class="card" :data-provider-page="current.id">
        <div class="line">
          <span class="line-title">{{ t("provider.custom.field.name.label") }}</span>
          <span class="line-value">
            {{ providerLabel(current) }}
            <span v-if="fromEnvironment(current)" class="tag">{{ t("provider.environment") }}</span>
          </span>
        </div>
        <div v-if="current.kind === 'openai-compatible'" class="line">
          <span class="line-title">{{ t("set.baseURL") }}</span>
          <span class="endpoint">
            <input
              :value="endpointValue(current)"
              class="field-in"
              :placeholder="t('set.baseURL')"
              spellcheck="false"
              data-provider-endpoint
              @input="endpoints[current.id] = ($event.target as HTMLInputElement).value"
              @keydown.enter="!$event.isComposing && saveEndpoint(current)"
            />
            <button type="button" class="dock-btn" :disabled="!endpointChanged(current)" @click="saveEndpoint(current)">{{ t("set.save") }}</button>
          </span>
        </div>
      </div>
      <div class="section">
        {{ t("set.models.fromProvider") }}
        <span class="count">{{ current.models.length ? t("provider.modelCount", { n: current.models.length }) : t("provider.noModels") }}</span>
      </div>
      <div v-if="current.models.length" class="card models" data-provider-models>
        <div v-for="model in current.models" :key="model.id" class="model-row">
          <span class="model-name">{{ model.name }}</span>
          <span class="model-id">{{ model.id }}</span>
        </div>
      </div>
    </template>

    <!--
      MiMo ends the page with an aria-hidden block the height of the bar that
      floats over it, so the last card can still be scrolled clear of it.
    -->
    <div v-if="dockHost" class="dock-floor" aria-hidden="true" />

    <!--
      MiMo's action bar is portalled out of the page and into the dialog shell,
      where it is positioned against the shell rather than carried along by the
      page: it stays above the last row however far the page has scrolled.
    -->
    <Teleport v-if="dockHost" :to="dockHost">
      <div class="dock" data-provider-actions>
        <span class="dock-start">
          <template v-if="current?.custom && customEntry">
            <button
              type="button"
              class="dock-btn danger"
              :data-provider-remove="current.id"
              @click="removing = { id: current.id, name: providerLabel(current), custom: true }"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M4 6.5h16M9.5 6.5V4.5h5v2M6.5 6.5l.8 13a1.7 1.7 0 0 0 1.7 1.5h6a1.7 1.7 0 0 0 1.7-1.5l.8-13" />
              </svg>
              {{ t("set.models.removeProvider") }}
            </button>
            <button type="button" class="dock-btn" :data-provider-clone="current.id" @click="startClone(current)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="9" y="9" width="11" height="11" rx="2" />
                <path d="M15 5.5A1.5 1.5 0 0 0 13.5 4H5.5A1.5 1.5 0 0 0 4 5.5v8A1.5 1.5 0 0 0 5.5 15" />
              </svg>
              {{ t("set.models.cloneProvider") }}
            </button>
          </template>
          <template v-else-if="current && !current.custom">
            <span v-if="fromEnvironment(current)" class="env-note">{{ t("provider.fromEnvironment") }}</span>
            <button
              v-else
              type="button"
              class="dock-btn danger"
              :data-provider-remove="current.id"
              @click="removing = { id: current.id, name: providerLabel(current), custom: false }"
            >
              {{ t("set.disconnect") }}
            </button>
          </template>
        </span>
        <button
          v-if="selected === ADD"
          type="button"
          class="primary"
          data-provider-save
          :disabled="saving || !form?.canSave"
          @click="save"
        >
          {{ saving ? t("common.saving") : t("set.models.confirmAdd") }}
        </button>
        <button
          v-else-if="current?.custom && customEntry"
          type="button"
          class="primary"
          data-provider-save
          :disabled="saving || !form?.canSave || !form?.dirty"
          @click="save"
        >
          {{ saving ? t("common.saving") : t("common.save") }}
        </button>
        <button v-else-if="current" type="button" class="primary" :data-provider-manage="current.id" @click="manage(current)">
          {{ t("set.models.manage") }}
        </button>
      </div>
    </Teleport>

    <Teleport to="body">
      <ConfirmDialog
        v-if="removing"
        :title="t(removing.custom ? 'set.models.removeProvider' : 'set.models.disconnectTitle')"
        :body="t(removing.custom ? 'set.models.removeProviderBody' : 'set.models.disconnectBody', { name: removing.name })"
        :confirm-label="removing.custom ? t('set.models.remove') : t('set.disconnect')"
        @confirm="confirmRemove"
        @close="removing = undefined"
      />
      <ProviderCloneDialog v-if="cloning" :initial="cloning.initial" :taken="cloning.taken" @confirm="confirmClone" @close="cloning = undefined" />
    </Teleport>
    <ConnectDialog v-if="connectOpen" :group="connectTarget" @close="closeConnect" />
  </div>
</template>

<style scoped>
/*
 * The settings page's own title, as the other pages draw theirs (MiMo's
 * sc-h1: 24px, regular weight), then MiMo's intro 2 under the title's gap
 * and the tabs 16 under the intro. The page's 12px flex gap is counted in:
 * 15 + 12 is the other pages' 27, 4 + 12 is 16.
 */
h2 {
  margin: 0 0 15px;
  color: var(--text-strong);
  font-size: calc(24px * var(--ui-font-scale, 1));
  font-weight: 400;
  line-height: calc(38.4px * var(--ui-font-scale, 1));
}

/* The page title takes MiMo's softer ink in dark, as every other page's does. */
:root[data-theme="dark"] h2 {
  color: #f4f4f5;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) h2 {
    color: #f4f4f5;
  }
}

.note {
  margin: 2px 0 4px;
  color: var(--text-base);
  font-size: calc(12.5px * var(--ui-font-scale, 1));
  line-height: 1.6;
}

.models-page {
  display: flex;
  flex-direction: column;
  /* MiMo's models-page-body: 16 between the blocks of the page. */
  gap: 16px;
}

/* MiMo 26.920's tabs: 36 high, an 8px corner, a line; the shown one has a strong line and a soft fill. */
.tabs {
  display: flex;
  gap: 8px;
  padding-bottom: 4px;
  overflow-x: auto;
}

.tab {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  height: calc(36px * var(--ui-font-scale, 1));
  padding: 0 12px;
  color: #151c13cc;
  background: transparent;
  border: 1px solid #f0ebe5;
  border-radius: 8px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  white-space: nowrap;
  cursor: pointer;
}

.tab.square {
  justify-content: center;
  width: calc(36px * var(--ui-font-scale, 1));
  padding: 0;
}

.tab:hover:not(.on) {
  background: #f1f0ec;
}

/*
 * MiMo marks the chosen tab with its rule and the strong ink alone: the fill it
 * asks for is `bg-soft`, which ships as no rule at all (2026-09-23 decision -
 * take MiMo's drawn result, not the class name's intent).
 */
.tab.on {
  color: var(--text-strong);
  border-color: var(--text-strong);
  font-weight: 500;
}

.tab:disabled {
  opacity: 0.5;
  cursor: default;
}

.tab-name {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.spin {
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* The vendor chips: 32 high, 7 between the mark and the name. */
.presets {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.preset {
  display: flex;
  align-items: center;
  gap: 7px;
  height: calc(32px * var(--ui-font-scale, 1));
  padding: 0 10px;
  color: #151c13cc;
  background: transparent;
  border: 1px solid #f0ebe5;
  border-radius: 8px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  cursor: pointer;
}

.preset:hover:not(.on) {
  background: #f1f0ec;
}

/* The chosen chip, like the chosen tab, is a rule and an ink and no fill. */
.preset.on {
  color: var(--text-strong);
  border-color: var(--text-strong);
  cursor: default;
}

:root[data-theme="dark"] .tab,
:root[data-theme="dark"] .preset {
  color: #f4f4f5;
  border-color: #2e2e2e;
}

:root[data-theme="dark"] .tab:hover:not(.on),
:root[data-theme="dark"] .preset:hover:not(.on) {
  background: #ffffff0f;
}

:root[data-theme="dark"] .tab.on,
:root[data-theme="dark"] .preset.on {
  border-color: var(--text-strong);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .tab,
  :root:not([data-theme="light"]) .preset {
    color: #f4f4f5;
    border-color: #2e2e2e;
  }

  :root:not([data-theme="light"]) .tab:hover:not(.on),
  :root:not([data-theme="light"]) .preset:hover:not(.on) {
    background: #ffffff0f;
  }

  :root:not([data-theme="light"]) .tab.on,
  :root:not([data-theme="light"]) .preset.on {
    border-color: var(--text-strong);
  }
}

.preset-mark {
  width: 16px;
  height: 16px;
}

.preset-plus {
  width: 16px;
  height: 16px;
  stroke: var(--text-weak);
  stroke-width: 1.4;
  stroke-linecap: round;
}

/* MiMo's set-card and its sr rows, the same ones the rest of the dialog uses. */
.card {
  padding: 0 16px;
  background: #ffffff;
  border: 1px solid #f3efeb;
  border-radius: 16px;
}

.line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  padding: 16px 0;
  border-bottom: 1px solid #f3efeb;
}

.line:last-child {
  border-bottom: none;
}

:root[data-theme="dark"] .card {
  background: #282828;
  border-color: #3d3d3d;
}

:root[data-theme="dark"] .line {
  border-color: #3d3d3d;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .card {
    background: #282828;
    border-color: #3d3d3d;
  }

  :root:not([data-theme="light"]) .line {
    border-color: #3d3d3d;
  }
}

.line-title {
  color: var(--text-strong);
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
}

.line-value {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-base);
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.tag {
  padding: 1px 6px;
  color: var(--text-weak);
  background: var(--surface-hover);
  border-radius: 6px;
  font-size: calc(11px * var(--ui-font-scale, 1));
}

.endpoint {
  display: flex;
  gap: 8px;
  width: 420px;
  max-width: 100%;
}

.field-in {
  box-sizing: border-box;
  flex: 1;
  min-width: 0;
  height: calc(32px * var(--ui-font-scale, 1));
  padding: 0 10px;
  color: var(--text-strong);
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  outline: none;
}

.field-in:focus {
  border-color: var(--border-strong);
}

.section {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-top: 10px;
  color: var(--text-strong);
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 500;
}

.count {
  color: var(--text-base);
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-weight: 400;
}

.card.models {
  max-height: 260px;
  padding: 4px 16px;
  overflow-y: auto;
}

.model-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 0;
  font-size: calc(12.5px * var(--ui-font-scale, 1));
}

.model-name {
  overflow: hidden;
  color: var(--text-strong);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-id {
  flex: none;
  color: var(--text-weak);
  font-family: var(--font-mono);
  font-size: calc(11.5px * var(--code-font-scale, 1));
}

/*
 * MiMo's models-actions-dock: a glass pill held against the dialog shell - 8 up
 * from its foot, clear of the 240 navigation column by the page's own inset,
 * and the same again at the other end - rather than a bar the page carries
 * along as it scrolls. The floor below the page is what keeps the last card
 * reachable underneath it.
 */
.dock {
  position: absolute;
  bottom: 8px;
  inset-inline-start: 320px;
  inset-inline-end: 80px;
  z-index: 8;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 48px;
  padding: 6px 10px 6px 8px;
  background: color-mix(in srgb, #fffefd 42%, transparent);
  border: 1px solid color-mix(in srgb, #f0ebe5 70%, transparent);
  border-radius: 999px;
  box-shadow: 0 8px 28px #00000024, inset 0 1px #ffffff47;
  backdrop-filter: blur(22px) saturate(165%);
}

:root[data-theme="dark"] .dock {
  background: color-mix(in srgb, #282828 42%, transparent);
  border-color: color-mix(in srgb, #2e2e2e 70%, transparent);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .dock {
    background: color-mix(in srgb, #282828 42%, transparent);
    border-color: color-mix(in srgb, #2e2e2e 70%, transparent);
  }
}

.dock-floor {
  flex: none;
  height: 130px;
}

.dock-start {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
}

.dock-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  height: calc(34px * var(--ui-font-scale, 1));
  padding: 0 10px;
  color: var(--text-base);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 8px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  white-space: nowrap;
  cursor: pointer;
}

.dock-btn svg {
  flex: none;
  width: 15px;
  height: 15px;
}

.dock-btn:hover:not(:disabled) {
  color: var(--text-strong);
  background: #f1f0ec;
  border-color: #f0ebe5;
}

:root[data-theme="dark"] .dock-btn:hover:not(:disabled) {
  background: #ffffff0f;
  border-color: #2e2e2e;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .dock-btn:hover:not(:disabled) {
    background: #ffffff0f;
    border-color: #2e2e2e;
  }
}

/* Deleting a provider is the one red hover: red-500 on its own 10% wash inside red-300. */
.dock-btn.danger:hover:not(:disabled) {
  color: #fb2c36;
  background: color-mix(in srgb, #fb2c36 10%, transparent);
  border-color: #ffa2a2;
}

.dock-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.env-note {
  padding: 0 10px;
  color: var(--text-base);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

/* MiMo's Button size sm, default variant: 26 tall, 8 round, 12 in, 14/500. */
.primary {
  height: calc(26px * var(--ui-font-scale, 1));
  padding: 0 12px;
  color: #ffffff;
  background: #151c13;
  border: 0;
  border-radius: 8px;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
}

:root[data-theme="dark"] .primary {
  color: #0d0d0d;
  background: #ececec;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .primary {
    color: #0d0d0d;
    background: #ececec;
  }
}

.primary:hover:not(:disabled) {
  opacity: 0.9;
}

.primary:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
