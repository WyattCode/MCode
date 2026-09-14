import type {
  AssistantMessage,
  AssistantPart,
  Attachment,
  Message,
  ReasoningPart,
  SessionInfo,
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
import type { ToolDefinition } from "../tool/types"
import { ToolError } from "../tool/types"
import { AnthropicAdapter, describeAnthropicError } from "../provider/anthropic"
import { OpenAICompatible } from "../provider/openai"
import { ChatGPTSubscription } from "../provider/chatgpt"
import type { AuthManager } from "../auth/manager"
import type { ProviderAdapter, TurnEvent, TurnOutcome } from "../provider/types"
import { ProviderError } from "../provider/types"
import type { SessionStore, Snapshot, SnapshotFile } from "./store"
import { emptyUsage } from "./store"
import type { Recording } from "./snapshot"
import { Snapshots, decode, readSnapshotFile } from "./snapshot"
import {
  SUMMARY_OUTPUT_TOKENS,
  isContextOverflow,
  isOverflowByCount,
  maxOutputTokens,
  summaryWouldFit,
} from "./overflow"
import { buildSummaryPrompt, isSummary, selectForSummary } from "./summary"
import { systemPrompt, titleFrom } from "./prompt"

/** A message the user sent: its words, its files, and the places it points at. */
type PromptInput = { sessionID: string; text: string; attachments?: Attachment[]; annotations?: UserMessage["annotations"] }

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

const COMPACT_SYSTEM = [
  "You are compacting a coding session so it can continue in a smaller context.",
  "Write a dense summary of everything that still matters: what the user asked for,",
  "what was decided and why, which files and symbols were touched, what is done,",
  "what is still open, and any constraint or preference the user stated.",
  "Keep exact names, paths and identifiers. Omit pleasantries and narration.",
  "Write it as notes to yourself, not as a report to the user.",
].join(" ")

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
export class SessionRunner {
  private readonly running = new Map<string, AbortController>()
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
  /*
   * Set after construction rather than injected: the MCP layer reads config,
   * which the runner also holds, and threading it through the constructor
   * would make the two impossible to build in either order.
   */
  private mcp?: { tools: () => ToolDefinition[] }

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
    permissions.useReviewer((input) => this.reviewCommand(input))
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
  private tools(agent: string, modelID: string): ToolDefinition[] {
    const own = toolsFor(agent, modelID)
    if (agent === "plan") return own
    return [...own, ...(this.mcp?.tools() ?? [])]
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

  /** True once nothing is mid-turn, so storage can be cleared safely. */
  get idle(): boolean {
    return this.running.size === 0
  }

  abort(sessionID: string): void {
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

    const summary: UserMessage = {
      id: `${mark.messageID}:summary`,
      sessionID: session.id,
      role: "user",
      text: mark.summary,
      attachments: [],
      time: { created: mark.at },
    }
    return [summary, ...messages.slice(at + 1)]
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
      return await this.compactNow(session, controller.signal)
    } finally {
      this.running.delete(sessionID)
      this.bus.publish({ type: "session.idle", sessionID })
    }
  }

  /**
   * The compaction itself, for the button above and for a turn that has
   * outgrown its model (see `run`). Streams a summary of everything the model
   * currently sees and records it as the new starting point.
   */
  private async compactNow(session: SessionInfo, signal: AbortSignal): Promise<SessionInfo> {
    const stored = await this.store.messages(session.id)
    const live = this.liveMessages(session, stored)
    /*
     * What a new summary has to cover: everything since the last one. The
     * last summary itself goes in separately, as the reference passes it, so
     * the model is told to carry it forward rather than shown it as a message.
     */
    const previous = session.compacted
    const since = (() => {
      if (!previous) return live
      const at = live.findIndex((message) => message.id === previous.messageID)
      return at < 0 ? live : live.slice(at + 1)
    })()
    const selected = selectForSummary(since)
    if (!selected) throw new Error("Nothing to compact yet")
    const prompt = buildSummaryPrompt({ previousSummary: previous?.summary, context: [selected.head] })
    // The reference's own guard: a summary request it can see will not fit is
    // not sent. Measured on the prompt that will actually go out, not on the
    // raw transcript, since tool output is cut to 2,000 characters in it.
    if (!summaryWouldFit(prompt.length, this.config.modelEntry(session.model)?.contextWindow ?? 0)) {
      throw new Error("This conversation is too long to summarise within the model's context window")
    }

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

    let summary = ""
    this.summarising.add(session.id)
    this.bus.publish({ type: "session.compacting", sessionID: session.id, active: true })
    try {
      await adapter.stream(
        {
          apiKey: tokens?.access ?? apiKey,
          model: session.model,
          system: COMPACT_SYSTEM,
          /*
           * One user message, the conversation quoted inside it and the
           * instruction after it, as the reference sends it. Not the
           * transcript replayed as a live conversation, which a model
           * continues rather than summarises.
           */
          history: [
            {
              id: `${session.id}:summary-request`,
              sessionID: session.id,
              role: "user",
              text: prompt,
              attachments: [],
              time: { created: Date.now() },
            },
          ],
          tools: [],
          effort: "low",
          showReasoning: false,
          signal,
          baseURL: definition.baseURL,
          headers: definition.headers,
          accountId: tokens?.accountId,
          /*
           * A summary is short, and asking for the usual 32k is what stopped
           * this from working the first time: a transcript that had just been
           * refused at 230,145 tokens plus a 32,000 answer is one token over
           * the same window, so the summary was refused too. The reference asks
           * for 4,096 here (its SUMMARY_OUTPUT_TOKENS), which leaves the room
           * a summary of an overlong conversation needs.
           */
          maxOutput: Math.min(maxOutputTokens(this.config.modelEntry(session.model)), SUMMARY_OUTPUT_TOKENS),
        },
        (event) => {
          if (event.type === "text.delta") summary += event.text
        },
      )
    } finally {
      this.summarising.delete(session.id)
      this.bus.publish({ type: "session.compacting", sessionID: session.id, active: false })
    }
    summary = summary.trim()
    if (!summary) throw new Error("The model returned an empty summary")
    if (!isSummary(summary)) throw new Error("The model did not return a summary")
    return this.store.update(session.id, {
      // The last message the summary covers. Everything after it - the kept
      // end - stays in the model's view word for word, as the reference keeps
      // its `recent`.
      compacted: { messageID: selected.mark.id, summary, at: Date.now() },
    })
  }

  /**
   * A compaction nothing is waiting on.
   *
   * The one made because a step's token count crossed the line is ahead of
   * need: the step itself succeeded, and failing to summarise must not turn a
   * finished turn into an error. The reference's `compactIfNeeded` returns
   * false and carries on; so does this. If the next request is then refused
   * for length, the rescue in `run` takes it from there.
   */
  private async compactQuietly(session: SessionInfo, signal: AbortSignal): Promise<SessionInfo> {
    try {
      return await this.compactNow(session, signal)
    } catch {
      return session
    }
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
  ): Promise<string> {
    const user: UserMessage = {
      id: Identifier.message(),
      sessionID: input.sessionID,
      role: "user",
      text: input.text,
      attachments: input.attachments ?? [],
      ...(input.annotations?.length ? { annotations: input.annotations } : {}),
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

    const written = steering.written.then(() => this.store.saveMessage(user))
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

    const user: UserMessage = {
      id: Identifier.message(),
      sessionID: session.id,
      role: "user",
      text: input.text,
      attachments: input.attachments ?? [],
      ...(input.annotations?.length ? { annotations: input.annotations } : {}),
      time: { created: Date.now() },
    }
    await this.store.saveMessage(user)
    this.turn(session.id).messages = [user.id]

    // First real prompt names the session, so the sidebar stops saying "New session".
    if (session.title === "New session" && input.text.trim()) {
      await this.store.update(session.id, { title: titleFrom(input.text) })
    }

    this.launch(session.id, apiKey, controller)
    return user.id
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

  /** Runs a claimed session's turn and releases it afterwards. */
  private launch(sessionID: string, apiKey: string, controller: AbortController): void {
    this.steering.set(sessionID, { waiting: [], written: Promise.resolve() })

    // Deliberately not awaited: the caller gets the message id immediately and
    // follows the turn through events.
    void this.run(sessionID, apiKey, controller)
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

  private async run(sessionID: string, apiKey: string, controller: AbortController): Promise<void> {
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
    const system = await systemPrompt({
      directory: session.directory,
      agent: session.agent,
      staged: session.staged,
      instructions: config.instructions,
      globalAgentsFile: this.globalAgents,
    })

    /*
     * The step that was last rescued by a compaction. A request the provider
     * refuses as too long is retried once against the compacted transcript,
     * as the reference does; refused again, the error stands.
     */
    let rescued = -1
    /*
     * No limit unless one is configured, which is the reference's default -
     * `agent.steps ?? Infinity`. Stop is what ends a turn that will not end
     * itself; a count that cuts in mid-refactor loses everything the model had
     * worked out, and says so in red.
     */
    const limit = config.maxSteps && config.maxSteps > 0 ? config.maxSteps : undefined
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
      const stored = await this.store.messages(sessionID)
      this.markDelivered(sessionID, stored)
      const history = this.contextFor(session, stored)

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
          : history,
        tools: lastStep ? [] : this.tools(session.agent, session.model.model),
        effort,
        showReasoning: config.showReasoning,
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
        maxOutput: maxOutputTokens(this.config.modelEntry(session.model)),
      })
      } catch (failure) {
        /*
         * A provider that refuses the request as too long is answered the way
         * the reference answers it: the transcript is compacted and the step
         * runs again. The refusal is already on the transcript, in red, from
         * `stream`; what follows it is the summary and the continuation.
         * Only one rescue per step - a summary that is itself too long is a
         * real failure, and it is left to stand.
         */
        const reason = failure instanceof Shown ? failure.reason : failure
        if (
          rescued !== step &&
          !controller.signal.aborted &&
          // compactNow measures the prompt it will send and refuses if it
          // cannot fit, which leaves the original refusal standing.
          isContextOverflow(describe(reason))
        ) {
          rescued = step
          try {
            session = await this.compactNow(session, controller.signal)
          } catch {
            // The summary failed too - the same refusal, usually. The one
            // already on the message stands; a second notice would say
            // nothing the first did not.
            throw failure
          }
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

      // Discovered providers report no pricing, so cost stays at zero
      // rather than being invented from a guessed rate.
      const entry = this.config.modelEntry(session.model)
      const usage = {
        ...outcome.usage,
        cost: entry
          ? ((outcome.usage.input + outcome.usage.cacheWrite) * entry.input +
              outcome.usage.output * entry.output) /
            1_000_000
          : 0,
      }
      assistant.usage = usage
      await this.store.addUsage(sessionID, usage)
      /*
       * The reference's other trigger: once the tokens the provider reports
       * reach the window less the room an answer needs, the transcript is
       * compacted before the model is asked again. Nothing for a model whose
       * window is not known - a discovered model reports 0 - which then has
       * only the refusal above to fall back on.
       */
      const overflowing = isOverflowByCount(usage, this.config.modelEntry(session.model))

      if (outcome.stop === "refusal") {
        assistant.finish = "refusal"
        assistant.error = "The model declined to continue with this request."
        assistant.time.completed = Date.now()
        await this.store.saveMessage(assistant)
        return
      }

      const pending = assistant.parts.filter((part): part is ToolPart => part.type === "tool")
      if (outcome.stop !== "tool_use" || pending.length === 0) {
        assistant.finish = outcome.stop === "max_tokens" ? "max_tokens" : "end_turn"
        assistant.time.completed = Date.now()
        await this.store.saveMessage(assistant)
        /*
         * The model has stopped, but the user may have typed while it was
         * writing. Read with nothing awaited after the save above, so that a
         * message arriving from this instant onwards is the release's business
         * and cannot fall between the two.
         */
        if (overflowing) {
          // Compacted at the end of the turn, so the next one starts inside
          // the window instead of being refused on its first request.
          session = await this.compactQuietly(session, controller.signal)
        }
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
      // The reference compacts after the step that crossed the line, before
      // the model is asked again.
      if (overflowing) session = await this.compactQuietly(session, controller.signal)
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
      const outcome = await adapter.stream(request, emit)

      // Tool arguments stream as partial JSON, so they are only trustworthy
      // once the turn closes - fill them in from the settled outcome.
      for (const call of outcome.toolCalls) {
        const part = assistant.parts.find(
          (candidate): candidate is ToolPart => candidate.type === "tool" && candidate.callID === call.callID,
        )
        if (part) part.input = call.input
        else
          announce({
            type: "tool",
            id: Identifier.part(),
            callID: call.callID,
            name: call.name,
            status: "pending",
            input: call.input,
            time: { created: Date.now() },
          })
      }

      await this.store.saveMessage(assistant)
      return outcome
    } catch (err) {
      if (request.signal.aborted || (err instanceof Error && err.name === "AbortError")) return undefined
      assistant.finish = "error"
      assistant.error = describe(err)
      if (err instanceof ProviderError && err.code) {
        assistant.errorCode = err.code
        assistant.errorParams = err.params
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

    part.status = "running"
    part.time.started = Date.now()
    publish()

    const reach = reachOf(part.name)
    if (reach !== "reads") {
      const turn = this.turn(input.session.id)
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

    try {
      /*
       * Several tools name a permission bucket and then never mention it again -
       * reading, listing, globbing, searching, the todo list all just run. Their
       * buckets were therefore settings with nothing behind them: a person could
       * switch reading off and watch files carry on being read. This is the only
       * point that every call passes through, so it is where those buckets are
       * consulted. Inside the try, so a refusal is caught below and written onto
       * the part as an error the model reads back, rather than ending the turn.
       */
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
        snapshot: (target) => this.record(input.session.id, target),
        shell: this.config.get().shell,
        progress: (text) => {
          part.output = text
          publish()
        },
      })
      part.status = "completed"
      part.output = result.output
      part.title = result.title ?? part.title
      part.metadata = result.metadata
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
    } finally {
      part.time.completed = Date.now()
      publish()
      await this.store.saveMessage(assistant, true)
    }
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
