import { DEFAULT_APP_ICON } from "@shared/app-icons"
import { migrateChime } from "@shared/chime"
import { normalizeChord, retireKeybinds } from "@shared/chord"
import fs from "node:fs/promises"
import { watch as watchFiles, type FSWatcher } from "node:fs"
import path from "node:path"
import os from "node:os"
import type {
  AppConfig,
  CustomProvider,
  Effort,
  ModelInfo,
  ModelRef,
  PermissionAction,
  ProviderStatus,
} from "@shared/protocol"
import {
  DEFAULT_PERMISSIONS,
  EFFORTS,
  PERMISSION_ACTIONS,
  PERMISSION_KINDS,
  type PermissionKind,
} from "@shared/protocol"
import { adoptedProjects, knownFolder, listedProjects, reconciledProjects } from "@shared/projects"
import { RepoRoots } from "./repo-roots"
import { worktreeTop } from "./session/worktree"
import { sanitizeConfig } from "./config-sanitize"
import { defaultAccess, type Access } from "@shared/access"
import type { Storage } from "./storage"
import { writeAtomic } from "./storage"
import type { Bus } from "./bus"
import {
  BUILT_IN,
  MODELS_DEV_IDS,
  definition,
  type ModelEntry,
  type ProviderDefinition,
  type ProviderKind,
} from "./provider/catalog"
import { nameFromId } from "./provider/model-name"
import { CodedError } from "@shared/errors"
import type { Catalog, CatalogModel } from "@shared/models-dev"
import { conversational } from "./provider/discover"
import { modelVariants } from "./provider/variants"
import { menuEfforts } from "@shared/effort-menu"
import { normalizeBaseURL, normalizeModelId } from "@shared/custom-endpoint"
import type { OAuthTokens } from "./auth/oauth"
import { parseJsonc, renderJsonc } from "./jsonc"

export const DEFAULT_MODEL: ModelRef = { provider: "", model: "" }

/** Recorded in `migrations` once the project list has been filled from conversations. */
export const PROJECT_LIST_MIGRATION = "projects-list"
/** Round 10: linked worktrees that had become projects of their own are filed under their repository's. */
export const REPOSITORY_PROJECTS_MIGRATION = "projects-by-repository"
/** Round 10: project memory is filed per repository, and outside a repository in one shared folder. */
export const MEMORY_LAYOUT_MIGRATION = "memory-by-repository"

/**
 * Which build's idea of the stored config this one is.
 *
 * None of this app's JSON documents carried a version, so a build installed
 * over a newer one read whatever it found straight into its config object,
 * kept the fields it did not know, possibly misread the ones it did, and wrote
 * its own understanding back over the lot. Detecting it has to mean refusing to
 * write, not merely refusing to read: a downgrade that still saves is exactly
 * how the newer build's settings are lost.
 *
 * Raise this only when a change would be misread by a build that predates it.
 */
export const CONFIG_SCHEMA_VERSION = 1

export type { ModelEntry }

/**
 * One catalog entry as the window sees it.
 *
 * Absent is false throughout, which is the reference's own default for every
 * capability read, and the effort list is worked out here rather than stored so
 * a catalog edit cannot leave a model advertising levels its family has never
 * accepted.
 */
function modelInfo(model: ModelEntry): ModelInfo {
  const inputs = model.inputs ?? {}
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxOutput: model.maxOutput ?? 0,
    reasoning: model.reasoning ?? false,
    attachment: model.attachment ?? false,
    toolCall: model.toolCall ?? false,
    temperature: model.temperature ?? false,
    inputs: {
      // Every chat model reads text, and a provider that lists no modalities
      // at all has still told us that much.
      text: inputs.text ?? true,
      image: inputs.image ?? false,
      audio: inputs.audio ?? false,
      video: inputs.video ?? false,
      pdf: inputs.pdf ?? false,
    },
    cost: { input: model.input, output: model.output },
    // The levels the menu offers, by MiMo's desktop rule; what each becomes on the wire is `variants()` below.
    variants: menuEfforts(model.id, model.name),
  }
}

function defaults(): AppConfig {
  return {
    model: DEFAULT_MODEL,
    theme: "system",
    mcpServers: {},
    pinnedTabs: [],
    pinnedProjects: [],
    projectOrder: [],
    taskOrder: {},
    keybinds: {},
    updateFeed: "",
    taskDoneSound: "bloom",
    spineSound: true,
    projectRoot: "",
    /*
     * Empty means nobody has chosen yet, which the window answers by reading
     * the machine's own preference. A real value here would be indistinguishable
     * from a deliberate choice and would re-assert itself forever.
     */
    language: "",
    permissions: { ...DEFAULT_PERMISSIONS },
    /*
     * Derived, and rewritten from `permissions` on every load and every change.
     * The value here only matters for the moment between the two.
     */
    autoApprove: allowed(DEFAULT_PERMISSIONS),
    allowFullAccess: false,
    directory: process.cwd(),
    projects: [],
    closedProjects: [],
    projectNames: {},
    projectUsed: {},
    projectIcons: {},
    projectColors: {},
    // MiMo's 中: one app-wide level, medium until someone picks another.
    effort: "medium",
    agent: "build",
    staged: false,
    importOnboarded: false,
    uiFontSize: 14,
    codeFontSize: 12,
    instructions: "",
    tray: true,
    voiceMode: "smart",
    voiceSend: false,
    voiceFeedback: true,
    fontSmoothing: true,
    appIcon: DEFAULT_APP_ICON,
    pointerCursor: true,
    reduceMotion: "system",
    diffMarks: "color",
    migrations: [],
    shell: "",
    customProviders: [],
    /*
     * Removing a custom provider puts its id here; nothing ever leaves
     * `customProviders`. See `set` for why the store enforces that rather than
     * the caller.
     */
    disabledProviders: [],
    /*
     * Empty until something writes one. The project's own command files are
     * the other half of this list and are read from disk, not from here.
     */
    commands: {},
    providerEndpoints: {},
  }
}

/**
 * Fields earlier builds stored and this one no longer has.
 *
 * Each was a setting whose row is gone because MiMo has no such setting; the
 * behaviour is now MiMo's fixed one. A stored value would otherwise ride along
 * in every write for ever, so it is dropped on every read - MiMo's own settings
 * store deletes its retired keys the same way each time it loads.
 */
export const RETIRED_FIELDS: readonly string[] = [
  // Round nine (S9-1): notifications always on, no permission or failure cue,
  // no Ctrl+wheel zoom in the main window, tool rows always start closed.
  "notifyAgent",
  "notifyPermission",
  "soundPermission",
  "soundError",
  "pinchZoom",
  "expandShell",
  "expandEdits",
  // S9-2: the picker's curation list, whose switches round three removed; every model shows.
  "enabledModels",
  // S9-3: the hidden tab list; the numbered shortcuts count along the side column now.
  "openTabs",
  // S9-5: the three typeface boxes; MiMo deletes its stored faces the same way on every load.
  "uiFont",
  "codeFont",
  "terminalFont",
  // S9-6: the palette choice; MiMo has only the scheme, and MCode draws with its one palette.
  "themeID",
  // S9-7: the post-update notes window's switch; MiMo has no such window.
  "releaseNotes",
  // S9-9: the bar's terminal toggle switch, which nothing ever read.
  "showTerminal",
  // S9-14: the remote-backend connection MiMo does not have; the window only ever talks to its own backend.
  "serverURL",
  "servers",
  "defaultServer",
]

/** Takes the retired fields out of a document; answers whether any was there. */
function dropRetired(document: object): boolean {
  const record = document as Record<string, unknown>
  let dropped = false
  for (const field of RETIRED_FIELDS) {
    if (!(field in record)) continue
    delete record[field]
    dropped = true
  }
  return dropped
}

/**
 * The permission map MiMo's three levels leave behind, at `level`.
 *
 * MiMo has no per-tool answers, only the level; the map is how this app stores
 * the level. So full access is every bucket allowed, and the other two levels
 * are the defaults - the middle one is applied on top of them by `accessLevel`.
 */
export function levelMap(level: Access): Record<PermissionKind, PermissionAction> {
  if (level !== "full") return { ...DEFAULT_PERMISSIONS }
  return Object.fromEntries(PERMISSION_KINDS.map((kind) => [kind, "allow"])) as Record<PermissionKind, PermissionAction>
}

/** MiMo's defaults when nothing is stored: the middle level, and the full access switch on. */
export function firstInstall(): Pick<AppConfig, "accessLevel" | "allowFullAccess"> {
  return { accessLevel: "auto", allowFullAccess: true }
}

/**
 * What a config document on disk says about permissions.
 *
 * A document written by a build that had the map is read straight off. One
 * written before that has only the old list of approvals, and is read through
 * it, so someone who had approved the shell still has the shell approved and
 * everything they had not approved still asks. A document from a build older
 * than either has neither, and gets the defaults - which are the behaviours it
 * was running under anyway.
 */
function storedPermissions(stored: Partial<AppConfig> | undefined): Record<PermissionKind, PermissionAction> {
  const base = { ...DEFAULT_PERMISSIONS }
  const map = knownActions(stored?.permissions as Partial<Record<string, unknown>> | undefined)
  if (Object.keys(map).length) return { ...base, ...map }
  if (Array.isArray(stored?.autoApprove)) return fromApprovals(base, stored.autoApprove)
  return base
}

/**
 * Config, credentials, and the discovered model lists.
 *
 * Credentials live in their own owner-only file and never cross the wire -
 * the renderer only ever learns whether a provider is configured. Discovered
 * models are cached separately from config because a gateway like OpenRouter
 * returns hundreds of entries, which has no business inside a settings blob.
 */
/** The buckets that run without asking, which is what the old list held. */
function allowed(permissions: Record<PermissionKind, PermissionAction>): PermissionKind[] {
  return PERMISSION_KINDS.filter((kind) => permissions[kind] === "allow")
}

/** A stored map, with anything this build does not recognise dropped. */
function knownActions(
  stored: Partial<Record<string, unknown>> | undefined,
): Partial<Record<PermissionKind, PermissionAction>> {
  const out: Partial<Record<PermissionKind, PermissionAction>> = {}
  if (!stored || typeof stored !== "object") return out
  for (const kind of PERMISSION_KINDS) {
    const value = stored[kind]
    if (typeof value === "string" && (PERMISSION_ACTIONS as readonly string[]).includes(value)) {
      out[kind] = value as PermissionAction
    }
  }
  return out
}

/**
 * Reads a list of approvals - the shape this setting had before there were
 * three answers - onto a map.
 *
 * Two things it deliberately will not do. It never turns a Deny into anything
 * else, because the old shape has no word for "never" and so a sentence written
 * in it cannot take one back; and a bucket it does not name that runs without
 * asking by default is left alone, because the list was written when only the
 * buckets that prompt were in it and it can only be read as a sentence about
 * those. Everything else it does not name goes back to asking, which is what an
 * approval being absent from that list always meant.
 */
function fromApprovals(
  base: Record<PermissionKind, PermissionAction>,
  approvals: readonly string[],
): Record<PermissionKind, PermissionAction> {
  const out = { ...base }
  for (const kind of PERMISSION_KINDS) {
    if (out[kind] === "deny") continue
    if (approvals.includes(kind)) out[kind] = "allow"
    else if (DEFAULT_PERMISSIONS[kind] !== "allow") out[kind] = "ask"
  }
  return out
}

/**
 * The one invariant the custom-provider list has: entries are disabled, never
 * deleted.
 *
 * The reference has no delete. Its Settings screen's `disconnect()` forgets the
 * credential and appends the id to `disabled_providers`; the config record
 * survives, both the provider service (`isProviderAllowed`, node-BBwF64dM.js
 * @34277010) and the list handler (@34606145) filter on that set, and adding a
 * provider writes `{provider: {[id]: config}, disabled_providers: nextDisabled}`
 * with the id taken back out - so re-adding under a removed id restores it,
 * which is the only editing path the reference offers. Its form's collision
 * rule is `existingProviderIDs.has(id) && !disabled` for exactly that reason.
 *
 * It lives here, in the store, rather than at the two call sites because the
 * store is where "the list is keyed by id" is true: the reference holds these
 * in an object, this app in an array, and an array will happily carry the same
 * id twice or lose one silently. So a write that drops an id disables it, a
 * write that repeats an id replaces that record, and either way an id that is
 * present is not disabled.
 */
function customProviderWrite(
  before: readonly CustomProvider[],
  after: AppConfig,
): Pick<AppConfig, "customProviders" | "disabledProviders"> {
  const written = new Map<string, CustomProvider>()
  // Last wins: re-adding an id is how the reference edits a provider.
  for (const entry of after.customProviders) written.set(entry.id, entry)

  const kept = [...written.values()]
  const dropped = before.filter((entry) => !written.has(entry.id))
  for (const entry of dropped) kept.push(entry)

  const disabled = new Set(after.disabledProviders ?? [])
  for (const entry of dropped) disabled.add(entry.id)
  for (const id of written.keys()) disabled.delete(id)
  // An id with no record behind it would hide a built-in for good.
  const known = new Set(kept.map((entry) => entry.id))
  return {
    customProviders: kept,
    disabledProviders: [...disabled].filter((id) => known.has(id)),
  }
}

type CustomModelEntry = NonNullable<CustomProvider["models"]>[number]

/**
 * A custom model as it may be stored: its id stripped of every blank and its
 * name trimmed, as MiMo saves them, and MiMo's
 * 高级配置 checked. The image switch has three states (absent is the default),
 * and each limit is a positive whole number of tokens, with an output limit
 * allowed only beside an input limit. A limit that breaks those rules is
 * refused rather than quietly dropped, so a mistyped cap never passes as set.
 */
export function customModelOf(model: CustomModelEntry): CustomModelEntry {
  const out: CustomModelEntry = { id: normalizeModelId(String(model.id ?? "")), name: String(model.name ?? "").trim() }
  if (typeof model.attachment === "boolean") out.attachment = model.attachment
  const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0
  const context = model.limit?.context
  const output = model.limit?.output
  const invalid = "A model limit must be a positive whole number, and an output limit needs an input limit"
  if (context !== undefined && !positive(context)) throw new CodedError(invalid, "provider.custom.limitInvalid")
  if (output !== undefined && (!positive(output) || context === undefined)) throw new CodedError(invalid, "provider.custom.limitInvalid")
  if (positive(context)) out.limit = positive(output) ? { context, output } : { context }
  // MiMo's other model fields, kept when a config file states them.
  const inputs = Object.fromEntries((["pdf", "audio", "video"] as const).flatMap((key) => (typeof model.inputs?.[key] === "boolean" ? [[key, model.inputs[key]]] : [])))
  if (Object.keys(inputs).length) out.inputs = inputs
  if (model.cacheTTL === "5m" || model.cacheTTL === "1h") out.cacheTTL = model.cacheTTL
  if (model.interleaved === "reasoning" || model.interleaved === "reasoning_content" || model.interleaved === "reasoning_details") out.interleaved = model.interleaved
  return out
}

/**
 * A model as models.dev describes it, laid over what this app knew: models.dev
 * decides limits, prices and capabilities wherever it states them, and the
 * app's own table keeps the name it gives a model.
 */
export function withCatalog(entry: ModelEntry, listed: CatalogModel | undefined, keepName: boolean): ModelEntry {
  if (!listed) return entry
  const input = listed.modalities?.input
  const efforts = listed.reasoning_options?.find((option) => option.type === "effort")?.values
  const interleaved = typeof listed.interleaved === "object" && listed.interleaved && "field" in listed.interleaved ? String((listed.interleaved as { field: unknown }).field) : undefined
  const positive = (value: number | undefined) => (value && value > 0 ? value : undefined)
  return {
    ...entry,
    name: keepName || !listed.name ? entry.name : listed.name,
    contextWindow: positive(listed.limit?.context) ?? entry.contextWindow,
    ...(positive(listed.limit?.output) ? { maxOutput: listed.limit!.output } : {}),
    input: listed.cost?.input ?? entry.input,
    output: listed.cost?.output ?? entry.output,
    ...(listed.cost?.cache_read !== undefined ? { cacheRead: listed.cost.cache_read } : {}),
    ...(listed.cost?.cache_write !== undefined ? { cacheWrite: listed.cost.cache_write } : {}),
    // The dearer tier past 200k, where the catalog gives both halves of it; see `costOf`.
    ...(listed.cost?.context_over_200k?.input !== undefined && listed.cost.context_over_200k.output !== undefined
      ? {
          over200K: {
            input: listed.cost.context_over_200k.input,
            output: listed.cost.context_over_200k.output,
            ...(listed.cost.context_over_200k.cache_read !== undefined ? { cacheRead: listed.cost.context_over_200k.cache_read } : {}),
            ...(listed.cost.context_over_200k.cache_write !== undefined ? { cacheWrite: listed.cost.context_over_200k.cache_write } : {}),
          },
        }
      : {}),
    reasoning: listed.reasoning ?? entry.reasoning,
    attachment: listed.attachment ?? entry.attachment,
    toolCall: listed.tool_call ?? entry.toolCall,
    temperature: listed.temperature ?? entry.temperature,
    ...(input
      ? { inputs: { text: input.includes("text"), image: input.includes("image"), audio: input.includes("audio"), video: input.includes("video"), pdf: input.includes("pdf") } }
      : {}),
    ...(efforts ? { efforts: efforts.filter((value): value is Effort => (EFFORTS as readonly string[]).includes(value)) } : {}),
    ...(interleaved ? { interleaved } : {}),
  }
}

export class Config {
  private current: AppConfig = defaults()
  /** The models.dev catalog (provider/models-dev.ts); empty until it has loaded. */
  private catalog: Catalog = {}
  private credentials: Record<string, string> = {}
  private oauth: Record<string, OAuthTokens> = {}
  private discovered: Record<string, ModelEntry[]> = {}
  /** Whether a document was already on disk when this process read it; see the import migration. */
  private existed = false

  /** Which main repository a conversation folder is part of, kept between launches. */
  readonly repoRoots: RepoRoots

  constructor(
    private readonly storage: Storage,
    private readonly bus: Bus,
    private readonly credentialFile: string,
  ) {
    this.repoRoots = new RepoRoots(storage)
  }

  /**
   * Changes to a document that this build makes once and then leaves alone.
   *
   * Answers whether anything moved, so a document already migrated is not
   * rewritten on every launch. Each entry runs only if its name is absent, and
   * the name is recorded whether or not the value needed changing - a
   * migration that did nothing this time still must not run again, or it would
   * undo a choice made after it.
   */
  private migrate(): boolean {
    const done = new Set(this.current.migrations ?? [])
    let moved = false
    const once = (name: string, apply: () => void) => {
      if (done.has(name)) return
      apply()
      done.add(name)
      moved = true
    }

    /*
     * Round three renamed several commands to MiMo's ids. A chord someone bound
     * under the old id would otherwise stop working without a word; it moves to
     * the new id unless that one already has a binding. Commands that are gone
     * (new terminal, the duplicate fork) take their chords with them.
     */
    once("keybind-ids-r3", () => {
      const renamed: Record<string, string | undefined> = {
        "command.palette": "app.search",
        "model.variant.decrease": "effort.decrease",
        "model.variant.increase": "effort.increase",
        "view.rightMax": "panel.maximize",
        "view.rightExpand": "panel.maximize",
        "session.forkChat": undefined,
        "terminal.new": undefined,
      }
      const binds = { ...(this.current.keybinds ?? {}) }
      for (const [from, to] of Object.entries(renamed)) {
        if (!(from in binds)) continue
        if (to && !(to in binds)) binds[to] = binds[from]
        delete binds[from]
      }
      this.current.keybinds = binds
    })

    /*
     * Recording now reads the physical key, so a chord saved in the old printed
     * form (Ctrl+Shift+{) is rewritten to the one a keystroke produces
     * (Ctrl+Shift+[), or it would never fire again. A deleted binding ("")
     * stays deleted.
     */
    once("keybind-chords-r4", () => {
      const binds: Record<string, string> = {}
      for (const [id, chord] of Object.entries(this.current.keybinds ?? {})) binds[id] = normalizeChord(chord)
      this.current.keybinds = binds
    })

    /*
     * Round five takes MiMo's eight chimes. A figure chosen from the old five
     * moves to its nearest new one; off stays off.
     */
    once("chime-r5", () => {
      this.current.taskDoneSound = migrateChime(this.current.taskDoneSound)
    })

    // Round five dropped the chords MiMo lacks; see `retireKeybinds` for what a saved binding keeps.
    once("keybind-retired-r5", () => {
      this.current.keybinds = retireKeybinds(this.current.keybinds ?? {})
    })

    /*
     * Full access now needs its settings switch, and the server holds a config
     * at full access with the switch off to the default. A config that reached
     * full access before that rule (the auto-accept chord, the per-tool rows)
     * turns the switch on instead, so nobody's permissions change on upgrade.
     */
    once("full-access-switch-r5", () => {
      const map = this.current.permissions
      const full = this.current.accessLevel !== "auto" && PERMISSION_KINDS.every((kind) => map[kind] !== "ask")
      if (full && !this.current.allowFullAccess) this.current.allowFullAccess = true
    })

    /*
     * 导入: the one question about conversations in other AI apps belongs to a
     * new profile's first run. A profile that has been running without it is
     * marked as already asked, so an upgrade never opens a window over the
     * conversations it already has - and nothing stored is touched either way.
     */
    once("import-prompt-r6", () => {
      if (this.existed) this.current.importOnboarded = true
    })

    /*
     * Round nine (S9-1): the per-tool answers had no row left to change them,
     * yet a stored "deny" still refused a tool at every level and a stored
     * "allow" still skipped a question at the default one. MiMo has only the
     * three levels, so the map goes back to what the level the user is on
     * writes, and the set-aside map full access kept goes with it. The level
     * itself - and the full access switch - are the user's and stay.
     */
    once("orphans-r9", () => {
      this.current.permissions = levelMap(defaultAccess(this.current))
      delete this.current.accessBefore
    })

    /*
     * Round nine: MCP tool calls stop asking by default, as in MiMo (the
     * user's decision of 2026-09-17). A document that went through the reset
     * above before the default changed still says "ask" for MCP, which
     * cannot be told from a choice, so it moves to the new default once; a
     * refusal stays.
     */
    once("mcp-allow-r9", () => {
      const map = this.current.permissions
      if (map?.mcp === "ask") this.current.permissions = { ...map, mcp: "allow" }
      const kept = this.current.accessBefore
      if (kept?.mcp === "ask") this.current.accessBefore = { ...kept, mcp: "allow" }
    })

    if (moved) this.current.migrations = [...done]
    return moved
  }

  async load(): Promise<void> {
    /*
     * A config that will not parse must not stop the app from opening.
     *
     * This used to throw straight out of the backend's start-up, so a half
     * written or hand-edited config.json left the whole app unopenable with a
     * syntax error and no interface left to fix it from - the very scenario the
     * byte-order-mark note in the store describes, fixed there for one cause
     * only. The reference never throws here either: an absent file is defaults,
     * an unparseable one is an error it reports and carries on from.
     *
     * The damaged file is kept rather than written over, under a name of its
     * own, so the settings in it can still be got back by hand.
     */
    const read = await this.readStored()
    const stored = read.value
    if (read.corrupt) {
      const aside = await this.storage.quarantine("config")
      this.unreadable = { problem: read.corrupt, evidence: aside }
    }
    /*
     * A file that could not be read still means a profile that has been used
     * before: treating it as a first run would offer to import from other apps
     * on a machine that has been running MCode for months.
     */
    this.existed = stored !== undefined || read.corrupt !== undefined
    // Read before anything is merged: what follows must not write over a newer document.
    this.fromNewerVersion = typeof stored?.schemaVersion === "number" && stored.schemaVersion > CONFIG_SCHEMA_VERSION
    this.current = { ...defaults(), ...stored, permissions: storedPermissions(stored) }
    const retired = dropRetired(this.current)
    // Before the migrations, which read these values as the types they claim to be.
    const cleaned = sanitizeConfig(this.current, defaults())
    /*
     * A first install - no config on disk at all - starts where MiMo's does:
     * 帮我审批, with full access allowed. The user chose these (2026-09-15). Only
     * an absent file counts: a stored config that lacks the fields was written
     * under the old defaults and keeps meaning them. A file that is there but
     * cannot be read is not a first install either - answering one with the
     * first-install permissions would quietly change what this machine allows.
     */
    if (stored === undefined && !read.corrupt) Object.assign(this.current, firstInstall())
    const migrated = this.migrate()
    this.current.autoApprove = allowed(this.current.permissions)
    if ((migrated || retired || cleaned) && !this.fromNewerVersion) await this.persist()
    this.discovered = (await this.storage.read<Record<string, ModelEntry[]>>("models")) ?? {}
    try {
      const raw = JSON.parse(await fs.readFile(this.credentialFile, "utf8"))
      // The file used to be a bare provider -> key map; keep those working.
      const versioned = raw && typeof raw === "object" && ("keys" in raw || "oauth" in raw)
      this.credentials = versioned ? (raw.keys ?? {}) : raw
      this.oauth = versioned ? (raw.oauth ?? {}) : {}
    } catch {
      this.credentials = {}
      this.oauth = {}
    }
  }

  /**
   * Set when the stored config would not parse, with where it was kept.
   *
   * The app opens on the defaults either way; this is what lets it say so
   * rather than leaving the reader to wonder where their settings went.
   */
  unreadable: { problem: string; evidence?: string } | undefined

  /**
   * Set when the stored config was written by a later build than this one.
   *
   * Everything still works - the settings that are understood are read as
   * usual - but nothing is written back, so re-installing an older build and
   * opening it once cannot strip the fields the newer one had added.
   */
  fromNewerVersion = false

  /**
   * config.json as stored: JSONC, so a hand edit may carry comments and
   * trailing commas. A file that does not parse is reported with where it broke.
   */
  private async readStored(): Promise<{ value?: Partial<AppConfig>; corrupt?: string; text?: string }> {
    let text: string | undefined
    try {
      text = await this.storage.readText("config")
    } catch (err) {
      return { corrupt: err instanceof Error ? err.message : String(err) }
    }
    if (text === undefined) return {}
    const read = parseJsonc(text)
    if (read.problem) {
      return { corrupt: `config.json is not valid JSON near line ${read.problem.line}, column ${read.problem.column} (${read.problem.reason})`, text }
    }
    if (read.value === undefined) return { text }
    if (!read.value || typeof read.value !== "object" || Array.isArray(read.value)) return { corrupt: "config.json does not hold an object", text }
    return { value: read.value as Partial<AppConfig>, text }
  }

  /*
   * What this process itself wrote lately. A key-by-key save leaves the keys
   * in the file's own order, so the file no longer reads back identical to the
   * settings in memory, and the folder watcher would take every save of ours
   * - including one already overtaken by the next - for a hand edit.
   */
  private readonly written: string[] = []

  /** Writes the settings key by key into the file as it stands, refusing one that no longer parses. */
  private persist(): Promise<void> {
    const file = this.storage.fileOf("config")
    const value = this.current
    return this.storage.writeText("config", (current) => {
      const text = renderJsonc(file, current, value)
      this.written.push(text)
      if (this.written.length > 16) this.written.shift()
      return text
    })
  }

  /** The last credential write, so two of them cannot interleave. */
  private persisting: Promise<void> = Promise.resolve()

  /**
   * Replaces the credential file rather than writing over it.
   *
   * This holds every API key and login token in the app; a truncated one costs
   * the user every provider they had connected, so it gets the same temp-then-
   * rename treatment as the document store.
   */
  private async persistCredentials(): Promise<void> {
    const next = this.persisting.catch(() => {}).then(() =>
      writeAtomic(
        this.credentialFile,
        JSON.stringify({ keys: this.credentials, oauth: this.oauth }, null, 2),
        0o600,
      ),
    )
    this.persisting = next
    await next
  }

  /** Tokens from a subscription login, if this provider has one. */
  tokens(provider: string): OAuthTokens | undefined {
    return this.oauth[provider]
  }

  async setTokens(provider: string, tokens: OAuthTokens | undefined): Promise<void> {
    if (tokens) this.oauth[provider] = tokens
    else delete this.oauth[provider]
    await this.persistCredentials()
  }

  get(): AppConfig {
    return this.current
  }

  private watcher?: FSWatcher

  /**
   * Hand edits to config.json take effect without reopening the app.
   *
   * MiMo's MCP page says an edited config file counts from the next
   * conversation; this reloads the document whenever the file on disk comes to
   * say something other than what this process holds, and announces it the
   * way a change made in the window is announced - so MCP servers reconnect and
   * the window redraws. The folder is watched rather than the file, because a
   * save by rename (this app's own, and many editors') replaces the file a
   * watcher would be holding. A file that does not parse is left alone until it
   * does.
   */
  watch(): void {
    if (this.watcher) return
    const file = this.storage.fileOf("config")
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      this.watcher = watchFiles(path.dirname(file), (_event, name) => {
        if (name && name.toString() !== path.basename(file)) return
        clearTimeout(timer)
        timer = setTimeout(() => void this.reloadFromDisk(), 150)
      })
      this.watcher.unref()
    } catch {
      // A folder that cannot be watched only means edits wait for the next launch.
    }
  }

  /** Told after a hand edit has been taken in, with the settings before and after it. */
  private reloadListeners: ((before: AppConfig, after: AppConfig) => void | Promise<void>)[] = []

  onReload(listener: (before: AppConfig, after: AppConfig) => void | Promise<void>): void {
    this.reloadListeners.push(listener)
  }

  /**
   * A hand edit, taken in under the same rules as a launch and a change made in
   * the window.
   *
   * It used to be spread over the defaults and nothing else: a document marked
   * as written by a later build was then written over by the next change, a
   * custom provider deleted from the file was simply gone rather than disabled,
   * and turning full access off left every conversation already at full access
   * there until its next question.
   */
  async reloadFromDisk(): Promise<void> {
    // A file that stopped parsing is left alone: the next save refuses and says where it broke.
    const read = await this.readStored()
    const stored = read.value
    if (!stored || (read.text !== undefined && this.written.includes(read.text))) return
    if (JSON.stringify(stored) === JSON.stringify(this.current)) return
    const before = this.current
    // As load reads it: a later build's document is taken in but never written back over.
    this.fromNewerVersion = typeof stored.schemaVersion === "number" && stored.schemaVersion > CONFIG_SCHEMA_VERSION
    let next: AppConfig = { ...defaults(), ...stored, permissions: storedPermissions(stored) }
    dropRetired(next)
    sanitizeConfig(next, defaults())
    // As set keeps it: a custom provider taken out of the file is disabled, not lost.
    if (JSON.stringify(next.customProviders) !== JSON.stringify(before.customProviders)) {
      next = { ...next, ...customProviderWrite(before.customProviders, next) }
    }
    next.autoApprove = allowed(next.permissions)
    this.current = next
    this.bus.publish({ type: "config.updated", config: this.current })
    for (const listener of this.reloadListeners) await Promise.resolve(listener(before, next)).catch(() => undefined)
  }

  /**
   * One change at a time (N11-34). A save that fails rolls the settings back to
   * how it found them, and two overlapping saves meant that roll-back also
   * threw away the other save's change - gone from memory and never written.
   * Queued, "how it found them" is exactly the state before this change.
   */
  private setting: Promise<unknown> = Promise.resolve()

  set(patch: Partial<AppConfig>): Promise<AppConfig> {
    const next = this.setting.catch(() => undefined).then(() => this.setNow(patch))
    this.setting = next
    return next
  }

  private async setNow(patch: Partial<AppConfig>): Promise<AppConfig> {
    const previous = this.current
    try {
      return await this.apply(patch)
    } catch (err) {
      // A save that could not be written leaves the settings as they were, so memory never runs ahead of the file.
      this.current = previous
      throw err
    }
  }

  private async apply(patch: Partial<AppConfig>): Promise<AppConfig> {
    const before = this.current.permissions
    const providersBefore = this.current.customProviders
    const projectsBefore = { projects: this.current.projects, closedProjects: this.current.closedProjects }
    this.current = { ...this.current, ...patch }
    dropRetired(this.current)
    if (patch.customProviders) {
      this.current = { ...this.current, ...customProviderWrite(providersBefore, this.current) }
    }
    // A folder taken out of the removed set is a project again, and one put in it leaves the list.
    if (patch.projects || patch.closedProjects) {
      this.current.projects = reconciledProjects(projectsBefore, this.current)
    }
    /*
     * A patch may speak either vocabulary. The map wins when both are present:
     * it is the one that can say every answer, and a caller sending both has
     * said the same thing twice.
     */
    if (patch.permissions) {
      this.current.permissions = { ...before, ...knownActions(patch.permissions) }
    } else if (patch.autoApprove) {
      this.current.permissions = fromApprovals(before, patch.autoApprove)
    } else {
      this.current.permissions = before
    }
    this.current.autoApprove = allowed(this.current.permissions)
    /*
     * Never written over a document a later build wrote.
     *
     * Reading one is fine - the fields this build understands still mean what
     * they say - but writing this build's understanding back would drop every
     * field the newer one had added. Detecting a newer document has to mean
     * refusing the write, not only refusing to trust the read, and refusing it
     * out loud so the user is told rather than left with settings that quietly
     * do not stick.
     */
    if (this.fromNewerVersion) {
      throw new CodedError("The stored settings were written by a newer version of this app", "error.configNewer")
    }
    this.current = { ...this.current, schemaVersion: CONFIG_SCHEMA_VERSION }
    await this.persist()
    this.bus.publish({ type: "config.updated", config: this.current })
    return this.current
  }

  /**
   * Folders neither listed nor removed join the project list, as MiMo derives them.
   *
   * `byRepository` is for a conversation's own folder: one that is not a known
   * project is filed under the main repository it belongs to, so a
   * conversation in a linked worktree or a subdirectory adds the repository's
   * project rather than one of its own, and a folder that is gone adds nothing.
   * A folder the reader chose as a project (移动至项目) is taken as it is.
   */
  async adoptProjects(directories: readonly string[], options: { byRepository?: boolean } = {}): Promise<void> {
    const folders = options.byRepository ? await this.projectFolders(directories) : directories
    const patch = adoptedProjects(this.current, folders)
    if (patch) await this.set(patch)
  }

  private async projectFolders(directories: readonly string[]): Promise<string[]> {
    const known = [...(this.current.projects ?? []), ...(this.current.closedProjects ?? [])]
    const out: string[] = []
    for (const directory of directories) {
      const listed = knownFolder(known, directory)
      if (listed) {
        out.push(listed)
        continue
      }
      const { roots, missing } = await this.repoRoots.resolve([directory])
      if (missing.includes(directory)) continue
      const root = roots[directory]
      out.push(root ? (knownFolder(known, root) ?? root) : directory)
    }
    return out
  }

  /**
   * Once: a listed project that is a linked worktree of another repository
   * leaves the list, and that repository's folder joins it, so the worktree's
   * conversations are filed under the repository as new ones now are. Only
   * linked worktrees - a subdirectory may have been added as a project on
   * purpose - and nothing about the conversations themselves changes.
   */
  async migrateRepositoryProjects(): Promise<void> {
    const done = this.current.migrations ?? []
    if (done.includes(REPOSITORY_PROJECTS_MIGRATION)) return
    const leaving = new Set<string>()
    const joining: string[] = []
    for (const directory of listedProjects(this.current)) {
      const top = await worktreeTop(directory).catch(() => undefined)
      if (!top || top.main) continue
      const root = await this.repoRoots.rootOf(directory).catch(() => undefined)
      if (!root) continue
      leaving.add(directory)
      joining.push(root)
    }
    const kept = (list: string[] | undefined) => (list ?? []).filter((entry) => !leaving.has(entry))
    const trimmed = { ...this.current, projects: kept(this.current.projects) }
    const known = [...trimmed.projects, ...(trimmed.closedProjects ?? [])]
    const adopted = adoptedProjects(trimmed, joining.map((root) => knownFolder(known, root) ?? root))
    await this.set({
      projects: adopted?.projects ?? trimmed.projects,
      ...(leaving.size ? { pinnedProjects: kept(this.current.pinnedProjects), projectOrder: kept(this.current.projectOrder) } : {}),
      migrations: [...done, REPOSITORY_PROJECTS_MIGRATION],
    })
  }

  /**
   * Round ten (R10-6): project memory moves from one folder per conversation
   * folder to one per repository, once. `move` does the moving and is handed
   * every folder this profile knows of; the migration is recorded only when it
   * finished, so a failure is tried again at the next launch.
   */
  async migrateMemory(directories: readonly string[], move: (directories: string[]) => Promise<unknown>): Promise<void> {
    const done = this.current.migrations ?? []
    if (done.includes(MEMORY_LAYOUT_MIGRATION)) return
    await move([...directories, ...listedProjects(this.current), ...(this.current.closedProjects ?? [])])
    await this.set({ migrations: [...(this.current.migrations ?? []), MEMORY_LAYOUT_MIGRATION] })
  }

  /**
   * Once, when the list first exists: every folder the side column listed from
   * its conversations becomes an entry, newest conversation first. Names, pins,
   * the removed set and the dragged order are separate fields and stay as they
   * were.
   */
  async migrateProjects(directories: readonly string[]): Promise<void> {
    const done = this.current.migrations ?? []
    if (done.includes(PROJECT_LIST_MIGRATION)) return
    await this.set({ ...adoptedProjects(this.current, directories), migrations: [...done, PROJECT_LIST_MIGRATION] })
  }

  /**
   * An explicit key stored in the app wins; otherwise fall back to the ambient
   * environment so an existing shell setup just works.
   */
  apiKey(provider: string): string | undefined {
    const stored = this.credentials[provider]
    if (stored) return stored
    return process.env[this.environmentName(provider) ?? ""] || undefined
  }

  /**
   * The variable a provider's key would come from, whether or not it is set.
   *
   * Built-ins have a fixed name; a custom provider names its own, because the
   * reference lets the key field be typed as `{env:MY_VAR}` and writes that
   * variable's name into the config instead of the secret. This is the whole
   * of that indirection - nothing is stored, and the value is read at the
   * moment it is needed.
   */
  private environmentName(provider: string): string | undefined {
    const custom = this.current.customProviders.find((entry) => entry.id === provider)
    if (custom) return custom.environment
    return ENV_KEYS[provider]
  }

  /**
   * The environment variable a provider's key is coming from, when that is
   * where it comes from.
   *
   * Only the name, never the value: this travels to the interface so it can
   * say which variable is in force. A stored key wins in `apiKey`, so this is
   * empty whenever the app holds one of its own - the distinction matters
   * because the app can take back what it holds and cannot touch the shell.
   */
  environmentKey(provider: string): string | undefined {
    if (this.credentials[provider]) return undefined
    const name = this.environmentName(provider)
    if (!name) return undefined
    return process.env[name] ? name : undefined
  }

  async setApiKey(provider: string, apiKey: string): Promise<void> {
    if (apiKey) this.credentials[provider] = apiKey
    else {
      delete this.credentials[provider]
      /*
       * The discovered catalog describes what a key can drive, so it goes when
       * the key goes - but an environment variable can be supplying one too,
       * and that survives anything done here. Dropping the catalog in that case
       * left the provider still connected, still reachable, and reporting that
       * it had no models, because the fallback catalog only covers the handful
       * of providers with a curated list.
       */
      if (!this.environmentKey(provider)) {
        delete this.discovered[provider]
        await this.storage.write("models", this.discovered)
      }
    }
    await this.persistCredentials()
  }

  async setDiscovered(provider: string, models: ModelEntry[]): Promise<void> {
    this.discovered[provider] = models
    await this.storage.write("models", this.discovered)
  }

  /**
   * Built-ins plus whatever the user added by base URL, minus anything
   * disabled.
   *
   * The filter is here, at the single place every other reader goes through -
   * `definition`, `models`, `providers`, `usable`, `enabled` all come back to
   * this - which is how one line delivers the reference's whole removal
   * behaviour. A disabled provider is absent from Settings, absent from the
   * model picker, and unreachable by a turn; and because the id-collision check
   * in the add handler asks `definition(id)`, a disabled id is free to be
   * claimed again, which is the reference's `&& !disabled` escape hatch reached
   * from the other end.
   */
  definitions(): ProviderDefinition[] {
    const disabled = new Set(this.current.disabledProviders ?? [])
    const custom = this.current.customProviders
      .filter((entry) => !disabled.has(entry.id))
      .map<ProviderDefinition>((entry) => ({
        id: entry.id,
        name: entry.name,
        // MiMo lets a custom provider name its SDK; here that is the protocol it speaks.
        kind: entry.protocol === "anthropic" ? "anthropic" : "openai-compatible",
        description: "provider.desc.custom",
        // Tidied as a save would be, so an address stored before that rule still reaches the right path.
        baseURL: normalizeBaseURL(entry.baseURL),
        headers: entry.headers,
        /*
         * The typed-in list becomes the provider's catalog, and `handEntered`
         * stops anything asking /models for a better one. The reference never
         * probes a custom provider at all: plenty of OpenAI-compatible
         * endpoints have no such route, and asking is how a working provider
         * ends up showing an empty picker.
         */
        /* MiMo's 高级配置 reaches the catalog: limits feed compaction and max_tokens, the image switch the attachment check. */
        models: entry.models?.map((model) => ({
          id: model.id,
          name: model.name,
          contextWindow: model.limit?.context ?? 0,
          ...(model.limit?.output ? { maxOutput: model.limit.output } : {}),
          ...(typeof model.attachment === "boolean" ? { attachment: model.attachment } : {}),
          // MiMo's modalities: the image switch, and the other inputs a config file may state.
          ...(typeof model.attachment === "boolean" || model.inputs
            ? { inputs: { text: true, ...model.inputs, ...(typeof model.attachment === "boolean" ? { image: model.attachment } : {}) } }
            : {}),
          ...(model.cacheTTL ? { cacheTTL: model.cacheTTL } : {}),
          ...(model.interleaved ? { interleaved: model.interleaved } : {}),
          input: 0,
          output: 0,
        })),
        handEntered: true,
      }))
    // An override adjusts the built-in in place; appending would create a
    // second entry with the same id.
    const overrides = this.current.providerEndpoints ?? {}
    const builtIn = BUILT_IN.filter((entry) => !disabled.has(entry.id)).map((entry) =>
      overrides[entry.id] ? { ...entry, baseURL: overrides[entry.id] } : entry,
    )
    return [...builtIn, ...custom]
  }

  definition(id: string): ProviderDefinition | undefined {
    return this.definitions().find((entry) => entry.id === id)
  }

  /** Hands over a newer models.dev catalog; what `models()` answers changes with it. */
  useModelCatalog(catalog: Catalog): void {
    this.catalog = catalog
  }

  /** The models.dev catalog as it stands. */
  modelCatalog(): Catalog {
    return this.catalog
  }

  /**
   * A provider's models with what models.dev says about each. Custom
   * providers are left as typed: their ids are the user's, not models.dev's.
   */
  models(provider: string): ModelEntry[] {
    const listed = this.catalog[MODELS_DEV_IDS[provider] ?? ""]?.models
    const entries = this.listedModels(provider)
    if (!listed || this.definition(provider)?.handEntered) return entries
    const curated = new Set((this.definition(provider)?.models ?? []).map((entry) => entry.id))
    return entries.map((entry) => withCatalog(entry, listed[entry.id], curated.has(entry.id) || entry.name !== nameFromId(entry.id)))
  }

  /**
   * A discovered list wins when we have one - it is fresher than anything
   * baked in here - and the static catalog is the fallback for providers that
   * expose no /models endpoint, or whose discovery has not run or failed.
   */
  private listedModels(provider: string): ModelEntry[] {
    const discovered = this.discovered[provider]
    /*
     * Read through `this.definition`, not the module-level one: that only knows
     * the built-ins, so a custom provider's hand-entered models were invisible
     * here and its picker came up empty however many were typed in.
     */
    const curated = this.definition(provider)?.models ?? []
    if (!discovered?.length) return curated

    /*
     * Discovery is authoritative about which models exist; the catalog is
     * authoritative about what they are called. Taking the discovered list
     * wholesale threw the names away, so the picker showed `mimo-v2.5` where
     * the vendor writes MiMo-V2.5. Merged here rather than at discovery time so
     * a list already cached on disk is fixed without re-fetching it.
     */
    const named = new Map(curated.map((entry) => [entry.id, entry]))
    return discovered
      /*
       * Filtered here as well as at discovery, so a list already cached from
       * before that check existed stops offering embeddings and speech models
       * without waiting for someone to press refresh.
       */
      .filter((entry) => conversational(entry.id))
      .map((entry) => {
        const known = named.get(entry.id)
        /*
         * The catalog also wins on capabilities, not just the name. What it
         * holds came out of the reference's own model table; what a discovered
         * row holds is whatever the provider volunteered, which for most of
         * them is nothing at all - and "nothing" reads as false, which would
         * quietly take the effort control away from a model known to reason.
         */
        if (known) {
          return {
            ...entry,
            name: known.name,
            input: known.input,
            output: known.output,
            reasoning: known.reasoning ?? entry.reasoning,
            attachment: known.attachment ?? entry.attachment,
            toolCall: known.toolCall ?? entry.toolCall,
            temperature: known.temperature ?? entry.temperature,
            maxOutput: known.maxOutput ?? entry.maxOutput,
            inputs: known.inputs ?? entry.inputs,
            efforts: known.efforts ?? entry.efforts,
          }
        }
        // A raw id is not a name, whether or not we have heard of the model.
        return entry.name === entry.id ? { ...entry, name: nameFromId(entry.id) } : entry
      })
  }

  modelEntry(ref: ModelRef): ModelEntry | undefined {
    return this.models(ref.provider).find((entry) => entry.id === ref.model)
  }

  /**
   * The reasoning efforts one model accepts, or undefined when it is not a
   * model we know anything about.
   *
   * The two answers are deliberately different. An empty array says "this
   * model takes no effort parameter", which an adapter honours by sending
   * none; undefined says "nobody has worked it out", which leaves the adapter
   * to do what it has always done.
   */
  /**
   * Whether this provider can answer a prompt at all.
   *
   * A stored key or a subscription is the usual answer. The third case is the
   * one the custom-provider form invites in so many words - its key field is
   * labelled "Optional. Leave empty if you manage auth via headers" - and
   * without it that reader gets a provider that is listed in Settings, tagged
   * Custom, and has no models anywhere: the composer's picker reads
   * `configured`, `enabled()` reads a key, and the runner refuses the turn with
   * "No API key configured". Measured in the running app: a custom provider
   * added with headers and a blank key came back `configured: false` with its
   * typed-in model missing from the picker while an otherwise identical one
   * with a key showed both.
   *
   * Headers are required, not just hand-entry: a custom provider with neither a
   * key nor a header has nothing to authenticate with, and saying it is ready
   * would only move the failure to the first prompt.
   */
  usable(id: string): boolean {
    if (this.apiKey(id) || this.oauth[id]) return true
    const entry = this.definition(id)
    return Boolean(entry?.handEntered && entry.headers && Object.keys(entry.headers).length)
  }

  variants(ref: ModelRef): Effort[] | undefined {
    const entry = this.modelEntry(ref)
    if (!entry) return undefined
    const kind = this.definition(ref.provider)?.kind
    if (!kind) return undefined
    return modelVariants(kind, entry, ref.provider)
  }

  providers(): ProviderStatus[] {
    return this.definitions().map((entry) => ({
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      description: entry.description,
      recommended: entry.recommended ?? false,
      order: entry.order ?? 100,
      group: entry.group,
      groupName: entry.groupName,
      modeLabel: entry.modeLabel,
      custom: !definition(entry.id),
      baseURL: entry.baseURL,
      keyURL: entry.keyURL,
      configured: this.usable(entry.id),
      authenticated: Boolean(this.oauth[entry.id]),
      environment: this.environmentKey(entry.id),
      authMethods: entry.authMethods ?? [],
      models: this.models(entry.id).map((model) => modelInfo(model)),
    }))
  }

  /** Models offered in the composer picker: every model of every usable provider, as MiMo lists them. */
  enabled(): { provider: string; model: ModelEntry }[] {
    const out: { provider: string; model: ModelEntry }[] = []
    for (const provider of this.definitions()) {
      if (!this.usable(provider.id)) continue
      for (const model of this.models(provider.id)) out.push({ provider: provider.id, model })
    }
    return out
  }
}

/** Ambient environment variables consulted when no key is stored. */
const ENV_KEYS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  moonshot: "MOONSHOT_API_KEY",
  zhipu: "ZHIPU_API_KEY",
  dashscope: "DASHSCOPE_API_KEY",
  xai: "XAI_API_KEY",
  xiaomi: "MIMO_API_KEY",
  "xiaomi-plan": "MIMO_PLAN_API_KEY",
  groq: "GROQ_API_KEY",
  siliconflow: "SILICONFLOW_API_KEY",
  volcengine: "ARK_API_KEY",
  minimax: "MINIMAX_API_KEY",
  stepfun: "STEPFUN_API_KEY",
  hunyuan: "HUNYUAN_API_KEY",
  qianfan: "QIANFAN_API_KEY",
  mistral: "MISTRAL_API_KEY",
  together: "TOGETHER_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
  nvidia: "NVIDIA_API_KEY",
}

export type { CustomProvider }

export function homeDirectory(): string {
  return os.homedir()
}
