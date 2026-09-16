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
  /**
   * Where the title came from: the first prompt's fallback, the model's
   * generated title, or the user's own rename. MiMo generates once, only over
   * the fallback, so a rename is never replaced. Absent on sessions stored
   * before this existed, which are treated as already named.
   */
  titleSource?: "fallback" | "generated" | "user"
  /** MiMo's `auto_worktree_hint_sent`: the one note about changing a repository's main worktree has gone to the model. */
  worktreeNotice?: boolean
  /** Absolute path of the project directory this session operates in. */
  directory: string
  model: ModelRef
  agent: AgentName
  /**
   * plan: two words fixed when the conversation is made, which name its plan
   * file (`<created>-<slug>.md`) as MiMo's session slug names its own.
   * Conversations stored before this have none and fall back to their id.
   */
  slug?: string
  /**
   * Whether this conversation works in stages: clarify, plan, build, review.
   *
   * Absent is off, which is what every conversation stored before this field
   * existed has to read as.
   */
  staged?: boolean
  /**
   * On Smart: the first message picks between the fast and the main model, and
   * `model` then holds the one it picked.
   */
  smart?: boolean
  /** Which of the two Smart picked; absent until the first message. */
  smartRoute?: "fast" | "main"
  /**
   * Started with no project: its directory is a folder made for it alone.
   *
   * The side column lists these under Recent rather than as projects, since
   * a folder nobody chose is not something anyone would go back to by name.
   */
  scratch?: boolean
  /**
   * Which project the side column files this conversation under, when that is
   * not the folder it works in - MiMo's `groupProject`.
   *
   * 移动至项目 only changes where a conversation is listed. Its working
   * directory, and with it the commands, the relative paths and the
   * per-project approvals, stay exactly where they were. An empty string is
   * MiMo's "moved out": listed under no project at all. Absent - every
   * conversation stored before this field - is filed by `directory`, which is
   * what those conversations have always done.
   */
  group?: string
  /**
   * A side chat, and the conversation it was opened beside.
   *
   * A side chat is a conversation of its own, in the same project, that no
   * list shows: it lives in the side column of the conversation it belongs to.
   */
  sideOf?: string
  /** The conversation this one was branched from, for the marker at its top. */
  forkOf?: string
  /**
   * This conversation's own access level, as MiMo keeps one per conversation.
   * Absent follows the app's default level.
   */
  access?: "ask" | "auto" | "full"
  /*
   * subagents: a subagent's own conversation, and where in its parent it was
   * started - the parent conversation, the assistant message and the task call.
   * No list shows one; it is reached from the parent's 子智能体 tab.
   */
  parentID?: string
  parentMessageID?: string
  parentCallID?: string
  /** subagents: its kind and its numbered name within the parent (`general-1`), which picks its avatar, and where it stands. */
  subagent?: SubagentState
  /** tasks: the task tool's registry for this conversation, shared with its subagents; the info card's 任务清单. */
  tasks?: TaskItem[]
  created: number
  updated: number
  /** Rolling totals across every assistant turn in the session. */
  usage: Usage
  /** Put away rather than deleted: hidden everywhere, restorable from settings. */
  archived?: boolean
  /** When it was put away (ms), so the archived list reads newest-archived first as MiMo's does. */
  archivedAt?: number
  /**
   * Where the conversation was summarised, if it has been.
   *
   * Everything up to and including `messageID` is sent to the model as
   * `summary` instead of verbatim. The messages themselves are kept: the point
   * is to shrink the context, not to lose the history. `trigger` is what set it
   * off, MiMo's label, and `files` the files the summarised part worked on,
   * each with what happened to it, which the next request lists.
   */
  compacted?: {
    messageID: string
    summary: string
    at: number
    trigger?: "manual" | "automatic" | "provider-overflow"
    files?: string[]
  }
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
  /** session chat: what this conversation is for, as a tool recorded it for other conversations to read. */
  chat?: { purpose?: string; task?: string; taskStatus?: ChatTaskStatus }
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
  /**
   * Tool-specific structured payload the UI renders richly (diffs, matches).
   *
   * Two keys are the runner's rather than the tool's: `recoverable: true` on an
   * error part marks a call refused before it ran because its arguments did not
   * fit the schema (drawn as skipped), and `permissions` holds the
   * `PermissionRecord`s the call's questions were answered with, so the
   * transcript can redraw them after a reload.
   */
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
  /** Anthropic's signature over the thinking, kept so the block can be sent back to the same model, as MiMo keeps it. */
  signature?: string
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

/** Where a search found its words inside one conversation, as the overlay draws it. */
export interface MessageHit {
  sessionID: string
  messageID: string
  /** A single line around the words, with ellipses where it was cut. */
  text: string
  /** Where the words sit inside `text`. */
  ranges: { start: number; end: number }[]
}

/** What one stored session produced, newest file first. */
export interface SessionArtifacts {
  sessionID: string
  title: string
  directory: string
  updated: number
  files: ArtifactFile[]
}

import type { FileNotice } from "./file-notices"

export interface UserMessage {
  id: string
  sessionID: string
  role: "user"
  text: string
  /** Files pinned into the prompt by the user. */
  attachments: Attachment[]
  time: { created: number }
  /** Sent into a turn that was already running (MiMo's 插话), so the transcript keeps it inside that turn. */
  steered?: boolean
  /**
   * plan: written by the app rather than typed - the word that the user
   * approved a plan, put where the user's next message would be. The model
   * reads it; the transcript leaves it out, as MiMo leaves out the synthetic
   * message its plan_exit writes.
   */
  synthetic?: boolean
  /** Places the user pointed at with this message (MiMo's 注释); the model reads them after the text. */
  annotations?: Annotation[]
  /** Documents the user changed since the last message; the model reads them before the text, the transcript does not show them. */
  fileNotices?: FileNotice[]
  /**
   * skills: written by the runner, never drawn - the skills this message named
   * with `/name`, and the hint an attached office document brings. The model
   * reads them after the text.
   */
  reminders?: string[]
  /**
   * Notes the runner attached when the message was sent - MiMo's runtime
   * context: the reply language, the working directory and, on a
   * conversation's first message, what this app offers; also where attached
   * files are, and the one note about changing a repository's main worktree.
   * The model reads each in a system-reminder before everything else; the
   * transcript does not show them.
   */
  context?: string[]
  /**
   * subagents: written by the runner, not the user - what became of background
   * subagents. `text` is what the model reads; the transcript draws pills.
   */
  notices?: SubagentNotice[]
  /**
   * Who sent this message when it was not typed: the parent of a subagent
   * (`from: "main"`, drawn under 来自 {source} 的消息), or - session chat - another
   * conversation, named by its title, with its id and whether it asks or answers.
   */
  inbox?: MessageSource
}

export interface MessageSource {
  from: string
  /** session chat: the conversation that sent it. */
  sessionID?: string
  /** session chat: a message to handle, or the reply to one this conversation sent. */
  direction?: "request" | "reply"
  /** automation: sent by this scheduled task's run; `from` is the task's title. */
  automationID?: string
}

/* session chat: the task statuses a conversation's record can hold, as MiMo's update_session takes them. */
export const CHAT_TASK_STATUSES = ["idle", "working", "blocked", "done"] as const
export type ChatTaskStatus = (typeof CHAT_TASK_STATUSES)[number]

/**
 * session chat: one message between two conversations, from one side's view.
 *
 * Outbound is the caller waiting on a reply; inbound is the target handling a
 * message (`kind: "request"`) or the caller handling the reply that came back
 * (`kind: "reply"`). A queued one waits behind `queueAhead` others for its
 * target. `peerID` is null once the other conversation is gone.
 */
export interface ChatLink {
  peerID: string | null
  peerTitle: string
  direction: "outbound" | "inbound"
  kind: "request" | "reply"
  phase: "running" | "queued"
  queueAhead: number
}

/** subagents: what a background subagent's parent is told, in MiMo's five outcomes. */
export type SubagentNoticeStatus = "completed" | "failed" | "cancelled" | "stalled" | "ended"

export interface SubagentNotice {
  /** The numbered name the model uses (`explore-1`). */
  subagentID: string
  sessionID: string
  description: string
  status: SubagentNoticeStatus
  /** The first line of its answer or its error, shown as the pill's title. */
  summary?: string
  /** For a stall: how many seconds nothing has happened in it. */
  quietSeconds?: number
}

/**
 * subagents: a subagent's own record. `status` is running while a turn of it
 * is under way and idle between turns; `outcome` is how its last turn ended.
 * Sessions stored before background subagents carry only `type` and `id`.
 */
export interface SubagentState {
  type: SubagentType
  id: string
  /** Started with spawn, so it works on after the parent's turn and reports back. */
  background?: boolean
  status?: "running" | "idle"
  outcome?: "success" | "failure" | "cancelled"
  error?: string
  /** Turns taken, counting each follow-up sent to it. */
  turns?: number
  /** When its last turn ended. */
  ended?: number
  /** The task registry's task it was started for, when the id named one. */
  taskID?: string
  /** The slash command that started it. */
  command?: string
  /** The JSON Schema its result has to match (MiMo's output_schema). */
  outputSchema?: Record<string, unknown>
}

/** tasks: MiMo's five task statuses. */
export const TASK_STATUSES = ["open", "in_progress", "blocked", "done", "abandoned"] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

/** tasks: one entry of a conversation's task registry. */
export interface TaskItem {
  /** T1, T2 at the top; T1.1 under T1. */
  id: string
  summary: string
  status: TaskStatus
  parentID?: string
  /** Who last took it on: `main`, or a subagent's name. */
  owner?: string
  created: number
  updated: number
  /** When it was done or abandoned. */
  ended?: number
  /** The latest note given with a change. */
  note?: string
}

/** One place the user pointed at: a passage of a reply, code in the files tab, or a whole file. */
export interface Annotation {
  id: string
  kind: "answer" | "code" | "file" | "pdf" | "docx" | "pptx" | "xlsx" | "chart" | "html" | "video"
  /** The file's absolute path, for a file or code shown from one. */
  path?: string
  /** A PDF or Word selection's page, from 1. */
  page?: number
  /** A slide's index from 0, with its p:sldId id and the shape whose text the selection matched. */
  slide?: number
  slideId?: string
  shapeId?: string
  shapeName?: string
  /** Where on the slide, as fractions of its box: left, top, width, height. */
  region?: { fx: number; fy: number; fw: number; fh: number }
  /** Drawn as a box on the slide rather than a picked piece. */
  boxed?: boolean
  /** A spreadsheet's sheet by name and id, and the cell or range as A1 (for a chart, the sheet it sits on). */
  sheet?: string
  sheetId?: string
  a1?: string
  /** A chart's title, kind and the cell references its data comes from. */
  chartTitle?: string
  chartKind?: string
  dataRef?: string
  /** A video frame: the moment, in seconds, whose region was boxed. */
  timeSec?: number
  /** A web page module: the CSS selector that finds it and its tag. */
  selector?: string
  tag?: string
  /** Where the selection sits: PDF points from a PDF page's bottom-left corner, or CSS pixels from a Word page's top-left. */
  rect?: { x: number; y: number; w: number; h: number; pageW: number; pageH: number }
  /** The file's name, for a whole file. */
  name?: string
  /** The selected text, whitespace folded; absent for a whole file. */
  quote?: string
  /** Which occurrence of the quote in its block was selected, and how many there are. */
  occ?: number
  occTotal?: number
  /** What the user wrote about it; empty when it is only pointed at. */
  text: string
}

export interface Attachment {
  path: string
  mime: string
  /** base64 for binary, utf8 text otherwise; empty for a file attached by path. */
  data: string
  /**
   * MiMo attaches a file by its path: nothing is copied into the message, and
   * the file is read from disk each time a request is built, so a file of any
   * size can be attached. `path` is absolute, or project-relative for an @
   * mention; the server fills in `mime` when the message is sent.
   */
  byPath?: boolean
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
  /**
   * The file changes of the turn this message ends were taken back out of the
   * project with the card's 撤销. The transcript stays; only the files moved.
   */
  reverted?: boolean
  /**
   * Set while the provider request is being tried again (MiMo's 正在重新连接).
   *
   * Only ever on the copy published with `message.updated`, never written to
   * disk: the next update for the message comes without it, which is how the
   * row goes away once the stream resumes.
   */
  retry?: {
    attempt: number
    message: string
    next: number
    /** MiMo's kind of failure (stream, network, rate_limit, server) and the attempts it allows, 0 when it waits indefinitely. */
    kind?: string
    max?: number
  }
  time: { created: number; completed?: number }
}

/** A project's local branches, for the home screen's branch chip. */
export interface BranchState {
  repo: boolean
  /** On a detached HEAD, or a repository with no commit yet: no branch to show. */
  detached: boolean
  branch?: string
  branches: string[]
}

/** How a branch switch or creation went. */
export interface CheckoutResult {
  ok: boolean
  branch?: string
  /** Refused because the working tree has uncommitted changes; ask before forcing. */
  dirty?: boolean
  /** Forced across uncommitted changes, which left conflict markers. */
  conflicts?: boolean
  code?: "untracked-overwrite" | "local-overwrite" | "branch-exists" | "branch-invalid"
  error?: string
  /** The branch is checked out in this other worktree instead. */
  worktree?: { directory: string; name: string }
}

/** One changed file's line counts. */
export interface GitFileLines {
  path: string
  additions: number
  deletions: number
}

/** The info card's 环境信息: the project's changes against HEAD, counted in lines. */
export interface GitSummary {
  /** False outside a repository, or without git: the section is not drawn. */
  repo: boolean
  /** False when the repository was found but its changes could not be read. */
  ok: boolean
  branch?: string
  detached: boolean
  fileCount: number
  additions: number
  deletions: number
  /** Per file, relative to the project directory; untracked files count as wholly added. */
  files: GitFileLines[]
  /** Origin (or upstream) is a GitHub repository: the section ends with the pull-request row. */
  github?: boolean
}

/** MiMo's pull-request row: the branch's newest pull request on GitHub, or why there is none to show. */
export type PullRequestState =
  | { ok: true; kind: "none" }
  | { ok: true; kind: "open" | "draft" | "closed" | "merged"; number: number; title: string; url: string }
  | {
      ok: false
      code: "not-a-repo" | "no-remote" | "detached" | "unsupported-remote" | "network" | "rate-limited" | "unauthorized" | "bad-response"
    }

/** What the commit or push card decides its buttons from. */
export interface CommitState {
  ok: boolean
  error?: string
  /** Absent when detached. */
  branch?: string
  isDetached: boolean
  hasHead: boolean
  hasChanges: boolean
  hasStaged: boolean
  stagedAdditions: number
  stagedDeletions: number
  hasUpstream: boolean
  upstream?: string
  /** Commits HEAD has that the push target does not, and the other way round. */
  ahead: number
  behind: number
  hasOrigin: boolean
  hasOriginBranch: boolean
  /** Every changed path, relative to the repository root. */
  changedPaths: string[]
}

export interface CommitResult {
  ok: boolean
  /** The new commit's short hash. */
  hash?: string
  code?: "nothing-to-commit" | "ident-missing" | "hook-rejected"
  error?: string
}

export interface PushResult {
  ok: boolean
  code?: "auth" | "rejected" | "no-remote"
  error?: string
}

/** What taking one turn's file changes back did, file by file. */
export interface TurnRevertResult {
  /** Edited files put back to how the turn found them. */
  restored: number
  /** Files the turn created, deleted. */
  removed: number
  /** Files whose changed lines were no longer there, left alone. */
  failed: number
  /** Paths outside the project, skipped. */
  outside: number
  /**
   * The project is not in a repository, so nothing was touched.
   *
   * Taking a turn back goes through git, as MiMo's does, and MiMo refuses
   * outright rather than writing to files it cannot put back.
   */
  noRepo?: boolean
}

export type Message = UserMessage | AssistantMessage

// ---------------------------------------------------------------------------
// Permission
// ---------------------------------------------------------------------------

/** How one file differs from HEAD, in the vocabulary the review speaks. */
export type GitChangeKind = "added" | "deleted" | "modified" | "renamed"

/** One shell the backend is holding, as the drawer needs to know it. */
export interface ShellSummary {
  shellID: string
  /** The directory it was started in, so the drawer can tell it apart from the conversation's. */
  cwd: string
  /** False once the process has ended; its output is still there to read. */
  alive: boolean
  /** Typed into at some point, so closing it asks first. */
  used: boolean
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
  /**
   * A command that loses work. It is asked every time: no "always" is offered,
   * and an earlier "always" for the bucket does not cover it.
   */
  forced?: boolean
  time: number
}

export type PermissionResponse = "once" | "always" | "reject"

/**
 * How a question that was put to the user ended.
 *
 * `cancelled` is a turn stopped while it was on screen; `policy` is one closed
 * by its bucket being switched to Allow or Deny in settings meanwhile.
 */
export type PermissionDecision = "allow-once" | "allow-always" | "reject" | "reject-with-reason" | "cancelled" | "policy"

/** A decided permission question, kept on the tool part it gated. */
export interface PermissionRecord {
  requestID: string
  kind: string
  /** A command that loses work, which the row names as a delete. */
  forced?: boolean
  subject: string
  preview?: string
  decided: PermissionDecision
  /** What the user wrote when refusing. */
  reason?: string
  time: number
}

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
  /**
   * plan: the plan file this question is about, which makes it plan_exit's
   * card - the window says it in the user's own language and offers to open
   * the file. MiMo tags the same question with a key and the path beside it;
   * the path alone is what its window reads back out.
   */
  plan?: string
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
  /** When it was asked, so the dock can queue it with permission requests in arrival order. */
  time: number
  /**
   * Not the model's question but the runner's: MiMo's repeated-call check, put
   * when a tool is called three times running with the same input. The window
   * draws it in its own language; the answers are the keys `once`, `always` and
   * `reject`, or typed feedback, which refuses.
   */
  loop?: { tool: string }
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
  /** A skill shipped with the app (MiMo's `bundled`). */
  builtin?: boolean
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
 * subagents: the kinds of subagent the task tool starts. A general one works
 * with the parent's tools; an explore one only reads, the way Plan does.
 */
export const SUBAGENT_TYPES = ["general", "explore"] as const

export type SubagentType = (typeof SUBAGENT_TYPES)[number]

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
 * how `read`, `list`, `glob` and `grep` came to be beyond reach: their tools
 * each declare a bucket, and nothing had a list to match it to.
 */
export const PERMISSION_KINDS = [
  "read",
  "edit",
  "write",
  "glob",
  "grep",
  "list",
  "bash",
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
 * project happened without asking, and everything that changed a file, ran a
 * command or reached the network asked first. Naming them here rather than leaving them
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
  /**
   * Remote: how to sign in, as MiMo's engine takes it. Absent means sign-in is
   * detected from a 401 and done with dynamic client registration; an object
   * supplies a registered client, scopes or a redirect; false turns it off.
   */
  oauth?: McpOAuthConfig | false
  /** Absent counts as on, so a server added by hand starts working. */
  enabled?: boolean
  /**
   * MiMo's per-server `timeout`, in milliseconds: how long connecting may take
   * (30s without it) and how long each tool call may take (a minute without it).
   */
  timeout?: number
  /** MiMo's per-server `sampling`: whether the server may have a model write for it. Unset asks. */
  sampling?: "deny" | "ask" | "allow"
}

export interface McpOAuthConfig {
  /** A client registered with the authorization server; without it one is registered dynamically. */
  clientId?: string
  clientSecret?: string
  /** Scopes to ask for, space-separated. */
  scope?: string
  /** Default http://127.0.0.1:19876/mcp/oauth/callback. */
  redirectUri?: string
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
  /** MiMo's card name: the title with its spaces folded, up to 60 characters, else `localhost:PORT`. */
  name: string
  /** MiMo's card subtitle, always `localhost:PORT`. */
  label: string
}

export type VoiceMode = "fast" | "smart"

/**
 * The composer's text and its caret or selection, for 智能编辑 to act on.
 *
 * Offsets are UTF-16 code units, which is what a textarea reports and accepts,
 * so the window can put the caret back exactly where the answer says.
 */
export interface VoiceDraft {
  text: string
  selectionStart: number
  selectionEnd: number
}

/** What 智能编辑 made of one utterance: the whole new text and where the caret or selection lands. */
export type VoiceEdit = VoiceDraft

/**
 * MiMo's close decision for a window.
 *
 * A quit in progress, or any other window still open, closes normally. The last
 * window is hidden instead of closed on macOS, or wherever the tray switch is on,
 * so the app keeps running behind its tray or menu bar icon; otherwise it closes.
 */
export function closeHidesToTray(state: {
  quitting: boolean
  otherWindows: number
  platform: string
  trayEnabled: boolean
}): boolean {
  if (state.quitting || state.otherWindows > 0) return false
  return state.platform === "darwin" || state.trayEnabled
}

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

/** Where the global AGENTS.md stands: read into every conversation, switched off (renamed), or not written. */
export type AgentsFileState = "loaded" | "disabled" | "none"

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

/** Where an importable MCP server was found: Claude Code, Kiro or Codex. */
export type McpImportSource = "claude" | "kiro" | "codex"

/** A server another tool has configured, as the import view lists it - never its variables or headers. */
export interface McpImportItem {
  source: McpImportSource
  name: string
  type: "local" | "remote"
  /** The command line, or the address. */
  summary: string
  /** Already configured here under this name, so it is skipped. */
  exists: boolean
}

/** One tool a server offers, as the MCP settings page lists it. */
export interface McpToolInfo {
  name: string
  description?: string
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
  /** New conversations start on Smart rather than on `model`. */
  smart?: boolean
  /** Smart's fast model, for easy everyday requests; empty follows `model`. */
  smartFast?: ModelRef
  /** Smart's main model, for everything else; empty follows `model`. */
  smartMain?: ModelRef
  /** Whether the in-app browser is offered at all; absent is on. */
  browserEnabled?: boolean
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
  /** The chime a task that ran past a minute makes when it ends. */
  taskDoneSound: "off" | "rhodes" | "handpan" | "vibes" | "bloom" | "harp" | "kalimba" | "bowl" | "koto"
  /** Whether moving along or pressing the conversation navigator plays a scale. On by default. */
  spineSound: boolean
  /**
   * Where a task with no project gets its folder. Empty means MCodeProjects
   * in the home directory.
   */
  projectRoot: string
  /** Whether a permission request or a failure also makes a sound. Off by default. */
  soundPermission: boolean
  soundError: boolean
  /** Sessions whose tabs survive a close-others and sort to the front. */
  pinnedTabs: string[]
  /** Project folders pinned to the top of the side column's project list. */
  pinnedProjects: string[]
  /** The side column's project order as dragged; folders not in it keep their recency slot. */
  projectOrder: string[]
  /** Each project's task order as dragged, by project folder. */
  taskOrder: Record<string, string[]>
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
  /**
   * The composer's access level. "auto" is the middle one: changes inside the
   * project, reaching outside it and everyday commands go ahead; deleting and
   * risky commands still ask. Absent, the level is read off `permissions` -
   * "full" when nothing asks, otherwise "ask" - which is what every config
   * written before this field meant.
   */
  accessLevel?: "ask" | "auto" | "full"
  /**
   * Whether full access can be picked in the composer at all. Off to begin
   * with: skipping every question is something to turn on deliberately.
   */
  allowFullAccess: boolean
  /** Working directory for new sessions. */
  directory: string
  /**
   * MiMo's project list: every project folder, newest added first, whether or
   * not it has a conversation. The side column, the home picker and the 环境
   * page all read it. Never shares a folder with `closedProjects`.
   */
  projects: string[]
  /**
   * Project directories hidden from the rail. Closing a project only hides it -
   * its sessions are kept, so reopening the directory brings them all back.
   */
  closedProjects: string[]
  /** Optional display name per project directory, keyed by absolute path. */
  projectNames: Record<string, string>
  /** When each project was last picked on the home screen (ms), so the picker lists it first even before it has a task. */
  projectUsed: Record<string, number>
  /** Per-project badge artwork, stored as a data URL so it survives a move. */
  projectIcons: Record<string, string>
  /** Per-project badge hue override; absent means derived from the path. */
  projectColors: Record<string, string>
  /** The reasoning effort every turn runs at: MiMo keeps one app-wide level, not one per conversation. */
  effort: Effort
  /** Which agent preset new sessions start in. */
  agent: AgentName
  /** Whether new sessions start in staged mode; each may then differ. */
  staged: boolean
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
  /** Start shell tool calls expanded in the transcript. */
  expandShell: boolean
  /** Start edit, write and patch tool calls expanded in the transcript. */
  expandEdits: boolean

  /*
   * Type. Empty means the built-in stack, which is what almost everyone wants;
   * the override exists because a person who has chosen a face to read code in
   * has usually chosen it for a reason.
   */
  uiFont: string
  codeFont: string
  /**
   * The base size, in px, of the interface's text and of code in the
   * transcript and diffs. MiMo's defaults, 14 and 12; each becomes a scale on
   * the root that the sizes in the interface are multiplied by.
   */
  uiFontSize: number
  codeFontSize: number
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
  /**
   * MiMo's `instructions` setting: more instruction files to read into every
   * conversation, as paths or globs (`docs/*.md`, `~/notes/rules.md`), each
   * looked for from the working folder up to the repository's top, or as web
   * addresses, which are fetched as MiMo fetches them - five seconds each, and
   * left out when that fails. Set in the config file; the settings have no row for it.
   */
  instructionFiles?: string[]
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
   * Whether the app keeps an icon in the system tray (the menu bar on macOS).
   *
   * On by default, as in MiMo. While it is on, closing the last window hides it
   * to the tray and the app keeps running, which is MiMo's rule and the reason
   * the switch's description says so; see closeHidesToTray. Quitting from the
   * tray, the app menu or the footer menu still quits.
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

  /** Desktop notifications, by occasion. */
  notifyAgent: boolean
  notifyPermission: boolean

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

  /**
   * The bottom-panel toggle in the bar, on to begin with.
   *
   * The reference this app follows for 2.0 keeps a bottom-panel toggle in the
   * bar at all times, and the drawer is otherwise reachable only by a chord
   * nobody is told about. The setting stays, so a reader who wants the bar
   * emptier can have that.
   */
  showTerminal: boolean

  /**
   * The shell the terminal opens and the bash tool runs in.
   *
   * Empty means whatever the system says; naming one is how someone whose
   * login shell differs from their working shell gets the working one.
   */
  shell: string
}

/** One hand-typed model on a custom provider: an id to send, a name to show, and MiMo's 高级配置. */
export interface CustomModel {
  id: string
  name: string
  /** Whether it reads images; absent means the provider or catalog default decides. */
  attachment?: boolean
  /** Token limits: the input (context) window and the output cap. An output limit needs an input limit. */
  limit?: { context?: number; output?: number }
  /** MiMo's model fields a config file can set beyond the form: which other inputs it reads, and an hour-long prompt cache. */
  inputs?: { pdf?: boolean; audio?: boolean; video?: boolean }
  cacheTTL?: "5m" | "1h"
  /** MiMo's `interleaved.field`: the message field an OpenAI-compatible model reads its own earlier reasoning back from. */
  interleaved?: "reasoning" | "reasoning_content" | "reasoning_details"
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
  /**
   * Which API the gateway speaks. Absent is OpenAI-compatible, which every
   * provider stored before this existed is; `anthropic` reaches a Claude-style
   * gateway over the Messages API, as MiMo's `npm: @ai-sdk/anthropic` does.
   */
  protocol?: "openai" | "anthropic"
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
  | { type: "session.create"; directory?: string; title?: string; scratch?: boolean; sideOf?: string }
  /* An empty folder for a new project, named by the user, under the default project location. */
  | { type: "project.createBlank"; name: string }
  /* A folder onto the project list, with no conversation; `used` also makes it the latest pick. */
  | { type: "project.add"; directory: string; used?: boolean }
  /* Folders off the project list; their conversations stay. */
  | { type: "project.remove"; directories: string[] }
  /* The conversations whose messages hold the query, one hit each, for the search overlay. */
  | { type: "search.messages"; query: string; limit?: number }
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
   *
   * `files: false` is MiMo's edit and retry instead: the messages from
   * `messageID` on are deleted and no file is touched.
   */
  | { type: "session.revert"; sessionID: string; messageID?: string; files?: false }
  | { type: "session.delete"; sessionID: string }
  | { type: "session.compact"; sessionID: string }
  | { type: "session.undo"; sessionID: string }
  | { type: "session.redo"; sessionID: string }
  /* One turn's file changes taken back out of the project; `messageIDs` are the turn's assistant messages. */
  | { type: "session.revertTurn"; sessionID: string; messageIDs: string[] }
  | { type: "session.history"; sessionID: string }
  | { type: "session.agent"; sessionID: string; agent: AgentName }
  | { type: "session.access"; sessionID: string; access: "ask" | "auto" | "full" }
  | { type: "session.staged"; sessionID: string; staged: boolean }
  | { type: "session.archive"; sessionID: string; archived: boolean }
  | { type: "session.rename"; sessionID: string; title: string }
  /* Which project the side column files a conversation under; the folder it works in is untouched. */
  | { type: "session.move"; sessionID: string; directory: string }
  /* Out of every project's group and into Recent; again, nothing on disk moves. */
  | { type: "session.moveOut"; sessionID: string }
  /* `titleSuffix` names the branch MiMo's way, 「{title} (分支)」, instead of copying the title. */
  | { type: "session.fork"; sessionID: string; messageID: string; titleSuffix?: boolean }
  | { type: "session.model"; sessionID: string; model: ModelRef }
  /** Puts the conversation on Smart, to pick its model from the next first message. */
  | { type: "session.smart"; sessionID: string }
  | { type: "session.prompt"; sessionID: string; text: string; attachments?: Attachment[]; annotations?: Annotation[]; fileNotices?: FileNotice[] }
  | { type: "session.abort"; sessionID: string }
  /*
   * subagents: a slash command marked `subtask`. `text` is the line as typed,
   * kept as the user's message; `prompt` is its filled-in template, which a
   * subagent works on before the conversation's own model reads the result.
   */
  | {
      type: "session.subtask"
      sessionID: string
      text: string
      description: string
      prompt: string
      subagentType?: SubagentType
    }
  | {
      type: "permission.respond"
      requestID: string
      response: PermissionResponse
      /** Why it was refused, passed on to the model with the refusal. */
      reason?: string
    }
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
   * The commands a slash can reach in this project.
   *
   * Directory-scoped because that is what decides them: the project's own
   * command files sit under it, and its MCP servers and skills are reached
   * from it. The reference scopes the same list per instance, one instance
   * being one worktree.
   */
  | { type: "command.list"; directory: string }
  /*
   * A project or global command filled in for sending, as MiMo's session.command
   * fills one: arguments substituted, its shell placeholders run in `directory`,
   * and the files it names with `@` returned for the window to attach.
   */
  | { type: "command.expand"; directory: string; name: string; arguments: string }
  /*
   * A template the window filled in itself - an MCP server's prompt, or the
   * line typed after a skill - with its ``!`cmd` `` placeholders run in
   * `directory`, as MiMo runs a template's commands whatever its source (the
   * user's 2026-09-16 decision).
   */
  | { type: "command.shell"; directory: string; text: string }
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
      protocol?: CustomProvider["protocol"]
    }
  | { type: "provider.removeCustom"; provider: string }
  | {
      type: "provider.updateCustom"
      id: string
      name: string
      baseURL: string
      /** Blank keeps the key already held; `{env:VAR}` switches to a variable. */
      apiKey: string
      headers?: Record<string, string>
      models: CustomModel[]
      protocol?: CustomProvider["protocol"]
    }
  /** Copied in the backend so the stored key never travels to the window; `name` is the copy's, already worded. */
  | { type: "provider.copyCustom"; provider: string; name: string }
  | { type: "auth.begin"; provider: string; method: AuthMethodKind }
  | { type: "auth.cancel"; provider: string }
  | { type: "auth.signOut"; provider: string }
  | { type: "workspace.info"; directory: string }
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
      /** The composer's text and selection; with it, 智能编辑 can carry out edit and caret instructions. */
      draft?: VoiceDraft
    }
  | { type: "git.status"; directory: string; scope?: "worktree" | "branch" }
  | { type: "git.init"; directory: string }
  /* The home screen's branch chip: the local branches, and switching or creating one. */
  | { type: "git.branches"; directory: string }
  | { type: "git.checkout"; directory: string; branch: string; force?: boolean; create?: boolean }
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
  /* The edited-files card: each of a turn's files diffed as it stands now, one patch per file. */
  | { type: "git.diffFiles"; directory: string; files: string[] }
  | { type: "git.revert"; directory: string; file: string }
  /* The info card's 环境信息 and its commit or push card. */
  | { type: "git.summary"; directory: string }
  | { type: "git.commitState"; directory: string }
  | { type: "git.commit"; directory: string; message: string; includeUnstaged: boolean }
  | { type: "git.push"; directory: string }
  /* The current branch's pull request, asked of GitHub's public API; only for GitHub remotes. */
  | { type: "git.pullRequest"; directory: string }
  /* A subject line for the pending changes, from the conversation's model; `update …` when it does not answer. */
  | { type: "git.commitMessage"; directory: string; sessionID?: string; paths: string[] }
  | { type: "file.list"; directory: string; query?: string }
  /* One folder level of a project for the @ menu; `sub` is relative to `directory`, empty for its root. */
  /* `all`: the files tab's tree, which shows dot entries and skips only MiMo's ignored folders. */
  | { type: "file.listDir"; directory: string; sub?: string; all?: boolean }
  /*
   * Files under `sub` whose path holds the query, for the @ menu's search.
   * `nameOnly`: the files tab's search, matching the file name alone, MiMo's
   * breadth-first walk capped at 50 results, depth 16 and 4000 entries.
   */
  | { type: "file.search"; directory: string; query: string; sub?: string; limit?: number; nameOnly?: boolean }
  /* Where the files tab browses with no project: the default project location. */
  | { type: "file.defaultDir" }
  /* Carries on the conversation's interrupted last turn, with no new message from the user. */
  | { type: "session.resume"; sessionID: string }
  /* Three example tasks for a project on the home screen, from the default model; empty when it cannot answer. */
  | { type: "home.suggest"; directory: string; language?: string }
  /*
   * `preview`: the files tab's reading, as MiMo's readFileText has it - text over
   * 512 KiB or holding a NUL byte is refused, a video is named as one, and media
   * carries no bytes because the tab plays it from a local address.
   */
  | { type: "file.read"; path: string; preview?: boolean }
  /* A text file saved from the right panel's files tab. */
  | { type: "file.write"; path: string; content: string }
  /*
   * A conversation's shells work in its folder. The home screen's bottom panel
   * has no conversation yet, so it names the project folder it has picked.
   */
  | { type: "shell.open"; sessionID?: string; directory?: string; cwd?: string; cols?: number; rows?: number }
  | { type: "shell.input"; shellID: string; data: string }
  | { type: "shell.resize"; shellID: string; cols: number; rows: number }
  | { type: "shell.close"; shellID: string }
  /**
   * The shells this session already has running, so the drawer can come back
   * to them instead of starting new ones.
   */
  | { type: "shell.list"; sessionID?: string; directory?: string }
  /** Everything a shell has printed so far, to redraw a pane that went away. */
  | { type: "shell.attach"; shellID: string }
  | { type: "workspace.list"; directory: string }
  | { type: "workspace.create"; directory: string; name: string }
  | { type: "workspace.remove"; directory: string; target: string }
  | { type: "mcp.list" }
  | { type: "mcp.toggle"; name: string }
  | { type: "mcp.tools"; name: string }
  /* 授权: the browser sign-in for a remote server that answered 401; resolves when it has finished. */
  | { type: "mcp.authenticate"; name: string }
  | { type: "mcp.importScan" }
  | { type: "mcp.importApply"; items: { source: McpImportSource; name: string }[] }
  /**
   * Saves one MCP server from the settings form. Environment and header rows
   * named in `keep` that come back blank keep the values already stored.
   */
  | { type: "mcp.save"; name: string; entry: McpServerConfig; keep?: { env?: string[]; headers?: string[] } }
  | { type: "agents.state" }
  | { type: "agents.ensure" }
  | { type: "agents.setEnabled"; enabled: boolean }
  | { type: "agents.delete" }

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

/* One row of a folder the @ menu is browsing. */
export interface DirEntry {
  name: string
  type: "dir" | "file"
}

/* A file the @ menu's search found: `rel` from the project root, `dir` the folder part of it. */
export interface FileHit {
  name: string
  rel: string
  dir: string
}

/* The marks a home suggestion can carry; anything else a model answers becomes "idea". */
export const SUGGESTION_ICONS = ["code", "bug", "test", "doc", "chart", "idea"] as const
export type SuggestionIcon = (typeof SUGGESTION_ICONS)[number]

/* An example task on the home screen: its row title, and the request that goes into the box. */
export interface HomeSuggestion {
  title: string
  query: string
  icon: SuggestionIcon
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
    /** session chat: the messages in flight, for a window that was not listening when they started. */
    chatLinks: Record<string, ChatLink[]>
  }
  "artifact.list": { artifacts: SessionArtifacts[] }
  "session.create": { session: SessionInfo }
  "project.createBlank": { directory: string }
  /* `existed` is true when the folder was already listed. */
  "project.add": { config: AppConfig; existed: boolean }
  "project.remove": { config: AppConfig }
  "search.messages": { hits: MessageHit[] }
  "session.get": { session: SessionInfo; messages: Message[] }
  "session.systemPrompt": { prompt: string }
  /**
   * `files` is how many the project was actually put back to - the number the
   * interface may repeat. It counts the files touched by moving the boundary,
   * in either direction, and is zero when the rolled back turns changed none.
   */
  "session.revert": { session: SessionInfo; files: number; history: HistoryDepth }
  "session.agent": { session: SessionInfo }
  "session.access": { session: SessionInfo }
  "session.staged": { session: SessionInfo }
  "session.delete": Record<string, never>
  "session.compact": { session: SessionInfo }
  "session.undo": { files: number; history: HistoryDepth }
  "session.redo": { files: number; history: HistoryDepth }
  "session.revertTurn": TurnRevertResult
  "session.history": { history: HistoryDepth }
  "session.archive": { session: SessionInfo }
  "session.rename": { session: SessionInfo }
  "session.move": { session: SessionInfo }
  "session.moveOut": { session: SessionInfo }
  "session.fork": { session: SessionInfo }
  "session.model": { session: SessionInfo }
  "session.smart": { session: SessionInfo }
  "session.prompt": { messageID: string }
  "session.abort": Record<string, never>
  "session.subtask": { messageID: string }
  "permission.respond": Record<string, never>
  "question.list": { questions: QuestionRequest[] }
  "question.reply": Record<string, never>
  "command.list": { commands: CommandInfo[] }
  /* `files` are the existing files the prompt names with `@`: `name` as written, `path` absolute. */
  "command.expand": { prompt: string; files: { name: string; path: string }[] }
  "command.shell": { text: string }
  "config.get": { config: AppConfig }
  "config.set": { config: AppConfig }
  "provider.list": { providers: ProviderStatus[] }
  "provider.auth": { providers: ProviderStatus[]; models: number }
  "provider.discover": { providers: ProviderStatus[]; count: number }
  "provider.addCustom": { providers: ProviderStatus[] }
  "provider.removeCustom": { providers: ProviderStatus[] }
  "provider.updateCustom": { providers: ProviderStatus[] }
  /** The copy's id. */
  "provider.copyCustom": { providers: ProviderStatus[]; id: string }
  /**
   * Where to send the user, plus the short code to type when the flow is the
   * device kind. Either way the outcome arrives later as an auth event.
   */
  "auth.begin": { url: string; userCode?: string }
  "auth.cancel": Record<string, never>
  "auth.signOut": { providers: ProviderStatus[] }
  /** Facts about a session's directory; absent fields are simply unknown. */
  "workspace.info": { exists: boolean; branch?: string; modified?: number }
  "git.status": GitStatus
  "git.init": GitStatus
  "git.branches": BranchState
  "git.checkout": CheckoutResult
  "git.diff": { patch: string }
  /* `repo` false means the project is not in a repository and there is nothing to compare with. */
  "git.diffFiles": { repo: boolean; files: { path: string; patch: string }[] }
  "git.revert": GitStatus
  "git.summary": GitSummary
  "git.commitState": CommitState
  "git.commit": CommitResult
  "git.push": PushResult
  "git.pullRequest": PullRequestState
  "git.commitMessage": { message: string; generated: boolean }
  "file.list": { files: FileEntry[] }
  /* Folders first, then files, each by name; dot entries and the ignored folders left out. */
  "file.listDir": { entries: DirEntry[] }
  /* `truncated` when more matched than `limit` allowed. */
  "file.search": { entries: FileHit[]; truncated: boolean }
  "file.defaultDir": { directory: string }
  /* The user message whose turn is being carried on. */
  "session.resume": { messageID: string }
  /* `generated` is false when no model answered, and the list is then empty. */
  "home.suggest": { suggestions: HomeSuggestion[]; generated: boolean }
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
    kind: "text" | "image" | "audio" | "pdf" | "binary"
    content: string
    truncated: boolean
    mime?: string
    data?: string
    /* A preview read of text past 512 KiB: nothing is carried, MiMo's toobig. */
    tooBig?: boolean
    /* A preview read of a video, which the files tab plays from disk; its kind stays binary for everyone else. */
    video?: boolean
  }
  "file.write": { path: string }
  "shell.open": { shellID: string; cwd: string }
  "shell.input": Record<string, never>
  "shell.resize": Record<string, never>
  "shell.close": Record<string, never>
  "shell.list": { shells: ShellSummary[] }
  "shell.attach": { data: string; alive: boolean; used: boolean }
  "app.paths": { paths: AppPaths }
  "usage.summary": { summary: UsageSummary }
  "local.servers": { servers: LocalServer[] }
  /* `edit` is 智能编辑's validated answer when a draft was sent; without it the window types `text` in. */
  "voice.transcribe": { text: string; heard: string; edit?: VoiceEdit }
  "workspace.list": { worktrees: Worktree[] }
  "workspace.create": { directory: string; branch: string }
  "workspace.remove": Record<string, never>
  "mcp.list": { servers: McpServerState[] }
  "mcp.toggle": { servers: McpServerState[] }
  /** A connected server's tools, or why there are none to list (a status name or the server's error). */
  "mcp.tools": { tools?: McpToolInfo[]; error?: string }
  "mcp.authenticate": { servers: McpServerState[] }
  "mcp.importScan": { items: McpImportItem[] }
  /** The names actually added. */
  "mcp.importApply": { imported: string[] }
  "mcp.save": { config: AppConfig }
  "agents.state": { path: string; state: AgentsFileState }
  /** Writes a starting file when there is none. */
  "agents.ensure": { path: string; state: AgentsFileState }
  "agents.setEnabled": { path: string; state: AgentsFileState }
  "agents.delete": { path: string; state: AgentsFileState }
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
  /** automation: a scheduled task's run started in a conversation, or its turn ended and whether the user is told. */
  | { type: "automation.run"; sessionID: string; phase: "started" | "finished"; notify?: boolean }
  /** session chat: every conversation's messages in flight, whole, whenever one changes. */
  | { type: "session.chatLinks"; links: Record<string, ChatLink[]> }
  /** Incremental append to a part already announced via message.updated. */
  | { type: "message.delta"; sessionID: string; messageID: string; partID: string; text: string }
  | { type: "permission.requested"; request: PermissionRequest }
  | { type: "permission.resolved"; requestID: string; decided?: PermissionDecision; reason?: string }
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
