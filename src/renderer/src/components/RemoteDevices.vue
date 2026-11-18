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
    <p v-if="!devices.length && !error">{{ t("set.ssh.empty") }}</p>
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
.devices { display: grid; justify-items: start; gap: 12px; }
.devices h2, .devices p, .form h3 { margin: 0; }
.device, .device-dialog { border: 1px solid var(--border-weak); border-radius: 10px; }
.device { box-sizing: border-box; width: 100%; display: flex; flex-wrap: wrap; align-items: center; padding: 12px; gap: 10px; }
.identity { min-width: 130px; flex: 1; display: grid; gap: 4px; overflow-wrap: anywhere; }
.identity span, .badge { font-size: .85em; }
.badge { padding: 3px 8px; border: 1px solid currentColor; border-radius: 16px; }
.badge[data-status="connected"] { color: var(--text-success); }
.badge[data-status="authFailed"], .badge[data-status="unreachable"] { color: var(--text-critical); }
.actions { display: flex; flex-wrap: wrap; gap: 6px; }
.result { flex-basis: 100%; overflow-wrap: anywhere; }
.device-dialog { color: inherit; background: var(--surface-raised); width: min(390px, calc(100vw - 40px)); }
.device-dialog::backdrop { background: var(--scrim); }
.form { display: grid; gap: 12px; }
fieldset { display: grid; padding: 0; margin: 0; border: 0; gap: 8px; }
label { display: grid; gap: 4px; }
input, select, button { color: inherit; font: inherit; background: transparent; border: 1px solid var(--border-button); border-radius: 6px; padding: 5px 8px; }
select { background: var(--surface-raised); }
button:not(:disabled) { cursor: pointer; }
button:hover:not(:disabled) { background: var(--surface-hover); }
</style>
