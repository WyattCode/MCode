<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue"
import type { ServerEntry } from "@shared/protocol"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"
import { notify } from "../lib/toast"
import ConfirmDialog from "./ConfirmDialog.vue"

/**
 * The list of servers this app can talk to.
 *
 * The backend the app starts for itself is always the first row and can never
 * be deleted - it is the thing to come back to when a remote server is
 * unreachable, and a list that could be emptied to nothing would be a way to
 * lock oneself out of one's own machine.
 *
 * MiMo has no server dialog, so this one is drawn with MiMo's shared modal
 * numbers: a 16px corner on a 1px line, 22 by 24 of padding, a 17px title over
 * a 13px muted lead, its ghost and primary buttons, the list popover for the
 * row menu, and the shared confirm before a server is deleted.
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
/** The server waiting on the delete confirm. */
const deleting = ref<ServerEntry>()

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

/* As MiMo does for a settings list entry, deleting asks first. */
function askRemove(entry: ServerEntry) {
  menuFor.value = undefined
  deleting.value = entry
}

async function remove() {
  const entry = deleting.value
  deleting.value = undefined
  if (!entry) return
  const next = servers.value.filter((row) => row.id !== entry.id)
  await app.patchConfig({ servers: next })
  // A default pointing at a server that no longer exists would send the next
  // launch at an address that is gone, so it goes with the row.
  if (defaultID.value === entry.id) await app.setDefaultServer("")
  // Deleting the server currently in use drops back to the local backend
  // rather than leaving the app pointed at a row that is gone.
  if (connectedURL.value === entry.url) emit("connect", "")
  notify(t("srv.deleted", { name: label(entry) }))
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

function onEscape() {
  // The confirm on top closes itself on the same press.
  if (deleting.value) return
  if (editing.value === undefined) emit("close")
  else cancel()
}

onMounted(() => {
  field.value?.focus()
})
</script>

<template>
  <div class="scrim" @mousedown.self="emit('close')">
    <div v-modal class="dialog" data-servers-dialog @keydown.escape="onEscape">
      <header class="bar">
        <div class="head">
          <h2 class="title">{{ t("srv.title") }}</h2>
          <p class="lead">{{ t("srv.description") }}</p>
        </div>
        <button class="icon" :aria-label="t('common.close')" v-tip="t('common.close')" @click="emit('close')">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
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
          :data-server-row="entry.id"
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

          <div v-if="menuFor === entry.id" class="menu" data-server-menu @click.stop>
            <button class="item" @click="openEdit(entry)">{{ t("srv.menuEdit") }}</button>
            <button v-if="entry.id !== defaultID" class="item" @click="setDefault(entry.id)">
              {{ t("srv.menuDefault") }}
            </button>
            <button v-else class="item" @click="setDefault('')">{{ t("srv.menuDefaultRemove") }}</button>
            <button class="item danger" data-server-delete @click="askRemove(entry)">{{ t("srv.menuDelete") }}</button>
          </div>
        </div>

        <p v-if="!shown.length && !localMatches" class="empty">{{ t("srv.empty") }}</p>
      </div>

      <!-- Add and edit share one form: they differ by title and by whether an
           id is being written back, which is not enough to justify two. -->
      <form v-if="editing !== undefined" class="form" @submit.prevent="save">
        <h3 class="form-title">{{ editing ? t("srv.editTitle") : t("srv.add") }}</h3>
        <label class="label" for="srv-name">{{ t("srv.nameOptional") }}</label>
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
          <button type="button" class="ghost" @click="cancel">{{ t("common.cancel") }}</button>
          <button type="submit" class="primary" :disabled="checking">
            {{ checking ? t("srv.checking") : editing ? t("srv.save") : t("srv.add") }}
          </button>
        </div>
      </form>

      <div v-else class="add-row">
        <button class="ghost" data-server-add @click="openAdd">{{ t("srv.add") }}</button>
      </div>

      <footer class="foot">
        <div class="foot-head">
          <span class="foot-title">{{ t("srv.defaultTitle") }}</span>
          <span class="foot-value">{{ defaultEntry ? label(defaultEntry) : t("srv.defaultNone") }}</span>
        </div>
        <p class="foot-lead">{{ t("srv.defaultDescription") }}</p>
        <div class="actions">
          <button v-if="defaultID" class="ghost" @click="setDefault('')">{{ t("srv.defaultClear") }}</button>
          <button class="ghost" :disabled="!connectedURL" @click="makeCurrentDefault">
            {{ t("srv.defaultSet") }}
          </button>
        </div>
      </footer>
    </div>
  </div>

  <Teleport to="body">
    <ConfirmDialog
      v-if="deleting"
      :title="t('srv.deleteTitle')"
      :body="
        connectedURL === deleting.url
          ? `${t('srv.deleteBody', { name: label(deleting) })}\n${t('srv.deleteCurrentNote')}`
          : t('srv.deleteBody', { name: label(deleting) })
      "
      :confirm-label="t('srv.menuDelete')"
      @confirm="remove"
      @close="deleting = undefined"
    />
  </Teleport>
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

/* MiMo's wider modal: 430 is its new-project box; a list wants a little more, so 480. */
.dialog {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: min(480px, 92vw);
  max-height: 76vh;
  padding: 22px 24px;
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 16px;
  box-shadow: var(--shadow-overlay);
}

.bar {
  display: flex;
  flex-shrink: 0;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 16px;
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
  font-size: calc(17px * var(--ui-font-scale, 1));
  font-weight: 400;
}

.lead {
  margin: 8px 0 0;
  color: var(--text-weak);
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: 1.6;
}

/* MiMo's close: 28 square, 8 round, muted. */
.icon {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 28px;
  height: 28px;
  margin: -4px -6px 0 0;
  color: var(--text-weak);
  border-radius: 8px;
}

.icon:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.search {
  margin-bottom: 8px;
}

.list {
  margin: 0 -8px;
  padding: 0 0 4px;
  overflow-y: auto;
}

.empty {
  display: flex;
  align-items: center;
  height: 48px;
  padding: 0 12px;
  color: var(--text-weak);
  font-size: calc(13px * var(--ui-font-scale, 1));
}

/* The menu hangs off the row, so the row is what it is positioned against. */
.row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px;
  text-align: start;
  border-radius: 8px;
  cursor: pointer;
}

.row:hover {
  background: var(--surface-hover);
}

.row.live {
  background: var(--surface-base);
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
  font-size: calc(13px * var(--ui-font-scale, 1));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.where {
  overflow: hidden;
  color: var(--text-weaker);
  font-size: calc(11px * var(--ui-font-scale, 1));
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
  font-size: calc(10px * var(--ui-font-scale, 1));
  font-weight: 500;
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: 6px;
}

.more {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 24px;
  height: 24px;
  color: var(--icon-weak);
  border-radius: 6px;
}

.more:hover {
  background: var(--surface-hover);
}

/* MiMo's list popover: 12 round on a 1px line with the menu shadow and 5px of padding. */
.menu {
  position: absolute;
  top: 100%;
  z-index: 2;
  display: flex;
  flex-direction: column;
  min-width: 160px;
  padding: 5px;
  background: var(--surface-menu);
  border: 1px solid var(--border-weak);
  border-radius: 12px;
  box-shadow: var(--shadow-lg);
  /* Hung from the end the trigger sits at, so it opens beside the button in
     either direction rather than always to the right. */
  inset-inline-end: 8px;
}

.item {
  padding: 6px 8px;
  color: var(--text-strong);
  font-size: calc(14px * var(--ui-font-scale, 1));
  line-height: 20px;
  text-align: start;
  border-radius: 8px;
}

.item:hover {
  background: var(--surface-hover);
}

.item.danger {
  color: #d93025;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex-shrink: 0;
  margin-top: 8px;
  padding: 12px;
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: 10px;
}

.form-title {
  margin: 0 0 2px;
  color: var(--text-strong);
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
}

.label {
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.error {
  margin: 0;
  color: #d93025;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  margin-top: 8px;
}

.add-row {
  display: flex;
  flex-shrink: 0;
  margin-top: 8px;
}

/* MiMo's modal buttons: 14px at 8 by 18 on an 8px corner; cancel on a line, primary in the send colour. */
.ghost,
.primary {
  padding: 8px 18px;
  border: 1px solid transparent;
  border-radius: 8px;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 400;
  cursor: pointer;
}

.ghost {
  color: var(--text-base);
  background: #fffefd;
  border-color: var(--border-weak);
}

.ghost:hover:not(:disabled) {
  color: var(--text-strong);
  background: #f1f0ec;
}

.primary {
  color: var(--button-primary-text);
  background: var(--button-primary);
  border-color: var(--button-primary);
}

.primary:hover:not(:disabled) {
  opacity: 0.9;
}

.ghost:disabled,
.primary:disabled {
  opacity: 0.5;
  cursor: default;
}

.foot {
  flex-shrink: 0;
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--border-weak);
}

.foot-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.foot-title {
  color: var(--text-strong);
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
}

.foot-value {
  overflow: hidden;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.foot-lead {
  margin: 4px 0 0;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 1.6;
}

:root[data-theme="dark"] .ghost {
  background: #1a1a1a;
}

:root[data-theme="dark"] .ghost:hover:not(:disabled) {
  background: #ffffff0f;
}

:root[data-theme="dark"] .item.danger,
:root[data-theme="dark"] .error {
  color: #ff9b7f;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .ghost {
    background: #1a1a1a;
  }

  :root:not([data-theme="light"]) .ghost:hover:not(:disabled) {
    background: #ffffff0f;
  }

  :root:not([data-theme="light"]) .item.danger,
  :root:not([data-theme="light"]) .error {
    color: #ff9b7f;
  }
}
</style>
