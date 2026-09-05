<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue"
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
import { projectName } from "../lib/project"
import SelectMenu from "./SelectMenu.vue"
import { chordOf, isBindable } from "../lib/keys"
import { notifyFailure } from "../lib/toast"
import { DEFAULT_THEME, THEMES } from "../lib/theme-palettes"

const emit = defineEmits<{ close: []; "check-updates": [] }>()
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

type Section = "general" | "keys" | "server" | "providers" | "models" | "archive"

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

const props = defineProps<{ section?: Section; commands: Bindable[] }>()
const section = ref<Section>(props.section ?? "general")

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

/** Deleting from here is final, so it asks the same way the reset does. */
const confirmingDelete = ref<string>()

async function removeArchived(sessionID: string) {
  await app.remove(sessionID)
  confirmingDelete.value = undefined
}

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
  void app.patchConfig({ permissions: next })
}

async function pickDirectory() {
  const [directory] = await window.mcode.pickDirectory(t("cmd.openProject"))
  if (directory) await app.patchConfig({ directory })
}



const modelQuery = ref("")
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
const available = computed(() =>
  [...app.providers]
    .filter((provider) => !provider.configured)
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)),
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

/** Every model across connected providers, filtered by the search box. */
const modelGroups = computed(() => {
  const needle = modelQuery.value.trim().toLowerCase()
  return connected.value
    .map((provider) => ({
      provider,
      models: provider.models.filter(
        (model) => !needle || model.name.toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle),
      ),
    }))
    .filter((group) => group.models.length > 0)
})

function key(provider: string, model: string) {
  return `${provider}/${model}`
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
      <nav class="nav">
        <div class="nav-group">{{ t("set.groupDesktop") }}</div>

        <!--
          Every glyph below is the reference's own, lifted from its icon sprite
          rather than drawn to look like it: same 20x20 grid, same 1px stroke,
          same square caps. MCode's were hand-drawn at 16x16 with a 1.4 stroke
          and round caps, which is why the column read heavier and rounder than
          opencode's beside it.
        -->
        <button class="nav-item" :class="{ on: section === 'general' }" @click="section = 'general'">
          <svg class="nav-ico" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path
              d="M3.625 6.25H10.9375M16.375 13.75H10.5625M3.625 13.75H4.9375M11.125 6.25C11.125 4.79969 12.2997 3.625 13.75 3.625C15.2003 3.625 16.375 4.79969 16.375 6.25C16.375 7.70031 15.2003 8.875 13.75 8.875C12.2997 8.875 11.125 7.70031 11.125 6.25ZM10.375 13.75C10.375 15.2003 9.20031 16.375 7.75 16.375C6.29969 16.375 5.125 15.2003 5.125 13.75C5.125 12.2997 6.29969 11.125 7.75 11.125C9.20031 11.125 10.375 12.2997 10.375 13.75Z"
              stroke="currentColor"
              stroke-linecap="square"
            />
          </svg>
          {{ t("set.general") }}
        </button>

        <button class="nav-item" :class="{ on: section === 'keys' }" @click="section = 'keys'">
          <svg class="nav-ico" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path
              d="M5.125 7.375V4.375H14.875V2.875M8.3125 13.9375H11.6875M8.125 13.9375H11.875M2.125 7.375H17.875V17.125H2.125V7.375ZM5.5 10.375H5.125V10.75H5.5V10.375ZM8.5 10.375H8.125V10.75H8.5V10.375ZM11.875 10.375H11.5V10.75H11.875V10.375ZM14.875 10.375H14.5V10.75H14.875V10.375ZM14.875 13.75H14.5V14.125H14.875V13.75ZM5.5 13.75H5.125V14.125H5.5V13.75Z"
              stroke="currentColor"
              stroke-linecap="square"
            />
          </svg>
          {{ t("set.keyboard") }}
        </button>

        <!--
          The reference has no archive page in its settings - its five tabs are
          general, shortcuts, servers, providers, models. It does archive
          sessions, from the same command MCode has, but with
          SHOW_HOME_SESSION_ARCHIVE false it then offers nowhere to see them
          again. This row is kept because removing it would strand whatever is
          already archived, and it uses opencode's own archive glyph.
        -->
        <button class="nav-item" :class="{ on: section === 'archive' }" @click="section = 'archive'">
          <svg class="nav-ico" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path
              d="M16.8747 6.24935H17.3747V5.74935H16.8747V6.24935ZM16.8747 16.8743V17.3743H17.3747V16.8743H16.8747ZM3.12467 16.8743H2.62467V17.3743H3.12467V16.8743ZM3.12467 6.24935V5.74935H2.62467V6.24935H3.12467ZM2.08301 2.91602V2.41602H1.58301V2.91602H2.08301ZM17.9163 2.91602H18.4163V2.41602H17.9163V2.91602ZM17.9163 6.24935V6.74935H18.4163V6.24935H17.9163ZM2.08301 6.24935H1.58301V6.74935H2.08301V6.24935ZM8.33301 9.08268H7.83301V10.0827H8.33301V9.58268V9.08268ZM11.6663 10.0827H12.1663V9.08268H11.6663V9.58268V10.0827ZM16.8747 6.24935H16.3747V16.8743H16.8747H17.3747V6.24935H16.8747ZM16.8747 16.8743V16.3743H3.12467V16.8743V17.3743H16.8747V16.8743ZM3.12467 16.8743H3.62467V6.24935H3.12467H2.62467V16.8743H3.12467ZM3.12467 6.24935V6.74935H16.8747V6.24935V5.74935H3.12467V6.24935ZM2.08301 2.91602V3.41602H17.9163V2.91602V2.41602H2.08301V2.91602ZM17.9163 2.91602H17.4163V6.24935H17.9163H18.4163V2.91602H17.9163ZM17.9163 6.24935V5.74935H2.08301V6.24935V6.74935H17.9163V6.24935ZM2.08301 6.24935H2.58301V2.91602H2.08301H1.58301V6.24935H2.08301ZM8.33301 9.58268V10.0827H11.6663V9.58268V9.08268H8.33301V9.58268Z"
              fill="currentColor"
            />
          </svg>
          {{ t("set.archive") }}
        </button>

        <div class="nav-group">{{ t("set.groupServer") }}</div>

        <button class="nav-item" :class="{ on: section === 'server' }" @click="section = 'server'">
          <svg class="nav-ico" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <rect x="3.35547" y="1.92969" width="13.2857" height="16.1429" stroke="currentColor" />
            <rect x="3.35547" y="11.9297" width="13.2857" height="6.14286" stroke="currentColor" />
            <rect x="12.8555" y="14.2852" width="1.42857" height="1.42857" fill="currentColor" />
            <rect x="10" y="14.2852" width="1.42857" height="1.42857" fill="currentColor" />
          </svg>
          {{ t("set.server") }}
        </button>

        <button class="nav-item" :class="{ on: section === 'providers' }" @click="section = 'providers'">
          <svg class="nav-ico" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path
              d="M10.0001 4.37562V2.875M13 4.37793V2.87793M7.00014 4.37793V2.875M10 17.1279V15.6279M13 17.1279V15.6279M7 17.1279V15.6279M15.625 13.0029H17.125M15.625 7.00293H17.125M15.625 10.0029H17.125M2.875 10.0029H4.375M2.875 13.0029H4.375M2.875 7.00293H4.375M4.375 4.37793H15.625V15.6279H4.375V4.37793ZM12.6241 10.0022C12.6241 11.4519 11.4488 12.6272 9.99908 12.6272C8.54934 12.6272 7.37408 11.4519 7.37408 10.0022C7.37408 8.55245 8.54934 7.3772 9.99908 7.3772C11.4488 7.3772 12.6241 8.55245 12.6241 10.0022Z"
              stroke="currentColor"
              stroke-linecap="square"
            />
          </svg>
          {{ t("set.providers") }}
        </button>

        <button class="nav-item" :class="{ on: section === 'models' }" @click="section = 'models'">
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

        <div class="nav-foot">
          MCode Desktop<br />
          v{{ app.version }}
        </div>
      </nav>

      <div class="content">
        <!-- General -->
        <template v-if="section === 'general'">
          <h2>{{ t("set.general") }}</h2>
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

          <h3>{{ t("set.appearance") }}</h3>
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
          </div>

          <!--
            Updates. opencode has this section too, with a Check now button and
            an updater behind it. MCode has no update service, so the address to
            look at has to be given here - without it the check could only ever
            answer "no update feed is configured", which is what it did from all
            three places that offer it.
          -->
          <h3>{{ t("set.updates") }}</h3>
          <div class="card">
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

            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("update.check") }}</div>
                <div class="line-sub">{{ t("set.updateFeedSub") }}</div>
              </div>
              <button class="ctl-btn" :disabled="!app.config?.updateFeed?.trim()" @click="emit('check-updates')">
                {{ t("set.checkNow") }}
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
            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.soundAgent") }}</div>
                <div class="line-sub">{{ t("set.soundAgentSub") }}</div>
              </div>
              <button
                class="switch"
                :class="{ on: app.config?.soundAgent }"
                @click="app.patchConfig({ soundAgent: !app.config?.soundAgent })"
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

            <!--
              The two title-bar controls opencode keeps behind a setting, both
              off to begin with as they are there. Their descriptions name the
              buttons exactly, so the rows say what they reveal.
            -->
            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.showNav") }}</div>
                <div class="line-sub">{{ t("set.showNavSub") }}</div>
              </div>
              <button
                class="switch"
                :class="{ on: app.config?.showNavigation }"
                @click="app.patchConfig({ showNavigation: !app.config?.showNavigation })"
              >
                <span class="knob" />
              </button>
            </div>

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

            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.paletteButton") }}</div>
                <div class="line-sub">{{ t("set.paletteButtonSub") }}</div>
              </div>
              <button
                class="switch"
                :class="{ on: app.config?.showPaletteButton }"
                @click="app.patchConfig({ showPaletteButton: !app.config?.showPaletteButton })"
              >
                <span class="knob" />
              </button>
            </div>

            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.serverButton") }}</div>
                <div class="line-sub">{{ t("set.serverButtonSub") }}</div>
              </div>
              <button
                class="switch"
                :class="{ on: app.config?.showServerButton }"
                @click="app.patchConfig({ showServerButton: !app.config?.showServerButton })"
              >
                <span class="knob" />
              </button>
            </div>

            <div class="line">
              <div class="line-text">
                <div class="line-title">{{ t("set.agentPicker") }}</div>
                <div class="line-sub">{{ t("set.agentPickerSub") }}</div>
              </div>
              <button
                class="switch"
                :class="{ on: app.config?.showAgentPicker }"
                @click="app.patchConfig({ showAgentPicker: !app.config?.showAgentPicker })"
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
          <h2>{{ t("set.archive") }}</h2>
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

          <h3 class="sub-head">{{ t("set.archivedSessions") }}</h3>
          <p class="sub-note">{{ t("set.archivedSub") }}</p>

          <div v-if="!archived.length" class="empty-note">{{ t("set.archiveEmpty") }}</div>

          <div v-else class="card">
            <div v-for="session in archived" :key="session.id" class="line">
              <div class="line-text">
                <div class="line-title">{{ sessionTitle(session.title) }}</div>
                <div class="line-sub">{{ session.directory }} · {{ ago(session.updated) }}</div>
              </div>
              <div v-if="confirmingDelete === session.id" class="confirm">
                <button class="ctl-btn" @click="confirmingDelete = undefined">{{ t("common.cancel") }}</button>
                <button class="danger-btn" @click="removeArchived(session.id)">{{ t("set.deleteForever") }}</button>
              </div>
              <div v-else class="confirm">
                <button class="ctl-btn" @click="app.archive(session.id, false)">{{ t("set.unarchive") }}</button>
                <button class="plink danger" @click="confirmingDelete = session.id">{{ t("set.deleteForever") }}</button>
              </div>
            </div>
          </div>
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
        <template v-else-if="section === 'providers'">
          <h2>{{ t("set.providers") }}</h2>
          <p class="note">{{ t("set.providersNote") }}</p>
          <div v-if="notice && !notice.id" class="notice">{{ notice.text }}</div>

          <template v-if="listedProviders.length">
            <h3>{{ t("set.connectedProviders") }}</h3>
            <div class="card">
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
                <button
                  v-else
                  class="plink"
                  @click="provider.custom ? removeCustom(provider.id) : disconnect(provider.id)"
                >
                  {{ provider.custom ? t("provider.remove") : t("set.disconnect") }}
                </button>
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
              </template>
            </div>
          </template>

          <h3>{{ t("set.available") }}</h3>
          <div class="card">
            <!--
              One row per vendor, not per endpoint. A ChatGPT subscription and
              the metered OpenAI API are separate providers underneath, but to
              someone connecting an account they are one name with a choice
              behind it - the dialog asks which.
            -->
            <div v-for="group in availableGroups" :key="group.id" class="prow">
              <ProviderIcon :id="group.entries[0].id" :name="group.name" />
              <div class="ptext">
                <div class="pname">
                  {{ group.name }}
                  <span v-if="group.recommended" class="tag">{{ t("provider.recommended") }}</span>
                </div>
                <div class="pdesc">{{ groupDescription(group) }}</div>
              </div>
              <button class="pbtn" @click="openConnect(group)">
                <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">
                  <path d="M7 2.6v8.8M2.6 7h8.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
                </svg>
                {{ t("set.connect") }}
              </button>
            </div>

            <div class="prow">
              <span class="pmark">+</span>
              <div class="ptext">
                <div class="pname">
                  {{ t("provider.custom.title") }}
                  <span class="tag">{{ t("settings.providers.tag.custom") }}</span>
                </div>
                <div class="pdesc">{{ t("settings.providers.custom.description") }}</div>
              </div>
              <button class="pbtn" @click="customOpen = !customOpen">
                <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">
                  <path d="M7 2.6v8.8M2.6 7h8.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
                </svg>
                {{ t("set.connect") }}
              </button>
            </div>

            <div v-if="customOpen" class="cpanel">
              <CustomProviderForm @connected="customOpen = false" />
            </div>
          </div>
        </template>

        <!-- Models -->
        <template v-else>
          <h2>{{ t("model.manage") }}</h2>
          <p class="note">{{ t("model.manageSub") }}</p>

          <input v-model="modelQuery" class="search-in" :placeholder="t('model.search')" spellcheck="false" />

          <div v-if="connected.length === 0" class="empty-note">{{ t("model.needProvider") }}</div>
          <div v-else-if="modelGroups.length === 0" class="empty-note">{{ t("model.none") }}</div>

          <template v-for="group in modelGroups" :key="group.provider.id">
            <h3>{{ group.provider.name }}</h3>
            <div class="card">
              <div v-for="model in group.models" :key="model.id" class="line">
                <div class="line-title">{{ model.name }}</div>
                <button
                  class="switch"
                  :class="{ on: modelEnabled(group.provider.id, model.id) }"
                  @click="toggleModel(group.provider.id, model.id)"
                >
                  <span class="knob" />
                </button>
              </div>
            </div>
          </template>
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
  font-size: 15px;
  font-weight: 640;
  line-height: 1;
}

.sub-head:first-of-type {
  margin-top: 6px;
}

.sub-note {
  margin: -8px 0 14px;
  color: var(--text-weak);
  font-size: 12.5px;
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
  font-size: 12px;
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
  font-size: 13px;
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
  font-size: 11px;
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
  font-size: 15px;
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
  font-size: 15px;
  font-weight: 640;
  line-height: 1;
}

.note {
  margin: -8px 0 14px;
  color: var(--text-weak);
  font-size: 12.5px;
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
  font-size: 13px;
  font-weight: 530;
  line-height: 1;
  letter-spacing: -0.04px;
}

.line-sub {
  /* The reference pulls its description in on both sides rather than pushing it
     down, which is what sets the title and the line under it 4.5px apart. */
  margin-block: -3.5px;
  color: var(--text-base);
  font-size: 13px;
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

.ctl-btn {
  flex-shrink: 0;
  max-width: 320px;
  height: 30px;
  padding: 0 10px;
  color: var(--text-strong);
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: var(--radius-md);
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ctl-btn:disabled {
  color: var(--text-weaker);
  cursor: default;
}

.link-btn {
  color: var(--text-base);
  font-size: 13px;
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
  font-size: 12.5px;
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
  font-size: 12.5px;
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
  font-size: 12.5px;
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
  font-size: 13px;
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
  font-size: 12px;
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
  font-size: 11px;
  font-weight: 530;
  line-height: 11px;
  letter-spacing: 0.05px;
}

.status {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--text-weak);
  font-size: 13px;
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
  font-size: 11px;
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
  font-size: 12.5px;
}

.search-in {
  /*
   * No border. opencode's shared `text-input-v2` is a 60% fill of bg-layer-02
   * that goes solid on focus, at radius 6 - `--surface-layer` and
   * `--radius-md` here. Focus used to move a border colour that no longer
   * exists.
   */
  width: 100%;
  height: 34px;
  margin-bottom: 6px;
  padding: 0 12px;
  color: var(--text-strong);
  background: color-mix(in srgb, var(--surface-layer) 60%, transparent);
  border: 0;
  border-radius: var(--radius-md);
  font-size: 13px;
  outline: none;
}

.search-in:focus {
  background: var(--surface-layer);
}

.empty-note {
  padding: 18px 2px;
  color: var(--text-weak);
  font-size: 13px;
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

.pmark {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  color: var(--text-base);
  background: var(--surface-raised-hover);
  border-radius: var(--radius-md);
  font-size: 13px;
  font-weight: 530;
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
  font-size: 13px;
  font-weight: 530;
  line-height: 1;
  letter-spacing: -0.04px;
}

.pdesc {
  margin-top: 1px;
  overflow: hidden;
  color: var(--text-base);
  font-size: 13px;
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
  font-size: 13px;
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
  font-size: 13px;
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
  font-size: 13px;
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
  font-size: 12.5px;
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
</style>
