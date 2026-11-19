<script setup lang="ts">
import { onMounted, ref } from "vue"
import type { SshDevice, SshDeviceInput, SshStatus, SshTest } from "@shared/ssh"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"

const emit = defineEmits<{ "session-started": [] }>()
const app = useApp()
const devices = ref<SshDevice[]>([])
const statuses = ref<Record<string, SshStatus>>({})
const results = ref<Record<string, SshTest>>({})
const dialog = ref<HTMLDialogElement>()
const confirm = ref<HTMLDialogElement>()
const candidate = ref<SshDevice>()
const formOpen = ref(false)
const confirmationOpen = ref(false)
const draft = ref<SshDeviceInput>({ name: "", host: "", user: "", port: 22, auth: "agent" })
const draftResult = ref<SshTest>()
const error = ref("")
const formError = ref("")
const busy = ref(false)
const testing = ref(false)
const launching = ref<string>()

function client() {
  if (!app.client) throw new Error(t("set.ssh.unavailable"))
  return app.client
}

onMounted(async () => {
  try {
    devices.value = (await client().request({ type: "ssh.list" })).devices
  } catch {
    error.value = t("set.ssh.unavailable")
  }
})

function edit(device?: SshDevice) {
  draft.value = device ? { ...device } : { name: "", host: "", user: "", port: 22, auth: "agent" }
  draftResult.value = undefined
  formError.value = ""
  dialog.value?.showModal()
  formOpen.value = true
}

function resultText(result: SshTest): string {
  return result.ok ? t("set.ssh.success", { os: result.os }) : t(`set.ssh.failure.${result.reason}`)
}

async function test(device: { id: string } | SshDeviceInput): Promise<SshTest> {
  try {
    return await client().request({ type: "ssh.test", device })
  } catch {
    return { ok: false, reason: "client" }
  }
}

async function testDraft() {
  if (busy.value) return
  busy.value = true
  formError.value = ""
  draftResult.value = undefined
  testing.value = true
  try {
    draftResult.value = await test({ ...draft.value })
  } finally {
    testing.value = false
    busy.value = false
  }
}

async function testSaved(device: SshDevice) {
  statuses.value[device.id] = "connecting"
  const result = await test({ id: device.id })
  results.value[device.id] = result
  statuses.value[device.id] = statusOf(result)
}

function statusOf(result: SshTest): SshStatus {
  return result.ok ? "connected" : result.reason === "auth" ? "authFailed" : "unreachable"
}

async function save() {
  if (busy.value) return
  busy.value = true
  formError.value = ""
  try {
    const { device } = await client().request({ type: "ssh.save", device: { ...draft.value } })
    const index = devices.value.findIndex((item) => item.id === device.id)
    if (index < 0) devices.value.push(device)
    else devices.value[index] = device
    if (draftResult.value) {
      results.value[device.id] = draftResult.value
      statuses.value[device.id] = statusOf(draftResult.value)
    } else {
      delete results.value[device.id]
      delete statuses.value[device.id]
    }
    dialog.value?.close()
  } catch {
    formError.value = t("set.ssh.saveError")
  } finally {
    busy.value = false
  }
}

function askRemove(device: SshDevice) {
  candidate.value = device
  confirm.value?.showModal()
  confirmationOpen.value = true
}

async function remove() {
  if (!candidate.value || busy.value) return
  busy.value = true
  error.value = ""
  const { id } = candidate.value
  try {
    await client().request({ type: "ssh.remove", id })
    devices.value = devices.value.filter((device) => device.id !== id)
    delete statuses.value[id]
    delete results.value[id]
  } catch {
    error.value = t("set.ssh.removeError")
  } finally {
    busy.value = false
    confirm.value?.close()
  }
}

async function start(device: SshDevice) {
  if (launching.value) return
  launching.value = device.id
  error.value = ""
  try {
    await app.create(undefined, { sshDeviceId: device.id, title: device.name })
    emit("session-started")
  } catch {
    error.value = t("set.ssh.startError")
  } finally {
    launching.value = undefined
  }
}
</script>

<template>
  <section class="devices">
    <h2>{{ t("set.ssh.title") }}</h2>
    <p>{{ t("set.ssh.description") }}</p>
    <button type="button" @click="edit()">{{ t("set.ssh.add") }}</button>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="!devices.length && !error" class="empty">{{ t("set.ssh.empty") }}</p>
    <article v-for="device in devices" :key="device.id" class="device">
      <div class="identity">
        <strong>{{ device.name }}</strong>
        <span>{{ device.host.includes(":") ? `[${device.host}]` : device.host }}:{{ device.port }} · {{ device.user }}</span>
      </div>
      <span class="badge" :data-status="statuses[device.id] || 'idle'">{{ t(`set.ssh.status.${statuses[device.id] || 'idle'}`) }}</span>
      <div class="actions">
        <button type="button" :disabled="statuses[device.id] === 'connecting'" @click="testSaved(device)">{{ t("set.ssh.test") }}</button>
        <button type="button" :disabled="statuses[device.id] === 'connecting'" @click="edit(device)">{{ t("set.ssh.edit") }}</button>
        <button type="button" :disabled="statuses[device.id] === 'connecting'" @click="askRemove(device)">{{ t("set.ssh.delete") }}</button>
        <button type="button" :disabled="!!launching" @click="start(device)">{{ t("set.ssh.start") }}</button>
      </div>
      <p v-if="results[device.id]" class="result" role="status">{{ resultText(results[device.id]) }}</p>
    </article>

    <dialog ref="dialog" class="device-dialog" aria-labelledby="ssh-form-title" :aria-modal="formOpen || undefined" @cancel="busy && $event.preventDefault()" @close="formOpen = false; draft.password = undefined">
      <form class="form" @submit.prevent="save">
        <h3 id="ssh-form-title">{{ t(draft.id ? "set.ssh.editTitle" : "set.ssh.add") }}</h3>
        <fieldset :disabled="busy" @input="draftResult = undefined">
          <label>{{ t("set.ssh.name") }} <input v-model="draft.name" required /></label>
          <label>{{ t("set.ssh.host") }} <input v-model="draft.host" required spellcheck="false" /></label>
          <label>{{ t("set.ssh.port") }} <input v-model.number="draft.port" type="number" min="1" max="65535" required /></label>
          <label>{{ t("set.ssh.user") }} <input v-model="draft.user" required spellcheck="false" /></label>
          <label>{{ t("set.ssh.auth") }}
            <select v-model="draft.auth" @change="draft.password = undefined">
              <option value="agent">{{ t("set.ssh.agent") }}</option>
              <option value="key">{{ t("set.ssh.key") }}</option>
              <option value="password">{{ t("set.ssh.password") }}</option>
            </select>
          </label>
          <label v-if="draft.auth === 'key'">{{ t("set.ssh.keyPath") }} <input v-model="draft.keyPath" required spellcheck="false" /></label>
          <label v-if="draft.auth === 'password'">{{ t("set.ssh.password") }} <input v-model="draft.password" type="password" autocomplete="new-password" :required="!draft.id" /></label>
        </fieldset>
        <p v-if="testing" role="status">{{ t("set.ssh.status.connecting") }}</p>
        <p v-if="draftResult" role="status">{{ resultText(draftResult) }}</p>
        <p v-if="formError" role="alert">{{ formError }}</p>
        <div class="actions">
          <button type="button" :disabled="busy" @click="dialog?.close()">{{ t("set.ssh.cancel") }}</button>
          <button type="button" :disabled="busy || !draft.name || !draft.host || !draft.user" @click="testDraft">{{ t("set.ssh.test") }}</button>
          <button type="submit" :disabled="busy">{{ t("set.ssh.save") }}</button>
        </div>
      </form>
    </dialog>

    <dialog ref="confirm" class="device-dialog" aria-labelledby="ssh-delete-title" :aria-modal="confirmationOpen || undefined" @cancel="busy && $event.preventDefault()" @close="confirmationOpen = false">
      <div class="form">
        <h3 id="ssh-delete-title">{{ t("set.ssh.delete") }}</h3>
        <p>{{ t("set.ssh.confirm", { name: candidate?.name ?? "" }) }}</p>
        <div class="actions">
          <button type="button" autofocus :disabled="busy" @click="confirm?.close()">{{ t("set.ssh.cancel") }}</button>
          <button type="button" :disabled="busy" @click="remove">{{ t("set.ssh.delete") }}</button>
        </div>
      </div>
    </dialog>
  </section>
</template>

<style scoped>
/*
 * The settings pages' own look - title, sub-line, card and button - repeated
 * here: SettingsDialog's rules are scoped and do not reach this component's
 * markup, so this page used to draw with bare borders and browser defaults.
 */
.devices {
  --set-btn: #f1f1f1;
  --set-btn-hover: #f1f0ec;
  --set-btn-ink: #151c13;
  --set-card: #ffffff;
  --set-card-edge: #f3efeb;
  --set-field-edge: #e3e3e0;
  --set-field: transparent;
  --set-title: var(--text-strong);
}

:root[data-theme="dark"] .devices {
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
  :root:not([data-theme="light"]) .devices {
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

.devices h2 {
  margin: 0 0 26px;
  color: var(--set-title);
  font-size: calc(24px * var(--ui-font-scale, 1));
  font-weight: 400;
  line-height: calc(38.4px * var(--ui-font-scale, 1));
}

.devices p {
  margin: 0 0 14px;
  color: var(--text-base);
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: calc(20px * var(--ui-font-scale, 1));
}

.devices > button {
  margin-bottom: 14px;
}

/* The empty list is a card with one line in it, as every other empty list on these pages is. */
.devices > .empty,
.device {
  box-sizing: border-box;
  width: 100%;
  margin: 0 0 8px;
  padding: 16px;
  background: var(--set-card);
  border: 1px solid var(--set-card-edge);
  border-radius: 16px;
}

.device {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.identity {
  display: grid;
  flex: 1;
  gap: 4px;
  min-width: 130px;
  overflow-wrap: anywhere;
}

.identity strong {
  color: var(--text-strong);
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 530;
}

.identity span,
.badge {
  color: var(--text-base);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.badge {
  padding: 2px 8px;
  border: 1px solid currentColor;
  border-radius: 16px;
}

.badge[data-status="connected"] {
  color: var(--text-success);
}

.badge[data-status="authFailed"],
.badge[data-status="unreachable"] {
  color: var(--text-critical);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.devices .result {
  flex-basis: 100%;
  margin: 0;
  overflow-wrap: anywhere;
}

.device-dialog {
  width: min(390px, calc(100vw - 40px));
  padding: 20px;
  color: var(--text-strong);
  background: var(--surface-raised);
  border: 1px solid var(--set-card-edge);
  border-radius: 16px;
}

.device-dialog::backdrop {
  background: var(--scrim);
}

.form {
  display: grid;
  gap: 14px;
}

.form h3 {
  margin: 0;
  font-size: calc(15px * var(--ui-font-scale, 1));
  font-weight: 600;
}

.form p {
  margin: 0;
}

.form .actions {
  justify-content: flex-end;
}

fieldset {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  border: 0;
}

label {
  display: grid;
  gap: 5px;
  color: var(--text-base);
  font-size: calc(12px * var(--ui-font-scale, 1));
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
</style>
