<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue"
import type { ServerEntry } from "@shared/protocol"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"

/**
 * The list of servers this app can talk to.
 *
 * The backend the app starts for itself is always the first row and can never
 * be deleted - it is the thing to come back to when a remote server is
 * unreachable, and a list that could be emptied to nothing would be a way to
 * lock oneself out of one's own machine.
 *
 * opencode also collects a username and password per server, for a server
 * behind a proxy that asks for them. MCode's protocol has no authentication and
 * the browser's WebSocket refuses a URL carrying credentials, so those two
 * fields would take a password and quietly drop it. They are left out until
 * there is something to hand them to.
 */
const emit = defineEmits<{ close: []; connect: [url: string] }>()

const app = useApp()

const query = ref("")
const field = ref<HTMLInputElement>()

/** The row whose menu is open, if any. */
const menuFor = ref<string>()

/** Set while the add/edit form is up: "" for a new server, or the id of one. */
const editing = ref<string>()
const draftName = ref("")
const draftURL = ref("")
const checking = ref(false)
const failed = ref(false)
const urlField = ref<HTMLInputElement>()

const servers = computed<ServerEntry[]>(() => app.config?.servers ?? [])
const connectedURL = computed(() => app.config?.serverURL?.trim() ?? "")
const defaultID = computed(() => app.config?.defaultServer ?? "")

/** What the local backend is called and where it is, for the fixed first row. */
const localLabel = computed(() => t("srv.localServer"))
const localAddress = computed(() => `127.0.0.1:${app.port || "-"}`)

const shown = computed(() => {
  const needle = query.value.trim().toLowerCase()
  if (!needle) return servers.value
  return servers.value.filter(
    (entry) =>
      entry.name.toLowerCase().includes(needle) || entry.url.toLowerCase().includes(needle),
  )
})

/** Whether the local row survives the search, so it can be hidden while filtering. */
const localMatches = computed(() => {
  const needle = query.value.trim().toLowerCase()
  if (!needle) return true
  return localLabel.value.toLowerCase().includes(needle) || localAddress.value.includes(needle)
})

const defaultEntry = computed(() => servers.value.find((entry) => entry.id === defaultID.value))

function label(entry: ServerEntry): string {
  return entry.name.trim() || entry.url
}

/**
 * Whether a server answers.
 *
 * Opening a socket and closing it again is the only honest test: the address
 * may parse, resolve and refuse, and the dialog says "could not connect"
 * because that is the thing the user is about to depend on.
 */
function reachable(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok: boolean, socket?: WebSocket) => {
      if (settled) return
      settled = true
      try {
        socket?.close()
      } catch {
        /* already closing */
      }
      resolve(ok)
    }
    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    } catch {
      resolve(false)
      return
    }
    // Long enough for a machine on the same network, short enough that a
    // mistyped address does not look like the dialog has hung.
    const timer = setTimeout(() => finish(false, socket), 4000)
    socket.onopen = () => {
      clearTimeout(timer)
      finish(true, socket)
    }
    socket.onerror = () => {
      clearTimeout(timer)
      finish(false, socket)
    }
    socket.onclose = () => {
      clearTimeout(timer)
      finish(false)
    }
  })
}

function openAdd() {
  editing.value = ""
  draftName.value = ""
  draftURL.value = ""
  failed.value = false
  menuFor.value = undefined
  void nextTick(() => urlField.value?.focus())
}

function openEdit(entry: ServerEntry) {
  editing.value = entry.id
  draftName.value = entry.name
  draftURL.value = entry.url
  failed.value = false
  menuFor.value = undefined
  void nextTick(() => urlField.value?.focus())
}

function cancel() {
  editing.value = undefined
  checking.value = false
  failed.value = false
}

async function save() {
  if (checking.value) return
  const url = draftURL.value.trim()
  const name = draftName.value.trim()
  if (!/^wss?:\/\//.test(url)) {
    failed.value = true
    return
  }

  checking.value = true
  failed.value = false
  const ok = await reachable(url)
  checking.value = false
  if (!ok) {
    failed.value = true
    return
  }

  const id = editing.value
  const next = id
    ? servers.value.map((entry) => (entry.id === id ? { ...entry, name, url } : entry))
    : [...servers.value, { id: crypto.randomUUID(), name, url }]
  await app.patchConfig({ servers: next })
  editing.value = undefined
}

async function remove(entry: ServerEntry) {
  menuFor.value = undefined
  const next = servers.value.filter((row) => row.id !== entry.id)
  await app.patchConfig({ servers: next })
  // A default pointing at a server that no longer exists would send the next
  // launch at an address that is gone, so it goes with the row.
  if (defaultID.value === entry.id) await app.setDefaultServer("")
  // Deleting the server currently in use drops back to the local backend
  // rather than leaving the app pointed at a row that is gone.
  if (connectedURL.value === entry.url) emit("connect", "")
}

async function setDefault(id: string) {
  menuFor.value = undefined
  await app.setDefaultServer(id)
}

/** Marks whichever server is connected now as the one to start with. */
async function makeCurrentDefault() {
  const current = servers.value.find((entry) => entry.url === connectedURL.value)
  await app.setDefaultServer(current?.id ?? "")
}

function choose(url: string) {
  if (url === connectedURL.value) return
  emit("connect", url)
}

onMounted(() => {
  field.value?.focus()
})
</script>

<template>
  <div class="scrim" @mousedown.self="emit('close')">
    <div v-modal class="dialog" @keydown.escape="editing === undefined ? emit('close') : cancel()">
      <header class="bar">
        <div class="head">
          <h2 class="title">{{ t("srv.title") }}</h2>
          <p class="lead">{{ t("srv.description") }}</p>
        </div>
        <span class="gap" />
        <button class="icon" v-tip="{ label: t('common.close'), placement: 'bottom' }" @click="emit('close')">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
        </button>
      </header>

      <div class="search">
        <input
          ref="field"
          v-model="query"
          class="field"
          :placeholder="t('srv.search')"
          spellcheck="false"
        />
      </div>

      <div class="list">
        <!-- The backend this app started. Always present, never removable. -->
        <div v-if="localMatches" class="row" :class="{ live: !connectedURL }" @click="choose('')">
          <span class="dot" :class="{ off: !app.connected || connectedURL }" />
          <span class="text">
            <span class="name">{{ localLabel }}</span>
            <span class="where">{{ localAddress }}</span>
          </span>
          <span v-if="!connectedURL" class="badge">{{ t("srv.current") }}</span>
        </div>

        <div
          v-for="entry in shown"
          :key="entry.id"
          class="row"
          :class="{ live: connectedURL === entry.url }"
          @click="choose(entry.url)"
        >
          <span class="dot" :class="{ off: connectedURL !== entry.url || !app.connected }" />
          <span class="text">
            <span class="name">{{ label(entry) }}</span>
            <span class="where">{{ entry.url }}</span>
          </span>
          <span v-if="entry.id === defaultID" class="badge">{{ t("srv.statusDefault") }}</span>
          <span v-if="connectedURL === entry.url" class="badge">{{ t("srv.current") }}</span>

          <button
            class="more"
            :aria-label="t('srv.menuEdit')"
            @click.stop="menuFor = menuFor === entry.id ? undefined : entry.id"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="3.5" cy="8" r="1.2" fill="currentColor" />
              <circle cx="8" cy="8" r="1.2" fill="currentColor" />
              <circle cx="12.5" cy="8" r="1.2" fill="currentColor" />
            </svg>
          </button>

          <div v-if="menuFor === entry.id" class="menu" @click.stop>
            <button class="item" @click="openEdit(entry)">{{ t("srv.menuEdit") }}</button>
            <button v-if="entry.id !== defaultID" class="item" @click="setDefault(entry.id)">
              {{ t("srv.menuDefault") }}
            </button>
            <button v-else class="item" @click="setDefault('')">{{ t("srv.menuDefaultRemove") }}</button>
            <button class="item danger" @click="remove(entry)">{{ t("srv.menuDelete") }}</button>
          </div>
        </div>

        <p v-if="!shown.length && !localMatches" class="empty">{{ t("srv.empty") }}</p>
      </div>

      <!-- Add and edit share one form: they differ by title and by whether an
           id is being written back, which is not enough to justify two. -->
      <form v-if="editing !== undefined" class="form" @submit.prevent="save">
        <h3 class="form-title">{{ editing ? t("srv.editTitle") : t("srv.add") }}</h3>
        <label class="label" for="srv-name">{{ t("srv.name") }}</label>
        <input
          id="srv-name"
          v-model="draftName"
          class="field"
          :placeholder="t('srv.namePlaceholder')"
          spellcheck="false"
        />
        <label class="label" for="srv-url">{{ t("srv.url") }}</label>
        <input
          id="srv-url"
          ref="urlField"
          v-model="draftURL"
          class="field"
          :placeholder="t('srv.urlPlaceholder')"
          spellcheck="false"
          autocomplete="off"
        />
        <p v-if="failed" class="error">{{ t("srv.addError") }}</p>
        <div class="actions">
          <button type="button" class="btn" @click="cancel">{{ t("common.cancel") }}</button>
          <button type="submit" class="btn primary" :disabled="checking">
            {{ checking ? t("srv.checking") : editing ? t("srv.save") : t("srv.add") }}
          </button>
        </div>
      </form>

      <button v-else class="add" @click="openAdd">{{ t("srv.add") }}</button>

      <footer class="foot">
        <div class="foot-head">
          <span class="foot-title">{{ t("srv.defaultTitle") }}</span>
          <span class="foot-value">{{ defaultEntry ? label(defaultEntry) : t("srv.defaultNone") }}</span>
        </div>
        <p class="foot-lead">{{ t("srv.defaultDescription") }}</p>
        <div class="actions">
          <button v-if="defaultID" class="btn" @click="setDefault('')">{{ t("srv.defaultClear") }}</button>
          <button class="btn" :disabled="!connectedURL" @click="makeCurrentDefault">
            {{ t("srv.defaultSet") }}
          </button>
        </div>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/*
 * Each dialog carries its own scrim rule, because scoped styles mean one
 * component's cannot reach another's. Without it the panel is a plain block in
 * the document flow: it lands wherever it was mounted, with nothing dimmed
 * behind it and nothing centred.
 */
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
  width: min(520px, 92vw);
  max-height: 76vh;
}

.bar {
  display: flex;
  flex-shrink: 0;
  align-items: flex-start;
  width: 100%;
  padding: 16px;
}

.head {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: flex-start;
  min-width: 0;
}

.title {
  margin: 0;
  color: var(--text-strong);
  font-size: 15px;
  font-weight: 530;
  line-height: 20px;
  letter-spacing: -0.13px;
}

.lead {
  margin-top: 4px;
  color: var(--text-base);
  font-size: 13px;
  font-weight: 440;
  line-height: 20px;
  letter-spacing: -0.04px;
}

.gap {
  flex: 1;
}

.icon {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-top: -2px;
  margin-inline-start: auto;
  margin-inline-end: -2px;
  color: var(--icon-weak);
  border-radius: 4px;
}

.icon:hover {
  background: var(--surface-hover);
}

.search {
  padding: 0 12px 8px;
}

.list {
  padding: 0 12px 4px;
  overflow-y: auto;
}

.empty {
  display: flex;
  align-items: center;
  height: 48px;
  padding: 0 12px;
  color: var(--text-weak);
  font-size: 13px;
}

/* The menu hangs off the row, so the row is what it is positioned against. */
.row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 12px;
  text-align: start;
  border-radius: 6px;
  cursor: pointer;
}

.row:hover {
  background: var(--surface-hover);
}

.row.live {
  background: var(--surface-raised);
}

.dot {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  background: var(--accent-base, #4ade80);
  border-radius: 50%;
}

.dot.off {
  background: var(--icon-weaker);
}

.text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.name {
  overflow: hidden;
  color: var(--text-strong);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.where {
  overflow: hidden;
  color: var(--text-weaker);
  font-size: 11px;
  font-weight: 440;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* An address is not prose: read it in the direction it was written even when
     the interface around it runs the other way. */
  direction: ltr;
  text-align: start;
}

.badge {
  flex-shrink: 0;
  padding: 1px 6px;
  color: var(--text-weaker);
  font-size: 10px;
  font-weight: 500;
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: 4px;
}

.more {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  color: var(--icon-weak);
  border-radius: 4px;
}

.more:hover {
  background: var(--surface-hover);
}

.menu {
  position: absolute;
  top: 100%;
  z-index: 2;
  display: flex;
  flex-direction: column;
  min-width: 148px;
  padding: 4px;
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 24%);
  /* Hung from the end the trigger sits at, so it opens beside the button in
     either direction rather than always to the right. */
  inset-inline-end: 8px;
}

.item {
  padding: 6px 8px;
  color: var(--text-base);
  font-size: 12px;
  text-align: start;
  border-radius: 4px;
}

.item:hover {
  background: var(--surface-hover);
}

.item.danger {
  color: var(--text-danger, #f87171);
}

.form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex-shrink: 0;
  margin: 4px 12px 0;
  padding: 12px;
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 8px;
}

.form-title {
  margin: 0 0 2px;
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 530;
}

.label {
  color: var(--text-weaker);
  font-size: 11px;
  font-weight: 440;
}

.error {
  color: var(--text-danger, #f87171);
  font-size: 11px;
}

.actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 6px;
}

/*
 * Nothing of its own. This carried `5px 10px`, 12px type and a 5px radius -
 * three numbers that match neither the shared button nor opencode's, so the
 * same control was a different size in this dialog than in every other.
 */
.btn {
  color: var(--text-base);
}

.btn:hover:not(:disabled) {
  background: var(--surface-hover);
}

.btn:disabled {
  opacity: 0.5;
}

.btn.primary {
  color: var(--text-strong);
  border-color: var(--border-base);
}

.add {
  flex-shrink: 0;
  margin: 4px 12px 0;
  padding: 7px 10px;
  color: var(--text-base);
  font-size: 12px;
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: 6px;
}

.add:hover {
  background: var(--surface-hover);
}

.foot {
  flex-shrink: 0;
  margin-top: 12px;
  padding: 12px 16px 14px;
  border-top: 1px solid var(--border-weak);
}

.foot-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.foot-title {
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 530;
}

.foot-value {
  overflow: hidden;
  color: var(--text-weaker);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.foot-lead {
  margin-top: 3px;
  color: var(--text-weaker);
  font-size: 11px;
  font-weight: 440;
  line-height: 16px;
}
</style>
