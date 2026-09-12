/**
 * Wire protocol shared by the renderer and the Node backend.
 *
 * Two channels ride over one WebSocket:
 *   - request/response, correlated by `id` (RPC)
 *   - server-pushed events, fire-and-forget (broadcast)
 */

// ---------------------------------------------------------------------------
// Session + message model
// ---------------------------------------------------------------------------

/** How many turns can be taken back, and put back. */
export interface HistoryDepth {
  undo: number
  redo: number
}

export interface SessionInfo {
  id: string
  title: string
  /** Absolute path of the project directory this session operates in. */
  directory: string
  model: ModelRef
  agent: AgentName
  /**
   * This session's reasoning effort, or absent to follow the app default.
   *
   * Absent is a real state rather than a missing value - it is what the cycle
   * returns to after the last step, and what a session starts in - but it
   * resolves to the app-wide setting at the point the turn runs, not to
   * "whatever the provider does".
   */
  effort?: Effort
  created: number
  updated: number
  /** Rolling totals across every assistant turn in the session. */
  usage: Usage
  /** Put away rather than deleted: hidden everywhere, restorable from settings. */
  archived?: boolean
  /**
   * Where the conversation was summarised, if it has been.
   *
   * Everything up to and including `messageID` is sent to the model as
   * `summary` instead of verbatim. The messages themselves are kept: the point
   * is to shrink the context, not to lose the history.
   */
  compacted?: { messageID: string; summary: string; at: number }
  /**
   * Where the conversation has been rolled back to, if it has been.
   *
   * `messageID` is the first message that is no longer part of the
   * conversation: it and everything after it are held out of the transcript and
   * out of what the model is given, and the project has been put back to how
   * that point found it. Both halves move together - the boundary is only ever
   * set to a point the files could actually be returned to - so a reader who
   * sees three messages rolled back is looking at a project that no longer
   * carries their changes.
   *
   * The messages themselves stay on disk until the session is prompted again,
   * which is what makes it possible to put them back.
   */
  revert?: { messageID: string; at: number }
}

export interface Usage {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
}

export interface ModelRef {
  provider: string
  model: string
}

export type ToolStatus = "pending" | "running" | "completed" | "error"

export interface ToolPart {
  type: "tool"
  id: string
  /** Provider-assigned tool_use id, echoed back with the result. */
  callID: string
  name: string
  status: ToolStatus
  input: Record<string, unknown>
  /** Human-readable one-liner shown in the collapsed card, e.g. a command. */
  title?: string
  output?: string
  /** Tool-specific structured payload the UI renders richly (diffs, matches). */
  metadata?: Record<string, unknown>
  error?: string
  /** i18n key for `error`, when the failure was one the tool anticipated. */
  errorCode?: string
  errorParams?: Record<string, string>
  time: { created: number; started?: number; completed?: number }
}

export interface TextPart {
  type: "text"
  id: string
  text: string
}

export interface ReasoningPart {
  type: "reasoning"
  id: string
  text: string
  time: { created: number; completed?: number }
}

export type AssistantPart = TextPart | ReasoningPart | ToolPart

/**
 * One file a stored session produced, as the artifacts page needs it.
 *
 * `at` is when the session last wrote it; `modified` is what the file system
 * says now. The two differ when something outside the app has edited the file
 * since, which is worth being able to see.
 */
export interface ArtifactFile {
  /** Project-relative where the file is inside the project, absolute otherwise. */
  path: string
  at: number
  /** False once the file has been deleted or moved away. */
  exists: boolean
  size?: number
  modified?: number
}

/** What one stored session produced, newest file first. */
export interface SessionArtifacts {
  sessionID: string
  title: string
  directory: string
  updated: number
  files: ArtifactFile[]
}

export interface UserMessage {
  id: string
  sessionID: string
  role: "user"
  text: string
  /** Files pinned into the prompt by the user. */
  attachments: Attachment[]
  time: { created: number }
}

export interface Attachment {
  path: string
  mime: string
  /** base64 for binary, utf8 text otherwise. */
  data: string
}

export interface AssistantMessage {
  id: string
  sessionID: string
  role: "assistant"
  model: ModelRef
  agent: AgentName
  /**
   * What this turn ran at, recorded because the session's setting can change
   * between turns. Always set on turns run since this field existed; absent on
   * messages stored before it.
   */
  effort?: Effort
  parts: AssistantPart[]
  usage?: Usage
  /** Set once the turn ends: why it ended, or why it failed. */
  finish?: "end_turn" | "max_tokens" | "aborted" | "error" | "refusal"
  error?: string
  /** i18n key for `error`, when the failure was one the app can phrase itself. */
  errorCode?: string
  errorParams?: Record<string, string>
  time: { created: number; completed?: number }
}

export type Message = UserMessage | AssistantMessage

// ---------------------------------------------------------------------------
// Permission
// ---------------------------------------------------------------------------

/** How one file differs from HEAD, in the vocabulary the review speaks. */
export type GitChangeKind = "added" | "deleted" | "modified"

/** One shell the backend is holding, as the drawer needs to know it. */
export interface ShellSummary {
  shellID: string
  /** False once the process has ended; its output is still there to read. */
  alive: boolean
}

export interface GitChange {
  path: string
  kind: GitChangeKind
}

export interface GitStatus {
  /** Whether git itself is available on this machine. */
  installed: boolean
  repo: boolean
  branch?: string
  changed: string[]
  /*
   * The same files, carrying the letter git already told us.
   *
   * `changed` is kept beside it because most callers only ever ask "which
   * files"; the review is the one place that also has to say how each moved.
   */
  entries: GitChange[]
}

export interface PermissionRequest {
  id: string
  sessionID: string
  messageID: string
  callID: string
  /** Permission bucket, e.g. "bash" or "edit" - approvals are remembered per bucket. */
  kind: string
  title: string
  /** i18n key for `title`, so the dialog can say it in the user's language. */
  titleCode?: string
  /** The exact thing being approved: a command line, a file path, a URL. */
  subject: string
  /** Unified diff or command preview rendered inside the dialog. */
  preview?: string
  time: number
}

export type PermissionResponse = "once" | "always" | "reject"

// ---------------------------------------------------------------------------
// The question tool
// ---------------------------------------------------------------------------

/*
 * A tool the model uses to put a multiple-choice question to the reader and
 * wait for the answer.
 *
 * Every name and every field below is transcribed from the reference, so the
 * two can be compared line by line: the schemas live at node-BBwF64dM.js
 * @22133600 (`QuestionOption`, `QuestionInfo`, `QuestionPrompt`,
 * `QuestionRequest`, `QuestionAnswer`, `QuestionReply`), the tool itself and
 * its description at @19448800, and the HTTP surface at @34442600.
 *
 * It is on by default for this app: the registry decides with
 * `["app","cli","desktop"].includes(flags.client) || flags.enableQuestionTool`
 * (@32848445) and the desktop client is in that list, so there is no setting to
 * read and none is added here.
 *
 * What is deliberately NOT copied is the permission row. The reference asserts
 * `permission.assert({action:"question"})` before asking, and its `build` and
 * `plan` agents allow it over a default ruleset that denies it (@11798370) -
 * but there is no `settings.permissions.tool.question.title` or
 * `.description` string anywhere in the archive, in any of the eighteen
 * languages, so that row is not one a reader ever sees. Adding a permission
 * kind here would demand a title this project would have to invent.
 */

/** One choice offered by a question. */
export interface QuestionOption {
  /** The reference's own annotation: "Display text (1-5 words, concise)". */
  label: string
  /** "Explanation of choice" - a second line under the label. */
  description: string
}

/**
 * One question, as the model writes it.
 *
 * `custom` is not part of what the model supplies - the tool's input schema is
 * `Prompt`, which is `{question, header, options, multiple}` - but the pending
 * request the client receives is `Info`, which adds it. Absent means true: the
 * reference's annotation is "Allow typing a custom answer (default: true)", and
 * its tool description tells the model that when custom is on a "Type your own
 * answer" option is added for it, so it should not write one itself.
 */
export interface QuestionPrompt {
  /** "Complete question" - the sentence shown above the options. */
  question: string
  /** "Very short label (max 30 chars)" - the card's heading. */
  header: string
  options: QuestionOption[]
  /** "Allow selecting multiple choices". Absent is one answer only. */
  multiple?: boolean
  custom?: boolean
}

/**
 * One question tool call, parked until the reader answers it.
 *
 * `tool` says which assistant message and which tool call raised it, so the
 * form can be drawn inside that tool card rather than as a free-floating
 * dialog. It is optional in the reference because the same service can be
 * driven by a plugin with no tool call behind it.
 */
export interface QuestionRequest {
  id: string
  sessionID: string
  questions: QuestionPrompt[]
  tool?: { messageID: string; callID: string }
}

/**
 * One question's answer: the labels chosen, or the one typed.
 *
 * An array even for a single-choice question - the reference's annotation on
 * the reply is "User answers in order of questions (each answer is an array of
 * selected labels)" - and empty when the reader skipped it, which the model is
 * told reads as "Unanswered".
 */
export type QuestionAnswer = string[]

/**
 * What a finished question tool call carries in `ToolPart.metadata`.
 *
 * The reference's renderer reads exactly this - `props.input.questions` for
 * the questions and `props.metadata.answers` for the replies - so an answered
 * card can be redrawn from the stored transcript with no live request behind
 * it.
 */
export interface QuestionMetadata {
  answers: QuestionAnswer[]
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

/**
 * Where a slash command came from, which is what the badge beside it says.
 *
 * The reference's own union, `Literals(["command","mcp","skill"])` on
 * `Command.Info` at node-BBwF64dM.js @32868194. Its composer badges only the
 * two that are not `command`: the row is drawn when
 * `cmd.type === "custom" && cmd.source !== "command"` and the label is
 * `prompt.slash.badge.skill` / `.mcp` / `.custom` (main-8t-QUXax.js @4486037),
 * so a project command shows the word "custom" and the app's own UI commands
 * show nothing at all.
 */
export const COMMAND_SOURCES = ["command", "mcp", "skill"] as const

export type CommandSource = (typeof COMMAND_SOURCES)[number]

/**
 * One command a slash can reach, from wherever it came from.
 *
 * Field for field the reference's `Command.Info` (@32868194), which its own
 * service builds by merging three sources into one map keyed by name, in this
 * order: the config's `command` record, then MCP prompts, then skills - and a
 * skill whose name is already taken is skipped, so a command wins over a skill
 * of the same name. Two differences of vocabulary, both deliberate: `model` is
 * this app's `ModelRef` rather than the reference's "provider/model" string,
 * and `agent` is the closed `AgentName` union rather than a free string,
 * because those are the shapes every other request here already speaks.
 */
export interface CommandInfo {
  /** What is typed after the slash, and the key the map is built on. */
  name: string
  description?: string
  /** Which agent to run it as, when it names one. */
  agent?: AgentName
  /** Which model to run it on, when it names one. */
  model?: ModelRef
  source: CommandSource
  /**
   * The prompt text, with its placeholders still in it.
   *
   * For a config or file command this is what was written; for an MCP prompt
   * it is the prompt's messages joined with newlines, fetched with `$1`, `$2`
   * … standing in for its declared arguments; for a skill it is the skill's
   * body followed by the two lines the reference appends naming its base
   * directory.
   */
  template: string
  /** Run it as a subagent rather than in this session. */
  subtask?: boolean
  /**
   * The placeholders the template uses, in the order to fill them.
   *
   * The reference derives this rather than storing it (`hints`, @32868000):
   * every distinct `$1`-style token sorted, then `$ARGUMENTS` last if the
   * template mentions it.
   */
  hints: string[]
}

/**
 * One command as a config document defines it.
 *
 * The reference's `ConfigCommandV1.Info` (@3080853). `variant` is its name for
 * a reasoning effort, which is why it is typed as one here.
 */
export interface CommandDefinition {
  template: string
  description?: string
  agent?: AgentName
  model?: ModelRef
  variant?: Effort
  subtask?: boolean
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * The presets a turn can run as.
 *
 * Build does the work; Plan reads and describes it without changing anything.
 */
export const AGENT_NAMES = ["build", "plan"] as const

export type AgentName = (typeof AGENT_NAMES)[number]

/**
 * The reasoning steps, in the order the cycle walks them.
 *
 * This is the reference's complete vocabulary, not a selection from it. Its
 * constants at node-BBwF64dM.js @22219232 read `WIDELY_SUPPORTED_EFFORTS =
 * ["low","medium","high"]` and `OPENAI_EFFORTS = ["none","minimal",
 * ...WIDELY_SUPPORTED_EFFORTS,"xhigh"]`, and `max` is added by the Anthropic
 * and DeepSeek-V4 arms, so seven ids exist across the whole switch. The order
 * here is theirs: ascending, with the two "barely think" levels first.
 *
 * `none` and `minimal` were dropped from this union when the per-model variant
 * table landed, on the reasoning that no request path could carry them. That
 * was wrong, and the reference's own bundled models.dev snapshot says so: the
 * `openai` provider record gives gpt-5.4, gpt-5.4-mini, gpt-5.5 and
 * gpt-5.3-codex-spark `reasoning_options: [{type:"effort", values:["none",
 * "low","medium","high","xhigh"]}]` and the three gpt-5.6 models the same list
 * plus `max` - so all seven models this app ships in its Codex catalog accept
 * `none`, and the picker was hiding a level the provider honours.
 * `minimal` belongs to the same constant and is what a bare `gpt-5` id or a
 * hand-entered one resolves to.
 *
 * The eighth id the reference can produce is `thinking`, from the MiniMax-M3
 * toggle arm. It is deliberately absent: the same function excludes every
 * `minimax` id from effort control a few lines later, so it is unreachable for
 * anything this app can talk to.
 */
export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const

export type Effort = (typeof EFFORTS)[number]

/**
 * Every bucket a tool call is judged against.
 *
 * The order is the order the settings screen draws, and it follows the
 * reference's own row order so the two screens read the same way down the page.
 * Two entries have no counterpart there: the reference judges every kind of
 * file change as one "edit", where this app separates creating a file from
 * changing one, and it has no notion of an MCP server at all.
 *
 * A name absent from here cannot be configured and cannot be refused, which is
 * how `read`, `list`, `glob`, `grep` and `todowrite` came to be beyond reach:
 * their tools each declare a bucket, and nothing had a list to match it to.
 */
export const PERMISSION_KINDS = [
  "read",
  "edit",
  "write",
  "glob",
  "grep",
  "list",
  "bash",
  "todowrite",
  "webfetch",
  "outside",
  "mcp",
] as const

export type PermissionKind = (typeof PERMISSION_KINDS)[number]

/** What a bucket does when a call lands in it. */
export const PERMISSION_ACTIONS = ["allow", "ask", "deny"] as const

export type PermissionAction = (typeof PERMISSION_ACTIONS)[number]

/**
 * What each bucket does when the user has never said.
 *
 * These are the behaviours this app already had, written down: looking at the
 * project - and keeping a todo list, which is the model talking to itself -
 * happened without asking, and everything that changed a file, ran a command or
 * reached the network asked first. Naming them here rather than leaving them
 * implicit is what lets a stored setting be told apart from an untouched one.
 */
export const DEFAULT_PERMISSIONS: Record<PermissionKind, PermissionAction> = {
  read: "allow",
  edit: "ask",
  write: "ask",
  glob: "allow",
  grep: "allow",
  list: "allow",
  bash: "ask",
  todowrite: "allow",
  webfetch: "ask",
  outside: "ask",
  mcp: "ask",
}

/**
 * Buckets whose tool puts the question itself.
 *
 * These tools know what they are about to do and can show it - the shell its
 * command, edit its diff, an MCP call its arguments - so the question they
 * raise is worth far more than a generic one in front of it. Anything not
 * listed here has no question of its own, and is asked about by
 * `Permissions.check` instead.
 */
export const SELF_ASKING_KINDS: readonly PermissionKind[] = [
  "edit",
  "write",
  "bash",
  "webfetch",
  "outside",
  "mcp",
]

/**
 * The buckets the settings screen offers a control for.
 *
 * This is deliberately a separate name from the list above rather than a use of
 * it. A control for a bucket nothing consults is exactly the defect the three
 * answers were added to remove, so the screen is only ever allowed to show what
 * some code path really reads. Every bucket is now consulted, by the tool's own
 * question or by `Permissions.check` in front of the call, so the two lists
 * agree today - but should a kind ever be declared ahead of its enforcement,
 * this is where it is kept off the screen until it means something.
 */
export const ENFORCED_KINDS: readonly PermissionKind[] = PERMISSION_KINDS

/** Kinds whose risk is what leaves the machine rather than what changes on it. */
export const NETWORK_KINDS: readonly PermissionKind[] = ["webfetch", "mcp"]

/** Kinds that can change something outside this app's own state. */
export const WRITING_KINDS: readonly PermissionKind[] = ["edit", "write", "bash", "outside"]

/**
 * How a Model Context Protocol server is reached.
 *
 * A local server is a command this app runs and talks to over its pipes; a
 * remote one is an endpoint that answers a POST. The two are one type because
 * the rest of the app only ever asks whether a server is on.
 */
export interface McpServerConfig {
  type: "local" | "remote"
  /** Local: the command and its arguments, already split. */
  command?: string[]
  /** Local: extra variables, laid over the ones this app was started with. */
  environment?: Record<string, string>
  /** Remote: where to POST, and anything the endpoint needs to let us in. */
  url?: string
  headers?: Record<string, string>
  /** Absent counts as on, so a server added by hand starts working. */
  enabled?: boolean
}

/** One checkout of a repository - what this app calls a workspace. */
/**
 * How spoken input is turned into text.
 *
 * "fast" writes down what was heard. "smart" reads it once more and tidies it -
 * false starts, filler, the punctuation nobody says out loud - which takes a
 * round trip and is why it is a choice.
 */
/** A development server answering on this machine right now. */
export interface LocalServer {
  port: number
  url: string
  /** The page's own title, when it gave one. */
  title: string
}

export type VoiceMode = "fast" | "smart"

/** Usage gathered under one heading - a day, a model, or everything. */
export interface UsageBucket {
  /** A date as YYYY-MM-DD, or a model as "provider/model". */
  key: string
  usage: Usage
  /** How many assistant turns went into it. */
  turns: number
}

export interface UsageSummary {
  total: Usage
  turns: number
  /** Oldest first, one entry per day that actually has turns in it. */
  byDay: UsageBucket[]
  /** Heaviest first. */
  byModel: UsageBucket[]
  /** How many days back the daily list was gathered over. */
  days: number
}

/** One file this app keeps, or looks for, and whether it is actually there. */
export interface AppPath {
  /** What to call it in the list. */
  name: string
  /** Absolute, because the point of the page is to be able to go and open it. */
  path: string
  exists: boolean
  /** Where it is read from: the app's own storage, or the open project. */
  scope: "app" | "project"
}

export interface AppPaths {
  /** The folder everything the app stores lives under. */
  storage: string
  files: AppPath[]
}

export interface Worktree {
  directory: string
  branch?: string
  main: boolean
}

export type McpStatus = "connected" | "pending" | "failed" | "needs_auth" | "disabled"

export interface McpServerState {
  name: string
  status: McpStatus
  /** Why it failed, in the server's own words. Shown under its name. */
  error?: string
  /** How many tools it offered, once it connected. */
  tools: number
}

/**
 * A server the user has saved, so it can be returned to by name.
 *
 * The address is the identity as far as connecting goes, but the id is what the
 * list is keyed by: an address can be edited, and a row that changed identity
 * when its address changed would lose its place and its default flag.
 */
export interface ServerEntry {
  id: string
  /** What to call it in the list. Empty means show the address instead. */
  name: string
  /** A ws:// or wss:// address. */
  url: string
}

export interface AppConfig {
  model: ModelRef
  theme: "dark" | "light" | "system"
  /* Which named palette the colours are generated from. */
  themeID: string
  /**
   * Shortcuts the user has changed, as command id to chord.
   *
   * Only what differs from the defaults is stored, so a later change to a
   * default reaches everyone who never touched that one.
   */
  keybinds: Record<string, string>
  /**
   * How many tool steps a turn may take before it has to answer in words.
   *
   * Unset means no limit, which is the reference's default (`agent.steps ??
   * Infinity`). MCode used to stop at sixty and end the turn in red, which on
   * a long refactor arrives in the middle of the work with everything the
   * model had learned thrown away.
   *
   * With a number, the step at the limit goes out with no tools and an
   * instruction to summarise instead - the reference's own behaviour, and the
   * reason its setting is described as "before forcing text-only response".
   */
  maxSteps?: number
  /**
   * A server to talk to instead of the one this app started.
   *
   * Empty means the local backend. The protocol is identical, so a remote
   * server is simply a different address for the same conversation.
   */
  serverURL: string
  /**
   * Saved servers, in the order they were added.
   *
   * Separate from serverURL, which is whichever one is connected now: a server
   * can be saved without being in use, and the one in use can be an address
   * typed once and never kept.
   */
  servers: ServerEntry[]
  /**
   * The saved server to connect to at launch, by id.
   *
   * Empty means start the local backend, which is what an app with no servers
   * saved has always done.
   */
  defaultServer: string
  /** Where to look for a newer release, if anywhere. */
  updateFeed: string
  /** Whether each notification also makes a sound. Off by default. */
  soundAgent: boolean
  soundPermission: boolean
  soundError: boolean
  /** Sessions whose tabs survive a close-others and sort to the front. */
  pinnedTabs: string[]
  /** Model Context Protocol servers, by the name they are shown under. */
  mcpServers: Record<string, McpServerConfig>
  /** UI display language. Simplified Chinese is the default. */
  /*
   * A language code the renderer offers. Kept as a plain string here so
   * that adding one to the picker does not mean editing the protocol; the
   * renderer falls back to English for anything it does not have a table
   * for, which is what would happen to an unknown code anyway.
   */
  language: string
  /**
   * What each tool bucket does: run without asking, ask, or refuse outright.
   *
   * Stored as a full map rather than a list of the approved, because a list can
   * only say yes: a name is in it or it is not, and "never do this" has nowhere
   * to live. That was the gap - a tool could be waved through or asked about,
   * and there was no way to say no.
   */
  permissions: Record<PermissionKind, PermissionAction>
  /**
   * The buckets set to allow, in the shape this setting used to have.
   *
   * Derived from `permissions` after every change and never the truth itself.
   * It is kept because a config written by an older build says what the user
   * chose in this vocabulary and has to keep meaning it, and because the title
   * bar's auto-accept toggle still speaks it.
   */
  autoApprove: PermissionKind[]
  /**
   * The map as it stood when the composer's access chip was turned to full,
   * so turning it back puts the user's own answers back rather than the
   * factory ones. Absent whenever the chip is not holding one.
   */
  accessBefore?: Partial<Record<PermissionKind, PermissionAction>>
  /** Working directory for new sessions. */
  directory: string
  /**
   * Project directories hidden from the rail. Closing a project only hides it -
   * its sessions are kept, so reopening the directory brings them all back.
   */
  closedProjects: string[]
  /**
   * Width in pixels of the docked project panel, once someone has dragged it.
   * Optional because absent has to stay distinguishable from a deliberate
   * choice: the panel then uses its own default rather than a number written
   * on first launch that would look like the user had picked it.
   */
  /** How wide the browser panel is, when it has been dragged. */
  browserWidth?: number
  sidebarWidth?: number
  /** Optional display name per project directory, keyed by absolute path. */
  projectNames: Record<string, string>
  /** Per-project badge artwork, stored as a data URL so it survives a move. */
  projectIcons: Record<string, string>
  /** Per-project badge hue override; absent means derived from the path. */
  projectColors: Record<string, string>
  /** Sampling effort a new session starts with; each may then differ. */
  effort: Effort
  /** Which agent preset new sessions start in. */
  agent: AgentName
  /**
   * Sessions with a tab in the title bar, in the order they are drawn.
   *
   * Kept in config rather than in the window, so closing the app and
   * reopening it leaves the same set of conversations to hand.
   */
  openTabs: string[]
  /** Set once the first-run setup has been completed or skipped. */
  onboarded: boolean
  /** OpenAI-compatible providers the user added by base URL. */
  customProviders: CustomProvider[]
  /**
   * Provider ids to hide, which is how the reference removes one.
   *
   * Its Settings screen never deletes a custom provider: `disconnect()` in
   * dialog-settings-r1qwJsHg.js:1223-1229 forgets the credential and then
   * appends the id to `disabled_providers`, and the config entry stays. Both
   * ends of the server honour that list by filtering rather than forgetting -
   * `isProviderAllowed` at node-BBwF64dM.js @34277010 and the provider list
   * handler @34606145 - which is also the whole reason its form's
   * "already exists" rule carries `&& !disabled`: a removed id is missing from
   * the list, so re-adding it is allowed, and re-adding under the same id is
   * the only way the reference offers to edit one (there is no edit form).
   *
   * The name is `disabled_providers` there and `disabledProviders` here for
   * the same reason every other field on this document is camelCase.
   */
  disabledProviders: string[]
  /** Base-URL overrides for built-in providers, keyed by provider id. */
  providerEndpoints: Record<string, string>
  /**
   * Commands a slash can reach, keyed by the name typed after the slash.
   *
   * The reference's config key is `command` (singular) and its entry schema is
   * `ConfigCommandV1.Info` at node-BBwF64dM.js @3080853 - template, and
   * optional description/agent/model/variant/subtask. It also reads the same
   * shape out of every markdown file under a `command` or `commands` folder in
   * each config directory, with the frontmatter as the entry and the body as
   * the template (@3239000), so a project can carry its commands in files
   * instead of in the document.
   */
  commands: Record<string, CommandDefinition>
  /**
   * "provider/model" keys shown in the composer picker. Empty means the user
   * has not curated the list yet, and every connected model is offered.
   */
  enabledModels: string[]
  /** Show the model's summarized reasoning in the stream. */
  showReasoning: boolean
  /** Start shell tool calls expanded in the transcript. */
  expandShell: boolean
  /** Start edit, write and patch tool calls expanded in the transcript. */
  expandEdits: boolean
  /*
   * What the title bar carries besides the review toggle.
   *
   * opencode keeps its bar to one control and puts these two behind settings
   * that ship off, which is why a bar with three buttons on it did not look
   * like the same application.
   */
  showServerButton: boolean
  showPaletteButton: boolean

  /*
   * Type. Empty means the built-in stack, which is what almost everyone wants;
   * the override exists because a person who has chosen a face to read code in
   * has usually chosen it for a reason.
   */
  uiFont: string
  codeFont: string
  terminalFont: string

  /**
   * Standing instructions from the user, added to every session's prompt.
   *
   * A project's own AGENTS.md says how that project is written; this says how
   * this person wants to be worked with, wherever they are working. Kept
   * separate from the project files for exactly that reason - one travels with
   * the repository and the other travels with the reader.
   */
  instructions: string
  /** How spoken input is written down. */
  voiceMode: VoiceMode
  /**
   * Whether saying "send" at the end of a recording sends the message.
   *
   * Off by default, which is what the reference does - a word that submits
   * whatever is in the box is not something to turn on for someone.
   */
  voiceSend: boolean
  /** Whether the app reads short progress lines aloud. */
  voiceFeedback: boolean
  /**
   * Which model writes the speech down.
   *
   * Absent means the feature is not set up: the window says so rather than
   * recording into nothing. It is kept apart from the chat model because a
   * provider that is good at one is not necessarily offering the other.
   */
  voiceModel?: ModelRef
  /**
   * Whether the app keeps an icon in the system tray.
   *
   * On by default, which is what the reference does. Closing the window still
   * closes it - a tray icon is a way back to a running app, not a trapdoor
   * that makes the close button mean something else.
   */
  tray: boolean
  /** Whether text is drawn with the lighter antialiasing or the system's own. */
  fontSmoothing: boolean
  /**
   * Which of the app's colourways the icon wears.
   *
   * An id rather than a path: the artwork is the app's own and ships with it,
   * and a path in the config document would be a way to point the window at a
   * file that is not there.
   */
  appIcon: string
  /** Whether pointing at something pressable turns the cursor into a hand. */
  pointerCursor: boolean
  /**
   * Whether the interface animates.
   *
   * Three states rather than two, because "follow the machine" is a different
   * answer from "no": a reader who has asked the OS for less motion should get
   * less of it here without having to say so twice, and a reader who wants the
   * transitions back should be able to keep them even so.
   */
  reduceMotion: "system" | "on" | "off"
  /**
   * How a diff says which lines changed: by the ground under them, or by a
   * sign at the head of each one.
   *
   * Ground alone fails a reader who cannot separate the two hues; signs alone
   * survive a screenshot in greyscale. Neither is right for everyone, so it is
   * asked rather than assumed.
   */
  diffMarks: "color" | "signs"
  /** Whether a long line in code or a diff folds rather than scrolling away. */
  wrapCode: boolean

  /** Desktop notifications, by occasion. */
  notifyAgent: boolean
  notifyPermission: boolean
  notifyError: boolean

  /** Whether pinch and Ctrl+wheel resize the interface. */
  pinchZoom: boolean

  /**
   * Whether a new version says what changed in it.
   *
   * opencode's `releaseNotes`, and on by default the way its own
   * `defaultSettings` has it. Its string: "Show What's New popups after
   * updates".
   */
  releaseNotes: boolean
  /**
   * One-time migrations already applied to this document, by name.
   *
   * A migration that just overwrote the value every load would make the setting
   * unchangeable; one with no record at all would run again on the next launch
   * and undo a deliberate choice made in between. The name goes in here the
   * first time it runs and the migration never looks at that field again.
   */
  migrations: string[]

  /** Whether a session offers the review panel at all. */
  showFileTree: boolean
  /**
   * Two title-bar controls kept behind a setting.
   *
   * `showNavigation` stays false, which is opencode's own default
   * (`defaultSettings` at main-8t-QUXax.js @1901464 has both false): the back
   * and forward arrows are already at the top of the side column.
   *
   * `showTerminal` is now true. The reference this app follows for 2.0 keeps a
   * bottom-panel toggle in the bar at all times, and the drawer is otherwise
   * reachable only by a chord nobody is told about. The setting stays, so a
   * reader who wants the bar emptier can have that.
   */
  showNavigation: boolean
  showTerminal: boolean
  /** Whether the composer offers the agent switcher. */
  showAgentPicker: boolean

  /**
   * The shell the terminal opens and the bash tool runs in.
   *
   * Empty means whatever the system says; naming one is how someone whose
   * login shell differs from their working shell gets the working one.
   */
  shell: string
}

/** One hand-typed model on a custom provider: an id to send, a name to show. */
export interface CustomModel {
  id: string
  name: string
}

export interface CustomProvider {
  /**
   * Chosen by the user, not derived from the name.
   *
   * The reference asks for this outright and validates it against
   * /^[a-z0-9][a-z0-9-_]*$/. It matters because `provider/model` refs, the
   * enabled-model list and the stored credential are all keyed by it, so an id
   * that moves when the display name is edited takes all three with it.
   */
  id: string
  name: string
  baseURL: string
  /**
   * Extra request headers, sent with every call to this provider.
   *
   * This is the only way to reach a gateway that authenticates with anything
   * other than a bearer token - `x-api-key`, Azure's `api-key`, a routing
   * header - which is why the reference collects them as free key/value pairs
   * rather than offering a fixed set.
   */
  headers?: Record<string, string>
  /**
   * The models this provider serves, typed in by hand.
   *
   * The reference never probes /models for a custom provider and requires at
   * least one entry here, because plenty of OpenAI-compatible endpoints have no
   * such route and the alternative is a provider that connects and then offers
   * nothing to talk to.
   */
  models?: CustomModel[]
  /**
   * The environment variable holding this provider's key, when `{env:VAR}` was
   * typed into the key field instead of a key.
   *
   * The point is that no secret is written to disk: the config names a variable
   * and the value is read from the process at the moment it is needed.
   */
  environment?: string
}

/**
 * "local" is a runtime on this machine - Ollama and friends bind to loopback
 * and authenticate nobody, so asking for a key would be theatre.
 */
export type AuthMethodKind = "api-key" | "oauth-browser" | "oauth-headless" | "local"

export interface ProviderStatus {
  id: string
  name: string
  kind: "anthropic" | "openai-compatible" | "chatgpt"
  /** i18n key, resolved in the renderer. */
  description: string
  recommended: boolean
  /** Explicit picker position; lower sorts first. */
  order: number
  /** Entries sharing a group are one provider with several ways to connect. */
  group?: string
  groupName?: string
  /** i18n key naming this connection mode within its group. */
  modeLabel?: string
  custom: boolean
  /** The endpoint in force, with any override already applied. */
  baseURL?: string
  keyURL?: string
  configured: boolean
  /** Signed in through OAuth, as opposed to holding a pasted key. */
  authenticated: boolean
  /**
   * The environment variable connecting this provider, when the app itself
   * holds no key for it. Set means there is nothing here to disconnect: the
   * variable is what makes the provider available, and only the user's shell
   * can take it away.
   */
  environment?: string
  /** Ways this entry can be connected; empty means an API key. */
  authMethods: AuthMethodKind[]
  models: ModelInfo[]
}

/** Which kinds of content a model will accept as input. */
export interface ModelModalities {
  text: boolean
  image: boolean
  audio: boolean
  video: boolean
  pdf: boolean
}

/**
 * What is known about one model, as the window sees it.
 *
 * The field names follow the reference's own `ProviderCapabilities` record
 * rather than being renamed, so a reader comparing the two is comparing like
 * with like. Two of them are carried without being read anywhere yet -
 * `toolCall` and `temperature` - which is also true in the reference: it puts
 * both on the wire and gates only one request field, `temperature`, on a
 * parameter this app does not send at all. They are here so the record is
 * complete rather than because something consults them today.
 */
export interface ModelInfo {
  id: string
  name: string
  /** Tokens the model will read in one turn. Zero means unknown. */
  contextWindow: number
  /** Tokens the model will write in one turn. Zero means unknown. */
  maxOutput: number
  reasoning: boolean
  attachment: boolean
  toolCall: boolean
  temperature: boolean
  inputs: ModelModalities
  /** USD per million tokens. Zero means unknown, and the readout hides it. */
  cost: { input: number; output: number }
  /**
   * The reasoning efforts THIS model accepts, in the order to offer them.
   *
   * Empty is the meaningful case: it says the model has no reasoning control,
   * and the reference draws no effort pill at all for such a model rather than
   * drawing one whose every setting the provider will ignore. A non-empty list
   * is not `EFFORTS` filtered down by taste - it is what the reference's own
   * per-family rules say the model will honour, so GPT-5-Pro really does offer
   * exactly one level and Claude 4.6 really does lack `xhigh`.
   */
  variants: Effort[]
}

// ---------------------------------------------------------------------------
// Requests (renderer -> server)
// ---------------------------------------------------------------------------

export type Request =
  | { type: "session.list" }
  /* Every file every stored session has written, for the artifacts page. */
  | { type: "artifact.list" }
  | { type: "session.create"; directory?: string; title?: string }
  | { type: "session.get"; sessionID: string }
  /**
   * The instructions the model is given ahead of the conversation.
   *
   * Built in the server from the session's directory and agent, so the window
   * has no way to work it out for itself - and without it the Context view can
   * neither show the prompt nor account for the tokens it costs.
   */
  | { type: "session.systemPrompt"; sessionID: string }
  /**
   * Moves the conversation's rollback boundary.
   *
   * `messageID` is the first message to roll back; leaving it out restores
   * everything that was rolled back. Both directions move the project's files
   * as well as the transcript, so this is one request rather than two.
   */
  | { type: "session.revert"; sessionID: string; messageID?: string }
  | { type: "session.delete"; sessionID: string }
  | { type: "session.compact"; sessionID: string }
  | { type: "session.undo"; sessionID: string }
  | { type: "session.redo"; sessionID: string }
  | { type: "session.history"; sessionID: string }
  | { type: "session.agent"; sessionID: string; agent: AgentName }
  | { type: "session.archive"; sessionID: string; archived: boolean }
  | { type: "session.rename"; sessionID: string; title: string }
  /* Which project a conversation belongs to, which is the directory it works in. */
  | { type: "session.move"; sessionID: string; directory: string }
  | { type: "session.fork"; sessionID: string; messageID: string }
  | { type: "session.model"; sessionID: string; model: ModelRef }
  | { type: "session.effort"; sessionID: string; effort?: Effort }
  | { type: "session.prompt"; sessionID: string; text: string; attachments?: Attachment[] }
  | { type: "session.abort"; sessionID: string }
  | { type: "permission.respond"; requestID: string; response: PermissionResponse }
  /**
   * The questions parked on an answer, across every session.
   *
   * The same replay `session.list` does for permissions, and for the same
   * reason: `question.asked` goes out once, so a window that reloaded, or one
   * opened afterwards, has no other way to learn that a turn is waiting.
   * The reference's counterpart is `GET /question`, annotated "Get all pending
   * question requests across all sessions."
   */
  | { type: "question.list" }
  /**
   * Answers one parked question tool call, which lets its turn continue.
   *
   * One entry per question, in the order they were asked; an empty array is a
   * question the reader skipped. The reference is
   * `POST /question/:requestID/reply`.
   */
  | { type: "question.reply"; requestID: string; answers: QuestionAnswer[] }
  /**
   * Dismisses one without answering. The tool fails with "The user dismissed
   * this question" rather than hanging - the reference's `RejectedError`.
   */
  | { type: "question.reject"; requestID: string }
  /**
   * The commands a slash can reach in this project.
   *
   * Directory-scoped because that is what decides them: the project's own
   * command files sit under it, and its MCP servers and skills are reached
   * from it. The reference scopes the same list per instance, one instance
   * being one worktree.
   */
  | { type: "command.list"; directory: string }
  | { type: "config.get" }
  | { type: "config.set"; patch: Partial<AppConfig> }
  | { type: "provider.list" }
  | { type: "provider.auth"; provider: string; apiKey: string }
  /** Re-reads the provider's model list. OpenAI-compatible providers only. */
  | { type: "provider.discover"; provider: string }
  /**
   * Adds an OpenAI-compatible provider by base URL.
   *
   * `id` is the user's, not a slug of `name`; `models` is mandatory and
   * non-empty because nothing discovers them for a custom provider; and
   * `apiKey` may be the literal `{env:VAR}`, which stores the variable's name
   * in the config and no secret anywhere.
   */
  | {
      type: "provider.addCustom"
      id: string
      name: string
      baseURL: string
      apiKey: string
      headers?: Record<string, string>
      models: CustomModel[]
    }
  | { type: "provider.removeCustom"; provider: string }
  | { type: "auth.begin"; provider: string; method: AuthMethodKind }
  | { type: "auth.cancel"; provider: string }
  | { type: "auth.signOut"; provider: string }
  | { type: "workspace.info"; directory: string }
  | { type: "app.reset" }
  /* "branch" widens the review past the working tree to the whole branch. */
  | { type: "app.paths"; directory?: string }
  | { type: "usage.summary"; days?: number }
  | { type: "local.servers" }
  | {
      type: "voice.transcribe"
      /** The recording, base64. Kept small by the window: it stops at a minute. */
      audio: string
      mime: string
      /** Overrides the configured mode for this one recording. */
      mode?: VoiceMode
      /** What the window is showing, so the considered mode can say it better. */
      language?: string
    }
  | { type: "git.status"; directory: string; scope?: "worktree" | "branch" }
  | { type: "git.init"; directory: string }
  /*
   * `context` is how many unchanged lines to keep either side of a change.
   * A very large number is how "show the whole file" is asked for, which is
   * the same request git already answers - there is no second endpoint.
   */
  | {
      type: "git.diff"
      directory: string
      file: string
      context?: number
      scope?: "worktree" | "branch"
    }
  | { type: "git.revert"; directory: string; file: string }
  | { type: "file.list"; directory: string; query?: string }
  | { type: "file.read"; path: string }
  | { type: "shell.open"; sessionID: string; cwd?: string; cols?: number; rows?: number }
  | { type: "shell.input"; shellID: string; data: string }
  | { type: "shell.resize"; shellID: string; cols: number; rows: number }
  | { type: "shell.close"; shellID: string }
  /**
   * The shells this session already has running, so the drawer can come back
   * to them instead of starting new ones.
   */
  | { type: "shell.list"; sessionID: string }
  /** Everything a shell has printed so far, to redraw a pane that went away. */
  | { type: "shell.attach"; shellID: string }
  | { type: "workspace.list"; directory: string }
  | { type: "workspace.create"; directory: string; name: string }
  | { type: "workspace.remove"; directory: string; target: string }
  | { type: "mcp.list" }
  | { type: "mcp.toggle"; name: string }

export type RequestType = Request["type"]
export type RequestOf<T extends RequestType> = Extract<Request, { type: T }>

// ---------------------------------------------------------------------------
// Responses (server -> renderer, correlated by request id)
// ---------------------------------------------------------------------------

export interface FileEntry {
  path: string
  name: string
  directory: boolean
}

export interface ResponseMap {
  /**
   * `running` names the sessions mid-turn, which a reconnecting client cannot
   * know.
   *
   * `permissions` is the same idea for the dialogs: a tool that asked while
   * nobody was listening is still parked on its answer, and the request was
   * only ever announced once, as an event. A window that reloads, or one that
   * opens after the question was asked, has no other way to learn about it -
   * and until it is answered the turn cannot move.
   */
  "session.list": {
    sessions: SessionInfo[]
    running: string[]
    /** Sessions being summarised, so a window that reconnects mid-summary is right. */
    compacting: string[]
    permissions: PermissionRequest[]
  }
  "artifact.list": { artifacts: SessionArtifacts[] }
  "session.create": { session: SessionInfo }
  "session.get": { session: SessionInfo; messages: Message[] }
  "session.systemPrompt": { prompt: string }
  /**
   * `files` is how many the project was actually put back to - the number the
   * interface may repeat. It counts the files touched by moving the boundary,
   * in either direction, and is zero when the rolled back turns changed none.
   */
  "session.revert": { session: SessionInfo; files: number; history: HistoryDepth }
  "session.agent": { session: SessionInfo }
  "session.delete": Record<string, never>
  "session.compact": { session: SessionInfo }
  "session.undo": { files: number; history: HistoryDepth }
  "session.redo": { files: number; history: HistoryDepth }
  "session.history": { history: HistoryDepth }
  "session.archive": { session: SessionInfo }
  "session.rename": { session: SessionInfo }
  "session.move": { session: SessionInfo }
  "session.fork": { session: SessionInfo }
  "session.model": { session: SessionInfo }
  "session.effort": { session: SessionInfo }
  "session.prompt": { messageID: string }
  "session.abort": Record<string, never>
  "permission.respond": Record<string, never>
  "question.list": { questions: QuestionRequest[] }
  "question.reply": Record<string, never>
  "question.reject": Record<string, never>
  "command.list": { commands: CommandInfo[] }
  "config.get": { config: AppConfig }
  "config.set": { config: AppConfig }
  "provider.list": { providers: ProviderStatus[] }
  "provider.auth": { providers: ProviderStatus[]; models: number }
  "provider.discover": { providers: ProviderStatus[]; count: number }
  "provider.addCustom": { providers: ProviderStatus[] }
  "provider.removeCustom": { providers: ProviderStatus[] }
  /**
   * Where to send the user, plus the short code to type when the flow is the
   * device kind. Either way the outcome arrives later as an auth event.
   */
  "auth.begin": { url: string; userCode?: string }
  "auth.cancel": Record<string, never>
  "auth.signOut": { providers: ProviderStatus[] }
  /** Facts about a session's directory; absent fields are simply unknown. */
  "workspace.info": { exists: boolean; branch?: string; modified?: number }
  /** Everything is gone; the renderer reloads into onboarding. */
  "app.reset": { config: AppConfig; providers: ProviderStatus[] }
  "git.status": GitStatus
  "git.init": GitStatus
  "git.diff": { patch: string }
  "git.revert": GitStatus
  "file.list": { files: FileEntry[] }
  /**
   * One file, ready to show.
   *
   * `kind` decides which of the four the reader gets, the way opencode splits
   * a preview: text carries `content`, an image or a sound carries `mime` and
   * `data`, and a binary carries neither - there is nothing to show it as, and
   * reading it would only spend the memory to say so.
   *
   * `data` is bare base64, not a data URL, because that is what an attachment
   * already is on this side and the one place that renders one prefixes it
   * itself.
   */
  "file.read": {
    path: string
    kind: "text" | "image" | "audio" | "binary"
    content: string
    truncated: boolean
    mime?: string
    data?: string
  }
  "shell.open": { shellID: string }
  "shell.input": Record<string, never>
  "shell.resize": Record<string, never>
  "shell.close": Record<string, never>
  "shell.list": { shells: ShellSummary[] }
  "shell.attach": { data: string; alive: boolean }
  "app.paths": { paths: AppPaths }
  "usage.summary": { summary: UsageSummary }
  "local.servers": { servers: LocalServer[] }
  "voice.transcribe": { text: string; heard: string }
  "workspace.list": { worktrees: Worktree[] }
  "workspace.create": { directory: string; branch: string }
  "workspace.remove": Record<string, never>
  "mcp.list": { servers: McpServerState[] }
  "mcp.toggle": { servers: McpServerState[] }
}

// ---------------------------------------------------------------------------
// Events (server -> renderer, unsolicited)
// ---------------------------------------------------------------------------

export type ServerEvent =
  | { type: "session.updated"; session: SessionInfo }
  | { type: "session.deleted"; sessionID: string }
  | { type: "session.idle"; sessionID: string }
  /**
   * A compaction is running for this session.
   *
   * Sent because an automatic one can take minutes on a long
   * conversation - five, measured on a 230k transcript against a local
   * model - and the last thing on screen before it starts is the
   * provider's refusal, in red. Without this the app looks like it gave
   * up, which is how the first working version of the rescue was read.
   */
  | { type: "session.compacting"; sessionID: string; active: boolean }
  | { type: "session.error"; sessionID: string; error: string }
  | { type: "message.updated"; message: Message }
  /**
   * Messages have left the transcript for good.
   *
   * Sent when a session that had been rolled back is prompted again: the
   * rolled back messages are dropped at that point, because the conversation
   * has taken a different turning and there is no longer anything to put back.
   * Nothing else removes a message, so this is the one event that means the
   * transcript a window is holding is longer than the one on disk.
   */
  | { type: "session.reverted"; sessionID: string }
  /** Incremental append to a part already announced via message.updated. */
  | { type: "message.delta"; sessionID: string; messageID: string; partID: string; text: string }
  | { type: "permission.requested"; request: PermissionRequest }
  | { type: "permission.resolved"; requestID: string }
  /**
   * A question tool call is waiting on the reader.
   *
   * The reference's `question.asked` carries the request's own fields rather
   * than nesting them (`define({type:"question.asked", schema: Request.fields})`
   * @22136338); this app nests, the way `permission.requested` beside it does,
   * because every event here is read through one `event.request` accessor.
   */
  | { type: "question.asked"; request: QuestionRequest }
  /**
   * It has been answered - by this window or another one. The answers ride
   * along so a second window can draw the finished card without refetching.
   */
  | { type: "question.replied"; sessionID: string; requestID: string; answers: QuestionAnswer[] }
  /** It was dismissed, and the tool call it belonged to has failed. */
  | { type: "question.rejected"; sessionID: string; requestID: string }
  | { type: "shell.data"; shellID: string; data: string }
  | { type: "shell.exit"; shellID: string; code: number | null }
  | { type: "config.updated"; config: AppConfig }
  | { type: "mcp.status"; servers: McpServerState[] }
  /** A subscription login finished in the browser, minutes after it began. */
  | { type: "auth.completed"; provider: string; providers: ProviderStatus[] }
  | { type: "auth.failed"; provider: string; message: string }

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

export interface RequestEnvelope {
  kind: "request"
  id: string
  request: Request
}

export type ResponseEnvelope =
  | { kind: "response"; id: string; ok: true; data: unknown }
  | { kind: "response"; id: string; ok: false; error: string }

export interface EventEnvelope {
  kind: "event"
  event: ServerEvent
}

export type ClientFrame = RequestEnvelope
export type ServerFrame = ResponseEnvelope | EventEnvelope
