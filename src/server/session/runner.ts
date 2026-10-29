import path from "node:path"
import type {
  AgentName,
  AssistantMessage,
  AssistantPart,
  Attachment,
  Message,
  ModelRef,
  PermissionRecord,
  ReasoningPart,
  SessionInfo,
  SubagentNotice,
  TaskItem,
  TextPart,
  ToolPart,
  TurnAgent,
  Usage,
  UserMessage,
} from "@shared/protocol"
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { Identifier } from "@shared/id"
import { effortToSend } from "@shared/effort-menu"
import { NO_TESTING_NOTE, NO_TESTING_REFUSAL, forbidsTesting } from "@shared/no-testing"
import { availableModels, fallbackModel, modelAvailable } from "@shared/model-fallback"
import { readTask, smartRoute, type TaskReading } from "@shared/smart"
import type { Bus } from "../bus"
import type { Config } from "../config"
import type { Permissions } from "../permission"
import { PermissionDenied, REVIEW_TIMEOUT_MS, VERDICT_TOOL_NAME, looksSecret, verdictApproves } from "../permission"
import { processAlive, type Storage } from "../storage"
import { globalAgentsPath } from "../global-agents"
import { discoverSkills, enabledSkills, skillReminders, withSkillReminders, type SkillInfo } from "../skill"
import { findTool, forModel, hasOwnToolsOnly, reachOf, repairableNames, toolsForTurn, withheldByLab } from "../tool/registry"
import { normalizeToolInput, resolveToolName } from "../tool/repair"
import { inputForTool } from "../provider/tool-schema"
import { Questions } from "../tool/question"
import type { PlanControl, SubagentControl, SubagentSpec, ToolContext, ToolDefinition, ToolResult } from "../tool/types"
import { instructionsIn } from "../tool/read"
import { keepReadCopy } from "../tool/read-media"
import { ToolError } from "../tool/types"
import { argumentProblems, refusedArgumentsNote } from "../tool/validate"
import { repairToolArguments } from "../tool/arg-repair"
import { ToolOutputs } from "../tool/truncate"
import { cooldownLeft, noteRateLimit, retryDecision, waitFor, withRequestRetry } from "./retry"
import { Semaphore, STEP_TOOL_LIMIT, SUBAGENT_LIMIT } from "./semaphore"
import { CodedError, codeOf, paramsOf } from "@shared/errors"
import { describeAnthropicError } from "../provider/anthropic"
import { adapterFor } from "../provider/adapter"
import { interleavedField } from "../provider/interleaved"
import type { AuthManager } from "../auth/manager"
import type { ProviderAdapter, TurnEvent, TurnOutcome } from "../provider/types"
import { failureCode, failureDetail } from "./error-map"
import type { SessionStore, Snapshot, SnapshotFile } from "./store"
import { emptyUsage } from "./store"
import type { Recording } from "./snapshot"
import { Snapshots, keepSnapshotFile, snapshotBytes, withProjectLock } from "./snapshot"
import { revertTurnFiles, turnFilePaths } from "./turn-revert"
import { COMPACTION_TRIGGER_RATIO, SUMMARY_OUTPUT_MAX, fitOutput, isOverflowByCount, promptSince, isOverflowError, maxOutputTokens, underPressure, usableContext } from "./overflow"
// MiMo's pruning: what a turn re-sends of its older tool output once the prompt cache has gone cold.
import { pruneLevelFor, prunedHistory, type PruneLevel } from "./prune"
import { estimateTokens } from "./estimate"
import { SHRINK_STEPS, SUMMARY_NUDGE, UNKNOWN_WINDOW, compactedText, continueNote, extractSummary, flattenOldest, isCheckpoint, isSummary, legacySummary, messagesTokens, nextRequestEstimate, requestTokens, shrinkLargeToolResults, splitConversation, summaryPrompt, touchedFiles, type CompactionTrigger } from "./summary"
import { fetchInstruction, instructionUpdate, instructionValues, memorySection, systemPromptFrom, type InstructionValues } from "./prompt"
// plan: the plan file, what planning may write, and what each planning turn is told.
import { GOAL_GUARD, JUDGE_SYSTEM, MAX_GOAL_REACT, cleanGoal, goalReminder, judgeQuestion, judgeTranscript, parseVerdict, sameGoal, type GoalVerdict } from "./goal"
import { approvedNote, buildSwitchNote, carryOutNote, firstPlanNote, laterPlanNote, planDisplay, planFile, planFolders, planWritable, slugOf, subagentAgent } from "./plan"
import { maxStepsPrompt, stepLimitFor } from "./steps"
import { promptFamily } from "./prompts"

/** Codex's unified_exec default output budget, used for reasoning-family models. */
const REASONING_MAX_OUTPUT_TOKENS = 10_000
import { status as gitStatus } from "../git"
import { historyService, memoryFilesFor, memoryWritable } from "../history/service"
import { withAutomationNotes } from "../automation/framing"
import { TITLE_SYSTEM, UNTITLED, cleanTitle, fallbackTitle, titleModelRef, titlePrompt, withoutSkillPrefix } from "./title"
import { interfaceLocale } from "./locale"
import { providerExtras, samplingFor, smallRequest, thinkingOffExtra } from "../provider/sampling"
import { attachmentNote, runtimeContext, sessionNote } from "./context"
import { settleAttachments, withAttachmentData, type AttachmentCache } from "./attachments"
import type { ModelEntry } from "../provider/catalog"
import { forWire } from "../provider/wire-ids"
import type { ModelModalities, QueuedPrompt, SessionGoal } from "@shared/protocol"
import { costOf } from "./usage"
// The day on this machine's calendar, which is what the runtime context tells the model.
import { localDay } from "../usage-summary"
import { BackgroundUsage, type BackgroundUse } from "./background-usage"
import { UsageDays } from "./usage-days"
import type { Usage as TurnUsage } from "@shared/protocol"
import { ABORTED_TOOL } from "../provider/history"
import { INTERRUPTED_FINISH, INTERRUPTED_NOTE, LENGTH_NOTE, THOUGHT_LENGTH_NOTE, LOOP_ANSWERS, LOOP_ENDED, LOOP_ENDED_CODE, LOOP_FINISH, CONTINUATION_LIMITS, continuationFor, createLoopMonitor, frameSteered, recallHint, reminder, repeatNoteFor, repeatsCall, withNotes, withRecallHint, withSameStepsNote } from "./reminders"
import { withPatchCheckpoint } from "./patch-checkpoint"
import { LoopMonitor, TEXT_LOOP_BUFFER, WanderWatch, applyCrops, describeLoop, detectStreak, stepDigest, suggestLoopNextStep, textLoopNoteFor, type LoopIncident } from "./loop-health"
import { interruptedTurn } from "@shared/resume"
// session chat
import { CHAT_WAIT_MS, SessionChat, withChatHeaders } from "./chat"
import { SUBAGENT_TIMERS, firstLine, isStalled, noticeText, readLegacyMessage, statusHeader, subagentOutput, type ResultStatus, type SubagentTimers } from "@shared/subagent"
import { STRUCTURED_OUTPUT, STRUCTURED_REMINDER, STRUCTURED_RETRIES, structuredOutputTool, structuredResult } from "../tool/subagent"
import { TASK_ID, applyTask, listedTasks } from "../tool/task"
// tasks: the record a subagent started for a task has to leave behind before it finishes.
import { MAX_PROGRESS_REACT, PROGRESS_SECTIONS, missingProgressSections, progressPath, progressReminder } from "./task-progress"
import type { TaskControl } from "../tool/types"
import type { McpServers } from "../mcp"

/** What a turn needs of the MCP layer: a project's servers connected, their tools, and their names. */
type McpAccess = Pick<McpServers, "ready" | "tools" | "names" | "needsTrustPrompt" | "trust">

/*
 * What a resumed turn is told at its first step, in MCode's own words. Sent in
 * the request only, never written to the transcript: 继续 adds no message.
 */
const RESUME_PROMPT =
  "The previous turn stopped before it was finished. Carry on with the task from where it stopped: do not redo work that is already done, and do not start over."

/*
 * What a turn the app was cut off in the middle of is told when it is carried
 * on at the next start: OpenCode v2's CONTINUE_AFTER_SERVER_RESTART (MIT),
 * with "app" for "server" - in MCode it is the app that went away.
 */
const RESTART_PROMPT = "The app restarted while you were working. Continue from where you left off without repeating completed work."

/** How many times one turn is carried on after the app went away before it is left for the reader (v2's `DEFAULT_MAX_ATTEMPTS`). */
export const MAX_RESTART_RESUMES = 10

/** Why a turn carries on without a new message: the reader's 继续, or the app coming back after it went away mid-turn. */
type Resumed = false | "user" | "restart"

/*
 * subagents: what a subagent is told about its place, in MCode's own words,
 * added after the system prompt its agent would otherwise get.
 */
const SUBAGENT_NOTE = [
  "## Working as a subagent",
  "",
  "Another agent handed you one task. The first message is everything it told you; you cannot ask it anything.",
  "Do the task, then end with a final message that is a complete answer on its own: what you found or changed, with exact paths and names, and anything you could not do.",
  "That final message is all the other agent will read.",
].join("\n")

/* subagents: a general subagent opens its final message with a status and a summary, as MiMo's does, so the parent can read those first. */
const RETURN_NOTE = [
  "## Your final message",
  "",
  "Begin your final message with these two lines, with nothing before them:",
  "**Status**: success, partial, failed or blocked",
  "**Summary**: one sentence saying what happened",
  "Then give what the task asked for. End with these three lines, each filled in or marked (none):",
  "**Files changed**: the paths you changed, or (none)",
  "**Checks run**: the inspections or commands you already ran, or (none)",
  "**Remaining risks**: open questions or risks for the agent that sent you, or (none)",
].join("\n")

/* tasks: MiMo's completion gate sends a general subagent back this many times at most. */
const TASK_GATE_TURNS = 2

/* tasks: what a general subagent that is ending with tasks still in its hands is told, in MCode's own words. */
function taskGateReminder(held: readonly TaskItem[]): string {
  return [
    "<system-reminder>",
    "You are ending your work, but these tasks are assigned to you and are not finished:",
    ...held.map((task) => `- ${task.id} (${task.status}): ${task.summary}`),
    "Finish each one and mark it done with the task tool, or abandon it with a reason if it turned out not to be needed.",
    "Then write your final message again, opening with the **Status** and **Summary** lines.",
    "</system-reminder>",
  ].join("\n")
}

/* subagents: a subagent asked for structured output returns it through its tool rather than in prose. */
const STRUCTURED_NOTE = [
  "## Your result",
  "",
  `This task wants its result as data. When the work is done, call ${STRUCTURED_OUTPUT} once with an object that matches its parameters. That object is your answer; do not repeat it in prose.`,
].join("\n")

/* subagents: what the conversation's model is told, in the request only, after a `subtask` command's subagent has answered. */
const SUBTASK_PROMPT =
  "A subagent has just carried out the command above. Tell the user what it found or did, briefly, and carry on from there if anything is left to do."

/** subagents: a `subtask` command's subagent, run before the conversation's model is asked. */
type Lead = SubagentSpec

/** A message the user sent: its words, its files, and the places it points at. */
type PromptInput = {
  sessionID: string
  text: string
  attachments?: Attachment[]
  annotations?: UserMessage["annotations"]
  /* Documents the user changed since the last message, told to the model ahead of the text. */
  fileNotices?: UserMessage["fileNotices"]
  /* session chat: sent by another conversation, marked the way a subagent's follow-up is. */
  inbox?: UserMessage["inbox"]
  /* What a slash command named, for this turn only: MiMo runs the turn as the agent and model the command names. */
  agent?: TurnAgent
  model?: SessionInfo["model"]
  /* 追求目标: this message sets the conversation's goal - the composer sends it while the switch is on. */
  goal?: string
  /* OpenCode v2's delivery: while a turn runs, "queue" waits for it to end instead of joining it. */
  delivery?: "steer" | "queue"
  /* Set when the queue sends it, so the window knows a turn it did not send has started. */
  fromQueue?: boolean
}

/**
 * A conversation as one turn runs it: its own settings, except that a slash
 * command may name one of the command agents for this turn alone.
 */
type TurnSession = Omit<SessionInfo, "agent"> & { agent: TurnAgent }

/** The conversation as stored after a change mid-turn, still run as the agent and model this turn was started with. */
function keepTurn(next: SessionInfo, turn: TurnSession): TurnSession {
  return { ...next, agent: turn.agent, model: turn.model }
}

/**
 * What the summary is for: the next turn reads it instead of the conversation,
 * so it has to carry decisions and state rather than read as a recap.
 */
/*
 * Smart's one question about a conversation's first message, in this app's own
 * words: what kind of task it is and how hard, as JSON, so the route can be
 * decided by a rule rather than by the model's say-so.
 */
const SMART_SYSTEM = [
  "You sort one request for a coding assistant before any work starts.",
  'Answer with JSON and nothing else: {"scene": "chat" | "writing" | "software" | "research" | "other", "difficulty": "easy" | "hard", "confidence": a number from 0 to 1}.',
  "software means reading, writing, running or fixing code; research means finding, comparing or checking information.",
  "easy means a short answer that needs no investigation; anything else is hard.",
].join("\n")

/** Room for the JSON, and for a model that reasons before giving it. */
const SMART_OUTPUT_TOKENS = 1024

/** How long the sorting may take before the main model is used anyway. */
const SMART_TIMEOUT_MS = 20_000

/** The message is quoted up to this many characters; the start says what it is. */
const SMART_REQUEST_CHARS = 4000

/*
 * The instruction for reviewing one risky command on the user's behalf. Its
 * own short request with no tools: the model is asked for a verdict, not to
 * carry on with the work.
 */
const REVIEW_SYSTEM = [
  "You decide whether one action a coding assistant wants to take may go ahead without asking the user, who chose to let this check settle such questions.",
  "Go by what the user recently asked for.",
  "Approve work that carries out those requests and does not destroy existing files: making folders, running scripts and searches, reading anywhere - outside the project and in temporary folders included.",
  "Deny what destroys or overwrites work, runs code fetched from elsewhere, or goes against what the user asked.",
  `Answer only by calling ${VERDICT_TOOL_NAME} once with {"decision":"APPROVE"} or {"decision":"DENY"}, and write nothing else.`,
].join("\n")

/** MiMo's judge answers in one small tool call. */
const REVIEW_OUTPUT_TOKENS = 64

/** The review sees the user's last three requests, each cut at 400 characters. */
const REVIEW_REQUESTS = 3
const REVIEW_REQUEST_CHARS = 400

/** The review's one tool: a verdict given in prose does not count. */
const VERDICT_TOOL: ToolDefinition = {
  name: VERDICT_TOOL_NAME,
  description: "Give the decision. Call it once, and write nothing else.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["decision"],
    properties: {
      decision: { type: "string", enum: ["APPROVE", "DENY"], description: "APPROVE lets this one action go ahead; DENY leaves it for the user" },
    },
  },
  async execute() {
    return { output: "" }
  },
}

/** How long a goal verdict may take before the turn is let go. */
const GOAL_JUDGE_TIMEOUT_MS = 90_000

/** What the bar says when no verdict came back at all; the reader sees it in their own language, keyed off this. */
const GOAL_JUDGE_FAILED = "judge-failed"

/** How long a title may take before the fallback is kept. */
const TITLE_TIMEOUT_MS = 60_000

/** The first message is quoted up to this many characters for its title. */
const TITLE_SOURCE_CHARS = 4000


/**
 * Drives one session's conversation.
 *
 * The loop is written by hand rather than using the SDK tool runner because
 * every step has to be observable: each text delta, each tool transition, and
 * each permission prompt is published as it happens so the UI can render a
 * turn while it is still running, and so an abort can land mid-tool.
 */
/**
 * Tools a subagent never gets: starting subagents, and talking to other
 * conversations. plan: leaving plan mode is the conversation's own move, and a
 * subagent has no plan to put to anyone - MiMo denies it to every agent but
 * its two primary ones for the same reason.
 */
const SUBAGENT_WITHHELD = new Set(["actor", "contacts", "talk_to_session", "create_session", "update_session", "automation_update", "plan_exit", "question"])

/** plan: the tools whose behaviour depends on whether the conversation is planning. */
const PLAN_AWARE = new Set(["write", "edit", "notebook_edit", "patch", "plan_exit"])

export class SessionRunner {
  private readonly running = new Map<string, AbortController>()
  /** Where each running turn works, so the MCP servers of a folder with a turn in it are never swept (N11-36). */
  private readonly workingIn = new Map<string, string>()
  /** N11-20: every subagent in the process shares these permits; top-level conversations do not take one. */
  readonly subagentGate = new Semaphore(SUBAGENT_LIMIT)
  /**
   * The turns that are waiting between attempts, by conversation (N11-17).
   *
   * A retry is never written to disk, so this is the only place a window that
   * reconnects mid-wait can learn about one; `session.list` replays it.
   */
  private readonly retrying = new Map<string, { messageID: string; attempt: number; message: string; next: number; kind?: string; max?: number }>()
  /**
   * The requests a conversation has out that are not its turn.
   *
   * Naming a conversation is launched and forgotten, with a controller of its
   * own and no entry in `running` - so Stop, which reaches subagents, stream
   * controllers, pending permissions and pending questions, could never reach
   * it. Pressing Stop on the first message left the title request running to
   * its own timeout, renamed the conversation seconds later, and billed the
   * user for the request they had just cancelled.
   */
  private readonly background = new Map<string, Set<AbortController>>()
  /** Which conversations are close enough to their compaction line to halve tool output. */
  private readonly pressured = new Map<string, boolean>()
  /**
   * The last request a conversation sent: the prompt size its provider
   * reported, and the estimate of that same request. The next request is sized
   * as the first plus what the estimate grew by, so only what was added since
   * is guessed at - the four-characters-a-token estimate runs well short on
   * Chinese text and on code.
   */
  private readonly promptAnchors = new Map<string, { model: string; measured: number; estimated: number }>()
  /** read: how much the running turn trims off older output, so read knows which instructions its request still carries. */
  private readonly turnPrune = new Map<string, PruneLevel>()
  /**
   * Patch-checkpoint fires per user message that the stored history cannot
   * show: the note rides the request only, so the twice-at-most cap needs its
   * own record until the user speaks again.
   */
  private readonly checkpointFireCounts = new Map<string, number>()
  /** Calls whose arguments arrived as text that could not be read, and why. */
  private readonly inputErrors = new WeakMap<ToolPart, string>()
  /**
   * The turns that are still open to more of the user's words.
   *
   * Someone watching a model work usually sees it going the wrong way before it
   * finishes, and says so. While a prompt sent mid-turn was refused, the only
   * lever they had was Stop and start again, which throws away everything the
   * turn had already done. A session listed here takes the prompt into the turn
   * that is running instead: the message goes into the transcript at once and
   * reaches the model at the next step, which is the first moment a request is
   * being built rather than already in flight.
   *
   * An entry's lifetime is exactly the window in which joining is safe. It is
   * made as the turn is launched and removed only once the turn has been
   * released and anything still in it has been handed to a fresh turn, so there
   * is no instant at which a prompt can neither join this turn nor start the
   * next one.
   */
  private readonly steering = new Map<string, Steering>()

  /** Conversations that already said Not now to this folder's MCP trust prompt. */
  private readonly mcpTrustSkipped = new Set<string>()

  /** Turns being carried on after the app went away, and how many times each has been: written into the claim as the turn starts. */
  private readonly restartResumes = new Map<string, number>()

  /**
   * Set as the app closes. A turn cut off by the quit keeps its claim, so the
   * next start carries it on; one that ends for a reason of its own releases
   * it. Without this the shutdown's own killing of commands ended turns that
   * then looked finished.
   */
  private closing = false
  /** OpenCode v2 queue: each conversation's edits, chained so none is lost to another running beside it. */
  private readonly queueEdits = new Map<string, Promise<void>>()

  /** Whether a process is alive; replaced by checks, which cannot rely on the machine's process table. */
  alive?: (pid: number) => boolean
  /** subagents: the subagents a running turn is waiting on (run), so Stop reaches them. Background ones are not here. */
  private readonly children = new Map<string, Set<string>>()
  /** subagents: every subagent taking a turn, by its own session id. An idle one has no entry. */
  private readonly workers = new Map<string, Worker>()
  /** subagents: how background work is timed; MiMo's figures unless the checks or `MCODE_SUBAGENT_TIMERS` say otherwise. */
  readonly subagentTimers: SubagentTimers = { ...SUBAGENT_TIMERS, ...timersFromEnvironment() }
  /** subagents: the stall watchdog, running while any background subagent is. */
  private watchdog?: ReturnType<typeof setInterval>
  /**
   * subagents: the conversation whose turn a running subagent works for. Its
   * file changes are recorded into that turn.
   */
  private readonly owners = new Map<string, string>()
  /** subagents: the highest number handed out per parent and kind, so parallel calls never share a name. */
  private readonly numbering = new Map<string, number>()
  /*
   * Set after construction rather than injected: the MCP layer reads config,
   * which the runner also holds, and threading it through the constructor
   * would make the two impossible to build in either order.
   */
  private mcp?: McpAccess

  /** Where the per-project shadow repositories that back undo are kept. */
  private readonly snapshots: Snapshots
  /** What background requests spent; the usage page counts it with the turns. */
  readonly backgroundUsage: BackgroundUsage
  /** Each conversation's turns by day, so the usage page does not read every transcript (S13-2). */
  readonly usageDays: UsageDays

  /**
   * The undo stores, for the two things outside a turn that have to reach them:
   * collecting a project's store when its last conversation goes, and moving an
   * old profile's inline undo bodies into it.
   */
  get checkpoints(): Snapshots {
    return this.snapshots
  }
  /** Sessions with a summary in flight; see `compactingSessions`. */
  private readonly summarising = new Set<string>()

  /**
   * The questions tools are parked on.
   *
   * Held here rather than beside `permissions` in the runtime because the
   * runner is the only thing that builds a tool context, and because nothing
   * else in the backend has a reason to reach it - `handlers.ts` gets at it
   * through `runner.questions`, the way it gets at running sessions through
   * `runner.busySessions()`.
   */
  readonly questions: Questions
  /** session chat: conversations messaging each other; `handlers.ts` reads its links. */
  readonly chat: SessionChat

  /** Where the global AGENTS.md lives, next to the app's own config. */
  private readonly globalAgents: string

  private readonly toolOutputs: ToolOutputs

  /** plan: the app's own folder, where a plan goes when the project is not a repository. */
  private readonly dataRoot: string

  /** plan: whether a project is under version control - asked once per folder, since it decides where its plans live. */
  private readonly repos = new Map<string, boolean>()

  /**
   * plan: the agent each conversation's running turn began as.
   *
   * A turn is judged by the mode it started in, as MiMo judges its own by the
   * agent the turn was built from. It matters at exactly one moment: the user
   * approves the plan half way through a turn, and the conversation becomes a
   * building one. That turn was promised to be read-only, and its system
   * prompt and tool list still say so, so it stays read-only to the end and
   * the building starts on the next turn - which is what plan_exit tells the
   * model to wait for. Overwritten whenever a turn starts, so a stale entry
   * cannot outlive the conversation's next turn.
   */
  private readonly turnAgents = new Map<string, string>()

  /**
   * What a slash command named for the turn it starts: the agent and model to
   * run that turn as.
   *
   * MiMo runs a command's turn that way and leaves the conversation's own
   * settings alone, so this is taken by the turn that was started for it and
   * never written to the conversation.
   */
  private readonly turnOverrides = new Map<string, { agent?: TurnAgent; model?: SessionInfo["model"] }>()

  constructor(
    private readonly store: SessionStore,
    private readonly bus: Bus,
    private readonly config: Config,
    private readonly permissions: Permissions,
    private readonly auth: AuthManager,
    storage: Storage,
  ) {
    this.snapshots = new Snapshots(storage.folder("snapshot"))
    this.backgroundUsage = new BackgroundUsage(storage)
    this.usageDays = new UsageDays(storage, store)
    // Complete outputs the shared cap cut, kept a week, as MiMo keeps them.
    this.toolOutputs = new ToolOutputs(storage.folder("tool-output"))
    this.toolOutputs.start()
    this.globalAgents = globalAgentsPath(storage.directory)
    this.dataRoot = storage.directory
    this.questions = new Questions(bus)
    // session chat: messages between conversations run through this runner's own prompt.
    this.chat = new SessionChat(
      store,
      bus,
      {
        isRunning: (sessionID) => this.running.has(sessionID),
        prompt: (input) => this.prompt(input),
        create: async ({ directory, title }) => {
          const settings = config.get()
          await config.adoptProjects([directory], { byRepository: true })
          return store.create({ directory, title, model: settings.model, agent: settings.agent, goalMode: settings.goalMode, ...(settings.smart ? { smart: true } : {}) })
        },
      },
      CHAT_WAIT_MS,
      storage,
    )
    // session chat: a message that was in flight when the app went away is sent, or its caller told.
    void this.chat.restore()
    permissions.useReviewer((input) => this.reviewCommand(input))
    // subagents: anything a working subagent writes is a sign of life to the watchdog.
    bus.subscribe((event) => {
      const id = event.type === "message.updated" ? event.message.sessionID : event.type === "message.delta" ? event.sessionID : undefined
      const worker = id ? this.workers.get(id) : undefined
      if (worker) worker.activity = Date.now()
    })
    void this.recoverSubagents(Date.now())
  }

  /**
   * The session's own model, asked whether a risky command should run.
   *
   * It sees what the user last asked for, where the work is and the command,
   * and answers with one word. Only an answer that starts with APPROVE counts;
   * `Permissions` asks the user for everything else, and for anything that
   * takes longer than its timeout, which also ends the request here.
   */
  private async reviewCommand(input: { sessionID: string; kind: string; subject: string }): Promise<boolean> {
    const session = await this.store.get(input.sessionID)
    if (!session) return false
    const definition = this.config.definition(session.model.provider)
    if (!definition) return false
    const adapter: ProviderAdapter = adapterFor(definition.kind)
    const apiKey = this.config.apiKey(definition.id) ?? ""
    const tokens = definition.kind === "chatgpt" ? await this.auth.accessToken(definition.id) : undefined
    const stored = await this.store.messages(session.id)
    // As MiMo's judge reads them: the last few requests, each cut short, any that looks like it holds a credential left out.
    const requests = stored
      .flatMap((message) => (message.role === "user" && message.text.trim() ? [message.text.trim()] : []))
      .map((text) => (text.length > REVIEW_REQUEST_CHARS ? `${text.slice(0, REVIEW_REQUEST_CHARS)}…` : text))
      .filter((text) => !looksSecret(text))
      .slice(-REVIEW_REQUESTS)
    const text = [
      input.kind,
      input.subject,
      ...(requests.length ? ["", "What the user asked for recently, oldest first:", ...requests.map((request, index) => `${index + 1}. ${request}`)] : []),
    ].join("\n")

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REVIEW_TIMEOUT_MS)
    let answer = ""
    let calls: { name: string; input: Record<string, unknown> }[] = []
    try {
      const outcome = await adapter.stream(
        {
          apiKey: tokens?.access ?? apiKey,
          model: session.model,
          system: REVIEW_SYSTEM,
          history: [
            {
              id: `${session.id}:command-review`,
              sessionID: session.id,
              role: "user",
              text,
              attachments: [],
              time: { created: Date.now() },
            },
          ],
          tools: [VERDICT_TOOL],
          // Out of band; the empty variants list already withholds the level, so this is for the body fields.
          ...smallRequest(session.model.provider, session.model.model),
          variants: [],
          signal: controller.signal,
          baseURL: definition.baseURL,
          headers: definition.headers,
          accountId: tokens?.accountId,
          maxOutput: REVIEW_OUTPUT_TOKENS,
        },
        (event) => {
          if (event.type === "text.delta") answer += event.text
        },
      )
      calls = outcome.toolCalls
      this.noteBackground(session.id, session.model, outcome.usage, "review")
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
    return verdictApproves(calls, answer)
  }

  useMcp(mcp: McpAccess): void {
    this.mcp = mcp
  }

  /**
   * The tools for a turn: this app's own, plus whatever the connected MCP
   * servers of the conversation's project offer. Which servers those are is
   * the MCP layer's to say: a saved change reaches every conversation once the
   * next one starts, as MiMo applies it.
   *
   * plan: a planning conversation is offered the MCP ones too, as MiMo offers
   * them - its rule is about writing files, not about which servers are
   * reachable, and a plan written without the project's own tools is a worse
   * plan. An explore subagent is still offered only its own few.
   */
  private tools(agent: string, directory: string): ToolDefinition[] {
    // speak rides on the voice feedback setting; the rule itself lives with the registry.
    // bash's description is written for the shell the settings name (R16-C2).
    // session chat: the lab's switch takes its tools away from the next turn.
    const settings = this.config.get()
    const own = toolsForTurn(agent, { voiceFeedback: settings.voiceFeedback !== false, shell: settings.shell, sessionChat: settings.sessionChat, webSearch: settings.websearch !== false })
    if (hasOwnToolsOnly(agent)) return own
    return [...own, ...(this.mcp?.tools(directory) ?? [])]
  }

  /** The tools a conversation's request carries: its agent's, less what a subagent never gets. */
  private offeredTools(session: TurnSession): ToolDefinition[] {
    // OpenCode v2: a GPT model edits with patch, every other with edit and write (registry `usesPatch`).
    return forModel(this.tools(session.subagent?.type === "explore" ? "explore" : session.agent, session.directory), session.model.model).filter(
      (tool) => !session.parentID || !SUBAGENT_WITHHELD.has(tool.name),
    )
  }

  /** Whether the session's model comes from a user-added (custom) provider. */
  private isLocal(session: TurnSession): boolean {
    const custom = this.config.get().customProviders
    if (!custom?.length) return false
    const provider = session.model.provider
    return !!provider && custom.some((p) => p.id === provider)
  }

  private checkpointKey(sessionID: string, history: Message[]): string {
    for (let index = history.length - 1; index >= 0; index--) {
      const message = history[index]
      if (message?.role === "user") return `${sessionID}:${message.id}`
    }
    return sessionID
  }

  private checkpointFires(sessionID: string, history: Message[]): number {
    return this.checkpointFireCounts.get(this.checkpointKey(sessionID, history)) ?? 0
  }

  private noteCheckpointFire(sessionID: string, history: Message[]): void {
    const key = this.checkpointKey(sessionID, history)
    this.checkpointFireCounts.set(key, (this.checkpointFireCounts.get(key) ?? 0) + 1)
    while (this.checkpointFireCounts.size > 200) {
      const oldest = this.checkpointFireCounts.keys().next().value
      if (oldest === undefined) break
      this.checkpointFireCounts.delete(oldest)
    }
  }

  /**
   * This turn's copy of the conversation, run as the agent and model a slash
   * command named.
   *
   * Never written back, so the next message runs as the conversation is set
   * again - which is what MiMo's command does. A model whose provider is not
   * configured is ignored rather than failing the turn with it.
   */
  private withCommandTurn(session: SessionInfo, override: { agent?: TurnAgent; model?: SessionInfo["model"] } | undefined): TurnSession {
    if (!override) return session
    const named = override.model
    const model = named && this.config.definition(named.provider) && this.config.usable(named.provider) ? named : undefined
    if (!override.agent && !model) return session
    return { ...session, ...(override.agent ? { agent: override.agent } : {}), ...(model ? { model } : {}) }
  }

  /**
   * plan: where this conversation's plan is written, and which paths planning
   * may write at all.
   *
   * The folder depends on whether the project is a repository, as MiMo's does:
   * a repository keeps its plans with the code, and a folder that is not one
   * would be littered by them, so those go to the app's own folder instead.
   */
  private async planFor(session: SessionInfo): Promise<{ file: string; folders: string[] }> {
    // Bounded: one entry per folder ever opened, which on a long-lived profile is not a small number (N11-37).
    if (this.repos.size > 256) this.repos.clear()
    let repo = this.repos.get(session.directory)
    if (repo === undefined) {
      repo = (await gitStatus(session.directory).catch(() => undefined))?.repo === true
      this.repos.set(session.directory, repo)
    }
    const place = { directory: session.directory, dataRoot: this.dataRoot, repo }
    return { file: planFile(place, { created: session.created, slug: slugOf(session) }), folders: planFolders(place) }
  }

  /** plan: what a tool is told about planning - the mode it is in, its plan file, and how to leave. */
  private async planControl(session: SessionInfo): Promise<PlanControl> {
    const { file, folders } = await this.planFor(session)
    const began = this.turnAgents.get(session.id) ?? session.agent
    return {
      // The step's own mode, not the conversation's: approval lifts planning from the next step, not within the step that asked.
      agent: began,
      // Approved during this step: what it refuses, it refuses only until the step ends.
      switched: began === "plan" && session.agent !== "plan",
      file,
      writable: (target) => planWritable(target, folders),
      approve: () => this.approvePlan(session.id, file),
    }
  }

  /**
   * plan: the user approved the plan.
   *
   * Two things happen, and both have to, or the conversation and the window
   * would disagree about what it is: the conversation becomes a building one -
   * which is what the mode chip reads, and what the next turn's tools and
   * prompt are built from - and it is told the plan was approved, in the place
   * a message from the user would have gone. That word is the app's rather than
   * theirs, so the transcript leaves it out, as MiMo leaves its own out.
   */
  private async approvePlan(sessionID: string, file: string): Promise<void> {
    const session = await this.store.update(sessionID, { agent: "build" })
    const message: UserMessage = {
      id: Identifier.message(),
      sessionID,
      role: "user",
      text: approvedNote(planDisplay(session.directory, file)),
      attachments: [],
      synthetic: true,
      time: { created: Date.now() },
    }
    await this.store.saveMessage(message)
  }

  /**
   * plan: what this turn is told about planning, carried with the user's own
   * message as MiMo carries it.
   *
   * A conversation's first planning turn gets the long note with its plan
   * file's path, every later one a single line, and the first turn after the
   * switch is told it may build again - with the plan named when one was
   * actually written. A subagent gets none: it plans for its parent, and its
   * parent's turn carries the note.
   */
  private async planNote(session: SessionInfo, stored: readonly Message[]): Promise<string | undefined> {
    if (session.parentID) return undefined
    const planned = [...stored].reverse().find((message): message is AssistantMessage => message.role === "assistant")?.agent === "plan"
    if (session.agent !== "plan" && !planned) return undefined

    const { file } = await this.planFor(session)
    const display = planDisplay(session.directory, file)
    const exists = await access(file).then(
      () => true,
      () => false,
    )
    if (session.agent !== "plan") return [buildSwitchNote(), ...(exists ? [carryOutNote(display)] : [])].join("\n\n")
    if (planned) return laterPlanNote(display)
    // The folder is made now, so the model's first write lands rather than failing on a missing parent.
    await mkdir(dirname(file), { recursive: true }).catch(() => undefined)
    return firstPlanNote(display, exists)
  }

  /**
   * The recall hint for a step, when the conversation has any: its memory
   * folder holds something, or its task list has ever had a task. A
   * subagent's are its parent's, as its tasks are.
   */
  private async recallFor(session: TurnSession): Promise<string | undefined> {
    const rootID = session.parentID ?? session.id
    const notes = memoryFilesFor(session.directory, rootID)?.notes
    if (!notes) return undefined
    const folder = dirname(notes)
    const remembered = (await readdir(folder).catch((): string[] => [])).length > 0
    const tasked = remembered || ((await this.store.get(rootID))?.tasks ?? []).length > 0
    return tasked ? recallHint(folder, !session.parentID) : undefined
  }

  isRunning(sessionID: string): boolean {
    return this.running.has(sessionID)
  }

  /** Every session mid-turn, for a client that has just (re)connected. */
  /**
   * Sessions whose transcript is being summarised.
   *
   * Reported alongside the busy ones so a window that reconnects mid-summary
   * learns the truth rather than keeping whatever it last heard. A socket that
   * dropped during a compaction would otherwise show it running forever - the
   * event that ends it went out while nothing was listening.
   */
  compactingSessions(): string[] {
    return [...this.summarising]
  }

  /** The folders turns are running in right now (N11-36). */
  busyDirectories(): string[] {
    return [...new Set(this.workingIn.values())]
  }

  /** The turns waiting between attempts, for a window that reconnected into one (N11-17). */
  retryRows(): Record<string, { messageID: string; attempt: number; message: string; next: number; kind?: string; max?: number }> {
    return Object.fromEntries(this.retrying)
  }

  busySessions(): string[] {
    return [...this.running.keys()]
  }

  abort(sessionID: string): void {
    // subagents: Stop on a conversation stops the subagents working for it first.
    for (const child of [...(this.children.get(sessionID) ?? [])]) this.abort(child)
    this.running.get(sessionID)?.abort()
    // ...and the requests that are not the turn: the title, and Smart's routing question.
    for (const controller of [...(this.background.get(sessionID) ?? [])]) controller.abort()
    this.pressured.delete(sessionID)
    this.promptAnchors.delete(sessionID)
    this.permissions.rejectAll(sessionID)
    /*
     * Stopping a turn has to settle its question too. The tool is parked on a
     * promise that nothing else resolves, so without this the abort would tear
     * down the stream while the form stayed on screen answering into a turn
     * that no longer exists - and the session would keep reporting itself busy.
     */
    this.questions.rejectAll(sessionID)
  }

  /**
   * Holds a controller for work that is not this conversation's turn, so Stop
   * reaches it, and gives back the way to let it go.
   */
  private hold(sessionID: string, controller: AbortController): () => void {
    const held = this.background.get(sessionID) ?? new Set<AbortController>()
    this.background.set(sessionID, held)
    held.add(controller)
    return () => {
      held.delete(controller)
      if (held.size === 0) this.background.delete(sessionID)
    }
  }

  /**
   * The history the model is given.
   *
   * After a compaction everything up to the mark is represented by one summary
   * message instead of verbatim. The stored transcript is untouched - the point
   * is to shrink the context, not to lose the conversation.
   */
  /**
   * The conversation as it now stands.
   *
   * Rolled back messages are still on disk, so that they can be put back, but
   * they are no longer part of the conversation. Anything that reads the
   * transcript to act on it has to stop at the boundary: sending them would
   * make the model answer as though the rollback had not happened, and
   * summarising over them would fold an abandoned branch into the summary that
   * replaces the conversation.
   */
  private liveMessages(session: TurnSession, messages: Message[]): Message[] {
    if (!session.revert) return messages
    const boundary = messages.findIndex((message) => message.id === session.revert?.messageID)
    return boundary < 0 ? messages : messages.slice(0, boundary)
  }

  private contextFor(session: TurnSession, messages: Message[]): Message[] {
    // subagents: a subagent call saved before the actor rename is sent as the actor call it is now.
    messages = this.liveMessages(session, messages).map(readLegacyMessage)

    const mark = session.compacted
    if (!mark) return messages
    const at = messages.findIndex((message) => message.id === mark.messageID)
    // A mark for a message that is gone means the session was edited under us;
    // sending everything is the safe direction.
    if (at < 0) return messages

    // MiMo's projection: the summary tagged with its trigger, and the files it had been working on.
    const summary: UserMessage = {
      id: `${mark.messageID}:summary`,
      sessionID: session.id,
      role: "user",
      text: compactedText(mark),
      attachments: [],
      time: { created: mark.at },
    }
    const after = messages.slice(at + 1)
    // Nothing re-posted after an automatic or overflow compaction: the model is told to carry on.
    if (after.length || (mark.trigger ?? "manual") === "manual") return [summary, ...after]
    const carryOn: UserMessage = {
      id: `${mark.messageID}:continue`,
      sessionID: session.id,
      role: "user",
      text: continueNote(mark.trigger ?? "automatic"),
      attachments: [],
      time: { created: mark.at },
    }
    return [summary, carryOn]
  }

  /**
   * What a turn is doing to the filesystem, gathered while it runs.
   *
   * Two accounts are kept because neither covers the other. `told` is what the
   * edit and write tools reported as they wrote, which is byte-exact and works
   * for files outside the project as well as in it. `watching` is the whole
   * project photographed at the start of the turn, which is the only way to see
   * what a shell command or an MCP server did.
   */
  private readonly pending = new Map<string, Turn>()

  private turn(sessionID: string): Turn {
    let turn = this.pending.get(sessionID)
    if (!turn) {
      turn = { told: new Map(), opaque: false, messages: [] }
      this.pending.set(sessionID, turn)
    }
    return turn
  }

  private async record(sessionID: string, target: string): Promise<void> {
    const turn = this.turn(sessionID)
    const key = pathKey(target)
    /*
     * Told to the recording as well as kept here. Two conversations can be
     * mid-turn in one project, and a file one of their tools named is the one
     * thing that says which of them changed it.
     */
    turn.watching?.claim(target)
    // A path recorded twice keeps its first reading, because the state to
    // return to is the one the turn began from, not the one the last edit did.
    if (turn.told.has(key)) return
    /*
     * The body goes to the project's checkpoint store and only the reference is
     * held here, so a turn that rewrites a large file no longer puts that file
     * into the conversation's own undo document.
     */
    turn.told.set(key, await keepSnapshotFile(this.snapshots, turn.directory, target))
  }

  /**
   * Hands the turn's recording to the store, and starts a fresh one.
   *
   * The two accounts are merged rather than chosen between: the project scan
   * covers everything git can see, and what the tools reported covers the rest,
   * which is anything git ignores and anything outside the project. Where both
   * hold a file the reported one wins, because those are the exact bytes this
   * app replaced.
   */
  private async commitSnapshot(sessionID: string): Promise<void> {
    const turn = this.pending.get(sessionID)
    this.pending.delete(sessionID)
    if (!turn) return

    const watched = turn.watching ? await turn.watching.finish() : undefined

    const files = new Map<string, SnapshotFile>()
    for (const file of watched?.files ?? []) files.set(pathKey(file.path), file)
    for (const [key, file] of turn.told) files.set(key, file)

    /*
     * A scan that could not be made only matters if something ran that this app
     * cannot otherwise account for. A turn of nothing but edits is still fully
     * described by what the tools reported, even on a machine without git.
     */
    let blocked: string | undefined
    if (watched?.refused) blocked = watched.refused
    else if (turn.opaque && !turn.watching) {
      blocked = "This turn was not recorded for undo, so it cannot be taken back."
    } else if (turn.opaque) blocked = watched?.unavailable
    /*
     * A file whose contents could not be taken blocks the turn whatever the
     * scan said. Filing it as an ordinary turn would leave an entry that, on
     * undo, deletes that file instead of restoring it (R25-A1).
     */
    if (!blocked) {
      const lost = [...files.values()].find((file) => file.unreadable !== undefined)
      if (lost) blocked = `${lost.unreadable}, so this turn cannot be taken back.`
    }

    // A turn that changed nothing does not take up a place in the history.
    if (!blocked && files.size === 0) return
    const at = Date.now()
    /*
     * Which conversation left each file as it now stands. An undo in another
     * conversation reads this and refuses rather than writing over what this
     * turn did afterwards - the project has one set of files and several
     * conversations, and only this says whose work is on top of it.
     */
    if (turn.directory && !blocked) {
      await this.snapshots.wrote(turn.directory, sessionID, at, [...files.values()].map((file) => file.path))
    }
    await this.store.pushSnapshot(sessionID, {
      at,
      files: blocked ? [] : [...files.values()],
      blocked,
      messages: turn.messages,
      /*
       * Where this turn's bodies were kept, and how big it was - MiMo's
       * `summary_files` / `summary_additions` / `summary_deletions`. The
       * snapshot no longer holds anything that could be counted later, so the
       * count is taken now, and the store is named so a restore knows where to
       * look even if the conversation is moved afterwards.
       */
      ...(turn.directory ? { directory: turn.directory } : {}),
      ...(blocked
        ? {}
        : {
            summary: {
              files: files.size,
              ...(watched?.additions !== undefined ? { additions: watched.additions } : {}),
              ...(watched?.deletions !== undefined ? { deletions: watched.deletions } : {}),
            },
          }),
    })
  }

  /**
   * Puts the last recorded turn back.
   *
   * Only the files that turn changed are touched, whether a tool changed them
   * or a shell command did, and only to the contents they held when the turn
   * began. A file the turn never went near is left alone even if it has changed
   * since; a file the turn did change is put back even if the user has edited
   * it since, which is what "undo my last turn" has to mean to be useful.
   *
   * A steered message the model has taken starts a turn of its own, as MiMo
   * 26.914 shows it: the recording up to that step is filed as the turn before,
   * and a new one opens for the steer. So "the last turn" is what the model did
   * after the last thing the user said, and an undo takes back only that.
   */
  async undo(sessionID: string): Promise<number> {
    /*
     * A turn in flight is still writing messages and files. Summarising over it
     * would mark a boundary against a message that is not finished, and undoing
     * it would fight the tool that is mid-write.
     */
    if (this.running.has(sessionID)) throw new CodedError("Wait for the current turn to finish", "error.sessionBusy")
    const snapshot = await this.store.peekSnapshot(sessionID, "undo")
    if (!snapshot) throw new Error("Nothing to undo")
    /*
     * Left where it is rather than dropped. Undoing the turn before this one
     * would put files back to a state that never existed, since whatever this
     * turn did is still on top of them, and would report a file count for it.
     */
    if (snapshot.blocked) throw new Error(snapshot.blocked)
    await this.guardOthers(sessionID, snapshot.at, snapshot.files)
    // Restore first: if this throws, both stacks are still as they were and the
    // same undo can be tried again.
    const swapped = await this.restore(snapshot)
    /*
     * The turn's own record, with the files swapped for what they replaced.
     * Only `files` differs: `directory` names the checkpoint store both sides
     * of the swap live in, and without it a redo has no store to read the
     * bodies back from; `messages` is what a rollback needs to know which turn
     * a message belongs to. Rebuilding the entry from `at` and `files` alone
     * dropped both, so every redo failed and the entry stuck on the stack.
     */
    await this.store.moveSnapshot(sessionID, "undo", "redo", { ...snapshot, files: swapped })
    await this.noteRestore(sessionID, snapshot.files)
    return snapshot.files.length
  }

  /**
   * Moves the conversation's rollback boundary, taking the project with it.
   *
   * The transcript is messages and the project is files, and the whole of this
   * is keeping the two saying the same thing. A message names a point in the
   * conversation; a recorded turn names a point the files can actually be
   * returned to; and those are not always the same point, because a turn that
   * was steered answered several messages with no state on disk in between.
   * So the boundary asked for is a request, and the boundary that comes back is
   * where the files could be put - never further forward than the earliest turn
   * still rolled back, and never further back than the last turn restored.
   *
   * Aimed at a message the recording no longer reaches, this refuses rather
   * than moving the transcript on its own. A conversation that says three
   * messages have been rolled back, over a project that still carries their
   * changes, is worse than being told it cannot be done.
   *
   * @param messageID the first message to roll back, or nothing to restore
   *   everything currently rolled back.
   * @returns the session as it now stands and how many files were written.
   */
  async revert(sessionID: string, messageID?: string): Promise<{ session: SessionInfo; files: number }> {
    /*
     * A turn in flight is still writing messages and files. Moving the boundary
     * under it would cut the transcript at a message that is still being
     * answered, and put files back while a tool is mid-write.
     */
    if (this.running.has(sessionID)) throw new CodedError("Wait for the current turn to finish", "error.sessionBusy")
    const session = await this.store.require(sessionID)
    const stored = await this.store.messages(sessionID)
    const order = new Map(stored.map((message, at) => [message.id, at]))

    let target = messageID === undefined ? stored.length : order.get(messageID)
    if (target === undefined) throw new Error("That message is no longer in this conversation")
    /** Where the boundary stands now, so the direction of travel is knowable. */
    const before = session.revert ? (order.get(session.revert.messageID) ?? stored.length) : stored.length

    /*
     * Turns older than the undo stack holds cannot be put back, and the floor
     * is where that begins. Checked before anything is written, so a refusal
     * leaves the conversation exactly as it was.
     */
    if (messageID !== undefined) {
      const floor = await this.store.floor(sessionID)
      const at = floor === undefined ? undefined : order.get(floor)
      if (at !== undefined && target <= at) {
        throw new Error(
          "This session's file history no longer reaches back that far, so the project cannot be put back to that message",
        )
      }
    }

    let files = 0

    /*
     * Forwards first: every rolled back turn that begins before the target goes
     * back on the project. Each is committed as it lands, so a write that fails
     * part way leaves a boundary that still describes what is on disk.
     *
     * A turn that was steered began before the target and reaches past it, and
     * it comes back whole - half a turn is not a state the project was ever in.
     * `restoredTo` is how far it reached, and the target moves out to meet it so
     * that the pass below does not simply take back what has just been put on.
     */
    let restoredTo = -1
    while (true) {
      const step = (await this.store.reverted(sessionID))[0]
      if (!step) break
      const at = order.get(step.messageID)
      if (at === undefined || at >= target) break
      await this.guardOthers(sessionID, step.snapshot.at, step.swapped)
      await this.write(step.swapped, step.snapshot.directory)
      await this.noteRestore(sessionID, step.swapped)
      files += step.swapped.length
      for (const id of step.messages) restoredTo = Math.max(restoredTo, (order.get(id) ?? -1) + 1)
      await this.store.putBack(sessionID)
    }
    if (restoredTo > target) target = restoredTo

    /*
     * Backwards: every recorded turn that answered anything at or after the
     * target comes off the project. Peeked before it is taken, so a turn that
     * cannot be put back leaves both the stack and the files untouched.
     */
    while (true) {
      const snapshot = await this.store.peekSnapshot(sessionID, "undo")
      if (!snapshot) break
      /*
       * A turn recorded before this app knew which messages a turn answered.
       * There is no way to tell whether it is inside the range being rolled
       * back, so there is no way to move the transcript past it and still be
       * telling the truth about the files. It only stands in the way when the
       * rollback actually reaches this far down the stack.
       */
      if (!snapshot.messages?.length) {
        throw new Error(
          "This part of the conversation was recorded before messages could be rolled back, so the project cannot be put back to it",
        )
      }
      const reaches = snapshot.messages.some((id) => (order.get(id) ?? -1) >= target)
      if (!reaches) break
      if (snapshot.blocked) throw new Error(snapshot.blocked)
      await this.guardOthers(sessionID, snapshot.at, snapshot.files)
      const swapped = await this.restore(snapshot)
      await this.noteRestore(sessionID, snapshot.files)
      files += snapshot.files.length
      await this.store.takeBack(sessionID, {
        messageID: snapshot.messages[0],
        messages: snapshot.messages,
        snapshot,
        swapped,
      })
    }

    /*
     * Where the boundary ends up, which is not always where it was asked for.
     *
     * It cannot sit later than the earliest turn still rolled back, or messages
     * would show whose changes are off the project; and the search for a user
     * message is what keeps it from landing inside a turn, on a reply whose own
     * question is still on screen.
     */
    const remaining = await this.store.reverted(sessionID)
    const first = remaining[0] ? order.get(remaining[0].messageID) : undefined
    let boundary = target
    if (first !== undefined && first < boundary) boundary = first
    const at = stored.slice(boundary).find((message) => message.role === "user")

    /*
     * Going back withdraws the offer to redo. A turn on the redo stack was
     * taken back by an ordinary undo, with its messages left on screen, and
     * once the boundary is in front of those messages that offer would write
     * files for a turn the reader can no longer see.
     */
    if (boundary < before) await this.store.forgetRedo(sessionID)

    const revert = at ? { messageID: at.id, at: Date.now() } : undefined
    return { session: await this.store.update(sessionID, { revert }), files }
  }

  /**
   * Makes a rollback permanent, because the conversation has moved on.
   *
   * Called when a rolled back session is prompted again. The rolled back
   * messages are removed rather than left hidden: they are no longer a state
   * anyone can return to, and leaving them on disk would mean a transcript that
   * disagreed with itself the next time it was read.
   */
  private async commitRevert(session: SessionInfo): Promise<SessionInfo> {
    const boundary = session.revert?.messageID
    if (!boundary) return session
    const stored = await this.store.messages(session.id)
    const at = stored.findIndex((message) => message.id === boundary)
    if (at >= 0) {
      // By what is on disk, not by what could be read: see SessionStore.messageIDs.
      const ids = await this.store.messageIDs(session.id)
      const from = ids.indexOf(boundary)
      for (const id of from >= 0 ? ids.slice(from) : stored.slice(at).map((message) => message.id)) {
        await this.store.deleteMessage(session.id, id)
      }
    }
    await this.store.dropReverted(session.id)
    // The deleted messages may carry reminders of instruction changes; the next turn sets a fresh baseline, as v2's committed revert does.
    const updated = await this.store.update(session.id, { revert: undefined, instructions: undefined })
    this.bus.publish({ type: "session.reverted", sessionID: session.id })
    return updated
  }

  /**
   * MiMo's edit and retry: the messages from one on are deleted and nothing
   * else moves. Files the later turns changed stay as they are - each turn's
   * card still offers its own 撤销 - which is why no snapshot is consulted and
   * the rollback's history floor does not apply.
   *
   * A rollback still standing from before is made permanent first, so the
   * transcript has one boundary and not two. A summary whose mark was among
   * the deleted messages summarised them, so it goes with them.
   */
  async truncate(sessionID: string, messageID: string): Promise<SessionInfo> {
    if (this.running.has(sessionID)) throw new CodedError("Wait for the current turn to finish", "error.sessionBusy")
    let session = await this.store.require(sessionID)
    if (session.revert) session = await this.commitRevert(session)
    const stored = await this.store.messages(sessionID)
    const at = stored.findIndex((message) => message.id === messageID)
    if (at < 0) throw new Error("That message is no longer in this conversation")
    const kept = new Set(stored.slice(0, at).map((message) => message.id))
    // By what is on disk, not by what could be read: see SessionStore.messageIDs.
    const ids = await this.store.messageIDs(sessionID)
    const from = ids.indexOf(messageID)
    for (const id of from >= 0 ? ids.slice(from) : stored.slice(at).map((message) => message.id)) {
      await this.store.deleteMessage(sessionID, id)
    }
    // subagents: the subagents the deleted turns started go with them.
    for (const child of await this.store.list()) {
      if (child.parentID !== sessionID || !child.parentMessageID || kept.has(child.parentMessageID)) continue
      // A background one may still be working; it is stopped quietly first.
      await this.stopSubagent(child.id)
      await this.store.delete(child.id)
    }
    if (session.compacted && !kept.has(session.compacted.messageID)) {
      session = await this.store.update(sessionID, { compacted: undefined })
    }
    // And the reminders of instruction changes the deleted messages carried: the next turn sets a fresh baseline.
    if (session.instructions) session = await this.store.update(sessionID, { instructions: undefined })
    return session
  }

  /** Puts back what undo took away. */
  async redo(sessionID: string): Promise<number> {
    /*
     * A turn in flight is still writing messages and files. Summarising over it
     * would mark a boundary against a message that is not finished, and undoing
     * it would fight the tool that is mid-write.
     */
    if (this.running.has(sessionID)) throw new CodedError("Wait for the current turn to finish", "error.sessionBusy")
    const snapshot = await this.store.peekSnapshot(sessionID, "redo")
    if (!snapshot) throw new Error("Nothing to redo")
    await this.guardOthers(sessionID, snapshot.at, snapshot.files)
    const swapped = await this.restore(snapshot)
    // The same swap the other way; see undo() for why the rest of the record goes with it.
    await this.store.moveSnapshot(sessionID, "redo", "undo", { ...snapshot, files: swapped })
    await this.noteRestore(sessionID, snapshot.files)
    return snapshot.files.length
  }

  /**
   * Swaps the recorded contents with what is on disk, and hands back what was
   * there before.
   *
   * That return value is what makes undo and redo the same operation: restoring
   * a snapshot produces a snapshot of the state it replaced. The caller files
   * it, once this has finished - a restore that throws part way must not leave
   * the stacks holding neither.
   */
  private async restore(snapshot: Snapshot): Promise<SnapshotFile[]> {
    return this.write(snapshot.files, snapshot.directory)
  }

  /**
   * Writes recorded contents back over what is there, handing back what was.
   *
   * `directory` names the checkpoint store the recorded bodies are in, and is
   * where the state being replaced is kept in turn - so the swap that makes
   * undo and redo one operation costs a reference each way rather than two
   * copies of every file.
   */
  private async write(files: SnapshotFile[], directory?: string): Promise<SnapshotFile[]> {
    // Under the project's lock, so no turn's photograph lands half way through (N11-15).
    return directory ? withProjectLock(directory, () => this.writeNow(files, directory)) : this.writeNow(files, directory)
  }

  private async writeNow(files: SnapshotFile[], directory?: string): Promise<SnapshotFile[]> {
    const swapped: SnapshotFile[] = []
    for (const file of files) {
      const swap = await keepSnapshotFile(this.snapshots, directory, file.path)
      /*
       * What is on disk now is the other half of the swap - it is what a redo
       * puts back. Recorded as "there was nothing here", a redo would delete
       * the file, so a body that cannot be taken stops the restore instead
       * (R25-A1), the same way an unanswerable store body does below.
       */
      if (swap.unreadable !== undefined) throw new Error(`${swap.unreadable}, so this turn cannot be put back`)
      swapped.push(swap)
      // "Did not exist" in either shape: a checkpoint reference of null, or a legacy body of null.
      const absent = file.blob !== undefined ? file.blob === null : file.content === null
      if (absent) {
        await rm(file.path, { force: true })
        continue
      }
      /*
       * A body the store can no longer answer for stops the restore rather than
       * emptying the file. Writing nothing in place of something is the one
       * outcome worse than saying the turn cannot be put back.
       */
      const bytes = await snapshotBytes(this.snapshots, directory, file)
      if (bytes === undefined) {
        throw new Error(`${file.path} could not be read back from this conversation's undo store, so this turn cannot be put back`)
      }
      await mkdir(dirname(file.path), { recursive: true })
      // Written as bytes rather than as a string: a snapshot may stand for a file
      // that is not text at all, and encoding it on the way out would change it.
      await writeFile(file.path, bytes)
    }
    return swapped
  }

  /**
   * Refuses a restore that would take another conversation's work with it.
   *
   * Undo's promise is that the files go back to how the turn found them, and it
   * keeps that promise over the user's own later edits on purpose. What it
   * cannot do is keep it over another conversation working in the same project:
   * that conversation's turn is not on this one's stack, its own card still
   * offers to take it back, and writing over it here would leave both
   * transcripts describing a project neither of them matches.
   */
  private async guardOthers(sessionID: string, at: number, files: SnapshotFile[]): Promise<void> {
    const directory = (await this.store.get(sessionID))?.directory
    if (!directory) return
    const clashes = await this.snapshots.writtenSince(
      directory,
      sessionID,
      at,
      files.map((file) => file.path),
    )
    if (!clashes.length) return
    const rest = clashes.length > 1 ? ` (and ${clashes.length - 1} more)` : ""
    throw new Error(`Another conversation has changed ${clashes[0]}${rest} since this turn, so taking it back would undo that work too`)
  }

  /**
   * A turn's 撤销 from the "edited N files" card (N11-13).
   *
   * It checked only that its own conversation was idle. Undo and redo also
   * refuse to take another conversation's later work with them, and record the
   * restore so the next one to look sees it; this did neither, so it could put
   * back a file another conversation had changed since. It now does both, and
   * does its writing under the project's lock as they do (N11-15).
   */
  async revertTurn(sessionID: string, messages: Message[]): Promise<Awaited<ReturnType<typeof revertTurnFiles>>> {
    if (this.isRunning(sessionID)) throw new CodedError("Wait for the current turn to finish", "error.sessionBusy")
    const session = await this.store.require(sessionID)
    const paths = turnFilePaths(session.directory, messages)
    const since = Math.min(...messages.map((message) => message.time.created))
    const files = paths.map((path) => ({ path }) as SnapshotFile)
    await this.guardOthers(sessionID, Number.isFinite(since) ? since : Date.now(), files)
    const result = await withProjectLock(session.directory, () => revertTurnFiles(session.directory, messages))
    if (result.restored + result.removed > 0) await this.noteRestore(sessionID, files)
    return result
  }

  /** A restore is a write like any other, so the next conversation to look sees it. */
  private async noteRestore(sessionID: string, files: SnapshotFile[]): Promise<void> {
    if (!files.length) return
    const directory = (await this.store.get(sessionID))?.directory
    if (!directory) return
    await this.snapshots.wrote(
      directory,
      sessionID,
      Date.now(),
      files.map((file) => file.path),
    )
  }

  /**
   * Summarises the conversation so far and marks it as the new starting point.
   *
   * Asked of the session's own model, with no tools: this is a reading task,
   * and a model that could act here might decide to.
   */
  /**
   * Compacts on request: the transcript so far becomes one summary, and the
   * model's view from then on begins with it.
   *
   * Refused while a turn is running, and holds the running slot itself while
   * the summary streams - so a prompt sent during a compaction is refused the
   * same way, and Stop cancels the summary like any other request.
   */
  async compact(sessionID: string): Promise<SessionInfo> {
    if (this.running.has(sessionID)) throw new CodedError("Wait for the current turn to finish", "error.sessionBusy")
    const session = await this.store.require(sessionID)
    const controller = new AbortController()
    this.running.set(sessionID, controller)
    try {
      return await this.compactNow(session, controller.signal, "manual")
    } finally {
      this.running.delete(sessionID)
      this.bus.publish({ type: "session.idle", sessionID })
    }
  }

  /**
   * The system prompt a conversation's requests carry: built once and reused,
   * as MiMo's prefix snapshot is, so a new file or a changed working tree does
   * not start its cache over. Rebuilt only when what it was built for changes -
   * the agent, the mode, the instructions, the tools or the skills. The model
   * is not among them: no section of the prompt names it any more, since the
   * environment block went. A compaction sends the same one, so its request
   * reads from that cache too.
   *
   * memory: a conversation's own turns are told about its memory files, a
   * subagent's are not, as MiMo does. That text names this conversation's notes
   * file, so it goes as a tail after the prefix rather than inside it: the
   * prefix stays the same from one conversation to the next.
   */
  private async systemFor(session: TurnSession): Promise<{ system: string; systemTail?: string }> {
    const config = this.config.get()
    const skills = await this.skillsFor(session.directory)
    /*
     * OpenCode v2's instruction deltas. What the instructions say now is read
     * on every turn - an AGENTS.md edited mid-conversation used to go unseen
     * until the app restarted, since only the names of the settings were
     * watched - but the prompt is built from the conversation's baseline, and
     * a change is told to the model at the point it happened instead of
     * rewriting the prefix the provider has cached.
     */
    const values = await instructionValues({
      directory: session.directory,
      agent: session.agent,
      instructions: config.instructions,
      globalAgentsFile: this.globalAgents,
      instructionFiles: config.instructionFiles,
      skills,
      skillsFolder: path.join(this.dataRoot, "skills"),
      fetchInstruction: (url) => this.fetchInstructionCached(url),
    })
    const initial = await this.syncInstructions(session.id, values)
    const local = this.isLocal(session)
    const key = JSON.stringify([
      session.agent,
      initial,
      local,
      promptFamily(session.model.model),
      this.tools(session.subagent?.type === "explore" ? "explore" : session.agent, session.directory).map((tool) => tool.name),
    ])
    const frozen = this.prefixes.get(session.id)
    const base = frozen?.key === key ? frozen.system : systemPromptFrom(session.agent, initial, undefined, { local, modelID: session.model.model })
    this.prefixes.set(session.id, { key, system: base })
    // subagents: a subagent is told what it is, after what its agent would be told anyway.
    const outputSchema = session.subagent?.outputSchema
    if (session.parentID) {
      return { system: [base, SUBAGENT_NOTE, ...(outputSchema ? [STRUCTURED_NOTE] : session.subagent?.type === "general" ? [RETURN_NOTE] : [])].join("\n\n") }
    }
    const memory = memoryFilesFor(session.directory, session.id)
    /*
     * 追求目标: one line telling the model to work the goal to its end, beside
     * the memory note rather than inside the cached prefix - a goal set or met
     * mid-conversation would otherwise start the provider's cache over.
     *
     * Left out in plan mode, as MiMo leaves it out: planning is meant to stop
     * and show a plan, which is the one thing this line forbids.
     */
    const pursuing = session.goal && !session.goal.done && session.agent !== "plan" ? [GOAL_GUARD] : []
    const tail = [...(memory ? [memorySection(memory)] : []), ...pursuing]
    return tail.length ? { system: base, systemTail: tail.join("\n\n") } : { system: base }
  }

  /**
   * The compaction itself, for the button above and for a turn that has
   * outgrown its model (see `run`).
   *
   * MiMo's shape: the conversation as the model currently sees it is replayed
   * with its own system prompt and tools, and one instruction is added at the
   * end. Calling a tool is not allowed while summarising; the output cap is the
   * model's usual one. For an overflow the attached files are left out, since
   * they are what made it too large. A reply that is empty, not a summary, a
   * tool call, or itself too large leaves the conversation as it was.
   *
   * `boundary` is the last message the summary is to cover, for a caller that
   * is compacting with a newer message already in the conversation - a turn
   * compacting because the reply before it crossed the line has the user's new
   * request sitting at the end. Marking there would put that request behind the
   * mark, where `contextFor` never sends it, and the turn would answer a
   * question the model was never shown. Left out, the mark falls at the end, as
   * it does for the button and for an overflow.
   */
  private async compactNow(session: TurnSession, signal: AbortSignal, trigger: CompactionTrigger, boundary?: string): Promise<SessionInfo> {
    const stored = await this.store.messages(session.id)
    const live = this.liveMessages(session, stored)
    let seen = this.contextFor(session, stored)
    const cut = boundary ? seen.findIndex((message) => message.id === boundary) : -1
    // Summarising past the boundary would describe the request as work already done.
    if (cut >= 0) seen = seen.slice(0, cut + 1)
    const last = cut >= 0 ? live.find((message) => message.id === boundary) : live.at(-1)
    // skills: what a message loaded is part of the conversation being summarised.
    const context = withSkillReminders(withAutomationNotes(withChatHeaders(seen)))
    if (!last || !context.some((message) => message.role === "user")) throw new Error("Nothing to compact yet")
    /*
     * OpenCode v2's rolling compaction: the newest exchanges within
     * RECENT_KEEP tokens are kept word for word beside the summary, and only
     * what came before them is sent to be summarised. A conversation already
     * compacted opens with that checkpoint, and the model updates it rather
     * than summarising a summary.
     */
    const split = splitConversation(context)
    if (!split || split.older.length === 0) throw new Error("Nothing to compact yet")
    const update = split.older.some(isCheckpoint)
    const prompt = summaryPrompt(update, update && session.compacted !== undefined && legacySummary(session.compacted.summary))

    const definition = this.config.definition(session.model.provider)
    if (!definition) throw new CodedError(`No provider called ${session.model.provider} is set up`, "error.noModel")
    const adapter: ProviderAdapter = adapterFor(definition.kind)
    const apiKey = this.config.apiKey(definition.id) ?? ""
    const tokens = definition.kind === "chatgpt" ? await this.auth.accessToken(definition.id) : undefined
    const entry = this.config.modelEntry(session.model)
    /*
     * MiMo's shrink: the summary request is sent exactly when the conversation
     * has outgrown its model, so replaying every large tool result in full made
     * the request most likely to be refused for length the largest one sent.
     */
    const replay = shrinkLargeToolResults(
      trigger === "provider-overflow" ? withoutAttachments(split.older) : await withAttachmentData(split.older, session.directory, new Map()),
    )
    const instruction: UserMessage = {
      id: `${session.id}:compaction`,
      sessionID: session.id,
      role: "user",
      text: prompt,
      attachments: [],
      time: { created: Date.now() },
    }

    let reported: Usage | undefined
    const system = await this.systemFor(session)
    const offered = this.offeredTools(session)
    /** One summary request over this history; what it wrote, and whether it reached for a tool instead. */
    const ask = async (history: Message[]): Promise<{ text: string; called: boolean }> => {
      let text = ""
      let called = false
      const outcome = await adapter.stream(
        {
          apiKey: tokens?.access ?? apiKey,
          model: session.model,
          ...system,
          history,
          tools: offered,
          // Out of band: a summary is not worth a reasoning budget either, so MiMo's cheap profile rather than the app-wide level.
          ...smallRequest(session.model.provider, session.model.model),
          variants: this.config.variants(session.model),

          signal,
          baseURL: definition.baseURL,
          headers: definition.headers,
          accountId: tokens?.accountId,
          /*
           * OpenCode v2's summary cap, then fitted to the window. With no
           * margin on the estimate: the history was cut to 90% of the window
           * by this same estimate, and 1.15 on top of that is over the whole
           * window, which left every large summary 4096 tokens. A request the
           * estimate undersold is refused and squeezed below, as before.
           */
          maxOutput: fitOutput(Math.min(maxOutputTokens(session.model, entry), SUMMARY_OUTPUT_MAX), entry, {
            measured: requestTokens({ system: system.system, systemTail: system.systemTail, tools: offered, history }),
            estimated: 0,
          }),
          outputLimit: entry?.maxOutput,
          sessionID: session.id,
          cacheTTL: entry?.cacheTTL,
          inputs: modelInputs(entry),
          sampling: samplingFor(session.model.model, entry?.temperature === true),
          // The provider's own fields, then the cheap profile's on top - the spread above set `extra` and this replaces it.
          extra: { ...providerExtras(session.model.provider, entry?.reasoning === true, session.id), ...smallRequest(session.model.provider, session.model.model).extra },
        },
        (event) => {
          if (event.type === "text.delta") text += event.text
          if (event.type === "tool") called = true
        },
      )
      if (outcome.toolCalls.length) called = true
      // The first request's count is the one the ring's estimate scales from; a nudge re-sends the same history.
      reported ??= outcome.usage
      this.noteBackground(session.id, session.model, outcome.usage, "compaction")
      return { text, called }
    }

    let summary = ""
    /*
     * OpenCode v2's delivery: a summary request estimated too large for the
     * model is squeezed - the conversation after any checkpoint becomes one
     * text message, and whole exchanges go, oldest first - rather than sent to
     * be refused. Estimates can be wrong, so until the provider refuses, a
     * request that cannot be squeezed is sent as it is; after a refusal the
     * next attempts aim at 70%, 50% and 35% of the first refused request, and
     * only a refusal after those gives up. MCode gave up at the first.
     *
     * One adaptation: v2 scales the whole request, and its system prompt is a
     * dozen lines. MCode's prompt and tool schemas run to tens of thousands of
     * tokens, which cannot shrink, so 70% of the whole left no room for the
     * conversation at all and the first squeeze gave up - measured. The steps
     * scale the conversation part only.
     */
    const fixed = estimateTokens(system.system) + estimateTokens(system.systemTail) + estimateTokens(JSON.stringify(offered))
    const usable = usableContext(entry) || Math.floor(UNKNOWN_WINDOW * COMPACTION_TRIGGER_RATIO)
    let room = usable - estimateTokens(prompt) - estimateTokens(SUMMARY_NUDGE) - fixed
    let refused: number | undefined
    let sent: Message[] = replay
    this.summarising.add(session.id)
    this.promptAnchors.delete(session.id)
    this.bus.publish({ type: "session.compacting", sessionID: session.id, active: true })
    try {
      for (let rejections = 0; ; ) {
        const history = messagesTokens(replay) <= room ? replay : (flattenOldest(replay, room, session.id) ?? (rejections > 0 ? undefined : replay))
        if (!history) throw new Error("This conversation is too large to compact")
        sent = history
        try {
          const first = await ask([...history, instruction])
          summary = first.called ? "" : extractSummary(first.text)
          /*
           * OpenCode v2 gives a reply that skipped the template one reminder
           * before it counts as a failure: a model that carried on with the
           * task, or answered in prose, usually writes the summary when told
           * plainly.
           */
          if (!summary || !isSummary(summary)) {
            const nudge: UserMessage = { ...instruction, id: `${session.id}:compaction-nudge`, text: SUMMARY_NUDGE }
            const reply: AssistantMessage = {
              id: `${session.id}:compaction-reply`,
              sessionID: session.id,
              role: "assistant",
              model: session.model,
              parts: first.text ? [{ type: "text", id: Identifier.part(), text: first.text }] : [],
              time: { created: Date.now(), completed: Date.now() },
            } as AssistantMessage
            const second = await ask([...history, instruction, reply, nudge])
            if (second.called) throw new Error("The model called a tool instead of writing a summary")
            summary = extractSummary(second.text)
          }
          break
        } catch (failure) {
          if (!isOverflowError(failure, describe(failure))) throw failure
          const step = SHRINK_STEPS[rejections]
          if (step === undefined) throw new Error("This conversation is too large to compact")
          refused ??= messagesTokens(history)
          room = Math.floor(refused * step)
          rejections += 1
        }
      }
    } finally {
      this.summarising.delete(session.id)
      this.bus.publish({ type: "session.compacting", sessionID: session.id, active: false })
    }
    if (!summary) throw new Error("The model returned an empty summary")
    if (!isSummary(summary)) throw new Error("The model did not return a summary")
    const files = touchedFiles(context, session.directory)
    const mark = { messageID: last.id, summary, ...(split.recent ? { recent: split.recent } : {}), at: Date.now(), trigger, ...(files.length ? { files } : {}) }
    /*
     * What the ring should say now, rather than after the next turn: the next
     * request is the system prompt, the tools, the summary, and whatever
     * arrived after the boundary (or MiMo's note to carry on, when nothing did).
     */
    const after = live.slice(live.findIndex((message) => message.id === last.id) + 1)
    const opening = estimateTokens(compactedText(mark)) + (after.length || trigger === "manual" ? messagesTokens(after) : estimateTokens(continueNote(trigger)))
    const counted = reported ? reported.input + reported.cacheRead + reported.cacheWrite : 0
    const estimate = nextRequestEstimate(fixed, messagesTokens([...sent, instruction]), opening, counted)
    /*
     * OpenCode v2 starts a new instruction epoch at a compaction: the prompt
     * is starting over anyway, so its baseline becomes what the model was
     * last told, and the reminders of changes it replaces go with the
     * conversation they were attached to.
     */
    const told = (await this.store.get(session.id))?.instructions
    return this.store.update(session.id, {
      // The last message the summary covers: the whole conversation as it stood.
      compacted: { ...mark, estimate },
      ...(told ? { instructions: { initial: told.current, current: told.current } } : {}),
    })
  }

  /**
   * MiMo's compaction at the start of a turn: when the last finished reply
   * since the last compaction crossed the line, the conversation is compacted
   * before the model is asked again. A failure leaves the turn to go on; if
   * its request is then refused for length, the rescue in `run` takes over.
   */
  private async compactIfCrossed(session: TurnSession, signal: AbortSignal): Promise<TurnSession> {
    const live = this.liveMessages(session, await this.store.messages(session.id))
    const from = session.compacted ? live.findIndex((message) => message.id === session.compacted?.messageID) + 1 : 0
    const reply = live
      .slice(from)
      .reverse()
      .find((message): message is AssistantMessage => message.role === "assistant" && message.finish !== undefined && message.usage !== undefined)
    if (!reply?.usage || !isOverflowByCount(reply.usage, this.config.modelEntry(session.model))) return session
    try {
      // The summary stops at that reply, so the request this turn is about to answer stays in front of the mark and is sent as the user wrote it.
      return keepTurn(await this.compactNow(session, signal, "automatic", reply.id), session)
    } catch {
      return session
    }
  }

  /**
   * MiMo's overflow compaction: a request too large for the model, or a step
   * that crossed the line mid-turn. The conversation is compacted and the
   * user's last request posted again after the summary, its attached files
   * left out, so the turn carries on from what was asked. Undefined when the
   * compaction could not be made.
   */
  private async compactForOverflow(session: TurnSession, signal: AbortSignal): Promise<TurnSession | undefined> {
    let compacted: TurnSession
    try {
      compacted = keepTurn(await this.compactNow(session, signal, "provider-overflow"), session)
    } catch {
      return undefined
    }
    const live = this.liveMessages(compacted, await this.store.messages(session.id))
    const asked = [...live].reverse().find((message): message is UserMessage => message.role === "user" && !message.notices?.length && Boolean(message.text.trim()))
    if (!asked) return compacted
    const left = asked.attachments.map((file) => file.path.split(/[\\/]/).pop() ?? file.path)
    const again: UserMessage = {
      id: Identifier.message(),
      sessionID: session.id,
      role: "user",
      text: asked.text,
      attachments: [],
      ...(asked.annotations?.length ? { annotations: asked.annotations } : {}),
      // skills: what the request loaded goes with it again; its context notes too, with word of the files left out.
      ...(asked.reminders?.length ? { reminders: asked.reminders } : {}),
      ...(left.length || asked.context?.length
        ? { context: [...(asked.context ?? []), ...(left.length ? [`Attached files were left out to make the conversation fit: ${left.join(", ")}.`] : [])] }
        : {}),
      time: { created: Date.now() },
    }
    await this.store.saveMessage(again)
    this.turn(session.id).messages.push(again.id)
    return compacted
  }

  async prompt(input: PromptInput): Promise<string> {
    /*
     * A turn that is under way takes the message rather than a second turn
     * being started for it. This is checked before the busy test below, because
     * "already working" is the answer for a session that cannot take anything
     * more - a compaction, or a turn still being set up - and not for one that
     * is simply mid-answer.
     */
    const open = this.steering.get(input.sessionID)
    // OpenCode v2's queue: kept until the running turn ends, then sent as a turn of its own.
    if (input.delivery === "queue" && (open || this.running.has(input.sessionID))) return this.enqueue(input)
    if (open) return this.join(open, input)

    if (this.running.has(input.sessionID)) throw new CodedError("This session is already working on something", "error.sessionBusy")

    // A command's agent and model belong to the turn this starts, never to one already running.
    if (input.agent || input.model) this.turnOverrides.set(input.sessionID, { agent: input.agent, model: input.model })
    else this.turnOverrides.delete(input.sessionID)

    /*
     * Claimed here rather than after the setup below. Everything between the
     * question and the answer is a filesystem round trip, and two prompts
     * arriving inside that window both used to pass - leaving one session
     * running two conversations, with Stop able to reach only one of them.
     */
    const controller = new AbortController()
    this.running.set(input.sessionID, controller)

    try {
      return await this.begin(input, controller)
    } catch (failure) {
      // The turn never started, so the session is not busy after all.
      this.running.delete(input.sessionID)
      throw failure
    }
  }

  /**
   * subagents: a slash command marked `subtask`. The line as typed becomes the
   * user's message, a subagent works on the command's prompt as the turn's first
   * step, and the conversation's own model then reads its answer and replies.
   * Refused while a turn is running, since the subagent has to lead the turn.
   */
  async subtask(input: { sessionID: string; text: string; description: string; prompt: string; type: SubagentSpec["type"] }): Promise<string> {
    if (this.running.has(input.sessionID)) throw new CodedError("This session is already working on something", "error.sessionBusy")
    if (!input.prompt.trim()) throw new Error("The command has no prompt to hand to a subagent")
    const controller = new AbortController()
    this.running.set(input.sessionID, controller)
    try {
      return await this.begin({ sessionID: input.sessionID, text: input.text }, controller, {
        description: input.description,
        prompt: input.prompt,
        type: input.type,
      })
    } catch (failure) {
      this.running.delete(input.sessionID)
      throw failure
    }
  }

  /**
   * Adds a message to the turn that is already running.
   *
   * The id is taken and listed before anything is awaited. That is what makes
   * the hand-off safe: the loop decides whether to finish by reading this list
   * with nothing awaited either side of the read, so a message is either in it
   * before that decision - and answered in this turn - or arrives after it and
   * is picked up by the release, which starts a fresh turn. There is no order
   * of events in which it lands between the two and is quietly dropped.
   *
   * Writes are chained rather than issued in parallel so that two messages
   * typed a moment apart reach the transcript in the order they were typed.
   */
  private join(
    steering: Steering,
    input: PromptInput,
    // subagents: a notice for the parent, or a follow-up for a subagent, joins the same way.
    extra: Pick<UserMessage, "notices" | "inbox"> = {},
  ): Promise<string> {
    // The user's own words take the runtime context; a notice or a message from elsewhere does not.
    const typed = !input.inbox && !extra.inbox && !extra.notices
    const context = typed ? [runtimeContext({ language: this.config.get().language })] : []
    const user: UserMessage = {
      id: Identifier.message(),
      sessionID: input.sessionID,
      role: "user",
      text: input.text,
      attachments: input.attachments ?? [],
      ...(input.annotations?.length ? { annotations: input.annotations } : {}),
      ...(input.fileNotices?.length ? { fileNotices: input.fileNotices } : {}),
      ...extra,
      ...(context.length ? { context } : {}),
      time: { created: Date.now() },
      // Marked, so the transcript can show it inside the turn it joined.
      steered: true,
    }
    steering.waiting.push(user.id)
    /*
     * News of subagents stays inside the turn it reached, so the running turn's
     * recording covers it. Anything the user typed opens a turn of its own once
     * the model takes it (see `openSteeredTurn`); until then it belongs to no
     * recording, since nothing has been done in answer to it.
     */
    if (extra.notices?.length) this.turn(input.sessionID).messages.push(user.id)

    // 追求目标: a message typed into a running turn sets the goal too, before it reaches the transcript.
    if (input.goal) user.setsGoal = true
    const written = steering.written.then(async () => {
      const goal = input.goal ? cleanGoal(input.goal) : ""
      if (goal) await this.store.update(input.sessionID, { goal: { condition: goal, startedAt: Date.now(), attempts: 0 } })
      // Settled in the same chain, so messages still reach the transcript in the order they were typed.
      if (user.attachments.some((file) => file.byPath)) {
        const session = await this.store.get(input.sessionID)
        if (session) user.attachments = await settleAttachments(user.attachments, session.directory)
      }
      // skills: what it names is loaded into it on the way to the transcript, in the order it was typed.
      const reminders = await this.remindersFor(input)
      if (reminders.length) user.reminders = reminders
      return this.store.saveMessage(user)
    })
    /*
     * A message that could not be written is taken off both lists again. Left
     * on the waiting one, the loop would keep asking for another step to
     * deliver something that is not in the transcript and never will be; left
     * on the turn's, this turn's recording would claim to cover a message
     * nobody can find.
     */
    steering.written = written.catch(() => {
      const at = steering.waiting.indexOf(user.id)
      if (at >= 0) steering.waiting.splice(at, 1)
      const answering = this.pending.get(input.sessionID)?.messages
      const also = answering?.indexOf(user.id) ?? -1
      if (answering && also >= 0) answering.splice(also, 1)
    })
    return written.then(() => user.id)
  }

  /** skills: every switched-on skill a conversation in this directory can reach, with the user's global ones from the app's data folder. */
  private async skillsFor(directory: string): Promise<SkillInfo[]> {
    const settings = this.config.get()
    return enabledSkills((await discoverSkills({ directory, storageDirectory: path.dirname(this.globalAgents), settings })).skills, settings.disabledSkills)
  }

  /** skills: what a user message carries for the model beyond its words - skills it names, and the hint its office documents bring. */
  private async remindersFor(input: PromptInput, directory?: string): Promise<string[]> {
    const attachments = input.attachments ?? []
    if (!input.text.includes("/") && !attachments.length) return []
    const where = directory ?? (await this.store.get(input.sessionID))?.directory
    return where ? skillReminders(input.text, await this.skillsFor(where), attachments) : []
  }

  /** True while something the user typed is waiting to reach the model. */
  private steered(sessionID: string): boolean {
    return (this.steering.get(sessionID)?.waiting.length ?? 0) > 0
  }

  /**
   * Crosses off the steered messages carried by the history about to be sent.
   *
   * Matched against that history rather than simply emptied, because a message
   * written while the transcript was being read may or may not have made it in.
   * Comparing ids answers that exactly, so nothing is marked delivered before
   * the model has actually been given it.
   */
  private markDelivered(sessionID: string, history: Message[]): string[] {
    const steering = this.steering.get(sessionID)
    if (!steering || steering.waiting.length === 0) return []
    const carried = new Set(history.map((message) => message.id))
    const delivered = steering.waiting.filter((id) => carried.has(id))
    steering.waiting = steering.waiting.filter((id) => !carried.has(id))
    return delivered
  }

  /**
   * MiMo 26.914's steer: once the model takes what the user typed mid-turn, the
   * work so far is settled as a turn of its own - filed for undo and rollback -
   * and the steered messages open the next one, photographed afresh. News of
   * subagents does not split a turn; it was already counted in the running one.
   */
  private async openSteeredTurn(sessionID: string, directory: string, delivered: string[], history: Message[]): Promise<void> {
    const byID = new Map(history.map((message) => [message.id, message]))
    const typed = delivered.filter((id) => {
      const message = byID.get(id)
      return message?.role === "user" && !message.notices?.length
    })
    // A turn started for these very messages (the release's resume) is already theirs.
    const running = this.pending.get(sessionID)
    if (!typed.length || (running && typed.every((id) => running.messages.includes(id)))) return
    try {
      await this.commitSnapshot(sessionID)
    } catch (cause) {
      this.bus.publish({ type: "session.error", sessionID, error: `Could not record this turn for undo: ${(cause as Error).message}` })
    }
    const next = this.turn(sessionID)
    next.messages = typed
    next.directory = directory
    next.watching = this.snapshots.begin(directory)
  }

  /** The setup a claimed session goes through before its turn is launched. */
  /**
   * Smart's one decision: which of its two models this conversation runs on.
   *
   * Asked of the main model in a short request with no tools. Anything that
   * does not come back as a clear reading - a failure, a timeout, prose - lands
   * on the main model. The answer is written into the session, so every later
   * turn simply runs on `model` like any other conversation.
   */
  private async routeSmart(session: SessionInfo, text: string): Promise<SessionInfo> {
    const config = this.config.get()
    const main = config.smartMain?.provider ? config.smartMain : config.model
    const fast = config.smartFast?.provider ? config.smartFast : main
    let reading: TaskReading | undefined
    const definition = this.config.definition(main.provider)
    if (definition && this.config.usable(main.provider)) {
      const adapter: ProviderAdapter = adapterFor(definition.kind)
      const apiKey = this.config.apiKey(definition.id) ?? ""
      const tokens = definition.kind === "chatgpt" ? await this.auth.accessToken(definition.id) : undefined
      const controller = new AbortController()
      // Stop reaches Smart's routing question too; it is asked before the turn claims the session.
      const release = this.hold(session.id, controller)
      const timer = setTimeout(() => controller.abort(), SMART_TIMEOUT_MS)
      let answer = ""
      try {
        const outcome = await adapter.stream(
          {
            apiKey: tokens?.access ?? apiKey,
            model: main,
            system: SMART_SYSTEM,
            history: [
              {
                id: `${session.id}:smart-route`,
                sessionID: session.id,
                role: "user",
                text: text.slice(0, SMART_REQUEST_CHARS),
                attachments: [],
                time: { created: Date.now() },
              },
            ],
            tools: [],
            // Out of band: routing one message is not work a reasoning budget should be spent on.
            ...smallRequest(main.provider, main.model),
            signal: controller.signal,
            baseURL: definition.baseURL,
            headers: definition.headers,
            accountId: tokens?.accountId,
            maxOutput: SMART_OUTPUT_TOKENS,
          },
          (event) => {
            if (event.type === "text.delta") answer += event.text
          },
        )
        this.noteBackground(session.id, main, outcome.usage, "smart")
        reading = readTask(answer)
      } catch {
        reading = undefined
      } finally {
        clearTimeout(timer)
        release()
      }
    }
    const route = smartRoute(reading)
    return this.store.update(session.id, { model: route === "fast" ? fast : main, smartRoute: route })
  }

  /** Records what a request outside the turns spent, priced as a turn on that model would be. */
  private noteBackground(sessionID: string, model: ModelRef, usage: TurnUsage | undefined, kind: BackgroundUse["kind"]): void {
    if (!usage) return
    const priced = { ...usage, cost: costOf(usage, this.config.modelEntry(model)) }
    if (!priced.input && !priced.output && !priced.reasoning && !priced.cacheRead && !priced.cacheWrite) return
    void this.backgroundUsage.add({ at: Date.now(), sessionID, model, usage: priced, kind })
  }

  /**
   * MiMo's answer to a model that has gone - its provider removed or signed
   * out, or the model dropped from the provider's list: the conversation
   * follows the app's model instead, or MiMo's fallback when that has gone
   * too. Without this the next message failed with a provider error that did
   * not say why. With no model left at all, the turn is refused in words the
   * window can show.
   */
  private async withAvailableModel(session: SessionInfo): Promise<SessionInfo> {
    const providers = this.config.providers()
    if (modelAvailable(providers, session.model)) return session
    const chosen = this.config.get().model
    const next = modelAvailable(providers, chosen) ? chosen : fallbackModel(availableModels(providers))
    if (!next) throw new CodedError("No model is available. Connect a provider or add a model in Settings.", "error.noModel")
    return this.store.update(session.id, { model: next })
  }

  private async begin(
    input: PromptInput,
    controller: AbortController,
    lead?: Lead,
  ): Promise<string> {
    let session = await this.store.require(input.sessionID)

    /*
     * Anything rolled back leaves the transcript for good at this point.
     *
     * The conversation has been taken back to here and is now going somewhere
     * else, so the branch that was rolled back is not a state anyone can return
     * to any more. Making it permanent before the new message is written is
     * what keeps the two from being interleaved on disk.
     */
    if (session.revert) session = await this.commitRevert(session)

    await this.settleInterrupted(session.id)

    // Smart picks its model from the first message, before anything is checked against it.
    if (session.smart && !session.smartRoute && input.text.trim()) session = await this.routeSmart(session, input.text)

    // A conversation whose model has gone since it last ran moves to one that is there.
    session = await this.withAvailableModel(session)
    // The level is the conversation's own: one stored before that took the app's at its next turn, and keeps it from here.
    if (!session.effort) session = await this.store.setEffort(session.id, this.config.get().effort)

    /*
     * The project is photographed from here rather than from the first tool
     * call, so that on a large project the scan runs while the model is still
     * composing its reply instead of being waited for. plan: a planning turn is
     * photographed too - it writes its plan file, and its commands run under
     * the same permission rules as any other turn's.
     */
    this.pending.delete(session.id)
    this.turn(session.id).directory = session.directory
    this.turn(session.id).watching = this.snapshots.begin(session.directory)

    // A subscription is authorised by stored tokens, so it has no API key to
    // check here - the bearer is resolved (and refreshed) at turn time.
    const apiKey = this.config.apiKey(session.model.provider) ?? ""

    /*
      * 追求目标: the goal is written before the message that set it, so the
      * turn this starts is already carrying the guard and is judged when it
      * ends. A fresh goal each time, as MiMo's own set is: its clock and its
      * count of re-entries start over.
      */
    const goal = input.goal ? cleanGoal(input.goal) : ""
    if (goal) session = await this.store.update(session.id, { goal: { condition: goal, startedAt: Date.now(), attempts: 0 } })

    // MiMo's runtime context rides on what the user sends; a first message also gets the app note and the directory.
    const stored = await this.store.messages(session.id)
    const first = stored.length === 0
    // MiMo attaches by path: what each such file is gets settled now, its contents are read per request.
    const attachments = await settleAttachments(input.attachments, session.directory)
    // skills: what the message names, and the hint its office documents bring.
    const reminders = await this.remindersFor(input, session.directory)
    const context = input.inbox ? [] : await this.runtimeNotes(session, first)
    const attached = input.inbox ? undefined : attachmentNote(attachments.filter((file) => file.byPath), session.directory)
    if (attached) context.push(attached)
    // plan: what this turn may do, or - on the turn after the switch - that it may build again.
    const planning = input.inbox ? undefined : await this.planNote(session, stored)
    if (planning) context.push(planning)
    // Told not to test: the turn says so to the model, and the app tool is refused for it (see runTool).
    const noTesting = !input.inbox && forbidsTesting(input.text)
    if (noTesting) context.push(NO_TESTING_NOTE)
    this.turn(session.id).noTesting = noTesting
    const user: UserMessage = {
      id: Identifier.message(),
      sessionID: session.id,
      role: "user",
      text: input.text,
      attachments,
      ...(input.annotations?.length ? { annotations: input.annotations } : {}),
      ...(input.fileNotices?.length ? { fileNotices: input.fileNotices } : {}),
      // session chat
      ...(input.inbox ? { inbox: input.inbox } : {}),
      // 追求目标: the transcript marks the message that set the goal.
      ...(goal ? { setsGoal: true } : {}),
      ...(input.fromQueue ? { queued: true } : {}),
      // skills
      ...(reminders.length ? { reminders } : {}),
      ...(context.length ? { context } : {}),
      time: { created: Date.now() },
    }
    await this.store.saveMessage(user)
    this.turn(session.id).messages = [user.id]

    /*
     * MiMo's titles: the first prompt of a conversation nobody has named sets
     * the fallback at once, and a model names the task in the background.
     * Subagents keep the name they were started with.
     */
    if (!session.parentID && session.titleSource === undefined && session.title === UNTITLED) {
      // The skill chips ahead of the words are not what the task is called.
      const words = input.text.includes("/") ? withoutSkillPrefix(input.text, new Set((await this.skillsFor(session.directory)).map((skill) => skill.name))) : input.text
      const fallback = fallbackTitle(words, input.attachments ?? [])
      session = await this.store.update(session.id, { title: fallback, titleSource: "fallback" })
      if (/\p{L}/u.test(words)) void this.generateTitle(session.id, words).catch(() => undefined)
    }

    this.launch(session.id, apiKey, controller, false, lead)
    return user.id
  }

  /**
   * The notes a prompt the user typed is sent with: the runtime context every
   * time, and on a conversation's first message the app note before it and the
   * working directory inside it, as MiMo's desktop attaches them. A subagent's
   * prompt is the runner's own and gets none.
   */

  /**
   * First project MCP (local or remote) from a project file in this folder: ask
   * once, remember trust, then ready() may start them. "Not now" leaves them blocked.
   */
  private async ensureMcpTrust(sessionID: string, directory: string, signal?: AbortSignal): Promise<void> {
    if (!this.mcp) return
    if (this.mcpTrustSkipped.has(sessionID)) return
    if (!(await this.mcp.needsTrustPrompt(directory))) return
    try {
      const [answer] = await this.questions.ask({
        sessionID,
        questions: [
          {
            question: "This folder configures MCP servers (mcode.json / .claude.json). Trust and start them? Local ones can run programs; remote ones can reach the network with any headers the file sets.",
            header: "MCP",
            options: [
              { label: "Trust", description: "Start this folder's MCP servers" },
              { label: "Not now", description: "Skip them for now" },
            ],
          },
        ],
        signal,
      })
      const chosen = (answer ?? []).map((entry) => entry.trim()).filter(Boolean)
      if (chosen.includes("Trust")) await this.mcp.trust(directory)
      else this.mcpTrustSkipped.add(sessionID)
    } catch {
      // Dismissed or stopped: leave untrusted; do not skip — a later turn may ask again.
    }
  }

  private async runtimeNotes(session: SessionInfo, first: boolean): Promise<string[]> {
    if (session.parentID) return []
    const config = this.config.get()
    /*
     * The date changes per turn, so it rides here rather than in the cached
     * system prompt. Read off this machine's calendar rather than UTC's: east
     * of Greenwich the UTC date is still yesterday's for the whole morning, so
     * every conversation opened before 08:00 at UTC+8 used to be told the
     * wrong day. MiMo's own `<env>` block carries no date at all - this line
     * is MCode's, and so is its format (YYYY-MM-DD).
     */
    const runtime = runtimeContext({
      language: config.language,
      today: localDay(Date.now()),
      ...(first ? { directory: session.directory } : {}),
    })
    if (!first) return [runtime]
    // The project's MCP servers, as the MCP layer has them for this directory.
    await this.mcp?.ready(session.directory)
    const names = this.mcp?.names(session.directory) ?? []
    return [
      sessionNote({
        mcpServers: names,
        // Where the MCP servers actually live, so a bulk import can be done by editing the file.
        configFile: path.join(this.dataRoot, "config.json"),
      }),
      runtime,
    ]
  }

  /**
   * MiMo's generated title: one short request, the first message as data and
   * the interface language as a hint, on the conversation's own model (MCode
   * has no small-model setting). Written only while the title is still the
   * fallback, so a rename made meanwhile wins; anything that fails leaves the
   * fallback where it is. `MCODE_GENERATE_TITLES=0` turns it off for checks
   * whose scripted providers would otherwise have a reply taken by it.
   */
  private async generateTitle(sessionID: string, text: string): Promise<void> {
    if (process.env.MCODE_GENERATE_TITLES === "0") return
    const session = await this.store.get(sessionID)
    if (!session || session.titleSource !== "fallback") return
    /* MiMo's 标题生成模型: the model named for titles when this install can still reach it, else the conversation's own. */
    const model = titleModelRef(
      this.config.get().titleModel,
      session.model,
      (ref) => Boolean(this.config.definition(ref.provider)) && this.config.usable(ref.provider) && Boolean(this.config.modelEntry(ref)),
    )
    const controller = new AbortController()
    /*
     * Held where Stop can reach it. This request is launched and forgotten and
     * has no entry in `running`, so pressing Stop on the very first message
     * used to leave it running to its own timeout - renaming the conversation
     * seconds after it had been cancelled, and billing for the request.
     */
    const release = this.hold(sessionID, controller)
    let title: string | undefined
    try {
      title = await this.titleFrom(session, model, text, controller.signal)
      // MiMo's fallback: a title model that failed, or answered with nothing usable, is followed by one try on the conversation's own.
      const own = session.model
      if (!title && !controller.signal.aborted && (model.provider !== own.provider || model.model !== own.model)) {
        title = await this.titleFrom(session, own, text, controller.signal)
      }
    } finally {
      release()
    }
    // Stopped while it was writing: the conversation keeps the fallback it already has.
    if (controller.signal.aborted || !title) return
    const current = await this.store.get(sessionID)
    if (current?.titleSource !== "fallback") return
    await this.store.update(sessionID, { title, titleSource: "generated" })
  }

  /** One title request on one model: the cleaned title, or nothing when it failed, timed out or said nothing usable. */
  private async titleFrom(session: SessionInfo, model: ModelRef, text: string, stopped: AbortSignal): Promise<string | undefined> {
    const definition = this.config.definition(model.provider)
    if (!definition || !this.config.usable(model.provider) || stopped.aborted) return undefined
    const adapter: ProviderAdapter = adapterFor(definition.kind)
    const tokens = definition.kind === "chatgpt" ? await this.auth.accessToken(definition.id) : undefined
    const entry = this.config.modelEntry(model)
    // Each try has its own time limit, and Stop ends either.
    const controller = new AbortController()
    const stop = () => controller.abort()
    stopped.addEventListener("abort", stop, { once: true })
    // Stop may have come while the sign-in token was fetched; that abort has already fired.
    if (stopped.aborted) stop()
    const timer = setTimeout(stop, TITLE_TIMEOUT_MS)
    const sessionID = session.id
    let answer = ""
    try {
      // MiMo's request budget for a call that is not a turn: four quick tries, then the fallback stands.
      const outcome = await withRequestRetry(() => {
        // Each attempt starts its own answer; a retry must not continue the last one's text.
        answer = ""
        return adapter.stream(
          {
            apiKey: tokens?.access ?? this.config.apiKey(definition.id) ?? "",
            model,
            system: TITLE_SYSTEM,
            history: [
              {
                id: `${session.id}:title`,
                sessionID: session.id,
                role: "user",
                text: titlePrompt(text.slice(0, TITLE_SOURCE_CHARS), interfaceLocale(this.config.get().language)),
                attachments: [],
                time: { created: Date.now() },
              },
            ],
            tools: [],
            // Out of band: MiMo's cheap profile, so naming a conversation does not think for as long as answering it.
            ...smallRequest(model.provider, model.model),
            variants: this.config.variants(model),
            signal: controller.signal,
            baseURL: definition.baseURL,
            headers: definition.headers,
            accountId: tokens?.accountId,
            maxOutput: maxOutputTokens(model, entry),
            outputLimit: entry?.maxOutput,
            // MiMo's title agent runs at 0.5, where the model takes a temperature.
            sampling: { ...samplingFor(model.model, false), ...(entry?.temperature ? { temperature: 0.5 } : {}) },
          },
          (event) => {
            if (event.type === "text.delta") answer += event.text
          },
        )
      }, controller.signal)
      this.noteBackground(sessionID, model, outcome.usage, "title")
    } catch {
      return undefined
    } finally {
      clearTimeout(timer)
      stopped.removeEventListener("abort", stop)
    }
    if (controller.signal.aborted) return undefined
    return cleanTitle(answer) || undefined
  }

  /**
   * 追求目标: whether this turn has to carry on.
   *
   * Called where a turn would end. The conversation's goal is read again from
   * the store rather than from the turn's copy, because the bar above the
   * composer can take the goal off while the turn runs, and a goal the reader
   * has just abandoned must not send the turn back.
   *
   * MiMo's order, kept: judge, then decide. Met - or out of reach - ends the
   * goal and lets the turn stop. Anything else counts one re-entry against
   * `MAX_GOAL_REACT`, writes the judge's reason where the user's next message
   * would go, and returns true so the loop asks the model again. A judge that
   * could not answer lets the turn stop; a conversation held open by a request
   * that keeps failing would be the worse failure of the two.
   *
   * A subagent never has a goal of its own: it works for a parent turn, and
   * that turn's goal is judged when the parent's own turn ends.
   */
  private async goalGate(session: TurnSession, stopped: AbortSignal): Promise<boolean> {
    if (session.parentID || stopped.aborted) return false
    const sessionID = session.id
    const current = await this.store.get(sessionID)
    const goal = current?.goal
    if (!goal || goal.done) return false

    const verdict = await this.judgeGoal(session, goal.condition, stopped)
    // Stop landed while the judge was reading: the goal stands, untouched, for the next turn.
    if (stopped.aborted) return false
    /*
     * The judge can take a minute and a half. The bar may have cleared the goal
     * or set a new one meanwhile; the verdict is about the goal that was read
     * above and is written to that goal only. Anything else lets the turn stop.
     */
    const now = (await this.store.get(sessionID))?.goal
    if (!now || !sameGoal(now, goal)) return false
    if (!verdict) {
      await this.endGoal(sessionID, goal, { status: "blocked", reason: GOAL_JUDGE_FAILED, at: Date.now() })
      return false
    }
    if (verdict.ok || verdict.impossible) {
      await this.endGoal(sessionID, goal, { status: verdict.ok ? "complete" : "blocked", reason: verdict.reason, at: Date.now() })
      return false
    }

    const attempts = now.attempts + 1
    if (attempts > MAX_GOAL_REACT) {
      await this.endGoal(sessionID, goal, { status: "blocked", reason: verdict.reason, at: Date.now() })
      return false
    }
    await this.store.update(sessionID, { goal: { ...now, attempts } })
    const reminder: UserMessage = {
      id: Identifier.message(),
      sessionID,
      role: "user",
      text: goalReminder(goal.condition, verdict.reason),
      attachments: [],
      // The app's word, not the reader's: the transcript leaves it out, as it leaves out an approved plan's.
      synthetic: true,
      time: { created: Date.now() },
    }
    await this.store.saveMessage(reminder)
    return true
  }

  /**
   * 追求目标: the goal stops driving turns but stays on the conversation, so the
   * bar can say how it ended. Only the goal that was judged: one set in its
   * place meanwhile is a fresh goal the verdict says nothing about.
   */
  private async endGoal(sessionID: string, judged: SessionGoal, done: NonNullable<SessionGoal["done"]>): Promise<void> {
    const current = (await this.store.get(sessionID))?.goal
    if (!current || !sameGoal(current, judged)) return
    await this.store.update(sessionID, { goal: { ...current, done } })
  }

  /**
   * 追求目标: one judge request - the transcript, then the one question.
   *
   * The conversation's own model answers it, as MiMo's does: the judge has to
   * read the same work the turn produced, and a model too small to follow it
   * would wave through turns that did nothing. It is asked out of band, at the
   * cheap profile and without tools, and the answer is JSON rather than prose
   * so "met" cannot be read out of a hedge. Nothing usable, a failure, or a
   * timeout all return nothing, which the caller treats as a judge that failed.
   */
  private async judgeGoal(session: TurnSession, condition: string, stopped: AbortSignal): Promise<GoalVerdict | undefined> {
    const model = session.model
    const definition = this.config.definition(model.provider)
    if (!definition || !this.config.usable(model.provider) || stopped.aborted) return undefined
    const adapter: ProviderAdapter = adapterFor(definition.kind)
    const tokens = definition.kind === "chatgpt" ? await this.auth.accessToken(definition.id) : undefined
    const entry = this.config.modelEntry(model)
    const controller = new AbortController()
    const stop = () => controller.abort()
    stopped.addEventListener("abort", stop, { once: true })
    if (stopped.aborted) stop()
    const timer = setTimeout(stop, GOAL_JUDGE_TIMEOUT_MS)
    const sessionID = session.id
    let answer = ""
    try {
      const stored = await this.store.messages(sessionID)
      // Calls as text: the judge has no tools, and a tool block with none defined is refused.
      const transcript = judgeTranscript(this.contextFor(session, stored))
      const outcome = await adapter.stream(
        {
          apiKey: tokens?.access ?? this.config.apiKey(definition.id) ?? "",
          model,
          system: JUDGE_SYSTEM,
          history: [
            ...transcript,
            {
              id: `${sessionID}:goal:${Date.now()}`,
              sessionID,
              role: "user" as const,
              text: judgeQuestion(condition),
              attachments: [],
              time: { created: Date.now() },
            },
          ],
          tools: [],
          ...smallRequest(model.provider, model.model),
          variants: this.config.variants(model),
          signal: controller.signal,
          baseURL: definition.baseURL,
          headers: definition.headers,
          accountId: tokens?.accountId,
          maxOutput: maxOutputTokens(model, entry),
          outputLimit: entry?.maxOutput,
          // A verdict is a reading of the record, not a piece of writing: no room for a warmer answer.
          sampling: { ...samplingFor(model.model, false), ...(entry?.temperature ? { temperature: 0 } : {}) },
        },
        (event) => {
          if (event.type === "text.delta") answer += event.text
        },
      )
      this.noteBackground(sessionID, model, outcome.usage, "goal")
    } catch {
      return undefined
    } finally {
      clearTimeout(timer)
      stopped.removeEventListener("abort", stop)
    }
    if (controller.signal.aborted) return undefined
    return parseVerdict(answer)
  }

  /**
   * MiMo's settling of calls a stopped or closed turn left unfinished: at the
   * next prompt, while nothing is running, each is stored as an error saying it
   * was aborted, marked interrupted and aborted so the transcript draws it
   * quietly and the model reads it as a call that did not complete.
   */
  private async settleInterrupted(sessionID: string): Promise<void> {
    for (const message of await this.store.messages(sessionID)) {
      if (message.role !== "assistant") continue
      let changed = false
      for (const part of message.parts) {
        if (part.type !== "tool" || (part.status !== "pending" && part.status !== "running")) continue
        part.status = "error"
        part.error = ABORTED_TOOL
        part.metadata = { ...(part.metadata ?? {}), aborted: true, interrupted: true }
        part.time.completed ??= Date.now()
        changed = true
      }
      if (changed) await this.store.saveMessage(message)
    }
  }

  /**
   * Starts a turn for messages that arrived as the last one was ending.
   *
   * They are in the transcript already - what they missed is a model call. This
   * is the setup a prompt does, without writing a message that exists.
   */
  private async resume(sessionID: string, stranded: string[]): Promise<void> {
    const controller = new AbortController()
    this.running.set(sessionID, controller)
    try {
      const session = await this.store.require(sessionID)
      this.pending.delete(sessionID)
      // The messages this turn exists to answer, carried over from the turn
      // that was ending as they arrived - a rollback aimed at one of them has
      // to reach this turn's recording, not the previous turn's.
      this.turn(sessionID).messages = stranded
      this.turn(sessionID).directory = session.directory
      this.turn(sessionID).watching = this.snapshots.begin(session.directory)
      this.launch(sessionID, this.config.apiKey(session.model.provider) ?? "", controller)
    } catch (failure) {
      this.running.delete(sessionID)
      this.bus.publish({ type: "session.error", sessionID, error: describe(failure) })
      this.bus.publish({ type: "session.idle", sessionID })
    }
  }

  /**
   * Carries on a turn that broke off - stopped, failed, or cut short by a quit -
   * on the transcript as it stands, with no new message from the user.
   *
   * The same setup a prompt goes through, minus the message. Refused while the
   * conversation is rolled back: the new turn would be written after messages
   * that are hidden and about to be dropped.
   */
  async resumeTurn(sessionID: string, how: Exclude<Resumed, false> = "user"): Promise<string> {
    if (this.running.has(sessionID)) throw new Error("This session is already working on something")
    const controller = new AbortController()
    this.running.set(sessionID, controller)
    try {
      const session = await this.store.require(sessionID)
      if (session.revert) throw new Error("Resume is unavailable while part of the conversation is rolled back")
      const messageID = interruptedTurn(await this.store.messages(sessionID))
      if (!messageID) throw new Error("There is no interrupted turn to resume")
      await this.settleInterrupted(sessionID)
      if (!this.config.usable(session.model.provider)) {
        throw new Error(`No API key configured for ${session.model.provider}. Add one in Settings.`)
      }
      this.pending.delete(sessionID)
      // The turn answers the same question the broken one did, so a rollback to it reaches both.
      this.turn(sessionID).messages = [messageID]
      this.turn(sessionID).directory = session.directory
      this.turn(sessionID).watching = this.snapshots.begin(session.directory)
      this.launch(sessionID, this.config.apiKey(session.model.provider) ?? "", controller, how)
      return messageID
    } catch (failure) {
      this.running.delete(sessionID)
      throw failure
    }
  }

  /**
   * Keeps a conversation's instruction state and returns the values its
   * system prompt is built from.
   *
   * The first read sets the baseline. A later read that differs from what the
   * model was last told becomes a reminder on the newest user message - the
   * message this turn answers, so the change sits where it happened in the
   * conversation and is kept with it - and `current` moves on. Read from the
   * store each time: a turn builds its prompt more than once, and a copy of
   * the conversation from the turn's start would tell the same change twice.
   */
  private async syncInstructions(sessionID: string, values: InstructionValues): Promise<InstructionValues> {
    const stored = (await this.store.get(sessionID))?.instructions
    if (!stored) {
      await this.store.update(sessionID, { instructions: { initial: values, current: values } }).catch(() => undefined)
      return values
    }
    const initial = { standing: "", project: "", skills: "", ...stored.initial } as InstructionValues
    const told = { standing: "", project: "", skills: "", ...stored.current } as InstructionValues
    const update = instructionUpdate(told, values)
    if (!update) return initial
    const messages = await this.store.messages(sessionID).catch((): Message[] => [])
    const asked = messages.findLast((message): message is UserMessage => message.role === "user")
    if (asked) {
      asked.reminders = [...(asked.reminders ?? []), reminder(update)]
      await this.store.saveMessage(asked)
    }
    await this.store.update(sessionID, { instructions: { initial: stored.initial, current: values } }).catch(() => undefined)
    return initial
  }

  /** Web instruction files, fetched at most once every few minutes: they are read on every turn now, and each fetch may wait five seconds. */
  private readonly fetchedInstructions = new Map<string, { at: number; text: Promise<string> }>()
  private fetchInstructionCached(url: string): Promise<string> {
    const held = this.fetchedInstructions.get(url)
    if (held && Date.now() - held.at < 5 * 60_000) return held.text
    const text = fetchInstruction(url)
    this.fetchedInstructions.set(url, { at: Date.now(), text })
    return text
  }

  /** The app is closing: turns still running keep their claims, so the next start carries them on. */
  closeTurns(): void {
    this.closing = true
  }

  /**
   * Carries on every turn the app was cut off in the middle of (OpenCode v2's
   * SessionRestart): a claim still on a conversation at start-up means a turn
   * was running when the app went away - a crash, a kill, or a quit - and
   * nothing released it.
   *
   * Only top-level conversations: a subagent's parent decides what happens to
   * it, and start-up already marks those that were working as failed. The
   * count is written before the turn starts, so a turn that brings the app
   * down again is counted by the next start; past MAX_RESTART_RESUMES it is
   * left for the reader to carry on with 继续 or not. Like v2's, this is at
   * least once: a command that was running when the app died may have done
   * its work, and the model is told only that it was cut off.
   *
   * @returns the conversations carried on
   */
  async resumeClaimed(): Promise<string[]> {
    const carried: string[] = []
    for (const session of await this.store.list().catch((): SessionInfo[] => [])) {
      const claim = session.claim
      if (!claim) continue
      /*
       * Two instances may share one data folder. A claim written by a process
       * that is still alive is a turn running over there right now, and
       * carrying it on here would run it twice; it is left alone. A dead
       * process's id may have been handed to another program since, which
       * only ever errs towards leaving a turn for the reader.
       */
      if (claim.pid !== undefined && claim.pid !== process.pid && (this.alive ?? processAlive)(claim.pid)) continue
      const release = () => this.store.update(session.id, { claim: undefined }).catch(() => undefined)
      if (session.parentID || session.subagent || this.running.has(session.id) || session.revert) {
        await release()
        continue
      }
      if (claim.resumes >= MAX_RESTART_RESUMES) {
        console.warn(`[restart] ${session.id} was cut off ${claim.resumes} times in a row; left for the reader to carry on`)
        await release()
        continue
      }
      if (!interruptedTurn(await this.store.messages(session.id).catch((): Message[] => []))) {
        await release()
        continue
      }
      this.restartResumes.set(session.id, claim.resumes + 1)
      try {
        await this.resumeTurn(session.id, "restart")
        carried.push(session.id)
      } catch (failure) {
        this.restartResumes.delete(session.id)
        console.warn(`[restart] could not carry on ${session.id}: ${describe(failure)}`)
        await release()
      }
    }
    return carried
  }

  /** Runs a claimed session's turn and releases it afterwards. */
  private launch(sessionID: string, apiKey: string, controller: AbortController, resumed: Resumed = false, lead?: Lead): void {
    this.steering.set(sessionID, { waiting: [], written: Promise.resolve() })

    // Deliberately not awaited: the caller gets the message id immediately and
    // follows the turn through events.
    let failed = false
    void this.run(sessionID, apiKey, controller, resumed, lead)
      .catch((err) => {
        failed = true
        // A failure recorded on the message is already in front of the user.
        if (err instanceof Shown) return
        const code = codeOf(err)
        this.bus.publish({ type: "session.error", sessionID, error: describe(err), ...(code ? { errorCode: code, errorParams: paramsOf(err) } : {}) })
      })
      .finally(async () => {
        /*
         * Awaited before the session is released. Undo reads this stack the
         * moment a turn ends, and starting the write without waiting for it
         * meant that read could land one turn behind.
         */
        try {
          await this.commitSnapshot(sessionID)
        } catch (cause) {
          this.bus.publish({
            type: "session.error",
            sessionID,
            error: `Could not record this turn for undo: ${(cause as Error).message}`,
          })
        }
        // The turn ended for a reason of its own: nothing to carry on at the next start. A turn cut off by the quit keeps its claim.
        if (!this.closing) await this.store.update(sessionID, { claim: undefined }).catch(() => undefined)
        this.running.delete(sessionID)
        this.retrying.delete(sessionID)
        this.workingIn.delete(sessionID)

        /*
         * The last read of the waiting list, and the only one that can see a
         * message that arrived after the loop had stopped looking. Everything
         * from here down is synchronous, so the entry is removed and the next
         * turn claims the session in the same tick - a prompt sent in this
         * moment finds either a turn to join or an idle session, never a busy
         * one it cannot reach.
         *
         * Nothing is resumed after Stop. The message stays in the transcript
         * and goes to the model with whatever is asked next, which is what Stop
         * has to mean if it is to mean anything.
         */
        const waiting = this.steering.get(sessionID)?.waiting ?? []
        const stranded = waiting.length > 0 && !controller.signal.aborted
        const carried = [...waiting]
        this.steering.delete(sessionID)
        if (stranded) {
          void this.resume(sessionID, carried)
          return
        }
        this.bus.publish({ type: "session.idle", sessionID })
        // OpenCode v2: the next queued message once a turn ends of its own accord; after Stop or a failure they wait for the user.
        if (!controller.signal.aborted && !failed && !this.closing) void this.sendQueued(sessionID)
      })
  }

  /**
   * Changes a conversation's queue, one change at a time: two messages queued
   * a moment apart must both be kept, and a read-change-write pair running
   * beside another would drop one of them.
   */
  private queueEdit(sessionID: string, change: (queued: QueuedPrompt[]) => QueuedPrompt[]): Promise<{ before: QueuedPrompt[]; after: QueuedPrompt[] }> {
    const edited = (this.queueEdits.get(sessionID) ?? Promise.resolve()).then(async () => {
      const before = (await this.store.require(sessionID)).queued ?? []
      const after = change(before)
      await this.store.update(sessionID, { queued: after.length ? after : undefined })
      return { before, after }
    })
    this.queueEdits.set(
      sessionID,
      edited.then(
        () => undefined,
        () => undefined,
      ),
    )
    return edited
  }

  /** A message for after the running turn: kept on the conversation, and its id handed back. */
  private async enqueue(input: PromptInput): Promise<string> {
    const item: QueuedPrompt = {
      id: Identifier.message(),
      text: input.text,
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      ...(input.annotations?.length ? { annotations: input.annotations } : {}),
      ...(input.fileNotices?.length ? { fileNotices: input.fileNotices } : {}),
      ...(input.agent ? { agent: input.agent } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.goal ? { goal: input.goal } : {}),
      time: Date.now(),
    }
    await this.queueEdit(input.sessionID, (queued) => [...queued, item])
    return item.id
  }

  private promptOf(sessionID: string, item: QueuedPrompt): PromptInput {
    return {
      sessionID,
      text: item.text,
      attachments: item.attachments,
      annotations: item.annotations,
      fileNotices: item.fileNotices,
      agent: item.agent,
      model: item.model,
      goal: item.goal,
    }
  }

  /** Takes a queued message back without sending it. */
  async removeQueued(sessionID: string, id: string): Promise<void> {
    const { before } = await this.queueEdit(sessionID, (queued) => queued.filter((item) => item.id !== id))
    if (!before.some((item) => item.id === id)) throw new CodedError("That message is no longer queued", "error.queueGone")
  }

  /** 立即发送: a queued message into the running turn, or as a turn of its own if none is running. */
  async sendQueuedNow(sessionID: string, id: string): Promise<string> {
    // The same refusal `session.prompt` gives: a review-restricted conversation takes nothing more.
    if ((await this.store.get(sessionID))?.reviewRestricted) throw new CodedError("this conversation can't be continued - start a new one", "composer.reviewRestricted")
    let item: QueuedPrompt | undefined
    await this.queueEdit(sessionID, (queued) => {
      item = queued.find((entry) => entry.id === id)
      return queued.filter((entry) => entry.id !== id)
    })
    const taken = item
    if (!taken) throw new CodedError("That message is no longer queued", "error.queueGone")
    try {
      return await this.prompt(this.promptOf(sessionID, taken))
    } catch (failure) {
      // Not sent, so not lost: back where it was, at the front.
      await this.queueEdit(sessionID, (queued) => [taken, ...queued]).catch(() => undefined)
      throw failure
    }
  }

  /**
   * The oldest queued message, sent as a new turn. A send that is refused - a
   * provider gone, a rollback in the way - puts it back and leaves the rest
   * waiting, said as the turn's own error would be.
   */
  private async sendQueued(sessionID: string): Promise<void> {
    if (this.running.has(sessionID) || this.steering.has(sessionID)) return
    // A conversation a review restricted during the turn takes nothing more; what was queued stays for the reader to take back.
    if ((await this.store.get(sessionID).catch(() => undefined))?.reviewRestricted) return
    let item: QueuedPrompt | undefined
    await this.queueEdit(sessionID, (queued) => {
      item = queued[0]
      return queued.slice(1)
    }).catch(() => undefined)
    const taken = item
    if (!taken) return
    try {
      await this.prompt({ ...this.promptOf(sessionID, taken), fromQueue: true })
    } catch (failure) {
      await this.queueEdit(sessionID, (queued) => [taken, ...queued]).catch(() => undefined)
      const code = codeOf(failure)
      this.bus.publish({ type: "session.error", sessionID, error: describe(failure), ...(code ? { errorCode: code, errorParams: paramsOf(failure) } : {}) })
    }
  }

  private async run(sessionID: string, apiKey: string, controller: AbortController, resumed: Resumed = false, lead?: Lead): Promise<void> {
    /*
     * OpenCode v2's write-ahead claim, before anything else the turn does: a
     * quit or a crash from here on leaves it behind, and the next start
     * carries the turn on. The count of such carryings-on is kept across them
     * and reset only by a turn that ends.
     */
    const resumes = this.restartResumes.get(sessionID) ?? 0
    this.restartResumes.delete(sessionID)
    await this.store.update(sessionID, { claim: { at: Date.now(), resumes, pid: process.pid } }).catch(() => undefined)
    const own = await this.store.require(sessionID)
    // plan: the conversation's own mode as the turn begins; approving a plan changes it mid-turn.
    const planning = own.agent === "plan"
    // A slash command's own agent and model hold for this turn; the conversation keeps its own.
    let session: TurnSession = this.withCommandTurn(own, this.turnOverrides.get(sessionID))
    this.turnOverrides.delete(sessionID)
    // plan: what this step is judged by; a plan approved during the turn moves it to build from the next step.
    this.turnAgents.set(sessionID, session.agent)
    // MiMo's loop detectors watch one turn: what the last turn's calls added up to is not held against this one.
    this.loopWatches.delete(sessionID)
    // The project's servers are connected (or have failed) before the turn is offered their tools, as MiMo's instance waits for them.
    this.workingIn.set(sessionID, session.directory)
    await this.ensureMcpTrust(sessionID, session.directory, controller.signal)
    await this.mcp?.ready(session.directory)
    const definition = this.config.definition(session.model.provider)
    if (!definition) throw new CodedError(`No provider called ${session.model.provider} is set up`, "error.noModel")
    const adapter: ProviderAdapter = adapterFor(definition.kind)
    // A subscription carries no API key; the bearer is a refreshed access token.
    const tokens = definition.kind === "chatgpt" ? await this.auth.accessToken(definition.id) : undefined
    if (definition.kind === "chatgpt" && !tokens) throw new CodedError(`The ${definition.name} sign-in has expired`, "auth.expired", { name: definition.name })
    const config = this.config.get()
    // MiMo's prefix snapshot, with the skills and a subagent's notes; memory rides after it (see systemFor).
    let { system, systemTail } = await this.systemFor(session)
    // subagents: a subagent asked for structured output returns it through its tool.
    const outputSchema = session.subagent?.outputSchema

    /*
     * subagents: a `subtask` command's subagent works first, as a task call on
     * the turn's first reply. The model is asked only once it has answered.
     */
    if (lead) {
      const assistant: AssistantMessage = {
        id: Identifier.message(),
        sessionID,
        role: "assistant",
        model: session.model,
        agent: session.agent,
        effort: session.effort ?? config.effort,
        parts: [],
        time: { created: Date.now() },
      }
      const part: ToolPart = {
        type: "tool",
        id: Identifier.part(),
        callID: `subtask_${Identifier.part()}`,
        name: "actor",
        status: "pending",
        input: { operation: { action: "run", description: lead.description, prompt: lead.prompt, subagent_type: lead.type } },
        time: { created: Date.now() },
      }
      assistant.parts.push(part)
      await this.store.saveMessage(assistant)
      await this.runTool({ part, assistant, session: { id: sessionID, directory: session.directory, model: session.model }, signal: controller.signal })
      assistant.time.completed = Date.now()
      if (controller.signal.aborted) assistant.finish = "aborted"
      await this.store.saveMessage(assistant)
      if (controller.signal.aborted) return
    }

    // MiMo compacts at the start of a turn when the last finished reply crossed the line.
    if (!lead) session = await this.compactIfCrossed(session, controller.signal)

    /*
     * MiMo's pruning, decided once for the whole turn rather than per step.
     *
     * Per step it would flip: trimming rewrites the prefix, which is only free
     * while the provider's cache is already cold, and the first request of a
     * turn warms that cache again - so step 2 would send the untrimmed history
     * back and undo the saving. One decision per turn keeps the request stable.
     */
    const pruneLevel = await this.pruneLevelFor(session)
    this.turnPrune.set(sessionID, pruneLevel)

    /*
     * The step that was last rescued by a compaction. A request the provider
     * refuses as too long is retried once against the compacted transcript,
     * as MiMo does; refused again, the error stands.
     */
    let rescued = -1
    /*
     * No limit unless one is configured, which is the reference's default -
     * `agent.steps ?? Infinity`. Stop is what ends a turn that will not end
     * itself; a count that cuts in mid-refactor loses everything the model had
     * worked out, and says so in red.
     */
    const limit = stepLimitFor(config.maxSteps, this.isLocal(session))
    /* MiMo's continuations this turn: notes kept in the request after the reply they answer, and how many of each were used. */
    const notes = new Map<string, string[]>()
    const continued = { length: 0, textTool: 0, empty: 0, interrupted: 0 }
    /* MiMo's n-gram check: how many times this turn has been told to stop repeating itself. */
    let repeated = 0
    /*
     * The two checks that watch across steps rather than inside one reply: the
     * digests of the recent steps, and how many times this turn has been pulled
     * out of writing the same step again (session/loop-health.ts).
     */
    const digests: string[] = []
    let textLooped = 0
    /* Files attached by path, read once for this turn. */
    const attachmentData: AttachmentCache = new Map()
    /*
     * The reply a continuation carries on writing.
     *
     * A step that stopped at the output limit is asked to continue, and what
     * comes back is the rest of the same sentence - so it belongs in the same
     * message, welded onto the same text part, not in a message of its own.
     * Split in two, a fence cut by the limit is an unclosed fence in one
     * message and a stray closing one in the next: the widget renders as a code
     * block and the prose after it is swallowed as a second one, and copying
     * the reply inserts a blank line into the middle of a word. Every other
     * reason to continue a turn (a tool call written as prose, an empty reply)
     * is a fresh attempt rather than the rest of a sentence, and keeps its own
     * message.
     */
    let continuing: AssistantMessage | undefined
    /**
     * The step before this one reached the output limit, which turns thinking
     * off for this one (`thinkingOffExtra`). A thinking model given 32k can
     * spend nearly all of it planning at every step: measured on the user's
     * local Qwen, the step after a written file thought 25k more, began the
     * file again and was cut inside the call. With thinking off for one step it
     * does the work; the step after thinks again.
     */
    let afterCut = false
    /**
     * The step an overflow compaction was last made at. One that crossed the
     * line again at the very next step made room for nothing: the instructions
     * and tools alone fill the model's window, or the request posted again
     * after the summary reads the same large file back in. Compacting again
     * only repeats it - measured on the LAN Qwen given a 24k window, a turn
     * compacted and re-asked thirty times in six minutes. The turn stops there,
     * saying how small the window is and how much of it MCode's own part takes.
     */
    let compactedAt: number | undefined
    const futile = (at: number) => compactedAt !== undefined && at - compactedAt <= 1
    // Said on the step's own reply, as every coded failure is, and the turn ended there.
    const stopTooSmall = async (message: AssistantMessage, fixed: number): Promise<never> => {
      const window = this.config.modelEntry(session.model)?.contextWindow ?? 0
      message.finish = "error"
      message.error = `This model's context window (${window} tokens) is too small: the conversation is still over it after compacting, and MCode's instructions and tools take about ${fixed} tokens.`
      message.errorCode = "error.contextTooSmall"
      message.errorParams = { window: window.toLocaleString("en-US"), fixed: fixed.toLocaleString("en-US") }
      message.time.completed = Date.now()
      await this.store.saveMessage(message)
      throw new Shown(new CodedError(message.error, "error.contextTooSmall", message.errorParams))
    }
    for (let step = 0; ; step++) {
      if (controller.signal.aborted) return
      // The reference's `isLastStep`: tools that may not be called, and an instruction to write.
      const lastStep = limit !== undefined && step >= limit
      /*
       * And a stop, for a provider that does not honour being told no tools.
       *
       * `lastStep` only adds the instruction and asks for `toolChoice: "none"`.
       * Nothing ended the loop, so a local OpenAI-compatible server that
       * ignores `tool_choice` - which several shims do - kept calling tools and
       * the turn ran, and billed, until the user pressed Stop, with the very
       * setting meant to cap it switched on (R25-B3).
       */
      if (limit !== undefined && step > limit) break

      /*
       * Anything typed while the last step ran has to be on disk before the
       * transcript is read, or the model answers without it and the message
       * looks ignored. This is also the only point at which a steered message
       * can be taken on board: the request for this step has not been built
       * yet, whereas one already in flight cannot be added to.
       */
      await this.steering.get(sessionID)?.written
      /*
       * plan: MiMo picks each step's agent from the latest user message, so a
       * plan approved in the last step - which wrote the approval as a message
       * from the build agent - is carried out from this step on, in the same
       * run: build's prompt, build's tools, and writes no longer refused.
       */
      if (planning && session.agent === "plan") {
        const now = await this.store.get(sessionID)
        if (now && now.agent !== "plan") {
          session = { ...session, agent: now.agent }
          ;({ system, systemTail } = await this.systemFor(session))
          this.turnAgents.set(sessionID, session.agent)
        }
      }
      const stored = await this.store.messages(sessionID)
      const delivered = this.markDelivered(sessionID, stored)
      if (delivered.length) await this.openSteeredTurn(sessionID, session.directory, delivered, stored)
      /*
       * A cut reply is carried on only while it is still the last thing in the
       * conversation. Once the user's words have come in after it, the rest is
       * an answer to them as well, and belongs below them: welded into the cut
       * message it would show above the question it answers, and the undo turn
       * the steered message opened would take in a reply from the one before.
       */
      if (continuing && (delivered.length || stored.at(-1)?.id !== continuing.id)) continuing = undefined
      // session chat: a message from another conversation says so, in the request only; automation: a scheduled task's run says so too.
      // MiMo's pruning comes first, so the older tool output is already trimmed before anything is framed around it.
      // MiMo's recall hint: a conversation with memory or tasks is told, each step, where to look before asking.
      /*
       * MiMo's loop-streak crop: a stretch of steps that all did the same thing
       * is dropped from the request before anything else is built around it.
       * Telling a model to change course in a request three quarters made of
       * the course it is on rarely lands; taking the repetition out does.
       */
      const crops = stored.flatMap((message) => (message.role === "user" ? (message.crops ?? []) : []))
      const cropped = applyCrops(this.contextFor(session, stored), crops)
      const chatted = withRecallHint(withAutomationNotes(withChatHeaders(prunedHistory(cropped, pruneLevel))), await this.recallFor(session))
      // MiMo: from a turn's second step on, what the user sent meanwhile is framed as sent mid-task;
      // skills: what a message loaded follows it, after the framing so it is never taken for typed words;
      // this turn's continuation notes follow the replies they answer; and three identical steps
      // in a row bring a note to change approach.
      // The checkpoint note rides a user message's reminders, so it goes
      // inside withSkillReminders - the one merger that folds reminders
      // into the text the model actually reads. Fires the note made this
      // turn are counted here because the note never reaches the store.
      const framed = step > 0 ? frameSteered(chatted) : chatted
      const checked = withPatchCheckpoint(framed, {
        local: this.isLocal(session),
        fired: this.checkpointFires(sessionID, framed),
      })
      if (checked !== framed) this.noteCheckpointFire(sessionID, framed)
      const history = forWire(
        await withAttachmentData(
          withSameStepsNote(withNotes(withSkillReminders(checked), notes)),
          session.directory,
          attachmentData,
        ),
        session.model,
      )

      /*
       * The conversation's own level (the user's choice, 2026-10-11: MiMo keeps
       * one app-wide value), sent only for a model whose menu offers levels -
       * clamped to them.
       */
      const menu = this.config.menu(session.model)
      const effort = effortToSend(menu.levels, session.effort ?? config.effort, menu.preferred)

      const assistant: AssistantMessage =
        continuing ??
        ({
          id: Identifier.message(),
          sessionID,
          role: "assistant",
          model: session.model,
          agent: session.agent,
          effort,
          parts: [],
          time: { created: Date.now() },
        } satisfies AssistantMessage)
      /*
       * The reply is open again: the limit it hit is not how it ends, and it
       * has no completion time until it stops for a reason of its own.
       */
      const carried = continuing !== undefined
      // The step after one the output limit cut goes without thinking (`afterCut`).
      const noThinking = afterCut
      afterCut = false
      if (carried) {
        assistant.finish = undefined
        assistant.time.completed = undefined
        /*
         * The note asking for the rest has been sent with this step's request,
         * and after it the reply is no longer a cut one. Left on, every later
         * step of the turn told the model a finished reply had been cut off;
         * it goes back on below only if this step is cut again.
         */
        const kept = (notes.get(assistant.id) ?? []).filter((note) => note !== LENGTH_NOTE && note !== THOUGHT_LENGTH_NOTE && note !== INTERRUPTED_NOTE)
        if (kept.length) notes.set(assistant.id, kept)
        else notes.delete(assistant.id)
      }
      /* What the reply already says, so this step's own words can be told apart from it below. */
      const said = carried ? textOf(assistant) : ""
      const before = carried ? assistant.usage : undefined
      // Set again below, and only there: every other way out of this step starts a message of its own.
      continuing = undefined
      await this.store.saveMessage(assistant)

      /*
       * MiMo's mid-stream loop check: the reply is watched as it is written and
       * cut where it starts repeating itself, rather than being read after the
       * fact.
       */
      const sentHistory: Message[] = lastStep
        ? [
            ...history,
            /*
             * Sent as the user, where the reference sends it as the
             * assistant. A trailing assistant message is a prefill to
             * Anthropic - the model continues that text rather than
             * answering it - and a prefill cannot be combined with extended
             * thinking, which MCode asks for by default. Copying the role
             * would import a 400 on every Anthropic turn that reached the
             * limit. Nothing changes for an OpenAI-compatible provider,
             * where either role is an ordinary message.
             */
            {
              id: `${assistant.id}:steps`,
              sessionID,
              role: "user" as const,
              text: maxStepsPrompt(limit!),
              attachments: [],
              time: { created: Date.now() },
            },
          ]
        : resumed && step === 0
          ? [
              ...history,
              // A request that ends on the model's own broken reply reads as a prefill; a line from the user does not.
              {
                id: `${assistant.id}:resume`,
                sessionID,
                role: "user" as const,
                text: resumed === "restart" ? RESTART_PROMPT : RESUME_PROMPT,
                attachments: [],
                time: { created: Date.now() },
              },
            ]
          : lead && step === 0
            ? [
                ...history,
                // subagents: request only, like the resume line - the transcript keeps the command as typed.
                {
                  id: `${assistant.id}:subtask`,
                  sessionID,
                  role: "user" as const,
                  text: SUBTASK_PROMPT,
                  attachments: [],
                  time: { created: Date.now() },
                },
              ]
            : history
      // subagents: a subagent is never handed the actor tool, so it cannot start subagents of its own,
      // nor the session chat tools, which refuse a subagent anyway and only cost it a wasted call;
      // one asked for structured output has the tool it returns it through.
      const sentTools = [...this.offeredTools(session), ...(outputSchema ? [structuredOutputTool(outputSchema)] : [])]
      // The output asked for, fitted to what the window has left (OpenCode v2, d9987ef9); see `promptSince`.
      const modelKey = `${session.model.provider}/${session.model.model}`
      const estimated = requestTokens({ system, systemTail, tools: sentTools, history: sentHistory })
      const prompt = promptSince(this.promptAnchors.get(sessionID), modelKey, estimated)
      const maxOutput = fitOutput(maxOutputTokens(session.model, this.config.modelEntry(session.model)), this.config.modelEntry(session.model), prompt)

      const monitor = createLoopMonitor()
      let outcome: Awaited<ReturnType<SessionRunner["stream"]>>
      try {
        outcome = await this.stream(adapter, assistant, {
        apiKey: tokens?.access ?? apiKey,
        model: session.model,
        system,
        systemTail,
        history: sentHistory,
        tools: sentTools,
        // MiMo's last step: the tools stay defined, since the history carries calls to them, but none may be called.
        ...(lastStep ? { toolChoice: "none" as const } : {}),
        effort: effort ?? "",

        signal: controller.signal,
        baseURL: definition.baseURL,
        /*
         * A custom provider's headers are collected by the form, stored, and
         * carried onto the definition, but until they are named here they never
         * reach a turn - the definition is read for its baseURL alone.
         */
        headers: definition.headers,
        /*
         * Which efforts this model actually accepts. Without it the OpenAI
         * adapter sends `reasoning_effort` for every model, including the ones
         * whose variants list is empty, so hiding the composer's effort pill
         * would only stop the user choosing a level - the wire would still
         * carry one the provider rejects. With no level to send, the list is
         * empty, which withholds the field everywhere.
         */
        variants: effort ? this.config.variants(session.model) : [],
        accountId: tokens?.accountId,
        maxOutput,
        outputLimit: this.config.modelEntry(session.model)?.maxOutput,
        // MiMo's prompt cache key and session affinity, and the hour-long cache where the model asks for it.
        sessionID,
        cacheTTL: this.config.modelEntry(session.model)?.cacheTTL,
        // What the model reads besides text: an attachment it cannot read goes as a note.
        inputs: modelInputs(this.config.modelEntry(session.model)),
        // MiMo's interleaved reasoning, for a model that reads its own reasoning back.
        interleaved: interleavedField(definition.kind, session.model, this.config.modelEntry(session.model)),
        // MiMo's family sampling and provider switches.
        sampling: samplingFor(session.model.model, this.config.modelEntry(session.model)?.temperature === true),
        extra: {
          ...providerExtras(session.model.provider, this.config.modelEntry(session.model)?.reasoning === true, sessionID),
          ...(noThinking ? thinkingOffExtra(session.model.provider, definition.kind, definition.handEntered === true, definition.baseURL) : {}),
        },
        ...(noThinking ? { thinkingOff: true } : {}),
      }, monitor, carried)
      } catch (failure) {
        /*
         * A provider that refuses the request as too long is answered the way
         * MiMo answers it: an overflow compaction, the user's request posted
         * again after the summary, and the step run again. The refusal is
         * already on the transcript, in red, from `stream`. Only one rescue per
         * step - a summary that is itself too large is a real failure, and the
         * original refusal is left to stand.
         */
        const reason = failure instanceof Shown ? failure.reason : failure
        if (rescued !== step && !controller.signal.aborted && isOverflowError(reason, describe(reason))) {
          if (futile(step)) await stopTooSmall(assistant, requestTokens({ system, systemTail, tools: sentTools, history: [] }))
          rescued = step
          compactedAt = step
          const compacted = await this.compactForOverflow(session, controller.signal)
          if (!compacted) throw failure
          session = compacted
          step -= 1
          /*
           * Run again into a message of its own, even when this step was
           * continuing a reply. That reply now lies before the compaction mark,
           * where the request no longer reaches it: the rest of it would be
           * written into a message the model cannot see, above the summary and
           * the request posted again after it.
           */
          continue
        }
        throw failure
      }
      // A call cut part-way reports as a tool call; the provider's own finish says it was the limit.
      if (outcome && (outcome.stop === "max_tokens" || outcome.finishReason === "length" || outcome.finishReason === "max_tokens")) afterCut = true
      if (outcome === undefined) {
        // Aborted mid-stream. Persist whatever arrived so the transcript is honest.
        assistant.finish = "aborted"
        assistant.time.completed = Date.now()
        await this.store.saveMessage(assistant)
        return
      }

      // MiMo's cost: cache reads and writes at their own prices, reasoning at the output price.
      const usage = { ...outcome.usage, cost: costOf(outcome.usage, this.config.modelEntry(session.model)) }
      /*
       * A continued reply carries both requests' figures. The words it wrote
       * add up, and so does what they cost; what was sent does not - the second
       * request was the same conversation over again, and the context ring
       * reads the message's input to say how full the window is, so adding the
       * two would have it report twice the context that exists.
       */
      assistant.usage = before
        ? {
            input: usage.input,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
            output: before.output + usage.output,
            reasoning: before.reasoning + usage.reasoning,
            cost: before.cost + usage.cost,
          }
        : usage
      await this.store.addUsage(sessionID, usage)
      // What this request came to as the provider counted it, beside the estimate it was sized by.
      const promptSize = usage.input + usage.cacheRead + usage.cacheWrite
      if (promptSize > 0) this.promptAnchors.set(sessionID, { model: modelKey, measured: promptSize, estimated })
      /*
       * MiMo's count trigger: once the tokens the provider reports reach 90%
       * of the window, a turn that goes on is compacted as an overflow before
       * the model is asked again, and one that ends is compacted when the next
       * turn starts. Nothing for a model whose window is not known - a
       * discovered model reports 0 - which has only the refusal to fall back on.
       */
      const overflowing = isOverflowByCount(usage, this.config.modelEntry(session.model))
      /*
       * Whether the next tool's output is capped at half the usual, as MiMo's
       * `pressureCaps` does. Read from the count the provider just reported
       * against the room this model has: a conversation this near the line
       * spends 50 KB on every tool result otherwise, and crosses it sooner
       * than MiMo's would.
       */
      this.pressured.set(sessionID, underPressure(usage, this.config.modelEntry(session.model)))

      if (outcome.stop === "refusal") {
        assistant.finish = "refusal"
        /*
         * A refusal is one of MiMo's coded failures (CONTENT_BLOCKED), so the
         * card can say it in the reader's language. The English stays as the
         * message for anything that logs it.
         */
        assistant.errorCode = "error.contentBlocked"
        const base =
          outcome.finishReason === "content_filter"
            ? "The provider's content filter stopped this reply."
            : "The model declined to continue with this request."
        // With what the provider said about it, where it said anything: `Blocked (cyber): <its sentence>`.
        const said = outcome.refusal
        assistant.error = said ? [said.category ? `${base} (${said.category})` : base, said.explanation].filter(Boolean).join(" ") : base
        // Shown under the card's own sentence, as every coded failure's detail is.
        if (said) assistant.errorParams = { detail: [said.category ? `(${said.category})` : "", said.explanation ?? ""].filter(Boolean).join(" ") }
        assistant.time.completed = Date.now()
        await this.store.saveMessage(assistant)
        return
      }

      /*
       * MiMo's n-gram check: a reply that has fallen into repeating its own
       * wording is told to change tack, twice at most. Request only, as the
       * continuation notes are, and it never ends a turn by itself - a step
       * that called tools carries on regardless.
       */
      // What this step wrote, which on a continuation is the reply so far minus what it already said.
      const replied = textOf(assistant).slice(said.length)
      /* The stream was cut mid-reply for repeating itself, as MiMo cuts its own. */
      const looped = outcome.finishReason === LOOP_FINISH
      if (looped) {
        // A call announced while the stream was cut never ran and has no settled arguments to run with.
        assistant.parts = assistant.parts.filter((part) => part.type !== "tool")
      }
      const repeatNote = repeatNoteFor(replied, repeated)
      if (repeatNote) {
        repeated += 1
        notes.set(assistant.id, [...(notes.get(assistant.id) ?? []), repeatNote])
      } else if (looped) {
        /*
         * Both recovery prompts are spent and it is still repeating. MiMo ends
         * the session here ("max recovery exceeded, terminating"); this ends
         * the turn with the failure on the message instead, which is as far as
         * a conversation the user can keep typing into should go.
         */
        assistant.finish = "error"
        assistant.error = LOOP_ENDED
        assistant.errorCode = LOOP_ENDED_CODE
        assistant.time.completed = Date.now()
        await this.store.saveMessage(assistant)
        return
      }

      /*
       * MiMo's text-loop recovery, which watches whole steps where the n-gram
       * check watches inside one: the same step written out again, three times
       * over, is a model that has run out of ideas rather than one making slow
       * progress. Two notes at most, then the streak crop below takes over.
       */
      if (replied.trim()) {
        digests.push(stepDigest(replied))
        if (digests.length > TEXT_LOOP_BUFFER) digests.shift()
        const textNote = textLoopNoteFor(digests, textLooped)
        if (textNote) {
          textLooped += 1
          notes.set(assistant.id, [...(notes.get(assistant.id) ?? []), textNote])
          digests.length = 0
        }
      }
      await this.cropStreak(sessionID)

      let pending = assistant.parts.filter((part): part is ToolPart => part.type === "tool")
      if (outcome.stop !== "tool_use" || pending.length === 0) {
        const next = continuationFor(assistant, outcome.stop, outcome.finishReason, session.model.model, continued, said)
        /*
         * One copy of each note per message. A reply cut twice hangs both of
         * its notes off the same message now that a continuation stays in it,
         * and the same sentence twice over reads as a fault rather than as
         * emphasis.
         */
        const had = notes.get(assistant.id) ?? []
        if (next.note && !had.includes(next.note)) notes.set(assistant.id, [...had, next.note])
        /*
         * A tool call written as prose, run in this same step.
         *
         * `continuationFor` has read back the shapes small local models
         * actually write. Asking for the call again costs a step and, on those
         * models, usually brings the same prose back, so what was parsed is
         * filed as ordinary pending parts instead. Each name is resolved
         * against what this request offered - a call for a tool that was never
         * offered is dropped rather than run into an `invalid` row - and the
         * rest falls through to the execution below, so the permission checks,
         * the loop detectors and the undo recording see these calls exactly as
         * they see one that came through the wire.
         */
        if (next.recovered?.length) {
          const offered = sentTools.map((tool) => tool.name)
          for (const call of next.recovered) {
            const name = resolveToolName(call.name, offered)
            if (!name) continue
            assistant.parts.push({
              type: "tool",
              id: Identifier.part(),
              callID: `recovered_${Identifier.part()}`,
              name,
              status: "pending",
              input: call.input,
              time: { created: Date.now() },
            })
          }
          await this.store.saveMessage(assistant)
          pending = assistant.parts.filter((part): part is ToolPart => part.type === "tool" && part.status === "pending")
          if (pending.length === 0) {
            /*
             * Every recovered call named a tool this request never offered.
             * Asking again would ping-pong forever on models without a step
             * cap, so the same limit a written-out call burns applies here.
             */
            continued.textTool += 1
            notes.set(assistant.id, [
              "Recovered tool call(s) written as text, but none matched a tool this request offers. Make the call again as a real tool call.",
            ])
            if (continued.textTool >= CONTINUATION_LIMITS.textTool) {
              assistant.error = "The model kept writing tool calls for tools this request does not offer."
              assistant.errorCode = "error.invalidTool"
              assistant.finish = "error"
              assistant.time.completed = Date.now()
              await this.store.saveMessage(assistant)
              return
            }
          }
        }
        if (!next.recovered?.length || pending.length === 0) {
          /*
           * A failure the turn is still retrying (the prose-tool-call note rides
           * beside its error) must not brand the reply an error: the note asks
           * the model again, and only the step that really ends the turn
           * records the failure on the message.
           */
          const askingAgain = Boolean((next.note || repeatNote) && !lastStep)
          if (next.error && !askingAgain) {
            assistant.error = next.error.message
            if (next.error.code) assistant.errorCode = next.error.code
          }
          assistant.finish = outcome.stop === "max_tokens" ? "max_tokens" : next.error && !askingAgain ? "error" : "end_turn"
          assistant.time.completed = Date.now()
          await this.store.saveMessage(assistant)
          if (askingAgain) {
            // The rest of a sentence the limit cut belongs to the reply that started it.
            if (next.note === LENGTH_NOTE || next.note === THOUGHT_LENGTH_NOTE || next.note === INTERRUPTED_NOTE) continuing = assistant
            if (overflowing) {
              if (futile(step)) await stopTooSmall(assistant, requestTokens({ system, systemTail, tools: sentTools, history: [] }))
              compactedAt = step
              const compacted = await this.compactForOverflow(session, controller.signal)
              if (compacted) {
                session = compacted
                // The cut reply is behind the compaction mark now, out of the request; the next step starts a message after it.
                continuing = undefined
              }
            }
            continue
          }
          /*
           * The model has stopped, but the user may have typed while it was
           * writing. Read with nothing awaited after the save above, so that a
           * message arriving from this instant onwards is the release's business
           * and cannot fall between the two. A turn that ends over the line is
           * compacted when the next one starts, as MiMo's is.
           */
          if (this.steered(sessionID)) continue
          /*
           * 追求目标: the last thing between a finished turn and an idle
           * conversation. A judge reads the transcript; a goal it says is not met
           * writes a reminder and the turn runs on, at most MAX_GOAL_REACT times.
           * Anything the user typed meanwhile is read again first, since the
           * judge request takes a moment and the answer they typed during it
           * belongs to this turn.
           */
          if (await this.goalGate(session, controller.signal)) {
            if (this.steered(sessionID)) continue
            if (overflowing) {
              if (futile(step)) await stopTooSmall(assistant, requestTokens({ system, systemTail, tools: sentTools, history: [] }))
              compactedAt = step
              session = (await this.compactForOverflow(session, controller.signal)) ?? session
            }
            continue
          }
          return
        }
      }

      /*
       * Stopped between the reply and its tools.
       *
       * `stream` already returns undefined for an abort it saw, but an adapter
       * can only notice a signal where it looks at one, and the last place it
       * looks is before its final read. A Stop that lands after that returns a
       * perfectly ordinary outcome, and running its calls is the one thing this
       * turn must not do - the tools write to disk, and whether each of them
       * re-checks the signal before it does is not something this loop should
       * depend on. MiMo cannot reach this case at all: its tools execute inside
       * the stream, so cutting the stream is what stops them.
       */
      if (controller.signal.aborted) {
        assistant.finish = "aborted"
        assistant.time.completed = Date.now()
        await this.store.saveMessage(assistant)
        return
      }

      // Tools in one assistant turn are independent, so run them together and
      // let each report its own transitions.
      // At most STEP_TOOL_LIMIT at once (N11-20): twenty shell commands in one reply used to be twenty processes together.
      const calls = new Semaphore(STEP_TOOL_LIMIT)
      await Promise.all(
        pending.map((part) =>
          calls.run(() => this.runTool({ part, assistant, session: { id: sessionID, directory: session.directory, model: session.model }, signal: controller.signal })),
        ),
      )
      // A turn that has been probing for a long while without changing the project is told to stop and think (loop-health.ts).
      const wandering = this.loopWatch(sessionID).wander.note()
      if (wandering) notes.set(assistant.id, [...(notes.get(assistant.id) ?? []), wandering])

      assistant.time.completed = Date.now()
      /*
       * Stopped while its tools were still running.
       *
       * The transcript decides whether to say a turn was stopped by reading its
       * finish, and this path left that unset - so a turn killed while a command
       * was running looked, in its footer, exactly like one that had finished on
       * its own. The only sign was red text inside a tool row. Stopping while
       * the model was still writing already recorded it; stopping a moment later
       * did not.
       */
      if (controller.signal.aborted) assistant.finish = "aborted"
      await this.store.saveMessage(assistant)

      if (controller.signal.aborted) return
      // MiMo compacts a step that crossed the line mid-turn as an overflow, before the model is asked again.
      if (overflowing) {
        if (futile(step)) await stopTooSmall(assistant, requestTokens({ system, systemTail, tools: sentTools, history: [] }))
        compactedAt = step
        session = (await this.compactForOverflow(session, controller.signal)) ?? session
      }
    }
  }

  /**
   * How much this turn trims off its own older tool output, read from the last
   * finished reply: what that step reported, and when it landed.
   *
   * MiMo runs the same check after every finished turn and rewrites its stored
   * parts; MCode decides here and rewrites only the request (session/prune.ts),
   * so the transcript the user reads keeps every result whole.
   */
  private async pruneLevelFor(session: TurnSession): Promise<PruneLevel> {
    const live = this.liveMessages(session, await this.store.messages(session.id))
    const last = [...live]
      .reverse()
      .find((message): message is AssistantMessage => message.role === "assistant" && message.usage !== undefined)
    const entry = this.config.modelEntry(session.model)
    return pruneLevelFor({
      tokens: last?.usage,
      entry,
      lastAssistantAt: last?.time.completed ?? last?.time.created,
      ...(entry?.cacheTTL ? { cacheTTL: entry.cacheTTL } : {}),
    })
  }

  /**
   * Streams one assistant turn, materializing parts as the adapter reports
   * them. Returns undefined if the turn was aborted.
   */
  private async stream(
    adapter: ProviderAdapter,
    assistant: AssistantMessage,
    request: Parameters<ProviderAdapter["stream"]>[0],
    monitor?: { append(text: string): boolean },
    /*
     * This request continues a reply the output limit cut off, so its first
     * words are the rest of a sentence already on screen: they are appended to
     * the text part that holds it rather than starting one of their own.
     */
    carryOn = false,
  ): Promise<TurnOutcome | undefined> {
    /*
     * MiMo cuts a repeating reply where it is, with a `takeUntil` over its own
     * stream. The adapters here take one signal, so the cut is a controller of
     * this app's own that follows the turn's: aborting it ends the request
     * without ending the turn, and what was written up to that point stays.
     */
    const inner = new AbortController()
    const follow = () => inner.abort()
    /*
     * A signal that fell before this point never fires again: a cancel that
     * lands while the step is still being prepared (a subagent cancelled just
     * after it was spawned) would otherwise leave the request running to its end.
     */
    if (request.signal.aborted) inner.abort()
    else request.signal.addEventListener("abort", follow, { once: true })
    let cut = false
    /**
     * Whether this attempt has had anything at all out of the provider.
     *
     * MiMo splits its retries by exactly this (`hasProviderOutput`): a failure
     * before the first event is the request phase, and one after it is the
     * stream phase. The two wait on different curves - see `retryDecision`.
     */
    let streamed = false
    // Text and reasoning blocks are keyed by the index the adapter reports;
    // tools are keyed by call id, since only the provider knows how those
    // interleave with the rest of the turn.
    const blocks = new Map<number, TextPart | ReasoningPart>()
    /*
     * The message as this attempt found it, so a retry puts it back rather than
     * emptying it. Everything here belongs to an earlier step of the same
     * reply, which this request is not going to stream again.
     */
    const base = [...assistant.parts]
    /* The part a continuation writes into, and how much of it was there before. */
    const carried = carryOn ? assistant.parts.findLast((part): part is TextPart => part.type === "text") : undefined
    const carriedAt = carried?.text.length ?? 0
    /* Whether this attempt has already taken the carried part; only the reply's first block continues it. */
    let taken = false
    let dirty = false
    const flush = setInterval(() => {
      if (!dirty) return
      dirty = false
      // Not flushed to the platter: overwritten half a second from now, and the step's own save is durable (N11-29).
      void this.store.saveMessage(assistant, true, false)
    }, 500)

    const announce = (part: AssistantPart) => {
      assistant.parts.push(part)
      // N11-4: the part, not the whole message. The message itself was announced before the stream opened.
      this.bus.publish({ type: "message.part.updated", sessionID: assistant.sessionID, messageID: assistant.id, part: structuredClone(part) })
    }

    const append = (part: TextPart | ReasoningPart, text: string) => {
      // Where this append belongs, so a window that missed one can tell (N11-32).
      const at = part.text.length
      part.text += text
      dirty = true
      this.bus.publish({
        type: "message.delta",
        sessionID: assistant.sessionID,
        messageID: assistant.id,
        partID: part.id,
        text,
        at,
      })
    }

    const emit = (event: TurnEvent) => {
      streamed = true
      if (event.type === "text.start") {
        // The rest of the cut-off sentence goes back into the part that holds its beginning.
        if (carried && !taken) {
          taken = true
          blocks.set(event.index, carried)
          /*
           * And that part moves to the end of the reply, so the thinking this
           * step did sits before the words rather than after the answer - both
           * in the transcript and in what is sent back to the model.
           */
          const at = assistant.parts.indexOf(carried)
          if (at >= 0 && at < assistant.parts.length - 1) {
            assistant.parts.splice(at, 1)
            assistant.parts.push(carried)
            this.bus.publish({ type: "message.updated", message: structuredClone(assistant) })
          }
          return
        }
        const part: TextPart = { type: "text", id: Identifier.part(), text: "" }
        blocks.set(event.index, part)
        announce(part)
      } else if (event.type === "reasoning.start") {
        const part: ReasoningPart = {
          type: "reasoning",
          id: Identifier.part(),
          text: "",
          time: { created: Date.now() },
        }
        blocks.set(event.index, part)
        announce(part)
      } else if (event.type === "text.delta" || event.type === "reasoning.delta") {
        const part = blocks.get(event.index)
        /*
         * Both the words and the thinking, as MiMo watches them: its n-gram
         * check runs on its `text-delta` and its `reasoning-delta` alike, so a
         * model stuck repeating one passage inside its own thinking has the
         * stream cut too. Nothing here could reach the reasoning arm until the
         * thinking was asked for at all.
         *
         * The check decides before the append. A reply the socket delivered in
         * one read is parsed into deltas after the cut has fired, and keeping
         * them stored the whole loop the cut was meant to stop (15,200
         * characters on a Linux loopback): once `cut` is set, neither the
         * delta that fired it nor the ones already parsed behind it are kept.
         */
        if (!cut && monitor?.append(event.text)) {
          cut = true
          inner.abort()
        } else if (!cut && part) {
          append(part, event.text)
        }
      } else if (event.type === "block.end") {
        const part = blocks.get(event.index)
        if (part?.type === "reasoning") {
          part.time.completed = Date.now()
          dirty = true
        }
      } else if (event.type === "reasoning.signature") {
        // Kept so the thinking can be sent back to the same model, as MiMo keeps it.
        const part = blocks.get(event.index)
        if (part?.type === "reasoning") {
          part.signature = event.signature
          if (event.itemID) part.itemID = event.itemID
          dirty = true
        }
      } else if (event.type === "tool") {
        announce({
          type: "tool",
          id: Identifier.part(),
          callID: event.callID,
          name: event.name,
          status: "pending",
          input: {},
          time: { created: Date.now() },
        })
      }
    }

    try {
      let outcome: TurnOutcome | undefined
      /* When this request first failed: each kind of failure is retried for so long and no longer. */
      let firstFailure: number | undefined
      for (let attempt = 1; outcome === undefined; attempt++) {
        /*
         * N11-21: another conversation on the same provider was just told to
         * wait. Knocking anyway only earns another 429 and makes the account's
         * limit last longer, so this one waits too - in the open, with the same
         * countdown and the same way out.
         */
        const held = cooldownLeft(assistant.model.provider)
        // Under a second is the tail of a wait this request has just sat out itself, not a reason for another row.
        if (held >= 1000) {
          // No sentence of its own: the window says a rate_limit wait in the reader's language (error.rateLimited).
          const retry = { attempt, message: "", next: Date.now() + held, kind: "rate_limit" }
          this.retrying.set(assistant.sessionID, { messageID: assistant.id, ...retry })
          this.bus.publish({ type: "message.updated", message: { ...structuredClone(assistant), retry } })
          try {
            if (!(await waitFor(held, request.signal))) throw new DOMException("Aborted", "AbortError")
          } finally {
            this.retrying.delete(assistant.sessionID)
          }
        }
        try {
          // The SDK's own quiet retries are off here: this loop retries in the open.
          outcome = await adapter.stream({ ...request, retries: 0, signal: inner.signal }, emit)
        } catch (err) {
          /*
           * The stream was cut for repeating itself rather than by the user or
           * by a fault: the step ends here, with whatever was written, and the
           * turn decides what to say about it. Retrying would replay the loop.
           */
          if (cut && !request.signal.aborted) {
            // The loop's own condition ends it; nothing of this step is retried.
            outcome = { stop: "end_turn", toolCalls: [], usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, finishReason: LOOP_FINISH }
            continue
          }
          if (request.signal.aborted || (err instanceof Error && err.name === "AbortError")) throw err
          /*
           * MiMo retries a step while replaying it is safe, and a tool call
           * that has only begun to stream is still safe: its `retrySafe` turns
           * false on the assembled `tool-call` event, not on the input-start or
           * the argument deltas before it.
           *
           * This used to give up the moment a tool part had been announced -
           * which is as soon as the name is known, with the arguments still
           * streaming - so a socket dropped mid-arguments, the very case
           * retrying exists for, ended the turn in red instead of being sent
           * again. Nothing has run at this point either: tools execute after
           * `stream` returns, and whatever streamed so far is dropped just
           * below, so replaying the step repeats no side effect.
           */
          firstFailure ??= Date.now()
          /*
           * MiMo's two phases: a request that failed before the provider had
           * said a single word is tried again on its quick request curve, and
           * one that failed part-way through a reply waits out its kind.
           */
          const decision = retryDecision(err, attempt, Date.now() - firstFailure, Math.random(), streamed ? "stream" : "request")
          if (!decision) throw err
          /*
           * OpenCode v2's continuation: a stream that broke after the reply had
           * begun keeps its words and is continued, rather than thrown away and
           * asked for from the start. Only the words: a tool call cut part-way
           * cannot be finished by another request, so a step that had begun one
           * is sent again whole, as before; and this attempt's thinking goes,
           * since a block cut before its signature cannot be sent back.
           */
          const fresh = assistant.parts.filter((part) => !base.includes(part))
          const grew = (carried !== undefined && carried.text.length > carriedAt) || fresh.some((part) => part.type === "text" && part.text.trim() !== "")
          const resume = streamed && grew && !cut && !fresh.some((part) => part.type === "tool")
          streamed = false
          if (resume) {
            assistant.parts = assistant.parts.filter((part) => base.includes(part) || part.type === "text")
            taken = false
            blocks.clear()
            dirty = false
            const retry = { attempt, message: describe(err), next: Date.now() + decision.wait, kind: decision.kind, max: decision.max }
            if (decision.kind === "rate_limit") noteRateLimit(assistant.model.provider, retry.next)
            this.retrying.set(assistant.sessionID, { messageID: assistant.id, ...retry })
            this.bus.publish({ type: "message.updated", message: { ...structuredClone(assistant), retry } })
            try {
              if (!(await waitFor(decision.wait, request.signal))) throw new DOMException("Aborted", "AbortError")
            } finally {
              this.retrying.delete(assistant.sessionID)
            }
            // The step ends here; the turn continues it in this same reply with the note asking for the rest.
            outcome = { stop: "end_turn", toolCalls: [], usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, finishReason: INTERRUPTED_FINISH }
            continue
          }
          /*
           * Tried again from the start, as MiMo's engine does: what the failed
           * attempt managed to stream is dropped, because the next one streams
           * it again. The retry itself rides on the published copy only, so the
           * next update for the message clears the row without anything to undo.
           */
          /*
           * Back to where this attempt began, not to nothing: a reply being
           * continued past the output limit already holds the words an earlier
           * step wrote, and this request is not going to stream those again.
           */
          assistant.parts = [...base]
          if (carried) carried.text = carried.text.slice(0, carriedAt)
          taken = false
          blocks.clear()
          dirty = false
          const retry = { attempt, message: describe(err), next: Date.now() + decision.wait, kind: decision.kind, max: decision.max }
          // Everyone else on this provider holds off for as long as it asked (N11-21).
          if (decision.kind === "rate_limit") noteRateLimit(assistant.model.provider, retry.next)
          // Kept as well as published, so a window that reconnects mid-wait is told (N11-17).
          this.retrying.set(assistant.sessionID, { messageID: assistant.id, ...retry })
          this.bus.publish({ type: "message.updated", message: { ...structuredClone(assistant), retry } })
          try {
            if (!(await waitFor(decision.wait, request.signal))) throw new DOMException("Aborted", "AbortError")
          } finally {
            this.retrying.delete(assistant.sessionID)
          }
        }
      }

      /*
       * An adapter that sees its signal fall may simply stop reading and hand
       * back what it had rather than throwing, as the chat-completions one
       * does. A cut stream is a cut stream either way, and whatever it half
       * assembled is not a reply to act on.
       */
      if (cut && !request.signal.aborted) outcome = { stop: "end_turn", toolCalls: [], usage: outcome.usage, finishReason: LOOP_FINISH }

      // Tool arguments stream as partial JSON, so they are only trustworthy
      // once the turn closes - fill them in from the settled outcome.
      for (const call of outcome.toolCalls) {
        let part = assistant.parts.find(
          (candidate): candidate is ToolPart => candidate.type === "tool" && candidate.callID === call.callID,
        )
        if (part) part.input = call.input
        else {
          part = {
            type: "tool",
            id: Identifier.part(),
            callID: call.callID,
            name: call.name,
            status: "pending",
            input: call.input,
            time: { created: Date.now() },
          }
          announce(part)
        }
        if (call.inputError) this.inputErrors.set(part, call.inputError)
      }

      await this.store.saveMessage(assistant)
      return outcome
    } catch (err) {
      if (request.signal.aborted || (err instanceof Error && err.name === "AbortError")) return undefined
      assistant.finish = "error"
      assistant.error = describe(err)
      /*
       * MiMo's card shows a short sentence and keeps the raw text aside; the
       * code names the sentence and `detail` keeps what the provider said.
       */
      const failure = failureCode(err)
      if (failure) {
        assistant.errorCode = failure.code
        assistant.errorParams = failure.params ?? { detail: failureDetail(err) }
      }
      assistant.time.completed = Date.now()
      await this.store.saveMessage(assistant)
      // Rethrown to end the turn, but flagged: it is on the message already,
      // and broadcasting it again put two identical notices on one failure.
      throw new Shown(err)
    } finally {
      clearInterval(flush)
      request.signal.removeEventListener("abort", follow)
    }
  }

  private async runTool(input: {
    part: ToolPart
    assistant: AssistantMessage
    session: { id: string; directory: string; model: ModelRef }
    signal: AbortSignal
  }): Promise<void> {
    const { part, assistant } = input
    /*
     * N11-4: every one of the six places below changes this one part and
     * nothing else, so this one part is what goes out. A bash command reporting
     * its output ten times a second used to clone and serialise the whole
     * message - the largest one measured on this machine is 244 KB - and send
     * it to every window.
     */
    const publish = () => this.bus.publish({ type: "message.part.updated", sessionID: assistant.sessionID, messageID: assistant.id, part: structuredClone(part) })

    /*
     * A name that does not resolve is repaired rather than refused, which is
     * what the reference does in `experimental_repairToolCall`
     * (node-BBwF64dM.js @22826700). Two steps, in its order.
     *
     * First, lowercase it: a model that writes `Read` or `Bash` has named a
     * tool that exists, spelled the way prose spells it, and the reference
     * takes that call rather than throwing it away.
     *
     * Second, hand the call to `invalid`, whose whole purpose is to tell the
     * model in one sentence which name it used and why nothing ran. That reads
     * back as a completed call with an explanation, where the previous
     * behaviour - a part error saying "Unknown tool: X" - gave the model
     * nothing to correct from and looked in the transcript like the app had
     * broken.
     */
    // subagents: a subagent asked for structured output has one more tool, made from its schema.
    const schema = part.name === STRUCTURED_OUTPUT ? (await this.store.get(input.session.id))?.subagent?.outputSchema : undefined
    // A tool the lab has switched off is not there to be called, as it is not there in MiMo.
    const labOff = (name: string) => withheldByLab(name, this.config.get())
    const lookup = (name: string) =>
      (labOff(name) ? undefined : findTool(name)) ??
      (schema && name === STRUCTURED_OUTPUT ? structuredOutputTool(schema) : undefined) ??
      this.mcp?.tools(input.session.directory).find((entry) => entry.name === name)
    let tool = lookup(part.name)
    if (!tool) {
      // MiMo's repair: the name without case, then with dashes, underscores and spaces ignored.
      const offered = [...repairableNames(), ...(schema ? [STRUCTURED_OUTPUT] : []), ...(this.mcp?.tools(input.session.directory).map((entry) => entry.name) ?? [])]
      const resolved = resolveToolName(part.name, offered)
      const repaired = resolved ? lookup(resolved) : undefined
      if (resolved && repaired) {
        part.name = resolved
        tool = repaired
      } else {
        tool = findTool("invalid")
        // As MiMo's model library words it: the names this request did offer, so the model can pick one.
        const info = await this.store.get(input.session.id)
        const available = info ? [...this.offeredTools(info).map((entry) => entry.name), ...(info.subagent?.outputSchema ? [STRUCTURED_OUTPUT] : [])] : []
        part.input = {
          tool: part.name,
          error: `Model tried to call unavailable tool '${part.name}'. ${available.length ? `Available tools: ${available.join(", ")}.` : "No tools are available."}`,
        }
        part.name = "invalid"
      }
    }
    if (!tool) {
      part.status = "error"
      part.error = `Unknown tool: ${part.name}`
      part.time.completed = Date.now()
      publish()
      return
    }

    /*
     * Arguments that do not fit the tool's parameters are refused before
     * anything runs or anyone is asked. The part is an error the model reads
     * back like any other, so the turn continues, but it is marked recoverable:
     * the call was a generation slip, not a failure of the tool, and the
     * transcript draws it as a step that was not executed.
     */
    const unreadable = this.inputErrors.get(part)
    // Argument names a model spelled its own way (filePath for file_path) are put onto the schema's, as MiMo's repair does.
    if (tool.name !== "invalid" && !unreadable) {
      part.input = normalizeToolInput(part.input, tool.parameters)
      // And a value this model's own schema turned into a string is read back as the number the tool declares.
      part.input = inputForTool(input.session.model, tool.parameters, part.input) as typeof part.input
      const repaired = repairToolArguments(tool.name, tool.parameters, part.input)
      part.input = repaired.input as typeof part.input
    }
    const problems = tool.name === "invalid" ? [] : unreadable ? [unreadable] : argumentProblems(tool.parameters, part.input)
    if (problems.length) {
      part.status = "error"
      /*
       * MiMo's TOOL_ARGUMENT_INVALID: the row says one sentence in the
       * reader's language, and the English instructions - which are addressed
       * to the model, not to a person - stay on `error`, where the model reads
       * them. Without the code a Chinese reader got two lines of English
       * prose in the step for what is a common, self-correcting slip.
       */
      part.errorCode = "error.toolArgumentInvalid"
      part.error = refusedArgumentsNote(tool.name, problems, tool.parameters)
      part.metadata = { recoverable: true }
      part.time.started = Date.now()
      part.time.completed = part.time.started
      this.settleForLoops(input.session.id, part, input.signal)
      publish()
      await this.store.saveMessage(assistant, true)
      return
    }

    // subagents: a subagent's calls belong to the turn of the conversation it works for.
    const owner = this.owners.get(input.session.id) ?? input.session.id
    // Told not to test: driving a browser or an app is what the verification loops were made of.
    if (tool.name === "app" && this.turn(owner).noTesting) {
      part.status = "error"
      part.error = NO_TESTING_REFUSAL
      part.metadata = { recoverable: true }
      part.time.started = Date.now()
      part.time.completed = part.time.started
      this.settleForLoops(input.session.id, part, input.signal)
      publish()
      await this.store.saveMessage(assistant, true)
      return
    }

    part.status = "running"
    part.time.started = Date.now()
    publish()

    const reach = reachOf(part.name)
    if (reach !== "reads") {
      const turn = this.turn(owner)
      // A shell command and an MCP tool leave no account of themselves, so the
      // turn is only describable if the project can be compared afterwards.
      if (reach === "opaque") {
        turn.opaque = true
        // The recording is told too: a file that changed while two turns were
        // watching belongs to whichever of them could change one in silence.
        turn.watching?.opaque()
      }
      /*
       * Waited for here, and only here. The opening photograph has to be
       * finished before anything writes, or the write lands inside it and the
       * turn appears to have changed nothing at all.
       */
      await turn.watching?.ready()
    }

    /*
     * The answers to this call's questions, kept on the part so the transcript
     * can say what was asked and how it was answered after a reload. Written as
     * each one is decided, so the row appears while an approved command runs.
     */
    const decisions: PermissionRecord[] = []
    const stopListening = this.permissions.onDecided(part.callID, (record) => {
      decisions.push(record)
      part.metadata = { ...(part.metadata ?? {}), permissions: [...decisions] }
      publish()
    })

    try {
      /*
       * Several tools name a permission bucket and then never mention it again -
       * reading, listing, globbing, searching, the todo list all just run. Their
       * buckets were therefore settings with nothing behind them: a person could
       * switch reading off and watch files carry on being read. This is the only
       * point that every call passes through, so it is where those buckets are
       * consulted. Inside the try, so a refusal is caught below and written onto
       * the part as an error, which the model reads in this same turn.
       */
      await this.checkRepeated(part, assistant, input.session.id, input.signal)
      await this.permissions.check({
        sessionID: input.session.id,
        messageID: assistant.id,
        callID: part.callID,
        tool: tool.name,
        kind: tool.permission ?? "",
        arguments: part.input,
        directory: input.session.directory,
      })
      /*
       * plan: only the tools that turn on the promise are told about it - the
       * three that write, and the one that asks to stop planning - so an
       * ordinary read costs no extra look at the conversation's record.
       */
      const planControl = PLAN_AWARE.has(tool.name) ? await this.planControl(await this.store.require(input.session.id)) : undefined
      const result = await tool.execute(part.input, {
        sessionID: input.session.id,
        messageID: assistant.id,
        callID: part.callID,
        directory: input.session.directory,
        permissions: this.permissions,
        questions: this.questions,
        signal: input.signal,
        snapshot: (target) => this.record(owner, target),
        removeExplicitWatermark: this.config.get().removeExplicitWatermark === true,
        reportOperation: async (kind) => {
          if (tool.name !== "app" || part.status !== "running") return
          part.metadata = { ...(part.metadata ?? {}), operationKind: kind ?? "none" }
          publish()
          // A reloaded window reads the transcript while the operation is still running.
          await this.store.saveMessage(assistant, true)
        },
        shell: this.config.get().shell,
        // websearch: the user's choice of service, asked once and kept in the settings.
        webSearch: {
          selection: () => this.config.get().websearch,
          select: async (selection) => void (await this.config.set({ websearch: selection })),
        },
        toolOutputs: this.toolOutputs,
        // Codex's exec default (10k tokens) for open reasoning models on a step budget; others keep bash's own.
        ...(promptFamily(input.session.model.model) === "reasoning" ? { maxOutputTokens: REASONING_MAX_OUTPUT_TOKENS } : {}),
        subagent: this.workers.has(input.session.id),
        // session chat: a conversation's own calls only; a subagent has no contacts.
        chat: this.workers.has(input.session.id) ? undefined : this.chat,
        // subagents: offered to a conversation's own calls; a subagent's calls get none, so there is no nesting.
        subagents: this.workers.has(input.session.id)
          ? undefined
          : this.subagentControl({ parentID: input.session.id, messageID: assistant.id, callID: part.callID, signal: input.signal }),
        progress: (text) => {
          // As MiMo's metadata updates: only while the call runs, so a late write never replaces a finished result.
          if (part.status !== "running") return
          part.output = text
          publish()
        },
        skills: () => this.skillsFor(input.session.directory),
        tasks: tool.name === "task" ? await this.taskControl(input.session.id) : undefined,
        // plan: the write tools read it before they change anything; plan_exit ends planning through it.
        plan: planControl,
        // read: the model's inputs, a copy of what it attaches, and the instructions already given.
        ...(tool.name === "read" ? this.readSupport(input.session.id) : {}),
      })
      /*
       * MiMo's shared cap, for every tool that did not cap its own output. The
       * note suggests handing the file to an explore subagent only where this
       * conversation is offered the actor tool; a subagent is told to grep.
       */
      const offered = result.metadata?.truncated === undefined ? await this.store.get(input.session.id) : undefined
      const capped =
        result.metadata?.truncated === undefined
          ? await this.toolOutputs
              .cap(result.output, {
                delegate: offered ? this.offeredTools(offered).some((entry) => entry.name === "actor") : false,
                pressure: this.pressured.get(owner) ?? false,
                // The call reached here, so it did not throw: MiMo's "succeeded but was cut".
                outcome: "success",
              })
              .catch(() => undefined)
          : undefined
      part.status = "completed"
      part.output = capped?.text ?? result.output
      part.title = result.title ?? part.title
      part.metadata = capped?.truncated ? { ...result.metadata, truncated: true, outputPath: capped.file } : result.metadata
      // MiMo's tool results carry media to the model; one attached by path is read when the request is built.
      if (result.attachments?.length) part.attachments = result.attachments
      // MiMo's interactive notice: the reader is told once why a command that wanted to be typed at was skipped.
      await this.noteInteractiveRefusal(owner, part)
    } catch (err) {
      part.status = "error"
      // Tool failures are told to the model as text so it can adapt; only
      // infrastructure problems bubble out of the turn.
      const expected = err instanceof ToolError || err instanceof PermissionDenied
      part.error = expected ? (err as Error).message : `Tool crashed: ${describe(err)}`
      if (err instanceof ToolError && err.code) {
        part.errorCode = err.code
        part.errorParams = err.params
      }
      /*
       * Cut off by Stop rather than failing on its own; the transcript settles
       * the step quietly, as MiMo does. Marked interrupted too, as MiMo marks
       * it: a call that had already printed something (a command's output on
       * its card) is then handed to the model as that output, so it knows how
       * far the command got; one that had printed nothing keeps its own
       * account of the stop.
       */
      if (input.signal.aborted) part.metadata = { ...(part.metadata ?? {}), aborted: true, interrupted: true }
    } finally {
      stopListening()
      // A finished tool hands back metadata of its own, which would otherwise replace the record.
      if (decisions.length) part.metadata = { ...(part.metadata ?? {}), permissions: decisions }
      part.time.completed = Date.now()
      this.settleForLoops(input.session.id, part, input.signal)
      publish()
      await this.store.saveMessage(assistant, true)
    }
  }

  /**
   * MiMo's interactive notice: a command that declared itself interactive was
   * answered rather than run, and the reader is told so once per conversation.
   *
   * The model already has its own sentence in the tool result. What was missing
   * was the reader's half: the card said the command failed and nothing said
   * why, or that it was this app's doing rather than the command's. MiMo pushes
   * one `kind: "notice"` per engine session on the first such call and sets
   * `interactiveNotified`; this is the same, kept on the conversation so a
   * reload does not bring it back, and filed under the owner so a subagent's
   * refusal does not raise a second one.
   */
  private async noteInteractiveRefusal(sessionID: string, part: ToolPart): Promise<void> {
    if (part.name !== "bash" || part.metadata?.interactive !== true) return
    const session = await this.store.get(sessionID)
    if (!session || session.interactiveNotice) return
    await this.store.update(sessionID, { interactiveNotice: true })
    this.bus.publish({ type: "session.notice", sessionID, code: "toast.bashInteractive" })
  }

  /** Each conversation's system prompt as first built, and what it was built for (see `run`). */
  private readonly prefixes = new Map<string, { key: string; system: string }>()

  /** Tools a conversation said to always let repeat, by session: MiMo's `always` on its doom-loop ask. */
  private readonly repeatsAllowed = new Map<string, Set<string>>()

  /**
   * What each running conversation's tool calls are adding up to
   * (session/loop-health.ts), and the incident the last settled call raised.
   * A call is only judged once it has settled - its status, output, exit code
   * and diff are what the detectors read - so the incident it raises is asked
   * about before the next call runs, as MiMo's processor checks each call as
   * it finishes. Started afresh with every turn.
   */
  private readonly loopWatches = new Map<string, { monitor: LoopMonitor; wander: WanderWatch; incident?: LoopIncident }>()

  private loopWatch(sessionID: string): { monitor: LoopMonitor; wander: WanderWatch; incident?: LoopIncident } {
    const known = this.loopWatches.get(sessionID)
    if (known) return known
    const made = { monitor: new LoopMonitor(sessionID), wander: new WanderWatch() }
    this.loopWatches.set(sessionID, made)
    return made
  }

  /** A call has settled: the monitor reads it, and any incident waits for the next call. A stopped call says nothing about a loop. */
  private settleForLoops(sessionID: string, part: ToolPart, signal: AbortSignal): void {
    if (signal.aborted) return
    const watch = this.loopWatch(sessionID)
    watch.wander.consume(part)
    const incident = watch.monitor.consume(part)
    if (incident) watch.incident = incident
  }

  /**
   * The crop MiMo makes once a turn has been going round for three finished
   * steps: the whole repeated span is remembered on the user message that
   * opened it, and every request from here on leaves it out. Nothing is
   * deleted - the transcript still shows every step the model took.
   */
  private async cropStreak(sessionID: string): Promise<void> {
    const session = await this.store.get(sessionID)
    if (!session) return
    const stored = this.liveMessages(session, await this.store.messages(sessionID))
    const finished = stored.filter(
      (message): message is AssistantMessage => message.role === "assistant" && (message.finish !== undefined || message.time.completed !== undefined),
    )
    const span = detectStreak(finished)
    if (!span) return
    const anchor = [...stored].reverse().find((message): message is UserMessage => message.role === "user" && message.id < span.from)
    if (!anchor) return
    if ((anchor.crops ?? []).some((crop) => crop.from === span.from && crop.to === span.to && crop.key === span.key)) return
    await this.store.saveMessage({ ...anchor, crops: [...(anchor.crops ?? []), span] })
  }

  /**
   * MiMo's doom-loop check, in its four kinds.
   *
   * MCode used to notice only the first of them - three calls in a row with
   * byte-identical arguments - which never catches the two that actually cost
   * a user their turn: the same fix written to one file over and over with
   * cosmetic differences, and one failing command retried after every attempt
   * to appease it. The fourth kind, four fruitless actions of one sort in a
   * row, catches a turn hunting for a file that is not there.
   *
   * All four raise the same question: once lets it run, always lets that tool
   * repeat for the rest of the conversation, and a refusal - or typed
   * feedback, or dismissing the question - refuses the call, and the model
   * reads that refusal and carries on, as it does a refused permission.
   */
  private async checkRepeated(part: ToolPart, assistant: AssistantMessage, sessionID: string, signal: AbortSignal): Promise<void> {
    const watch = this.loopWatch(sessionID)
    const incident: LoopIncident | undefined = repeatsCall(assistant.parts, part) ? { kind: "same-call", tool: part.name } : watch.incident
    watch.incident = undefined
    if (!incident || this.repeatsAllowed.get(sessionID)?.has(incident.tool)) return
    if (!incident.note) incident.note = suggestLoopNextStep(incident)
    // Asked once per incident: the count starts again whatever the answer, so one `once` does not ask again immediately.
    watch.monitor.reset()
    const [answer] = await this.questions.ask({
      sessionID,
      questions: [
        {
          question: `${describeLoop(incident)} Suggested next step: ${incident.note}. Let it run again?`,
          header: part.name,
          options: [
            { label: LOOP_ANSWERS.once, description: "" },
            { label: LOOP_ANSWERS.always, description: "" },
            { label: LOOP_ANSWERS.reject, description: incident.note },
          ],
        },
      ],
      tool: { messageID: assistant.id, callID: part.callID },
      signal,
      loop: { tool: part.name },
    })
    const chosen = (answer ?? []).map((entry) => entry.trim()).filter(Boolean)
    if (chosen.includes(LOOP_ANSWERS.once)) return
    if (chosen.includes(LOOP_ANSWERS.always)) {
      const allowed = this.repeatsAllowed.get(sessionID) ?? new Set<string>()
      allowed.add(incident.tool)
      this.repeatsAllowed.set(sessionID, allowed)
      return
    }
    const feedback = chosen.find((entry) => entry !== LOOP_ANSWERS.reject)
    const said = feedback
      ? `The user stopped this repeated call and said: ${feedback}`
      : incident.kind === "same-call"
        ? "The user stopped this call: it repeated the previous two calls with the same input."
        : `The user stopped this call: ${describeLoop(incident)}`
    throw new PermissionDenied(part.name, `${said}\nIt was not run. Do not repeat it; ${incident.note}`)
  }

  /** tasks: changes to one conversation's registry, one after another, so parallel subagents never lose each other's. */
  private readonly taskQueues = new Map<string, Promise<unknown>>()

  /** tasks: the registry a call works on - a subagent's is its parent's, as MiMo's actors share their session's - and who is asking. */
  private async taskControl(sessionID: string): Promise<TaskControl> {
    const session = await this.store.get(sessionID)
    const root = session?.parentID ?? sessionID
    const who = { owner: session?.subagent?.id ?? "main", subagent: Boolean(session?.parentID) }
    return { update: (change) => this.changeTasks(root, who, change) }
  }

  /** tasks: one change to a conversation's registry, queued behind the others. */
  private changeTasks<T>(root: string, who: { owner: string; subagent: boolean }, change: (list: TaskItem[], who: { owner: string; subagent: boolean }) => { list: TaskItem[]; result: T }): Promise<T> {
    const next = (this.taskQueues.get(root) ?? Promise.resolve()).then(async () => {
      const current = (await this.store.get(root))?.tasks ?? []
      const { list, result } = change(current, who)
      if (JSON.stringify(list) !== JSON.stringify(current)) await this.store.update(root, { tasks: list })
      return result
    })
    this.taskQueues.set(root, next.catch(() => undefined))
    return next
  }

  /** tasks: the tasks a subagent holds that are not finished (open, in progress or blocked), as MiMo's completion gate reads them. */
  private async heldTasks(child: SessionInfo): Promise<TaskItem[]> {
    const owner = child.subagent?.id
    if (!owner || !child.parentID) return []
    const tasks = (await this.store.get(child.parentID))?.tasks ?? []
    return listedTasks(tasks, {}, Date.now()).filter((task) => task.owner === owner)
  }

  /** subagents: the actor tool's actions, bound to the conversation and call they were asked from. */
  private subagentControl(call: SubagentCall): SubagentControl {
    return {
      run: (spec, timeoutMs) => this.runSubagent(call, spec, timeoutMs),
      spawn: (spec) => this.spawnSubagent(call, spec),
      status: (id) => this.subagentStatus(call.parentID, id),
      wait: (id, timeoutMs) => this.waitSubagent(call, id, timeoutMs),
      cancel: (id) => this.cancelSubagent(call.parentID, id),
      send: (id, message) => this.sendSubagent(call.parentID, id, message),
      models: async (options) => this.subagentModels(options),
    }
  }

  /**
   * subagents: makes a subagent's conversation and starts its first turn.
   *
   * The subagent is a conversation of its own, linked to the call that started
   * it, and runs through the same loop, store and permission queue as any other:
   * its questions reach the dock under its own id, which the window files under
   * the parent. A run's changes are recorded into the turn waiting for it; a
   * background one's are its own, since the turn that started it may be long over.
   */
  private async startSubagent(call: SubagentCall, spec: SubagentSpec, background: boolean): Promise<{ child: SessionInfo; worker: Worker; taskNote?: string }> {
    const parent = await this.store.require(call.parentID)
    // tasks: a task_id the registry does not hold is dropped and the call says so, as MiMo's does.
    let taskID = spec.taskID
    let taskNote: string | undefined
    if (taskID && !TASK_ID.test(taskID)) {
      taskNote = `note: task_id "${taskID}" is not a task id (T1, T1.2), so the subagent runs without one. Task ids come from the task tool.`
      taskID = undefined
    } else if (taskID && !(parent.tasks ?? []).some((task) => task.id === taskID)) {
      taskNote = `note: there is no task ${taskID} in this conversation, so the subagent runs without one. Create it with the task tool first, or leave task_id out.`
      taskID = undefined
    }
    const model = spec.model ? this.modelFor(spec.model) : parent.model
    const type = spec.type
    const counted = `${parent.id}:${type}`
    const earlier = (await this.store.list()).filter((session) => session.parentID === parent.id && session.subagent?.type === type)
    // Read and reserved with nothing awaited between, so calls started together never share a number.
    const number =
      Math.max(this.numbering.get(counted) ?? 0, ...earlier.map((session) => Number(/-(\d+)$/.exec(session.subagent?.id ?? "")?.[1] ?? 0))) + 1
    this.numbering.set(counted, number)
    const name = `${type}-${number}`

    // plan: an explore subagent only reads; anything else builds, even started from a planning turn (see subagentAgent).
    const agent: AgentName = subagentAgent(type)
    const child = await this.store.create({
      directory: parent.directory,
      model,
      agent,
      // It thinks as hard as the conversation that sent it.
      ...(parent.effort ? { effort: parent.effort } : {}),
      title: spec.description || name,
      parentID: parent.id,
      parentMessageID: call.messageID,
      parentCallID: call.callID,
      subagent: {
        type,
        id: name,
        ...(background ? { background: true } : {}),
        status: "running",
        turns: 1,
        ...(taskID ? { taskID } : {}),
        ...(spec.command ? { command: spec.command } : {}),
        ...(spec.outputSchema ? { outputSchema: spec.outputSchema } : {}),
      },
    })
    await this.store.saveMessage({
      id: Identifier.message(),
      sessionID: child.id,
      role: "user",
      text: spec.prompt,
      attachments: [],
      time: { created: Date.now() },
    })
    // tasks: the task it was started for becomes its own and under way, as MiMo's actor starts it.
    const started = taskID
    if (started) {
      await this.changeTasks(parent.id, { owner: name, subagent: false }, (list, who) => ({
        list: applyTask(list, { action: "start", id: started }, { ...who, now: Date.now() }).tasks,
        result: undefined,
      })).catch(() => undefined)
    }
    const worker = this.work(child, { background, owner: background ? undefined : (this.owners.get(parent.id) ?? parent.id) })
    return { child, worker, taskNote }
  }

  /** subagents: claims a subagent's session and runs its turn in the background of whoever asked. */
  private work(child: SessionInfo, options: { background: boolean; owner?: string }): Worker {
    const controller = new AbortController()
    this.running.set(child.id, controller)
    if (options.owner) this.owners.set(child.id, options.owner)
    // A background subagent is never shown a question, as MiMo's background actors are not.
    this.permissions.markBackground(child.id, options.background ? child.parentID : undefined)
    // Open to follow-ups from the start, as a conversation's own turn is to the user's.
    this.steering.set(child.id, { waiting: [], written: Promise.resolve() })
    const worker: Worker = {
      sessionID: child.id,
      parentID: child.parentID ?? "",
      name: child.subagent?.id ?? child.id,
      description: child.title,
      background: options.background,
      notify: options.background,
      activity: Date.now(),
      stalledNoticed: false,
      settled: Promise.resolve({ kind: "cancelled" }),
      admitted: false,
    }
    this.workers.set(child.id, worker)
    worker.settled = this.childTurn(child, worker, controller)
    if (options.background) this.watch()
    return worker
  }

  /** subagents: one turn of a subagent, then its record, then word to its parent if it is owed any. */
  private async childTurn(child: SessionInfo, worker: Worker, controller: AbortController): Promise<ChildOutcome> {
    let failure: unknown
    // tasks: how often the completion gate sent it back, and the last words it had said by then.
    const gate: TaskGate = { turns: 0 }
    let release: (() => void) | undefined
    try {
      /*
       * N11-20: MiMo's process-wide subagent gate. Past min(16, 2 x cores)
       * subagents at once the rest queue here - still shown as started, not
       * refused - and one stopped while it waits simply never takes a permit.
       */
      release = await this.subagentGate.acquire(controller.signal).catch(() => undefined)
      worker.admitted = Boolean(release)
      let reminded = 0
      // tasks: how often the progress checker sent it back for its task's record.
      let recorded = 0
      while (release) {
        await this.run(child.id, this.config.apiKey(child.model.provider) ?? "", controller)
        await this.steering.get(child.id)?.written
        if (controller.signal.aborted) break
        // A turn that ended in an error ends the work; what it had said before stays as its partial result.
        const ended = await this.lastReply(child.id)
        if (ended?.finish === "error" || ended?.finish === "refusal") break
        gate.said = answerIn(ended) || gate.said
        // A follow-up that landed as the last step ended is answered in this turn too.
        if (this.steered(child.id)) continue
        // Asked for structured output and ended without it: reminded, at most twice, as MiMo retries.
        const schema = (await this.store.get(child.id))?.subagent?.outputSchema
        if (schema && reminded < STRUCTURED_RETRIES && structuredResult(await this.store.messages(child.id)) === undefined) {
          reminded++
          await this.store.saveMessage({
            id: Identifier.message(),
            sessionID: child.id,
            role: "user",
            text: STRUCTURED_REMINDER,
            attachments: [],
            inbox: { from: "main" },
            time: { created: Date.now() },
          })
          continue
        }
        // tasks: MiMo's completion gate - a general subagent ending with open or started tasks in its hands is sent back, at most twice.
        if (child.subagent?.type === "general" && gate.turns < TASK_GATE_TURNS) {
          const held = (await this.heldTasks(child)).filter((task) => task.status === "open" || task.status === "in_progress")
          if (held.length) {
            gate.turns++
            await this.store.saveMessage({
              id: Identifier.message(),
              sessionID: child.id,
              role: "user",
              text: taskGateReminder(held),
              attachments: [],
              synthetic: true,
              time: { created: Date.now() },
            })
            continue
          }
        }
        /*
         * tasks: and MiMo's progress checker after it - a subagent carrying a
         * task id may not finish until that task's record is written and whole.
         * Sent back at most three times, as MiMo bounds it.
         */
        if (recorded < MAX_PROGRESS_REACT) {
          const note = await this.missingProgress(child)
          if (note) {
            recorded++
            await this.store.saveMessage({
              id: Identifier.message(),
              sessionID: child.id,
              role: "user",
              text: note,
              attachments: [],
              synthetic: true,
              time: { created: Date.now() },
            })
            continue
          }
        }
        break
      }
    } catch (err) {
      failure = err
      if (!(err instanceof Shown)) this.bus.publish({ type: "session.error", sessionID: child.id, error: describe(err) })
    } finally {
      release?.()
      // Closed with nothing awaited since the last look, so a follow-up either made it in or finds the turn over.
      this.steering.delete(child.id)
      if (!this.owners.has(child.id)) await this.commitSnapshot(child.id).catch(() => undefined)
      this.running.delete(child.id)
      this.workingIn.delete(child.id)
      this.owners.delete(child.id)
      this.bus.publish({ type: "session.idle", sessionID: child.id })
    }

    const outcome = await this.outcomeOf(child, controller.signal.aborted, failure, gate)
    const current = await this.store.get(child.id)
    if (current?.subagent) {
      await this.store
        .update(child.id, {
          subagent: {
            ...current.subagent,
            status: "idle",
            outcome: outcome.kind,
            error: outcome.kind === "failure" ? outcome.error : undefined,
            reported: outcome.kind === "success" && (outcome.status || outcome.unfinished) ? { status: outcome.status, unfinished: outcome.unfinished } : undefined,
            ended: Date.now(),
          },
        })
        .catch(() => undefined)
    }
    // Let go only once its outcome is on record, so a wait that finds no worker reads how it ended.
    if (this.workers.get(child.id) === worker) this.workers.delete(child.id)
    this.unwatch()
    if (worker.notify && current) await this.notifyParent(worker.parentID, this.noticeOf(current, outcome)).catch(() => undefined)
    return outcome
  }

  /**
   * tasks: what a subagent that is ending without its task's record is told,
   * or nothing when it is not owed one.
   *
   * Only a subagent that was given a task id, and only one that could write the
   * file: explore has no tool that would make it, and nothing is asked while
   * memory writing is switched off. `memory/guard.ts` lets the subagent write
   * that folder under either the conversation it works for or its own id, so
   * both are looked at before it is told the file is missing.
   */
  private async missingProgress(child: SessionInfo): Promise<string | undefined> {
    const taskID = child.subagent?.taskID
    if (!taskID || child.subagent?.type !== "general") return undefined
    const root = historyService()?.memoryRoot
    if (!root || !memoryWritable()) return undefined
    const owners = [child.parentID, child.id].filter((id): id is string => Boolean(id))
    let best: { file: string; missing: string[] } | undefined
    for (const owner of owners) {
      const file = progressPath(root, owner, taskID)
      const body = await readFile(file, "utf8").catch(() => undefined)
      if (body === undefined) {
        best ??= { file, missing: [...PROGRESS_SECTIONS] }
        continue
      }
      const missing = missingProgressSections(body)
      if (!missing.length) return undefined
      best = { file, missing }
    }
    return best && best.missing.length ? progressReminder(taskID, best.file, best.missing) : undefined
  }

  /**
   * subagents: how a subagent's turn ended, read from its transcript. A turn
   * the completion gate sent it back for that failed leaves the answer given
   * before it, with the status lowered to partial, as MiMo's gate does.
   */
  private async outcomeOf(child: SessionInfo, aborted: boolean, failure: unknown, gate: TaskGate = { turns: 0 }): Promise<ChildOutcome> {
    if (aborted) return { kind: "cancelled" }
    const messages = await this.store.messages(child.id).catch((): Message[] => [])
    const last = [...messages].reverse().find((message): message is AssistantMessage => message.role === "assistant")
    const failed = failure !== undefined || last?.finish === "error" || last?.finish === "refusal"
    if (failed && !gate.turns) {
      return {
        kind: "failure",
        error: last?.error ?? describe(failure instanceof Shown ? failure.reason : failure),
        ...(gate.said ? { partial: gate.said } : {}),
      }
    }
    // subagents: asked for structured output, the object it returned is its answer, and none is a failure.
    if ((await this.store.get(child.id))?.subagent?.outputSchema) {
      const value = structuredResult(messages)
      if (value === undefined) return { kind: "failure", error: `The subagent ended without returning its result through ${STRUCTURED_OUTPUT}.` }
      return this.reconciled(child, JSON.stringify(value, null, 2), failed, false)
    }
    // After the gate sent it back, a turn that said nothing leaves the answer it gave before, as MiMo keeps it.
    return this.reconciled(child, (!failed && answerIn(last)) || (gate.turns ? gate.said : "") || "", failed, true)
  }

  /**
   * tasks: a subagent's answer as its parent reads it, reconciled as MiMo's
   * actor does: tasks a general subagent still holds lower the status it
   * reported - to partial while any is open or under way, to blocked when only
   * blocked ones are left - and are named after a prose answer.
   */
  private async reconciled(child: SessionInfo, answer: string, gateFailed: boolean, prose: boolean): Promise<ChildOutcome> {
    const header = prose ? statusHeader(answer) : undefined
    const held = child.subagent?.type === "general" ? await this.heldTasks(child) : []
    const lowered = held.some((task) => task.status !== "blocked") ? "partial" : held.length ? "blocked" : undefined
    const status = lowered ?? (gateFailed && (!header || header.status === "success") ? "partial" : header?.status)
    const unfinished = held.length ? held.map((task) => task.id) : undefined
    return {
      kind: "success",
      answer: prose && unfinished ? unfinishedNamed(answer, unfinished) : answer,
      ...(status ? { status } : {}),
      ...(header ? { summary: header.summary } : {}),
      ...(unfinished ? { unfinished } : {}),
    }
  }

  /** subagents: a subagent's latest reply. */
  private async lastReply(sessionID: string): Promise<AssistantMessage | undefined> {
    const messages = await this.store.messages(sessionID).catch((): Message[] => [])
    return [...messages].reverse().find((message): message is AssistantMessage => message.role === "assistant")
  }

  /**
   * subagents: a subagent's last answer, for wait, as its parent was given it:
   * with the tasks it left unfinished named after it.
   */
  private async answerOf(child: SessionInfo): Promise<string> {
    const answer = child.subagent?.outputSchema ? JSON.stringify(structuredResult(await this.store.messages(child.id)) ?? null, null, 2) : answerIn(await this.lastReply(child.id))
    const unfinished = child.subagent?.reported?.unfinished
    return unfinished?.length && !child.subagent?.outputSchema ? unfinishedNamed(answer, unfinished) : answer
  }

  /** subagents: MiMo's five outcomes, as the parent is told them. */
  private noticeOf(child: SessionInfo, outcome: ChildOutcome): NoticeEntry {
    const base = { subagentID: child.subagent?.id ?? child.id, sessionID: child.id, description: child.title }
    if (outcome.kind === "cancelled") return { notice: { ...base, status: "cancelled" } }
    if (outcome.kind === "failure") {
      return { notice: { ...base, status: "failed", summary: firstLine(outcome.error) }, result: outcome.error, ...(outcome.partial ? { partial: outcome.partial } : {}) }
    }
    if (!outcome.answer) return { notice: { ...base, status: "ended" } }
    // The status its answer reported, as reconciled with its tasks, says how it went.
    const reported = outcome.status
    return {
      notice: {
        ...base,
        status: reported === "failed" ? "failed" : "completed",
        summary: outcome.summary ?? firstLine(outcome.answer),
        ...(reported ? { reported } : {}),
      },
      result: outcome.answer,
    }
  }

  /**
   * subagents: tells a conversation what became of one of its background
   * subagents, as MiMo's inbox does. A turn under way takes the notice at its
   * next step; an idle conversation gets it as a message and a turn to read it.
   */
  private async notifyParent(parentID: string, entry: NoticeEntry): Promise<void> {
    const parent = await this.store.get(parentID)
    if (!parent) return
    const text = noticeText([entry])
    const steering = this.steering.get(parentID)
    if (steering) {
      await this.join(steering, { sessionID: parentID, text }, { notices: [entry.notice] })
      return
    }
    // Set up, compacting or wrapping up a turn: asked again shortly, rather than a second turn being started.
    if (this.running.has(parentID)) {
      setTimeout(() => void this.notifyParent(parentID, entry).catch(() => undefined), 500)
      return
    }
    const message: UserMessage = {
      id: Identifier.message(),
      sessionID: parentID,
      role: "user",
      text,
      attachments: [],
      notices: [entry.notice],
      time: { created: Date.now() },
    }
    await this.store.saveMessage(message)
    // Where no turn can start now, it waits in the transcript for the next message.
    if (parent.revert || !this.config.usable(parent.model.provider)) return
    const opened = this.steering.get(parentID)
    if (opened) {
      opened.waiting.push(message.id)
      return
    }
    if (this.running.has(parentID)) return
    void this.resume(parentID, [message.id])
  }

  /** subagents: run - wait for the subagent's final message, up to the timeout, then leave it working. */
  private async runSubagent(call: SubagentCall, spec: SubagentSpec, timeoutMs = this.subagentTimers.waitMs): Promise<ToolResult> {
    const { child, worker, taskNote } = await this.startSubagent(call, spec, false)
    const noted = (output: string) => (taskNote ? `${taskNote}\n${output}` : output)
    const siblings = this.children.get(call.parentID) ?? new Set<string>()
    siblings.add(child.id)
    this.children.set(call.parentID, siblings)
    const stop = () => this.abort(child.id)
    call.signal.addEventListener("abort", stop, { once: true })
    if (call.signal.aborted) stop()

    let outcome: ChildOutcome | "timeout"
    try {
      outcome = await within(worker.settled, timeoutMs)
    } finally {
      call.signal.removeEventListener("abort", stop)
      siblings.delete(child.id)
      if (!siblings.size && this.children.get(call.parentID) === siblings) this.children.delete(call.parentID)
    }

    const name = child.subagent?.id ?? child.id
    const metadata = { sessionID: child.id, subagent: child.subagent }
    if (outcome === "timeout") {
      // Left working, as MiMo leaves it. Its changes are its own from here: the turn it worked for has moved on.
      this.owners.delete(child.id)
      const note = "The subagent did not finish in the time allowed and is still working. Check on it with status or wait, or cancel it."
      return { output: noted(subagentOutput(name, note, "timeout")), title: child.title, metadata }
    }
    // Stopped with this turn: the call is cut off with it. Stopped some other way: a result that says so, as MiMo's run returns it.
    if (outcome.kind === "cancelled" && call.signal.aborted) throw new ToolError("The subagent was stopped before it finished.")
    if (outcome.kind === "cancelled") {
      return { output: noted(subagentOutput(name, "The subagent was stopped before it finished.", "cancelled")), title: child.title, metadata: { ...metadata, cancelled: true } }
    }
    if (outcome.kind === "failure") throw new ToolError(`The subagent failed: ${outcome.error}${outcome.partial ? `\nPartial result: ${outcome.partial}` : ""}`)
    return {
      output: noted(subagentOutput(name, outcome.answer || "(The subagent ended without a final message.)", outcome.status, outcome.summary)),
      title: child.title,
      metadata,
    }
  }

  /** subagents: spawn - start the subagent and answer at once; its outcome arrives as a notice. */
  private async spawnSubagent(call: SubagentCall, spec: SubagentSpec): Promise<ToolResult> {
    const { child, taskNote } = await this.startSubagent(call, spec, true)
    const name = child.subagent?.id ?? child.id
    return {
      output: [
        ...(taskNote ? [taskNote] : []),
        `actor_id: ${name}`,
        "",
        "Started in the background. Its outcome will arrive as a notification in this conversation; use status or wait if you need it sooner, and send to give it more work.",
      ].join("\n"),
      title: child.title,
      metadata: { sessionID: child.id, subagent: child.subagent, background: true },
    }
  }

  /** subagents: a conversation's subagent, by the name the model was given or by its session id. */
  private async findSubagent(parentID: string, id: string): Promise<SessionInfo | undefined> {
    return (await this.store.list()).find((session) => session.parentID === parentID && (session.subagent?.id === id || session.id === id))
  }

  private unknownSubagent(id: string): ToolResult {
    return { output: JSON.stringify({ status: "unknown", actor_id: id }), title: id, metadata: { status: "unknown" } }
  }

  /** subagents: where a subagent stands, as status and wait report it, under MiMo's field names. */
  private snapshotOf(child: SessionInfo): Record<string, unknown> {
    const state = child.subagent
    const running = this.running.has(child.id)
    /*
     * MiMo's three: a subagent that has been started but is still queued behind
     * the process-wide gate is pending, not running. Saying "running" for one
     * that has not made a single request yet is what made a model wait on a
     * subagent it had, in fact, only put in a queue.
     */
    const worker = this.workers.get(child.id)
    const pending = running && worker !== undefined && !worker.admitted
    return {
      status: pending ? "pending" : running ? "running" : "idle",
      actor_id: state?.id ?? child.id,
      description: child.title,
      agent: state?.type,
      background: state?.background === true,
      turnCount: state?.turns ?? 1,
      lastTurnTime: (!running && state?.ended) || child.updated,
      ...(!running && state?.outcome ? { lastOutcome: state.outcome } : {}),
      ...(!running && state?.error ? { error: state.error } : {}),
      time: { created: child.created, updated: child.updated, ...(!running && state?.ended ? { completed: state.ended } : {}) },
    }
  }

  private reported(child: SessionInfo, output: Record<string, unknown>): ToolResult {
    return { output: JSON.stringify(output), title: child.title, metadata: { sessionID: child.id, subagent: child.subagent, status: output.status } }
  }

  /** subagents: status - a look without waiting. */
  private async subagentStatus(parentID: string, id: string): Promise<ToolResult> {
    const child = await this.findSubagent(parentID, id)
    return child ? this.reported(child, this.snapshotOf(child)) : this.unknownSubagent(id)
  }

  /** subagents: wait - until the subagent is idle, the timeout passes, or the turn asking is stopped. */
  private async waitSubagent(call: SubagentCall, id: string, timeoutMs = this.subagentTimers.waitMs): Promise<ToolResult> {
    let child = await this.findSubagent(call.parentID, id)
    if (!child) return this.unknownSubagent(id)
    const worker = this.workers.get(child.id)
    if (worker) {
      let stop: (() => void) | undefined
      const stopped = new Promise<"stopped">((resolve) => {
        stop = () => resolve("stopped")
        call.signal.addEventListener("abort", stop, { once: true })
        if (call.signal.aborted) resolve("stopped")
      })
      const ended = await within(Promise.race([worker.settled, stopped]), timeoutMs)
      if (stop) call.signal.removeEventListener("abort", stop)
      if (ended === "stopped") throw new ToolError("Stopped while waiting for the subagent.")
      if (ended === "timeout") return this.reported(child, { status: "timeout", actor_id: child.subagent?.id ?? id, description: child.title })
      child = (await this.store.get(child.id)) ?? child
    }
    const snapshot = this.snapshotOf(child)
    if (snapshot.status !== "idle") return this.reported(child, snapshot)
    // An ended subagent's answer comes with it, and so does what a failed one had said by then, as MiMo's wait gives both.
    const outcome = child.subagent?.outcome ?? "success"
    const result = outcome === "cancelled" ? "" : await this.answerOf(child)
    const said = child.subagent?.reported
    return this.reported(child, {
      ...snapshot,
      ...(result && (outcome === "success" || !child.subagent?.outputSchema) ? { result } : {}),
      ...(outcome === "success" && said?.status ? { reportedStatus: said.status } : {}),
      ...(outcome === "success" && !child.subagent?.outputSchema && statusHeader(result) ? { reportedSummary: statusHeader(result)!.summary } : {}),
    })
  }

  /** subagents: cancel - stop a running subagent; one that is idle is left as it is. */
  private async cancelSubagent(parentID: string, id: string): Promise<ToolResult> {
    const child = await this.findSubagent(parentID, id)
    if (!child) return this.unknownSubagent(id)
    const about = {
      actor_id: child.subagent?.id ?? id,
      description: child.title,
      subagent_type: child.subagent?.type,
      background: child.subagent?.background === true,
    }
    const worker = this.workers.get(child.id)
    if (!worker) return this.reported(child, { status: "idle", ...about })
    this.abort(child.id)
    await within(worker.settled, 10_000)
    return this.reported(child, { status: "cancelled", ...about })
  }

  /**
   * subagents: send - a follow-up into the subagent's own history. A turn under
   * way takes it at its next step; an idle subagent takes a new turn for it. The
   * parent is told when that turn ends, as it is for a background subagent.
   */
  private async sendSubagent(parentID: string, id: string, text: string): Promise<ToolResult> {
    let child = await this.findSubagent(parentID, id)
    if (!child) {
      const refused = { queued: false, actor_id: id, error: "There is no subagent with that actor_id in this conversation." }
      return { output: JSON.stringify(refused), title: id, metadata: { status: "unknown" } }
    }
    const inbox = { from: "main" }
    const queued = (target: SessionInfo, messageID: string): ToolResult => ({
      output: JSON.stringify({ queued: true, actor_id: target.subagent?.id ?? id, message_id: messageID }),
      title: target.title,
      metadata: { sessionID: target.id, subagent: target.subagent },
    })

    const worker = this.workers.get(child.id)
    const steering = this.steering.get(child.id)
    if (worker && steering) {
      worker.notify = true
      return queued(child, await this.join(steering, { sessionID: child.id, text }, { inbox }))
    }
    // A turn that is closing is let close; the message then starts the next one.
    if (worker) await worker.settled
    child = (await this.store.get(child.id)) ?? child

    const message: UserMessage = { id: Identifier.message(), sessionID: child.id, role: "user", text, attachments: [], inbox, time: { created: Date.now() } }
    await this.store.saveMessage(message)
    const state = child.subagent ?? { type: "general" as const, id }
    child = await this.store.update(child.id, {
      subagent: { ...state, status: "running", outcome: undefined, error: undefined, ended: undefined, turns: (state.turns ?? 1) + 1 },
    })
    // Another follow-up got there first and started the turn; this one joins it.
    const opened = this.steering.get(child.id)
    const running = this.workers.get(child.id)
    if (opened && running) {
      opened.waiting.push(message.id)
      running.notify = true
      return queued(child, message.id)
    }
    this.work(child, { background: true })
    return queued(child, message.id)
  }

  /**
   * read: what a read in this conversation is told and given - the model's
   * inputs and a connected model that sees pictures, where attached media is
   * kept, and which instruction files the request it will join still carries
   * (the history as this turn sends it: after compaction, with what pruning
   * cleared taken out).
   */
  private readSupport(sessionID: string): Pick<ToolContext, "model" | "keepCopy" | "instructionsGiven"> {
    return {
      model: async () => {
        const session = await this.store.require(sessionID)
        const vision = this.config
          .providers()
          .filter((provider) => provider.configured)
          .flatMap((provider) => provider.models.filter((model) => model.inputs.image).map((model) => `${provider.id}/${model.id}`))
          .sort()[0]
        return { inputs: modelInputs(this.config.modelEntry(session.model)), ...(vision ? { vision } : {}) }
      },
      keepCopy: (source, bytes) => keepReadCopy(path.join(this.dataRoot, "read-media"), source, bytes),
      instructionsGiven: async () => {
        const session = await this.store.require(sessionID)
        const sent = prunedHistory(this.contextFor(session, await this.store.messages(sessionID)), this.turnPrune.get(sessionID) ?? 0)
        return instructionsIn(sent)
      },
    }
  }

  /** subagents: models - what a subagent can be given, from the providers that are connected. */
  private subagentModels(options: { vision: boolean; limit?: number }): ToolResult {
    const all = this.config
      .providers()
      .filter((provider) => provider.configured)
      .flatMap((provider) => provider.models.map((model) => ({ ref: `${provider.id}/${model.id}`, vision: model.inputs.image })))
    const matching = (options.vision ? all.filter((entry) => entry.vision) : all).sort((a, b) => a.ref.localeCompare(b.ref))
    const shown = matching.slice(0, options.limit ?? 50)
    const heading = options.vision ? "Models that read images" : "Models"
    const output = shown.length
      ? [
          `${heading} (${shown.length} of ${matching.length}):`,
          ...shown.map((entry) => `${entry.ref}${entry.vision ? " (vision)" : ""}`),
          ...(matching.length > shown.length ? [`... and ${matching.length - shown.length} more; raise limit to list them.`] : []),
          "Pass one as model when you spawn or run a subagent.",
        ].join("\n")
      : options.vision
        ? "No connected model reads images."
        : "No models are connected."
    return { output, title: heading, metadata: { count: shown.length, total: matching.length, vision: options.vision } }
  }

  /** subagents: a model the actor tool named, as `provider/model` or as an id only one connected provider has. */
  private modelFor(ref: string): ModelRef {
    const providers = this.config.providers().filter((provider) => provider.configured)
    const slash = ref.indexOf("/")
    const named = slash > 0 ? providers.find((provider) => provider.id === ref.slice(0, slash)) : undefined
    if (named && ref.length > slash + 1) return { provider: named.id, model: ref.slice(slash + 1) }
    const matches = providers.filter((provider) => provider.models.some((model) => model.id === ref))
    if (matches.length === 1) return { provider: matches[0]!.id, model: ref }
    throw new ToolError(`No connected model matches "${ref}". Use the models action to list the ones a subagent can be given.`)
  }

  /** subagents: the stall watchdog, MiMo's: every scan, a background subagent quiet past the mark is reported once. */
  private watch(): void {
    if (this.watchdog) return
    this.watchdog = setInterval(() => this.scanStalled(), this.subagentTimers.scanMs)
    this.watchdog.unref?.()
  }

  /** subagents: the watchdog stops with the last background subagent, so the next one starts it on the timings then in force. */
  private unwatch(): void {
    if (!this.watchdog || [...this.workers.values()].some((worker) => worker.background)) return
    clearInterval(this.watchdog)
    this.watchdog = undefined
  }

  private scanStalled(): void {
    const now = Date.now()
    for (const worker of this.workers.values()) {
      if (!worker.background) continue
      const quiet = now - worker.activity
      // Quiet enough to report, reported once per quiet spell; activity, or going past the abandon mark, ends the spell.
      if (!isStalled(quiet, this.subagentTimers)) {
        worker.stalledNoticed = false
        continue
      }
      if (worker.stalledNoticed) continue
      worker.stalledNoticed = true
      const notice: SubagentNotice = {
        subagentID: worker.name,
        sessionID: worker.sessionID,
        description: worker.description,
        status: "stalled",
        quietSeconds: Math.floor(quiet / 1000),
      }
      void this.notifyParent(worker.parentID, { notice }).catch(() => undefined)
    }
    this.unwatch()
  }

  /** subagents: stops one subagent without a word to its parent, and waits a little for it to settle. */
  private async stopSubagent(sessionID: string): Promise<void> {
    const worker = this.workers.get(sessionID)
    if (!worker) return
    worker.notify = false
    this.abort(sessionID)
    await within(worker.settled, 5000)
  }

  /**
   * Everything kept per conversation that nothing else takes away (N11-37):
   * called once the conversation itself is deleted. Each of these used to live
   * for the life of the process - a whole system prompt per conversation among
   * them - because only the turn's own bookkeeping was ever cleared.
   */
  forgetSession(sessionID: string): void {
    this.turnPrune.delete(sessionID)
    this.turnAgents.delete(sessionID)
    this.prefixes.delete(sessionID)
    this.taskQueues.delete(sessionID)
    this.retrying.delete(sessionID)
    this.repeatsAllowed.delete(sessionID)
    this.loopWatches.delete(sessionID)
    this.mcpTrustSkipped.delete(sessionID)
    for (const key of [...this.numbering.keys()]) if (key.startsWith(`${sessionID}:`)) this.numbering.delete(key)
  }

  /** subagents: stops every subagent of a conversation that is being deleted. Stop alone leaves background ones working, as MiMo does. */
  async dropSubagents(parentID: string): Promise<void> {
    const leaving = [...this.workers.values()].filter((worker) => worker.parentID === parentID)
    await Promise.all(leaving.map((worker) => this.stopSubagent(worker.sessionID)))
  }

  /**
   * subagents: a subagent recorded as running that nothing is running - the app
   * closed while it worked - is marked failed, as MiMo marks its orphans.
   */
  private async recoverSubagents(before: number): Promise<void> {
    const sessions = await this.store.list().catch((): SessionInfo[] => [])
    for (const session of sessions) {
      if (session.subagent?.status !== "running" || session.updated > before || this.workers.has(session.id)) continue
      await this.store
        .update(session.id, {
          subagent: { ...session.subagent, status: "idle", outcome: "failure", error: "The app closed while this subagent was working." },
        })
        .catch(() => undefined)
    }
  }
}

/** subagents: the conversation and call an actor tool action was asked from. */
interface SubagentCall {
  parentID: string
  messageID: string
  callID: string
  signal: AbortSignal
}

/** subagents: a subagent taking a turn. */
interface Worker {
  sessionID: string
  parentID: string
  name: string
  description: string
  /** Started with spawn, or woken by send: watched for stalls. */
  background: boolean
  /** Whether its parent is told when this turn ends. */
  notify: boolean
  /** When it last wrote anything. */
  activity: number
  /** This quiet spell has been reported already. */
  stalledNoticed: boolean
  /** Settles once the turn is over and recorded. */
  settled: Promise<ChildOutcome>
  /** False until it has a permit from the subagent gate: started, but not running yet. */
  admitted: boolean
}

type ChildOutcome =
  | { kind: "success"; answer: string; status?: ResultStatus; summary?: string; unfinished?: string[] }
  | { kind: "failure"; error: string; partial?: string }
  | { kind: "cancelled" }

/** tasks: the completion gate's turns so far, and the last answer given before one. */
type TaskGate = { turns: number; said?: string }

/** tasks: an answer with the tasks its subagent left unfinished named after it. */
function unfinishedNamed(answer: string, ids: readonly string[]): string {
  return `${answer}\n\n**Unfinished tasks**: ${ids.join(", ")}`
}

/**
 * A reply's words, exactly as they were written.
 *
 * Joined with nothing between them: a reply continued past the output limit
 * carries on in the middle of whatever it was writing, so anything inserted at
 * the seam lands inside a word or inside a fence.
 */
function textOf(message: AssistantMessage): string {
  return message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
}

type NoticeEntry = { notice: SubagentNotice; result?: string; partial?: string }

/** subagents: a reply's final words. */
function answerIn(message: AssistantMessage | undefined): string {
  return (message?.parts ?? [])
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim()
}

/** subagents: a promise's value, or "timeout" once `ms` has passed. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms)
  })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

/** subagents: the probe's shortened timings, as JSON in `MCODE_SUBAGENT_TIMERS`; anything unreadable is ignored. */
function timersFromEnvironment(): Partial<SubagentTimers> {
  const raw = process.env.MCODE_SUBAGENT_TIMERS
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return {}
    const out: Partial<SubagentTimers> = {}
    for (const key of Object.keys(SUBAGENT_TIMERS) as (keyof SubagentTimers)[]) {
      const value = (parsed as Record<string, unknown>)[key]
      if (typeof value === "number" && value > 0) out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

/** What a running turn has been handed since it started. */
interface Steering {
  /**
   * Ids of messages taken into this turn that the model has not been given yet.
   *
   * Ids rather than the messages themselves, because the turn does not carry
   * them anywhere - it re-reads the transcript at every step, and this is only
   * the note of which of those messages it is still waiting to see.
   */
  waiting: string[]
  /** Settles once every message taken on so far is in the transcript. */
  written: Promise<unknown>
}

/** One turn's account of what it is doing to the filesystem. */
interface Turn {
  /** What the edit and write tools reported, keyed the way paths are compared. */
  told: Map<string, SnapshotFile>
  /** The project scan, when one could be started for this turn. */
  watching?: Recording
  /** The project the turn ran in, for the ledger of which conversation wrote what. */
  directory?: string
  /** True once a tool ran whose file changes cannot be seen from here. */
  opaque: boolean
  /** The message this turn answers told the model not to test or verify. */
  noTesting?: boolean
  /**
   * The user messages this turn is answering, in the order they were sent.
   *
   * More than one when several were steered in at once, or when news of
   * subagents reached the turn. Recorded so that rolling the conversation back
   * to a message can find the turn that message belongs to, and know how much
   * of the transcript that turn's recording accounts for.
   */
  messages: string[]
}

/**
 * How two spellings of one path are told apart.
 *
 * The scan reports paths as git resolved them on disk; the tools report them as
 * the model asked for them. On Windows those can differ in case alone, and
 * counting one file twice would restore it twice and inflate the number the
 * user is shown.
 */
function pathKey(target: string): string {
  return process.platform === "win32" ? target.toLowerCase() : target
}

/** An overflow compaction leaves attached files out of what it replays, naming each where it was. */
function withoutAttachments(history: Message[]): Message[] {
  return history.map((message) => {
    if (message.role !== "user" || !message.attachments.length) return message
    const names = message.attachments.map((file) => file.path.split(/[\\/]/).pop() ?? file.path)
    return { ...message, attachments: [], text: `${message.text}\n\n[Attached files left out to make the conversation fit: ${names.join(", ")}]` }
  })
}

/** What a model reads besides text, from its catalog entry; the image switch counts where no image input is stated. */
function modelInputs(entry: ModelEntry | undefined): ModelModalities {
  return {
    text: true,
    image: entry?.inputs?.image ?? entry?.attachment ?? false,
    audio: entry?.inputs?.audio ?? false,
    video: entry?.inputs?.video ?? false,
    pdf: entry?.inputs?.pdf ?? false,
  }
}

/** Wraps a failure that has already been written onto the assistant message. */
class Shown extends Error {
  constructor(readonly reason: unknown) {
    super("already reported")
    this.name = "Shown"
  }
}

function describe(err: unknown): string {
  const api = describeAnthropicError(err)
  if (api) return api
  if (err instanceof Error) return err.message
  return String(err)
}

export { emptyUsage }
