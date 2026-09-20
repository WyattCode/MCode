<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue"
import type { McpServerState, SkillSummary } from "@shared/protocol"
import ContextMenu from "./ContextMenu.vue"
import SkillDetailDialog from "./SkillDetailDialog.vue"
import type { MenuItem } from "../lib/menu"
import { useApp } from "../stores/app"
import { language, t } from "../lib/i18n"
import { notice, notify, notifyFailure } from "../lib/toast"
import { skillTitle, type SkillContentState } from "../lib/skill-display"

/**
 * The plugins page, laid out from MiMo's: a 900 column with a 24/500 title, a
 * line under it, a search field, and an Installed section whose right end
 * offers Manage.
 *
 * MiMo follows that with a catalogue - Featured, Productivity - of things to
 * install with one press. There is no catalogue here: this app's plugins are
 * the MCP servers the user has configured, and a shop front with nothing
 * behind it would be a picture of a feature rather than the feature. So the
 * page stops where the real data stops, and Manage opens the place servers
 * are actually added.
 */
const app = useApp()
const emit = defineEmits<{
  manage: []
  /* The skill card's 在对话中试用 and 让智能体配置: the window decides which box the chip goes into. */
  "try-skill": [name: string, title: string]
  "configure-skill": [name: string, title: string]
}>()

const servers = ref<McpServerState[]>([])
/* Every skill the open project reaches, switched off ones too: the page is where they are switched. */
const skills = ref<SkillSummary[]>([])
const loaded = ref(false)
const query = ref("")

/** One row of the installed list: a server, or a skill the open project offers. */
interface Entry {
  key: string
  kind: "plugin" | "skill"
  name: string
  enabled: boolean
  server?: McpServerState
  skill?: SkillSummary
  description?: string
  /** A skill shipped with the app. */
  builtin?: boolean
}

/* The folder whose skills are listed: the open conversation's, or the default one on the home screen. */
const where = computed(() => app.current?.directory ?? app.config?.directory)

/** Rejects when the list cannot be read, leaving the skills already shown in place. */
async function loadSkills(): Promise<void> {
  const directory = where.value
  if (!directory) {
    skills.value = []
    return
  }
  const listed = await app.client?.request({ type: "skill.list", directory })
  if (!listed) throw new Error(t("error.backendLost"))
  skills.value = listed.skills
}

/*
 * The servers and the skills, read side by side as MiMo's page reads them
 * (Promise.allSettled): a half that answers is shown, and a half that fails
 * is said rather than read as "nothing installed". Resolves to the first
 * failure's reason, or undefined when both answered.
 */
const listFailed = ref(false)

async function loadLists(): Promise<string | undefined> {
  const [listed, read] = await Promise.allSettled([app.client?.request({ type: "mcp.list" }), loadSkills()])
  if (listed.status === "fulfilled" && listed.value) servers.value = listed.value.servers
  const failure =
    listed.status === "rejected" ? listed.reason : !listed.value ? new Error(t("error.backendLost")) : read.status === "rejected" ? read.reason : undefined
  listFailed.value = failure !== undefined
  return failure === undefined ? undefined : failure instanceof Error ? failure.message : String(failure)
}

async function retryLists() {
  loaded.value = false
  await loadLists()
  loaded.value = true
}

/* MiMo's filter: by state, then by type, each with its own "all". */
type StatusFilter = "all" | "on" | "off"
type TypeFilter = "all" | "plugin" | "skill"
const status = ref<StatusFilter>("all")
const kind = ref<TypeFilter>("all")
const filtering = computed(() => status.value !== "all" || kind.value !== "all")

const entries = computed<Entry[]>(() => [
  ...servers.value.map((server) => ({
    key: `plugin:${server.name}`,
    kind: "plugin" as const,
    name: server.name,
    enabled: server.status !== "disabled",
    server,
  })),
  ...skills.value.map((skill) => ({
    key: `skill:${skill.name}`,
    kind: "skill" as const,
    name: skillTitle(skill, language.value),
    enabled: skill.enabled,
    skill,
    description: skill.description,
    builtin: skill.builtin,
  })),
])

const shown = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase()
  return entries.value.filter((entry) => {
    if (status.value === "on" && !entry.enabled) return false
    if (status.value === "off" && entry.enabled) return false
    if (kind.value !== "all" && entry.kind !== kind.value) return false
    if (!needle) return true
    return (
      entry.name.toLocaleLowerCase().includes(needle) ||
      (entry.skill?.name ?? "").toLocaleLowerCase().includes(needle) ||
      (entry.description ?? "").toLocaleLowerCase().includes(needle)
    )
  })
})

let off: (() => void) | undefined

onMounted(async () => {
  /*
   * A server answers in its own time, and the answer arrives as an event
   * rather than in the reply to the list. Without this the page would show
   * whatever was true the moment it opened - every server stuck at "pending",
   * and a switch pressed here never seen to take.
   */
  off = app.client?.on((event) => {
    if (event.type === "mcp.status") servers.value = event.servers
  })
  await loadLists()
  loaded.value = true
})

onUnmounted(() => off?.())

/**
 * Off and on again, which is the only switch a server has.
 *
 * Held while the connection is made, as the dialog holds its own: starting a
 * server takes long enough to see, and a switch that can be pressed again in
 * that gap sends a second toggle at a server that is still answering the first.
 */
const busy = ref("")

async function toggle(name: string) {
  busy.value = name
  try {
    const result = await app.client?.request({ type: "mcp.toggle", name })
    if (result) servers.value = result.servers
  } catch (err) {
    notifyFailure(t("mcp.title"), err instanceof Error ? err.message : String(err))
  } finally {
    busy.value = ""
  }
}

/*
 * Refresh reads both halves again - the servers and the skills - and says
 * whether it could, as MiMo's does: either half failing is 刷新失败 with its
 * reason, and what that half showed before stays on the page.
 */
const refreshing = ref(false)

async function refresh() {
  if (refreshing.value) return
  refreshing.value = true
  try {
    const [failure] = await Promise.all([loadLists(), app.refreshCommands()])
    if (failure === undefined) notify(t("plugins.refreshed"))
    else notifyFailure(t("plugins.refreshFailed", { error: failure }))
  } finally {
    refreshing.value = false
  }
}

/*
 * A skill's switch, as MiMo's: the page moves at once, the name is written to
 * (or taken from) `disabledSkills`, the slash menu's list is asked for again,
 * and a note says which way it went. A write that fails puts the switch back.
 */
async function setSkillEnabled(name: string, enabled: boolean) {
  const skill = skills.value.find((entry) => entry.name === name)
  if (!skill || skill.enabled === enabled) return
  const title = skillTitle(skill, language.value)
  skills.value = skills.value.map((entry) => (entry.name === name ? { ...entry, enabled } : entry))
  const before = app.config?.disabledSkills ?? []
  const next = enabled ? before.filter((entry) => entry !== name) : [...before.filter((entry) => entry !== name), name]
  try {
    await app.patchConfig({ disabledSkills: next }, { quiet: true })
    void app.refreshCommands()
    notice.info(t(enabled ? "skills.enabledToast" : "skills.disabledToast", { name: title }))
  } catch (err) {
    skills.value = skills.value.map((entry) => (entry.name === name ? { ...entry, enabled: !enabled } : entry))
    notifyFailure(t("skills.toggleFailed", { error: err instanceof Error ? err.message : String(err) }))
  }
}

/* The row's "…" menu: 停用 or 启用, as MiMo's holds. */
const skillMenu = ref<{ x: number; y: number; name: string }>()
const skillMenuItems = computed<MenuItem[]>(() => {
  const skill = skills.value.find((entry) => entry.name === skillMenu.value?.name)
  return skill ? [{ key: "toggle", label: skill.enabled ? t("plugins.disable") : t("plugins.enable") }] : []
})

function openSkillMenu(event: MouseEvent, name: string) {
  const from = (event.currentTarget as HTMLElement).getBoundingClientRect()
  skillMenu.value = { x: Math.round(from.right), y: Math.round(from.bottom + 4), name }
}

function pickSkillMenu() {
  const name = skillMenu.value?.name
  skillMenu.value = undefined
  const skill = skills.value.find((entry) => entry.name === name)
  if (skill) void setSkillEnabled(skill.name, !skill.enabled)
}

/* The skill card: which skill, what its SKILL.md read gave, and whether an uninstall is under way. */
const detailName = ref<string>()
const detail = computed(() => skills.value.find((entry) => entry.name === detailName.value))
const content = ref<SkillContentState>({ status: "idle" })
const uninstalling = ref(false)

function openDetail(name: string) {
  detailName.value = name
  content.value = { status: "idle" }
}

async function loadContent() {
  const skill = detail.value
  const directory = where.value
  if (!skill || !directory) {
    content.value = { status: "failed" }
    return
  }
  content.value = { status: "loading" }
  try {
    const read = await app.client!.request({ type: "skill.content", directory, name: skill.name })
    if (detailName.value === skill.name) content.value = { status: "ready", path: read.path, text: read.content, truncated: read.truncated }
  } catch {
    if (detailName.value === skill.name) content.value = { status: "failed" }
  }
}

async function uninstall() {
  const skill = detail.value
  const directory = where.value
  if (!skill || !directory || uninstalling.value) return
  uninstalling.value = true
  const title = skillTitle(skill, language.value)
  try {
    await app.client!.request({ type: "skill.uninstall", directory, name: skill.name })
    detailName.value = undefined
    skills.value = skills.value.filter((entry) => entry.name !== skill.name)
    void app.refreshCommands()
    notice.success(t("skillDetail.uninstalledToast", { name: title }))
  } catch (err) {
    notice.danger(t("skillDetail.uninstallFailed", { error: err instanceof Error ? err.message : String(err) }))
  } finally {
    uninstalling.value = false
  }
}

function trySkill() {
  const skill = detail.value
  if (!skill) return
  detailName.value = undefined
  emit("try-skill", skill.name, skillTitle(skill, language.value))
}

function configureSkill() {
  const skill = detail.value
  if (!skill) return
  detailName.value = undefined
  emit("configure-skill", skill.name, skillTitle(skill, language.value))
}

/** The filter menu, its right edge on the button's as MiMo aligns it. */
const filterMenu = ref<{ x: number; y: number }>()

const filterItems = computed<MenuItem[]>(() => [
  { key: "status:all", label: t("plugins.filterAll"), checked: status.value === "all" },
  { key: "status:on", label: t("plugins.filterOn"), checked: status.value === "on" },
  { key: "status:off", label: t("plugins.filterOff"), checked: status.value === "off" },
  { key: "type:all", label: t("plugins.typeAll"), checked: kind.value === "all", divided: true },
  { key: "type:plugin", label: t("plugins.typePlugins"), checked: kind.value === "plugin" },
  { key: "type:skill", label: t("plugins.typeSkills"), checked: kind.value === "skill" },
])

function openFilter(event: MouseEvent) {
  const from = (event.currentTarget as HTMLElement).getBoundingClientRect()
  filterMenu.value = { x: Math.round(from.right), y: Math.round(from.bottom + 4) }
}

function pickFilter(key: string) {
  filterMenu.value = undefined
  const [group, value] = key.split(":")
  if (group === "status") status.value = value as StatusFilter
  else if (group === "type") kind.value = value as TypeFilter
}
</script>

<template>
  <div class="plugins">
    <div class="drag" aria-hidden="true" />
    <div class="column">
      <div class="title-row">
        <h1 class="title">{{ t("plugins.title") }}</h1>
        <div class="actions">
          <button
            class="icon-btn refresh"
            :aria-label="t('plugins.refresh')"
            v-tip="{ label: t('plugins.refresh'), placement: 'bottom' }"
            :disabled="refreshing"
            @click="refresh"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3"
                stroke="currentColor"
                stroke-width="1.2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>
      <p class="subtitle">{{ t("plugins.subtitle") }}</p>

      <div class="bar">
        <div class="search">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="4.3" stroke="currentColor" stroke-width="1.2" />
            <path d="M10.2 10.2 14 14" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
          </svg>
          <input
            v-model="query"
            :placeholder="t('plugins.search')"
            :aria-label="t('plugins.search')"
            spellcheck="false"
            autocomplete="off"
          />
        </div>
        <button
          class="filter"
          :class="{ active: filtering }"
          :aria-label="t('plugins.filter')"
          :aria-expanded="Boolean(filterMenu)"
          aria-haspopup="menu"
          v-tip="{ label: t('plugins.filter'), placement: 'bottom' }"
          @click="openFilter"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2.5 4h11M4.5 8h7M6.5 12h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
          </svg>
          <span v-if="filtering" class="dot" aria-hidden="true" />
        </button>
      </div>

      <div class="head">
        <span class="head-label">{{ t("plugins.installed") }}</span>
        <button class="manage" @click="emit('manage')">{{ t("plugins.manage") }}</button>
      </div>

      <!--
        A list that could not be read is said, with Retry, rather than read as
        nothing installed - above what the other half did bring back, where it is seen.
      -->
      <p v-if="loaded && listFailed" class="empty failed" data-plugins-failed>
        <span>{{ t("plugins.listUnavailable") }}</span>
        <button class="retry" @click="retryLists">{{ t("common.retry") }}</button>
      </p>
      <div v-if="shown.length" class="cards">
        <div
          v-for="entry in shown"
          :key="entry.key"
          class="card"
          :class="{ opens: entry.skill }"
          :data-kind="entry.kind"
          :data-skill="entry.skill?.name"
          :data-skill-enabled="entry.skill ? String(entry.enabled) : undefined"
          :role="entry.skill ? 'button' : undefined"
          :tabindex="entry.skill ? 0 : undefined"
          @click="entry.skill && openDetail(entry.skill.name)"
          @keydown.enter.self="entry.skill && openDetail(entry.skill.name)"
          @keydown.space.self.prevent="entry.skill && openDetail(entry.skill.name)"
        >
          <div class="card-text">
            <span class="card-name">{{ entry.name }}</span>
            <span class="card-note">
              <template v-if="entry.server">
                <span v-if="entry.server.error" class="card-error">{{ entry.server.error }}</span>
                <template v-else>{{ t("plugins.tools", { n: String(entry.server.tools) }) }}</template>
              </template>
              <template v-else>{{ entry.description || t("plugins.skill") }}</template>
            </span>
          </div>
          <template v-if="entry.server">
            <span class="card-state">{{ t(`mcp.status.${entry.server.status}`) }}</span>
            <button
              class="switch"
              :class="{ on: entry.server.status === 'connected' }"
              role="switch"
              :aria-checked="entry.server.status === 'connected'"
              :aria-label="entry.name"
              :disabled="busy === entry.name || entry.server.status === 'pending'"
              @click="toggle(entry.name)"
            >
              <span class="knob" />
            </button>
          </template>
          <template v-else-if="entry.skill">
            <span class="card-state" :data-builtin="entry.builtin ? '' : undefined">{{ entry.builtin ? t("plugins.builtinSkill") : t("plugins.skill") }}</span>
            <!-- MiMo's row action: a switched-off skill offers its install button, which switches it back on; otherwise the "…" menu. -->
            <button
              v-if="!entry.enabled"
              class="enable"
              :data-skill-enable-row="entry.skill.name"
              @click.stop="setSkillEnabled(entry.skill.name, true)"
            >
              {{ t("plugins.install") }}
            </button>
            <button
              v-else
              class="icon-btn more"
              :data-skill-more="entry.skill.name"
              :aria-label="t('plugins.moreActions')"
              aria-haspopup="menu"
              :aria-expanded="skillMenu?.name === entry.skill.name"
              v-tip="{ label: t('plugins.moreActions'), placement: 'bottom' }"
              @click.stop="openSkillMenu($event, entry.skill.name)"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <circle cx="3.5" cy="8" r="1.2" />
                <circle cx="8" cy="8" r="1.2" />
                <circle cx="12.5" cy="8" r="1.2" />
              </svg>
            </button>
          </template>
        </div>
      </div>

      <p v-if="loaded && !listFailed && !shown.length" class="empty">{{ entries.length ? t("plugins.noMatch") : t("plugins.none") }}</p>
    </div>
    <ContextMenu
      v-if="filterMenu"
      :x="filterMenu.x"
      :y="filterMenu.y"
      :items="filterItems"
      end
      @pick="pickFilter"
      @close="filterMenu = undefined"
    />
    <ContextMenu
      v-if="skillMenu"
      :x="skillMenu.x"
      :y="skillMenu.y"
      :items="skillMenuItems"
      :min-width="72"
      end
      @pick="pickSkillMenu"
      @close="skillMenu = undefined"
    />
    <SkillDetailDialog
      v-if="detail"
      :skill="detail"
      :busy="uninstalling"
      :content="content"
      @close="detailName = undefined"
      @toggle="(enabled: boolean) => detail && setSkillEnabled(detail.name, enabled)"
      @uninstall="uninstall"
      @configure="configureSkill"
      @try-skill="trySkill"
      @load-content="loadContent"
    />
  </div>
</template>

<style scoped>
/*
 * MiMo's plugins page, measured: the column 900 wide, its title 24/500/30 at
 * 55 from the top of the pane, the line under it 13/400/20, the search field
 * a row below, and the section head 14/500/22.4 with its quiet link at the
 * far end. The cards are this app's own: a server is a name, a state and a
 * switch, not a thing to be installed; a skill is a name, its kind and MiMo's
 * row action, and opens MiMo's skill card.
 */
.plugins {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scrollbar-gutter: stable both-edges;
}

/* No header on this page, so the top strip is what drags the window. */
.drag {
  position: absolute;
  inset: 0 0 auto;
  height: 44px;
  -webkit-app-region: drag;
}

.column {
  max-width: 900px;
  margin: 0 auto;
  padding: 55px 0 40px;
}

.title {
  margin: 0;
  color: var(--text-strong);
  font-size: calc(24px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: calc(30px * var(--ui-font-scale, 1));
}

.subtitle {
  margin: 4px 0 0;
  color: var(--text-base);
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 400;
  line-height: calc(20px * var(--ui-font-scale, 1));
}

/* The title with its actions at the far end: 16 apart, the row at least 30 tall. */
.title-row {
  display: flex;
  align-items: center;
  gap: 16px;
  min-height: 30px;
}

.actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  margin-inline-start: auto;
}

/* A bare 30px square with a 7px corner, filled only under the pointer. */
.icon-btn {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  color: var(--text-base);
  background: transparent;
  border: 0;
  border-radius: 7px;
}

.icon-btn:hover:not(:disabled) {
  color: var(--text-strong);
  background: color-mix(in srgb, var(--text-strong) 8%, transparent);
}

.icon-btn:disabled {
  opacity: 0.6;
}

/* The search field and its filter button, 10 apart. */
.bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 22px;
}

/* Outlined, a 7px inset around a 16px glyph, and a 6px dot while a filter is on. */
.filter {
  position: relative;
  display: inline-flex;
  flex: none;
  align-items: center;
  padding: 7px;
  color: var(--text-strong);
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--text-strong) 10%, var(--surface-raised));
  border-radius: 8px;
}

.filter:hover {
  background: color-mix(in srgb, var(--text-strong) 4%, transparent);
}

.dot {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 6px;
  height: 6px;
  background: var(--text-accent);
  border-radius: 50%;
}

.search {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 12px;
  color: var(--text-weak);
  background: color-mix(in srgb, var(--text-strong) 4%, var(--surface-raised));
  border: 1px solid color-mix(in srgb, var(--text-strong) 10%, var(--surface-raised));
  border-radius: 10px;
}

.search input {
  flex: 1;
  min-width: 0;
  color: var(--text-strong);
  background: transparent;
  border: 0;
  outline: none;
  font-size: calc(14px * var(--ui-font-scale, 1));
  line-height: calc(22.4px * var(--ui-font-scale, 1));
}

.search input::placeholder {
  color: var(--text-weak);
}

/* 14/500/22.4 with the link at the far end, as MiMo sets its own. */
.head {
  display: flex;
  align-items: center;
  margin-top: 32px;
}

.head-label {
  color: var(--text-strong);
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: calc(22.4px * var(--ui-font-scale, 1));
}

.manage {
  margin-inline-start: auto;
  color: var(--text-base);
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: calc(17px * var(--ui-font-scale, 1));
}

.manage:hover {
  color: var(--text-strong);
}

/* Two to a row, as MiMo lays its catalogue out. */
.cards {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px 20px;
  margin-top: 14px;
}

.card {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 14px 16px;
  background: color-mix(in srgb, var(--text-strong) 4%, var(--surface-raised));
  border: 1px solid color-mix(in srgb, var(--text-strong) 10%, var(--surface-raised));
  border-radius: 14px;
}

/* A skill's card opens its detail card. */
.card.opens {
  cursor: pointer;
}

.card.opens:hover {
  background: color-mix(in srgb, var(--text-strong) 7%, var(--surface-raised));
}

/* MiMo's row actions: a small outlined button, or a bare "…" square. */
.enable {
  flex-shrink: 0;
  height: calc(28px * var(--ui-font-scale, 1));
  padding: 0 12px;
  color: var(--text-strong);
  font-size: calc(13px * var(--ui-font-scale, 1));
  background: transparent;
  border: 1px solid var(--border-weak);
  border-radius: 8px;
}

.enable:hover {
  background: color-mix(in srgb, var(--text-strong) 6%, transparent);
}

.more {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
}

.card-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.card-name {
  overflow: hidden;
  color: var(--text-strong);
  font-size: calc(15px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: calc(21px * var(--ui-font-scale, 1));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-note {
  overflow: hidden;
  color: var(--text-base);
  font-size: calc(14px * var(--ui-font-scale, 1));
  line-height: calc(18.9px * var(--ui-font-scale, 1));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-error {
  color: var(--error);
}

.card-state {
  flex-shrink: 0;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: calc(16px * var(--ui-font-scale, 1));
}

/* The same round switch the settings page uses, so one control reads one way. */
.switch {
  position: relative;
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  width: 32px;
  height: 20px;
  background: color-mix(in srgb, var(--text-strong) 22%, var(--surface-raised));
  border: 0;
  border-radius: 999px;
  transition: background-color 0.15s;
}

.switch.on {
  background: var(--icon-base);
}

.switch:disabled {
  opacity: 0.6;
}

.knob {
  position: absolute;
  top: 2px;
  width: 16px;
  height: 16px;
  /* Always the opposite of the track it sits on, in either scheme. */
  background: var(--icon-base);
  border-radius: 50%;
  inset-inline-start: 2px;
  transition: inset-inline-start 0.15s, background-color 0.15s;
}

.switch.on .knob {
  background: var(--surface-raised);
  inset-inline-start: 14px;
}

.empty {
  margin: 14px 0 0;
  color: var(--text-base);
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: calc(20.8px * var(--ui-font-scale, 1));
}

.failed {
  display: flex;
  align-items: center;
  gap: 12px;
}

.failed .retry {
  color: var(--text-strong);
  font: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
}
</style>
