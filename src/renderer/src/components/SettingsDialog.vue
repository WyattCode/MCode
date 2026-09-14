<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { useApp } from "../stores/app"
import ConnectDialog from "./ConnectDialog.vue"
import CustomProviderForm from "./CustomProviderForm.vue"
import ProviderIcon from "./ProviderIcon.vue"
import { groupConnected, groupProviders, waysFor, type Group } from "../lib/connect"
import {
  DEFAULT_PERMISSIONS,
  ENFORCED_KINDS,
  NETWORK_KINDS,
  PERMISSION_ACTIONS,
  WRITING_KINDS,
  type PermissionAction,
  type PermissionKind,
  type ProviderStatus,
  EFFORTS,
} from "@shared/protocol"
import { LANGUAGES, ago, language, sessionTitle, t, type Language } from "../lib/i18n"
import { folderName, projectName } from "../lib/project"
import SelectMenu from "./SelectMenu.vue"
import { chime } from "../lib/sound"
import { CHIMES, chimeOf, type Chime } from "@shared/chime"
import ConfirmDialog from "./ConfirmDialog.vue"
import { APP_ICONS, DEFAULT_APP_ICON, appIconSvg } from "@shared/app-icons"
import type { AgentsFileState, AppPath, AppPaths, UsageSummary } from "@shared/protocol"
import type { McpImportItem, McpImportSource, McpServerConfig, McpStatus, McpToolInfo } from "@shared/protocol"
import classicIcon from "@resources/app-icons/classic.png"
import { chordOf, isBindable } from "../lib/keys"
import { notifyFailure, notify } from "../lib/toast"
import { DEFAULT_THEME, THEMES } from "../lib/theme-palettes"

const emit = defineEmits<{ close: []; "check-updates": []; "install-update": [] }>()
const app = useApp()

/*
 * Shells worth offering by name. "Automatic" is the empty string, which is
 * what the backend already means by "whatever this machine runs".
 */
const shellOptions = computed(() => [
  { value: "", label: t("set.shellAuto") },
  ...(app.platform === "win32"
    ? [
        { value: "powershell.exe", label: "Windows PowerShell" },
        { value: "pwsh.exe", label: "PowerShell" },
        { value: "cmd.exe", label: "Command Prompt" },
        { value: "bash.exe", label: "Git Bash" },
      ]
    : [
        { value: "/bin/zsh", label: "zsh" },
        { value: "/bin/bash", label: "bash" },
        { value: "/bin/sh", label: "sh" },
        { value: "/usr/bin/fish", label: "fish" },
      ]),
])

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
  | "server"
  | "models"
  | "mcp"

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
const section = ref<Section>(props.section ?? "general")

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

function revealPath(file: AppPath) {
  const cut = Math.max(file.path.lastIndexOf("/"), file.path.lastIndexOf("\\"))
  if (cut < 0) return
  window.mcode.revealFile(file.path.slice(0, cut), file.path.slice(cut + 1))
}

function openPath(file: AppPath) {
  const cut = Math.max(file.path.lastIndexOf("/"), file.path.lastIndexOf("\\"))
  if (cut < 0) return
  window.mcode.openFile(file.path.slice(0, cut), file.path.slice(cut + 1))
}

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
  try {
    agents.value = await app.client?.request({ type: "agents.setEnabled", enabled })
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
interface McpForm {
  name: string
  type: "stdio" | "http"
  command: string
  url: string
  args: string[]
  env: { key: string; value: string }[]
  headers: { key: string; value: string }[]
}

const MCP_KINDS = ["stdio", "http"] as const
const MCP_TONE: Record<McpStatus, string> = {
  connected: "ok",
  failed: "err",
  needs_auth: "warn",
  pending: "muted",
  disabled: "muted",
}
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
const mcpTools = ref<Record<string, "loading" | { tools?: McpToolInfo[]; error?: string }>>({})

function blankMcpForm(): McpForm {
  return { name: "", type: "stdio", command: "", url: "", args: [], env: [], headers: [] }
}

const mcpRows = computed(() =>
  Object.entries(app.config?.mcpServers ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, entry]) => {
      const state = app.mcpServers.find((server) => server.name === name)
      const enabled = entry.enabled !== false
      return {
        name,
        remote: entry.type === "remote",
        enabled,
        status: (enabled ? (state?.status ?? "pending") : "disabled") as McpStatus,
        error: state?.error,
      }
    }),
)

/* The config keeps a command already split; the form shows its first word as a line, quoted when it has a space. */
function joinCommand(parts: string[]): string {
  return parts.map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(" ")
}

function splitCommand(line: string): string[] {
  const parts: string[] = []
  const pattern = /"([^"]*)"|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(line))) parts.push(match[1] ?? match[2])
  return parts
}

function recordOf(rows: { key: string; value: string }[]): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const row of rows) if (row.key.trim()) out[row.key.trim()] = row.value
  return Object.keys(out).length ? out : undefined
}

function rowsOf(record?: Record<string, string>) {
  return Object.entries(record ?? {}).map(([key, value]) => ({ key, value }))
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
    command: command ? joinCommand([command]) : "",
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
      ? { type: "remote", url: form.url.trim(), headers: recordOf(form.headers) }
      : {
          type: "local",
          command: [...splitCommand(form.command), ...form.args.filter((arg) => arg.trim())],
          environment: recordOf(form.env),
        }
  // An edit keeps the server as switched on or off as it was.
  if (app.config?.mcpServers?.[name]?.enabled === false) entry.enabled = false
  try {
    await app.patchConfig({ mcpServers: { ...(app.config?.mcpServers ?? {}), [name]: entry } })
  } catch {
    notifyFailure(t("set.mcpForm.saveFailed"))
    return
  }
  delete mcpTools.value[name]
  notify(t("set.mcpForm.saved", { name }))
  mcpView.value = "list"
}

async function setMcpEnabled(name: string, enabled: boolean) {
  const entry = app.config?.mcpServers?.[name]
  if (!entry) return
  try {
    await app.patchConfig({ mcpServers: { ...(app.config?.mcpServers ?? {}), [name]: { ...entry, enabled } } })
  } catch {
    notifyFailure(t("set.mcp.toggleFailed"))
  }
  delete mcpTools.value[name]
}

/* As in MiMo, removing asks nothing and says what went. */
async function removeMcp(name: string) {
  const servers = { ...(app.config?.mcpServers ?? {}) }
  delete servers[name]
  await app.patchConfig({ mcpServers: servers })
  if (mcpToolsOpen.value === name) mcpToolsOpen.value = undefined
  delete mcpTools.value[name]
  notify(t("set.mcp.removed") + name)
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
    notify(t("set.mcp.importDone", { n: String(result?.imported.length ?? 0) }))
    mcpView.value = "list"
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
  if (entry.error !== undefined) {
    const error = entry.error in MCP_TONE ? t(`set.mcp.status.${entry.error}`) : entry.error
    return { kind: "error", tools: [] as McpToolInfo[], error }
  }
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

/* The widest day sets the scale, so the bars mean something next to each other. */
const busiestDay = computed(() =>
  Math.max(1, ...(usage.value?.byDay ?? []).map((day) => day.usage.input + day.usage.output)),
)

function tokens(count: number): string {
  if (count >= 1_000_000) return (count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1) + "M"
  if (count >= 1000) return (count / 1000).toFixed(count >= 10_000 ? 0 : 1) + "k"
  return String(count)
}

/*
 * The environment page, laid out as MiMo's: the projects, each of which can be
 * configured or removed, then every worktree those projects have beyond their
 * main checkout. MCode's projects are the folders its conversations live in, so
 * adding one reopens a closed folder or starts a conversation there, and
 * removing one closes it the way the side column does - its conversations stay.
 */
const envProjects = computed(() => {
  const closed = new Set(app.config?.closedProjects ?? [])
  const seen = new Set<string>()
  const out: string[] = []
  for (const session of [...app.sessions].sort((a, b) => b.updated - a.updated)) {
    if (session.archived || session.scratch || closed.has(session.directory) || seen.has(session.directory)) continue
    seen.add(session.directory)
    out.push(session.directory)
  }
  return out
})

const removingProject = ref<string>()
/** The project whose environment is open, or none for the list. */
const configuring = ref<string>()
const envName = ref("")
const envDirty = computed(
  () => Boolean(configuring.value) && envName.value.trim() !== (app.config?.projectNames?.[configuring.value ?? ""] ?? ""),
)

async function addProject() {
  const [directory] = await window.mcode.pickDirectory(t("set.addProject"), false)
  if (!directory) return
  const closed = app.config?.closedProjects ?? []
  if (closed.includes(directory)) await app.patchConfig({ closedProjects: closed.filter((entry) => entry !== directory) })
  // A folder with no conversation is not yet a project here; one is started so it can be.
  if (!app.sessions.some((session) => session.directory === directory && !session.archived && !session.scratch)) {
    await app.create(directory)
  }
  void loadTrees()
}

async function removeProject() {
  const directory = removingProject.value
  removingProject.value = undefined
  if (!directory) return
  const closed = app.config?.closedProjects ?? []
  if (!closed.includes(directory)) await app.patchConfig({ closedProjects: [...closed, directory] })
  void loadTrees()
}

function configure(directory: string) {
  configuring.value = directory
  envName.value = app.config?.projectNames?.[directory] ?? ""
}

/** The name is the project's display name, the same one renaming it in the side column sets. */
async function saveEnv() {
  const directory = configuring.value
  if (!directory) return
  const names = { ...(app.config?.projectNames ?? {}) }
  const name = envName.value.trim()
  if (name) names[directory] = name
  else delete names[directory]
  await app.patchConfig({ projectNames: names })
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
    if (next === "files" || next === "models" || next === "mcp") void loadPaths()
    if (next === "files") void loadAgents()
    if (next !== "mcp") mcpView.value = "list"
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

/*
 * The gallery's tiles. The drawn ones come from the same string their PNGs are
 * rasterised from; the original comes from its own file, because it is a
 * painted mark rather than these paths and a redrawing of it would be a
 * different icon wearing its name.
 */
const iconTiles = APP_ICONS.map((spec) => ({
  spec,
  svg: spec.original ? "" : appIconSvg(spec, 44),
  image: spec.original ? classicIcon : "",
}))

/* The segments each of the two appearance choices offers, in the order shown. */
const MOTION_MODES = ["system", "on", "off"] as const
const DIFF_MARKS = ["color", "signs"] as const

/*
 * The column's search, after MiMo's: narrows the entries to those whose name
 * matches, and Enter opens the first of them. Being the first text field in
 * the dialog it is also where focus lands on opening - before it, that was the
 * first text box on the General page, the UI font, and opening settings
 * scrolled the page halfway down to show it.
 */
const navQuery = ref("")
const NAV_LABELS: Record<Section, string> = {
  general: "set.nav.general",
  usage: "set.nav.usage",
  appearance: "set.appearance",
  files: "set.nav.files",
  models: "set.models",
  server: "set.server",
  personal: "set.personal",
  keys: "set.shortcuts",
  mcp: "set.nav.mcp",
  environment: "set.environment",
  archive: "set.nav.archive",
  updates: "set.nav.updates",
}

function navShows(entry: Section): boolean {
  const needle = navQuery.value.trim().toLocaleLowerCase()
  return !needle || t(NAV_LABELS[entry]).toLocaleLowerCase().includes(needle)
}

const navMatches = computed(() => (Object.keys(NAV_LABELS) as Section[]).filter(navShows))

function openFirstMatch() {
  const first = navMatches.value[0]
  if (first) section.value = first
}

const saved = ref<string>()

/*
 * The buckets a call is really checked against, which is not every bucket
 * there is: see ENFORCED_KINDS. Drawing a control for a bucket nothing
 * consults would put a switch on the screen that changes nothing, which is the
 * same class of defect as asking a question that has already been answered.
 */
const BUCKETS = ENFORCED_KINDS
const NETWORK = new Set<string>(NETWORK_KINDS)
const WRITES = new Set<string>(WRITING_KINDS)
const ACTIONS = PERMISSION_ACTIONS

/**
 * The buckets the reference has a name for, and the two it does not.
 *
 * Nine of this app's eleven map onto a bucket in the reference's permission
 * schema, so those nine rows can carry its words instead of a raw lowercase
 * identifier - `outside` under the name the reference gives it, external
 * directory. The other two have no counterpart at all: the reference judges
 * every kind of file change as one `edit` ("Modify files, including edits,
 * writes, and patches") and has no notion of an MCP server, so there is no
 * string for `write` or `mcp` to adopt. They keep showing their id rather than
 * a title this app invented for them.
 *
 * Worth being precise about what this is: the reference ships no permissions
 * screen at all - its own copies of these strings are unread - so this is
 * borrowing its vocabulary for a screen of ours, not matching a screen of its.
 */
const TITLED_BUCKETS = new Set<string>([
  "read",
  "edit",
  "glob",
  "grep",
  "list",
  "bash",
  "todowrite",
  "webfetch",
  "outside",
])

function bucketTitle(bucket: PermissionKind): string {
  return TITLED_BUCKETS.has(bucket) ? t(`tool.title.${bucket}`) : bucket
}


/**
 * Recording a new chord for one command.
 *
 * The listener is on the window in the capture phase so the keystroke never
 * reaches the app underneath - otherwise pressing Ctrl+W to record it would
 * close the tab while recording.
 */
/*
 * A size typed into one of the two rows: a whole number in the range the
 * interface can still be laid out at, else the row goes back to what it was.
 */
function setSize(field: "uiFontSize" | "codeFontSize", event: Event, fallback: number) {
  const input = event.target as HTMLInputElement
  const value = Math.round(Number(input.value))
  const [min, max] = field === "uiFontSize" ? [10, 24] : [8, 24]
  if (!input.value.trim() || !Number.isFinite(value) || value < min || value > max) {
    input.value = String(app.config?.[field] ?? fallback)
    return
  }
  input.value = String(value)
  if (value !== app.config?.[field]) void app.patchConfig({ [field]: value })
}

const capturing = ref<string>()

/** The chord a row answers to: the user's if they set one, else the built-in. */
function boundKeys(shortcut: { id: string; hint?: string }) {
  return app.config?.keybinds?.[shortcut.id] || shortcut.hint || ""
}

function beginCapture(command: string) {
  capturing.value = command
  const finish = () => {
    window.removeEventListener("keydown", onCapture, true)
    capturing.value = undefined
  }
  const onCapture = (event: KeyboardEvent) => {
    event.preventDefault()
    event.stopImmediatePropagation()
    if (event.key === "Escape") return finish()
    const chord = chordOf(event)
    if (!isBindable(chord)) return
    /*
     * Two commands cannot share a chord. The dispatcher keeps one of them - the
     * last one written - so assigning a chord that is already in use silently
     * took it away from whatever had it, with both rows still showing it. Every
     * command is checked, including the ones this page does not list, because a
     * hidden command's chord is just as live as a visible one's.
     */
    const clash = props.commands.filter((entry) => entry.id !== command && boundKeys(entry) === chord)
    if (clash.length) {
      notifyFailure(
        t("key.conflict"),
        t("key.conflictBody", { keybind: chord, titles: clash.map((entry) => entry.title).join(", ") }),
      )
      return finish()
    }
    void app.patchConfig({ keybinds: { ...(app.config?.keybinds ?? {}), [command]: chord } })
    finish()
  }
  window.addEventListener("keydown", onCapture, true)
}

function resetBinding(command: string) {
  const next = { ...(app.config?.keybinds ?? {}) }
  delete next[command]
  void app.patchConfig({ keybinds: next })
}

const themeOptions = computed(() => [
  { value: "system", label: t("set.themeSystem") },
  { value: "dark", label: t("set.themeDark") },
  { value: "light", label: t("set.themeLight") },
])
const paletteOptions = THEMES.map((entry) => ({ value: entry.id, label: entry.name }))
const languageOptions = computed(() => LANGUAGES.map((entry) => ({ value: entry.id, label: entry.label })))
const effortOptions = computed(() =>
  EFFORTS.map((level) => ({
    value: level,
    label: level === "xhigh" ? "XHigh" : level.charAt(0).toUpperCase() + level.slice(1),
  })),
)

/**
 * Wipes the app back to first run - keys, subscription logins, preferences and
 * every session. It cannot be undone, so it asks once rather than firing on the
 * click that happens to land on it.
 */
const confirmingReset = ref(false)

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

const archived = computed(() =>
  app.sessions.filter((session) => session.archived).sort((a, b) => b.updated - a.updated),
)

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

async function restorePicked() {
  for (const sessionID of pickedLive.value) await app.archive(sessionID, false)
  stopSelecting()
}

/** What the delete dialog is about: one named conversation, or the selection. */
const confirmingDelete = ref<{ ids: string[]; title?: string }>()

async function confirmRemove() {
  const target = confirmingDelete.value
  confirmingDelete.value = undefined
  if (!target) return
  for (const sessionID of target.ids) await app.remove(sessionID)
  if (target.title === undefined) stopSelecting()
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
/*
 * What each font box falls back to, named rather than described.
 *
 * The reference puts the font's own name in the placeholder - measured on the
 * running app, its sans box reads `value: "", placeholder: "System Sans"` - so
 * an unset field still tells you what is actually being used. This said
 * "Default", which says only that you have not chosen. The three names are its
 * own constants (`sansDefault`, `monoDefault`, `terminalDefault`), and being
 * font names they are the same in every language.
 */
const FONT_SANS_DEFAULT = "System Sans"
const FONT_MONO_DEFAULT = "System Mono"
const FONT_TERMINAL_DEFAULT = "JetBrainsMono Nerd Font Mono"

const resetGate = ref<HTMLElement>()

async function armReset() {
  confirmingReset.value = true
  await nextTick()
  resetGate.value?.scrollIntoView({ behavior: "smooth", block: "end" })
  // Focused so Escape and Enter land here rather than on the page behind it.
  resetGate.value?.querySelector<HTMLButtonElement>(".danger-btn")?.focus()
}

function cancelReset() {
  confirmingReset.value = false
}

async function resetEverything() {
  await app.resetEverything()
  confirmingReset.value = false
  emit("close")
}

/*
 * Grouped the way opencode groups them, and in its order, so the two pages can
 * be read side by side. Only bindings this app actually honours are listed - a
 * shortcuts page that lies is worse than a short one.
 */
/*
 * The page is derived from the commands themselves rather than listed here.
 *
 * A hand-written table has to be kept in step with the command list by hand,
 * and it was not: rows named chords nothing implemented, and commands added
 * elsewhere never appeared. Deriving it means a command is bindable the moment
 * it exists, and the thirty-seven themes and eighteen languages get their rows
 * for free - which is what the reference's own page shows.
 */
const SECTIONS = [
  "key.groupGeneral",
  "key.groupSession",
  "key.groupNavigation",
  "key.groupModels",
  "key.groupTerminal",
  "key.groupPrompt",
  "key.groupDisplay",
] as const

/**
 * What the shortcuts page is narrowed to.
 *
 * The page carries every command, which now includes thirty-seven themes and
 * eighteen languages - the reference's own page is long for the same reason,
 * and ships a search box for the same reason. Matched against the name and the
 * chord, so both "terminal" and "ctrl+b" find their row.
 */
const keyFilter = ref("")

const SHORTCUTS = computed(() => {
  const needle = keyFilter.value.trim().toLowerCase()
  const bySection = new Map<string, { id: string; title: string; hint?: string }[]>()
  for (const command of props.commands) {
    /*
     * A hidden command is one the palette does not offer, either because it is
     * meaningless from where it would be chosen - opening the palette from
     * inside the palette - or because it is one of nine numbered project rows
     * that already appear as projects. opencode leaves them off this page for
     * the same reason, and with the themes and languages here the page is long
     * enough without ten rows nobody was looking for.
     */
    if (command.hidden) continue
    if (needle && !`${command.title} ${boundKeys(command)}`.toLowerCase().includes(needle)) continue
    const section = command.group ?? "key.groupGeneral"
    const rows = bySection.get(section) ?? []
    rows.push({ id: command.id, title: command.title, hint: command.hint })
    bySection.set(section, rows)
  }
  // Within a group, by name. The order they are declared in is the order the
  // command list happens to build them, which is not an order anyone can use to
  // find something.
  for (const rows of bySection.values()) rows.sort((a, b) => a.title.localeCompare(b.title))
  return SECTIONS.map((group) => ({ group, items: bySection.get(group) ?? [] })).filter(
    (section) => section.items.length > 0,
  )
})


/**
 * Both credentials, because a provider can hold either.
 *
 * Clearing the API key was the whole of this, so disconnecting a subscription
 * removed a key it never had and left its tokens in place - the row stayed
 * connected and the button looked broken.
 */
async function disconnect(provider: string) {
  const entry = app.providers.find((item) => item.id === provider)
  if (entry?.authenticated) await app.signOut(provider)
  await app.setApiKey(provider, "")
}

/** What a bucket does today, falling back to what it does untouched. */
function permissionOf(bucket: PermissionKind): PermissionAction {
  return app.config?.permissions?.[bucket] ?? DEFAULT_PERMISSIONS[bucket]
}

function actionLabel(action: PermissionAction): string {
  if (action === "allow") return t("set.permAllow")
  if (action === "deny") return t("set.permDeny")
  return t("set.permAsk")
}

function setPermission(bucket: PermissionKind, action: PermissionAction) {
  const current = { ...DEFAULT_PERMISSIONS, ...app.config?.permissions }
  if (current[bucket] === action) return
  void app.patchConfig({ permissions: { ...current, [bucket]: action } })
}

/**
 * True when nothing in this list will stop and ask.
 *
 * A bucket set to Deny counts as settled. This switch is about being
 * interrupted, and a refusal interrupts nobody - which also means it is not a
 * way to undo a "never": switching it on approves what would have asked and
 * leaves a refusal exactly as it was.
 */
function autoApproveAll(): boolean {
  return BUCKETS.every((bucket) => permissionOf(bucket) !== "ask")
}

function toggleAutoApproveAll() {
  const on = autoApproveAll()
  const next = { ...DEFAULT_PERMISSIONS, ...app.config?.permissions }
  for (const bucket of BUCKETS) {
    if (next[bucket] === "deny") continue
    next[bucket] = on ? DEFAULT_PERMISSIONS[bucket] : "allow"
  }
  void app.patchConfig({ permissions: next, accessLevel: on ? "ask" : "full" })
}

async function pickDirectory() {
  const [directory] = await window.mcode.pickDirectory(t("cmd.openProject"))
  if (directory) await app.patchConfig({ directory })
}

/** Where tasks with no project get their folders. Empty is the default under the home folder. */
async function pickProjectRoot() {
  const [directory] = await window.mcode.pickDirectory(t("set.pickDir"))
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
  settle: "set.chimeSettle",
  triple: "set.chimeTriple",
  sweep: "set.chimeSweep",
  duet: "set.chimeDuet",
  zen: "set.chimeZen",
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



/** Which provider row has its key field open. Only one at a time. */
/**
 * The vendor whose connect dialog is open.
 *
 * `undefined` with `connectOpen` set browses every provider, which is how the
 * quick connect button enters; a group jumps straight to that vendor's ways in.
 */
const connectTarget = ref<Group>()
const connectOpen = ref(false)

function openConnect(group?: Group) {
  connectTarget.value = group
  connectOpen.value = true
}

function closeConnect() {
  connectOpen.value = false
  connectTarget.value = undefined
}

/**
 * What a vendor row says about getting in.
 *
 * Naming the subscription is the useful part - "connect with an API key" on a
 * row that also takes a Pro account tells the wrong half of the story.
 */
function groupDescription(group: Group): string {
  const ways = waysFor(group.entries)
  const account = ways.find((entry) => entry.method === "oauth-browser" || entry.method === "oauth-headless")
  const keyed = ways.some((entry) => entry.method === "api-key")
  if (account && keyed) return t("connect.descBoth", { name: account.provider.name })
  if (account) return t("connect.descAccount", { name: account.provider.name })
  if (ways.every((entry) => entry.method === "local")) return t("auth.local")
  return t(group.entries[0].description)
}

/** Vendors with nothing connected yet, which is what the list below offers. */
const availableGroups = computed(() =>
  groupProviders(app.providers).filter((group) => !groupConnected(group)),
)
const busy = ref<string>()
/**
 * The last thing that went wrong, and which row it belongs to.
 *
 * Section-wide messages leave `id` unset and show at the top; anything raised
 * by acting on one provider is shown against that provider instead.
 */
const notice = ref<{ id?: string; text: string }>()

function say(text: string, id?: string) {
  notice.value = { id, text }
}

function noticeFor(id: string): string | undefined {
  return notice.value?.id === id ? notice.value.text : undefined
}
const customOpen = ref(false)
/** Per-provider endpoint overrides being edited, keyed by provider id. */
const endpoints = ref<Record<string, string>>({})

/**
 * A published base URL can move, and a wrong one turns into an opaque connection
 * failure. Letting it be corrected in place beats telling people to re-add the
 * provider as a custom one.
 */
/**
 * What the field shows: what has been typed, else the endpoint in force.
 *
 * Filling it in is the point - a local runtime's address is a port number, and
 * an empty box asks the user to remember it rather than telling them.
 */
function endpointValue(provider: { id: string; baseURL?: string }): string {
  return endpoints.value[provider.id] ?? provider.baseURL ?? ""
}

/** Nothing to save while the field still matches what is in force. */
function endpointChanged(provider: { id: string; baseURL?: string }): boolean {
  const typed = endpoints.value[provider.id]
  if (typed === undefined) return false
  const trimmed = typed.trim()
  return trimmed.length > 0 && trimmed !== (provider.baseURL ?? "")
}

async function saveEndpoint(provider: string) {
  const value = endpoints.value[provider]?.trim()
  if (!value) return
  await app.patchConfig({
    providerEndpoints: { ...(app.config?.providerEndpoints ?? {}), [provider]: value },
  })
  delete endpoints.value[provider]
  say(t("set.saved"), provider)
  setTimeout(() => (notice.value = undefined), 2000)
}

/** Connected first, then recommended, then the rest - the order people scan. */
const connected = computed(() => app.providers.filter((provider) => provider.configured))

/*
 * The rows the providers page draws, which is not the same set as the ones that
 * can answer a prompt.
 *
 * A custom provider is created from a display name and a base URL; the key
 * field beside them may be left blank. Such a provider counts as unconfigured,
 * so a list of configured providers left it out, and the vendor list underneath
 * is built from the known catalogue and has no row for it either. It was still
 * sitting in the config file, which made re-adding it under the same name fail
 * as a duplicate, and the only way to be rid of it was to edit that file by
 * hand. The reference has the same shape - its connected list carries providers
 * that came from config whether or not they have credentials, tagged "Custom" -
 * so a custom provider is listed here on the strength of existing, and its
 * Remove button is the way back out.
 */
const listedProviders = computed(() =>
  app.providers.filter((provider) => provider.configured || provider.custom),
)

/**
 * Whether a variable in the user's shell is the only thing connecting this
 * provider.
 *
 * There is then nothing here to disconnect - the app holds no key of its own,
 * and it cannot reach into the shell to unset one. The server refuses the
 * request for exactly this case, so a Disconnect button offered here could only
 * ever fail: the click went to a promise nothing caught, which Vue logged to a
 * console the user is not reading, leaving a button that looked live and did
 * nothing. The reference shows the sentence in place of the button instead, and
 * tags the row Environment.
 *
 * `authenticated` is the exception the server also makes: a subscription signed
 * in through OAuth is the app's to remove whatever the environment says.
 */
function fromEnvironment(provider: ProviderStatus): boolean {
  return Boolean(provider.environment) && !provider.authenticated
}


function key(provider: string, model: string) {
  return `${provider}/${model}`
}

/*
 * Smart's two models. An empty choice follows the default model; it is stored
 * as an empty reference rather than removed, because a patch cannot remove a
 * field once it has been set.
 */
const smartOptions = computed(() => [
  { value: "", label: t("set.smartDefault") },
  ...connected.value.flatMap((provider) =>
    provider.models.map((model) => ({ value: key(provider.id, model.id), label: `${provider.name} · ${model.name}` })),
  ),
])

function smartValue(field: "smartFast" | "smartMain") {
  const chosen = app.config?.[field]
  return chosen?.provider ? key(chosen.provider, chosen.model) : ""
}

function setSmartModel(field: "smartFast" | "smartMain", value: string) {
  const at = value.indexOf("/")
  const chosen = at > 0 ? { provider: value.slice(0, at), model: value.slice(at + 1) } : { provider: "", model: "" }
  void app.patchConfig(field === "smartFast" ? { smartFast: chosen } : { smartMain: chosen })
}

/* Clearing what the in-app browser has stored, after a confirmation, as MiMo asks for one. */
const confirmingClear = ref(false)

async function clearBrowsing() {
  confirmingClear.value = false
  const reason = await window.mcode.browserClearData()
  if (reason) notifyFailure(t("set.browsingDataFailed", { error: reason }))
  else notify(t("set.browsingDataCleared"))
}

/**
 * An empty list means "not curated yet", in which case everything is offered -
 * so the first toggle has to seed the list from what is currently visible,
 * otherwise turning one model off would appear to turn every other one off.
 */
function modelEnabled(provider: string, model: string) {
  const chosen = app.config?.enabledModels ?? []
  return chosen.length === 0 || chosen.includes(key(provider, model))
}

async function toggleModel(provider: string, model: string) {
  const chosen = app.config?.enabledModels ?? []
  const seeded = chosen.length
    ? chosen
    : app.providers.flatMap((entry) =>
        entry.configured ? entry.models.map((candidate) => key(entry.id, candidate.id)) : [],
      )
  const target = key(provider, model)
  const next = seeded.includes(target) ? seeded.filter((entry) => entry !== target) : [...seeded, target]
  await app.patchConfig({ enabledModels: next })
}

/**
 * A better answer than the network's own for a runtime on this machine.
 *
 * The transport can only report that nothing answered; what the user needs to
 * know is that the application being open is not the same as its API server
 * running.
 */
function localFailure(id: string): string | undefined {
  const entry = app.providers.find((item) => item.id === id)
  if (!entry?.authMethods?.includes("local")) return undefined
  return t("auth.localDown", { name: entry.name, url: entry.baseURL ?? "" })
}

async function refresh(provider: string) {
  busy.value = provider
  notice.value = undefined
  try {
    const result = await app.discoverModels(provider)
    say(t("provider.refreshed", { n: result }), provider)
  } catch (err) {
    say(localFailure(provider) ?? (err instanceof Error ? err.message : String(err)), provider)
  } finally {
    busy.value = undefined
    setTimeout(() => (notice.value = undefined), 4000)
  }
}


/**
 * Deleting a custom provider from the config.
 *
 * This is the only way out for one that was added without a key, so a failure
 * is put on the row instead of being dropped on the floor - a button that
 * silently does nothing would leave the provider as stranded as it was before
 * it started being drawn at all.
 */
/* MiMo's 编辑 / 复制 on a saved custom model; here on the custom provider that holds the models. */
const editingCustom = ref<string>()

function customEntry(id: string) {
  return app.config?.customProviders?.find((entry) => entry.id === id)
}

function editCustom(id: string) {
  if (!customEntry(id)) {
    notifyFailure(t("set.models.editFailed"))
    return
  }
  editingCustom.value = editingCustom.value === id ? undefined : id
}

async function copyCustom(provider: { id: string; name: string }) {
  try {
    await app.copyCustomProvider(provider.id, t("set.models.copyName", { name: provider.name }))
    notify(t("set.models.copied"))
  } catch {
    notifyFailure(t("set.models.copyFailed"))
  }
}

async function removeCustom(provider: string) {
  busy.value = provider
  notice.value = undefined
  try {
    await app.removeCustomProvider(provider)
  } catch (err) {
    say(err instanceof Error ? err.message : String(err), provider)
  } finally {
    busy.value = undefined
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape") return
  /*
   * The connect dialog opens on top of this one and listens for Escape too, so
   * without standing down here a single press closed both layers at once.
   */
  if (connectOpen.value) return
  emit("close")
}

onMounted(() => window.addEventListener("keydown", onKeydown))
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown))
</script>

<template>
  <div class="overlay" @mousedown.self="emit('close')">
    <div v-modal class="dialog">
      <!-- 2.0: MiMo's dialog closes from its own corner as well as from Escape
           and the scrim, which a pointer-only reader otherwise has to find. -->
      <button class="close" :aria-label="t('common.close')" @click="emit('close')">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
        </svg>
      </button>
      <nav class="nav">
        <div class="nav-title">{{ t("rail.settings") }}</div>
        <input
          v-model="navQuery"
          class="nav-search"
          :placeholder="t('set.search')"
          :aria-label="t('set.search')"
          spellcheck="false"
          autocomplete="off"
          @keydown.enter="openFirstMatch"
        />
        <!--
          MiMo's four groups, in its order. MCode's own server and provider pages
          sit beside Models, which they feed.
        -->
        <div v-show="navShows('general') || navShows('usage') || navShows('appearance') || navShows('files') || navShows('models') || navShows('server') || navShows('personal') || navShows('keys')" class="nav-group">{{ t("set.group.personal") }}</div>

        <button v-show="navShows('general')" class="nav-item" :class="{ on: section === 'general' }" @click="section = 'general'">
          <svg class="nav-ico" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path
              d="M3.625 6.25H10.9375M16.375 13.75H10.5625M3.625 13.75H4.9375M11.125 6.25C11.125 4.79969 12.2997 3.625 13.75 3.625C15.2003 3.625 16.375 4.79969 16.375 6.25C16.375 7.70031 15.2003 8.875 13.75 8.875C12.2997 8.875 11.125 7.70031 11.125 6.25ZM10.375 13.75C10.375 15.2003 9.20031 16.375 7.75 16.375C6.29969 16.375 5.125 15.2003 5.125 13.75C5.125 12.2997 6.29969 11.125 7.75 11.125C9.20031 11.125 10.375 12.2997 10.375 13.75Z"
              stroke="currentColor"
              stroke-linecap="square"
            />
          </svg>
          {{ t("set.nav.general") }}
        </button>

        <button v-show="navShows('usage')" class="nav-item" :class="{ on: section === 'usage' }" @click="section = 'usage'">
          <svg class="nav-ico" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M4 16V9M8 16V5M12 16v-4M16 16v-8" stroke="currentColor" stroke-linecap="round" />
          </svg>
          <span>{{ t("set.nav.usage") }}</span>
        </button>

        <button v-show="navShows('appearance')" class="nav-item" :class="{ on: section === 'appearance' }" @click="section = 'appearance'">
          <svg class="nav-ico" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <circle cx="10" cy="10" r="6.5" stroke="currentColor" />
            <path d="M10 3.5a6.5 6.5 0 0 1 0 13z" fill="currentColor" />
          </svg>
          <span>{{ t("set.appearance") }}</span>
        </button>

        <button v-show="navShows('files')" class="nav-item" :class="{ on: section === 'files' }" @click="section = 'files'">
          <svg class="nav-ico" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M5 3.5h6l4 4V16.5H5z" stroke="currentColor" stroke-linejoin="round" />
            <path d="M11 3.5v4h4" stroke="currentColor" stroke-linejoin="round" />
          </svg>
          <span>{{ t("set.nav.files") }}</span>
        </button>

        <button v-show="navShows('models')" class="nav-item" :class="{ on: section === 'models' }" @click="section = 'models'">
          <svg class="nav-ico" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path
              fill-rule="evenodd"
              clip-rule="evenodd"
              d="M17.5 10C12.2917 10 10 12.2917 10 17.5C10 12.2917 7.70833 10 2.5 10C7.70833 10 10 7.70833 10 2.5C10 7.70833 12.2917 10 17.5 10Z"
              stroke="currentColor"
            />
          </svg>
          {{ t("set.models") }}
        </button>

        <button v-show="navShows('server')" class="nav-item" :class="{ on: section === 'server' }" @click="section = 'server'">
          <svg class="nav-ico" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <rect x="3.35547" y="1.92969" width="13.2857" height="16.1429" stroke="currentColor" />
            <rect x="3.35547" y="11.9297" width="13.2857" height="6.14286" stroke="currentColor" />
            <rect x="12.8555" y="14.2852" width="1.42857" height="1.42857" fill="currentColor" />
            <rect x="10" y="14.2852" width="1.42857" height="1.42857" fill="currentColor" />
          </svg>
          {{ t("set.server") }}
        </button>

        <button v-show="navShows('personal')" class="nav-item" :class="{ on: section === 'personal' }" @click="section = 'personal'">
          <svg class="nav-ico" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <circle cx="10" cy="7" r="3" stroke="currentColor" />
            <path d="M4.5 16c0-2.5 2.5-4 5.5-4s5.5 1.5 5.5 4" stroke="currentColor" stroke-linecap="round" />
          </svg>
          <span>{{ t("set.personal") }}</span>
        </button>

        <button v-show="navShows('keys')" class="nav-item" :class="{ on: section === 'keys' }" @click="section = 'keys'">
          <svg class="nav-ico" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path
              d="M5.125 7.375V4.375H14.875V2.875M8.3125 13.9375H11.6875M8.125 13.9375H11.875M2.125 7.375H17.875V17.125H2.125V7.375ZM5.5 10.375H5.125V10.75H5.5V10.375ZM8.5 10.375H8.125V10.75H8.5V10.375ZM11.875 10.375H11.5V10.75H11.875V10.375ZM14.875 10.375H14.5V10.75H14.875V10.375ZM14.875 13.75H14.5V14.125H14.875V13.75ZM5.5 13.75H5.125V14.125H5.5V13.75Z"
              stroke="currentColor"
              stroke-linecap="square"
            />
          </svg>
          {{ t("set.shortcuts") }}
        </button>

        <div v-show="navShows('mcp')" class="nav-group">{{ t("set.group.integrations") }}</div>

        <button v-show="navShows('mcp')" class="nav-item" :class="{ on: section === 'mcp' }" @click="section = 'mcp'">
          <svg class="nav-ico" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path
              d="M7.5 2.5v3.5M12.5 2.5v3.5M5.5 6h9v3.5a4.5 4.5 0 0 1-9 0V6ZM10 14v3.5"
              stroke="currentColor"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <span>{{ t("set.nav.mcp") }}</span>
        </button>

        <div v-show="navShows('environment')" class="nav-group">{{ t("set.group.coding") }}</div>

        <button v-show="navShows('environment')" class="nav-item" :class="{ on: section === 'environment' }" @click="section = 'environment'">
          <svg class="nav-ico" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M6.5 4v6.5a2 2 0 0 0 2 2H14" stroke="currentColor" stroke-linecap="round" />
            <circle cx="6.5" cy="3.6" r="1.6" stroke="currentColor" />
            <circle cx="15.4" cy="12.5" r="1.6" stroke="currentColor" />
            <circle cx="6.5" cy="15.4" r="1.6" stroke="currentColor" />
          </svg>
          <span>{{ t("set.environment") }}</span>
        </button>

        <div v-show="navShows('archive')" class="nav-group">{{ t("set.group.archived") }}</div>

        <button v-show="navShows('archive')" class="nav-item" :class="{ on: section === 'archive' }" @click="section = 'archive'">
          <svg class="nav-ico" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path
              d="M16.8747 6.24935H17.3747V5.74935H16.8747V6.24935ZM16.8747 16.8743V17.3743H17.3747V16.8743H16.8747ZM3.12467 16.8743H2.62467V17.3743H3.12467V16.8743ZM3.12467 6.24935V5.74935H2.62467V6.24935H3.12467ZM2.08301 2.91602V2.41602H1.58301V2.91602H2.08301ZM17.9163 2.91602H18.4163V2.41602H17.9163V2.91602ZM17.9163 6.24935V6.74935H18.4163V6.24935H17.9163ZM2.08301 6.24935H1.58301V6.74935H2.08301V6.24935ZM8.33301 9.08268H7.83301V10.0827H8.33301V9.58268V9.08268ZM11.6663 10.0827H12.1663V9.08268H11.6663V9.58268V10.0827ZM16.8747 6.24935H16.3747V16.8743H16.8747H17.3747V6.24935H16.8747ZM16.8747 16.8743V16.3743H3.12467V16.8743V17.3743H16.8747V16.8743ZM3.12467 16.8743H3.62467V6.24935H3.12467H2.62467V16.8743H3.12467ZM3.12467 6.24935V6.74935H16.8747V6.24935V5.74935H3.12467V6.24935ZM2.08301 2.91602V3.41602H17.9163V2.91602V2.41602H2.08301V2.91602ZM17.9163 2.91602H17.4163V6.24935H17.9163H18.4163V2.91602H17.9163ZM17.9163 6.24935V5.74935H2.08301V6.24935V6.74935H17.9163V6.24935ZM2.08301 6.24935H2.58301V2.91602H2.08301H1.58301V6.24935H2.08301ZM8.33301 9.58268V10.0827H11.6663V9.58268V9.08268H8.33301V9.58268Z"
              fill="currentColor"
            />
          </svg>
          {{ t("set.nav.archive") }}
        </button>

        <div v-show="navShows('updates')" class="nav-group">{{ t("set.groupAbout") }}</div>

        <button v-show="navShows('updates')" class="nav-item" :class="{ on: section === 'updates' }" @click="section = 'updates'">
          <svg class="nav-ico" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M10 4v8M10 4 6.8 7.2M10 4l3.2 3.2" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M4.5 13.5v2h11v-2" stroke="currentColor" stroke-linecap="round" />
          </svg>
          <span>{{ t("set.nav.updates") }}</span>
        </button>

        <div v-if="!navMatches.length" class="nav-empty">{{ t("set.noMatch") }}</div>

        <div class="nav-foot">
          MCode Desktop<br />
          v{{ app.version }}
        </div>
      </nav>

      <div class="content">
        <!-- General -->
        <template v-if="section === 'general'">
          <h2>{{ t("set.nav.general") }}</h2>
          <div class="card">
            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.language") }}</div>
                <div class="line-sub">{{ t("set.languageSub") }}</div>
              </div>
              <SelectMenu
                :model-value="language"
                :options="languageOptions"
                @update:model-value="app.patchConfig({ language: $event as Language })"
              />
            </div>

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
                @click="app.patchConfig({ allowFullAccess: !app.config?.allowFullAccess })"
              >
                <span class="knob" />
              </button>
            </div>

            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.autoAccept") }}</div>
                <div class="line-sub">{{ t("set.autoAcceptSub") }}</div>
              </div>
              <button class="switch" :class="{ on: autoApproveAll() }" @click="toggleAutoApproveAll">
                <span class="knob" />
              </button>
            </div>

            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.shell") }}</div>
                <div class="line-sub">{{ t("set.shellSub") }}</div>
              </div>
              <SelectMenu
                :model-value="app.config?.shell ?? ''"
                :options="shellOptions"
                @update:model-value="app.patchConfig({ shell: $event })"
              />
            </div>

            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.reasoning") }}</div>
                <div class="line-sub">{{ t("set.reasoningSub") }}</div>
              </div>
              <button
                class="switch"
                :class="{ on: app.config?.showReasoning }"
                @click="app.patchConfig({ showReasoning: !app.config?.showReasoning })"
              >
                <span class="knob" />
              </button>
            </div>

            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.expandShell") }}</div>
                <div class="line-sub">{{ t("set.expandShellSub") }}</div>
              </div>
              <button
                class="switch"
                :class="{ on: app.config?.expandShell }"
                @click="app.patchConfig({ expandShell: !app.config?.expandShell })"
              >
                <span class="knob" />
              </button>
            </div>

            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.expandEdits") }}</div>
                <div class="line-sub">{{ t("set.expandEditsSub") }}</div>
              </div>
              <button
                class="switch"
                :class="{ on: app.config?.expandEdits }"
                @click="app.patchConfig({ expandEdits: !app.config?.expandEdits })"
              >
                <span class="knob" />
              </button>
            </div>

            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.directory") }}</div>
                <div class="line-sub">{{ t("set.directorySub") }}</div>
              </div>
              <button class="ctl-btn" @click="pickDirectory">{{ app.config?.directory ?? "-" }}</button>
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

            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.effort") }}</div>
                <div class="line-sub">{{ t("set.effortSub") }}</div>
              </div>
              <SelectMenu
                :model-value="app.config?.effort ?? 'high'"
                :options="effortOptions"
                @update:model-value="app.patchConfig({ effort: $event as 'high' })"
              />
            </div>
          </div>

          <h3>{{ t("set.voice") }}</h3>
          <div class="card">
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

            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.voiceMode") }}</div>
                <div class="line-sub">{{ t("set.voiceModeSub") }}</div>
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
            <Teleport to="body">
              <ConfirmDialog
                v-if="confirmingVoiceSend"
                :title="t('set.voiceSendConfirmTitle')"
                :body="t('set.voiceSendConfirmBody')"
                :confirm-label="t('set.voiceSendConfirmOk')"
                @confirm="enableVoiceSend"
                @close="confirmingVoiceSend = false"
              />
            </Teleport>

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

          <h3>{{ t("set.notifications") }}</h3>
          <div class="card">
            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.notifyAgent") }}</div>
                <div class="line-sub">{{ t("set.notifyAgentSub") }}</div>
              </div>
              <button
                class="switch"
                :class="{ on: app.config?.notifyAgent }"
                @click="app.patchConfig({ notifyAgent: !app.config?.notifyAgent })"
              >
                <span class="knob" />
              </button>
            </div>

            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.notifyPermission") }}</div>
                <div class="line-sub">{{ t("set.notifyPermissionSub") }}</div>
              </div>
              <button
                class="switch"
                :class="{ on: app.config?.notifyPermission }"
                @click="app.patchConfig({ notifyPermission: !app.config?.notifyPermission })"
              >
                <span class="knob" />
              </button>
            </div>

            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.notifyError") }}</div>
                <div class="line-sub">{{ t("set.notifyErrorSub") }}</div>
              </div>
              <button
                class="switch"
                :class="{ on: app.config?.notifyError }"
                @click="app.patchConfig({ notifyError: !app.config?.notifyError })"
              >
                <span class="knob" />
              </button>
            </div>
          </div>

          <h3>{{ t("set.sounds") }}</h3>
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
                @click="app.patchConfig({ spineSound: app.config?.spineSound === false })"
              >
                <span class="knob" />
              </button>
            </div>

            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.soundPermission") }}</div>
                <div class="line-sub">{{ t("set.soundPermissionSub") }}</div>
              </div>
              <button
                class="switch"
                :class="{ on: app.config?.soundPermission }"
                @click="app.patchConfig({ soundPermission: !app.config?.soundPermission })"
              >
                <span class="knob" />
              </button>
            </div>

            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.soundError") }}</div>
                <div class="line-sub">{{ t("set.soundErrorSub") }}</div>
              </div>
              <button
                class="switch"
                :class="{ on: app.config?.soundError }"
                @click="app.patchConfig({ soundError: !app.config?.soundError })"
              >
                <span class="knob" />
              </button>
            </div>
          </div>

          <h3>{{ t("set.display") }}</h3>
          <div class="card">
            <!--
              Ahead of the zoom gesture, which is where opencode has it: after
              the three notification rows and before the display ones.
            -->
            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.releaseNotes") }}</div>
                <div class="line-sub">{{ t("set.releaseNotesSub") }}</div>
              </div>
              <button
                class="switch"
                :class="{ on: app.config?.releaseNotes }"
                @click="app.patchConfig({ releaseNotes: !app.config?.releaseNotes })"
              >
                <span class="knob" />
              </button>
            </div>

            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.pinchZoom") }}</div>
                <div class="line-sub">{{ t("set.pinchZoomSub") }}</div>
              </div>
              <button
                class="switch"
                :class="{ on: app.config?.pinchZoom }"
                @click="app.patchConfig({ pinchZoom: !app.config?.pinchZoom })"
              >
                <span class="knob" />
              </button>
            </div>
          </div>

          <!-- MiMo's browser group: the in-app browser itself, and what it has stored. -->
          <h3>{{ t("set.browser") }}</h3>
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
                @click="app.patchConfig({ browserEnabled: app.config?.browserEnabled === false })"
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

          <!--
            What the title bar carries, and what a session offers. The bar
            holds one control by default, the way opencode's does; these put
            the rest back for anyone who wants them to hand.
          -->
          <h3>{{ t("set.advanced") }}</h3>
          <div class="card">
            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.fileTree") }}</div>
                <div class="line-sub">{{ t("set.fileTreeSub") }}</div>
              </div>
              <button
                class="switch"
                :class="{ on: app.config?.showFileTree }"
                @click="app.patchConfig({ showFileTree: !app.config?.showFileTree })"
              >
                <span class="knob" />
              </button>
            </div>

            <!-- The bottom-panel toggle in the bar, which a reader can take away. -->
            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.showTerm") }}</div>
                <div class="line-sub">{{ t("set.showTermSub") }}</div>
              </div>
              <button
                class="switch"
                :class="{ on: app.config?.showTerminal }"
                @click="app.patchConfig({ showTerminal: !app.config?.showTerminal })"
              >
                <span class="knob" />
              </button>
            </div>

          </div>

          <h3>{{ t("set.perTool") }}</h3>
          <p class="note">{{ t("set.perToolSub") }}</p>
          <div class="card">
            <div v-for="bucket in BUCKETS" :key="bucket" class="line">
              <div class="line-text">
                <div class="line-title">
                  <span class="tool" :class="{ raw: !TITLED_BUCKETS.has(bucket) }">{{ bucketTitle(bucket) }}</span>
                  <!--
                    The tag says in which way a bucket is consequential, and a
                    bucket that is neither gets none: a read-only tool wearing a
                    "makes changes" label would be worse than no label at all.
                  -->
                  <span v-if="NETWORK.has(bucket) || WRITES.has(bucket)" class="tag warn">
                    {{ NETWORK.has(bucket) ? t("set.network") : t("set.writes") }}
                  </span>
                </div>
                <div class="line-sub">{{ t(`tool.desc.${bucket}`) }}</div>
              </div>
              <div class="choice" role="radiogroup" :aria-label="bucketTitle(bucket)">
                <button
                  v-for="action in ACTIONS"
                  :key="action"
                  class="choice-btn"
                  :class="{ on: permissionOf(bucket) === action, deny: action === 'deny' }"
                  role="radio"
                  :aria-checked="permissionOf(bucket) === action"
                  @click="setPermission(bucket, action)"
                >
                  {{ actionLabel(action) }}
                </button>
              </div>
            </div>
          </div>

          <h3>{{ t("set.resetKey") }}</h3>
          <div class="card">
            <div class="line">
              <div class="line-sub reset-note">{{ t("set.resetSub") }}</div>
              <button v-if="!confirmingReset" class="ctl-btn" @click="armReset">
                {{ t("set.resetAction") }}
              </button>
            </div>

            <div v-if="confirmingReset" ref="resetGate" class="reset-gate">
              <!-- Said in numbers, because "all sessions" does not feel like anything. -->
              <p class="reset-count">{{ t("set.resetCount", { n: app.sessions.length }) }}</p>
              <div class="confirm">
                <button class="ctl-btn" @click="cancelReset">{{ t("common.cancel") }}</button>
                <button class="danger-btn" @click="resetEverything">
                  {{ t("set.resetConfirm") }}
                </button>
              </div>
            </div>
          </div>
        </template>

        <!-- Keyboard -->
        <!-- Appearance: a page of its own, as MiMo keeps it, rather than a group under General. -->
        <template v-else-if="section === 'appearance'">
          <h2>{{ t("set.appearance") }}</h2>
          <div class="card">
            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.scheme") }}</div>
                <div class="line-sub">{{ t("set.schemeSub") }}</div>
              </div>
              <SelectMenu
                :model-value="app.config?.theme ?? 'system'"
                :options="themeOptions"
                @update:model-value="app.patchConfig({ theme: $event as 'dark' })"
              />
            </div>

            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.themePalette") }}</div>
                <div class="line-sub">{{ t("set.themePaletteSub") }}</div>
              </div>
              <SelectMenu
                :model-value="app.config?.themeID ?? DEFAULT_THEME"
                :options="paletteOptions"
                @update:model-value="app.patchConfig({ themeID: $event })"
              />
            </div>

            <!--
              The mark comes in six colourways. They are drawn here rather than
              loaded as pictures, from the same string the icon files are
              rasterised from, so the tile a reader presses is the icon they
              get rather than a picture of one that might have drifted.
            -->
            <div class="line icons">
              <div class="line-text">
                <div class="line-title">{{ t("set.appIcon") }}</div>
                <div class="line-sub">{{ t("set.appIconSub") }}</div>
              </div>
              <div class="gallery" role="radiogroup" :aria-label="t('set.appIcon')">
                <button
                  v-for="tile in iconTiles"
                  :key="tile.spec.id"
                  class="tile"
                  :class="{ on: appIcon === tile.spec.id }"
                  role="radio"
                  :aria-checked="appIcon === tile.spec.id"
                  :aria-label="tile.spec.name"
                  @click="app.patchConfig({ appIcon: tile.spec.id })"
                >
                  <img v-if="tile.image" class="tile-art" :src="tile.image" width="44" height="44" alt="" />
                  <span v-else class="tile-art" v-html="tile.svg" />
                  <span class="tile-name">{{ tile.spec.name }}</span>
                </button>
              </div>
            </div>

            <!--
              Four questions the stylesheet answers, kept together because they
              are all about how the window behaves rather than what it holds.
            -->
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
                  @change="setSize('uiFontSize', $event, 14)"
                  @keydown.enter="($event.target as HTMLInputElement).blur()"
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
                  @change="setSize('codeFontSize', $event, 12)"
                  @keydown.enter="($event.target as HTMLInputElement).blur()"
                />
                <span class="unit">px</span>
              </span>
            </div>

            <!--
              Three faces rather than one, because the jobs differ: prose wants
              a different face from code, and a terminal wants one whose glyphs
              are all the same width whatever the rest of the app uses.
            -->
            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.uiFont") }}</div>
                <div class="line-sub">{{ t("set.uiFontSub") }}</div>
              </div>
              <input
                class="field font-field"
                :value="app.config?.uiFont ?? ''"
                :placeholder="FONT_SANS_DEFAULT"
                spellcheck="false"
                @change="app.patchConfig({ uiFont: ($event.target as HTMLInputElement).value.trim() })"
              />
            </div>

            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.codeFont") }}</div>
                <div class="line-sub">{{ t("set.codeFontSub") }}</div>
              </div>
              <input
                class="field font-field"
                :value="app.config?.codeFont ?? ''"
                :placeholder="FONT_MONO_DEFAULT"
                spellcheck="false"
                @change="app.patchConfig({ codeFont: ($event.target as HTMLInputElement).value.trim() })"
              />
            </div>

            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.terminalFont") }}</div>
                <div class="line-sub">{{ t("set.terminalFontSub") }}</div>
              </div>
              <input
                class="field font-field"
                :value="app.config?.terminalFont ?? ''"
                :placeholder="FONT_TERMINAL_DEFAULT"
                spellcheck="false"
                @change="app.patchConfig({ terminalFont: ($event.target as HTMLInputElement).value.trim() })"
              />
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
                <div class="line-title">{{ t("set.tray") }}</div>
                <div class="line-sub">{{ t("set.traySub") }}</div>
              </div>
              <button
                class="switch"
                :class="{ on: app.config?.tray ?? true }"
                role="switch"
                :aria-checked="app.config?.tray ?? true"
                :aria-label="t('set.tray')"
                @click="app.patchConfig({ tray: !(app.config?.tray ?? true) })"
              >
                <span class="knob" />
              </button>
            </div>

            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.fontSmoothing") }}</div>
                <div class="line-sub">{{ t("set.fontSmoothingSub") }}</div>
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

            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.wrapCode") }}</div>
                <div class="line-sub">{{ t("set.wrapCodeSub") }}</div>
              </div>
              <button
                class="switch"
                :class="{ on: app.config?.wrapCode ?? true }"
                role="switch"
                :aria-checked="app.config?.wrapCode ?? true"
                :aria-label="t('set.wrapCode')"
                @click="app.patchConfig({ wrapCode: !(app.config?.wrapCode ?? true) })"
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
          <p class="page-sub ci-sub">
            {{ t("set.instructionsSub") }}
            <button type="button" class="ci-link" :aria-expanded="ciHelpOpen" @click="ciHelpOpen = !ciHelpOpen">
              {{ t("set.learnMore") }}
            </button>
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
            <button class="ctl-btn" :disabled="!dirty" @click="saveInstructions">
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
                <div class="line-sub mcp-path" data-config-path :title="configFile?.path">{{ configFile?.path ?? "" }}</div>
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
                  placeholder="value"
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
                  placeholder="value"
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
          <div class="card" data-mcp-list>
            <template v-for="row in mcpRows" :key="row.name">
              <div class="line" :data-mcp-row="row.name">
                <div class="line-text">
                  <div class="line-title">{{ row.name }}</div>
                  <div class="line-sub mcp-row-desc">
                    <span>{{ t(row.remote ? "set.mcp.remote" : "set.mcp.local") }}</span>
                    <span class="mcp-status" :class="MCP_TONE[row.status]" :data-mcp-status="row.status" :title="row.error">
                      <span class="mcp-status-dot" />
                      {{ t(`set.mcp.status.${row.status}`) }}
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
                  <button class="ctl-btn" :data-mcp-tools="row.name" @click="toggleMcpTools(row.name)">{{ t("set.mcp.tools") }}</button>
                  <button class="ctl-btn" :data-mcp-edit="row.name" @click="editMcp(row.name)">{{ t("set.mcp.edit") }}</button>
                  <button class="ctl-btn" :data-mcp-rm="row.name" @click="removeMcp(row.name)">{{ t("set.mcp.remove") }}</button>
                </div>
              </div>
              <div v-if="mcpToolsOpen === row.name" class="mcp-tools-panel" :data-mcp-tools-panel="row.name">
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
          <p class="page-sub mcp-sub">{{ t("set.mcp.manualSub") }}</p>
          <div class="card">
            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.mcp.configFile") }}</div>
                <div class="line-sub mcp-path" data-config-path :title="configFile?.path">
                  {{ configFile?.path ?? t("set.mcp.configResolving") }}
                </div>
              </div>
            </div>
          </div>
          <p class="page-sub mcp-example-label">{{ t("set.mcp.exampleLabel") }}</p>
          <pre class="mcp-example" data-mcp-example><code>{{ MCP_EXAMPLE }}</code></pre>
        </template>

        <template v-else-if="section === 'environment' && configuring">
          <button class="env-back" @click="configuring = undefined">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M10 4 6 8l4 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            {{ t("set.envBack") }}
          </button>
          <h3>{{ t("set.localEnv") }}</h3>
          <div class="card">
            <div class="line env-local">
              <div class="line-text">
                <div class="line-title">{{ projectName(configuring, app.config?.projectNames) }}</div>
                <div class="line-sub path">{{ configuring }}</div>
              </div>
            </div>
          </div>
          <h3>{{ t("set.envName") }}</h3>
          <input v-model="envName" class="env-input" :placeholder="t('set.envNamePlaceholder')" spellcheck="false" />
          <div class="env-save-row">
            <button class="ctl-btn env-save" :disabled="!envDirty" @click="saveEnv">{{ t("set.envSave") }}</button>
          </div>
        </template>

        <template v-else-if="section === 'environment'">
          <h2>{{ t("set.environment") }}</h2>
          <p class="page-sub">{{ t("set.environmentSub") }}</p>

          <div class="sec-row">
            <h3>{{ t("set.selectProject") }}</h3>
            <button class="ctl-btn add-project" @click="addProject">{{ t("set.addProject") }}</button>
          </div>
          <div class="card env-projects">
            <div v-for="directory in envProjects" :key="directory" class="line env-project">
              <div class="line-text">
                <div class="line-title env-project-name">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path
                      d="M1.9 4.2c0-.6.5-1.1 1.1-1.1h2.6l1.3 1.5h6.1c.6 0 1.1.5 1.1 1.1v6.1c0 .6-.5 1.1-1.1 1.1H3c-.6 0-1.1-.5-1.1-1.1z"
                      stroke="currentColor"
                      stroke-width="1.2"
                      stroke-linejoin="round"
                    />
                  </svg>
                  {{ projectName(directory, app.config?.projectNames) }}
                </div>
                <div class="line-sub path">{{ directory }}</div>
              </div>
              <button
                class="ctl-btn env-icon"
                data-act="remove"
                :aria-label="t('set.removeProject')"
                v-tip="{ label: t('set.removeProject') }"
                @click="removingProject = directory"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
              <button
                class="ctl-btn env-icon"
                data-act="configure"
                :aria-label="t('set.configureProject')"
                v-tip="{ label: t('set.configureProject') }"
                @click="configure(directory)"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
                </svg>
              </button>
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
              :aria-label="t('set.refreshWorktrees')"
              v-tip="{ label: t('set.refreshWorktrees') }"
              @click="refreshTrees"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
          </div>
          <p v-if="!treesLoaded" class="page-sub wt-loading">{{ t("set.loading") }}</p>
          <div v-else-if="!trees.length" class="card">
            <div class="line wt-empty">
              <div class="line-text">
                <div class="line-title">{{ t("set.noWorktreesTitle") }}</div>
                <div class="line-sub">{{ t("set.noWorktreesSub") }}</div>
              </div>
            </div>
          </div>
          <template v-else>
            <p class="page-sub wt-count">{{ t("set.worktreeCount", { n: String(trees.length) }) }}</p>
            <div class="card wt-list">
              <div v-for="tree in trees" :key="tree.directory" class="line wt-row">
                <span class="wt-name" :title="tree.name">{{ tree.name }}</span>
                <span class="tag">{{ tree.branch || t("set.detached") }}</span>
                <span class="tag">{{ t("set.worktreeProject", { name: projectName(tree.project, app.config?.projectNames) }) }}</span>
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
              @confirm="removeProject"
              @close="removingProject = undefined"
            />
          </Teleport>
        </template>

        <template v-else-if="section === 'usage'">
          <h2>{{ t("set.nav.usage") }}</h2>
          <p class="page-sub">{{ t("set.usageSub") }}</p>
          <div class="card">
            <div class="totals">
              <div class="total">
                <span class="total-value">{{ money.format(usage?.total.cost ?? 0) }}</span>
                <span class="total-name">{{ t("context.usage.cost") }}</span>
              </div>
              <div class="total">
                <span class="total-value">{{ tokens(usage?.total.input ?? 0) }}</span>
                <span class="total-name">{{ t("set.usageInput") }}</span>
              </div>
              <div class="total">
                <span class="total-value">{{ tokens(usage?.total.output ?? 0) }}</span>
                <span class="total-name">{{ t("set.usageOutput") }}</span>
              </div>
              <div class="total">
                <span class="total-value">{{ usage?.turns ?? 0 }}</span>
                <span class="total-name">{{ t("set.usageTurns") }}</span>
              </div>
            </div>
          </div>

          <h3>{{ t("set.usageByDay", { n: String(usage?.days ?? 14) }) }}</h3>
          <div class="card">
            <div v-for="day in usage?.byDay ?? []" :key="day.key" class="day">
              <span class="day-name">{{ day.key.slice(5) }}</span>
              <span class="day-bar">
                <span
                  class="day-fill"
                  :style="{
                    width:
                      Math.max(2, ((day.usage.input + day.usage.output) / busiestDay) * 100) + '%',
                  }"
                />
              </span>
              <span class="day-value">{{ tokens(day.usage.input + day.usage.output) }}</span>
              <span class="day-cost">{{ money.format(day.usage.cost) }}</span>
            </div>
            <p v-if="usage && !usage.byDay.length" class="line-sub">{{ t("set.usageNone") }}</p>
          </div>

          <h3>{{ t("set.usageByModel") }}</h3>
          <div class="card">
            <div v-for="entry in usage?.byModel ?? []" :key="entry.key" class="line">
              <div class="line-text">
                <div class="line-title">{{ entry.key }}</div>
                <div class="line-sub">
                  {{ t("set.usageTurnCount", { n: String(entry.turns) }) }} ·
                  {{ tokens(entry.usage.input + entry.usage.output) }}
                </div>
              </div>
              <span class="total-value small">{{ money.format(entry.usage.cost) }}</span>
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
                  <span v-if="updateReady" class="update-hint" data-update-install-hint>{{ t("set.updateInstallHint") }}</span>
                </div>
              </div>
              <button v-if="updateReady" class="ctl-btn update-install" data-update-install @click="emit('install-update')">
                {{ t("set.restartUpdate") }}
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
          </div>

        </template>

        <template v-else-if="section === 'keys'">
          <h2>{{ t("set.shortcuts") }}</h2>
          <p class="note">{{ t("set.shortcutsSub") }}</p>
          <div v-if="Object.keys(app.config?.keybinds ?? {}).length" class="confirm reset-all">
            <button class="ctl-btn" @click="app.patchConfig({ keybinds: {} })">
              {{ t("set.resetKeys") }}
            </button>
          </div>

          <!--
            Finding a row meant scrolling past every theme and every language,
            which is what the reference's own search box is here to answer.
          -->
          <input v-model="keyFilter" class="field key-search" :placeholder="t('key.search')" spellcheck="false" />
          <p v-if="!SHORTCUTS.length" class="note">{{ t("key.searchEmpty") }}</p>

          <template v-for="group in SHORTCUTS" :key="group.group">
            <h3>{{ t(group.group) }}</h3>
            <div class="card keys-card">
              <div v-for="shortcut in group.items" :key="shortcut.id" class="line">
                <div class="line-title">{{ shortcut.title }}</div>
                <div class="confirm">
                  <button
                    class="keys editable"
                    :class="{ capturing: capturing === shortcut.id, unset: !boundKeys(shortcut) }"
                    @click="beginCapture(shortcut.id)"
                  >
                    {{
                      capturing === shortcut.id
                        ? t("set.pressKeys")
                        : boundKeys(shortcut) || t("key.unassigned")
                    }}
                  </button>
                  <button
                    v-if="app.config?.keybinds?.[shortcut.id]"
                    class="plink"
                    @click="resetBinding(shortcut.id)"
                  >
                    {{ t("set.reset") }}
                  </button>
                </div>
              </div>
            </div>
          </template>
        </template>

        <!-- Archive -->
        <template v-else-if="section === 'archive'">
          <h2>{{ t("set.nav.archive") }}</h2>
          <p class="note">{{ t("set.archiveSub") }}</p>

          <h3 class="sub-head">{{ t("set.closedProjects") }}</h3>
          <p class="sub-note">{{ t("set.closedSub") }}</p>

          <div v-if="!closedProjects.length" class="empty-note">{{ t("set.closedEmpty") }}</div>

          <div v-else class="card">
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

          <div class="sec-row archived-head">
            <h3 class="sub-head">{{ t("set.archivedSessions") }}</h3>
            <button
              v-if="archived.length"
              class="ctl-btn batch-toggle"
              @click="selecting ? stopSelecting() : (selecting = true)"
            >
              {{ selecting ? t("set.batchDone") : t("set.batchManage") }}
            </button>
          </div>
          <p class="sub-note">{{ t("set.archivedSub") }}</p>

          <div v-if="!archived.length" class="empty-note">{{ t("set.archiveEmpty") }}</div>

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
                  class="plink danger"
                  data-batch="delete"
                  :disabled="!pickedLive.length"
                  @click="confirmingDelete = { ids: [...pickedLive] }"
                >
                  {{ t("set.deleteN", { n: String(pickedLive.length) }) }}
                </button>
              </span>
            </div>

            <div class="card">
              <div
                v-for="session in archived"
                :key="session.id"
                class="line archived-row"
                :class="{ picking: selecting }"
                :role="selecting ? 'checkbox' : undefined"
                :aria-checked="selecting ? pickedLive.includes(session.id) : undefined"
                @click="selecting && togglePick(session.id)"
              >
                <span v-if="selecting" class="check" :class="{ on: pickedLive.includes(session.id) }" aria-hidden="true">
                  <svg v-if="pickedLive.includes(session.id)" width="10" height="10" viewBox="0 0 12 12" fill="none">
                    <path d="M2.5 6.2 5 8.6l4.5-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </span>
                <div class="line-text">
                  <div class="line-title">{{ sessionTitle(session.title) }}</div>
                  <div class="line-sub">{{ session.directory }} · {{ ago(session.updated) }}</div>
                </div>
                <div v-if="!selecting" class="confirm">
                  <button class="ctl-btn" @click="app.archive(session.id, false)">{{ t("set.unarchive") }}</button>
                  <button
                    class="plink danger"
                    @click="confirmingDelete = { ids: [session.id], title: sessionTitle(session.title) }"
                  >
                    {{ t("set.deleteForever") }}
                  </button>
                </div>
              </div>
            </div>
          </template>

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
              :confirm-label="t('set.deleteForever')"
              @confirm="confirmRemove"
              @close="confirmingDelete = undefined"
            />
          </Teleport>
        </template>

        <!-- Server -->
        <template v-else-if="section === 'server'">
          <h2>{{ t("set.server") }}</h2>
          <!--
            opencode's server row, measured: one 20px line inside a list
            padded 20, a 6px dot and then the name 10 after it, and a 20px
            action at the end. No description under the name and no
            "connected" label - the dot is the whole status.
          -->
          <div class="card server-card">
            <div class="line">
              <span
                class="status"
                role="status"
                :class="{ ok: app.connected }"
                :aria-label="app.connected ? t('set.connected') : t('set.disconnected')"
                v-tip="{ label: app.connected ? t('set.connected') : t('set.disconnected'), placement: 'top' }"
              >
                <span class="led" />
              </span>
              <div class="line-title">{{ t("set.localServer") }}</div>
            </div>
          </div>
        </template>

        <!-- Providers -->
        <!--
          Models, laid out as MiMo's page: quick add, what has been added, and the
          file it is kept in. A provider is where MCode's models come from, so
          connecting one happens here; each added provider carries the switches
          for which of its models the chat menu offers.
        -->
        <template v-else>
          <h2>{{ t("set.models") }}</h2>
          <p class="note">{{ t("set.models.intro") }}</p>
          <div v-if="notice && !notice.id" class="notice">{{ notice.text }}</div>

          <h3>{{ t("set.models.quickAdd") }}</h3>
          <div class="presets">
            <button
              v-for="group in availableGroups"
              :key="group.id"
              class="preset"
              :data-preset="group.id"
              @click="openConnect(group)"
            >
              <ProviderIcon :id="group.entries[0].id" :name="group.name" class="preset-mark" />
              <span>{{ group.name }}</span>
            </button>
            <button class="preset" :class="{ on: customOpen }" data-preset="custom" @click="customOpen = !customOpen">
              <svg class="preset-plus" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 3v10M3 8h10" />
              </svg>
              <span>{{ t("set.models.custom") }}</span>
            </button>
          </div>
          <div v-if="customOpen" class="card cpanel">
            <CustomProviderForm @connected="customOpen = false" />
          </div>

          <h3>{{ t("set.models.added") }}</h3>
          <div v-if="!listedProviders.length" class="card empty-card">
            <div class="empty-title">{{ t("set.models.emptyTitle") }}</div>
            <div class="empty-desc">{{ t("set.models.emptyDesc") }}</div>
          </div>
          <div v-else class="card">
            <template v-for="provider in listedProviders" :key="provider.id">
            <div class="prow">
              <ProviderIcon :id="provider.id" :name="provider.name" />
              <div class="ptext">
                <div class="pname">
                  {{ provider.name }}
                  <span v-if="provider.custom" class="tag">{{ t("settings.providers.tag.custom") }}</span>
                  <span v-else-if="fromEnvironment(provider)" class="tag">
                    {{ t("provider.environment") }}
                  </span>
                </div>
                <div class="pdesc">
                  {{ provider.models.length ? t("provider.modelCount", { n: provider.models.length }) : t("provider.noModels") }}
                </div>
              </div>
              <!--
                Never on a custom provider. Its models are the ones that were
                typed in, so there is nothing to refresh from - and asking
                /models anyway is how a working provider ends up with an
                empty picker. The row is left with Remove, which is the one
                thing that can be done about it.
              -->
              <button
                v-if="provider.kind === 'openai-compatible' && provider.configured && !provider.custom"
                class="pbtn"
                :disabled="busy === provider.id"
                @click="refresh(provider.id)"
              >
                {{ t("provider.refresh") }}
              </button>
              <!--
                Where the Disconnect link would be, on a row the app cannot
                disconnect: the variable is the user's to unset, and saying so
                is the only useful thing this corner of the row can do.
              -->
              <span v-if="!provider.custom && fromEnvironment(provider)" class="penv">
                {{ t("provider.fromEnvironment") }}
              </span>
              <template v-else>
                <!-- MiMo's 编辑 / 复制 on a saved custom model, before its 删除. -->
                <template v-if="provider.custom">
                  <button class="plink" :data-provider-edit="provider.id" @click="editCustom(provider.id)">
                    {{ t("set.models.edit") }}
                  </button>
                  <button class="plink" :data-provider-copy="provider.id" @click="copyCustom(provider)">
                    {{ t("set.models.copy") }}
                  </button>
                </template>
                <button class="plink" @click="provider.custom ? removeCustom(provider.id) : disconnect(provider.id)">
                  {{ provider.custom ? t("provider.remove") : t("set.disconnect") }}
                </button>
              </template>
            </div>
            <div
              v-if="provider.custom && editingCustom === provider.id && customEntry(provider.id)"
              class="card cpanel"
              data-provider-edit-form
            >
              <CustomProviderForm :editing="customEntry(provider.id)" :autofocus="false" @connected="editingCustom = undefined" />
            </div>

            <div v-if="provider.kind === 'openai-compatible' && !provider.custom" class="pform">
              <input
                :value="endpointValue(provider)"
                class="key-in"
                :placeholder="t('set.baseURL')"
                spellcheck="false"
                @input="endpoints[provider.id] = ($event.target as HTMLInputElement).value"
                @keydown.enter="saveEndpoint(provider.id)"
              />
              <button
                class="ctl-btn"
                :disabled="!endpointChanged(provider)"
                @click="saveEndpoint(provider.id)"
              >
                {{ t("set.save") }}
              </button>
            </div>
            <div v-if="noticeFor(provider.id)" class="pnotice standalone">{{ noticeFor(provider.id) }}</div>
              <template v-if="provider.configured">
                <div v-for="model in provider.models" :key="model.id" class="line model-line">
                  <div class="line-title">{{ model.name }}</div>
                  <button
                    class="switch"
                    :class="{ on: modelEnabled(provider.id, model.id) }"
                    role="switch"
                    :aria-checked="modelEnabled(provider.id, model.id)"
                    :aria-label="model.name"
                    @click="toggleModel(provider.id, model.id)"
                  >
                    <span class="knob" />
                  </button>
                </div>
              </template>
            </template>
          </div>

          <!-- Smart's two models, which the composer's Smart row picks between. -->
          <h3>{{ t("model.smart") }}</h3>
          <p class="note">{{ t("set.smartNote") }}</p>
          <div class="card">
            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.smartFast") }}</div>
              </div>
              <SelectMenu
                :model-value="smartValue('smartFast')"
                :options="smartOptions"
                :width="240"
                @update:model-value="setSmartModel('smartFast', $event)"
              />
            </div>
            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.smartMain") }}</div>
              </div>
              <SelectMenu
                :model-value="smartValue('smartMain')"
                :options="smartOptions"
                :width="240"
                @update:model-value="setSmartModel('smartMain', $event)"
              />
            </div>
          </div>

          <h3>{{ t("set.models.configFile") }}</h3>
          <div class="card">
            <div class="line config-file">
              <div class="line-text">
                <div class="line-title">{{ t("set.models.configFileTitle") }}</div>
                <div class="line-sub path">{{ configFile?.path ?? "" }}</div>
              </div>
              <button v-if="configFile?.exists" class="ctl-btn" @click="openPath(configFile)">{{ t("files.open") }}</button>
              <button v-if="configFile" class="ctl-btn" @click="revealPath(configFile)">{{ t("set.reveal") }}</button>
            </div>
          </div>
        </template>
            </div>
    </div>
  </div>
  <ConnectDialog v-if="connectOpen" :group="connectTarget" @close="closeConnect" />

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

.size-input {
  width: 64px;
  color: var(--text-strong);
  background: var(--surface-raised);
  box-shadow: none;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.unit {
  color: var(--text-weak);
  font-size: calc(13px * var(--ui-font-scale, 1));
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

/* Splits the two kinds of undo on this page without turning them into tabs. */
/* The same heading the rest of the settings use; it was a smaller uppercase
   label here, and referred to a token that does not exist. */
.sub-head {
  margin: 28px 0 12px;
  color: var(--text-strong);
  font-size: calc(15px * var(--ui-font-scale, 1));
  font-weight: 640;
  line-height: 1;
}

.sub-head:first-of-type {
  margin-top: 6px;
}

.sub-note {
  margin: -8px 0 14px;
  color: var(--text-weak);
  font-size: calc(12.5px * var(--ui-font-scale, 1));
  line-height: 1.6;
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

.dialog {
  display: flex;
  width: min(980px, 88vw);
  height: min(600px, 84vh);
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}

/*
 * Measured off opencode's own settings tabs-list rather than chosen: 200px
 * wide with 12px of padding, where MCode had 260 and 22/14/16. The extra 60px
 * was empty in every language - the longest label here is two characters wider
 * than the icon column - and it came out of the page being configured.
 */
/*
 * The column is lighter than the page, and the cards are the page lifted.
 *
 * Measured off the reference itself (1.18.27, driven over its own devtools
 * rather than read off its stylesheet): the page is rgb(22,22,22), the tab
 * column rgb(36,36,36), and the cards are rgb(22,22,22) again - the same colour
 * as the page - carrying `--v2-elevation-raised`. So what lifts a card is its
 * shadow, not a fill.
 *
 * Both of those I had guessed backwards a moment ago: the column had gone down
 * to 8 and the cards up to 36. The stylesheet was no help either - its settings
 * variant still says `gap: 0` while the running app measures 4px - which is why
 * this was measured in the end instead of read.
 */
.nav {
  display: flex;
  flex-direction: column;
  /* 240 and 740 are what the reference splits its 980 into, and this dialog is
     already 980 wide. */
  /* 6 between rows, which is what the reference measures between its tab
     wrappers and between a section title and its first tab. */
  gap: 6px;
  width: 240px;
  min-width: 240px;
  padding: 12px;
  background: var(--surface-raised-hover);
  /* The seam between the column and the page it is choosing, so it belongs on
     whichever of the column's edges the page is on. */
  border-inline-end: 1px solid var(--border-weak);
}

/*
 * The group heading, matched to opencode's tabs-section-title: --text-weak
 * rather than the step below it, 13px, medium weight, and indented less than
 * the rows under it (its 4px against the trigger's 12px).
 */
/*
 * A section title in the navigation, measured on opencode's: 24 tall,
 * `padding: 0 0 0 4px`, `12px/500/24px` in text-base. The rhythm around it
 * is 6 from the title to its first tab, 6 between tabs, and 12 from a
 * section's last tab to the next title. This was 13px in text-weak with
 * ten of top padding and ten of right, which put the label a size larger and
 * a shade fainter than the reference's, and its groups on a different beat.
 */
.nav-group {
  height: 24px;
  padding: 0 0 0 4px;
  color: var(--text-base);
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: 24px;
}

/* 12 from the last tab of one section to the next title: the 6 the list
   already puts between rows, and 6 more. */
.nav-item + .nav-group {
  margin-top: 6px;
}

.nav-group:first-child {
  padding-top: 0;
}

/*
 * opencode 1.18.29's tab: the wrapper is `215x28` on a 4px radius, the trigger
 * inside it `padding: 0 6px` at `13px/440`, and the selected one fills with
 * `rgb(58, 58, 58)` - which is `--surface-key` here, the same fill the
 * selected project row uses. The numbers this carried before (32 tall, radius
 * 8, `0 10px`, 13.5px) were measured on 1.18.27; the reference moved.
 */
.nav-item {
  display: flex;
  /* The navigation is a flex column; without this the row measured 27 for a
     declared 28 - the same squeeze the terminal's new-tab button had. */
  flex-shrink: 0;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 28px;
  padding: 0 6px;
  color: var(--text-base);
  text-align: start;
  border-radius: 4px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  transition: background 0.12s, color 0.12s;
}

/* One size and stroke weight for every nav glyph, so the column reads evenly. */
.nav-ico {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  color: var(--icon-base);
  transition: color 0.12s;
}

.nav-item:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.nav-item:hover .nav-ico,
.nav-item.on .nav-ico {
  color: var(--text-strong);
}

/*
 * An overlay rather than a colour.
 *
 * Pinned to a token this went wrong twice in one sitting - first
 * --surface-raised-hover, which became the column's own fill, then a mix
 * against a ground the column no longer had. `--surface-selected` is
 * overlay/simple-overlay-pressed, a wash of white over whatever is behind it,
 * so it cannot match the plane it sits on however that plane changes.
 */
.nav-item.on {
  color: var(--text-strong);
  background: var(--surface-key);
}

/* settings-v2-nav-footer: 11px on line-height 1, inset 4px from the column. */
.nav-foot {
  margin-top: auto;
  padding: 4px 0 4px 4px;
  color: var(--text-weak);
  font-size: calc(11px * var(--ui-font-scale, 1));
  line-height: 1;
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

.note {
  margin: -8px 0 14px;
  color: var(--text-weak);
  font-size: calc(12.5px * var(--ui-font-scale, 1));
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
.line {
  display: flex;
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

.line.stack {
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
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
  min-width: 0;
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
  line-height: 20px;
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

.ctl-pair {
  display: flex;
  flex-shrink: 0;
  gap: 8px;
}

.ctl-btn {
  flex-shrink: 0;
  max-width: 320px;
  height: 30px;
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

.ctl-btn:disabled {
  color: var(--text-weaker);
  cursor: default;
}

/* MiMo's 重启更新 is its filled button, and the hint under the version a line of its own. */
.ctl-btn.update-install {
  color: var(--surface-base);
  background: var(--text-strong);
}

.update-hint {
  display: block;
}

.ctl-btn.update-install:disabled {
  color: var(--surface-base);
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
  color: var(--text-weak);
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

.mcp-ctrl {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 10px;
}

.mcp-tools-panel {
  padding: 4px 0 14px;
  border-bottom: 1px solid color-mix(in srgb, var(--text-strong) 10%, var(--surface-menu));
}

.mcp-tools-hint {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.mcp-tools-hint.err {
  color: var(--text-critical);
}

.mcp-tools-head {
  margin-bottom: 8px;
  color: var(--text-weak);
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

.mcp-tool-name {
  color: var(--text-base);
  font-family: var(--font-mono);
  font-size: calc(12px * var(--code-font-scale, 1));
}

.mcp-tool-desc {
  display: -webkit-box;
  overflow: hidden;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 1.45;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.page-sub.mcp-sub {
  margin-top: 0;
}

/* An import row's command or address wraps where it must, and the actions sit under the lists. */
.mcp-summary {
  overflow-wrap: anywhere;
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

.page-sub.mcp-example-label {
  margin: 14px 0 8px;
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
  color: var(--text-weak);
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
  margin-bottom: 14px;
}

.mcp-add-row.last {
  margin-bottom: 18px;
}

.mcp-hint {
  margin: 0 0 18px;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 1.6;
}

.mcp-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.link-btn {
  color: var(--text-base);
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.link-btn:hover {
  color: var(--text-strong);
}

.key-row {
  display: flex;
  gap: 8px;
}

.key-in {
  flex: 1;
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

.key-in:focus {
  border-color: var(--border-strong);
}

.reset-gate {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  border-top: 1px solid var(--border-weak);
}

.reset-count {
  margin: 0;
  color: var(--error);
  font-size: calc(12.5px * var(--ui-font-scale, 1));
  font-weight: 530;
}

.danger-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.reset-note {
  margin-top: 0;
}

.confirm {
  display: flex;
  flex-shrink: 0;
  gap: 8px;
}

.danger-btn {
  flex-shrink: 0;
  height: 30px;
  padding: 0 14px;
  color: #fff;
  background: var(--error);
  border-radius: var(--radius-md);
  font-size: calc(12.5px * var(--ui-font-scale, 1));
}

.danger-btn:hover {
  filter: brightness(1.08);
}

.plink.danger {
  color: var(--text-critical);
}

/* Nine of these are now words rather than identifiers, so the monospace face
   that made `todowrite` legible is only right for the two that stayed raw. */
.tool {
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.tool.raw {
  font-family: var(--font-mono);
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
  line-height: 26px;
  font-variant-numeric: tabular-nums;
}

.total-value.small {
  flex-shrink: 0;
  font-size: calc(14px * var(--ui-font-scale, 1));
  line-height: 20px;
}

.total-name {
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 16px;
}

.day {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 0;
}

.day-name {
  flex-shrink: 0;
  width: 44px;
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
  width: 56px;
  color: var(--text-base);
  font-size: calc(12px * var(--ui-font-scale, 1));
  text-align: end;
  font-variant-numeric: tabular-nums;
}

/*
 * MiMo's custom instructions: a heading, a line with an inline 了解更多 that
 * opens three lines of help, a 200px box on the page itself, and Save below.
 */
.page-sub.ci-sub {
  margin-top: 0;
}

.ci-link {
  display: inline;
  padding: 0;
  color: var(--text-interactive);
  background: none;
  border: 0;
  font: inherit;
  cursor: pointer;
}

.ci-link:hover {
  text-decoration: underline;
}

.ci-help {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: -6px 0 14px;
  padding: 10px 12px;
  color: var(--text-weak);
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

.ci-input:focus {
  border-color: var(--border-strong);
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

.page-sub {
  margin: -4px 0 14px;
  color: var(--text-base);
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: 20px;
}

/* The gallery is a block of its own, so its row stacks instead of squeezing. */
.line.icons {
  flex-direction: column;
  align-items: stretch;
  gap: 12px;
}

.gallery {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 10px;
}

.tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 8px 4px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 10px;
  cursor: pointer;
}

.tile:hover {
  background: var(--surface-hover);
}

/* The chosen one is said twice - a ring and a stronger name - because a ring
   alone is easy to miss at this size and colour is not everyone's channel. */
.tile.on {
  border-color: var(--icon-base);
}

.tile-art {
  display: block;
  overflow: hidden;
  border-radius: 10px;
  line-height: 0;
}

.tile-name {
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 16px;
}

.tile.on .tile-name {
  color: var(--text-strong);
  font-weight: 500;
}

.choice {
  display: inline-flex;
  flex-shrink: 0;
  overflow: hidden;
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: var(--radius-md);
}

.choice-btn {
  min-width: 54px;
  height: 26px;
  padding: 0 10px;
  color: var(--text-weak);
  background: transparent;
  border: 0;
  font-size: calc(12px * var(--ui-font-scale, 1));
  cursor: pointer;
}

.choice-btn + .choice-btn {
  border-inline-start: 1px solid var(--border-weak);
}

.choice-btn:hover {
  color: var(--text-base);
  background: var(--surface-hover);
}

/*
 * Mixed against the ground this control actually has.
 *
 * `.choice` fills itself with --surface-base, and this was
 * --surface-raised-hover, which is the same #fafafa in the light scheme: the
 * selected segment of every permission control measured 250 on a 250 ground,
 * step 0, so which one was chosen was invisible. Found by sweeping the live
 * interface for fills that match what is behind them - the fourth of these
 * today, all the same shape.
 */
.choice-btn.on {
  color: var(--text-strong);
  background: color-mix(in srgb, var(--text-strong) 10%, var(--surface-base));
}

/* The one answer that stops something happening says so in the warning hue. */
.choice-btn.on.deny {
  color: var(--text-critical);
  background: color-mix(in srgb, var(--error) 14%, transparent);
}

.tag.warn {
  color: var(--text-warning);
  background: color-mix(in srgb, var(--warning) 14%, transparent);
}

/*
 * opencode's `settings-v2-keybind-button`, measured: `46x23` for "Ctrl+,",
 * `padding: 6px 8px`, radius 2, transparent, no border, the chord at
 * `11px/530/11px` with `0.05px` of tracking in text-weak, set in the UI
 * face rather than the mono one. This was a 0.5px-bordered pill at
 * `2px 6px`, radius 4, in 13px text-base.
 */
.keys.editable {
  cursor: pointer;
  border: 0;
  border-radius: 2px;
  padding: 6px 8px;
}

.keys.editable:hover {
  background: var(--surface-hover);
}

/* While recording, the row says so rather than showing a stale chord. */
.keys.capturing {
  color: var(--text-accent);
  border-color: var(--text-accent);
}

/* Full width, above the groups it narrows, with the same gap the cards use. */
/*
 * The keybinds page, measured on opencode's. Its search field is full width
 * on the page's own surface with the value in text-strong; its rows are
 * `padding: 0 0 16px` inside a list padded 20 all round, stacked with no gap,
 * and their titles are `13px/440` - regular, where the general page's are
 * 530. The general `.line` and `.line-title` are right where they are used;
 * this page has its own rhythm.
 */
.key-search {
  width: 100%;
  margin-bottom: 4px;
  color: var(--text-strong);
  background: var(--surface-raised);
  letter-spacing: -0.04px;
}

.key-search::placeholder {
  color: var(--text-weak);
}

/*
 * The servers list: padded 20 all round, its single row 20 tall with no
 * padding of its own, the dot 6x6 and 10 ahead of the name. Measured on
 * opencode's 服务器 tab.
 */
.server-card {
  padding: 20px;
}

.server-card .line {
  gap: 10px;
  min-height: 20px;
  padding: 0;
  border-bottom: 0;
}

.server-card .line-title {
  font-weight: 440;
}

.server-card .status {
  gap: 0;
}

.server-card .led {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.keys-card {
  padding: 20px;
}

/*
 * 29 tall: the reference's row is the height of its title line plus the 16
 * below, and the 23px chord sits centred on it and overflows by five each
 * way - which is what puts consecutive chords 22 apart. Letting the chord
 * size the row made it 40 and the chords 17 apart.
 */
.keys-card .line {
  box-sizing: border-box;
  height: 29px;
  padding: 0 0 16px;
  overflow: visible;
}

.keys-card .line-title {
  font-weight: 440;
}

.reset-all {
  margin: -6px 0 14px;
}

.keys {
  flex-shrink: 0;
  color: var(--text-weak);
  font-family: var(--font-sans);
  font-size: calc(11px * var(--ui-font-scale, 1));
  font-weight: 530;
  line-height: 11px;
  letter-spacing: 0.05px;
}

.status {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--text-weak);
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.led {
  width: 7px;
  height: 7px;
  background: var(--error);
  border-radius: 50%;
}

.status.ok .led {
  background: var(--success);
}

.actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.row-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}

/*
 * opencode's `tag`, measured: `31x16` for 推荐 and `42x16` for 自定义 -
 * `padding: 0 4px`, radius 2, on bg-layer-02 (`--surface-layer`) with a
 * half-pixel ring, `11px/530/11px` at `0.05px` in text-base, 8 after the name
 * it follows. This was a 999px pill at `1px 7px` in text-weak on the hover
 * fill, with the accent variant drawn in blue text on a blue tint.
 */
.tag {
  display: inline-flex;
  align-items: center;
  height: 16px;
  margin-inline-start: 8px;
  padding: 0 4px;
  color: var(--text-base);
  background: var(--surface-layer);
  border-radius: 2px;
  box-shadow: inset 0 0 0 0.5px var(--border-weak);
  font-size: calc(11px * var(--ui-font-scale, 1));
  font-weight: 530;
  line-height: 11px;
  letter-spacing: 0.05px;
  vertical-align: middle;
}

/*
 * The accented tag is the one opencode's general page wears for 新: solid
 * `--primary` under white text, no ring - `19x16`, `0 4px`, radius 2.
 */
.tag.accent {
  color: #ffffff;
  background: var(--primary);
  box-shadow: none;
}

.notice {
  margin-bottom: 12px;
  padding: 8px 12px;
  color: var(--text-base);
  background: var(--surface-raised-hover);
  border-radius: var(--radius-md);
  font-size: calc(12.5px * var(--ui-font-scale, 1));
}

.empty-note {
  padding: 18px 2px;
  color: var(--text-weak);
  font-size: calc(13px * var(--ui-font-scale, 1));
}
/* Provider rows read as a scannable list: identity on the left, one action on
   the right. The key field is disclosed per row rather than always present -
   eleven permanent input boxes was a wall, not a list. */
.prow {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 17px 0;
  border-bottom: 0.5px solid var(--border-weaker);
}

.prow:last-child {
  border-bottom: none;
}

.prow:last-child {
  border-bottom: none;
}

.pmark.on {
  color: var(--surface-base);
  background: var(--text-strong);
}

.ptext {
  flex: 1;
  min-width: 0;
}

.pname {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-strong);
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 530;
  line-height: 1;
  letter-spacing: -0.04px;
}

.pdesc {
  margin-top: 1px;
  overflow: hidden;
  color: var(--text-base);
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 440;
  line-height: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/*
 * opencode's `button-v2` ghost variant, measured on its providers page:
 * `74x28` for 断开连接, `padding: 0 11px`, gap 6, radius 6, transparent,
 * `13px/530/20px` at `-0.04px` in text-base. This was `0 12px` on a 6% fill
 * in text-strong at 440 - a filled pill where the reference draws a ghost.
 */
.pbtn {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 28px;
  padding: 0 11px;
  color: var(--text-base);
  background: transparent;
  border-radius: 6px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 530;
  line-height: 20px;
  letter-spacing: -0.04px;
  transition: background 0.12s, color 0.12s;
}

.pbtn:hover:not(:disabled) {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.pbtn:disabled {
  color: var(--text-weaker);
  cursor: default;
}

.plink {
  flex-shrink: 0;
  color: var(--text-base);
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.plink:hover {
  color: var(--text-strong);
}

/* Standing where the link stands, and quieter than it: this is a statement
   about the row, not something to press. */
.penv {
  flex-shrink: 0;
  max-width: 260px;
  color: var(--text-weak);
  font-size: calc(13px * var(--ui-font-scale, 1));
  text-align: end;
}

.pform {
  display: flex;
  gap: 8px;
  padding: 0 16px 14px;
  border-bottom: 1px solid var(--border-weaker);
}

.pnotice {
  max-width: 520px;
  color: var(--text-critical);
  font-size: calc(12.5px * var(--ui-font-scale, 1));
  line-height: 1.6;
}

/* Outside the connect panel it has to bring its own inset and rule. */
.pnotice.standalone {
  padding: 0 16px 12px;
  border-bottom: 1px solid var(--border-weaker);
}

.pform.stack {
  flex-direction: column;
  padding-top: 4px;
}

/* Sits inside .pform.stack, so it must not re-apply the horizontal padding -
   otherwise the key row is inset from the fields above it. */
.pform-row {
  display: flex;
  gap: 8px;
}

/* The custom-provider form sits inside the provider card, so it brings the
   card's own inset and closing rule with it rather than knowing about them. */
.cpanel {
  padding: 4px 16px 16px;
  border-bottom: 1px solid var(--border-weaker);
}

/* MiMo's quick-add chips: 34 tall on a hairline, a small mark and the vendor's name. */
.presets {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 4px;
}

.preset {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 34px;
  padding: 0 10px;
  color: var(--text-strong);
  background: transparent;
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.preset:hover,
.preset.on {
  background: var(--surface-hover);
}

.preset-mark {
  width: 18px;
  height: 18px;
  border-radius: 5px;
  font-size: calc(10px * var(--ui-font-scale, 1));
}

.preset-mark :deep(.glyph) {
  width: 14px;
  height: 14px;
}

.preset-plus {
  width: 16px;
  height: 16px;
  color: var(--text-weak);
}

.preset-plus path {
  stroke: currentColor;
  stroke-width: 1.4;
  stroke-linecap: round;
}

.empty-card {
  padding: 18px 16px;
}

.empty-title {
  color: var(--text-strong);
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
}

.empty-desc {
  margin-top: 4px;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 1.6;
}

.model-line .line-title {
  font-weight: 400;
}

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
.overlay {
  background: rgb(0 0 0 / 0.24);
}

.dialog {
  position: relative;
  width: min(960px, 92vw);
  height: min(660px, 86vh);
  background: var(--surface-raised);
  border: 1px solid color-mix(in srgb, var(--text-strong) 16%, var(--surface-raised));
  border-radius: 20px;
}

.close {
  position: absolute;
  top: 18px;
  inset-inline-end: 18px;
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

.nav {
  gap: 2px;
  width: 241px;
  min-width: 241px;
  padding: 19px 11px 12px;
  background: var(--surface-raised);
  border-inline-end: 1px solid color-mix(in srgb, var(--text-strong) 10%, var(--surface-raised));
}

.nav-title {
  flex-shrink: 0;
  height: 36px;
  padding: 0 11px;
  color: var(--text-strong);
  font-size: calc(15px * var(--ui-font-scale, 1));
  font-weight: 600;
  line-height: 36px;
}

.nav-group {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  height: 35px;
  padding: 0 11px;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-weight: 400;
  line-height: 19.2px;
}

.nav-title + .nav-group,
.nav-item + .nav-group {
  margin-top: 6px;
}

.nav-item {
  gap: 10px;
  height: 36px;
  padding: 0 11px;
  color: var(--text-strong);
  border-radius: 8px;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: 20px;
}

.nav-ico {
  width: 18px;
  height: 18px;
  color: var(--text-base);
}

.nav-item:hover {
  background: color-mix(in srgb, var(--text-strong) 5%, var(--surface-raised));
}

.nav-item.on {
  background: color-mix(in srgb, var(--text-strong) 8%, var(--surface-raised));
}

.nav-foot {
  padding: 4px 11px;
}

.content {
  padding: 44px 40px;
  background: var(--surface-menu);
}

h2 {
  margin: 0 0 27px;
  font-size: calc(24px * var(--ui-font-scale, 1));
  font-weight: 400;
  line-height: 38.4px;
}

h3 {
  margin: 27px 0 4px;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: 22.4px;
}

.card {
  padding: 0 17px;
  background: color-mix(in srgb, var(--text-strong) 4%, var(--surface-menu));
  border: 1px solid color-mix(in srgb, var(--text-strong) 13.4%, var(--surface-menu));
  border-radius: 16px;
  box-shadow: none;
}

.card + .card {
  margin-top: 16px;
}

.line {
  padding: 16px 0;
  border-bottom: 1px solid color-mix(in srgb, var(--text-strong) 10%, var(--surface-menu));
}

.line-text {
  gap: 3px;
}

.line-title {
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: 22.4px;
  letter-spacing: 0;
}

.line-sub {
  margin-block: 0;
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: 18.6px;
}

/* A round 32 by 20 switch: light track with a dark knob when on. */
.switch {
  width: 32px;
  height: 20px;
  background: color-mix(in srgb, var(--text-strong) 22%, var(--surface-menu));
  border-radius: 999px;
}

/* Hover changes the fill only; the shape is the switch's, not the pointer's. */
.switch:hover {
  background: color-mix(in srgb, var(--text-strong) 28%, var(--surface-menu));
}

.switch.on,
.switch.on:hover {
  background: var(--icon-base);
}

.knob,
.switch.on .knob {
  top: 2px;
  width: 16px;
  height: 16px;
  /* Always the opposite of the track it sits on, in either scheme. */
  background: var(--icon-base);
  border-radius: 50%;
}

.switch.on .knob {
  background: var(--surface-raised);
  inset-inline-start: 14px;
}

.ctl-btn {
  height: 28px;
  padding: 0 10px;
  color: var(--text-strong);
  background: color-mix(in srgb, var(--text-strong) 10%, var(--surface-menu));
  border: 0;
  border-radius: 8px;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
}

/* The pickers in a row: a filled 28px chip, the way MiMo's language picker is. */
.content :deep(.trigger) {
  height: 28px;
  padding: 0 8px 0 10px;
  background: color-mix(in srgb, var(--text-strong) 10%, var(--surface-menu));
  border-radius: 8px;
  font-size: calc(14px * var(--ui-font-scale, 1));
}

.content :deep(.trigger .label) {
  font-weight: 500;
  line-height: 20px;
}

/* The column's search field: MiMo's 36 tall with an 8px corner and a quiet rule. */
.nav-search {
  flex-shrink: 0;
  height: 36px;
  margin-top: 6px;
  padding: 0 14px;
  color: var(--text-strong);
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--text-strong) 16%, var(--surface-raised));
  border-radius: 8px;
  outline: none;
  font-size: calc(14px * var(--ui-font-scale, 1));
  line-height: 22.4px;
}

.nav-search::placeholder {
  color: var(--text-weak);
}

.nav-search:focus {
  border-color: color-mix(in srgb, var(--text-strong) 32%, var(--surface-raised));
}

.nav-search + .nav-group {
  margin-top: 7px;
}

.nav-empty {
  padding: 8px 11px;
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
  margin: 27px 0 4px;
}

.sec-row h3 {
  margin: 0;
}

.env-project-name {
  display: flex;
  align-items: center;
  gap: 6px;
}

.env-project-name svg {
  flex-shrink: 0;
  color: var(--text-weak);
}

.env-icon {
  display: grid;
  place-items: center;
  width: 30px;
  padding: 0;
}

.env-icon + .env-icon {
  margin-inline-start: 6px;
}

.env-refresh {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  color: var(--text-base);
  background: transparent;
  border: 0;
  border-radius: 7px;
}

.env-refresh:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.wt-count {
  margin: 4px 0 8px;
}

.wt-row {
  gap: 8px;
}

.wt-row .tag {
  flex-shrink: 0;
  margin-inline-start: 0;
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

.env-back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 8px 0 4px;
  color: var(--text-base);
  background: transparent;
  border: 0;
  border-radius: 8px;
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.env-back:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.env-input {
  width: 100%;
  height: 36px;
  margin-top: 8px;
  padding: 0 12px;
  color: var(--text-strong);
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: 10px;
  outline: none;
  font-size: calc(14px * var(--ui-font-scale, 1));
}

.env-input:focus {
  border-color: var(--border-strong, var(--border-weak));
}

.env-save-row {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}

.env-save:disabled {
  opacity: 0.5;
}
/*
 * Archived conversations in batch: MiMo's toolbar - a framed 10px-corner strip
 * with select all at the start, the count after it and the two actions at the
 * far end - and a checkbox at the start of each row while selecting.
 */
.batch-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 10px;
  padding: 8px 12px;
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
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

.archived-head h3 {
  margin: 0;
}

.archived-row.picking {
  gap: 10px;
  cursor: pointer;
}

.check {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 16px;
  height: 16px;
  color: var(--surface-raised);
  border: 1px solid var(--text-weak);
  border-radius: 4px;
}

.check.on {
  background: var(--text-strong);
  border-color: var(--text-strong);
}
</style>
