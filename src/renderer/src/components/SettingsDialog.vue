<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { useApp } from "../stores/app"
import { useOpenWith } from "../lib/open-with"
import ModelsPage from "./ModelsPage.vue"
import { LANGUAGES, ago, compactTokens, dayLabel, language, sessionTitle, t, type Language } from "../lib/i18n"
import { pickDirectory, pickProjectFolder } from "../lib/native-pick"
import { wordMatch } from "../lib/word-match"
import { revealScrollTop } from "../lib/scroll-reveal"
import { folderName, projectName } from "../lib/project"
import { listedProjects } from "@shared/projects"
import { projectOf } from "../lib/session-project"
import SelectMenu from "./SelectMenu.vue"
import { chime } from "../lib/sound"
import { CHIMES, chimeOf, type Chime } from "@shared/chime"
import ConfirmDialog from "./ConfirmDialog.vue"
import LanguageMenu from "./LanguageMenu.vue"
import VoiceUsageDialog from "./VoiceUsageDialog.vue"
import ThirdPartyDialog from "./ThirdPartyDialog.vue"
import { APP_ICONS, DEFAULT_APP_ICON } from "@shared/app-icons"
import type { AgentsFileState, AppPath, AppPaths, SkillPathSource, UsageSummary } from "@shared/protocol"
import { skillPathCompat } from "@shared/protocol"
import type { McpImportItem, McpImportSource, McpServerConfig, McpStatus, McpToolInfo } from "@shared/protocol"
import { MCP_STATUS_TONE, isMcpStatus, mcpNeedsSignIn, mcpStatusLabel } from "../lib/mcp-status"
import { homePath } from "../lib/home-path"
import { chordOf, composing, formatChord, isBindable, recordingChord } from "../lib/keys"
import { layerOpen } from "../lib/escape-layer"
import { pageRows } from "../lib/shortcut-page"
import { fullAccessOff } from "../lib/confirm-queue"
import { notifyFailure, notify } from "../lib/toast"
import { installUpdate, updateState } from "./UpdatePill.vue"
import { writeText } from "./../lib/clipboard"

/* MiMo's 当前版本 button reads the update capsule's phase; a download announced by the app counts as ready. */
const updatePhase = computed(() =>
  updateState.phase === "idle" && props.updateReady ? "ready" : updateState.phase,
)

const emit = defineEmits<{ close: []; "check-updates": [] }>()
const app = useApp()

type Section =
  | "general"
  | "appearance"
  | "personal"
  | "keys"
  | "archive"
  | "files"
  | "environment"
  | "usage"
  | "updates"
  | "models"
  | "mcp"
  | "lab"

/** Which page to land on - the title bar's server button aims straight at it. */
/**
 * The command list, so the shortcuts page can be a view of it rather than a
 * second copy that has to be kept in step by hand.
 */
interface Bindable {
  id: string
  title: string
  group?: string
  hint?: string
  /** Kept out of the palette, and out of this page - see SHORTCUTS below. */
  hidden?: boolean
}

const props = defineProps<{
  section?: Section
  commands: Bindable[]
  /** An update check in flight. */
  updateChecking?: boolean
  /** The version downloaded and waiting for a restart, if any. */
  updateReady?: string
}>()
/*
 * The page on show, written through requestLeave: every nav button, the
 * search's Enter and its jump pass MiMo's unsaved-environment guard.
 */
const currentSection = ref<Section>(props.section ?? "general")
const section = computed<Section>({
  get: () => currentSection.value,
  set: (next) =>
    requestLeave(() => {
      currentSection.value = next
      // A nav click while a query is typed highlights the match on the page it opens, as MiMo's does.
      if (navQuery.value.trim()) void flashMatch(navQuery.value)
    }),
})
/*
 * A page asked for while the settings are already open.
 *
 * The dialog stays mounted for as long as it is open, so the prop was read
 * once and every later request was dropped. Most callers cannot reach here -
 * they are behind the guard that refuses to open anything over a dialog - but
 * a toast is not: the archive notice's 「查看已归档」 sits above the settings and
 * stays clickable, so opening the settings and then pressing it did nothing at
 * all. Written through `section`, so the unsaved-environment guard still gets
 * its say.
 */
watch(
  () => props.section,
  (next) => {
    if (next && next !== currentSection.value) section.value = next
  },
)

/* MiMo's 默认打开目标: the same remembered choice the title bar's open-location control uses. */
const { options: openOptions, choice: openChoice, choose: chooseOpen } = useOpenWith(() => app.platform)

/*
 * Standing instructions are edited in a box and saved on purpose rather than
 * on every keystroke: this text goes into the prompt of every session, and a
 * half-typed sentence saved mid-word would reach the next turn.
 */
const draft = ref(app.config?.instructions ?? "")
const savedInstructions = computed(() => app.config?.instructions ?? "")
// As in MiMo: saving keeps the trimmed text, so only a change past whitespace counts.
const dirty = computed(() => draft.value.trim() !== savedInstructions.value.trim())
const ciHelpOpen = ref(false)

watch(savedInstructions, (next: string) => {
  if (!dirty.value) draft.value = next
})

async function saveInstructions() {
  const text = draft.value.trim()
  await app.patchConfig({ instructions: text })
  draft.value = text
  notify(t("set.instructionsSaved"))
}

/* This app's own files, and the open project's instruction files. */
const paths = ref<AppPaths>()

async function loadPaths() {
  paths.value = await app.client
    ?.request({ type: "app.paths", directory: app.current?.directory ?? app.config?.directory })
    .then((result) => result.paths)
    .catch(() => undefined)
}

/* The file the models page names as where providers and their models are kept. */
const configFile = computed(() => paths.value?.files.find((file) => file.name === "config.json"))

/*
 * MiMo's 配置 page: the config file, and the global AGENTS.md with its state -
 * read into every conversation, switched off, or not written - and what can be
 * done with it from each state.
 */
const agents = ref<{ path: string; state: AgentsFileState }>()
const confirmingAgentsDelete = ref(false)

function reasonText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/* MiMo 26.920's 复制路径 and 打开 on the config file row. */
async function copyConfigPath() {
  const target = configFile.value?.path
  if (!target) return
  try {
    await writeText(target)
    notify(t("set.config.pathCopied"), { level: "success" })
  } catch {
    notifyFailure(t("set.config.copyPathFailed"))
  }
}

async function openConfigFile() {
  const target = configFile.value?.path
  if (!target) return
  const cut = Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\"))
  const failure = await window.mcode.openFile(target.slice(0, cut), target.slice(cut + 1))
  if (failure) notifyFailure(failure)
}

/*
 * MiMo 26.920's 技能兼容路径: this app's own folders always, and the other
 * tools' folders each behind a switch, `.agents` on unless turned off.
 */
const skillPathRows = computed(() => {
  const compat = skillPathCompat(app.config?.skillPaths)
  const storage = paths.value?.storage
  const own = storage ? homePath(`${storage}${storage.includes("\\") ? "\\" : "/"}skills`, paths.value?.home) : ""
  return [
    { id: "mcode" as const, title: t("set.skillPaths.mcode"), global: own, project: ".mcode/skills", on: true },
    ...(["agents", "claude", "codex", "opencode"] as const).map((id) => ({
      id,
      title: t(`set.skillPaths.${id}`),
      global: `~/.${id}/skills`,
      project: `.${id}/skills`,
      on: compat[id],
    })),
  ]
})

function switchSkillPath(id: SkillPathSource) {
  const compat = skillPathCompat(app.config?.skillPaths)
  void app.patchConfig({ skillPaths: { ...compat, [id]: !compat[id] } })
}

/* 开机自启: read from main, which asks the OS; a change shows what the OS then says. */
const loginItem = ref({ supported: false, enabled: false })

async function loadLoginItem() {
  loginItem.value = await window.mcode.launchAtLogin().catch(() => ({ supported: false, enabled: false }))
}

async function switchLaunchAtLogin() {
  const wanted = !loginItem.value.enabled
  loginItem.value = { ...loginItem.value, enabled: wanted }
  const result = await window.mcode.setLaunchAtLogin(wanted).catch(() => ({ ok: false, enabled: !wanted }))
  loginItem.value = { ...loginItem.value, enabled: result.enabled }
}

async function loadAgents() {
  agents.value = await app.client?.request({ type: "agents.state" }).catch(() => undefined)
}

async function openAgents() {
  try {
    const result = await app.client?.request({ type: "agents.ensure" })
    if (!result) return
    agents.value = result
    const cut = Math.max(result.path.lastIndexOf("/"), result.path.lastIndexOf("\\"))
    const failure = await window.mcode.openFile(result.path.slice(0, cut), result.path.slice(cut + 1))
    if (failure) notifyFailure(t("set.agents.openFailed") + failure)
  } catch (err) {
    notifyFailure(t("set.agents.openFailed") + reasonText(err))
  }
}

async function switchAgents(enabled: boolean) {
  const client = app.client
  if (!client) {
    notifyFailure(t("set.agents.toggleFailed") + t("common.requestFailed"))
    return
  }
  try {
    const result = await client.request({ type: "agents.setEnabled", enabled })
    if (!result) {
      notifyFailure(t("set.agents.toggleFailed") + t("common.requestFailed"))
      return
    }
    agents.value = result
  } catch (err) {
    notifyFailure(t("set.agents.toggleFailed") + reasonText(err))
  }
}

async function removeAgents() {
  confirmingAgentsDelete.value = false
  try {
    agents.value = await app.client?.request({ type: "agents.delete" })
  } catch (err) {
    notifyFailure(t("set.agents.deleteFailed") + reasonText(err))
  }
}

/*
 * MiMo's MCP 服务器 page. The servers live in the config's mcpServers, so the
 * page edits that map through patchConfig and the backend reconnects to match;
 * each server's status comes from the store, which follows the backend's events.
 */
/* `saved` marks a row whose value is stored but not sent back; blank keeps it, as MiMo's form does. */
interface McpPair {
  key: string
  value: string
  saved?: boolean
}

interface McpForm {
  name: string
  type: "stdio" | "http"
  command: string
  url: string
  args: string[]
  env: McpPair[]
  headers: McpPair[]
}

const MCP_KINDS = ["stdio", "http"] as const
const MCP_EXAMPLE = `{
  "mcpServers": {
    "filesystem": {
      "type": "local",
      "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."],
      "enabled": true
    },
    "my-remote": {
      "type": "remote",
      "url": "https://example.com/mcp",
      "enabled": true
    }
  }
}`

const mcpView = ref<"list" | "form" | "import">("list")
const mcpEditing = ref<string>()
const mcpForm = ref<McpForm>(blankMcpForm())
const mcpRevealed = ref<Record<string, boolean>>({})
const mcpToolsOpen = ref<string>()
/** The server whose 授权 sign-in is under way. */
const mcpAuthorizing = ref<string>()
const mcpTools = ref<Record<string, "loading" | { tools?: McpToolInfo[]; error?: string }>>({})

function blankMcpForm(): McpForm {
  return { name: "", type: "stdio", command: "", url: "", args: [], env: [], headers: [] }
}

/*
 * MiMo's status pass: read the report, and connect now any server switched on
 * in the config that the report does not know yet - one added since the
 * servers were last read. Every other saved change waits for the next
 * conversation. Counted, so overlapping passes keep 检测中… until the last ends.
 */
const mcpChecking = ref(0)
/* N11-27: a saved MCP change still waiting for the next conversation, and what 现在应用 last said. */
const mcpUnapplied = ref(false)
const mcpApply = ref<"idle" | "doing" | "done" | "busy" | "failed">("idle")

async function applyMcpNow() {
  const client = app.client
  if (!client || mcpApply.value === "doing") return
  mcpApply.value = "doing"
  const result = await client.request({ type: "mcp.applyNow" }).catch(() => undefined)
  if (!result) {
    mcpApply.value = "failed"
    return
  }
  app.mcpServers = result.servers
  mcpApply.value = result.outcome === "nothing" ? "done" : result.outcome
  if (result.outcome === "done" || result.outcome === "nothing") mcpUnapplied.value = false
}

async function refreshMcp() {
  const client = app.client
  if (!client) return
  mcpChecking.value++
  try {
    const listed = await client.request({ type: "mcp.list" }).catch(() => undefined)
    let servers = listed?.servers
    if (!servers) return
    mcpUnapplied.value = listed?.unapplied === true
    if (!mcpUnapplied.value && mcpApply.value !== "done") mcpApply.value = "idle"
    const known = new Set(servers.map((server) => server.name))
    const missing = Object.entries(app.config?.mcpServers ?? {})
      .filter(([name, entry]) => entry.enabled !== false && !known.has(name))
      .map(([name]) => name)
    const registered = await Promise.all(missing.map((name) => client.request({ type: "mcp.register", name }).catch(() => undefined)))
    for (const result of registered) if (result) servers = result.servers
    app.mcpServers = servers
  } finally {
    mcpChecking.value--
  }
}

/*
 * MiMo's pills: 已禁用 when off; 检测中… on every enabled server while a status
 * pass runs; its known states by name; anything the report does not know 未知.
 */
const mcpRows = computed(() =>
  // In the config's own order, as MiMo lists them.
  Object.entries(app.config?.mcpServers ?? {}).map(([name, entry]) => {
    const state = app.mcpServers.find((server) => server.name === name)
    const enabled = entry.enabled !== false
    const status: McpStatus | "checking" | "unknown" = !enabled
      ? "disabled"
      : mcpChecking.value
        ? "checking"
        : state && isMcpStatus(state.status)
          ? state.status
          : "unknown"
    return {
      name,
      remote: entry.type === "remote",
      enabled,
      status,
      tone: isMcpStatus(status) ? MCP_STATUS_TONE[status] : "muted",
      label: isMcpStatus(status) ? mcpStatusLabel(status) : status,
      error: state?.error,
    }
  }),
)

/* Keys are trimmed; a header's value is too, an environment variable's is kept as typed - as MiMo's form saves them. */
function recordOf(rows: McpPair[], trimValues = false): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const row of rows) if (row.key.trim()) out[row.key.trim()] = trimValues ? row.value.trim() : row.value
  return Object.keys(out).length ? out : undefined
}

/* As MiMo's edit does, stored values come back blank and flagged as saved rather than readable. */
function rowsOf(record?: Record<string, string>): McpPair[] {
  return Object.keys(record ?? {}).map((key) => ({ key, value: "", saved: true }))
}

/* The saved rows left blank, whose stored values the server keeps. */
function keptOf(rows: McpPair[]): string[] {
  return rows.filter((row) => row.saved && row.key.trim() && row.value === "").map((row) => row.key.trim())
}

function httpURL(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

const mcpFormError = computed(() => {
  const form = mcpForm.value
  if (!form.name.trim()) return "set.mcpForm.errNeedName"
  if (form.type === "stdio" && !form.command.trim()) return "set.mcpForm.errNeedCommand"
  if (form.type === "http" && !form.url.trim()) return "set.mcpForm.errNeedUrl"
  if (form.type === "http" && !httpURL(form.url.trim())) return "set.mcpForm.errBadUrl"
  return undefined
})

function addMcp() {
  mcpEditing.value = undefined
  mcpForm.value = blankMcpForm()
  mcpRevealed.value = {}
  mcpView.value = "form"
}

function editMcp(name: string) {
  const entry = app.config?.mcpServers?.[name]
  if (!entry) {
    notifyFailure(t("set.mcp.editFailed"))
    return
  }
  const [command, ...args] = entry.command ?? []
  mcpForm.value = {
    name,
    type: entry.type === "remote" ? "http" : "stdio",
    // The program alone, as stored: the field is never split into words.
    command: command ?? "",
    url: entry.url ?? "",
    args,
    env: rowsOf(entry.environment),
    headers: rowsOf(entry.headers),
  }
  mcpEditing.value = name
  mcpRevealed.value = {}
  mcpView.value = "form"
}

async function saveMcp() {
  const form = mcpForm.value
  if (mcpFormError.value) {
    notifyFailure(t(mcpFormError.value))
    return
  }
  const name = form.name.trim()
  const entry: McpServerConfig =
    form.type === "http"
      ? { type: "remote", url: form.url.trim(), headers: recordOf(form.headers, true) }
      : {
          type: "local",
          command: [form.command.trim(), ...form.args.map((arg) => arg.trim()).filter(Boolean)],
          environment: recordOf(form.env),
        }
  // An edit keeps the server as switched on or off as it was.
  if (app.config?.mcpServers?.[name]?.enabled === false) entry.enabled = false
  try {
    // Saved rows left blank keep their stored values; the server fills them in, as the window never had them.
    const keep = { env: keptOf(form.env), headers: keptOf(form.headers) }
    const result = await app.client?.request({ type: "mcp.save", name, entry, keep })
    if (!result) throw new Error("not connected")
    app.config = result.config
  } catch (err) {
    // As MiMo's form: the reason when there is one (a config file that no longer parses says where), else the plain failure.
    notifyFailure(err instanceof Error && err.message ? err.message : t("set.mcpForm.saveFailed"))
    return
  }
  delete mcpTools.value[name]
  notify(t("set.mcpForm.saved", { name }), { level: "success" })
  mcpView.value = "list"
  void refreshMcp()
}

async function setMcpEnabled(name: string, enabled: boolean) {
  const entry = app.config?.mcpServers?.[name]
  if (!entry) return
  try {
    await app.patchConfig({ mcpServers: { ...(app.config?.mcpServers ?? {}), [name]: { ...entry, enabled } } }, { quiet: true })
  } catch (err) {
    notifyFailure(t("set.mcp.toggleFailed"), reasonText(err))
  }
  delete mcpTools.value[name]
  void refreshMcp()
}

/*
 * OpenCode v2's Code Mode, per server (R31-11): its tools are called from a
 * script the model writes rather than one by one. MiMo has no such switch, so
 * it sits inside the server's tools panel, not on the list MiMo draws.
 */
const codeModeOf = (name: string) => app.config?.mcpServers?.[name]?.codemode === true

async function setMcpCodeMode(name: string, on: boolean) {
  const entry = app.config?.mcpServers?.[name]
  if (!entry) return
  const { codemode: _dropped, ...rest } = entry
  try {
    await app.patchConfig({ mcpServers: { ...(app.config?.mcpServers ?? {}), [name]: on ? { ...entry, codemode: true } : rest } }, { quiet: true })
  } catch (err) {
    notifyFailure(t("set.mcp.toggleFailed"), reasonText(err))
  }
}

/* MiMo's 授权 on a remote server that answered 401: the browser sign-in, then the row reconnects. */
async function authorizeMcp(name: string) {
  if (mcpAuthorizing.value) return
  mcpAuthorizing.value = name
  notify(t("set.mcp.authorizing"))
  try {
    await app.client?.request({ type: "mcp.authenticate", name })
    notify(t("set.mcp.authorized"), { level: "success" })
  } catch (err) {
    notifyFailure(t("set.mcp.authorizeFailed") + (err instanceof Error ? err.message : String(err)))
  } finally {
    mcpAuthorizing.value = undefined
    delete mcpTools.value[name]
    void refreshMcp()
  }
}

/* As in MiMo, removing asks nothing and says what went. */
async function removeMcp(name: string) {
  const servers = { ...(app.config?.mcpServers ?? {}) }
  delete servers[name]
  try {
    await app.patchConfig({ mcpServers: servers }, { quiet: true })
  } catch (err) {
    notifyFailure(reasonText(err))
    return
  }
  if (mcpToolsOpen.value === name) mcpToolsOpen.value = undefined
  delete mcpTools.value[name]
  notify(t("set.mcp.removed") + name, { level: "success" })
  void refreshMcp()
}

async function loadMcpTools(name: string) {
  mcpTools.value = { ...mcpTools.value, [name]: "loading" }
  const result = await app.client
    ?.request({ type: "mcp.tools", name })
    .catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }))
  mcpTools.value = { ...mcpTools.value, [name]: result ?? { error: "" } }
}

function toggleMcpTools(name: string) {
  if (mcpToolsOpen.value === name) {
    mcpToolsOpen.value = undefined
    return
  }
  mcpToolsOpen.value = name
  if (!mcpTools.value[name]) void loadMcpTools(name)
}

/*
 * MiMo's 从其他工具导入: scan Claude Code, Kiro and Codex, list what they have
 * by source with everything not already here switched on, and add the picks.
 */
const MCP_IMPORT_SOURCES: { id: McpImportSource; label: string }[] = [
  { id: "claude", label: "Claude Code" },
  { id: "kiro", label: "Kiro" },
  { id: "codex", label: "Codex" },
]
const mcpImports = ref<McpImportItem[]>([])
const mcpImportPicked = ref<Set<string>>(new Set())
const mcpScanning = ref(false)
const mcpImporting = ref(false)

function importKey(item: { source: string; name: string }): string {
  return `${item.source}:${item.name}`
}

const mcpImportChosen = computed(() =>
  mcpImports.value.filter((item) => !item.exists && mcpImportPicked.value.has(importKey(item))),
)

async function startMcpImport() {
  if (mcpScanning.value) return
  mcpScanning.value = true
  try {
    const result = await app.client?.request({ type: "mcp.importScan" }).catch(() => undefined)
    mcpImports.value = result?.items ?? []
    mcpImportPicked.value = new Set(mcpImports.value.filter((item) => !item.exists).map(importKey))
    mcpView.value = "import"
  } finally {
    mcpScanning.value = false
  }
}

function pickMcpImport(item: McpImportItem) {
  const next = new Set(mcpImportPicked.value)
  if (next.has(importKey(item))) next.delete(importKey(item))
  else next.add(importKey(item))
  mcpImportPicked.value = next
}

async function finishMcpImport() {
  if (mcpImporting.value || !mcpImportChosen.value.length) return
  mcpImporting.value = true
  try {
    const items = mcpImportChosen.value.map(({ source, name }) => ({ source, name }))
    const result = await app.client?.request({ type: "mcp.importApply", items })
    notify(t("set.mcp.importDone", { n: String(result?.imported.length ?? 0) }), { level: "success" })
    mcpView.value = "list"
    void refreshMcp()
  } catch (err) {
    notifyFailure(t("set.mcp.importFailed") + (err instanceof Error ? err.message : String(err)))
  } finally {
    mcpImporting.value = false
  }
}

/* What the tools panel shows for a server: loading, why it failed, nothing, or the list. */
function mcpToolsView(name: string) {
  const entry = mcpTools.value[name]
  if (!entry || entry === "loading") return { kind: "loading", tools: [] as McpToolInfo[], error: "" }
  // The server's own reason, from the page's own probe, as MiMo shows it.
  if (entry.error !== undefined) return { kind: "error", tools: [] as McpToolInfo[], error: entry.error }
  const tools = entry.tools ?? []
  return { kind: tools.length ? "list" : "empty", tools, error: "" }
}

/*
 * Money in the reader's own locale, always in dollars - the figures the
 * providers report are dollars, and relabelling them in another currency
 * would change what they say without changing what they are. The same
 * reasoning the session header's readout is built on.
 */
const money = computed(
  () => new Intl.NumberFormat(language.value, { style: "currency", currency: "USD" }),
)

/* What has been spent, gathered by the server from every turn on disk. */
const usage = ref<UsageSummary>()

async function loadUsage() {
  usage.value = await app.client
    ?.request({ type: "usage.summary", days: 14 })
    .then((result) => result.summary)
    .catch(() => undefined)
}

/*
 * A spend with no price behind it reads as a dash, not as $0.00: the catalog
 * had no price for the models it went to.
 */
function spent(bucket: { usage: { cost: number }; priced: number; unpriced: number } | undefined): string {
  if (bucket && !bucket.priced && bucket.unpriced) return "—"
  return money.value.format(bucket?.usage.cost ?? 0)
}

/* The widest day sets the scale, so the bars mean something next to each other. */
const busiestDay = computed(() =>
  Math.max(1, ...(usage.value?.byDay ?? []).map((day) => day.usage.input + day.usage.output)),
)

/*
 * The environment page, laid out as MiMo's: the projects, each of which can be
 * configured or removed, then every worktree those projects have beyond their
 * main checkout. It lists the stored project list in its own order, newest
 * added first, as MiMo's page does; adding and removing change only the list.
 */
const envProjects = computed(() => listedProjects(app.config))

const removingProject = ref<string>()
/** The project whose environment is open, or none for the list. */
const configuring = ref<string>()
const envName = ref("")
const envDirty = computed(
  () => Boolean(configuring.value) && envName.value.trim() !== (app.config?.projectNames?.[configuring.value ?? ""] ?? ""),
)

async function addProject() {
  const [directory] = await pickProjectFolder(t("dialog.pickProjectFolder"), false)
  if (!directory) return
  // MiMo's add with activate off: listed, nothing opened, no conversation made.
  await app.addProject(directory, { switched: false })
  void loadTrees()
}

async function removeProject() {
  const directory = removingProject.value
  removingProject.value = undefined
  if (!directory) return
  await app.removeProjects([directory])
  void loadTrees()
}

function configure(directory: string) {
  configuring.value = directory
  envName.value = app.config?.projectNames?.[directory] ?? ""
}

/*
 * The name is the project's display name, the same one renaming it in the side
 * column sets. MiMo's rules: a blank name, or the current one, renames nothing;
 * a name another project already shows renames nothing either, and says so in
 * an ordinary notice - MiMo has saved the rest of the page by then, so it is
 * not a failure.
 */
async function saveEnv() {
  const directory = configuring.value
  if (!directory) return
  const name = envName.value.trim()
  const current = projectName(directory, app.config?.projectNames)
  if (!name || name === current) {
    envName.value = app.config?.projectNames?.[directory] ?? ""
    notify(t("set.envSaved"))
    return
  }
  const taken = envProjects.value.some(
    (other) => other !== directory && projectName(other, app.config?.projectNames) === name,
  )
  if (taken) {
    notify(t("set.envSavedNameTaken", { name }))
    return
  }
  await app.patchConfig({ projectNames: { ...(app.config?.projectNames ?? {}), [directory]: name } })
  notify(t("set.envSaved"))
}

interface TreeRow {
  directory: string
  name: string
  branch?: string
  /** The project's folder; its name is looked up when drawn, so a rename shows at once. */
  project: string
}

/* Every project's worktrees beyond its main checkout, each listed once. */
const trees = ref<TreeRow[]>([])
const treesLoaded = ref(false)

async function loadTrees() {
  const lists = await Promise.all(
    envProjects.value.map(async (directory) => {
      const listed = await app.client?.request({ type: "workspace.list", directory }).catch(() => undefined)
      return (listed?.worktrees ?? [])
        .filter((tree) => !tree.main)
        .map((tree) => ({
          directory: tree.directory,
          name: folderName(tree.directory),
          branch: tree.branch,
          project: directory,
        }))
    }),
  )
  const seen = new Set<string>()
  trees.value = lists.flat().filter((row) => !seen.has(row.directory) && Boolean(seen.add(row.directory)))
  treesLoaded.value = true
}

async function refreshTrees() {
  await loadTrees()
  notify(t("set.worktreesRefreshed"))
}

/*
 * Loaded when the page is opened rather than when the dialog is, because both
 * answers are about the disk and both go stale while the dialog sits open.
 */
watch(
  section,
  (next: Section) => {
    if (next === "files" || next === "mcp") void loadPaths()
    if (next === "files") void loadAgents()
    if (next === "general") void loadLoginItem()
    if (next !== "mcp") mcpView.value = "list"
    else void refreshMcp()
    if (next === "environment") void loadTrees()
    else configuring.value = undefined
    if (next === "usage") void loadUsage()
  },
  { immediate: true },
)

/* Spoken input: how it is written down, and by which model. */
const voiceModes = computed(() => [
  { value: "smart", label: t("set.voiceModeSmart") },
  { value: "fast", label: t("set.voiceModeFast") },
])

/*
 * Every model the connected providers offer, plus "not set" at the top.
 *
 * Not filtered to the ones that can hear: nothing in a provider's catalogue
 * says whether a model transcribes, and a picker that guessed would hide the
 * right answer on the machines where it guessed wrong.
 */
/*
 * As MiMo asks: a misheard "send" hands the agent a message nobody meant, so
 * turning the switch on takes a confirmation; turning it off does not.
 */
const confirmingVoiceSend = ref(false)
const confirmingWatermark = ref(false)
const watermarkSaving = ref(false)

async function setWatermarkRemoval(remove: boolean) {
  if (watermarkSaving.value) return
  watermarkSaving.value = true
  try {
    await app.patchConfig({ removeExplicitWatermark: remove })
    confirmingWatermark.value = false
  } finally {
    watermarkSaving.value = false
  }
}

function toggleWatermarkRemoval() {
  if (watermarkSaving.value) return
  if (app.config?.removeExplicitWatermark) void setWatermarkRemoval(false)
  else confirmingWatermark.value = true
}

function toggleVoiceSend() {
  if (app.config?.voiceSend) void app.patchConfig({ voiceSend: false })
  else confirmingVoiceSend.value = true
}

async function enableVoiceSend() {
  confirmingVoiceSend.value = false
  await app.patchConfig({ voiceSend: true })
}

const voiceModelOptions = computed(() => [
  { value: "", label: t("set.voiceModelNone") },
  /*
   * The engine on this machine. A provider row is only a transcription model
   * when the endpoint actually offers /audio/transcriptions - a chat-only
   * local server answers the model list but nothing else, and that is what the
   * precheck reports as asrUnavailable. This row is the setup that always
   * works, so it sits first.
   */
  { value: "local/base", label: t("set.voiceModelLocal") },
  ...app.providers
    .filter((provider) => provider.configured)
    .flatMap((provider) =>
      provider.models.map((model) => ({
        value: `${provider.id}/${model.id}`,
        label: `${provider.name} · ${model.name || model.id}`,
      })),
    ),
])

const voiceModelValue = computed(() => {
  const chosen = app.config?.voiceModel
  return chosen?.provider && chosen.model ? `${chosen.provider}/${chosen.model}` : ""
})

function setVoiceModel(value: string) {
  if (!value) {
    void app.patchConfig({ voiceModel: undefined })
    return
  }
  const cut = value.indexOf("/")
  void app.patchConfig({
    voiceModel: { provider: value.slice(0, cut), model: value.slice(cut + 1) },
  })
}

/* The colourways the mark comes in, drawn from the one module that defines them. */
const appIcon = computed(() => app.config?.appIcon ?? DEFAULT_APP_ICON)

/* MiMo's icon pick: the window wears it first, and only an icon that took is kept and said. */
async function chooseAppIcon(id: string) {
  if (id === appIcon.value) return
  const result = await window.mcode.appIcon(id).catch(() => ({ ok: false }))
  if (!result.ok) {
    notifyFailure(t("set.appIconApplyFail"))
    return
  }
  try {
    await app.patchConfig({ appIcon: id })
  } catch {
    // Not saved: the window goes back to the icon the config still names.
    void window.mcode.appIcon(appIcon.value)
    return
  }
  notify(t("set.appIconApplied"), { level: "success" })
}

/*
 * MiMo's 显示服务器 (Linux only). The main process keeps the choice and reads
 * it at launch, so a change is only saved here and takes a restart.
 */
const displayServer = ref<Awaited<ReturnType<typeof window.mcode.displayServer>>>({
  supported: false,
  pref: "auto",
  effective: null,
})
if (app.platform === "linux") {
  void window.mcode
    .displayServer()
    .then((state) => (displayServer.value = state))
    .catch(() => {})
}
const displayServerOptions = computed(() => [
  { value: "auto", label: t("set.dsAuto") },
  { value: "wayland", label: t("set.dsWayland") },
  { value: "x11", label: t("set.dsX11") },
])
const displayServerSub = computed(() =>
  displayServer.value.pref === "auto"
    ? `${t("set.displayServerSub")} · ${t(displayServer.value.effective === "wayland" ? "set.dsCurrentWayland" : "set.dsCurrentX11")}`
    : t("set.displayServerSub"),
)

async function chooseDisplayServer(value: string) {
  const pref = value === "wayland" || value === "x11" ? value : "auto"
  if (pref === displayServer.value.pref) return
  displayServer.value = { ...displayServer.value, pref }
  try {
    await window.mcode.setDisplayServer(pref)
  } catch {
    // MiMo says it either way; the next launch reads whatever was written.
  }
  notify(t("set.displayServerSaved"))
}

/*
 * MiMo's 硬件加速: saved for the main process to read before the next launch is
 * ready (Chromium takes it only then), so a change says a restart applies it -
 * the same line 显示服务器 uses.
 */
const hardwareAcceleration = ref(true)
void window.mcode
  .hardwareAcceleration()
  .then((state) => (hardwareAcceleration.value = state.enabled))
  .catch(() => {})

async function toggleHardwareAcceleration() {
  const enabled = !hardwareAcceleration.value
  hardwareAcceleration.value = enabled
  try {
    await window.mcode.setHardwareAcceleration(enabled)
  } catch {
    // MiMo says it either way; the next launch reads whatever was written.
  }
  notify(t("set.displayServerSaved"))
}

/*
 * The gallery's tiles: each colourway's own file, the one the window and the
 * taskbar are handed, so the tile pressed is the icon received. Every one is
 * generated from the painted mark by scripts/icons.mjs.
 */
const ICON_FILES = import.meta.glob<string>("@resources/app-icons/*.png", { eager: true, query: "?url", import: "default" })
const iconFile = (id: string) => Object.entries(ICON_FILES).find(([file]) => file.endsWith(`/${id}.png`))?.[1] ?? ""
const iconTiles = APP_ICONS.map((spec) => ({ spec, image: iconFile(spec.id) }))

/* The segments each of the two appearance choices offers, in the order shown. */
const MOTION_MODES = ["system", "on", "off"] as const
const DIFF_MARKS = ["color", "signs"] as const

/*
 * The column's search, after MiMo's: narrows the entries to those whose name
 * matches, and Enter opens the first of them. Focus no longer lands here on
 * opening: MiMo focuses the dialog itself (see dialogEl below).
 */
const navQuery = ref("")
const NAV_LABELS: Record<Section, string> = {
  general: "set.nav.general",
  usage: "set.nav.usage",
  appearance: "set.appearance",
  files: "set.nav.files",
  models: "set.models",
  personal: "set.personal",
  keys: "set.shortcuts",
  mcp: "set.nav.mcp",
  environment: "set.environment",
  lab: "set.nav.lab",
  archive: "set.nav.archive",
  updates: "set.nav.updates",
}

/* MiMo matches a page by its name or by the words listed for it, so 托盘 finds 常规 (lib/word-match.ts). */
const NAV_KEYWORDS: Record<Section, string> = {
  general: "set.keywords.general",
  usage: "set.keywords.usage",
  appearance: "set.keywords.appearance",
  files: "set.keywords.files",
  models: "set.keywords.models",
  personal: "set.keywords.personal",
  keys: "set.keywords.keys",
  mcp: "set.keywords.mcp",
  environment: "set.keywords.environment",
  lab: "set.keywords.lab",
  archive: "set.keywords.archive",
  updates: "set.keywords.updates",
}

function navShows(entry: Section): boolean {
  const query = navQuery.value
  return wordMatch(t(NAV_LABELS[entry]), query) || wordMatch(t(NAV_KEYWORDS[entry]), query)
}

const navMatches = computed(() => (Object.keys(NAV_LABELS) as Section[]).filter(navShows))

function openFirstMatch() {
  const first = navMatches.value[0]
  if (first) section.value = first
}

/* MiMo's search jumps while typing: off a page the query no longer matches, onto the first that does. */
watch(navQuery, (query) => {
  if (!query.trim()) return
  const matches = navMatches.value
  if (matches.length && !matches.includes(section.value)) section.value = matches[0]
  else void flashMatch(query)
})

/*
 * MiMo's highlight: two frames after the page draws, the first row whose text
 * (title, description or control) reads the query scrolls to the middle and holds the selected fill
 * for 1.6s while it fades. Reduced motion gets the fill without the fade.
 */
const contentEl = ref<HTMLElement>()
let flashTimer: number | undefined

async function flashMatch(query: string) {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return
  await nextTick()
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  const root = contentEl.value
  if (!root) return
  // A whole row's text, as MiMo reads it: the title, the description under it and its controls' labels.
  const hit = [...root.querySelectorAll<HTMLElement>(".line, .choice-btn, h3")].find((element) =>
    (element.textContent ?? "").toLocaleLowerCase().includes(needle),
  )
  if (!hit) return
  const target = hit.closest<HTMLElement>(".line") ?? hit
  const motion = document.documentElement.getAttribute("data-motion")
  const reduced = motion === "on" || (motion !== "off" && window.matchMedia("(prefers-reduced-motion: reduce)").matches)
  target.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" })
  for (const element of root.querySelectorAll(".sr-hit")) element.classList.remove("sr-hit")
  target.classList.add("sr-hit")
  if (flashTimer) window.clearTimeout(flashTimer)
  flashTimer = window.setTimeout(() => target.classList.remove("sr-hit"), 1600)
}

/* MiMo's 用法详情 for 智能编辑. */
const voiceUsageOpen = ref(false)
const licensesOpen = ref(false)

/*
 * MiMo's guard on an environment with unsaved edits: every way out - the
 * navigation, the search's jump, the back button, close, Escape and the scrim -
 * asks first, and 离开 discards the edits and does what was asked.
 */
const pendingLeave = ref<() => void>()

function requestLeave(action: () => void) {
  if (!envDirty.value) {
    action()
    return
  }
  pendingLeave.value = action
}

function confirmLeave() {
  const action = pendingLeave.value
  pendingLeave.value = undefined
  // Discarded first, so the action runs past a guard that no longer has anything to protect.
  envName.value = app.config?.projectNames?.[configuring.value ?? ""] ?? ""
  action?.()
}

function leaveEnvironment() {
  requestLeave(() => {
    configuring.value = undefined
  })
}

/*
 * MiMo's close: the overlay keeps rendering for its .12s fade before it goes.
 * Reduced motion has no fade to wait for.
 */
const closing = ref(false)

function reducedMotion(): boolean {
  const motion = document.documentElement.getAttribute("data-motion")
  return motion === "on" || (motion !== "off" && window.matchMedia("(prefers-reduced-motion: reduce)").matches)
}

/* Closes at once for a command that runs over Settings (MiMo's new task), still asking about unsaved edits first. */
function leaveThen(action: () => void) {
  requestLeave(() => {
    emit("close")
    action()
  })
}

defineExpose({ leaveThen })

function requestClose() {
  requestLeave(() => {
    if (closing.value) return
    if (reducedMotion()) {
      emit("close")
      return
    }
    closing.value = true
    window.setTimeout(() => emit("close"), 120)
  })
}

/*
 * MiMo focuses the dialog itself on open rather than a field, so a typed
 * character does not land in the search and the search shows no focus ring.
 * This reverses MCode's earlier choice of focusing the nav search.
 */
const dialogEl = ref<HTMLElement>()
/* MiMo lights a hovered nav row only after the pointer has moved in the column. */
const pointerMoved = ref(false)

onMounted(() => dialogEl.value?.focus())

/*
 * The nav list scrolls, so the selected row can sit below its fold - opened
 * straight onto 应用更新, or chosen from the search. As MiMo's: two frames after
 * the column draws, the selected row is brought just inside the list with 8 to
 * spare, and nothing moves when it is already in view.
 */
const navScrollEl = ref<HTMLElement>()

function revealSelectedNav() {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const list = navScrollEl.value
      const row = list?.querySelector<HTMLElement>(".nav-item.on")
      if (!list || !row || !row.offsetParent) return
      const top = row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop
      const target = revealScrollTop(list.scrollTop, list.clientHeight, top, row.offsetHeight)
      if (target === undefined) return
      list.scrollTo({ top: target, behavior: reducedMotion() ? "auto" : "smooth" })
    }),
  )
}

onMounted(revealSelectedNav)
watch([currentSection, navQuery], revealSelectedNav)

const saved = ref<string>()

/**
 * Recording a new chord for one command.
 *
 * The listener is on the window in the capture phase so the keystroke never
 * reaches the app underneath - otherwise pressing Ctrl+W to record it would
 * close the tab while recording.
 */
/* MiMo's ranges for the two size rows: UI 10-24, code 9-24. */
const SIZE_RANGE = { uiFontSize: [10, 24], codeFontSize: [9, 24] } as const

/* As MiMo does, every keystroke that makes a whole in-range number resizes the interface live. */
function typeSize(field: "uiFontSize" | "codeFontSize", event: Event) {
  const text = (event.target as HTMLInputElement).value.trim()
  const value = Number(text)
  const [min, max] = SIZE_RANGE[field]
  if (!/^\d+$/.test(text) || value < min || value > max) return
  if (value !== app.config?.[field]) void app.patchConfig({ [field]: value })
}

/*
 * MiMo's normalisation when the field is left: not a number or not above zero
 * goes back to the base size; anything else is rounded and clamped.
 */
function setSize(field: "uiFontSize" | "codeFontSize", event: Event, base: number) {
  const input = event.target as HTMLInputElement
  const typed = Number(input.value.trim())
  const [min, max] = SIZE_RANGE[field]
  const value = !input.value.trim() || !Number.isFinite(typed) || typed <= 0 ? base : Math.round(Math.min(max, Math.max(min, typed)))
  input.value = String(value)
  if (value !== app.config?.[field]) void app.patchConfig({ [field]: value })
}

/**
 * The chord a row answers to: the user's if they set one, else the built-in.
 * An empty string saved for a command means its built-in chord was deleted.
 */
function boundKeys(shortcut: { id: string; hint?: string }) {
  const binds = app.config?.keybinds ?? {}
  return shortcut.id in binds ? binds[shortcut.id] : shortcut.hint || ""
}

/** Whether the user has changed this command's chord - set or deleted - so it can be reset. */
function customBinding(command: string) {
  return command in (app.config?.keybinds ?? {})
}

/*
 * MiMo's recording: the pencil turns the binding into a pulsing box that takes
 * the next chord pressed; 确认 saves it, 取消 or a press outside the row drops
 * it, and a chord another command already answers to is refused in red with no
 * 确认. Every command is checked, including those this page does not list,
 * because a hidden command's chord is just as live.
 */
const recording = ref<string>()
const recordChord = ref<string>()

const recordConflict = computed(() => {
  const chord = recordChord.value
  if (!chord || !recording.value) return undefined
  return props.commands.find((entry) => entry.id !== recording.value && boundKeys(entry) === chord)
})

/* A conflicting command is named the way the page names it, or by its own title off the page. */
function commandLabel(command: { id: string; title: string }): string {
  return shortcutPage.value.find((row) => row.id === command.id)?.title ?? command.title
}

function onRecordKey(event: KeyboardEvent) {
  event.preventDefault()
  event.stopImmediatePropagation()
  if (event.key === "Escape") {
    cancelRecord()
    return
  }
  // Read by physical key, skipping composition; MiMo needs a modifier plus a key.
  const chord = chordOf(event, app.platform)
  if (isBindable(chord)) recordChord.value = chord
}

/* MiMo's one line for any shortcut write that fails. */
function saveKeybinds(next: Record<string, string>): Promise<void> {
  return app.patchConfig({ keybinds: next }).catch(() => {
    notifyFailure(t("set.keys.saveFailed"))
    throw new Error("keybinds not saved")
  })
}

function onRecordPress(event: MouseEvent) {
  const inside = (event.target as HTMLElement | null)?.closest(`[data-shortcut-id="${recording.value}"]`)
  if (!inside) cancelRecord()
}

function startRecord(command: string) {
  cancelRecord()
  recording.value = command
  recordChord.value = undefined
  recordingChord.value = true
  window.addEventListener("keydown", onRecordKey, true)
  document.addEventListener("mousedown", onRecordPress)
}

function cancelRecord() {
  window.removeEventListener("keydown", onRecordKey, true)
  document.removeEventListener("mousedown", onRecordPress)
  recording.value = undefined
  recordChord.value = undefined
  recordingChord.value = false
}

/* As MiMo does, a failed save keeps the recording open so the chord can be tried again. */
async function confirmRecord() {
  const command = recording.value
  const chord = recordChord.value
  if (!command || !chord || recordConflict.value) return
  try {
    await saveKeybinds({ ...(app.config?.keybinds ?? {}), [command]: chord })
    cancelRecord()
  } catch {
    /* already said */
  }
}

/* Deleting a built-in chord saves an empty one, so the default stops answering too. */
function deleteBinding(command: string) {
  void saveKeybinds({ ...(app.config?.keybinds ?? {}), [command]: "" }).catch(() => undefined)
}

function resetBinding(command: string) {
  const next = { ...(app.config?.keybinds ?? {}) }
  delete next[command]
  void saveKeybinds(next).catch(() => undefined)
}

async function resetAllBindings() {
  try {
    await saveKeybinds({})
    notify(t("set.keys.resetAllDone"))
  } catch {
    /* already said */
  }
}

/* MiMo's key search: while on, the next chord pressed is what the table is narrowed to; Escape clears it. */
const keySearch = ref(false)
const keySearchChord = ref<string>()

function onKeySearchKey(event: KeyboardEvent) {
  if (recording.value) return
  event.preventDefault()
  event.stopImmediatePropagation()
  if (event.key === "Escape") {
    keySearchChord.value = undefined
    return
  }
  const chord = chordOf(event, app.platform)
  if (chord) keySearchChord.value = chord
}

function toggleKeySearch() {
  keySearch.value = !keySearch.value
  keySearchChord.value = undefined
  keyFilter.value = ""
  if (keySearch.value) window.addEventListener("keydown", onKeySearchKey, true)
  else window.removeEventListener("keydown", onKeySearchKey, true)
}

watch(section, (next) => {
  if (next === "keys") return
  cancelRecord()
  if (keySearch.value) toggleKeySearch()
})

onBeforeUnmount(() => {
  cancelRecord()
  window.removeEventListener("keydown", onKeySearchKey, true)
})

/* MiMo's order and wording: 跟随系统, 浅色, 深色. */
const themeOptions = computed(() => [
  { value: "system", label: t("set.appearance.themeFollow") },
  { value: "light", label: t("set.appearance.themeLight") },
  { value: "dark", label: t("set.appearance.themeDark") },
])
const languageOptions = computed(() => LANGUAGES.map((entry) => ({ value: entry.id, label: entry.label })))

/**
 * Projects hidden with "Close project".
 *
 * They were recoverable only by picking the same folder again, which is not a
 * recovery path anyone finds - closing one looked like losing it. This sits
 * beside the archived sessions because it is the same kind of undo.
 */
const closedProjects = computed(() => app.config?.closedProjects ?? [])

async function reopenProject(directory: string) {
  await app.patchConfig({
    closedProjects: closedProjects.value.filter((entry) => entry !== directory),
  })
}

/* MiMo lists the newest-archived first; a session archived before the stamp existed falls back to its last update. */
const archived = computed(() =>
  app.sessions
    .filter((session) => session.archived)
    .sort((a, b) => (b.archivedAt ?? b.updated) - (a.archivedAt ?? a.updated)),
)

/* MiMo's row line: 已归档 · 项目「name」 · time, or without the project for a scratch task. */
function archivedDescription(session: { directory: string; updated: number; scratch?: boolean; group?: string }): string {
  const group = projectOf(session)
  const head = group
    ? t("set.archivedIn", { project: projectName(group, app.config?.projectNames) })
    : t("set.archivedPlain")
  return `${head} · ${ago(session.updated)}`
}

/*
 * MiMo's batch management for archived conversations: a toggle beside the
 * heading turns the rows into checkboxes, and a toolbar selects all or none,
 * counts the choice, and restores or deletes it together. Deleting - one or
 * many - is final, so it asks first in a dialog.
 */
const selecting = ref(false)
const picked = ref<string[]>([])
const pickedLive = computed(() => picked.value.filter((id) => archived.value.some((session) => session.id === id)))
const allPicked = computed(() => archived.value.length > 0 && pickedLive.value.length >= archived.value.length)

function stopSelecting() {
  selecting.value = false
  picked.value = []
}

function togglePick(sessionID: string) {
  picked.value = picked.value.includes(sessionID)
    ? picked.value.filter((entry) => entry !== sessionID)
    : [...picked.value, sessionID]
}

function toggleAllPicked() {
  picked.value = allPicked.value ? [] : archived.value.map((session) => session.id)
}

/* MiMo confirms a restore with one toast, and a batch with one counted toast rather than one each. */
async function restoreOne(sessionID: string) {
  await app.archive(sessionID, false)
  notify(t("toast.convoRestored"), { level: "success" })
}

async function restorePicked() {
  const ids = [...pickedLive.value]
  for (const sessionID of ids) await app.archive(sessionID, false)
  stopSelecting()
  // A batch is always counted, even a batch of one, as MiMo's unarchiveMany says it.
  if (ids.length) notify(t("toast.convosRestored", { n: ids.length }), { level: "success" })
}

/** What the delete dialog is about: one named conversation, or the selection. */
const confirmingDelete = ref<{ ids: string[]; title?: string }>()

async function confirmRemove() {
  const target = confirmingDelete.value
  confirmingDelete.value = undefined
  if (!target) return
  for (const sessionID of target.ids) await app.remove(sessionID)
  if (target.title === undefined) stopSelecting()
  // MiMo's delete notices are success-level, the same from here as from the side column.
  if (target.ids.length === 1) notify(t("toast.convoDeleted"), { level: "success" })
  else if (target.ids.length) notify(t("toast.convosDeleted", { n: target.ids.length }), { level: "success" })
}

// Nothing left to manage ends the selection, as the toggle disappears with the list.
watch(
  () => archived.value.length,
  (count) => {
    if (!count) stopSelecting()
  },
)

/*
 * Asked twice, not typed out.
 *
 * This used to want the app's name typed in before it would arm. The count
 * above it is what makes the action real - it says how many sessions go - and
 * having read that, a second deliberate click is the decision. Copying a word
 * out of a label adds a step without adding a thought, and it is the step
 * people learn to do without reading.
 */
/** What the shortcuts page is narrowed to by typing. */
const keyFilter = ref("")

/*
 * MiMo's fixed shortcut list, in its order, each row a label over a
 * description (see lib/shortcut-page). The per-theme, per-language and other
 * picker commands stay bindable from the palette but are off this page, as
 * the user chose.
 */
const shortcutPage = computed(() => pageRows(props.commands, t))

/** A chord as MiMo prints it on the key cap. */
function shownChord(chord: string): string {
  return formatChord(chord, app.platform)
}

/*
 * Narrowed by what is typed - matched against the label, the description and
 * the chord as printed - or, in key search, by the chord pressed.
 */
const shortcutRows = computed(() => {
  const needle = keyFilter.value.trim().toLowerCase()
  const chord = keySearchChord.value?.toLowerCase()
  return shortcutPage.value.filter((row) => {
    if (keySearch.value) return !chord || boundKeys(row).toLowerCase() === chord
    if (!needle) return true
    const bound = boundKeys(row)
    return [row.title, row.desc, shownChord(bound), bound].some((text) => text.toLowerCase().includes(needle))
  })
})

/* MiMo's switch: turned off while at full access, the level drops to the default and says so. */
async function toggleFullAccess() {
  const config = app.config
  if (!config) return
  if (!config.allowFullAccess) {
    await app.patchConfig({ allowFullAccess: true })
    return
  }
  const { patch, dropped } = fullAccessOff(config)
  try {
    await app.patchConfig(patch)
    if (dropped) app.announceAccess("ask")
  } catch {
    /* patchConfig has said so */
  }
}

/** Where tasks with no project get their folders. Empty is the default under the home folder. */
async function pickProjectRoot() {
  const [directory] = await pickDirectory(t("set.pickDir"))
  if (!directory) return
  await app.patchConfig({ projectRoot: directory })
  notify(t("set.projectRootSet"))
}

async function resetProjectRoot() {
  await app.patchConfig({ projectRoot: "" })
  notify(t("set.projectRootReset"))
}

const CHIME_LABEL: Record<Chime, string> = {
  off: "set.chimeOff",
  rhodes: "set.chimeRhodes",
  handpan: "set.chimeHandpan",
  vibes: "set.chimeVibes",
  bloom: "set.chimeBloom",
  harp: "set.chimeHarp",
  kalimba: "set.chimeKalimba",
  bowl: "set.chimeBowl",
  koto: "set.chimeKoto",
}

const chimeOptions = computed(() =>
  (["off", ...CHIMES] as Chime[]).map((value) => ({ value, label: t(CHIME_LABEL[value]) })),
)

/** Picking a chime is how it is heard: the list has no separate play button. */
function chooseChime(value: string) {
  const choice = chimeOf(value)
  void app.patchConfig({ taskDoneSound: choice })
  if (choice !== "off") chime(choice)
}

/* Clearing what the in-app browser has stored, after a confirmation, as MiMo asks for one. */
const confirmingClear = ref(false)

async function clearBrowsing() {
  confirmingClear.value = false
  const reason = await window.mcode.browserClearData()
  if (reason) notifyFailure(t("set.browsingDataFailed", { error: reason }))
  else notify(t("set.browsingDataCleared"))
}

/*
 * Whether another layer was up when Escape went down, read on the capture phase
 * before any of them has closed, as MiMo's overlay reads it. A confirmation, a
 * picker or a dialog opened from here closes alone, whichever it is: there is
 * no hand-kept list of them to fall out of step.
 */
let layerAtPress = false
function notePress(event: KeyboardEvent) {
  if (event.key === "Escape") layerAtPress = layerOpen(dialogEl.value)
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape") return
  /* As in MiMo, the overlay closes only when nothing on top of it took the Escape. An open picker marks it taken. */
  if (event.defaultPrevented) return
  if (confirmingVoiceSend.value) {
    confirmingVoiceSend.value = false
    return
  }
  if (layerAtPress) return
  requestClose()
}

onMounted(() => {
  window.addEventListener("keydown", notePress, true)
  window.addEventListener("keydown", onKeydown)
})
onBeforeUnmount(() => {
  window.removeEventListener("keydown", notePress, true)
  window.removeEventListener("keydown", onKeydown)
})
</script>

<template>
  <div class="overlay" :class="{ closing }" data-settings-overlay data-modal-no-exit @mousedown.self="requestClose">
    <div ref="dialogEl" v-modal class="dialog" data-modal-keep-focus data-new-task-clears>
      <!-- 2.0: MiMo's dialog closes from its own corner as well as from Escape
           and the scrim, which a pointer-only reader otherwise has to find. -->
      <button class="close" :aria-label="t('set.close')" data-settings-close @click="requestClose">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
        </svg>
      </button>
      <nav class="nav" :class="{ 'mouse-active': pointerMoved }" @pointermove="pointerMoved = true">
        <!-- The title and the search stay put; only the list under them scrolls, as MiMo's does. -->
        <div class="nav-top">
          <div class="nav-title">{{ t("rail.settings") }}</div>
          <input
            v-model="navQuery"
            class="nav-search"
            :placeholder="t('set.search')"
            :aria-label="t('set.search')"
            spellcheck="false"
            autocomplete="off"
            @keydown.enter="!composing($event) && openFirstMatch()"
          />
        </div>
        <!--
          MiMo's four groups, in its order, in a list that scrolls on its own:
          at the default size they are already taller than the dialog.
        -->
        <div ref="navScrollEl" class="nav-scroll u-scrollbar-thin" data-settings-nav-scroll>
          <div v-show="navShows('general') || navShows('usage') || navShows('appearance') || navShows('files') || navShows('models') || navShows('personal') || navShows('keys')" class="nav-group">{{ t("set.group.personal") }}</div>

          <button v-show="navShows('general')" class="nav-item" :class="{ on: section === 'general' }" @click="section = 'general'">
            <svg class="nav-ico" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path d="M3.6 5.55h12.8a.7.7 0 0 1 0 1.4H3.6a.7.7 0 0 1 0-1.4Z" />
              <path d="M3.6 13.05h12.8a.7.7 0 0 1 0 1.4H3.6a.7.7 0 0 1 0-1.4Z" />
              <path d="M13.75 3.65a2.6 2.6 0 1 1 0 5.2 2.6 2.6 0 0 1 0-5.2Z" />
              <path d="M7.75 11.15a2.6 2.6 0 1 1 0 5.2 2.6 2.6 0 0 1 0-5.2Z" />
            </svg>
            {{ t("set.nav.general") }}
          </button>

          <button v-show="navShows('usage')" class="nav-item" :class="{ on: section === 'usage' }" @click="section = 'usage'">
            <svg class="nav-ico" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <rect x="2.7" y="9" width="2.6" height="7.3" rx="1.1" />
              <rect x="6.8" y="5" width="2.6" height="11.3" rx="1.1" />
              <rect x="10.9" y="11.4" width="2.6" height="4.9" rx="1.1" />
              <rect x="15" y="7.3" width="2.6" height="9" rx="1.1" />
            </svg>
            <span>{{ t("set.nav.usage") }}</span>
          </button>

          <button v-show="navShows('appearance')" class="nav-item" :class="{ on: section === 'appearance' }" @click="section = 'appearance'">
            <svg class="nav-ico" viewBox="0 0 20 20" fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" aria-hidden="true">
              <path d="M10 2.6a7.4 7.4 0 1 1 0 14.8 7.4 7.4 0 0 1 0-14.8ZM10 4.2a5.8 5.8 0 0 0 0 11.6Z" />
            </svg>
            <span>{{ t("set.appearance") }}</span>
          </button>

          <button v-show="navShows('files')" class="nav-item" :class="{ on: section === 'files' }" @click="section = 'files'">
            <svg class="nav-ico" viewBox="0 0 20 20" fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" aria-hidden="true">
              <path d="M5.4 2.6h5.4l4.4 4.4v9.8a.6.6 0 0 1-.6.6H5.4a.6.6 0 0 1-.6-.6V3.2a.6.6 0 0 1 .6-.6ZM11 4.1v3.2h3.2L11 4.1Z" />
            </svg>
            <span>{{ t("set.nav.files") }}</span>
          </button>

          <button v-show="navShows('models')" class="nav-item" :class="{ on: section === 'models' }" @click="section = 'models'">
            <svg class="nav-ico" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path d="M17.5 10C12.2917 10 10 12.2917 10 17.5 10 12.2917 7.70833 10 2.5 10 7.70833 10 10 7.70833 10 2.5c0 5.20833 2.2917 7.5 7.5 7.5Z" />
            </svg>
            {{ t("set.models") }}
          </button>

          <button v-show="navShows('personal')" class="nav-item" :class="{ on: section === 'personal' }" @click="section = 'personal'">
            <svg class="nav-ico" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path d="M10 3.4a3.2 3.2 0 1 1 0 6.4 3.2 3.2 0 0 1 0-6.4Z" />
              <path d="M10 11.2c3.2 0 5.8 1.9 5.8 4.8a.6.6 0 0 1-.6.6H4.8a.6.6 0 0 1-.6-.6c0-2.9 2.6-4.8 5.8-4.8Z" />
            </svg>
            <span>{{ t("set.personal") }}</span>
          </button>

          <button v-show="navShows('keys')" class="nav-item" :class="{ on: section === 'keys' }" @click="section = 'keys'">
            <svg class="nav-ico" viewBox="0 0 20 20" fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" aria-hidden="true">
              <path d="M2.4 5.3h15.2a1 1 0 0 1 1 1v7.9a1 1 0 0 1-1 1H2.4a1 1 0 0 1-1-1V6.3a1 1 0 0 1 1-1Z" />
              <path d="M3.7 7.4h1.7v1.7H3.7ZM6.9 7.4h1.7v1.7H6.9ZM10.1 7.4h1.7v1.7h-1.7ZM13.3 7.4h1.7v1.7h-1.7ZM16.5 7.4h-.8v1.7h.8ZM5.6 11.1h8.8v1.7H5.6Z" />
            </svg>
            {{ t("set.shortcuts") }}
          </button>

          <div v-show="navShows('mcp')" class="nav-group">{{ t("set.group.integrations") }}</div>

          <button v-show="navShows('mcp')" class="nav-item" :class="{ on: section === 'mcp' }" @click="section = 'mcp'">
            <svg class="nav-ico" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path d="M6.75 2.7a.75.75 0 0 1 .75.75V6h-1.5V3.45a.75.75 0 0 1 .75-.75Z" />
              <path d="M13.25 2.7a.75.75 0 0 1 .75.75V6h-1.5V3.45a.75.75 0 0 1 .75-.75Z" />
              <path d="M5.2 7.1h9.6v2.8a4.85 4.85 0 0 1-4.05 4.78v2.62h-1.5v-2.62A4.85 4.85 0 0 1 5.2 9.9V7.1Z" />
            </svg>
            <span>{{ t("set.nav.mcp") }}</span>
          </button>

          <div v-show="navShows('environment')" class="nav-group">{{ t("set.group.coding") }}</div>

          <button v-show="navShows('environment')" class="nav-item" :class="{ on: section === 'environment' }" @click="section = 'environment'">
            <svg class="nav-ico" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path d="M5.85 3.6h1.3v12.8h-1.3Z" />
              <path d="M6.5 9.35h7.4v1.3H6.5Z" />
              <path d="M6.5 1.4a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4Z" />
              <path d="M6.5 13.2a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4Z" />
              <path d="M15 7.8a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4Z" />
            </svg>
            <span>{{ t("set.environment") }}</span>
          </button>

          <!-- MiMo 26.920's 实验室 group, always shown, between 编码 and 已归档. -->
          <div v-show="navShows('lab')" class="nav-group">{{ t("set.group.lab") }}</div>

          <button v-show="navShows('lab')" class="nav-item" :class="{ on: section === 'lab' }" data-nav-lab @click="section = 'lab'">
            <svg class="nav-ico" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path d="M7.4 2.6h5.2v1.5h-1v4.2l4.3 7.4c.41.7-.1 1.6-.91 1.6H5.01c-.81 0-1.32-.9-.91-1.6l4.3-7.4V4.1h-1V2.6Z" />
            </svg>
            <span>{{ t("set.nav.lab") }}</span>
          </button>

          <div v-show="navShows('archive')" class="nav-group">{{ t("set.group.archived") }}</div>

          <button v-show="navShows('archive')" class="nav-item" :class="{ on: section === 'archive' }" @click="section = 'archive'">
            <svg class="nav-ico" viewBox="0 0 20 20" fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" aria-hidden="true">
              <path d="M2.4 2.6h15.2a.8.8 0 0 1 .8.8v2.1a.8.8 0 0 1-.8.8H2.4a.8.8 0 0 1-.8-.8V3.4a.8.8 0 0 1 .8-.8Z" />
              <path d="M3.1 7.4h13.8v9.3a.7.7 0 0 1-.7.7H3.8a.7.7 0 0 1-.7-.7V7.4ZM8.2 9.4h3.6v1.5H8.2Z" />
            </svg>
            {{ t("set.nav.archive") }}
          </button>

          <div v-show="navShows('updates')" class="nav-group">{{ t("set.groupAbout") }}</div>

          <button v-show="navShows('updates')" class="nav-item" :class="{ on: section === 'updates' }" @click="section = 'updates'">
            <svg class="nav-ico" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path d="M10 3.1 14.5 7.6h-3.1v4.9H8.6V7.6H5.5L10 3.1Z" />
              <path d="M4 13.4h1.5v1.6h9V13.4H16v2.4a.7.7 0 0 1-.7.7H4.7a.7.7 0 0 1-.7-.7v-2.4Z" />
            </svg>
            <span>{{ t("set.nav.updates") }}</span>
          </button>

          <div v-if="!navMatches.length" class="nav-empty">{{ t("set.noMatch") }}</div>
        </div>
      </nav>

      <!-- MiMo's #set-main carries the thin 9px bar the nav column already has. -->
      <div ref="contentEl" class="content u-scrollbar-thin">
        <!-- General -->
        <template v-if="section === 'general'">
          <h2>{{ t("set.nav.general") }}</h2>
          <!-- MiMo's 常规 section, repeated under the page title: open target, new project location, language, tray. -->
          <h3 data-section="basics">{{ t("set.sectionBasics") }}</h3>
          <div class="card">
            <!-- MiMo's 默认打开目标: what 打开位置 opens a folder with, from the apps on this machine. -->
            <div class="line" data-open-target>
              <div class="line-text">
                <div class="line-title">{{ t("set.openTarget") }}</div>
                <div class="line-sub">{{ t("set.openTargetSub") }}</div>
              </div>
              <SelectMenu :model-value="openChoice" :options="openOptions" @update:model-value="chooseOpen($event)" />
            </div>

            <div class="line project-root">
              <div class="line-text">
                <div class="line-title">{{ t("set.projectRoot") }}</div>
                <div class="line-sub">{{ app.config?.projectRoot || t("set.projectRootEmpty") }}</div>
              </div>
              <span class="ctl-pair">
                <button class="ctl-btn" data-pick @click="pickProjectRoot">{{ t("set.pickDir") }}</button>
                <button v-if="app.config?.projectRoot" class="ctl-btn" data-reset @click="resetProjectRoot">
                  {{ t("set.resetDir") }}
                </button>
              </span>
            </div>

            <div class="line" data-watermark-row>
              <div class="line-text">
                <div class="line-title">{{ t("set.watermark") }}</div>
                <div class="line-sub">{{ t("set.watermarkSub") }}</div>
              </div>
              <button class="switch" :class="{ on: app.config?.removeExplicitWatermark }" type="button" role="switch" :aria-checked="Boolean(app.config?.removeExplicitWatermark)" :aria-label="t('set.watermark')" :disabled="watermarkSaving" data-watermark-toggle @click="toggleWatermarkRemoval"><span class="knob" /></button>
            </div>
            <Teleport to="body">
              <ConfirmDialog v-if="confirmingWatermark" :title="t('set.watermarkConfirm')" :body="t('set.watermarkBody')" :confirm-label="t('set.watermarkApply')" :danger="false" @close="!watermarkSaving && (confirmingWatermark = false)" @confirm="setWatermarkRemoval(true)" />
            </Teleport>

            <!-- MiMo's searchable picker; an empty language is 自动检测. -->
            <div class="line" data-language-row>
              <div class="line-text">
                <div class="line-title">{{ t("set.language") }}</div>
                <div class="line-sub">{{ t("set.languageSub") }}</div>
              </div>
              <LanguageMenu
                :model-value="app.config?.language ?? ''"
                @update:model-value="app.patchConfig({ language: $event })"
              />
            </div>

            <!-- MiMo's 显示服务器, Linux only: 自动 names the backend in use; a change takes a restart. -->
            <div v-if="displayServer.supported" class="line" data-display-server-row>
              <div class="line-text">
                <div class="line-title">{{ t("set.displayServer") }}</div>
                <div class="line-sub">{{ displayServerSub }}</div>
              </div>
              <SelectMenu :model-value="displayServer.pref" :options="displayServerOptions" @update:model-value="chooseDisplayServer($event)" />
            </div>

            <!-- MiMo's tray row, worded per platform: while on, closing the last window hides it to the tray. -->
            <div class="line" data-tray-row>
              <div class="line-text">
                <div class="line-title">{{ t(app.platform === "darwin" ? "set.trayMac" : "set.tray") }}</div>
                <div class="line-sub">
                  {{ t(app.platform === "darwin" ? "set.traySubMac" : app.platform === "win32" ? "set.traySub" : "set.traySubLinux") }}
                </div>
              </div>
              <button
                class="switch"
                :class="{ on: app.config?.tray ?? true }"
                role="switch"
                :aria-checked="app.config?.tray ?? true"
                :aria-label="t(app.platform === 'darwin' ? 'set.trayMac' : 'set.tray')"
                @click="app.patchConfig({ tray: !(app.config?.tray ?? true) })"
              >
                <span class="knob" />
              </button>
            </div>

            <!-- MiMo 26.920's 开机自启, after the tray row and only where the OS offers it (Windows and macOS). -->
            <div v-if="loginItem.supported" class="line" data-launch-at-login-row>
              <div class="line-text">
                <div class="line-title">{{ t("set.launchAtLogin") }}</div>
                <div class="line-sub">{{ t("set.launchAtLoginSub") }}</div>
              </div>
              <button
                class="switch"
                :class="{ on: loginItem.enabled }"
                role="switch"
                :aria-checked="loginItem.enabled"
                :aria-label="t('set.launchAtLogin')"
                data-launch-at-login
                @click="switchLaunchAtLogin"
              >
                <span class="knob" />
              </button>
            </div>

            <!-- MCode Remote: the gateway switch lives in the config's remote
                 field; the desktop main process starts and stops the gateway
                 as it flips. -->
            <div class="line" data-remote-row>
              <div class="line-text">
                <div class="line-title">{{ t("set.remote") }}</div>
                <div class="line-sub">{{ t("set.remoteSub") }}</div>
              </div>
              <button
                class="switch"
                :class="{ on: app.config?.remote?.enabled ?? false }"
                role="switch"
                :aria-checked="app.config?.remote?.enabled ?? false"
                :aria-label="t('set.remote')"
                data-remote-toggle
                @click="app.patchConfig({ remote: { ...(app.config?.remote ?? {}), enabled: !(app.config?.remote?.enabled ?? false) } })"
              >
                <span class="knob" />
              </button>
            </div>
          </div>

          <!-- MiMo's 权限 section: its full access gate alone. -->
          <h3 data-section="permissions">{{ t("set.sectionPermissions") }}</h3>
          <div class="card">
            <!-- MiMo's gate: full access can only be picked in the box once this is on. -->
            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.allowFullAccess") }}</div>
                <div class="line-sub">{{ t("set.allowFullAccessSub") }}</div>
              </div>
              <button
                class="switch"
                :class="{ on: app.config?.allowFullAccess }"
                role="switch"
                :aria-checked="Boolean(app.config?.allowFullAccess)"
                :aria-label="t('set.allowFullAccess')"
                @click="toggleFullAccess"
              >
                <span class="knob" />
              </button>
            </div>
          </div>

          <!-- MiMo's browser group, ahead of voice as MiMo orders them: the in-app browser itself, and what it has stored. -->
          <h3 data-section="browser">{{ t("set.browser") }}</h3>
          <div class="card">
            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.browserPlugin") }}</div>
                <div class="line-sub">{{ t("set.browserPluginSub") }}</div>
              </div>
              <button
                class="switch"
                :class="{ on: app.config?.browserEnabled !== false }"
                role="switch"
                :aria-checked="app.config?.browserEnabled !== false"
                :aria-label="t('set.browserPlugin')"
                @click="app.patchConfig({ browserEnabled: app.config?.browserEnabled === false })"
              >
                <span class="knob" />
              </button>
            </div>
            <!-- MCode's own switch (MiMo has none): whether a video card under a reply asks its platform for a title and cover. -->
            <div class="line" data-video-card-details-row>
              <div class="line-text">
                <div class="line-title">{{ t("set.videoCardDetails") }}</div>
                <div class="line-sub">{{ t("set.videoCardDetailsSub") }}</div>
              </div>
              <button
                class="switch"
                :class="{ on: app.config?.videoCardDetails !== false }"
                role="switch"
                :aria-checked="app.config?.videoCardDetails !== false"
                :aria-label="t('set.videoCardDetails')"
                data-video-card-details
                @click="app.patchConfig({ videoCardDetails: app.config?.videoCardDetails === false })"
              >
                <span class="knob" />
              </button>
            </div>
            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.browsingData") }}</div>
                <div class="line-sub">{{ t("set.browsingDataSub") }}</div>
              </div>
              <button class="ctl-btn clear-browsing" @click="confirmingClear = true">{{ t("set.clearBrowsingData") }}</button>
            </div>
          </div>

          <!--
            Web search, next to the browser: both are "may this reach the
            network". It was reachable only from the confirmation card that
            asks the first time, so choosing 关闭 there was a one-way door -
            turning it back on meant hand-editing config.json's `websearch`
            (round 31 left it that way; round 78 gave it a switch). Off is
            `false`; on returns to `auto`, the value that rotates through the
            services, since which one was in use is not recorded separately.
          -->
          <div class="card">
            <div class="line" data-websearch-row>
              <div class="line-text">
                <div class="line-title">{{ t("set.webSearch") }}</div>
                <div class="line-sub">{{ t("set.webSearchSub") }}</div>
              </div>
              <button
                class="switch"
                :class="{ on: app.config?.websearch !== false }"
                role="switch"
                :aria-checked="app.config?.websearch !== false"
                :aria-label="t('set.webSearch')"
                data-websearch-switch
                @click="app.patchConfig({ websearch: app.config?.websearch === false ? 'auto' : false })"
              >
                <span class="knob" />
              </button>
            </div>
          </div>
          <Teleport to="body">
            <ConfirmDialog
              v-if="confirmingClear"
              :title="t('set.clearBrowsingTitle')"
              :body="t('set.clearBrowsingBody')"
              :confirm-label="t('set.clearBrowsingOk')"
              @confirm="clearBrowsing"
              @close="confirmingClear = false"
            />
          </Teleport>

          <h3 data-section="voice">{{ t("set.voice") }}</h3>
          <div class="card">
            <!-- MCode's own and necessary: there is no built-in speech service to fall back on. -->
            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.voiceModel") }}</div>
                <div class="line-sub">{{ t("set.voiceModelSub") }}</div>
              </div>
              <SelectMenu
                :model-value="voiceModelValue"
                :options="voiceModelOptions"
                @update:model-value="setVoiceModel($event)"
              />
            </div>

            <!-- MiMo's description follows the mode; 智能编辑's ends in a 用法详情 link to the examples. -->
            <div class="line" data-voice-mode>
              <div class="line-text">
                <div class="line-title">{{ t("set.voiceMode") }}</div>
                <div class="line-sub" data-voice-mode-sub>
                  <template v-if="(app.config?.voiceMode ?? 'smart') === 'smart'">
                    {{ t("set.voiceModeSmartSub") }}&#12288;<span
                      class="usage-link"
                      role="button"
                      tabindex="0"
                      data-voice-usage-link
                      @click="voiceUsageOpen = true"
                      @keydown.enter.prevent="voiceUsageOpen = true"
                      >{{ t("set.voiceUsageLink") }}</span
                    >
                  </template>
                  <template v-else>{{ t("set.voiceModeFastSub") }}</template>
                </div>
              </div>
              <SelectMenu
                :model-value="app.config?.voiceMode ?? 'smart'"
                :options="voiceModes"
                @update:model-value="app.patchConfig({ voiceMode: $event as 'smart' })"
              />
            </div>

            <div v-if="(app.config?.voiceMode ?? 'smart') === 'smart'" class="line" data-voice-send>
              <div class="line-text">
                <div class="line-title">{{ t("set.voiceSend") }}</div>
                <div class="line-sub">{{ t(app.config?.voiceSend ? "set.voiceSendSubOn" : "set.voiceSendSub") }}</div>
              </div>
              <button
                class="switch"
                :class="{ on: app.config?.voiceSend ?? false }"
                role="switch"
                :aria-checked="app.config?.voiceSend ?? false"
                :aria-label="t('set.voiceSend')"
                @click="toggleVoiceSend"
              >
                <span class="knob" />
              </button>
            </div>

            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.voiceFeedback") }}</div>
                <div class="line-sub">{{ t("set.voiceFeedbackSub") }}</div>
              </div>
              <button
                class="switch"
                :class="{ on: app.config?.voiceFeedback ?? true }"
                role="switch"
                :aria-checked="app.config?.voiceFeedback ?? true"
                :aria-label="t('set.voiceFeedback')"
                @click="app.patchConfig({ voiceFeedback: !(app.config?.voiceFeedback ?? true) })"
              >
                <span class="knob" />
              </button>
            </div>
          </div>
          <Teleport to="body">
            <VoiceUsageDialog v-if="voiceUsageOpen" @close="voiceUsageOpen = false" />
          </Teleport>
          <!--
            MiMo's own dialog for turning voice send on, not the shared confirm:
            430 wide, a red warning triangle before a 16px title, a light red
            button, and nothing focused on open.
          -->
          <Teleport to="body">
            <div v-if="confirmingVoiceSend" class="vs-scrim" @mousedown.self="confirmingVoiceSend = false">
              <div v-modal class="vs-dialog" data-voice-send-confirm data-modal-keep-focus role="alertdialog" aria-labelledby="vs-title">
                <div class="vs-head">
                  <svg class="vs-warn" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d93025" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
                    <path d="M12 9v4M12 17h.01" />
                  </svg>
                  <div id="vs-title" class="vs-title">{{ t("set.voiceSendConfirmTitle") }}</div>
                </div>
                <p class="vs-body">{{ t("set.voiceSendConfirmBody") }}</p>
                <div class="vs-actions">
                  <button class="vs-cancel" type="button" @click="confirmingVoiceSend = false">{{ t("common.cancel") }}</button>
                  <button class="vs-ok" type="button" data-voice-send-ok @click="enableVoiceSend">{{ t("set.voiceSendConfirmOk") }}</button>
                </div>
              </div>
            </div>
          </Teleport>

          <!-- MiMo's two sound rows first, then MCode's own permission and error chimes. -->
          <h3 data-section="sound">{{ t("set.sounds") }}</h3>
          <div class="card">
            <div class="line task-done">
              <div class="line-text">
                <div class="line-title">{{ t("set.taskDone") }}</div>
                <div class="line-sub">{{ t("set.taskDoneSub") }}</div>
              </div>
              <SelectMenu
                :model-value="chimeOf(app.config?.taskDoneSound)"
                :options="chimeOptions"
                @update:model-value="chooseChime"
              />
            </div>

            <div class="line spine-sound">
              <div class="line-text">
                <div class="line-title">{{ t("set.spineSound") }}</div>
                <div class="line-sub">{{ t("set.spineSoundSub") }}</div>
              </div>
              <button
                class="switch"
                :class="{ on: app.config?.spineSound !== false }"
                role="switch"
                :aria-checked="app.config?.spineSound !== false"
                :aria-label="t('set.spineSound')"
                @click="app.patchConfig({ spineSound: app.config?.spineSound === false })"
              >
                <span class="knob" />
              </button>
            </div>

          </div>

          <!-- MiMo's 性能 section, right after 声音: one switch, applied at the next launch. -->
          <h3 data-section="performance">{{ t("set.performance") }}</h3>
          <div class="card">
            <div class="line" data-hw-accel-row>
              <div class="line-text">
                <div class="line-title">{{ t("set.hwAccel") }}</div>
                <div class="line-sub">{{ t("set.hwAccelSub") }}</div>
              </div>
              <button
                class="switch"
                :class="{ on: hardwareAcceleration }"
                role="switch"
                :aria-checked="hardwareAcceleration"
                :aria-label="t('set.hwAccel')"
                data-hw-accel-switch
                @click="toggleHardwareAcceleration"
              >
                <span class="knob" />
              </button>
            </div>
          </div>
        </template>

        <!-- Keyboard -->
        <!-- Appearance: a page of its own, as MiMo keeps it, rather than a group under General. -->
        <template v-else-if="section === 'appearance'">
          <h2>{{ t("set.appearance") }}</h2>
          <!-- MiMo's first card: 主题 alone - there is no palette to choose. -->
          <div class="card" data-appearance-theme>
            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.appearance.theme") }}</div>
                <div class="line-sub">{{ t("set.appearance.themeSub") }}</div>
              </div>
              <SelectMenu
                :model-value="app.config?.theme ?? 'system'"
                :options="themeOptions"
                @update:model-value="app.patchConfig({ theme: $event as 'dark' })"
              />
            </div>
          </div>

          <!--
            MiMo's 应用图标: a section heading and the grid, which is itself a card.
            The tiles are the icon files themselves, so the tile a reader presses
            is the icon they get.
          -->
          <h3 data-app-icon-head>{{ t("set.appIcon") }}</h3>
          <div class="card gallery" role="radiogroup" :aria-label="t('set.appIcon')">
            <button
              v-for="tile in iconTiles"
              :key="tile.spec.id"
              class="tile"
              :class="{ on: appIcon === tile.spec.id }"
              role="radio"
              :aria-checked="appIcon === tile.spec.id"
              :aria-label="tile.spec.name"
              @click="chooseAppIcon(tile.spec.id)"
            >
              <img class="tile-art" :src="tile.image" width="60" height="60" alt="" />
              <span class="tile-name">{{ tile.spec.name }}</span>
            </button>
          </div>

          <div class="card appearance-rest">
            <!-- MiMo's second card: pointer, motion, the two sizes, diff marks and smoothing; MCode's fonts and wrap after. -->
            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.pointerCursor") }}</div>
                <div class="line-sub">{{ t("set.pointerCursorSub") }}</div>
              </div>
              <button
                class="switch"
                :class="{ on: app.config?.pointerCursor ?? true }"
                role="switch"
                :aria-checked="app.config?.pointerCursor ?? true"
                :aria-label="t('set.pointerCursor')"
                @click="app.patchConfig({ pointerCursor: !(app.config?.pointerCursor ?? true) })"
              >
                <span class="knob" />
              </button>
            </div>

            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.reduceMotion") }}</div>
                <div class="line-sub">{{ t("set.reduceMotionSub") }}</div>
              </div>
              <div class="choice" role="radiogroup" :aria-label="t('set.reduceMotion')">
                <button
                  v-for="mode in MOTION_MODES"
                  :key="mode"
                  class="choice-btn"
                  :class="{ on: (app.config?.reduceMotion ?? 'system') === mode }"
                  role="radio"
                  :aria-checked="(app.config?.reduceMotion ?? 'system') === mode"
                  @click="app.patchConfig({ reduceMotion: mode })"
                >
                  {{ t(`set.motion.${mode}`) }}
                </button>
              </div>
            </div>

            <!-- MiMo's pair: the base size of the interface's text, and of code in the transcript and diffs. -->
            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.uiFontSize") }}</div>
                <div class="line-sub">{{ t("set.uiFontSizeSub") }}</div>
              </div>
              <span class="size-field">
                <input
                  class="field size-input"
                  :value="app.config?.uiFontSize ?? 14"
                  inputmode="numeric"
                  spellcheck="false"
                  :aria-label="t('set.uiFontSize')"
                  data-size-input="ui"
                  @input="typeSize('uiFontSize', $event)"
                  @change="setSize('uiFontSize', $event, 14)"
                  @keydown.enter="!composing($event) && ($event.target as HTMLInputElement).blur()"
                />
                <span class="unit">px</span>
              </span>
            </div>

            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.codeFontSize") }}</div>
                <div class="line-sub">{{ t("set.codeFontSizeSub") }}</div>
              </div>
              <span class="size-field">
                <input
                  class="field size-input"
                  :value="app.config?.codeFontSize ?? 12"
                  inputmode="numeric"
                  spellcheck="false"
                  :aria-label="t('set.codeFontSize')"
                  data-size-input="code"
                  @input="typeSize('codeFontSize', $event)"
                  @change="setSize('codeFontSize', $event, 12)"
                  @keydown.enter="!composing($event) && ($event.target as HTMLInputElement).blur()"
                />
                <span class="unit">px</span>
              </span>
            </div>

            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.diffMarks") }}</div>
                <div class="line-sub">{{ t("set.diffMarksSub") }}</div>
              </div>
              <div class="choice" role="radiogroup" :aria-label="t('set.diffMarks')">
                <button
                  v-for="mark in DIFF_MARKS"
                  :key="mark"
                  class="choice-btn"
                  :class="{ on: (app.config?.diffMarks ?? 'color') === mark }"
                  role="radio"
                  :aria-checked="(app.config?.diffMarks ?? 'color') === mark"
                  @click="app.patchConfig({ diffMarks: mark })"
                >
                  {{ t(`set.marks.${mark}`) }}
                </button>
              </div>
            </div>

            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.fontSmoothing") }}</div>
                <div class="line-sub">{{ t(app.platform === "darwin" ? "set.fontSmoothingSubMac" : "set.fontSmoothingSub") }}</div>
              </div>
              <button
                class="switch"
                :class="{ on: app.config?.fontSmoothing ?? true }"
                role="switch"
                :aria-checked="app.config?.fontSmoothing ?? true"
                :aria-label="t('set.fontSmoothing')"
                @click="app.patchConfig({ fontSmoothing: !(app.config?.fontSmoothing ?? true) })"
              >
                <span class="knob" />
              </button>
            </div>
          </div>
        </template>

        <template v-else-if="section === 'personal'">
          <h2>{{ t("set.personal") }}</h2>
          <p class="page-sub">{{ t("set.personalSub") }}</p>
          <h3>{{ t("set.instructions") }}</h3>
          <!-- MiMo's 了解更多 follows the sentence with no space between. -->
          <p class="page-sub">
            {{ t("set.instructionsSub") }}<button type="button" class="ci-link" data-ci-link :aria-expanded="ciHelpOpen" @click="ciHelpOpen = !ciHelpOpen">{{ t("set.learnMore") }}</button>
          </p>
          <div v-if="ciHelpOpen" class="ci-help" data-ci-help>
            <span>{{ t("set.ciHelp1") }}</span>
            <span>{{ t("set.ciHelp2") }}</span>
            <span>{{ t("set.ciHelp3") }}</span>
          </div>
          <textarea
            v-model="draft"
            class="ci-input"
            spellcheck="false"
            :placeholder="t('set.instructionsPlaceholder')"
            :aria-label="t('set.instructions')"
          />
          <div class="ci-actions">
            <!-- MiMo's save turns into the primary button once there is something to save. -->
            <button class="ctl-btn ci-save" :class="{ 'update-install': dirty }" data-ci-save :disabled="!dirty" @click="saveInstructions">
              {{ t("common.save") }}
            </button>
          </div>
        </template>

        <template v-else-if="section === 'files'">
          <h2>{{ t("set.nav.files") }}</h2>
          <div class="card" data-config-page>
            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.config.file") }}</div>
                <div class="line-sub mcp-path" data-config-path :title="configFile?.path">{{ configFile ? homePath(configFile.path, paths?.home) : "" }}</div>
              </div>
              <div class="mcp-ctrl">
                <button class="ctl-btn" data-config-copy-path :disabled="!configFile" @click="copyConfigPath">{{ t("set.config.copyPath") }}</button>
                <button class="ctl-btn" data-config-open :disabled="!configFile" @click="openConfigFile">{{ t("files.open") }}</button>
              </div>
            </div>
            <div class="line" data-agents-row>
              <div class="line-text">
                <div class="line-title">AGENTS.md</div>
                <div class="line-sub">{{ t("set.agents.desc") }}</div>
              </div>
              <div class="mcp-ctrl">
                <span class="agents-tag" :class="{ off: agents?.state !== 'loaded' }" data-agents-state>
                  {{ t(agents?.state === "loaded" ? "set.agents.loaded" : agents?.state === "disabled" ? "set.agents.disabled" : "set.agents.none") }}
                </span>
                <button v-if="agents?.state !== 'disabled'" class="ctl-btn" data-agents-open @click="openAgents">{{ t("files.open") }}</button>
                <button v-if="agents?.state === 'loaded'" class="ctl-btn" data-agents-disable @click="switchAgents(false)">
                  {{ t("set.agents.disable") }}
                </button>
                <button v-if="agents?.state === 'disabled'" class="ctl-btn" data-agents-enable @click="switchAgents(true)">
                  {{ t("set.agents.enable") }}
                </button>
                <button v-if="agents && agents.state !== 'none'" class="ctl-btn" data-agents-delete @click="confirmingAgentsDelete = true">
                  {{ t("set.agents.delete") }}
                </button>
              </div>
            </div>
          </div>
          <h3 data-skill-paths-heading>{{ t("set.skillPaths.title") }}</h3>
          <div class="card" data-skill-paths>
            <div v-for="row in skillPathRows" :key="row.id" class="line" :data-skill-path="row.id">
              <div class="line-text">
                <div class="line-title">{{ row.title }}</div>
                <div class="line-sub skill-path-pair">
                  <span>{{ t("set.skillPaths.global", { path: row.global }) }}</span>
                  <span>{{ t("set.skillPaths.project", { path: row.project }) }}</span>
                </div>
              </div>
              <span v-if="row.id === 'mcode'" class="agents-tag" data-skill-path-always>{{ t("set.skillPaths.always") }}</span>
              <button
                v-else
                class="switch"
                :class="{ on: row.on }"
                role="switch"
                :aria-checked="row.on"
                :aria-label="row.title"
                :data-skill-path-switch="row.id"
                @click="switchSkillPath(row.id)"
              >
                <span class="knob" />
              </button>
            </div>
          </div>
          <p class="note" data-skill-paths-note>{{ t("set.skillPaths.note") }}</p>
          <Teleport to="body">
            <ConfirmDialog
              v-if="confirmingAgentsDelete"
              :title="t('set.agents.deleteTitle')"
              :body="t('set.agents.deleteBody')"
              :confirm-label="t('set.agents.delete')"
              @confirm="removeAgents"
              @close="confirmingAgentsDelete = false"
            />
          </Teleport>
        </template>

        <template v-else-if="section === 'mcp' && mcpView === 'form'">
          <h2>{{ t(mcpEditing ? "set.mcpForm.editTitle" : "set.mcpForm.title") }}</h2>
          <div class="card mcp-form" data-mcp-form>
            <label class="mcp-label">{{ t("set.mcpForm.name") }}</label>
            <input
              v-model="mcpForm.name"
              class="mcp-input"
              data-mcp-name
              :disabled="Boolean(mcpEditing)"
              placeholder="my-server"
              spellcheck="false"
            />
            <label class="mcp-label">{{ t("set.mcpForm.type") }}</label>
            <div class="mcp-types" role="radiogroup" :aria-label="t('set.mcpForm.type')">
              <button
                v-for="kind in MCP_KINDS"
                :key="kind"
                type="button"
                class="mcp-type"
                :class="{ on: mcpForm.type === kind }"
                role="radio"
                :aria-checked="mcpForm.type === kind"
                :data-mcp-type="kind"
                @click="mcpForm.type = kind"
              >
                {{ t(`set.mcpForm.type_${kind}`) }}
              </button>
            </div>

            <template v-if="mcpForm.type === 'stdio'">
              <label class="mcp-label">{{ t("set.mcpForm.command") }}</label>
              <input v-model="mcpForm.command" class="mcp-input" data-mcp-command placeholder="node server.js" spellcheck="false" />
              <label class="mcp-label">{{ t("set.mcpForm.args") }}</label>
              <div v-for="(_, at) in mcpForm.args" :key="`arg${at}`" class="mcp-pair">
                <input v-model="mcpForm.args[at]" class="mcp-input small" :data-mcp-arg="at" spellcheck="false" />
                <button type="button" class="ctl-btn" :data-mcp-arg-rm="at" @click="mcpForm.args.splice(at, 1)">
                  {{ t("set.mcp.remove") }}
                </button>
              </div>
              <button type="button" class="ctl-btn mcp-add-row" data-mcp-arg-add @click="mcpForm.args.push('')">
                {{ t("set.mcpForm.addArg") }}
              </button>
              <label class="mcp-label">{{ t("set.mcpForm.env") }}</label>
              <div v-for="(row, at) in mcpForm.env" :key="`env${at}`" class="mcp-pair">
                <input v-model="row.key" class="mcp-input small" placeholder="KEY" :data-mcp-env-key="at" spellcheck="false" />
                <input
                  v-model="row.value"
                  class="mcp-input small"
                  :type="mcpRevealed[`env:${at}`] ? 'text' : 'password'"
                  :placeholder="row.saved ? t('set.mcpForm.savedKeepBlank') : 'value'"
                  :data-mcp-env-val="at"
                  spellcheck="false"
                />
                <button type="button" class="ctl-btn" :data-mcp-env-reveal="at" @click="mcpRevealed[`env:${at}`] = !mcpRevealed[`env:${at}`]">
                  {{ t(mcpRevealed[`env:${at}`] ? "set.mcpForm.hide" : "set.mcpForm.reveal") }}
                </button>
                <button type="button" class="ctl-btn" :data-mcp-env-rm="at" @click="mcpForm.env.splice(at, 1)">
                  {{ t("set.mcp.remove") }}
                </button>
              </div>
              <button type="button" class="ctl-btn mcp-add-row last" data-mcp-env-add @click="mcpForm.env.push({ key: '', value: '' })">
                {{ t("set.mcpForm.addEnv") }}
              </button>
            </template>

            <template v-else>
              <label class="mcp-label">{{ t("set.mcpForm.url") }}</label>
              <input v-model="mcpForm.url" class="mcp-input" data-mcp-url placeholder="https://example.com/mcp" spellcheck="false" />
              <label class="mcp-label">{{ t("set.mcpForm.headers") }}</label>
              <div v-for="(row, at) in mcpForm.headers" :key="`hdr${at}`" class="mcp-pair">
                <input v-model="row.key" class="mcp-input small" placeholder="Header" :data-mcp-header-key="at" spellcheck="false" />
                <input
                  v-model="row.value"
                  class="mcp-input small"
                  :type="mcpRevealed[`hdr:${at}`] ? 'text' : 'password'"
                  :placeholder="row.saved ? t('set.mcpForm.savedKeepBlank') : 'value'"
                  :data-mcp-header-val="at"
                  spellcheck="false"
                />
                <button type="button" class="ctl-btn" :data-mcp-header-reveal="at" @click="mcpRevealed[`hdr:${at}`] = !mcpRevealed[`hdr:${at}`]">
                  {{ t(mcpRevealed[`hdr:${at}`] ? "set.mcpForm.hide" : "set.mcpForm.reveal") }}
                </button>
                <button type="button" class="ctl-btn" :data-mcp-header-rm="at" @click="mcpForm.headers.splice(at, 1)">
                  {{ t("set.mcp.remove") }}
                </button>
              </div>
              <button type="button" class="ctl-btn mcp-add-row" data-mcp-header-add @click="mcpForm.headers.push({ key: '', value: '' })">
                {{ t("set.mcpForm.addHeader") }}
              </button>
              <p class="mcp-hint" data-mcp-http-hint>{{ t("set.mcpForm.httpHint") }}</p>
            </template>

            <div class="mcp-form-actions">
              <button type="button" class="ctl-btn" data-mcp-cancel @click="mcpView = 'list'">{{ t("common.cancel") }}</button>
              <button type="button" class="ctl-btn update-install" data-mcp-save :disabled="Boolean(mcpFormError)" @click="saveMcp">
                {{ t("common.save") }}
              </button>
            </div>
          </div>
        </template>

        <template v-else-if="section === 'mcp' && mcpView === 'import'">
          <h2>{{ t("set.mcp.importTitle") }}</h2>
          <p class="page-sub">{{ t("set.mcp.importViewSub") }}</p>
          <div v-if="!mcpImports.length" class="card" data-mcp-import-none>
            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.mcp.importNone") }}</div>
                <div class="line-sub">{{ t("set.mcp.importNoneDesc") }}</div>
              </div>
            </div>
          </div>
          <template v-for="source in MCP_IMPORT_SOURCES" :key="source.id">
            <template v-if="mcpImports.some((item) => item.source === source.id)">
              <h3>{{ source.label }}</h3>
              <div class="card" :data-mcp-import-source="source.id">
                <div
                  v-for="item in mcpImports.filter((entry) => entry.source === source.id)"
                  :key="importKey(item)"
                  class="line"
                  :data-mcp-import-row="item.name"
                >
                  <div class="line-text">
                    <div class="line-title">{{ item.name }}</div>
                    <div class="line-sub mcp-summary">
                      {{ t(item.type === "remote" ? "set.mcp.remote" : "set.mcp.local") }} · {{ item.summary }}
                    </div>
                  </div>
                  <span v-if="item.exists" class="mcp-status muted" :data-mcp-import-exists="item.name">
                    {{ t("set.mcp.importExists") }}
                  </span>
                  <button
                    v-else
                    class="switch"
                    :class="{ on: mcpImportPicked.has(importKey(item)) }"
                    role="switch"
                    :aria-checked="mcpImportPicked.has(importKey(item))"
                    :aria-label="item.name"
                    :data-mcp-import-pick="item.name"
                    @click="pickMcpImport(item)"
                  >
                    <span class="knob" />
                  </button>
                </div>
              </div>
            </template>
          </template>
          <!-- MiMo's note under the sources: where skills are read from, and that other tools' folders are not scanned. -->
          <p class="page-sub mcp-skills-note" data-mcp-import-skills-note>{{ t("set.mcp.importSkillsNote") }}</p>
          <div class="mcp-import-actions">
            <button class="ctl-btn" data-mcp-import-back @click="mcpView = 'list'">{{ t("set.mcp.importBack") }}</button>
            <button
              v-if="mcpImports.some((item) => !item.exists)"
              class="ctl-btn update-install"
              data-mcp-import-apply
              :disabled="mcpImporting || !mcpImportChosen.length"
              @click="finishMcpImport"
            >
              {{ mcpImporting ? t("set.mcp.importing") : t("set.mcp.importApply", { n: String(mcpImportChosen.length) }) }}
            </button>
          </div>
        </template>

        <template v-else-if="section === 'mcp'">
          <h2>{{ t("set.nav.mcp") }}</h2>
          <p class="page-sub">{{ t("set.mcp.sub") }}</p>
          <!-- N11-27: a saved change waits for the next conversation; this says so and offers to apply it now. -->
          <div v-if="mcpUnapplied || mcpApply !== 'idle'" class="card mcp-apply" data-mcp-apply>
            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t(mcpUnapplied ? "set.mcp.unapplied" : "set.mcp.applyDone") }}</div>
                <div v-if="mcpUnapplied && mcpApply !== 'idle'" class="line-sub" :data-mcp-apply-state="mcpApply">
                  {{ t(mcpApply === "doing" ? "set.mcp.applyDoing" : mcpApply === "busy" ? "set.mcp.applyBusy" : mcpApply === "failed" ? "set.mcp.applyFailed" : "set.mcp.applyDone") }}
                </div>
              </div>
              <div class="mcp-ctrl">
                <button v-if="mcpUnapplied" class="ctl-btn" data-mcp-apply-now :disabled="mcpApply === 'doing'" @click="applyMcpNow">{{ t("set.mcp.applyNow") }}</button>
              </div>
            </div>
          </div>
          <div class="card" data-mcp-list>
            <template v-for="row in mcpRows" :key="row.name">
              <div class="line" :data-mcp-row="row.name">
                <div class="line-text">
                  <div class="line-title">{{ row.name }}</div>
                  <div class="line-sub mcp-row-desc">
                    <span>{{ t(row.remote ? "set.mcp.remote" : "set.mcp.local") }}</span>
                    <span class="mcp-status" :class="row.tone" :data-mcp-status="row.status" :title="row.error">
                      <span class="mcp-status-dot" />
                      {{ t(`set.mcp.status.${row.label}`) }}
                    </span>
                  </div>
                </div>
                <div class="mcp-ctrl">
                  <button
                    class="switch"
                    :class="{ on: row.enabled }"
                    role="switch"
                    :aria-checked="row.enabled"
                    :aria-label="row.name"
                    :data-mcp-enabled="row.name"
                    @click="setMcpEnabled(row.name, !row.enabled)"
                  >
                    <span class="knob" />
                  </button>
                  <button
                    v-if="row.enabled && mcpNeedsSignIn(row.status)"
                    class="ctl-btn"
                    :data-mcp-auth="row.name"
                    :disabled="mcpAuthorizing === row.name"
                    @click="authorizeMcp(row.name)"
                  >
                    {{ mcpAuthorizing === row.name ? t("set.mcp.authorizing") : t("set.mcp.authorize") }}
                  </button>
                  <button class="ctl-btn" :data-mcp-tools="row.name" @click="toggleMcpTools(row.name)">{{ t("set.mcp.tools") }}</button>
                  <button class="ctl-btn" :data-mcp-edit="row.name" @click="editMcp(row.name)">{{ t("set.mcp.edit") }}</button>
                  <button class="ctl-btn" :data-mcp-rm="row.name" @click="removeMcp(row.name)">{{ t("set.mcp.remove") }}</button>
                </div>
              </div>
              <div v-if="mcpToolsOpen === row.name" class="mcp-tools-panel" :data-mcp-tools-panel="row.name">
                <div class="mcp-codemode" :data-mcp-codemode-row="row.name">
                  <div class="mcp-codemode-text">
                    <div class="mcp-codemode-title">{{ t("set.mcp.codemode") }}</div>
                    <div class="mcp-codemode-desc">{{ t("set.mcp.codemodeDesc") }}</div>
                  </div>
                  <button
                    class="switch"
                    :class="{ on: codeModeOf(row.name) }"
                    role="switch"
                    :aria-checked="codeModeOf(row.name)"
                    :aria-label="t('set.mcp.codemode')"
                    :data-mcp-codemode="row.name"
                    @click="setMcpCodeMode(row.name, !codeModeOf(row.name))"
                  >
                    <span class="knob" />
                  </button>
                </div>
                <template v-for="view in [mcpToolsView(row.name)]" :key="row.name">
                  <div v-if="view.kind === 'loading'" class="mcp-tools-hint" data-mcp-tools-loading>{{ t("set.mcp.toolsLoading") }}</div>
                  <div v-else-if="view.kind === 'error'" class="mcp-tools-hint err" data-mcp-tools-error>
                    <span>{{ t("set.mcp.toolsFailed") }}{{ view.error }}</span>
                    <button class="ctl-btn" :data-mcp-tools-retry="row.name" @click="loadMcpTools(row.name)">{{ t("set.mcp.toolsRetry") }}</button>
                  </div>
                  <div v-else-if="view.kind === 'empty'" class="mcp-tools-hint" data-mcp-tools-empty>{{ t("set.mcp.toolsEmpty") }}</div>
                  <template v-else>
                    <div class="mcp-tools-head">{{ t("set.mcp.toolsCount", { count: String(view.tools.length) }) }}</div>
                    <ul class="mcp-tools-list">
                      <li v-for="tool in view.tools" :key="tool.name" :data-mcp-tool="tool.name">
                        <code class="mcp-tool-name">{{ tool.name }}</code>
                        <span v-if="tool.description" class="mcp-tool-desc" :title="tool.description">{{ tool.description }}</span>
                      </li>
                    </ul>
                  </template>
                </template>
              </div>
            </template>
            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.mcp.addServer") }}</div>
                <div class="line-sub">{{ t("set.mcp.addServerDesc") }}</div>
              </div>
              <button class="ctl-btn" data-add-mcp @click="addMcp">{{ t("set.mcp.add") }}</button>
            </div>
            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.mcp.importEntry") }}</div>
                <div class="line-sub">{{ t("set.mcp.importEntryDesc") }}</div>
              </div>
              <button class="ctl-btn" data-mcp-import :disabled="mcpScanning" @click="startMcpImport">
                {{ t(mcpScanning ? "set.mcp.importScanning" : "set.mcp.importScan") }}
              </button>
            </div>
          </div>

          <h3>{{ t("set.mcp.manualTitle") }}</h3>
          <p class="page-sub">{{ t("set.mcp.manualSub") }}</p>
          <div class="card">
            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.mcp.configFile") }}</div>
                <div class="line-sub mcp-path" data-config-path :title="configFile?.path">
                  {{ configFile ? homePath(configFile.path, paths?.home) : t("set.mcp.configResolving") }}
                </div>
              </div>
              <!-- MiMo 26.920 puts the config page's 复制路径 and 打开 on this row too. -->
              <div class="mcp-ctrl">
                <button class="ctl-btn" data-config-copy-path :disabled="!configFile" @click="copyConfigPath">{{ t("set.config.copyPath") }}</button>
                <button class="ctl-btn" data-mcp-config-open :disabled="!configFile" @click="openConfigFile">{{ t("files.open") }}</button>
              </div>
            </div>
          </div>
          <p class="page-sub mcp-example-label">{{ t("set.mcp.exampleLabel") }}</p>
          <pre class="mcp-example" data-mcp-example><code>{{ MCP_EXAMPLE }}</code></pre>
        </template>

        <template v-else-if="section === 'environment' && configuring">
          <!-- MiMo's detail: capped at 820, a plain back link, plain labels, the local card with its folder icon. -->
          <div class="env-detail" data-env-detail>
            <button class="env-back" data-env-back @click="leaveEnvironment">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="m15 18-6-6 6-6" />
              </svg>
              {{ t("set.envBack") }}
            </button>
            <div class="env-flabel">{{ t("set.localEnv") }}</div>
            <div class="env-local" data-env-local>
              <svg class="env-local-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true">
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              </svg>
              <div class="env-local-text">
                <div class="env-local-name">{{ projectName(configuring, app.config?.projectNames) }}</div>
                <div class="env-local-path" :title="configuring">{{ configuring }}</div>
              </div>
            </div>
            <div class="env-flabel">{{ t("set.envName") }}</div>
            <input v-model="envName" class="env-input" data-env-name :placeholder="t('set.envNamePlaceholder')" spellcheck="false" />
            <div class="env-save-row">
              <button class="ctl-btn env-save" :class="{ dirty: envDirty }" data-env-save :disabled="!envDirty" @click="saveEnv">{{ t("set.envSave") }}</button>
            </div>
          </div>
          <!-- MiMo's leave guard: not destructive, so the plain confirm button. -->
          <Teleport to="body">
            <ConfirmDialog
              v-if="pendingLeave"
              :title="t('set.envLeaveTitle')"
              :body="t('set.envLeaveBody')"
              :confirm-label="t('set.envLeaveOk')"
              :danger="false"
              @confirm="confirmLeave"
              @close="pendingLeave = undefined"
            />
          </Teleport>
        </template>

        <template v-else-if="section === 'environment'">
          <h2>{{ t("set.environment") }}</h2>
          <p class="page-sub">{{ t("set.environmentSub") }}</p>

          <div class="sec-row">
            <h3>{{ t("set.selectProject") }}</h3>
            <button class="ctl-btn add-project" data-env-add @click="addProject">{{ t("set.addProject") }}</button>
          </div>
          <div class="card env-projects">
            <div v-for="directory in envProjects" :key="directory" class="line env-project" :data-env-project="directory">
              <div class="line-text">
                <!-- MiMo's sr-ic folder, 18 square on the shared 1.7 stroke and inline with the name. -->
                <div class="line-title env-project-name">
                  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M3.25 7.25A1.75 1.75 0 0 1 5 5.5h3.9l2 2h8.35a1.75 1.75 0 0 1 1.75 1.75v7.5a1.75 1.75 0 0 1-1.75 1.75H5a1.75 1.75 0 0 1-1.75-1.75Z"
                      stroke="currentColor"
                      stroke-width="1.7"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                  {{ projectName(directory, app.config?.projectNames) }}
                </div>
                <div class="line-sub path">{{ directory }}</div>
              </div>
              <!-- MiMo's pair: secondary sm buttons 34 wide, a 16px trash that reddens on hover, then a text 「+」, 10 apart. -->
              <span class="env-ctrl">
                <button
                  class="ctl-btn env-icon env-del"
                  data-act="remove"
                  :aria-label="t('set.removeProject')"
                  v-tip="{ label: t('set.removeProject') }"
                  @click="removingProject = directory"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
                  </svg>
                </button>
                <button
                  class="ctl-btn env-icon env-plus"
                  data-act="configure"
                  :aria-label="t('set.configureProject')"
                  v-tip="{ label: t('set.configureProject') }"
                  @click="configure(directory)"
                >
                  +
                </button>
              </span>
            </div>
            <div v-if="!envProjects.length" class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.noProjects") }}</div>
                <div class="line-sub">{{ t("set.noProjectsSub") }}</div>
              </div>
            </div>
          </div>

          <div class="sec-row">
            <h3>{{ t("set.worktrees") }}</h3>
            <button
              class="env-refresh"
              data-env-refresh
              :aria-label="t('set.refreshWorktrees')"
              v-tip="{ label: t('set.refreshWorktrees') }"
              @click="refreshTrees"
            >
              <!-- MiMo's refresh: the arc stops where the arrow head starts, and the head is 5 across. -->
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M21 12A9 9 0 1 1 18.36 5.64" />
                <path d="M16 9h5V4" />
              </svg>
            </button>
          </div>
          <p v-if="!treesLoaded" class="wt-status wt-loading">{{ t("set.loading") }}</p>
          <!-- MiMo's empty state is a card of its own: a 14/500 title over a 13px muted line. -->
          <div v-else-if="!trees.length" class="card wt-empty" data-wt-empty>
            <div class="wt-empty-title">{{ t("set.noWorktreesTitle") }}</div>
            <div class="wt-empty-desc">{{ t("set.noWorktreesSub") }}</div>
          </div>
          <template v-else>
            <p class="wt-status wt-count">{{ t("set.worktreeCount", { count: trees.length }) }}</p>
            <div class="card wt-list">
              <div v-for="tree in trees" :key="tree.directory" class="line wt-row">
                <span class="wt-name" :title="tree.name">{{ tree.name }}</span>
                <!-- A detached HEAD has no branch, and MiMo then draws no branch tag. -->
                <span v-if="tree.branch" class="wt-tag" data-wt-branch>{{ tree.branch }}</span>
                <span class="wt-tag">{{ t("set.worktreeProject", { name: projectName(tree.project, app.config?.projectNames) }) }}</span>
                <span class="wt-path" :title="tree.directory">{{ tree.directory }}</span>
              </div>
            </div>
          </template>

          <Teleport to="body">
            <ConfirmDialog
              v-if="removingProject"
              :title="t('set.removeProject')"
              :body="t('set.removeProjectBody', { name: projectName(removingProject, app.config?.projectNames) })"
              :confirm-label="t('set.removeProjectOk')"
              :danger="false"
              @confirm="removeProject"
              @close="removingProject = undefined"
            />
          </Teleport>
        </template>

        <template v-else-if="section === 'usage'">
          <h2>{{ t("set.nav.usage") }}</h2>
          <p class="page-sub">{{ t("set.usageSub") }}</p>
          <!-- Every figure below covers the same days, counted on this machine's calendar. -->
          <p class="page-sub" data-usage-window>{{ t("set.usageWindow", { n: String(usage?.days ?? 14) }) }}</p>
          <!-- These two cards hold figures rather than rows, so the block inside carries the row's own 16. -->
          <div class="card">
            <div class="usage-block">
              <div class="totals">
                <div class="total">
                  <span class="total-value" data-usage-total-cost>{{ usage ? spent({ usage: usage.total, priced: usage.priced, unpriced: usage.unpriced }) : money.format(0) }}</span>
                  <span class="total-name">{{ t("context.usage.cost") }}</span>
                </div>
                <div class="total">
                  <span class="total-value">{{ compactTokens(usage?.total.input ?? 0) }}</span>
                  <span class="total-name">{{ t("set.usageInput") }}</span>
                </div>
                <div class="total">
                  <span class="total-value">{{ compactTokens(usage?.total.output ?? 0) }}</span>
                  <span class="total-name">{{ t("set.usageOutput") }}</span>
                </div>
                <div class="total">
                  <span class="total-value">{{ usage?.turns ?? 0 }}</span>
                  <span class="total-name">{{ t("set.usageTurns") }}</span>
                </div>
              </div>
              <p v-if="usage?.priced && usage.unpriced" class="line-sub" data-usage-partly-priced>{{ t("set.usagePartlyPriced") }}</p>
            </div>
          </div>

          <h3>{{ t("set.usageByDay", { n: String(usage?.days ?? 14) }) }}</h3>
          <div class="card">
            <div class="usage-block">
              <div v-for="day in usage?.byDay ?? []" :key="day.key" class="day">
                <span class="day-name">{{ dayLabel(day.key) }}</span>
                <span class="day-bar">
                  <span
                    class="day-fill"
                    :style="{
                      width:
                        Math.max(2, ((day.usage.input + day.usage.output) / busiestDay) * 100) + '%',
                    }"
                  />
                </span>
                <span class="day-value">{{ compactTokens(day.usage.input + day.usage.output) }}</span>
                <span class="day-cost">{{ spent(day) }}</span>
              </div>
              <p v-if="usage && !usage.byDay.length" class="line-sub">{{ t("set.usageNone") }}</p>
            </div>
          </div>

          <h3>{{ t("set.usageByModel") }}</h3>
          <div class="card">
            <div v-for="entry in usage?.byModel ?? []" :key="entry.key" class="line">
              <div class="line-text">
                <div class="line-title">{{ entry.key }}</div>
                <div class="line-sub">
                  {{ t("set.usageTurnCount", { n: String(entry.turns) }) }} ·
                  {{ compactTokens(entry.usage.input + entry.usage.output) }}
                </div>
              </div>
              <span class="total-value small" data-usage-model-cost>{{ spent(entry) }}</span>
            </div>
            <p v-if="usage && !usage.byModel.length" class="line-sub">{{ t("set.usageNone") }}</p>
          </div>
        </template>

        <template v-else-if="section === 'updates'">
          <h2>{{ t("set.nav.updates") }}</h2>
          <!--
            MiMo's update page: one row for the version, whose button checks,
            reads 检查中… while it does, and becomes 重启更新 once a new version
            is downloaded. MCode has no update service, so the address to look at
            is a second row; without it the check says so.
          -->
          <div class="card">
            <div class="line" data-update-row>
              <div class="line-text">
                <div class="line-title">{{ t("set.version") }}</div>
                <div class="line-sub">
                  MCode {{ app.version }}
                  <span v-if="updatePhase === 'ready'" class="update-hint" data-update-install-hint>{{ t("set.updateInstallHint") }}</span>
                </div>
              </div>
              <!-- MiMo's button follows the capsule's phase: 重启更新, 更新中… (disabled), or 重试. -->
              <button
                v-if="updatePhase !== 'idle'"
                class="ctl-btn update-install"
                data-update-install
                :data-update-phase="updatePhase"
                :disabled="updatePhase === 'installing'"
                @click="installUpdate()"
              >
                {{ t(updatePhase === "installing" ? "update.pillInstalling" : updatePhase === "failed" ? "update.pillRetry" : "set.restartUpdate") }}
              </button>
              <button v-else class="ctl-btn" data-check-update :disabled="updateChecking" @click="emit('check-updates')">
                {{ t(updateChecking ? "set.checking" : "update.check") }}
              </button>
            </div>

            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.updateFeed") }}</div>
                <div class="line-sub">{{ t("set.updateFeedSub") }}</div>
              </div>
              <input
                class="field font-field"
                :value="app.config?.updateFeed ?? ''"
                placeholder="https://example.com/latest.json"
                spellcheck="false"
                @change="app.patchConfig({ updateFeed: ($event.target as HTMLInputElement).value.trim() })"
              />
            </div>

            <!-- MCode's own row, not MiMo's: the notices its bundled score synth and soundfont require. -->
            <div class="line" data-licenses-row>
              <div class="line-text">
                <div class="line-title">{{ t("set.licenses") }}</div>
                <div class="line-sub">{{ t("set.licensesSub") }}</div>
              </div>
              <button class="ctl-btn" data-licenses-open @click="licensesOpen = true">{{ t("set.licensesView") }}</button>
            </div>
          </div>
          <ThirdPartyDialog v-if="licensesOpen" @close="licensesOpen = false" />

        </template>

        <div v-else-if="section === 'keys'" class="keys-page" data-shortcuts-page>
          <h2>{{ t("set.shortcuts") }}</h2>
          <!--
            MiMo's shortcut page: a search bar that searches by words or, with
            the keyboard button, by the chord pressed; one table of commands and
            their bindings; and reset-all at the foot.
          -->
          <div class="keys-search" data-shortcuts-searchbar>
            <div v-if="keySearch" class="keys-search-capture" data-key-search-capture>
              <span v-if="keySearchChord" class="keys-search-chord">{{ shownChord(keySearchChord) }}</span>
              <template v-else>{{ t("set.keys.pressToSearch") }}</template>
            </div>
            <input
              v-else
              v-model="keyFilter"
              class="keys-search-input"
              :placeholder="t('key.search')"
              spellcheck="false"
              data-key-search-input
            />
            <button
              v-if="keySearch ? keySearchChord : keyFilter"
              type="button"
              class="keys-search-clear"
              :aria-label="t('set.keys.clear')"
              v-tip="{ label: t('set.keys.clear'), placement: 'top' }"
              data-key-search-clear
              @click="keySearch ? (keySearchChord = undefined) : (keyFilter = '')"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
            <button
              type="button"
              class="keys-search-mode"
              :class="{ on: keySearch }"
              :aria-label="t(keySearch ? 'set.keys.useTextSearch' : 'set.keys.useKeySearch')"
              v-tip="{ label: t(keySearch ? 'set.keys.useTextSearch' : 'set.keys.useKeySearch'), placement: 'top' }"
              data-key-search-toggle
              @click="toggleKeySearch"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true">
                <rect x="1.8" y="4.5" width="12.4" height="7.5" rx="1.6" />
                <path d="M4.5 7.2h.5M7 7.2h2M11 7.2h.5M5 9.6h6" />
              </svg>
            </button>
          </div>

          <!-- KS7: only the list scrolls; the title, search and footer stay put. -->
          <div class="keys-list">
            <div class="keys-table" data-shortcuts-list>
              <div class="keys-cols">
                <span class="keys-col-command">{{ t("set.keys.colCommand") }}</span>
                <span>{{ t("set.keys.colBinding") }}</span>
              </div>
              <div v-for="shortcut in shortcutRows" :key="shortcut.id" class="keys-row" :data-shortcut-id="shortcut.id">
                <div class="keys-command">
                  <div class="keys-label">{{ shortcut.title }}</div>
                  <div v-if="shortcut.desc" class="keys-desc" data-shortcut-desc>{{ shortcut.desc }}</div>
                </div>
                <div class="keys-binding">
                  <div v-if="recording === shortcut.id" class="keys-record">
                    <div class="keys-record-line">
                      <span class="keys-record-box" :class="{ conflict: recordConflict }" data-record-box>
                        {{ recordChord ? shownChord(recordChord) : t("set.keys.pressKey") }}
                      </span>
                      <button
                        v-if="recordChord && !recordConflict"
                        type="button"
                        class="keys-record-confirm"
                        data-record-confirm
                        @click="confirmRecord"
                      >
                        {{ t("set.keys.confirm") }}
                      </button>
                      <button type="button" class="keys-record-cancel" data-record-cancel @click="cancelRecord">
                        {{ t("common.cancel") }}
                      </button>
                    </div>
                    <span v-if="recordConflict" class="keys-record-conflict" data-record-conflict>
                      {{ t("set.keys.conflict", { label: commandLabel(recordConflict) }) }}
                    </span>
                  </div>
                  <template v-else>
                    <kbd v-if="boundKeys(shortcut)" class="keys-kbd" data-binding>{{ shownChord(boundKeys(shortcut)) }}</kbd>
                    <span v-else class="keys-unassigned" data-binding-unassigned>{{ t("set.keys.unassigned") }}</span>
                    <button
                      type="button"
                      class="keys-edit"
                      :aria-label="t('set.keys.edit')"
                      v-tip="{ label: t('set.keys.edit'), placement: 'top' }"
                      data-edit-shortcut
                      @click="startRecord(shortcut.id)"
                    >
                      <!-- MiMo draws this pencil filled, so MCode's own outline is filled rather than stroked. -->
                      <svg viewBox="0 0 16 16" fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" aria-hidden="true">
                        <path d="M10.9 1.75 14.25 5.1 6.15 13.2H2.8V9.85ZM10.9 3.63 4.13 10.4v1.47H5.6L12.37 5.1ZM2.8 14.25h10.4v1.35H2.8z" />
                      </svg>
                    </button>
                  </template>
                </div>
                <div class="keys-end">
                  <button
                    v-if="customBinding(shortcut.id)"
                    type="button"
                    class="keys-icon"
                    :aria-label="t('set.keys.resetOne', { label: shortcut.title })"
                    v-tip="{ label: t('set.keys.resetOne', { label: shortcut.title }), placement: 'top' }"
                    data-reset-shortcut
                    @click="resetBinding(shortcut.id)"
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M3 8.2a5 5 0 1 0 1.6-3.7M3.2 2.5v2.8H6" />
                    </svg>
                  </button>
                  <button
                    v-else-if="boundKeys(shortcut)"
                    type="button"
                    class="keys-icon danger"
                    :aria-label="t('set.keys.delete')"
                    v-tip="{ label: t('set.keys.delete'), placement: 'top' }"
                    data-delete-shortcut
                    @click="deleteBinding(shortcut.id)"
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M3 4.5h10M6.5 2.5h3M4.5 4.5l.5 9h6l.5-9" />
                    </svg>
                  </button>
                </div>
              </div>
              <div v-if="!shortcutRows.length" class="keys-empty" data-shortcuts-empty>{{ t("set.keys.noMatch") }}</div>
            </div>
          </div>

          <div class="keys-foot">
            <button class="ctl-btn" data-reset-all-shortcuts :title="t('set.keys.resetAll')" @click="resetAllBindings">{{ t("set.keys.resetAll") }}</button>
          </div>
        </div>

        <!-- Archive -->
        <!--
          MiMo 26.920's lab, one card per switch. Only session chat is here:
          its other two switches (Git version preview, the uncommitted-changes
          reminder) ship off and MCode has neither behaviour behind them.
        -->
        <template v-else-if="section === 'lab'">
          <h2>{{ t("set.nav.lab") }}</h2>
          <div class="card" data-lab-session-chat>
            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.lab.sessionChat") }}</div>
                <div class="line-sub">{{ t("set.lab.sessionChatSub") }}</div>
              </div>
              <button
                class="switch"
                :class="{ on: app.config?.sessionChat !== false }"
                role="switch"
                :aria-checked="app.config?.sessionChat !== false"
                :aria-label="t('set.lab.sessionChat')"
                data-session-chat-switch
                @click="app.patchConfig({ sessionChat: app.config?.sessionChat === false })"
              >
                <span class="knob" />
              </button>
            </div>
          </div>
        </template>

        <template v-else-if="section === 'archive'">
          <!-- MiMo's header: the page title, and 批量管理 at its far end while anything is archived. -->
          <div class="page-head">
            <h2>{{ t("set.nav.archive") }}</h2>
            <button
              v-if="archived.length"
              class="archived-manage"
              data-archived-manage
              @click="selecting ? stopSelecting() : (selecting = true)"
            >
              {{ selecting ? t("set.batchDone") : t("set.batchManage") }}
            </button>
          </div>

          <!-- MiMo's empty state is a card holding one row, not a loose note. -->
          <div v-if="!archived.length" class="card">
            <div class="line" data-archived-empty>
              <div class="line-text">
                <div class="line-title">{{ t("set.archivedEmptyTitle") }}</div>
                <div class="line-sub">{{ t("set.archivedEmptyDesc") }}</div>
              </div>
            </div>
          </div>

          <template v-else>
            <div v-if="selecting" class="batch-bar">
              <button class="batch-all" @click="toggleAllPicked">
                {{ allPicked ? t("set.selectNone") : t("set.selectAll") }}
              </button>
              <span class="batch-count">{{ t("set.selectedCount", { n: String(pickedLive.length) }) }}</span>
              <span class="batch-acts">
                <button class="ctl-btn" data-batch="restore" :disabled="!pickedLive.length" @click="restorePicked">
                  {{ t("set.restoreN", { n: String(pickedLive.length) }) }}
                </button>
                <button
                  class="archived-delete"
                  data-batch="delete"
                  :disabled="!pickedLive.length"
                  @click="confirmingDelete = { ids: [...pickedLive] }"
                >
                  {{ t("set.deleteN", { n: String(pickedLive.length) }) }}
                </button>
              </span>
            </div>

            <div class="card">
              <div v-for="session in archived" :key="session.id" class="line archived-row" :data-archived-row="session.id">
                <div class="line-text">
                  <!-- In select mode the checkbox and the title are the toggle; the rest of the row is not. -->
                  <div
                    class="line-title archived-title"
                    :class="{ picking: selecting }"
                    :role="selecting ? 'checkbox' : undefined"
                    :aria-checked="selecting ? pickedLive.includes(session.id) : undefined"
                    :tabindex="selecting ? 0 : undefined"
                    @click="selecting && togglePick(session.id)"
                    @keydown.space.prevent="selecting && togglePick(session.id)"
                  >
                    <span v-if="selecting" class="check" :class="{ on: pickedLive.includes(session.id) }" aria-hidden="true">
                      <svg v-if="pickedLive.includes(session.id)" width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path d="M2.5 6.2 5 8.6l4.5-5" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
                      </svg>
                    </span>
                    <span class="archived-name">{{ sessionTitle(session.title) }}</span>
                  </div>
                  <div class="line-sub">{{ archivedDescription(session) }}</div>
                </div>
                <div v-if="!selecting" class="confirm">
                  <button class="ctl-btn" data-archived-restore @click="restoreOne(session.id)">{{ t("set.unarchive") }}</button>
                  <button
                    class="archived-delete"
                    data-archived-delete
                    @click="confirmingDelete = { ids: [session.id], title: sessionTitle(session.title) }"
                  >
                    {{ t("set.archivedDelete") }}
                  </button>
                </div>
              </div>
            </div>
          </template>

          <!-- MCode's own undo for closed projects, kept below MiMo's list under its own heading. -->
          <h3 class="closed-head">{{ t("set.closedProjects") }}</h3>
          <div class="card" data-closed-projects>
            <div v-if="!closedProjects.length" class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.archivedEmptyTitle") }}</div>
                <div class="line-sub">{{ t("set.closedSub") }}</div>
              </div>
            </div>
            <div v-for="directory in closedProjects" :key="directory" class="line">
              <div class="line-text">
                <div class="line-title">{{ projectName(directory, app.config?.projectNames) }}</div>
                <div class="line-sub">{{ directory }}</div>
              </div>
              <div class="confirm">
                <button class="ctl-btn" @click="reopenProject(directory)">{{ t("set.reopen") }}</button>
              </div>
            </div>
          </div>

          <Teleport to="body">
            <ConfirmDialog
              v-if="confirmingDelete"
              :title="
                confirmingDelete.title !== undefined
                  ? t('set.deleteOneTitle')
                  : t('set.deleteN', { n: String(confirmingDelete.ids.length) })
              "
              :body="
                confirmingDelete.title !== undefined
                  ? t('set.deleteOneBody', { title: confirmingDelete.title })
                  : t('set.deleteManyBody', { n: String(confirmingDelete.ids.length) })
              "
              :confirm-label="t('set.archivedDelete')"
              @confirm="confirmRemove"
              @close="confirmingDelete = undefined"
            />
          </Teleport>
        </template>

        <!-- Models: MiMo 26.920's provider tabs and forms, a page of its own. -->
        <ModelsPage v-else />
            </div>
    </div>
  </div>

</template>

<style scoped>
/*
 * The settings page's inputs, measured on opencode's font rows: `220x28`,
 * radius 6, resting on the page's own surface (`rgb(22, 22, 22)`, which is
 * `--surface-raised` here) with no ring or shadow, the value in text-strong
 * at `13px/440` and `-0.04px`, the placeholder in text-weak. The shared
 * `.field` underneath sits on `--surface-base` with an elevation, which is
 * right where it is used and wrong here.
 */
/* The two size rows: a narrow field with its unit beside it, as MiMo draws them. */
.size-field {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

/* MiMo's th-numin: 64 by 26, a 1px line border, 9 round, right-aligned 14px on the input fill. */
.size-input {
  box-sizing: border-box;
  width: 64px;
  height: calc(26px * var(--ui-font-scale, 1));
  padding: 0 10px;
  color: var(--text-strong);
  background: #ffffff;
  border: 1px solid #f3efeb;
  border-radius: 9px;
  box-shadow: none;
  font-size: calc(14px * var(--ui-font-scale, 1));
  text-align: end;
  font-variant-numeric: tabular-nums;
}

.unit {
  color: var(--text-base);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

:root[data-theme="dark"] .size-input {
  background: #181818;
  border-color: #3d3d3d;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .size-input {
    background: #181818;
    border-color: #3d3d3d;
  }
}

.font-field {
  width: 220px;
  color: var(--text-strong);
  background: var(--surface-raised);
  box-shadow: none;
  letter-spacing: -0.04px;
  text-align: start;
}

.font-field::placeholder {
  color: var(--text-weak);
}

.overlay {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--scrim);
}

/* The shell's own layout; its size, fills and lift are MiMo's, further down. */
.dialog {
  display: flex;
  overflow: hidden;
}

/*
 * The navigation column's shape. Everything it is made of - its width, fills,
 * insets and type - is MiMo's and lives in the settings-dialog block below;
 * what is left here is the layout the rows need in any of those skins.
 */
.nav {
  display: flex;
  flex-direction: column;
}

.nav-item {
  display: flex;
  /* The navigation is a flex column; without this a row measures a pixel short
     of what it declares - the same squeeze the terminal's new-tab button had. */
  flex-shrink: 0;
  align-items: center;
  width: 100%;
  text-align: start;
  transition: background 0.12s, color 0.12s;
}

.nav-ico {
  flex-shrink: 0;
  transition: color 0.12s;
}

/* settings-v2-tab-header is 40/40/32 and the body below it 0/40/40, so the
   page carries 40 on every side and the title's own gap makes up the rest. */
.content {
  flex: 1;
  padding: 40px;
  overflow-y: auto;
}

/* Both levels are the same size and weight in the reference; what separates a
   section from the page is the space above it, not the type. */
h2 {
  margin: 0 0 32px;
  color: var(--text-strong);
  font-size: calc(15px * var(--ui-font-scale, 1));
  font-weight: 640;
  line-height: 1;
}

/*
 * Thirty-six between sections and twenty under a section's own title: the
 * reference's body has `gap: 36px`, its section title `padding-bottom: 8px`
 * inside a section whose `gap` is 16, and the list after the title pulls 4 back.
 */
/* The reference's body gap falls between sections, so the first title sits on
   the header's own 32 rather than adding another 36 to it. */
h2 + h3 {
  margin-top: 0;
}

h3 {
  margin: 36px 0 20px;
  color: var(--text-strong);
  font-size: calc(15px * var(--ui-font-scale, 1));
  font-weight: 640;
  line-height: 1;
}

/*
 * MiMo's sc-sub with mt-[8px]: a line under the card it belongs to, not pulled
 * up into it. 13px in mut, as every other sub-line on these pages.
 */
.note {
  margin: 8px 0 14px;
  color: var(--text-base);
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: 1.6;
}

.card {
  padding: 0 20px;
  /*
   * The same fill as the page, raised by its shadow. --shadow-md is this app's
   * name for elevation/raised, layer for layer: 0 2px 4px and 0 1px 2px of
   * alpha-dark-30, a half-pixel ring of alpha-light-16, and a half-pixel lip of
   * alpha-light-6.
   */
  background: var(--surface-raised);
  box-shadow: var(--shadow-md);
  border-radius: 8px;
  overflow: hidden;
}

/*
 * Twenty above and below, nothing at the sides - the card carries the side
 * inset so the divider runs the full width of it rather than stopping short.
 */
/*
 * Wrapping is what keeps a row inside the card at the window's 720px minimum.
 * The text column is `flex: 1` off a zero basis, so it never asks for room of
 * its own and the control alone decides whether the row fits; when it does not,
 * the control drops to a second line instead of being sliced off by the card's
 * `overflow: hidden`. A row that fits is laid out exactly as before - the text
 * column still swallows all the free space, so there is nothing to wrap.
 */
.line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 20px 0;
  border-bottom: 0.5px solid var(--border-weak);
}

/* Nothing to divide from below the last one. */
.line:last-child {
  border-bottom: none;
}

.line:last-child {
  border-bottom: none;
}

/*
 * The reference's settings-v2-row-copy: a column with 8px between the title and
 * the line under it, allowed to shrink so a long description wraps instead of
 * pushing the control off the row. Without the gap its rows measured 69 tall
 * against the reference's 77, which is exactly the 8 - and this element carried
 * no rule at all.
 */
.line-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 8px;
  /*
   * A column off a zero basis asks for nothing, so a control that fits beside
   * it is kept there however little is left for the words - in Chinese, at the
   * 720px minimum, a server's name was set one syllable to the line next to
   * three short buttons. Asking for this much first sends the control to a line
   * of its own instead, and `100%` keeps the ask inside a narrower card.
   */
  min-width: min(180px, 100%);
}

.line-title {
  color: var(--text-strong);
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 530;
  line-height: 1;
  letter-spacing: -0.04px;
}

.line-sub {
  /* The reference pulls its description in on both sides rather than pushing it
     down, which is what sets the title and the line under it 4.5px apart. */
  margin-block: -3.5px;
  color: var(--text-base);
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 440;
  line-height: calc(20px * var(--ui-font-scale, 1));
}

/* Pill switch: filled and light when on, hollow when off. */
/*
 * A small squared toggle rather than a rounded pill.
 *
 * The knob is the same height as the track and only its corners are eased, so
 * the control reads as a switch that has moved rather than as a dot sliding
 * inside a capsule.
 */
/*
 * opencode's v2 switch, measured on the running app rather than read from its
 * stylesheet - the stylesheet still carries the v1 rules (28x16, a border,
 * radius 3, a 14px thumb travelling 12) and those are what this was built
 * from. The live control is `24x16`, no border, radius 4, on bg-layer-04
 * (grey-700 dark / grey-400 light, which is exactly `--avatar-gray` in both
 * schemes here); the thumb is `12x12`, radius 2, sitting 2 in from the left
 * and travelling 8. Checked, the track is bg-accent (blue-600, `--primary`)
 * under a 0-to-10% white gradient, and the thumb is grey-300 under a
 * white-to-clear depth gradient. grey-300 is #eee in both schemes and no
 * token here is, so it is written out.
 */
.switch {
  position: relative;
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  width: 24px;
  height: 16px;
  background: var(--avatar-gray);
  border: 0;
  border-radius: 4px;
  transition: background-color 0.15s;
}
.switch:hover {
  background:
    linear-gradient(0deg, var(--surface-hover), var(--surface-hover)),
    linear-gradient(180deg, #fff0 0%, #fff3 100%),
    var(--avatar-gray);
}
.switch.on {
  background: linear-gradient(180deg, #fff0 0%, #ffffff1a 100%), var(--primary);
}
.knob {
  position: absolute;
  top: 2px;
  width: 12px;
  height: 12px;
  background: #eeeeee;
  border: 0;
  border-radius: 2px;
  inset-inline-start: 2px;
  transition: inset-inline-start 0.15s, background-color 0.15s;
}
.switch.on .knob {
  background: linear-gradient(180deg, #fff 0%, #fff0 100%), #eeeeee;
  inset-inline-start: 10px;
}

/*
 * The buttons keep their own width while the row has room for them, and the
 * pair is pushed to the end by its auto margin rather than by whatever grew
 * beside it - so it still sits at the right once it has wrapped onto a line of
 * its own. Shrinking is left on: the only time there is a deficit to shrink
 * against is a line the pair is alone on and still too wide for, and then it
 * breaks between buttons instead of running out of the card.
 */
.ctl-pair {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  margin-inline-start: auto;
}

.ctl-btn {
  flex-shrink: 0;
  max-width: 320px;
  height: calc(30px * var(--ui-font-scale, 1));
  padding: 0 10px;
  color: var(--text-strong);
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: var(--radius-md);
  font-size: calc(12.5px * var(--ui-font-scale, 1));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/*
 * Faded rather than recoloured. The dark rule for `.ctl-btn` sets the strong
 * ink on the plain element and outranks this one, so in the dark a disabled
 * button drew in the same white as an enabled one on the same fill - only the
 * missing hover wash told them apart, and only once the pointer was on it. The
 * primary variant below already fades, and opacity is the one answer no theme
 * rule can take away.
 */
.ctl-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

/* MiMo's 重启更新 is its primary button - the same pair the models page saves with. */
.ctl-btn.update-install {
  color: #ffffff;
  background: #151c13;
}

:root[data-theme="dark"] .ctl-btn.update-install {
  color: #0d0d0d;
  background: #ececec;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .ctl-btn.update-install {
    color: #0d0d0d;
    background: #ececec;
  }
}

.update-hint {
  display: block;
}

.ctl-btn.update-install:disabled {
  opacity: 0.4;
}

/*
 * MiMo's MCP page: under each name its kind and a status pill (6px dot, 11px,
 * round, tinted by state), a switch and three buttons at the end, and the tools
 * a server offers in a panel under its row; then 手动配置 with the config file
 * on one line and an example block.
 */
.mcp-row-desc {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.mcp-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 7px;
  color: var(--text-base);
  border: 1px solid var(--border-weak);
  border-radius: 999px;
  font-size: calc(11px * var(--ui-font-scale, 1));
  line-height: 1.4;
}

.mcp-status-dot {
  flex: none;
  width: 6px;
  height: 6px;
  background: currentColor;
  border-radius: 50%;
}

.mcp-status.ok {
  color: var(--text-success);
  background: color-mix(in srgb, var(--text-success) 8%, transparent);
  border-color: color-mix(in srgb, var(--text-success) 35%, transparent);
}

/*
 * MiMo's own failure pill: --color-err, one value for both schemes, under an
 * 8% fill and a 35% ring. --text-critical is that same --color-err.
 */
.mcp-status.err {
  color: var(--text-critical);
  background: color-mix(in srgb, var(--text-critical) 8%, transparent);
  border-color: color-mix(in srgb, var(--text-critical) 35%, transparent);
}

.mcp-status.warn {
  color: var(--text-warning);
  background: color-mix(in srgb, var(--text-warning) 8%, transparent);
  border-color: color-mix(in srgb, var(--text-warning) 35%, transparent);
}

/* The switch and its buttons, held to the end of the row the way `.ctl-pair` is. */
.mcp-ctrl {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  margin-inline-start: auto;
}

/* MiMo's mcp-tools-panel: pulled 6 up under the row it belongs to, inset by the
   card's own 16, and with no rule of its own - the row above already draws one. */
.mcp-tools-panel {
  margin-top: -6px;
  padding: 4px 16px 14px;
}

/* Code Mode's switch, above the tools it governs: the panel's own type, and a rule under it. */
.mcp-codemode {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border-weak);
}

.mcp-codemode-text {
  min-width: 0;
}

.mcp-codemode-title {
  color: var(--text-strong);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.mcp-codemode-desc {
  margin-top: 2px;
  color: var(--text-base);
  font-size: calc(11px * var(--ui-font-scale, 1));
  line-height: 1.45;
}

.mcp-tools-hint {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  color: var(--text-base);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

/* MiMo's tools error line is the same --color-err. */
.mcp-tools-hint.err {
  color: var(--text-critical);
}

.mcp-tools-head {
  margin-bottom: 8px;
  color: var(--text-base);
  font-size: calc(11px * var(--ui-font-scale, 1));
}

.mcp-tools-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 280px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.mcp-tools-list li {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

/*
 * MiMo draws a tool's own name in --color-txt, a step above the description
 * under it, which --text-body is.
 */
.mcp-tool-name {
  color: var(--text-body);
  font-family: var(--font-mono);
  font-size: calc(12px * var(--code-font-scale, 1));
}

.mcp-tool-desc {
  display: -webkit-box;
  overflow: hidden;
  color: var(--text-base);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 1.45;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

/* An import row's command or address wraps where it must, and the actions sit under the lists. */
.mcp-summary {
  overflow-wrap: anywhere;
}

/*
 * MiMo's shortcut page: a 12-round search bar on the card colour, a table of
 * 42% command and the binding with 14px rows 20 in, a pencil that shows on the
 * hovered row, a pulsing blue box while recording (red on a conflict), and the
 * reset or delete control in a 28px column at the end.
 */
/*
 * MiMo puts the search bar and the table on the settings card colour with the
 * card's own rule (#settings-overlay redefines both for them by name), and
 * everything drawn inside them - the column head, the row rules, a key cap, the
 * mode button - on --color-line. What was here instead was the opencode-era
 * formula, a percentage of the ink mixed into the menu surface.
 */
.keys-search {
  display: flex;
  align-items: center;
  margin-bottom: 16px;
  padding: 10px 16px;
  background: #ffffff;
  border: 1px solid #f3efeb;
  border-radius: 12px;
}

.keys-search-input,
.keys-search-capture {
  flex: 1;
  min-width: 0;
  font-size: calc(14px * var(--ui-font-scale, 1));
}

.keys-search-input {
  padding: 0;
  color: var(--text-strong);
  background: transparent;
  border: 0;
  outline: none;
}

.keys-search-input::placeholder,
.keys-search-capture {
  color: var(--text-weak);
}

.keys-search-chord {
  color: var(--text-strong);
}

.keys-search-clear {
  display: grid;
  place-items: center;
  margin-inline-end: 8px;
  color: var(--text-weak);
}

.keys-search-clear:hover {
  color: var(--text-strong);
}

.keys-search-clear svg {
  width: 14px;
  height: 14px;
}

.keys-search-mode {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  color: var(--text-weak);
  border: 1px solid #f0ebe5;
  border-radius: 6px;
}

.keys-search-mode:hover {
  color: var(--text-strong);
  border-color: var(--text-strong);
}

.keys-search-mode.on {
  color: var(--text-strong);
  background: #f8f7f5;
}

.keys-search-mode svg {
  width: 16px;
  height: 16px;
}

.keys-table {
  overflow: hidden;
  background: #ffffff;
  border: 1px solid #f3efeb;
  border-radius: 12px;
}

.keys-cols {
  display: flex;
  align-items: center;
  padding: 10px 20px;
  color: var(--text-base);
  border-bottom: 1px solid #f0ebe5;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.keys-col-command,
.keys-command {
  width: 42%;
}

.keys-row {
  display: flex;
  align-items: center;
  padding: 14px 20px;
  border-bottom: 1px solid #f0ebe5;
  transition: background-color 0.15s;
}

.keys-row:last-of-type {
  border-bottom: 0;
}

/*
 * MiMo's row hover is --color-side, which on Windows and Linux in light is the
 * warm #f8f7f5 rather than the white it is elsewhere - so it does show against
 * the card, and MCode can take it rather than keeping a mix of its own.
 */
.keys-row:hover {
  background: #f8f7f5;
}

.keys-command {
  min-width: 0;
  padding-inline-end: 16px;
  color: var(--text-base);
  font-size: calc(14px * var(--ui-font-scale, 1));
}

.keys-binding {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

/* MiMo's shortcuts page: title and search pinned, only the list scrolls, reset-all pinned at the foot. */
.content:has(> .keys-page) {
  overflow: hidden;
}

.keys-page {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.keys-page > h2,
.keys-page > .keys-search {
  flex: none;
}

.keys-list {
  flex: 1;
  min-height: 0;
  margin-inline-end: -10px;
  padding-inline-end: 0;
  overflow-y: auto;
  scrollbar-gutter: stable;
}

.keys-page > .keys-foot {
  flex: none;
  margin-top: 0;
  padding-top: 16px;
}

.keys-label {
  color: var(--text-strong);
  font-size: calc(14px * var(--ui-font-scale, 1));
}

.keys-desc {
  margin-top: 2px;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

/* MiMo's key cap sits on the code background: #f0f0f2 light, #2e2e2e dark. */
.keys-kbd {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  color: var(--text-strong);
  background: #f0f0f2;
  border: 1px solid #f0ebe5;
  border-radius: 6px;
  box-shadow: 0 1px 3px 0 #0000001a, 0 1px 2px -1px #0000001a;
  font-family: var(--font-sans);
  font-size: calc(13px * var(--ui-font-scale, 1));
}

:root[data-theme="dark"] .keys-search,
:root[data-theme="dark"] .keys-table {
  background: #282828;
  border-color: #3d3d3d;
}

:root[data-theme="dark"] .keys-cols,
:root[data-theme="dark"] .keys-row,
:root[data-theme="dark"] .keys-kbd,
:root[data-theme="dark"] .keys-search-mode,
:root[data-theme="dark"] .keys-record-cancel {
  border-color: #2e2e2e;
}

:root[data-theme="dark"] .keys-search-mode.on,
:root[data-theme="dark"] .keys-row:hover {
  background: #141414;
}

/* The shared dark border rule above outranks `.keys-search-mode:hover`, which left the toggle's border unchanged on hover. */
:root[data-theme="dark"] .keys-search-mode:hover {
  border-color: var(--text-strong);
}

:root[data-theme="dark"] .keys-kbd {
  background: #2e2e2e;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .keys-search,
  :root:not([data-theme="light"]) .keys-table {
    background: #282828;
    border-color: #3d3d3d;
  }

  :root:not([data-theme="light"]) .keys-cols,
  :root:not([data-theme="light"]) .keys-row,
  :root:not([data-theme="light"]) .keys-kbd,
  :root:not([data-theme="light"]) .keys-search-mode,
  :root:not([data-theme="light"]) .keys-record-cancel {
    border-color: #2e2e2e;
  }

  :root:not([data-theme="light"]) .keys-search-mode.on,
  :root:not([data-theme="light"]) .keys-row:hover {
    background: #141414;
  }

  :root:not([data-theme="light"]) .keys-search-mode:hover {
    border-color: var(--text-strong);
  }

  :root:not([data-theme="light"]) .keys-kbd {
    background: #2e2e2e;
  }
}

.keys-unassigned {
  color: var(--text-weak);
  font-size: calc(14px * var(--ui-font-scale, 1));
}

.keys-edit {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  color: var(--text-weak);
  border-radius: 4px;
  opacity: 0;
  transition: opacity 0.15s;
}

.keys-row:hover .keys-edit,
.keys-edit:focus-visible {
  opacity: 1;
}

.keys-edit:hover {
  color: var(--text-strong);
}

.keys-edit svg,
.keys-icon svg {
  width: 16px;
  height: 16px;
}

.keys-record {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.keys-record-line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.keys-record-box {
  display: flex;
  align-items: center;
  min-width: 90px;
  padding: 4px 12px;
  color: var(--text-interactive);
  background: color-mix(in srgb, var(--interactive) 5%, transparent);
  border: 2px solid var(--interactive);
  border-radius: 8px;
  font-size: calc(14px * var(--ui-font-scale, 1));
  animation: keys-record-pulse 2s ease-in-out infinite;
}

/*
 * A conflict is MiMo's red-500 (#fb2c36) on its own 5% wash, border and text
 * alike. MiMo's red-500 here, which is not its --color-err, so --text-critical
 * does not fit.
 */
.keys-record-box.conflict {
  color: #fb2c36;
  background: color-mix(in srgb, #fb2c36 5%, transparent);
  border-color: #fb2c36;
  animation: none;
}

@keyframes keys-record-pulse {
  50% {
    opacity: 0.5;
  }
}

.keys-record-confirm,
.keys-record-cancel {
  padding: 4px 10px;
  border-radius: 8px;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.keys-record-confirm {
  color: #fff;
  background: var(--interactive);
}

.keys-record-cancel {
  color: var(--text-weak);
  border: 1px solid #f0ebe5;
}

.keys-record-cancel:hover {
  color: var(--text-strong);
}

.keys-record-conflict {
  color: #fb2c36;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.keys-end {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  margin-inline-start: 12px;
}

.keys-icon {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  color: var(--text-weak);
  border-radius: 4px;
}

.keys-icon:hover {
  color: var(--text-strong);
}

.keys-icon.danger:hover {
  color: #fb2c36;
}

.keys-empty {
  padding: 32px 20px;
  color: var(--text-weak);
  font-size: calc(14px * var(--ui-font-scale, 1));
  text-align: center;
}

.keys-foot {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}

/*
 * The foot holds this one button, so it takes the width its words need rather
 * than the 320px other row buttons stop at - the Spanish "reset all" is 330 -
 * and wraps inside the page before it would ever be cut.
 */
.keys-foot .ctl-btn {
  max-width: 100%;
  height: auto;
  min-height: 28px;
  padding-block: 4px;
  white-space: normal;
}

/* MiMo's state tag on the AGENTS.md row: a 12px pill, green on its tint when loaded, quiet otherwise. */
.agents-tag {
  display: inline-block;
  padding: 3px 10px;
  color: var(--text-success);
  background: var(--surface-success);
  border-radius: 999px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-weight: 400;
}

.skill-path-pair {
  display: flex;
  flex-wrap: wrap;
  column-gap: 12px;
}

.agents-tag.off {
  color: var(--text-weak);
  background: color-mix(in srgb, var(--text-strong) 8%, transparent);
}

.mcp-import-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
}

.mcp-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mcp-example {
  margin: 0;
  padding: 12px 14px;
  overflow-x: auto;
  color: var(--text-strong);
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 9px;
  font-family: var(--font-mono);
  font-size: calc(12.5px * var(--code-font-scale, 1));
  line-height: 1.5;
  white-space: pre;
}

.mcp-example code {
  color: inherit;
  font: inherit;
}

/* MiMo's add / edit form: labelled 9-round fields on one card, stdio or HTTP picked in a pill pair. */
.card.mcp-form {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  padding: 16px;
}

.mcp-label {
  margin-bottom: 6px;
  color: var(--text-base);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.mcp-input {
  box-sizing: border-box;
  width: 100%;
  margin-bottom: 14px;
  padding: 10px 12px;
  color: var(--text-strong);
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: 9px;
  outline: none;
  font-family: inherit;
  font-size: calc(14px * var(--ui-font-scale, 1));
}

.mcp-input:focus {
  border-color: var(--border-strong);
}

.mcp-input:disabled {
  opacity: 0.6;
}

.mcp-input.small {
  flex: 1;
  min-width: 0;
  margin-bottom: 0;
  padding: 8px 10px;
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.mcp-types {
  display: inline-flex;
  align-self: flex-start;
  margin-bottom: 14px;
  padding: 2px;
  border: 1px solid var(--border-weak);
  border-radius: 9px;
}

.mcp-type {
  padding: 6px 14px;
  color: var(--text-base);
  border-radius: 7px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: 1;
}

.mcp-type.on {
  color: #fff;
  background: var(--interactive);
}

.mcp-pair {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.mcp-add-row {
  align-self: flex-start;
  margin-bottom: 12px;
}

.mcp-add-row.last {
  margin-bottom: 18px;
}

.mcp-hint {
  margin: 0 0 18px;
  color: var(--text-base);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 1.6;
}

.mcp-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.confirm {
  display: flex;
  flex-shrink: 0;
  gap: 8px;
}

/*
 * Three answers laid side by side, rather than a switch.
 *
 * A switch has two positions and there are three things to say here, and the
 * third of them - never - is the one worth being able to point at. Drawn as one
 * control with a single border and hairlines between the options, so it reads
 * as one setting with three positions rather than three separate buttons that
 * happen to sit together.
 */
/*
 * The usage cards hold figures, not rows, so nothing inside them carried the
 * 16 a row's padding gives - the four totals and the day list sat flush against
 * the card's corners. The block takes that padding on their behalf.
 */
.usage-block {
  padding-block: 16px;
}

/* Four figures across, each its own column so they line up whatever their width. */
.totals {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.total {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.total-value {
  color: var(--text-strong);
  font-size: calc(20px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: calc(26px * var(--ui-font-scale, 1));
  font-variant-numeric: tabular-nums;
}

.total-value.small {
  flex-shrink: 0;
  font-size: calc(14px * var(--ui-font-scale, 1));
  line-height: calc(20px * var(--ui-font-scale, 1));
}

.total-name {
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: calc(16px * var(--ui-font-scale, 1));
}

.day {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 0;
}

/*
 * Wide enough for the longest short month and day the tables' languages write
 * ("20 de set.", "20. Sept.") - measured at the ordinary interface size, so the
 * width has to follow the interface size too. It was a flat 64px against text
 * that scales to 1.71x, with `nowrap` and nothing to clip it, so at the largest
 * setting the date painted straight across the bar beside it (R25-D4).
 */
.day-name {
  flex-shrink: 0;
  width: calc(64px * var(--ui-font-scale, 1));
  white-space: nowrap;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-variant-numeric: tabular-nums;
}

.day-bar {
  flex: 1;
  height: 8px;
  background: var(--surface-base);
  border-radius: 999px;
}

.day-fill {
  display: block;
  height: 100%;
  background: var(--icon-base);
  border-radius: 999px;
}

.day-value,
.day-cost {
  flex-shrink: 0;
  width: calc(56px * var(--ui-font-scale, 1));
  color: var(--text-base);
  font-size: calc(12px * var(--ui-font-scale, 1));
  text-align: end;
  font-variant-numeric: tabular-nums;
}

/*
 * MiMo's custom instructions: a heading, a line with an inline 了解更多 that
 * opens three lines of help, a 200px box on the page itself, and Save below.
 */
.ci-link {
  display: inline;
  padding: 0;
  color: var(--text-interactive);
  background: none;
  border: 0;
  font: inherit;
  cursor: pointer;
}

.ci-help {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: -6px 0 14px;
  padding: 10px 12px;
  color: var(--text-base);
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: 10px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: 1.6;
}

.ci-input {
  display: block;
  box-sizing: border-box;
  width: 100%;
  min-height: 200px;
  margin-top: 10px;
  padding: 12px 14px;
  color: var(--text-strong);
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: 10px;
  outline: none;
  font-family: inherit;
  font-size: calc(14px * var(--ui-font-scale, 1));
  line-height: 1.6;
  resize: vertical;
}

/* MiMo's ci-input: the input fill (#fff / #181818) on a 1px line, the dim colour on focus. */
.ci-input,
.ci-help {
  background: #ffffff;
  border-color: #f3efeb;
}

.ci-input:focus {
  border-color: var(--text-weak);
}

/* Clean, MiMo's save is the secondary button at full opacity, its text not greyed. */
.ci-save:disabled {
  color: #151c13;
  opacity: 1;
}

/* The dark line is written on the plain element, which outranks `.ci-input:focus` above, so the focus ring had to be repeated here; the field sets `outline: none`, so that border is the only mark focus has. */
:root[data-theme="dark"] .ci-input,
:root[data-theme="dark"] .ci-help {
  background: #181818;
  border-color: #2e2e2e;
}

:root[data-theme="dark"] .ci-input:focus {
  border-color: var(--text-weak);
}

:root[data-theme="dark"] .ci-save:disabled {
  color: var(--text-strong);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .ci-input,
  :root:not([data-theme="light"]) .ci-help {
    background: #181818;
    border-color: #2e2e2e;
  }

  :root:not([data-theme="light"]) .ci-input:focus {
    border-color: var(--text-weak);
  }

  :root:not([data-theme="light"]) .ci-save:disabled {
    color: var(--text-strong);
  }
}

.ci-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 10px;
}

/* A path is read left to right and has to wrap somewhere, so let it wrap. */
.line-sub.path {
  font-family: var(--font-mono);
  font-size: calc(11.5px * var(--ui-font-scale, 1));
  overflow-wrap: anywhere;
}

/* MiMo's sc-sub: 14 below, nothing above, so it sits on the title's own 26. */
.page-sub {
  margin: 0 0 14px;
  color: var(--text-base);
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: calc(20px * var(--ui-font-scale, 1));
}

/* MiMo's import note and example label are the same sub-line, pushed 14 down. */
.page-sub.mcp-skills-note,
.page-sub.mcp-example-label {
  margin-top: 14px;
}

/*
 * MiMo's app icon grid, which is itself a set-card ("set-card app-icon-grid"):
 * four equal columns, 18 between rows and 12 between columns, 18 by 16 of
 * padding. The card rule below gives it the fill, the line and the 16px corner.
 */
.card.gallery {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 18px 12px;
  padding: 18px 16px;
}

/* A cell is a column of thumb and name with nothing of its own - no padding, no
   border, no hover fill; the thumb's ring is what answers the pointer. */
.tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 0;
  background: transparent;
  border: 0;
  cursor: pointer;
}

/*
 * The thumb: 60 square on a 14px corner under an inset hairline. Hover lays a
 * 2px menu-hover ring outside it; the chosen one is ringed twice - 2px of the
 * page colour, then 4px of the selection mark - so the mark reads as a gap and
 * a ring rather than a thicker border.
 */
/*
 * The thumb is the artwork itself, drawn or rasterised, so the size lives here
 * rather than on a wrapper: a rule for the image inside would have to outrank
 * this one, and did - the classic icon's PNG filled its whole grid cell.
 */
.tile-art {
  display: block;
  box-sizing: border-box;
  width: 60px;
  height: 60px;
  overflow: hidden;
  border-radius: 14px;
  box-shadow: inset 0 0 0 1px #00000014;
  object-fit: cover;
  line-height: 0;
  transition: box-shadow 0.12s ease;
}

.tile:hover .tile-art {
  box-shadow: inset 0 0 0 1px #00000014, 0 0 0 2px #f1f0ec;
}

.tile.on .tile-art {
  box-shadow: inset 0 0 0 1px #00000014, 0 0 0 2px #fffefd, 0 0 0 4px #151c13;
}

:root[data-theme="dark"] .tile:hover .tile-art {
  box-shadow: inset 0 0 0 1px #00000014, 0 0 0 2px #ffffff0f;
}

:root[data-theme="dark"] .tile.on .tile-art {
  box-shadow: inset 0 0 0 1px #00000014, 0 0 0 2px #181818, 0 0 0 4px #ffffff;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .tile:hover .tile-art {
    box-shadow: inset 0 0 0 1px #00000014, 0 0 0 2px #ffffff0f;
  }

  :root:not([data-theme="light"]) .tile.on .tile-art {
    box-shadow: inset 0 0 0 1px #00000014, 0 0 0 2px #181818, 0 0 0 4px #ffffff;
  }
}

.tile-name {
  max-width: 100%;
  overflow: hidden;
  color: var(--text-base);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: calc(16px * var(--ui-font-scale, 1));
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tile.on .tile-name {
  color: var(--text-strong);
  font-weight: 500;
}

/*
 * MiMo's th-seg: 26 tall including a 1px line border, 9 round, no dividers;
 * segments on the page ground at 12px muted, the picked one solid
 * selection-strong under white text (MiMo does not redefine it for dark).
 */
.choice {
  display: inline-flex;
  flex-shrink: 0;
  box-sizing: border-box;
  height: calc(26px * var(--ui-font-scale, 1));
  overflow: hidden;
  background: var(--surface-raised);
  border: 1px solid #f3efeb;
  border-radius: 9px;
}

.choice-btn {
  height: 100%;
  min-width: 0;
  padding: 0 12px;
  /* MiMo's th-seg-btn rests in mut, not the step below it. */
  color: var(--text-base);
  background: var(--surface-raised);
  border: 0;
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-weight: 400;
  cursor: pointer;
}

.choice-btn:hover {
  color: var(--text-strong);
}

/*
 * The picked segment is MiMo's primary pair - --color-primary on
 * --color-primary-foreground - which is #151c13 under white in light and
 * #ececec under #0d0d0d in dark. It had no dark value at all, so the dark
 * dialog drew near-black text on near-black fill.
 */
.choice-btn.on {
  color: #ffffff;
  background: #151c13;
}

:root[data-theme="dark"] .choice {
  border-color: #3d3d3d;
}

:root[data-theme="dark"] .choice-btn.on {
  color: #0d0d0d;
  background: #ececec;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .choice {
    border-color: #3d3d3d;
  }

  :root:not([data-theme="light"]) .choice-btn.on {
    color: #0d0d0d;
    background: #ececec;
  }
}

/*
 * opencode's `button-v2` ghost variant, measured on its providers page:
 * `74x28` for 断开连接, `padding: 0 11px`, gap 6, radius 6, transparent,
 * `13px/530/20px` at `-0.04px` in text-base. This was `0 12px` on a 6% fill
 * in text-strong at 440 - a filled pill where the reference draws a ghost.
 */

/* The custom-provider form sits inside the provider card, so it brings the
   card's own inset and closing rule with it rather than knowing about them. */

/*
 * 2.0: Xiaomi MiMo's settings dialog, measured with it open.
 *
 * 960 by 660 on the workspace fill behind a light scrim, a 20px corner and a
 * one-pixel rule a shade up from the fill. A 241 column of 36px rows at 14/500
 * under a 15/600 title, grouped by 12px grey labels; the page beside it on the
 * menu surface with 44 by 40 of padding, a 24/400 title, 14/500 section
 * labels, and cards a step lighter again with a 16px corner. Rows are a 14/500
 * name over a 12/500 line in the base text colour, 16 above and below.
 */
/* MiMo's light scrim, its settings-full rule and the warm nav fill; dark values follow below. */
.overlay {
  background: #0000001a;
  /* MiMo opens the overlay on --ease-enter, not the emphatic curve. */
  animation: settings-overlay-in 0.18s cubic-bezier(0.2, 0.7, 0.2, 1);
}

/* MiMo fades the whole overlay in from .99 and out over .12s while it keeps rendering. */
.overlay .dialog {
  animation: none;
}

.overlay.closing {
  animation: settings-overlay-out 0.12s ease-in forwards;
}

@keyframes settings-overlay-in {
  from {
    opacity: 0;
    transform: scale(0.99);
  }
}

@keyframes settings-overlay-out {
  to {
    opacity: 0;
    transform: scale(0.99);
  }
}

:root[data-motion="on"] .overlay,
:root[data-motion="on"] .overlay.closing {
  animation: none;
}

@media (prefers-reduced-motion: reduce) {
  :root[data-motion="system"] .overlay,
  :root[data-motion="system"] .overlay.closing {
    animation: none;
  }
}

/*
 * MiMo's settings-full: it gives up a fixed 48 of width and 88 of height to the
 * window rather than a share of it, so the dialog keeps its full 960 until the
 * window is under 1008 wide, under MiMo's --shadow-pop.
 */
.dialog {
  position: relative;
  width: min(960px, 100vw - 48px);
  height: min(660px, 100vh - 88px);
  background: #ffffff;
  border: 1px solid #f3efeb;
  border-radius: 20px;
  box-shadow: var(--shadow-pop);
  outline: none;
}

/* MiMo's u-modal-close: 14 from the corner, 28 square, muted, a ring on keyboard focus. */
.close {
  position: absolute;
  top: 14px;
  inset-inline-end: 14px;
  z-index: 1;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  color: var(--text-base);
  border-radius: 8px;
}

.close:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.close:focus-visible {
  outline: 2px solid var(--text-strong);
  outline-offset: -2px;
}

.close:active {
  scale: 0.96;
}

.nav {
  /* MiMo's rows carry their own 2 of margin, so the column needs no gap. */
  width: 240px;
  min-width: 240px;
  /* The padding lives on the two parts below: the fixed top and the list. */
  padding: 0;
  /* The column is a fixed width, so a row whose label outgrows it used to
     paint over the page beside it - the page has an opaque background, so the
     label simply disappeared under it. MiMo's settings-nav clips the same way.
     `clip` rather than `hidden` so the column itself never becomes a scroller;
     the list inside it is the one part that scrolls. */
  overflow-x: clip;
  background: #f8f7f5;
  border-inline-end: 1px solid #f3efeb;
}

/* MiMo's sn-top: the title and the search, which never scroll away. */
.nav-top {
  display: flex;
  flex: none;
  flex-direction: column;
  padding: 18px 10px 0;
}

/*
 * MiMo's sn-scroll. At the default size the groups are taller than the dialog
 * (814 against 659 in zh-CN at 1400x900), so the list scrolls inside the column
 * rather than running off its foot. As MiMo's: the same start inset, 12 below
 * the last row, nothing on the trailing side - the thin 9px scrollbar takes
 * that lane when there is anything to scroll. Logical sides, so a
 * right-to-left language keeps the inset at the start, away from the bar.
 */
.nav-scroll {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  padding-block: 0 12px;
  padding-inline: 10px 0;
  overflow-x: hidden;
  overflow-y: auto;
}

:root[data-theme="dark"] .overlay {
  background: #0000003d;
}

:root[data-theme="dark"] .dialog {
  background: #1f1f1f;
  border-color: #3d3d3d;
}

:root[data-theme="dark"] .nav {
  background: #141414;
  border-color: #3d3d3d;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .overlay {
    background: #0000003d;
  }

  :root:not([data-theme="light"]) .dialog {
    background: #1f1f1f;
    border-color: #3d3d3d;
  }

  :root:not([data-theme="light"]) .nav {
    background: #141414;
    border-color: #3d3d3d;
  }
}

/*
 * MiMo's sn-title: 2 above the words and 10 under them rather than one line
 * box the text is centred in, so the title sits nearer the top of the column.
 */
.nav-title {
  flex-shrink: 0;
  padding: 2px 10px 10px;
  color: var(--text-strong);
  font-size: calc(15px * var(--ui-font-scale, 1));
  font-weight: 600;
  line-height: calc(24px * var(--ui-font-scale, 1));
}

/*
 * MiMo's sn-group, likewise: 12 above the label and 4 under it. The 12 is what
 * separates a group from the last row of the one before, which already carries
 * 2 of its own - so a group label needs no margin rule of its own.
 */
.nav-group {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  padding: 12px 10px 4px;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-weight: 400;
  line-height: calc(19.2px * var(--ui-font-scale, 1));
}

.nav-item {
  gap: 10px;
  margin-bottom: 2px;
  padding: 8px 10px;
  color: var(--text-strong);
  border-radius: 8px;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: calc(20px * var(--ui-font-scale, 1));
  /* A label wider than the column wraps onto a second line, and a single word
     that cannot wrap - German's "Tastenkombinationen" at the largest interface
     font size - breaks rather than being drawn over the page beside it. */
  overflow-wrap: anywhere;
}

/*
 * MiMo's nav icons are 17 square in the label's own colour, and every one of
 * them is a solid glyph (its .i.filled): the column reads as a block of marks
 * rather than a column of wire drawings. MCode's are redrawn on its own grid
 * to the same weight.
 */
.nav-ico {
  width: 17px;
  height: 17px;
  color: currentColor;
}

/* Hover shows only once the pointer has moved in the column, so a resting pointer under a fresh dialog lights nothing. */
.nav-item:hover {
  background: transparent;
}

/* MiMo's menu-hover and side-sel, which are warm greys in light and washes of white in dark. */
.nav.mouse-active .nav-item:hover {
  background: #f1f0ec;
}

.nav-item.on,
.nav.mouse-active .nav-item.on:hover {
  background: #eeedec;
}

:root[data-theme="dark"] .nav.mouse-active .nav-item:hover {
  background: #ffffff0f;
}

:root[data-theme="dark"] .nav-item.on,
:root[data-theme="dark"] .nav.mouse-active .nav-item.on:hover {
  background: #ffffff1a;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .nav.mouse-active .nav-item:hover {
    background: #ffffff0f;
  }

  :root:not([data-theme="light"]) .nav-item.on,
  :root:not([data-theme="light"]) .nav.mouse-active .nav-item.on:hover {
    background: #ffffff1a;
  }
}

.content {
  padding: 44px 40px;
  background: #ffffff;
}

:root[data-theme="dark"] .content {
  background: #1f1f1f;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .content {
    background: #1f1f1f;
  }
}

/* MiMo's sc-h1 and sc-sec are both 26 off what follows them. */
h2 {
  margin: 0 0 26px;
  font-size: calc(24px * var(--ui-font-scale, 1));
  font-weight: 400;
  line-height: calc(38.4px * var(--ui-font-scale, 1));
}

/*
 * MiMo draws a page title in --color-hero-title-fg, which is txt-strong in
 * light and the softer --color-txt in dark - a 24px heading in pure white is
 * heavier than anything else on the page. Written out rather than named: its
 * light half is --text-strong, not the body ink, so no one token holds the pair.
 */
:root[data-theme="dark"] h2 {
  color: #f4f4f5;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) h2 {
    color: #f4f4f5;
  }
}

h3 {
  margin: 26px 0 4px;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: calc(22.4px * var(--ui-font-scale, 1));
}

/*
 * MiMo's set-card: white on the white page in light, a faint warm rule between;
 * #282828 on #1f1f1f in dark. Its inset is 16 - the row's own padding, which
 * the divider is drawn inside - and the space to whatever follows is the card's
 * own 8 of margin rather than a rule between two cards, so a heading or a
 * paragraph after it sits on the same beat another card would.
 */
.card {
  padding: 0 16px;
  margin-bottom: 8px;
  background: #ffffff;
  border: 1px solid #f3efeb;
  border-radius: 16px;
  box-shadow: none;
}

.line {
  padding: 16px 0;
  border-bottom: 1px solid #f3efeb;
}

:root[data-theme="dark"] .card {
  background: #282828;
  border-color: #3d3d3d;
}

:root[data-theme="dark"] .line {
  border-color: #3d3d3d;
}

:root[data-theme="dark"] .nav-search {
  border-color: #2e2e2e;
}

/* As .ci-input: the plain dark rule outranks `.nav-search:focus`, so the ring is repeated for the dark schemes. */
:root[data-theme="dark"] .nav-search:focus {
  border-color: var(--text-base);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .card {
    background: #282828;
    border-color: #3d3d3d;
  }

  :root:not([data-theme="light"]) .line {
    border-color: #3d3d3d;
  }

  :root:not([data-theme="light"]) .nav-search {
    border-color: #2e2e2e;
  }

  :root:not([data-theme="light"]) .nav-search:focus {
    border-color: var(--text-base);
  }
}

.line-text {
  gap: 3px;
}

/* An MCP server's name is the user's string and can be one long word; it breaks rather than pushing its row apart. */
.line-title {
  overflow-wrap: anywhere;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: calc(22.4px * var(--ui-font-scale, 1));
  letter-spacing: 0;
}

.line-sub {
  margin-block: 0;
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: calc(18.6px * var(--ui-font-scale, 1));
}

/*
 * MiMo's settings switch: 32 by 20 with a 16px thumb travelling 14. Off is the
 * neutral track under a white thumb; on is the primary track under the
 * primary-foreground thumb. No hover change, as MiMo has none.
 */
.switch {
  width: 32px;
  height: 20px;
  background: #e3e3e0;
  border-radius: 999px;
}

.switch:hover {
  background: #e3e3e0;
}

.switch.on,
.switch.on:hover {
  background: #151c13;
}

.knob,
.switch.on .knob {
  top: 2px;
  width: 16px;
  height: 16px;
  background: #ffffff;
  border-radius: 50%;
}

.switch.on .knob {
  inset-inline-start: 14px;
}

/* MiMo's secondary sm button: 28 tall, 8 round, 0 12, the secondary fill. */
.ctl-btn {
  height: calc(28px * var(--ui-font-scale, 1));
  padding: 0 12px;
  color: #151c13;
  background: #f1f1f1;
  border: 0;
  border-radius: 8px;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
}

.ctl-btn:hover:not(:disabled) {
  background: #f1f0ec;
}

/* MiMo's select trigger in a settings row: 28 tall, a 1px input border, transparent in light. */
.content :deep(.trigger) {
  gap: 8px;
  height: calc(28px * var(--ui-font-scale, 1));
  padding: 0 12px;
  background: transparent;
  border: 1px solid #e3e3e0;
  border-radius: 8px;
  box-shadow: var(--shadow-xs);
  font-size: calc(14px * var(--ui-font-scale, 1));
}

.content :deep(.trigger:hover),
.content :deep(.trigger.open) {
  background: transparent;
}

.content :deep(.trigger .label) {
  font-weight: 500;
  line-height: calc(20px * var(--ui-font-scale, 1));
}

.content :deep(.trigger .caret) {
  color: currentColor;
  opacity: 0.5;
}

:root[data-theme="dark"] .switch,
:root[data-theme="dark"] .switch:hover {
  background: #4a4a4a;
}

:root[data-theme="dark"] .switch.on,
:root[data-theme="dark"] .switch.on:hover {
  background: #ececec;
}

:root[data-theme="dark"] .switch.on .knob {
  background: #0d0d0d;
}

:root[data-theme="dark"] .ctl-btn {
  color: var(--text-strong);
  background: #2e2e2e;
}

:root[data-theme="dark"] .ctl-btn:hover:not(:disabled) {
  background: #ffffff1a;
}

:root[data-theme="dark"] .content :deep(.trigger) {
  background: rgb(58 58 58 / 0.3);
  border-color: #3a3a3a;
}

:root[data-theme="dark"] .content :deep(.trigger:hover),
:root[data-theme="dark"] .content :deep(.trigger.open) {
  background: rgb(58 58 58 / 0.5);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .switch,
  :root:not([data-theme="light"]) .switch:hover {
    background: #4a4a4a;
  }

  :root:not([data-theme="light"]) .switch.on,
  :root:not([data-theme="light"]) .switch.on:hover {
    background: #ececec;
  }

  :root:not([data-theme="light"]) .switch.on .knob {
    background: #0d0d0d;
  }

  :root:not([data-theme="light"]) .ctl-btn {
    color: var(--text-strong);
    background: #2e2e2e;
  }

  :root:not([data-theme="light"]) .ctl-btn:hover:not(:disabled) {
    background: #ffffff1a;
  }

  :root:not([data-theme="light"]) .content :deep(.trigger) {
    background: rgb(58 58 58 / 0.3);
    border-color: #3a3a3a;
  }

  :root:not([data-theme="light"]) .content :deep(.trigger:hover),
  :root:not([data-theme="light"]) .content :deep(.trigger.open) {
    background: rgb(58 58 58 / 0.5);
  }
}

/*
 * The column's search field, as MiMo insets it: 6 of margin inside the column's
 * own 10, which is what puts its edge 16 in, and 6 by 10 of padding rather than
 * a fixed height, so it grows with the interface font. The rule is --color-line
 * (#f0ebe5 / #2e2e2e), not a mix against the column's fill.
 */
.nav-search {
  flex-shrink: 0;
  box-sizing: border-box;
  width: calc(100% - 12px);
  margin: 6px;
  padding: 6px 10px;
  color: var(--text-strong);
  background: transparent;
  border: 1px solid #f0ebe5;
  border-radius: 8px;
  outline: none;
  font-size: calc(14px * var(--ui-font-scale, 1));
  line-height: calc(20px * var(--ui-font-scale, 1));
}

.nav-search::placeholder {
  color: var(--text-weak);
}

.nav-search:focus {
  border-color: var(--text-base);
}

/* MiMo's empty search: 13px dim, 10 at the sides and 16 above. */
.nav-empty {
  padding: 16px 10px 0;
  color: var(--text-weak);
  font-size: calc(13px * var(--ui-font-scale, 1));
}
/*
 * The environment page, as MiMo lays it out: a section title with its action at
 * the far end, the projects as rows with two framed icon buttons, then the
 * worktrees with a count line and a name, two tags and the path on each row.
 */
.sec-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 26px 0 4px;
}

.sec-row h3 {
  margin: 0;
}

/*
 * MiMo's sr-ic: the folder is inline with the name rather than a flex row of
 * its own - 18 square on the .i stroke, dropped 3 below the baseline with 4
 * after it - and it takes the title's colour instead of being greyed down.
 */
.env-project-name svg {
  width: 18px;
  height: 18px;
  vertical-align: -3px;
  margin-inline-end: 4px;
  color: currentColor;
}

.env-icon {
  display: grid;
  place-items: center;
  min-width: 34px;
  height: calc(26px * var(--ui-font-scale, 1));
  padding: 0;
}

/* MiMo's control column: 10 between the two buttons. */
.env-ctrl {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 10px;
}

.env-del svg {
  color: var(--text-base);
}

.env-del:hover svg {
  color: #e5484d;
}

.env-plus {
  font-size: calc(16px * var(--ui-font-scale, 1));
  line-height: 1;
}

/* MiMo's sc-refresh: 28 square, 6 round, muted; the menu hover and strong text on hover. */
.env-refresh {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  color: var(--text-base);
  background: transparent;
  border: 0;
  border-radius: 6px;
}

.env-refresh:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

/* The count and loading lines are MiMo's sc-empty-title: 14/500 strong, with no margin of its own. */
.wt-status {
  margin: 0;
  color: var(--text-strong);
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
}

/* The other sentence-in-a-card on this page, on the card row's own 16. */
.card.wt-empty {
  padding: 16px;
}

.wt-empty-title {
  color: var(--text-strong);
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
}

.wt-empty-desc {
  margin-top: 4px;
  color: var(--text-base);
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.wt-row {
  gap: 8px;
}

/*
 * MiMo's worktree tags are 11px dim on `bg-soft`, which ships as nothing at all -
 * so its tags have no fill. MCode keeps the filled pill (2026-09-23 decision)
 * and takes dim for the words: on --surface-hover, --text-weaker measured about
 * 1.1:1 in light, which is a tag nobody can read.
 */
.wt-tag {
  flex-shrink: 0;
  padding: 1px 6px;
  color: var(--text-weak);
  background: var(--surface-hover);
  border-radius: 6px;
  font-size: calc(11px * var(--ui-font-scale, 1));
  font-weight: 400;
}

/* The name keeps its width up to half the row; the path is what gives way. */
.wt-name {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 50%;
  overflow: hidden;
  color: var(--text-strong);
  font-size: calc(13px * var(--ui-font-scale, 1));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wt-path {
  flex: 1 1 0;
  min-width: 0;
  margin-inline-start: auto;
  text-align: end;
  overflow: hidden;
  color: var(--text-weak);
  font-size: calc(11px * var(--ui-font-scale, 1));
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* MiMo's environment detail, capped at 820. */
.env-detail {
  max-width: 820px;
}

/* A plain back link: 14px muted with an 18px chevron, strong on hover, 18 below. */
.env-back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 18px;
  padding: 0;
  color: var(--text-base);
  background: transparent;
  border: 0;
  font-size: calc(14px * var(--ui-font-scale, 1));
}

.env-back:hover {
  color: var(--text-strong);
}

/* MiMo's env-flabel: a plain 13px label, 18 above and 4 below. */
.env-flabel {
  margin: 18px 0 4px;
  color: var(--text-strong);
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 400;
}

.env-back + .env-flabel {
  margin-top: 0;
}

/* The local card: the side fill on a line, 10 round, 14 by 16, a 20px muted folder. */
.env-local {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  background: #ffffff;
  border: 1px solid var(--border-weak);
  border-radius: 10px;
}

.env-local-icon {
  flex-shrink: 0;
  color: var(--text-weak);
}

.env-local-text {
  min-width: 0;
}

.env-local-name {
  color: var(--text-strong);
  font-size: calc(14px * var(--ui-font-scale, 1));
}

.env-local-path {
  overflow: hidden;
  color: var(--text-base);
  font-size: calc(12px * var(--ui-font-scale, 1));
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* MiMo's env-field: 13px at 9 by 12, 8 round, the input fill on a line, the accent border on focus. */
.env-input {
  box-sizing: border-box;
  width: 100%;
  margin-top: 4px;
  padding: 9px 12px;
  color: var(--text-strong);
  background: #ffffff;
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  outline: none;
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.env-input:focus {
  border-color: #ff6a2b;
}

/* The save row: a rule above, 24 of margin and 16 of padding, the button at the end. */
.env-save-row {
  display: flex;
  justify-content: flex-end;
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid var(--border-weak);
}

.env-save:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.ctl-btn.env-save.dirty {
  color: #ffffff;
  background: #151c13;
}

:root[data-theme="dark"] .env-local {
  background: #141414;
}

:root[data-theme="dark"] .env-input {
  background: #181818;
}

:root[data-theme="dark"] .ctl-btn.env-save.dirty {
  color: #0d0d0d;
  background: #ececec;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .env-local {
    background: #141414;
  }

  :root:not([data-theme="light"]) .env-input {
    background: #181818;
  }

  :root:not([data-theme="light"]) .ctl-btn.env-save.dirty {
    color: #0d0d0d;
    background: #ececec;
  }
}
/*
 * Archived conversations in batch: MiMo's toolbar - a framed 10px-corner strip
 * with select all at the start, the count after it and the two actions at the
 * far end - and a checkbox at the start of each row while selecting.
 */
/* MiMo's toolbar and its 批量管理 button both sit on bg-bg inside --color-line. */
.batch-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 10px;
  padding: 8px 12px;
  background: #fffefd;
  border: 1px solid #f0ebe5;
  border-radius: 10px;
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.batch-all {
  padding: 0;
  color: var(--text-base);
  background: transparent;
  border: 0;
}

.batch-all:hover {
  color: var(--text-strong);
}

.batch-count {
  color: var(--text-weak);
}

.batch-acts {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-inline-start: auto;
}

.batch-acts button:disabled {
  opacity: 0.45;
  cursor: default;
}

/* MiMo's archived header: the page title with 批量管理 at its far end. */
.page-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-block-end: 26px;
}

.page-head h2 {
  margin: 0;
}

.archived-manage {
  margin-inline-start: auto;
  padding: 5px 12px;
  color: var(--text-strong);
  background: #fffefd;
  border: 1px solid #f0ebe5;
  border-radius: 7px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 400;
}

.archived-manage:hover {
  background: #f1f0ec;
}

:root[data-theme="dark"] .batch-bar,
:root[data-theme="dark"] .archived-manage {
  background: #181818;
  border-color: #2e2e2e;
}

:root[data-theme="dark"] .archived-manage:hover {
  background: #ffffff0f;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .batch-bar,
  :root:not([data-theme="light"]) .archived-manage {
    background: #181818;
    border-color: #2e2e2e;
  }

  :root:not([data-theme="light"]) .archived-manage:hover {
    background: #ffffff0f;
  }
}

/*
 * MiMo's inline and bulk delete are a ghost button in --color-del (#e5484d,
 * one value for both schemes) washed with red-50 on hover. What was here was
 * #d93025 on #fdecea - MiMo's confirm-button pair, which belongs on the dialog
 * that asks, not on the row that opens it.
 *
 * MiMo keeps the pink wash in dark too, where it is a near-white plate behind
 * red text; that is its own oversight rather than a value to copy, so the dark
 * hover stays the warm dark fill MCode already had (2026-09-23).
 */
.archived-delete {
  padding: 4px 10px;
  color: #e5484d;
  background: transparent;
  border: 0;
  border-radius: 7px;
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.archived-delete:hover:not(:disabled) {
  background: #fef2f2;
}

:root[data-theme="dark"] .archived-delete:hover:not(:disabled) {
  background: #3a2320;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .archived-delete:hover:not(:disabled) {
    background: #3a2320;
  }
}

.archived-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.archived-title.picking {
  cursor: pointer;
}

.archived-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* MiMo's checkbox: 18 square, 5 round; the send fill with a heavy white tick when checked. */
.check {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  box-sizing: border-box;
  width: 18px;
  height: 18px;
  color: var(--button-primary-text);
  border: 1px solid var(--text-weak);
  border-radius: 5px;
}

.check.on {
  background: var(--button-primary);
  border-color: var(--button-primary);
}

.closed-head {
  margin-block-start: 36px;
}

/* MiMo's 用法详情: a link-styled span inside the description, underlined 2px below. */
.usage-link {
  color: #2f6fed;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}

/* MiMo's text-blue, shared by 用法详情 and 了解更多. */
.ci-link {
  color: #2f6fed;
}

:root[data-theme="dark"] .usage-link,
:root[data-theme="dark"] .ci-link {
  color: #5a9cff;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .usage-link,
  :root:not([data-theme="light"]) .ci-link {
    color: #5a9cff;
  }
}

/* MiMo's voice send dialog: 430 wide on a 16px corner, a warning title row, a light red confirm. */
.vs-scrim {
  position: fixed;
  inset: 0;
  z-index: 130;
  display: grid;
  place-items: center;
  /* MiMo's dialog scrim is bg-black/50 in both schemes, not a lighter one in light. */
  background: #00000080;
}

.vs-dialog {
  box-sizing: border-box;
  width: min(430px, 88vw);
  padding: 22px 24px;
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 16px;
  box-shadow: var(--shadow-pop);
}

.vs-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-block-end: 10px;
}

.vs-warn {
  flex-shrink: 0;
}

.vs-title {
  color: var(--text-strong);
  font-size: calc(16px * var(--ui-font-scale, 1));
  font-weight: 400;
}

.vs-body {
  margin: 0 0 18px;
  color: var(--text-base);
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: 1.6;
  white-space: pre-line;
}

.vs-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.vs-cancel,
.vs-ok {
  padding: 8px 18px;
  border: 1px solid transparent;
  border-radius: 8px;
  font-size: calc(14px * var(--ui-font-scale, 1));
  cursor: pointer;
}

.vs-cancel {
  color: var(--text-base);
  background: var(--surface-base);
  border-color: var(--border-weak);
}

.vs-cancel:hover {
  background: var(--surface-hover);
}

.vs-ok {
  color: #d93025;
  background: #fdecea;
  border-color: #fdecea;
}

.vs-ok:hover {
  background: #f9ccc7;
  border-color: #f9ccc7;
}

:root[data-theme="dark"] .vs-ok {
  color: #ff9b7f;
  background: #3a2320;
  border-color: #3a2320;
}

:root[data-theme="dark"] .vs-ok:hover {
  background: #4a2c27;
  border-color: #4a2c27;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .vs-ok {
    color: #ff9b7f;
    background: #3a2320;
    border-color: #3a2320;
  }

  :root:not([data-theme="light"]) .vs-ok:hover {
    background: #4a2c27;
    border-color: #4a2c27;
  }
}

/* MiMo's search highlight: the selected fill held for the first fifth of 1.6s, then faded. */
.sr-hit {
  animation: sr-hit 1.6s ease-out;
}

@keyframes sr-hit {
  0%,
  20% {
    background: #f1f0ec;
  }

  100% {
    background: transparent;
  }
}

/* Reduced motion keeps the fill and drops the fade. */
:root[data-motion="on"] .sr-hit {
  animation: none;
  background: #f1f0ec;
}

@media (prefers-reduced-motion: reduce) {
  :root[data-motion="system"] .sr-hit {
    animation: none;
    background: #f1f0ec;
  }
}

/* MiMo's side-active is a wash of white in dark, not a warm grey. */
:root[data-theme="dark"] .sr-hit {
  animation-name: sr-hit-dark;
}

:root[data-theme="dark"]:root[data-motion="on"] .sr-hit {
  background: #ffffff1a;
}

@keyframes sr-hit-dark {
  0%,
  20% {
    background: #ffffff1a;
  }

  100% {
    background: transparent;
  }
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .sr-hit {
    animation-name: sr-hit-dark;
  }

  :root:not([data-theme="light"]):root[data-motion="on"] .sr-hit {
    background: #ffffff1a;
  }
}
</style>
