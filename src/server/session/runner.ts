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
  TextPart,
  ToolPart,
  UserMessage,
} from "@shared/protocol"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { Identifier } from "@shared/id"
import { readTask, smartRoute, type TaskReading } from "@shared/smart"
import type { Bus } from "../bus"
import type { Config } from "../config"
import type { Permissions } from "../permission"
import type { CommandRisk } from "../command-risk"
import { PermissionDenied, REVIEW_TIMEOUT_MS } from "../permission"
import type { Storage } from "../storage"
import { globalAgentsPath } from "../global-agents"
import { findTool, reachOf, toolsFor } from "../tool/registry"
import { Questions } from "../tool/question"
import type { SubagentControl, SubagentSpec, ToolDefinition, ToolResult } from "../tool/types"
import { ToolError } from "../tool/types"
import { argumentProblems, refusedArgumentsNote } from "../tool/validate"
import { retryDecision, waitFor } from "./retry"
import { AnthropicAdapter, describeAnthropicError } from "../provider/anthropic"
import { OpenAICompatible } from "../provider/openai"
import { ChatGPTSubscription } from "../provider/chatgpt"
import type { AuthManager } from "../auth/manager"
import type { ProviderAdapter, TurnEvent, TurnOutcome } from "../provider/types"
import { failureCode, failureDetail } from "./error-map"
import type { SessionStore, Snapshot, SnapshotFile } from "./store"
import { emptyUsage } from "./store"
import type { Recording } from "./snapshot"
import { Snapshots, decode, readSnapshotFile } from "./snapshot"
import { isContextOverflow, isOverflowByCount, maxOutputTokens } from "./overflow"
import { SUMMARY_INSTRUCTION, compactedText, continueNote, extractSummary, isSummary, touchedFiles, type CompactionTrigger } from "./summary"
import { repositoryState, systemPrompt } from "./prompt"
import { TITLE_SYSTEM, UNTITLED, cleanTitle, fallbackTitle, titlePrompt } from "./title"
import { interfaceLocale } from "./locale"
import { providerExtras, samplingFor } from "../provider/sampling"
import { attachmentNote, runtimeContext, sessionNote } from "./context"
import { settleAttachments, withAttachmentData, type AttachmentCache } from "./attachments"
import type { ModelEntry } from "../provider/catalog"
import { forWire } from "../provider/wire-ids"
import { hasLinkedWorktrees, worktreeNotice, worktreeTop } from "./worktree"
import path from "node:path"
import type { ModelModalities } from "@shared/protocol"
import { costOf } from "./usage"
import { ABORTED_TOOL } from "../provider/history"
import { LOOP_ANSWERS, continuationFor, frameSteered, repeatsCall, withNotes, withSameStepsNote } from "./reminders"
import { interruptedTurn } from "@shared/resume"
// session chat
import { SessionChat, withChatHeaders } from "./chat"
import { SUBAGENT_TIMERS, firstLine, isStalled, noticeText, subagentOutput, type SubagentTimers } from "@shared/subagent"

/*
 * What a resumed turn is told at its first step, in MCode's own words. Sent in
 * the request only, never written to the transcript: 继续 adds no message.
 */
const RESUME_PROMPT =
  "The previous turn stopped before it was finished. Carry on with the task from where it stopped: do not redo work that is already done, and do not start over."

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
  "You check one shell command before a coding assistant runs it.",
  "The user has chosen to let this check settle risky commands instead of being asked about each one.",
  "Approve only when the command is plainly a needed step of what the user asked for, and its effects go no further than that request needs.",
  "Reject when it reaches beyond the request, affects the machine or other programs broadly, publishes or sends work somewhere, or when you are not sure.",
  "Reply with a single word: APPROVE or REJECT.",
].join("\n")

/** Room for a one-word verdict, and for a model that reasons before giving it. */
const REVIEW_OUTPUT_TOKENS = 2048

/** The latest request is quoted from its end, where the instruction usually is. */
const REVIEW_REQUEST_CHARS = 4000

/** How long a title may take before the fallback is kept. */
const TITLE_TIMEOUT_MS = 60_000

/** The first message is quoted up to this many characters for its title. */
const TITLE_SOURCE_CHARS = 4000

/**
 * What the model is told on the step that has to be the last one.
 *
 * The reference's `MAX_STEPS_PROMPT`, kept as it stands. It goes in as an
 * assistant message beside a request carrying no tools at all, so the only
 * thing left to do is write.
 */
const MAX_STEPS_PROMPT = [
  "CRITICAL - MAXIMUM STEPS REACHED",
  "",
  "The maximum number of steps allowed for this task has been reached. Tools are disabled until next user input. Respond with text only.",
  "",
  "STRICT REQUIREMENTS:",
  "1. Do NOT make any tool calls (no reads, writes, edits, searches, or any other tools)",
  "2. MUST provide a text response summarizing work done so far",
  "3. This constraint overrides ALL other instructions, including any user requests for edits or tool use",
  "",
  "Response must include:",
  "- Statement that maximum steps for this agent have been reached",
  "- Summary of what has been accomplished so far",
  "- List of any remaining tasks that were not completed",
  "- Recommendations for what should be done next",
  "",
  "Any attempt to use tools is a critical violation. Respond with text ONLY.",
].join("\n")

/**
 * Drives one session's conversation.
 *
 * The loop is written by hand rather than using the SDK tool runner because
 * every step has to be observable: each text delta, each tool transition, and
 * each permission prompt is published as it happens so the UI can render a
 * turn while it is still running, and so an abort can land mid-tool.
 */
/** Tools a subagent never gets: starting subagents, and talking to other conversations. */
const SUBAGENT_WITHHELD = new Set(["task", "contacts", "talk_to_session", "create_session", "update_session"])

export class SessionRunner {
  private readonly running = new Map<string, AbortController>()
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
   * file changes are recorded into that turn, and a refusal stops that turn.
   */
  private readonly owners = new Map<string, string>()
  /** subagents: the highest number handed out per parent and kind, so parallel calls never share a name. */
  private readonly numbering = new Map<string, number>()
  /*
   * Set after construction rather than injected: the MCP layer reads config,
   * which the runner also holds, and threading it through the constructor
   * would make the two impossible to build in either order.
   */
  private mcp?: { tools: () => ToolDefinition[] }
  /*
   * MiMo's MCP page says a saved change applies from the next conversation.
   * Each conversation keeps the servers that were configured and on at its
   * first turn in this run; one added or switched on later is offered to new
   * conversations only. A server removed or switched off is gone at once, since
   * there is nothing left to call.
   */
  private readonly mcpServersAt = new Map<string, ReadonlySet<string>>()

  /** Where the per-project shadow repositories that back undo are kept. */
  private readonly snapshots: Snapshots
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

  constructor(
    private readonly store: SessionStore,
    private readonly bus: Bus,
    private readonly config: Config,
    private readonly permissions: Permissions,
    private readonly auth: AuthManager,
    storage: Storage,
  ) {
    this.snapshots = new Snapshots(storage.folder("snapshot"))
    this.globalAgents = globalAgentsPath(storage.directory)
    this.questions = new Questions(bus)
    // session chat: messages between conversations run through this runner's own prompt.
    this.chat = new SessionChat(store, bus, {
      isRunning: (sessionID) => this.running.has(sessionID),
      prompt: (input) => this.prompt(input),
      create: async ({ directory, title }) => {
        const settings = config.get()
        await config.adoptProjects([directory])
        return store.create({ directory, title, model: settings.model, agent: settings.agent, staged: settings.staged, ...(settings.smart ? { smart: true } : {}) })
      },
    })
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
  private async reviewCommand(input: { sessionID: string; command: string; risk: CommandRisk }): Promise<boolean> {
    const session = await this.store.get(input.sessionID)
    if (!session) return false
    const definition = this.config.definition(session.model.provider)
    if (!definition) return false
    const adapter: ProviderAdapter =
      definition.kind === "anthropic"
        ? AnthropicAdapter
        : definition.kind === "chatgpt"
          ? ChatGPTSubscription
          : OpenAICompatible
    const apiKey = this.config.apiKey(definition.id) ?? ""
    const tokens = definition.kind === "chatgpt" ? await this.auth.accessToken(definition.id) : undefined
    const stored = await this.store.messages(session.id)
    const request = [...stored].reverse().find((message) => message.role === "user")?.text ?? ""
    const text = [
      "The user's latest request:",
      request.slice(-REVIEW_REQUEST_CHARS) || "(none)",
      "",
      `Working directory: ${session.directory}`,
      `Flagged as: ${input.risk}`,
      "",
      "Command:",
      input.command,
    ].join("\n")

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REVIEW_TIMEOUT_MS)
    let answer = ""
    try {
      await adapter.stream(
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
          tools: [],
          effort: "low",
          showReasoning: false,
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
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
    return /^[^a-z]*approve/i.test(answer.trim())
  }

  useMcp(mcp: { tools: () => ToolDefinition[] }): void {
    this.mcp = mcp
  }

  /**
   * The tools for a turn: this app's own, plus whatever the connected MCP
   * servers offer.
   *
   * Plan gets none of the MCP ones. What an outside server does with a call is
   * not knowable from here, so a mode that promises to change nothing cannot
   * pass one along.
   *
   * The model id is passed on because the surface depends on it: the reference
   * gives a GPT-5 model `apply_patch` and withholds `edit` and `write`, and
   * every other model the reverse. See `usesPatch` in the registry.
   */
  private tools(agent: string, modelID: string, conversation: string): ToolDefinition[] {
    const own = toolsFor(agent, modelID)
    if (agent === "plan") return own
    let servers = this.mcpServersAt.get(conversation)
    if (!servers) {
      const configured = Object.entries(this.config.get().mcpServers ?? {})
      servers = new Set(configured.filter(([, entry]) => entry.enabled !== false).map(([name]) => name))
      this.mcpServersAt.set(conversation, servers)
    }
    const kept = servers
    return [...own, ...(this.mcp?.tools() ?? []).filter((tool) => !tool.server || kept.has(tool.server))]
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

  busySessions(): string[] {
    return [...this.running.keys()]
  }

  abort(sessionID: string): void {
    // subagents: Stop on a conversation stops the subagents working for it first.
    for (const child of [...(this.children.get(sessionID) ?? [])]) this.abort(child)
    this.running.get(sessionID)?.abort()
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
  private liveMessages(session: SessionInfo, messages: Message[]): Message[] {
    if (!session.revert) return messages
    const boundary = messages.findIndex((message) => message.id === session.revert?.messageID)
    return boundary < 0 ? messages : messages.slice(0, boundary)
  }

  private contextFor(session: SessionInfo, messages: Message[]): Message[] {
    messages = this.liveMessages(session, messages)

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
    // A path recorded twice keeps its first reading, because the state to
    // return to is the one the turn began from, not the one the last edit did.
    if (turn.told.has(key)) return
    turn.told.set(key, await readSnapshotFile(target))
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

    // A turn that changed nothing does not take up a place in the history.
    if (!blocked && files.size === 0) return
    await this.store.pushSnapshot(sessionID, {
      at: Date.now(),
      files: blocked ? [] : [...files.values()],
      blocked,
      messages: turn.messages,
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
   * Since a turn can now be steered, "the last turn" may answer more than one
   * message: everything from the prompt that set the model working until it
   * stopped is one turn and one entry here. That keeps the promise the interface
   * makes - the files go back to how the turn found them - because the recording
   * still opens at the moment the model started and closes when it stopped. It
   * does mean an undo after steering takes back work the model did in answer to
   * several things the user said, which is the only coherent reading: the later
   * messages were answered on top of the earlier ones, so there is no state in
   * between to return to.
   */
  async undo(sessionID: string): Promise<number> {
    /*
     * A turn in flight is still writing messages and files. Summarising over it
     * would mark a boundary against a message that is not finished, and undoing
     * it would fight the tool that is mid-write.
     */
    if (this.running.has(sessionID)) throw new Error("Wait for the current turn to finish")
    const snapshot = await this.store.peekSnapshot(sessionID, "undo")
    if (!snapshot) throw new Error("Nothing to undo")
    /*
     * Left where it is rather than dropped. Undoing the turn before this one
     * would put files back to a state that never existed, since whatever this
     * turn did is still on top of them, and would report a file count for it.
     */
    if (snapshot.blocked) throw new Error(snapshot.blocked)
    // Restore first: if this throws, both stacks are still as they were and the
    // same undo can be tried again.
    const swapped = await this.restore(snapshot)
    await this.store.moveSnapshot(sessionID, "undo", "redo", { at: snapshot.at, files: swapped })
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
    if (this.running.has(sessionID)) throw new Error("Wait for the current turn to finish")
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
      await this.write(step.swapped)
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
      const swapped = await this.restore(snapshot)
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
      for (const message of stored.slice(at)) await this.store.deleteMessage(session.id, message.id)
    }
    await this.store.dropReverted(session.id)
    const updated = await this.store.update(session.id, { revert: undefined })
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
    if (this.running.has(sessionID)) throw new Error("Wait for the current turn to finish")
    let session = await this.store.require(sessionID)
    if (session.revert) session = await this.commitRevert(session)
    const stored = await this.store.messages(sessionID)
    const at = stored.findIndex((message) => message.id === messageID)
    if (at < 0) throw new Error("That message is no longer in this conversation")
    const kept = new Set(stored.slice(0, at).map((message) => message.id))
    for (const message of stored.slice(at)) await this.store.deleteMessage(sessionID, message.id)
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
    return session
  }

  /** Puts back what undo took away. */
  async redo(sessionID: string): Promise<number> {
    /*
     * A turn in flight is still writing messages and files. Summarising over it
     * would mark a boundary against a message that is not finished, and undoing
     * it would fight the tool that is mid-write.
     */
    if (this.running.has(sessionID)) throw new Error("Wait for the current turn to finish")
    const snapshot = await this.store.peekSnapshot(sessionID, "redo")
    if (!snapshot) throw new Error("Nothing to redo")
    const swapped = await this.restore(snapshot)
    await this.store.moveSnapshot(sessionID, "redo", "undo", { at: snapshot.at, files: swapped })
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
    return this.write(snapshot.files)
  }

  /** Writes recorded contents back over what is there, handing back what was. */
  private async write(files: SnapshotFile[]): Promise<SnapshotFile[]> {
    const swapped: SnapshotFile[] = []
    for (const file of files) {
      swapped.push(await readSnapshotFile(file.path))
      if (file.content === null) {
        await rm(file.path, { force: true })
        continue
      }
      await mkdir(dirname(file.path), { recursive: true })
      // Written as bytes rather than as a string: a snapshot may hold a file
      // that is not text at all, and encoding it on the way out would change it.
      await writeFile(file.path, decode(file))
    }
    return swapped
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
    if (this.running.has(sessionID)) throw new Error("Wait for the current turn to finish")
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
   * the agent, the mode, the instructions, the model, or the tools. A compaction
   * sends the same one, so its request reads from that cache too.
   */
  private async systemFor(session: SessionInfo): Promise<string> {
    const config = this.config.get()
    const key = JSON.stringify([
      session.agent,
      session.staged === true,
      config.instructions ?? "",
      config.instructionFiles ?? [],
      session.model.provider,
      session.model.model,
      this.tools(session.agent, session.model.model, session.parentID ?? session.id).map((tool) => tool.name),
    ])
    const frozen = this.prefixes.get(session.id)
    const base =
      frozen?.key === key
        ? frozen.system
        : await systemPrompt({
            directory: session.directory,
            agent: session.agent,
            staged: session.staged,
            instructions: config.instructions,
            globalAgentsFile: this.globalAgents,
            instructionFiles: config.instructionFiles,
          })
    this.prefixes.set(session.id, { key, system: base })
    // subagents: a subagent is told what it is, after what its agent would be told anyway.
    return session.parentID ? `${base}\n\n${SUBAGENT_NOTE}` : base
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
   */
  private async compactNow(session: SessionInfo, signal: AbortSignal, trigger: CompactionTrigger): Promise<SessionInfo> {
    const stored = await this.store.messages(session.id)
    const live = this.liveMessages(session, stored)
    const last = live.at(-1)
    const context = withChatHeaders(this.contextFor(session, stored))
    if (!last || !context.some((message) => message.role === "user")) throw new Error("Nothing to compact yet")

    const definition = this.config.definition(session.model.provider)
    if (!definition) throw new Error(`Unknown provider: ${session.model.provider}`)
    const adapter: ProviderAdapter =
      definition.kind === "anthropic"
        ? AnthropicAdapter
        : definition.kind === "chatgpt"
          ? ChatGPTSubscription
          : OpenAICompatible
    const apiKey = this.config.apiKey(definition.id) ?? ""
    const tokens = definition.kind === "chatgpt" ? await this.auth.accessToken(definition.id) : undefined
    const entry = this.config.modelEntry(session.model)
    const replay =
      trigger === "provider-overflow" ? withoutAttachments(context) : await withAttachmentData(context, session.directory, new Map())
    const instruction: UserMessage = {
      id: `${session.id}:compaction`,
      sessionID: session.id,
      role: "user",
      text: SUMMARY_INSTRUCTION,
      attachments: [],
      time: { created: Date.now() },
    }

    let summary = ""
    let called = false
    this.summarising.add(session.id)
    this.bus.publish({ type: "session.compacting", sessionID: session.id, active: true })
    try {
      const outcome = await adapter.stream(
        {
          apiKey: tokens?.access ?? apiKey,
          model: session.model,
          system: await this.systemFor(session),
          history: [...replay, instruction],
          tools: this.tools(session.agent, session.model.model, session.parentID ?? session.id).filter((tool) => !session.parentID || !SUBAGENT_WITHHELD.has(tool.name)),
          effort: session.effort ?? this.config.get().effort,
          variants: this.config.variants(session.model),
          showReasoning: false,
          signal,
          baseURL: definition.baseURL,
          headers: definition.headers,
          accountId: tokens?.accountId,
          maxOutput: maxOutputTokens(session.model, entry),
          outputLimit: entry?.maxOutput,
          sessionID: session.id,
          cacheTTL: entry?.cacheTTL,
          inputs: modelInputs(entry),
          sampling: samplingFor(session.model.model, entry?.temperature === true),
          extra: providerExtras(session.model.provider, entry?.reasoning === true),
        },
        (event) => {
          if (event.type === "text.delta") summary += event.text
          if (event.type === "tool") called = true
        },
      )
      if (outcome.toolCalls.length) called = true
    } catch (failure) {
      if (isContextOverflow(describe(failure))) throw new Error("This conversation is too large to compact")
      throw failure
    } finally {
      this.summarising.delete(session.id)
      this.bus.publish({ type: "session.compacting", sessionID: session.id, active: false })
    }
    if (called) throw new Error("The model called a tool instead of writing a summary")
    summary = extractSummary(summary)
    if (!summary) throw new Error("The model returned an empty summary")
    if (!isSummary(summary)) throw new Error("The model did not return a summary")
    const files = touchedFiles(context, session.directory)
    return this.store.update(session.id, {
      // The last message the summary covers: the whole conversation as it stood.
      compacted: { messageID: last.id, summary, at: Date.now(), trigger, ...(files.length ? { files } : {}) },
    })
  }

  /**
   * MiMo's compaction at the start of a turn: when the last finished reply
   * since the last compaction crossed the line, the conversation is compacted
   * before the model is asked again. A failure leaves the turn to go on; if
   * its request is then refused for length, the rescue in `run` takes over.
   */
  private async compactIfCrossed(session: SessionInfo, signal: AbortSignal): Promise<SessionInfo> {
    const live = this.liveMessages(session, await this.store.messages(session.id))
    const from = session.compacted ? live.findIndex((message) => message.id === session.compacted?.messageID) + 1 : 0
    const reply = live
      .slice(from)
      .reverse()
      .find((message): message is AssistantMessage => message.role === "assistant" && message.finish !== undefined && message.usage !== undefined)
    if (!reply?.usage || !isOverflowByCount(reply.usage, this.config.modelEntry(session.model))) return session
    try {
      return await this.compactNow(session, signal, "automatic")
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
  private async compactForOverflow(session: SessionInfo, signal: AbortSignal): Promise<SessionInfo | undefined> {
    let compacted: SessionInfo
    try {
      compacted = await this.compactNow(session, signal, "provider-overflow")
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
      ...(left.length || asked.reminders?.length
        ? { reminders: [...(asked.reminders ?? []), ...(left.length ? [`Attached files were left out to make the conversation fit: ${left.join(", ")}.`] : [])] }
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
    if (open) return this.join(open, input)

    if (this.running.has(input.sessionID)) throw new Error("This session is already working on something")

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
    if (this.running.has(input.sessionID)) throw new Error("This session is already working on something")
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
    const reminders = typed ? [runtimeContext({ language: this.config.get().language })] : []
    const user: UserMessage = {
      id: Identifier.message(),
      sessionID: input.sessionID,
      role: "user",
      text: input.text,
      attachments: input.attachments ?? [],
      ...(input.annotations?.length ? { annotations: input.annotations } : {}),
      ...(input.fileNotices?.length ? { fileNotices: input.fileNotices } : {}),
      ...extra,
      ...(reminders.length ? { reminders } : {}),
      time: { created: Date.now() },
      // Marked, so the transcript can show it inside the turn it joined.
      steered: true,
    }
    steering.waiting.push(user.id)
    /*
     * Counted as part of the turn that is running, because that is the turn
     * whose recording will cover whatever it causes. A rollback aimed at this
     * message therefore takes the whole turn back, which is the only state on
     * disk that ever existed either side of it.
     */
    this.turn(input.sessionID).messages.push(user.id)

    const written = steering.written.then(async () => {
      // Settled in the same chain, so messages still reach the transcript in the order they were typed.
      if (user.attachments.some((file) => file.byPath)) {
        const session = await this.store.get(input.sessionID)
        if (session) user.attachments = await settleAttachments(user.attachments, session.directory)
      }
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
  private markDelivered(sessionID: string, history: Message[]): void {
    const steering = this.steering.get(sessionID)
    if (!steering || steering.waiting.length === 0) return
    const carried = new Set(history.map((message) => message.id))
    steering.waiting = steering.waiting.filter((id) => !carried.has(id))
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
      const adapter: ProviderAdapter =
        definition.kind === "anthropic"
          ? AnthropicAdapter
          : definition.kind === "chatgpt"
            ? ChatGPTSubscription
            : OpenAICompatible
      const apiKey = this.config.apiKey(definition.id) ?? ""
      const tokens = definition.kind === "chatgpt" ? await this.auth.accessToken(definition.id) : undefined
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), SMART_TIMEOUT_MS)
      let answer = ""
      try {
        await adapter.stream(
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
            effort: "low",
            showReasoning: false,
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
        reading = readTask(answer)
      } catch {
        reading = undefined
      } finally {
        clearTimeout(timer)
      }
    }
    const route = smartRoute(reading)
    return this.store.update(session.id, { model: route === "fast" ? fast : main, smartRoute: route })
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

    /*
     * The project is photographed from here rather than from the first tool
     * call, so that on a large project the scan runs while the model is still
     * composing its reply instead of being waited for. Plan is left out: it is
     * handed no tool that can write, so there is nothing to photograph.
     */
    this.pending.delete(session.id)
    if (session.agent !== "plan") {
      this.turn(session.id).watching = this.snapshots.begin(session.directory)
    }

    // A subscription is authorised by stored tokens, so it has no API key to
    // check here - the bearer is resolved (and refreshed) at turn time.
    const apiKey = this.config.apiKey(session.model.provider) ?? ""
    /*
     * `usable` rather than a key check, so a custom provider that carries its
     * credential in a header - which its own form invites - is not refused
     * here. Without this the picker offers the model and every prompt against
     * it comes back "No API key configured".
     */
    if (!this.config.usable(session.model.provider)) {
      throw new Error(`No API key configured for ${session.model.provider}. Add one in Settings.`)
    }

    // MiMo's runtime context rides on what the user sends; a first message also gets the app note and the directory.
    const first = (await this.store.messages(session.id)).length === 0
    // MiMo attaches by path: what each such file is gets settled now, its contents are read per request.
    const attachments = await settleAttachments(input.attachments, session.directory)
    const reminders = input.inbox ? [] : await this.remindersFor(session, first)
    const attached = input.inbox ? undefined : attachmentNote(attachments.filter((file) => file.byPath), session.directory)
    if (attached) reminders.push(attached)
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
      ...(reminders.length ? { reminders } : {}),
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
      const fallback = fallbackTitle(input.text, input.attachments ?? [])
      session = await this.store.update(session.id, { title: fallback, titleSource: "fallback" })
      if (/\p{L}/u.test(input.text)) void this.generateTitle(session.id, input.text).catch(() => undefined)
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
  private async remindersFor(session: SessionInfo, first: boolean): Promise<string[]> {
    if (session.parentID) return []
    const config = this.config.get()
    // The date and the repository's state change per turn, so they ride here rather than in the cached system prompt.
    const repository = await repositoryState(session.directory).catch(() => undefined)
    const runtime = runtimeContext({
      language: config.language,
      today: new Date().toISOString().slice(0, 10),
      ...(repository ? { repository } : {}),
      ...(first ? { directory: session.directory } : {}),
    })
    if (!first) return [runtime]
    // The conversation's MCP servers are fixed when it first asks for its tools (plan takes none).
    if (session.agent !== "plan") this.tools(session.agent, session.model.model, session.id)
    const names = [...(this.mcpServersAt.get(session.id) ?? [])]
    return [sessionNote({ mcpServers: names, globalAgentsFile: this.globalAgents }), runtime]
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
    const definition = this.config.definition(session.model.provider)
    if (!definition || !this.config.usable(session.model.provider)) return
    const adapter: ProviderAdapter =
      definition.kind === "anthropic" ? AnthropicAdapter : definition.kind === "chatgpt" ? ChatGPTSubscription : OpenAICompatible
    const tokens = definition.kind === "chatgpt" ? await this.auth.accessToken(definition.id) : undefined
    const entry = this.config.modelEntry(session.model)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS)
    let answer = ""
    try {
      await adapter.stream(
        {
          apiKey: tokens?.access ?? this.config.apiKey(definition.id) ?? "",
          model: session.model,
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
          effort: "low",
          variants: this.config.variants(session.model),
          showReasoning: false,
          signal: controller.signal,
          baseURL: definition.baseURL,
          headers: definition.headers,
          accountId: tokens?.accountId,
          maxOutput: maxOutputTokens(session.model, entry),
          outputLimit: entry?.maxOutput,
          // MiMo's title agent runs at 0.5, where the model takes a temperature.
          sampling: { ...samplingFor(session.model.model, false), ...(entry?.temperature ? { temperature: 0.5 } : {}) },
        },
        (event) => {
          if (event.type === "text.delta") answer += event.text
        },
      )
    } catch {
      return
    } finally {
      clearTimeout(timer)
    }
    const title = cleanTitle(answer)
    if (!title) return
    const current = await this.store.get(sessionID)
    if (current?.titleSource !== "fallback") return
    await this.store.update(sessionID, { title, titleSource: "generated" })
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
      if (session.agent !== "plan") {
        this.turn(sessionID).watching = this.snapshots.begin(session.directory)
      }
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
  async resumeTurn(sessionID: string): Promise<string> {
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
      if (session.agent !== "plan") this.turn(sessionID).watching = this.snapshots.begin(session.directory)
      this.launch(sessionID, this.config.apiKey(session.model.provider) ?? "", controller, true)
      return messageID
    } catch (failure) {
      this.running.delete(sessionID)
      throw failure
    }
  }

  /** Runs a claimed session's turn and releases it afterwards. */
  private launch(sessionID: string, apiKey: string, controller: AbortController, resumed = false, lead?: Lead): void {
    this.steering.set(sessionID, { waiting: [], written: Promise.resolve() })

    // Deliberately not awaited: the caller gets the message id immediately and
    // follows the turn through events.
    void this.run(sessionID, apiKey, controller, resumed, lead)
      .catch((err) => {
        // A failure recorded on the message is already in front of the user.
        if (err instanceof Shown) return
        this.bus.publish({ type: "session.error", sessionID, error: describe(err) })
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
        this.running.delete(sessionID)

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
      })
  }

  private async run(sessionID: string, apiKey: string, controller: AbortController, resumed = false, lead?: Lead): Promise<void> {
    let session = await this.store.require(sessionID)
    const definition = this.config.definition(session.model.provider)
    if (!definition) throw new Error(`Unknown provider: ${session.model.provider}`)
    const adapter: ProviderAdapter =
      definition.kind === "anthropic"
        ? AnthropicAdapter
        : definition.kind === "chatgpt"
          ? ChatGPTSubscription
          : OpenAICompatible
    // A subscription carries no API key; the bearer is a refreshed access token.
    const tokens = definition.kind === "chatgpt" ? await this.auth.accessToken(definition.id) : undefined
    const config = this.config.get()
    // MiMo's prefix snapshot (see systemFor).
    const system = await this.systemFor(session)

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
        name: "task",
        status: "pending",
        input: { description: lead.description, prompt: lead.prompt, subagent_type: lead.type },
        time: { created: Date.now() },
      }
      assistant.parts.push(part)
      await this.store.saveMessage(assistant)
      await this.runTool({ part, assistant, session: { id: sessionID, directory: session.directory }, signal: controller.signal })
      assistant.time.completed = Date.now()
      if (controller.signal.aborted) assistant.finish = "aborted"
      await this.store.saveMessage(assistant)
      if (controller.signal.aborted) return
    }

    // MiMo compacts at the start of a turn when the last finished reply crossed the line.
    if (!lead) session = await this.compactIfCrossed(session, controller.signal)

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
    const limit = config.maxSteps && config.maxSteps > 0 ? config.maxSteps : undefined
    /* MiMo's continuations this turn: notes kept in the request after the reply they answer, and how many of each were used. */
    const notes = new Map<string, string[]>()
    const continued = { length: 0, textTool: 0, empty: 0 }
    /* Files attached by path, read once for this turn. */
    const attachmentData: AttachmentCache = new Map()
    for (let step = 0; ; step++) {
      if (controller.signal.aborted) return
      // The reference's `isLastStep`: no tools, and an instruction to write.
      const lastStep = limit !== undefined && step >= limit

      /*
       * Anything typed while the last step ran has to be on disk before the
       * transcript is read, or the model answers without it and the message
       * looks ignored. This is also the only point at which a steered message
       * can be taken on board: the request for this step has not been built
       * yet, whereas one already in flight cannot be added to.
       */
      await this.steering.get(sessionID)?.written
      await this.deliverWorktreeNotice(sessionID)
      const stored = await this.store.messages(sessionID)
      this.markDelivered(sessionID, stored)
      // session chat: a message from another conversation says so, in the request only.
      const chatted = withChatHeaders(this.contextFor(session, stored))
      // MiMo: from a turn's second step on, what the user sent meanwhile is framed as sent mid-task;
      // this turn's continuation notes follow the replies they answer; and three identical steps
      // in a row bring a note to change approach.
      const history = forWire(
        await withAttachmentData(withSameStepsNote(withNotes(step > 0 ? frameSteered(chatted) : chatted, notes)), session.directory, attachmentData),
        session.model,
      )

      const effort = session.effort ?? config.effort

      const assistant: AssistantMessage = {
        id: Identifier.message(),
        sessionID,
        role: "assistant",
        model: session.model,
        agent: session.agent,
        effort,
        parts: [],
        time: { created: Date.now() },
      }
      await this.store.saveMessage(assistant)

      let outcome: Awaited<ReturnType<SessionRunner["stream"]>>
      try {
        outcome = await this.stream(adapter, assistant, {
        apiKey: tokens?.access ?? apiKey,
        model: session.model,
        system,
        history: lastStep
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
                text: MAX_STEPS_PROMPT,
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
                  text: RESUME_PROMPT,
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
              : history,
        // subagents: a subagent is never handed the task tool, so it cannot start subagents of its own,
        // nor the session chat tools, which refuse a subagent anyway and only cost it a wasted call.
        tools: lastStep ? [] : this.tools(session.agent, session.model.model, session.parentID ?? session.id).filter((tool) => !session.parentID || !SUBAGENT_WITHHELD.has(tool.name)),
        effort,
        // MiMo draws no reasoning, so none is asked for.
        showReasoning: false,
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
         * carry one the provider rejects.
         */
        variants: this.config.variants(session.model),
        accountId: tokens?.accountId,
        maxOutput: maxOutputTokens(session.model, this.config.modelEntry(session.model)),
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
        extra: providerExtras(session.model.provider, this.config.modelEntry(session.model)?.reasoning === true),
      })
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
        if (rescued !== step && !controller.signal.aborted && isContextOverflow(describe(reason))) {
          rescued = step
          const compacted = await this.compactForOverflow(session, controller.signal)
          if (!compacted) throw failure
          session = compacted
          step -= 1
          continue
        }
        throw failure
      }
      if (outcome === undefined) {
        // Aborted mid-stream. Persist whatever arrived so the transcript is honest.
        assistant.finish = "aborted"
        assistant.time.completed = Date.now()
        await this.store.saveMessage(assistant)
        return
      }

      // MiMo's cost: cache reads and writes at their own prices, reasoning at the output price.
      const usage = { ...outcome.usage, cost: costOf(outcome.usage, this.config.modelEntry(session.model)) }
      assistant.usage = usage
      await this.store.addUsage(sessionID, usage)
      /*
       * MiMo's count trigger: once the tokens the provider reports reach 90%
       * of the window, a turn that goes on is compacted as an overflow before
       * the model is asked again, and one that ends is compacted when the next
       * turn starts. Nothing for a model whose window is not known - a
       * discovered model reports 0 - which has only the refusal to fall back on.
       */
      const overflowing = isOverflowByCount(usage, this.config.modelEntry(session.model))

      if (outcome.stop === "refusal") {
        assistant.finish = "refusal"
        assistant.error =
          outcome.finishReason === "content_filter"
            ? "The provider's content filter stopped this reply."
            : "The model declined to continue with this request."
        assistant.time.completed = Date.now()
        await this.store.saveMessage(assistant)
        return
      }

      const pending = assistant.parts.filter((part): part is ToolPart => part.type === "tool")
      if (outcome.stop !== "tool_use" || pending.length === 0) {
        const next = continuationFor(assistant, outcome.stop, outcome.finishReason, session.model.model, continued)
        if (next.note) notes.set(assistant.id, [...(notes.get(assistant.id) ?? []), next.note])
        if (next.error) {
          assistant.error = next.error.message
          if (next.error.code) assistant.errorCode = next.error.code
        }
        assistant.finish = outcome.stop === "max_tokens" ? "max_tokens" : next.error ? "error" : "end_turn"
        assistant.time.completed = Date.now()
        await this.store.saveMessage(assistant)
        if (next.note && !lastStep) {
          if (overflowing) session = (await this.compactForOverflow(session, controller.signal)) ?? session
          continue
        }
        /*
         * The model has stopped, but the user may have typed while it was
         * writing. Read with nothing awaited after the save above, so that a
         * message arriving from this instant onwards is the release's business
         * and cannot fall between the two. A turn that ends over the line is
         * compacted when the next one starts, as MiMo's is.
         */
        if (!this.steered(sessionID)) return
        continue
      }

      // Tools in one assistant turn are independent, so run them together and
      // let each report its own transitions.
      await Promise.all(
        pending.map((part) =>
          this.runTool({ part, assistant, session: { id: sessionID, directory: session.directory }, signal: controller.signal }),
        ),
      )

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
      if (overflowing) session = (await this.compactForOverflow(session, controller.signal)) ?? session
    }
  }

  /**
   * Streams one assistant turn, materializing parts as the adapter reports
   * them. Returns undefined if the turn was aborted.
   */
  private async stream(
    adapter: ProviderAdapter,
    assistant: AssistantMessage,
    request: Parameters<ProviderAdapter["stream"]>[0],
  ): Promise<TurnOutcome | undefined> {
    // Text and reasoning blocks are keyed by the index the adapter reports;
    // tools are keyed by call id, since only the provider knows how those
    // interleave with the rest of the turn.
    const blocks = new Map<number, TextPart | ReasoningPart>()
    let dirty = false
    const flush = setInterval(() => {
      if (!dirty) return
      dirty = false
      void this.store.saveMessage(assistant, true)
    }, 500)

    const announce = (part: AssistantPart) => {
      assistant.parts.push(part)
      this.bus.publish({ type: "message.updated", message: structuredClone(assistant) })
    }

    const append = (part: TextPart | ReasoningPart, text: string) => {
      part.text += text
      dirty = true
      this.bus.publish({
        type: "message.delta",
        sessionID: assistant.sessionID,
        messageID: assistant.id,
        partID: part.id,
        text,
      })
    }

    const emit = (event: TurnEvent) => {
      if (event.type === "text.start") {
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
        if (part) append(part, event.text)
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
        try {
          // The SDK's own quiet retries are off here: this loop retries in the open.
          outcome = await adapter.stream({ ...request, retries: 0 }, emit)
        } catch (err) {
          if (request.signal.aborted || (err instanceof Error && err.name === "AbortError")) throw err
          /*
           * MiMo retries a step only while replaying it is safe: once a tool
           * call has started to stream, the attempt is not repeated.
           */
          if (assistant.parts.some((part) => part.type === "tool")) throw err
          firstFailure ??= Date.now()
          const decision = retryDecision(err, attempt, Date.now() - firstFailure)
          if (!decision) throw err
          /*
           * Tried again from the start, as MiMo's engine does: what the failed
           * attempt managed to stream is dropped, because the next one streams
           * it again. The retry itself rides on the published copy only, so the
           * next update for the message clears the row without anything to undo.
           */
          assistant.parts = []
          blocks.clear()
          dirty = false
          this.bus.publish({
            type: "message.updated",
            message: {
              ...structuredClone(assistant),
              retry: { attempt, message: describe(err), next: Date.now() + decision.wait, kind: decision.kind, max: decision.max },
            },
          })
          if (!(await waitFor(decision.wait, request.signal))) throw new DOMException("Aborted", "AbortError")
        }
      }

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
    }
  }

  private async runTool(input: {
    part: ToolPart
    assistant: AssistantMessage
    session: { id: string; directory: string }
    signal: AbortSignal
  }): Promise<void> {
    const { part, assistant } = input
    const publish = () => this.bus.publish({ type: "message.updated", message: structuredClone(assistant) })

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
    const lookup = (name: string) => findTool(name) ?? this.mcp?.tools().find((entry) => entry.name === name)
    let tool = lookup(part.name)
    if (!tool) {
      const lowered = part.name.toLowerCase()
      const repaired = lowered === part.name ? undefined : lookup(lowered)
      if (repaired) {
        part.name = lowered
        tool = repaired
      } else {
        tool = findTool("invalid")
        part.input = {
          tool: part.name,
          error: `Model tried to call unavailable tool '${part.name}'.`,
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
    const problems = tool.name === "invalid" ? [] : unreadable ? [unreadable] : argumentProblems(tool.parameters, part.input)
    if (problems.length) {
      part.status = "error"
      part.error = refusedArgumentsNote(tool.name, problems)
      part.metadata = { recoverable: true }
      part.time.started = Date.now()
      part.time.completed = part.time.started
      publish()
      await this.store.saveMessage(assistant, true)
      return
    }

    part.status = "running"
    part.time.started = Date.now()
    publish()

    // subagents: a subagent's calls belong to the turn of the conversation it works for.
    const owner = this.owners.get(input.session.id) ?? input.session.id
    const reach = reachOf(part.name)
    if (reach !== "reads") {
      const turn = this.turn(owner)
      // A shell command and an MCP tool leave no account of themselves, so the
      // turn is only describable if the project can be compared afterwards.
      if (reach === "opaque") turn.opaque = true
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
    let refusedByUser = false

    try {
      /*
       * Several tools name a permission bucket and then never mention it again -
       * reading, listing, globbing, searching, the todo list all just run. Their
       * buckets were therefore settings with nothing behind them: a person could
       * switch reading off and watch files carry on being read. This is the only
       * point that every call passes through, so it is where those buckets are
       * consulted. Inside the try, so a refusal is caught below and written onto
       * the part as an error; one a person gave then ends the turn once saved.
       */
      await this.checkRepeated(part, assistant, input.session.id, input.signal)
      await this.permissions.check({
        sessionID: input.session.id,
        messageID: assistant.id,
        callID: part.callID,
        tool: tool.name,
        kind: tool.permission ?? "",
        arguments: part.input,
      })
      const result = await tool.execute(part.input, {
        sessionID: input.session.id,
        messageID: assistant.id,
        callID: part.callID,
        directory: input.session.directory,
        permissions: this.permissions,
        questions: this.questions,
        signal: input.signal,
        snapshot: (target) => this.record(owner, target),
        shell: this.config.get().shell,
        // session chat: a conversation's own calls only; a subagent has no contacts.
        chat: this.workers.has(input.session.id) ? undefined : this.chat,
        // subagents: offered to a conversation's own calls; a subagent's calls get none, so there is no nesting.
        subagents: this.workers.has(input.session.id)
          ? undefined
          : this.subagentControl({ parentID: input.session.id, messageID: assistant.id, callID: part.callID, signal: input.signal }),
        progress: (text) => {
          part.output = text
          publish()
        },
      })
      part.status = "completed"
      part.output = result.output
      part.title = result.title ?? part.title
      part.metadata = result.metadata
      // MiMo's auto-worktree notice: the first change a conversation makes to a repository's main worktree is noted.
      await this.noteWorktreeChange(owner, part, input.session.directory)
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
       * Cut off by Stop rather than failing on its own. The model still reads
       * the error; the transcript settles the step quietly, as MiMo does.
       */
      if (input.signal.aborted) part.metadata = { ...(part.metadata ?? {}), aborted: true }
      if (err instanceof PermissionDenied && err.byUser) refusedByUser = true
    } finally {
      stopListening()
      // A finished tool hands back metadata of its own, which would otherwise replace the record.
      if (decisions.length) part.metadata = { ...(part.metadata ?? {}), permissions: decisions }
      part.time.completed = Date.now()
      publish()
      await this.store.saveMessage(assistant, true)
    }
    /*
     * MiMo stops the conversation when a person rejects, rather than handing
     * the refusal back for the model to work around. Stopped the way Stop does
     * it, so calls still running or asking are cancelled with it. The refusal
     * and its reason are already saved on the part for the next message.
     */
    // subagents: a refusal inside a subagent stops the turn it works for, and so every subagent in it.
    if (refusedByUser) this.abort(owner)
  }

  /** A conversation's first change to a repository's main worktree, waiting for the next step to note it. */
  private readonly worktreeHits = new Map<string, { root: string; linked: boolean }>()

  /**
   * MiMo's auto-worktree notice, first half: a completed write, edit or patch
   * in a git repository's main worktree, by a conversation of the user's own
   * (not a subagent), that has not been told yet. The shell is not looked at:
   * MCode's shell tool reports no paths it changed.
   */
  private async noteWorktreeChange(sessionID: string, part: ToolPart, directory: string): Promise<void> {
    if (this.worktreeHits.has(sessionID) || !["write", "edit", "apply_patch"].includes(part.name)) return
    const target = typeof part.input?.path === "string" ? part.input.path : undefined
    if (!target) return
    const session = await this.store.get(sessionID)
    if (!session || session.parentID || session.worktreeNotice) return
    const top = await worktreeTop(path.dirname(path.resolve(directory, target)))
    if (!top?.main) return
    this.worktreeHits.set(sessionID, { root: top.root, linked: await hasLinkedWorktrees(top.root) })
  }

  /**
   * Second half: at the next step the note is added to the latest user message
   * - stored, as MiMo stores it - and the conversation is marked so it is never
   * told twice.
   */
  private async deliverWorktreeNotice(sessionID: string): Promise<void> {
    const hit = this.worktreeHits.get(sessionID)
    if (!hit) return
    this.worktreeHits.delete(sessionID)
    const session = await this.store.get(sessionID)
    if (!session || session.worktreeNotice) return
    const latest = [...this.liveMessages(session, await this.store.messages(sessionID))].reverse().find((message): message is UserMessage => message.role === "user")
    if (!latest) return
    await this.store.saveMessage({ ...latest, reminders: [...(latest.reminders ?? []), worktreeNotice(hit.root, hit.linked)] })
    await this.store.update(sessionID, { worktreeNotice: true })
  }

  /** Each conversation's system prompt as first built, and what it was built for (see `run`). */
  private readonly prefixes = new Map<string, { key: string; system: string }>()

  /** Tools a conversation said to always let repeat, by session: MiMo's `always` on its doom-loop ask. */
  private readonly repeatsAllowed = new Map<string, Set<string>>()

  /**
   * MiMo's doom-loop check. The third call in a row with the same tool and the
   * same input stops and asks: once lets it run, always lets that tool repeat
   * for the rest of the conversation, and a refusal - or typed feedback, or
   * dismissing the question - refuses the call, which stops the turn as a
   * refused permission does.
   */
  private async checkRepeated(part: ToolPart, assistant: AssistantMessage, sessionID: string, signal: AbortSignal): Promise<void> {
    if (!repeatsCall(assistant.parts, part) || this.repeatsAllowed.get(sessionID)?.has(part.name)) return
    const [answer] = await this.questions.ask({
      sessionID,
      questions: [
        {
          question: `${part.name} has been called three times in a row with the same input. Let it run again?`,
          header: part.name,
          options: [
            { label: LOOP_ANSWERS.once, description: "" },
            { label: LOOP_ANSWERS.always, description: "" },
            { label: LOOP_ANSWERS.reject, description: "" },
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
      allowed.add(part.name)
      this.repeatsAllowed.set(sessionID, allowed)
      return
    }
    const feedback = chosen.find((entry) => entry !== LOOP_ANSWERS.reject)
    throw new PermissionDenied(
      part.name,
      feedback
        ? `The user stopped this repeated call and said: ${feedback}`
        : "The user stopped this call: it repeated the previous two calls with the same input.",
      true,
    )
  }

  /** subagents: the task tool's actions, bound to the conversation and call they were asked from. */
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
  private async startSubagent(call: SubagentCall, spec: SubagentSpec, background: boolean): Promise<{ child: SessionInfo; worker: Worker }> {
    const parent = await this.store.require(call.parentID)
    const model = spec.model ? this.modelFor(spec.model) : parent.model
    const type = spec.type
    const counted = `${parent.id}:${type}`
    const earlier = (await this.store.list()).filter((session) => session.parentID === parent.id && session.subagent?.type === type)
    // Read and reserved with nothing awaited between, so calls started together never share a number.
    const number =
      Math.max(this.numbering.get(counted) ?? 0, ...earlier.map((session) => Number(/-(\d+)$/.exec(session.subagent?.id ?? "")?.[1] ?? 0))) + 1
    this.numbering.set(counted, number)
    const name = `${type}-${number}`

    // An explore subagent only reads, and nothing started from Plan may change anything either.
    const agent: AgentName = type === "explore" || parent.agent === "plan" ? "plan" : "build"
    const child = await this.store.create({
      directory: parent.directory,
      model,
      agent,
      effort: parent.effort,
      title: spec.description || name,
      parentID: parent.id,
      parentMessageID: call.messageID,
      parentCallID: call.callID,
      subagent: { type, id: name, ...(background ? { background: true } : {}), status: "running", turns: 1 },
    })
    await this.store.saveMessage({
      id: Identifier.message(),
      sessionID: child.id,
      role: "user",
      text: spec.prompt,
      attachments: [],
      time: { created: Date.now() },
    })
    const worker = this.work(child, { background, owner: background ? undefined : (this.owners.get(parent.id) ?? parent.id) })
    return { child, worker }
  }

  /** subagents: claims a subagent's session and runs its turn in the background of whoever asked. */
  private work(child: SessionInfo, options: { background: boolean; owner?: string }): Worker {
    const controller = new AbortController()
    this.running.set(child.id, controller)
    if (options.owner) this.owners.set(child.id, options.owner)
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
    }
    this.workers.set(child.id, worker)
    worker.settled = this.childTurn(child, worker, controller)
    if (options.background) this.watch()
    return worker
  }

  /** subagents: one turn of a subagent, then its record, then word to its parent if it is owed any. */
  private async childTurn(child: SessionInfo, worker: Worker, controller: AbortController): Promise<ChildOutcome> {
    let failure: unknown
    try {
      do {
        await this.run(child.id, this.config.apiKey(child.model.provider) ?? "", controller)
        await this.steering.get(child.id)?.written
        // A follow-up that landed as the last step ended is answered in this turn too.
      } while (!controller.signal.aborted && this.steered(child.id))
    } catch (err) {
      failure = err
      if (!(err instanceof Shown)) this.bus.publish({ type: "session.error", sessionID: child.id, error: describe(err) })
    } finally {
      // Closed with nothing awaited since the last look, so a follow-up either made it in or finds the turn over.
      this.steering.delete(child.id)
      if (!this.owners.has(child.id)) await this.commitSnapshot(child.id).catch(() => undefined)
      this.running.delete(child.id)
      this.owners.delete(child.id)
      if (this.workers.get(child.id) === worker) this.workers.delete(child.id)
      this.unwatch()
      this.bus.publish({ type: "session.idle", sessionID: child.id })
    }

    const outcome = await this.outcomeOf(child.id, controller.signal.aborted, failure)
    const current = await this.store.get(child.id)
    if (current?.subagent) {
      await this.store
        .update(child.id, {
          subagent: {
            ...current.subagent,
            status: "idle",
            outcome: outcome.kind,
            error: outcome.kind === "failure" ? outcome.error : undefined,
            ended: Date.now(),
          },
        })
        .catch(() => undefined)
    }
    if (worker.notify && current) await this.notifyParent(worker.parentID, this.noticeOf(current, outcome)).catch(() => undefined)
    return outcome
  }

  /** subagents: how a subagent's turn ended, read from its transcript. */
  private async outcomeOf(sessionID: string, aborted: boolean, failure: unknown): Promise<ChildOutcome> {
    if (aborted) return { kind: "cancelled" }
    const messages = await this.store.messages(sessionID).catch((): Message[] => [])
    const last = [...messages].reverse().find((message): message is AssistantMessage => message.role === "assistant")
    if (failure !== undefined || last?.finish === "error" || last?.finish === "refusal") {
      return { kind: "failure", error: last?.error ?? describe(failure instanceof Shown ? failure.reason : failure) }
    }
    return { kind: "success", answer: answerIn(last) }
  }

  /** subagents: a subagent's last answer, for wait. */
  private async answerOf(sessionID: string): Promise<string> {
    const messages = await this.store.messages(sessionID).catch((): Message[] => [])
    return answerIn([...messages].reverse().find((message): message is AssistantMessage => message.role === "assistant"))
  }

  /** subagents: MiMo's five outcomes, as the parent is told them. */
  private noticeOf(child: SessionInfo, outcome: ChildOutcome): NoticeEntry {
    const base = { subagentID: child.subagent?.id ?? child.id, sessionID: child.id, description: child.title }
    if (outcome.kind === "cancelled") return { notice: { ...base, status: "cancelled" } }
    if (outcome.kind === "failure") return { notice: { ...base, status: "failed", summary: firstLine(outcome.error) }, result: outcome.error }
    if (!outcome.answer) return { notice: { ...base, status: "ended" } }
    return { notice: { ...base, status: "completed", summary: firstLine(outcome.answer) }, result: outcome.answer }
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
    const { child, worker } = await this.startSubagent(call, spec, false)
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
      return { output: subagentOutput(name, note, "timeout"), title: child.title, metadata }
    }
    if (outcome.kind === "cancelled") throw new ToolError("The subagent was stopped before it finished.")
    if (outcome.kind === "failure") throw new ToolError(`The subagent failed: ${outcome.error}`)
    return { output: subagentOutput(name, outcome.answer || "(The subagent ended without a final message.)"), title: child.title, metadata }
  }

  /** subagents: spawn - start the subagent and answer at once; its outcome arrives as a notice. */
  private async spawnSubagent(call: SubagentCall, spec: SubagentSpec): Promise<ToolResult> {
    const { child } = await this.startSubagent(call, spec, true)
    const name = child.subagent?.id ?? child.id
    return {
      output: [
        `subagent_id: ${name}`,
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
    return { output: JSON.stringify({ status: "unknown", subagent_id: id }), title: id, metadata: { status: "unknown" } }
  }

  /** subagents: where a subagent stands, as status, wait and cancel report it. */
  private snapshotOf(child: SessionInfo): Record<string, unknown> {
    const state = child.subagent
    const running = this.running.has(child.id)
    return {
      status: running ? "running" : "idle",
      subagent_id: state?.id ?? child.id,
      description: child.title,
      subagent_type: state?.type,
      background: state?.background === true,
      turns: state?.turns ?? 1,
      ...(!running && state?.outcome ? { outcome: state.outcome } : {}),
      ...(!running && state?.error ? { error: state.error } : {}),
      started: child.created,
      ...(!running && state?.ended ? { ended: state.ended } : {}),
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
      if (ended === "timeout") return this.reported(child, { status: "timeout", subagent_id: child.subagent?.id ?? id, description: child.title })
      child = (await this.store.get(child.id)) ?? child
    }
    const snapshot = this.snapshotOf(child)
    const answered = snapshot.status === "idle" && (child.subagent?.outcome ?? "success") === "success"
    return this.reported(child, answered ? { ...snapshot, result: await this.answerOf(child.id) } : snapshot)
  }

  /** subagents: cancel - stop a running subagent; one that is idle is left as it is. */
  private async cancelSubagent(parentID: string, id: string): Promise<ToolResult> {
    const child = await this.findSubagent(parentID, id)
    if (!child) return this.unknownSubagent(id)
    const about = {
      subagent_id: child.subagent?.id ?? id,
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
      const refused = { queued: false, subagent_id: id, error: "There is no subagent with that subagent_id in this conversation." }
      return { output: JSON.stringify(refused), title: id, metadata: { status: "unknown" } }
    }
    const inbox = { from: "main" }
    const queued = (target: SessionInfo, messageID: string): ToolResult => ({
      output: JSON.stringify({ queued: true, subagent_id: target.subagent?.id ?? id, message_id: messageID }),
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

  /** subagents: a model the task tool named, as `provider/model` or as an id only one connected provider has. */
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

/** subagents: the conversation and call a task tool action was asked from. */
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
}

type ChildOutcome = { kind: "success"; answer: string } | { kind: "failure"; error: string } | { kind: "cancelled" }

type NoticeEntry = { notice: SubagentNotice; result?: string }

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
  /** True once a tool ran whose file changes cannot be seen from here. */
  opaque: boolean
  /**
   * The user messages this turn is answering, in the order they were sent.
   *
   * More than one when the turn was steered. Recorded so that rolling the
   * conversation back to a message can find the turn that message belongs to,
   * and know how much of the transcript that turn's recording accounts for.
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

/**
 * MiMo's interleaved field: what the model's entry states, else `reasoning_content`
 * for a DeepSeek model reached over the OpenAI-compatible wire.
 */
function interleavedField(kind: string, model: ModelRef, entry: ModelEntry | undefined): string | undefined {
  if (kind !== "openai-compatible") return undefined
  if (entry?.interleaved) return entry.interleaved
  return model.model.toLowerCase().includes("deepseek") ? "reasoning_content" : undefined
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
