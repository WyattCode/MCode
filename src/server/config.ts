import { DEFAULT_APP_ICON } from "@shared/app-icons"
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
  PERMISSION_ACTIONS,
  PERMISSION_KINDS,
  type PermissionKind,
} from "@shared/protocol"
import { adoptedProjects, reconciledProjects } from "@shared/projects"
import type { Storage } from "./storage"
import { writeAtomic } from "./storage"
import type { Bus } from "./bus"
import {
  BUILT_IN,
  definition,
  type ModelEntry,
  type ProviderDefinition,
  type ProviderKind,
} from "./provider/catalog"
import { nameFromId } from "./provider/model-name"
import { conversational } from "./provider/discover"
import { modelVariants } from "./provider/variants"
import type { OAuthTokens } from "./auth/oauth"

export const DEFAULT_MODEL: ModelRef = { provider: "anthropic", model: "claude-opus-5" }

/** Recorded in `migrations` once the project list has been filled from conversations. */
export const PROJECT_LIST_MIGRATION = "projects-list"

export type { ModelEntry }

/** "provider/model" - the key models are enabled and looked up by. */
export function modelKey(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}`
}

/**
 * One catalog entry as the window sees it.
 *
 * Absent is false throughout, which is the reference's own default for every
 * capability read, and the effort list is worked out here rather than stored so
 * a catalog edit cannot leave a model advertising levels its family has never
 * accepted.
 */
function modelInfo(kind: ProviderKind, model: ModelEntry, provider: string): ModelInfo {
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
    variants: modelVariants(kind, model, provider),
  }
}

function defaults(): AppConfig {
  return {
    model: DEFAULT_MODEL,
    theme: "system",
    themeID: "mcode-2",
    mcpServers: {},
    pinnedTabs: [],
    pinnedProjects: [],
    projectOrder: [],
    taskOrder: {},
    keybinds: {},
    serverURL: "",
    servers: [],
    defaultServer: "",
    updateFeed: "",
    taskDoneSound: "settle",
    spineSound: true,
    projectRoot: "",
    soundPermission: false,
    soundError: false,
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
    effort: "high",
    agent: "build",
    staged: false,
    openTabs: [],
    onboarded: false,
    expandShell: false,
    expandEdits: false,
    uiFont: "",
    codeFont: "",
    uiFontSize: 14,
    codeFontSize: 12,
    terminalFont: "",
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
    notifyAgent: true,
    notifyPermission: true,
    /*
     * Off, which is opencode's. Its own getter is
     * `getStore().get(PINCH_ZOOM_ENABLED_KEY) === true`, so an unset store
     * reads false - the gesture is opted into, not out of. Read from the main
     * process rather than the settings UI, whose switch shows whatever the
     * reader last chose.
     */
    pinchZoom: false,
    releaseNotes: true,
    migrations: [],
    showTerminal: true,
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
    /**
     * Which models appear in the composer picker. Empty means "not chosen yet",
     * and the picker falls back to showing everything a connected provider
     * offers - otherwise connecting a provider would appear to do nothing.
     */
    enabledModels: [],
  }
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
 * A custom model as it may be stored: its id and name trimmed, and MiMo's
 * 高级配置 checked. The image switch has three states (absent is the default),
 * and each limit is a positive whole number of tokens, with an output limit
 * allowed only beside an input limit. A limit that breaks those rules is
 * refused rather than quietly dropped, so a mistyped cap never passes as set.
 */
export function customModelOf(model: CustomModelEntry): CustomModelEntry {
  const out: CustomModelEntry = { id: String(model.id ?? "").trim(), name: String(model.name ?? "").trim() }
  if (typeof model.attachment === "boolean") out.attachment = model.attachment
  const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0
  const context = model.limit?.context
  const output = model.limit?.output
  const invalid = "A model limit must be a positive whole number, and an output limit needs an input limit"
  if (context !== undefined && !positive(context)) throw new Error(invalid)
  if (output !== undefined && (!positive(output) || context === undefined)) throw new Error(invalid)
  if (positive(context)) out.limit = positive(output) ? { context, output } : { context }
  // MiMo's other model fields, kept when a config file states them.
  const inputs = Object.fromEntries((["pdf", "audio", "video"] as const).flatMap((key) => (typeof model.inputs?.[key] === "boolean" ? [[key, model.inputs[key]]] : [])))
  if (Object.keys(inputs).length) out.inputs = inputs
  if (model.cacheTTL === "5m" || model.cacheTTL === "1h") out.cacheTTL = model.cacheTTL
  if (model.interleaved === "reasoning" || model.interleaved === "reasoning_content" || model.interleaved === "reasoning_details") out.interleaved = model.interleaved
  return out
}

export class Config {
  private current: AppConfig = defaults()
  private credentials: Record<string, string> = {}
  private oauth: Record<string, OAuthTokens> = {}
  private discovered: Record<string, ModelEntry[]> = {}

  constructor(
    private readonly storage: Storage,
    private readonly bus: Bus,
    private readonly credentialFile: string,
  ) {}

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
     * 2.0 draws with its own theme, MCode 2.0. Changing the default only
     * reaches new documents, and every document already carries a themeID -
     * the default is written in with the rest - so anyone who never chose a
     * theme would open 2.0 looking exactly like 0.x. Only the untouched
     * default moves; a theme that was picked on purpose stays, and picking
     * OC-2 again afterwards sticks, because the name is recorded either way.
     */
    once("theme-mcode-2", () => {
      if (this.current.themeID === "oc-2") this.current.themeID = "mcode-2"
    })

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

    if (moved) this.current.migrations = [...done]
    return moved
  }

  async load(): Promise<void> {
    const stored = await this.storage.read<Partial<AppConfig>>("config")
    this.current = { ...defaults(), ...stored, permissions: storedPermissions(stored) }
    this.current.autoApprove = allowed(this.current.permissions)
    if (this.migrate()) await this.storage.write("config", this.current)
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

  private async reloadFromDisk(): Promise<void> {
    const stored = await this.storage.read<Partial<AppConfig>>("config").catch(() => undefined)
    if (!stored || typeof stored !== "object") return
    if (JSON.stringify(stored) === JSON.stringify(this.current)) return
    this.current = { ...defaults(), ...stored, permissions: storedPermissions(stored) }
    this.current.autoApprove = allowed(this.current.permissions)
    this.bus.publish({ type: "config.updated", config: this.current })
  }

  async set(patch: Partial<AppConfig>): Promise<AppConfig> {
    const before = this.current.permissions
    const providersBefore = this.current.customProviders
    const projectsBefore = { projects: this.current.projects, closedProjects: this.current.closedProjects }
    this.current = { ...this.current, ...patch }
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
    await this.storage.write("config", this.current)
    this.bus.publish({ type: "config.updated", config: this.current })
    return this.current
  }

  /** Conversation folders neither listed nor removed join the project list, as MiMo derives them. */
  async adoptProjects(directories: readonly string[]): Promise<void> {
    const patch = adoptedProjects(this.current, directories)
    if (patch) await this.set(patch)
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
        baseURL: entry.baseURL,
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

  /**
   * A discovered list wins when we have one - it is fresher than anything
   * baked in here - and the static catalog is the fallback for providers that
   * expose no /models endpoint, or whose discovery has not run or failed.
   */
  models(provider: string): ModelEntry[] {
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
      models: this.models(entry.id).map((model) => modelInfo(entry.kind, model, entry.id)),
    }))
  }

  /** Models offered in the composer picker, honouring the enabled list. */
  enabled(): { provider: string; model: ModelEntry }[] {
    const chosen = new Set(this.current.enabledModels)
    const out: { provider: string; model: ModelEntry }[] = []
    for (const provider of this.definitions()) {
      if (!this.usable(provider.id)) continue
      for (const model of this.models(provider.id)) {
        const key = modelKey({ provider: provider.id, model: model.id })
        if (chosen.size === 0 || chosen.has(key)) out.push({ provider: provider.id, model })
      }
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
