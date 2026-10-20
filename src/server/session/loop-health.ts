import type { AssistantMessage, AssistantPart, MessageCrop, ToolPart } from "@shared/protocol"
import {
  concreteStepFromBashRetry,
  formatStuckSuggestion,
  formatVerifyLoopNote,
  getVerifyLoopRound,
  incrementVerifyLoop,
  resetVerifyLoop,
  verifyLoopMax,
} from "./verify-loop"

/**
 * Whether a turn is getting anywhere, and what to do when it plainly is not.
 *
 * Four detectors, all here because they read the same turn - the first three
 * MiMo's, the last MCode's own:
 *
 * 1. `LoopMonitor` - the four kinds of stuck action. MCode used to notice only
 *    the first: three calls in a row with byte-identical arguments. That never
 *    catches the model rewriting the same fix with cosmetic differences, nor a
 *    command it retries after every failure, nor four reads in a row that turn
 *    nothing up. MiMo's `try-best-detector` watches all four.
 * 2. `stepDigest` and `textLoopNoteFor` - the same whole step written out
 *    again. The n-gram check in reminders.ts watches inside one reply; this
 *    watches across replies, which is where a model that has run out of ideas
 *    usually ends up.
 * 3. `detectStreak` and `applyCrops` - once a turn has repeated itself, saying
 *    "stop repeating" into a request that is three quarters made of the
 *    repetition rarely helps. MiMo takes the repeated span out of the request
 *    instead and remembers that it did.
 * 4. `WanderWatch` - a turn that keeps probing and never changes the project,
 *    which none of the three can see because nothing in it repeats or fails.
 *
 * Every threshold below is the one MiMo's engine uses, named where it is
 * declared so the value can be checked against it rather than guessed at.
 */

/** try-best-detector: how many recent edits an incoming one is compared against. */
export const EDIT_WINDOW = 12
/** Above this Jaccard similarity of 3-word shingles, two diffs are the same change. */
export const EDIT_SIMILARITY = 0.8
/** How many earlier edits of one file it has to resemble before the turn is stopped. */
export const EDIT_MATCHES = 2
/** How many same-kind actions in a row, none of them getting anywhere, is a loop. */
export const ACTION_STREAK = 4
/** How many times one normalised command may fail before the turn is stopped. */
export const BASH_RETRIES = 3

/** The tools that change a file, and so produce a diff worth comparing. */
const EDIT_TOOLS = new Set(["edit", "write", "notebook_edit", "patch"])

/**
 * Commands run to find out whether the work is done. Their value is that a
 * changed result counts as progress even when the command still fails - a test
 * run going from 9 failures to 1 is not a loop.
 */
const VERIFY_COMMAND =
  /(?:^|[;&|]\s*|\s)(?:(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|typecheck|lint|build|check))|pytest\b|python3?\s+-m\s+pytest\b|cargo\s+(?:test|check|clippy|build)\b|go\s+test\b|make\s+(?:test|check|lint|build)\b|tsc\b|vitest\b|jest\b)/i

export type LoopIncident =
  /** The third call in a row with the same tool and byte-identical arguments. */
  | { kind: "same-call"; tool: string; note?: string }
  /** The same change written to one file again, near enough that the difference is cosmetic. */
  | { kind: "edit-repeat"; tool: string; path: string; count: number; similarity: number; note?: string }
  /** The same command, normalised, failing again with nothing in between that changed its output. */
  | { kind: "bash-retry"; tool: string; command: string; count: number; note?: string }
  /** Four actions of one kind in a row, none of which moved anything. */
  | { kind: "action-streak"; tool: string; action: string; count: number; note?: string }

/** What the user is asked about, in one sentence. The model never reads this; the question does. */
export function describeLoop(incident: LoopIncident): string {
  switch (incident.kind) {
    case "same-call":
      return `${incident.tool} has been called three times in a row with the same input.`
    case "edit-repeat":
      return `${incident.tool} has written much the same change to ${incident.path} ${incident.count} times over (${Math.round(incident.similarity * 100)}% the same).`
    case "bash-retry":
      return `This command has failed ${incident.count} times with nothing in between changing what it printed: ${incident.command}`
    case "action-streak":
      return `${incident.count} ${incident.action} calls in a row have turned nothing up.`
  }
}

/** A concrete next step for an incident, in the same spirit as the verify-loop notes. */
export function suggestLoopNextStep(incident: LoopIncident): string {
  switch (incident.kind) {
    case "same-call":
      return "Change the arguments or switch tools; do not repeat the identical call."
    case "edit-repeat":
      return `Re-read ${incident.path}, make a smaller distinct edit, or run the failing check first.`
    case "bash-retry":
      return concreteStepFromBashRetry(incident.command)
    case "action-streak":
      return "Re-read the task goal; try a different search query or open a known entry file."
  }
}

/** A diff reduced to what it actually changes: the added and removed lines, whitespace flattened. */
export function normalizeDiff(diff: string): string {
  return diff
    .replaceAll("\r\n", "\n")
    .split("\n")
    .filter((line) => (line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---"))
    .map((line) => `${line[0]} ${line.slice(1).trim().replace(/\s+/g, " ")}`)
    .filter((line) => line.length > 2)
    .join(" ")
}

/** Overlapping runs of three words, which is what two diffs are compared by. Words hold no spaces, so joining on one cannot collide. */
export function shingles(text: string, size = 3): Set<string> {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length < size) return new Set(words.length ? [words.join(" ")] : [])
  return new Set(Array.from({ length: words.length - size + 1 }, (_, at) => words.slice(at, at + size).join(" ")))
}

/** How much two sets have in common, over everything either of them holds. */
export function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  const union = new Set([...left, ...right])
  if (!union.size) return 0
  let shared = 0
  for (const value of left) if (right.has(value)) shared += 1
  return shared / union.size
}

/**
 * A command with the parts that differ between two runs of the same thing
 * taken out: a temporary path, a long number, a seed. Without this, a retry
 * loop through `mktemp` looks like a different command every time.
 */
export function normalizeCommand(command: string): string {
  return command
    .replace(/(?:[A-Za-z]:)?[\\/](?:private[\\/])?[Tt]e?mp[\\/][\w.-]+/g, "<TMP>")
    .replace(/\b\d{6,}\b/g, "<NUM>")
    .replace(/--seed(?:=|\s+)\S+/g, "<SEED>")
    .replace(/\s+/g, " ")
    .trim()
}

/** The most of a result that is kept for comparing one run against the next. */
export const RESULT_KEPT = 2000

/** A command's output with the timings and temporary paths flattened, so "did anything change" is answerable. */
export function normalizeResult(value: string): string {
  const flattened = value
    .replace(/(?:[A-Za-z]:)?[\\/](?:private[\\/])?[Tt]e?mp[\\/][\w./\\-]+/g, "<TMP>")
    .replace(/\b\d{6,}\b/g, "<NUM>")
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|seconds?)\b/gi, "<TIME>")
    .replace(/\s+/g, " ")
    .trim()
  if (flattened.length <= RESULT_KEPT) return flattened
  const marker = " <CUT> "
  const head = Math.ceil((RESULT_KEPT - marker.length) / 2)
  return `${flattened.slice(0, head)}${marker}${flattened.slice(-(RESULT_KEPT - marker.length - head))}`
}

/** What a tool call names as the file it worked on, whichever way round it spells it. */
function pathOf(part: ToolPart): string | undefined {
  for (const key of ["file_path", "filePath", "path", "notebook_path", "notebookPath"]) {
    const value = part.input[key]
    if (typeof value === "string" && value) return value
  }
  const meta = part.metadata?.path
  return typeof meta === "string" && meta ? meta : undefined
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

/**
 * One turn's watch over what its tools are achieving.
 *
 * Fed every tool call as it settles, and asked each time whether this one is
 * evidence that the turn is going round. It answers at most once per incident:
 * the runner resets it after asking the user, so an allowed call does not
 * raise the same question on the very next part.
 */
export class LoopMonitor {
  private edits: { path: string; shingles: Set<string> }[] = []
  private failed = new Map<string, number>()
  private verify = new Map<string, { ok: boolean; result: string }>()
  private action?: { kind: string; progress: boolean }
  private streak = 0

  constructor(private readonly sessionID?: string) {}

  consume(part: ToolPart): LoopIncident | undefined {
    const incident = this.detect(part)
    if (incident && !incident.note) incident.note = suggestLoopNextStep(incident)
    return incident
  }

  private detect(part: ToolPart): LoopIncident | undefined {
    if (part.status === "pending" || part.status === "running") return undefined
    if (EDIT_TOOLS.has(part.name)) return this.edit(part)
    if (part.name === "bash") return this.bash(part)
    // Anything else - reading, globbing, grepping - counts only towards a streak that finds nothing.
    return this.track({ kind: lookKind(part.name), progress: part.status === "completed" && this.found(part) }, part.name)
  }

  /**
   * Whether a call turned anything up.
   *
   * "Produced some text" was the test, and it made this detector unable to fire
   * on the case it is named for: a fruitless grep or glob answers "No files
   * found", which is text, so twenty of them in a row counted as twenty pieces
   * of progress and the streak never reached four. Only calls that *errored*
   * could raise it - a different and far rarer failure than a model hunting for
   * something that is not in the project. A search says how much it found, so
   * that is what is read; anything else still falls back to its output.
   */
  private found(part: ToolPart): boolean {
    const counted = part.metadata?.matches ?? part.metadata?.count
    if (typeof counted === "number") return counted > 0
    return Boolean(part.output?.trim())
  }

  /** After the user has answered, so the next call starts the count again rather than asking twice. */
  reset(): void {
    this.edits = []
    this.failed.clear()
    this.verify.clear()
    this.action = undefined
    this.streak = 0
    if (this.sessionID) resetVerifyLoop(this.sessionID)
  }

  private verifyNote(problems: number, command?: string): string | undefined {
    if (!this.sessionID) return undefined
    const round = getVerifyLoopRound(this.sessionID) || incrementVerifyLoop(this.sessionID)
    const max = verifyLoopMax()
    const concrete = command
      ? concreteStepFromBashRetry(command)
      : "Re-read the failing output, change the code (not the test), then rerun the narrowest check."
    return round > max
      ? formatStuckSuggestion(problems, round, max, concrete)
      : formatVerifyLoopNote(problems, round, max, concrete)
  }

  private edit(part: ToolPart): LoopIncident | undefined {
    if (part.status !== "completed") return this.track({ kind: "edit", progress: false }, part.name)
    // A successful edit means the file moved, so a failing command may behave differently now.
    this.failed.clear()
    const file = pathOf(part)
    const diff = textOf(part.metadata?.diff)
    if (!file || !diff) return undefined
    const normalized = normalizeDiff(diff)
    if (!normalized) return undefined
    const shape = shingles(normalized)
    const similar = this.edits
      .filter((entry) => entry.path === file)
      .map((entry) => jaccard(shape, entry.shingles))
      .filter((score) => score > EDIT_SIMILARITY)
    this.edits.push({ path: file, shingles: shape })
    if (this.edits.length > EDIT_WINDOW) this.edits.shift()
    if (similar.length < EDIT_MATCHES) return undefined
    return { kind: "edit-repeat", tool: part.name, path: file, count: similar.length + 1, similarity: Math.max(...similar) }
  }

  private bash(part: ToolPart): LoopIncident | undefined {
    const raw = textOf(part.input.command) ?? textOf(part.metadata?.command)
    if (!raw) {
      this.action = undefined
      this.streak = 0
      return undefined
    }
    const command = normalizeCommand(raw)
    const exit = part.metadata?.exit
    const ok = part.status === "completed" && (typeof exit !== "number" || exit === 0)
    const result = normalizeResult(part.status === "completed" ? (part.output ?? "") : (part.error ?? ""))
    const verifying = VERIFY_COMMAND.test(command)
    const before = verifying ? this.verify.get(command) : undefined
    // A failing check whose output changed is progress: the work moved, even though it is not done.
    const progress = ok || (before !== undefined && before.result !== result)
    if (verifying) this.verify.set(command, { ok, result })
    if (ok) this.failed.delete(command)
    // Only a verbatim-repeat failure burns a verify round: a changed output
    // means the code moved, which is the opposite of a stuck loop.
    if (verifying && !ok && !progress && this.sessionID) incrementVerifyLoop(this.sessionID)
    if (verifying && ok && this.sessionID) resetVerifyLoop(this.sessionID)
    let count = 0
    if (!ok) {
      count = progress ? 1 : (this.failed.get(command) ?? 0) + 1
      this.failed.set(command, count)
    }
    const retry: LoopIncident | undefined = count >= BASH_RETRIES ? { kind: "bash-retry", tool: part.name, command, count } : undefined
    if (retry && verifying && this.sessionID) retry.note = this.verifyNote(1, command)
    if (!verifying) return retry
    if (retry) return retry
    const streak = this.track({ kind: "verify", progress }, part.name)
    if (streak && streak.kind === "action-streak" && streak.action === "verify" && this.sessionID) {
      streak.note = this.verifyNote(1, command)
    }
    return streak
  }

  /** A run of same-kind actions, broken by anything that got somewhere or by a different kind of action. */
  private track(next: { kind: string; progress: boolean }, tool: string): LoopIncident | undefined {
    if (next.progress || this.action?.kind !== next.kind) {
      this.action = next
      this.streak = next.progress ? 0 : 1
      return undefined
    }
    this.streak += 1
    if (this.streak < ACTION_STREAK) return undefined
    return { kind: "action-streak", tool, action: next.kind, count: this.streak }
  }
}

/** Which kind of action a tool that neither edits nor runs commands counts as. */
function lookKind(tool: string): string {
  if (tool === "read" || tool === "glob" || tool === "grep") return "search"
  return tool
}

// ------------------------------------------------------------------ wandering

/** How many settled calls in a row may pass without changing a file the project already had. */
export const WANDER_CALLS = 20
/** How many times a turn is told; the second time it is told to hand over. */
export const WANDER_RECOVERIES = 2

const WANDER_NOTE = [
  `You have made ${WANDER_CALLS} tool calls since you last changed a file the project already had. Every command may have succeeded, but the work has not moved: this is what being stuck on a wrong idea looks like.`,
  "Before you run anything else, stop and write down, briefly: exactly what is failing and what it expects; what the code involved does, read line by line; and the simplest explanation that fits all of it.",
  "A plain misunderstanding of how the language or a library behaves is far more likely than a broken runtime, compiler or machine - check that first.",
  "Then act on the most likely explanation. Throwaway probe scripts do not count as progress.",
].join(" ")

const WANDER_HANDOVER = [
  `Another ${WANDER_CALLS} calls have gone by without changing a file the project already had. This line of investigation is not working.`,
  "Stop investigating. Tell the user what you have established, what you suspect and why, and the concrete next step to try (re-state the failing check, re-read the last edited file, or run the narrowest check); do not stop at a request for advice.",
].join(" ")

/**
 * A turn that keeps looking and never changes anything.
 *
 * Not one of MiMo's detectors: its four watch for a call repeated or failing,
 * and a model that has talked itself into a wrong theory does neither - it runs
 * a different, successful probe every step, one benchmark run 177 of them over
 * eight minutes. What such a turn never does is change a file the project
 * already had, so that is what is counted. Files the turn created itself - the
 * probes - do not reset the count, and neither do edits to them.
 *
 * It asks nobody anything: the note goes to the model, in the request after
 * the step that crossed the line, as the text-loop notes do.
 */
export class WanderWatch {
  private since = 0
  private told = 0
  private made = new Set<string>()

  consume(part: ToolPart): void {
    if (part.status === "pending" || part.status === "running") return
    const file = pathOf(part)
    if (EDIT_TOOLS.has(part.name) && part.status === "completed" && file) {
      if (part.metadata?.created === true) this.made.add(file)
      else if (!this.made.has(file)) {
        this.since = 0
        return
      }
    }
    this.since += 1
  }

  /** What to tell the model now, if anything; each note starts the count again. */
  note(): string | undefined {
    if (this.told >= WANDER_RECOVERIES || this.since < WANDER_CALLS) return undefined
    this.since = 0
    this.told += 1
    return this.told === 1 ? WANDER_NOTE : WANDER_HANDOVER
  }
}

// ---------------------------------------------------------------- text loops

/** How many recent steps are kept to compare against each other. */
export const TEXT_LOOP_BUFFER = 5
/** How many identical steps in a row are a loop. */
export const TEXT_LOOP_TRIGGER = 3
/** How many times a turn is pulled out of one before it is left to end. */
export const TEXT_LOOP_RECOVERIES = 2
/** How much of a step's text is compared; past this two steps that opened the same are the same. */
export const TEXT_LOOP_DIGEST = 200

/**
 * A step's text reduced to what would be the same if the model simply said it
 * again: case folded, whitespace flattened, and the throat-clearing a model
 * varies between otherwise identical steps ("Let me", "I'll") removed.
 */
export function stepDigest(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^(let me |i'll |i will |let's |now )/, "")
    .slice(0, TEXT_LOOP_DIGEST)
}

const TEXT_LOOP_NOTE = [
  "Your last few steps said the same thing over again, word for word.",
  "Stop and do something different: a different tool or different arguments, a different approach, or - if something is blocking you - say plainly what it is and the concrete next step you will try.",
].join(" ")

const TEXT_LOOP_REPLAN = [
  "You are still repeating the same step after being pulled out of it once.",
  "The approach you are on has failed. Say what you were trying to do and why it did not work, then take a concrete next step (re-read the relevant file, run the narrowest failing check, or narrow the failing assertion) instead of trying the same thing again.",
].join(" ")

/**
 * Whether the last few steps are the same step, and what to say about it.
 *
 * The buffer holds the digests of the recent steps, newest last. Two notes at
 * most, as MiMo allows two; after that the turn is left alone, because a third
 * identical note is itself a repetition.
 */
export function textLoopNoteFor(digests: readonly string[], used: number): string | undefined {
  if (used >= TEXT_LOOP_RECOVERIES) return undefined
  if (digests.length < TEXT_LOOP_TRIGGER) return undefined
  const tail = digests.slice(-TEXT_LOOP_TRIGGER)
  if (!tail[0] || tail.some((digest) => digest !== tail[0])) return undefined
  return used === 0 ? TEXT_LOOP_NOTE : TEXT_LOOP_REPLAN
}

// ------------------------------------------------------------- streak crops

/** How many finished steps sharing one key make a streak. */
export const STREAK_TRIGGER = 3
/** The most messages one crop may take out, so a long stuck run does not remove the whole conversation. */
export const STREAK_MAX_SPAN = 64

function stableJSON(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJSON(record[key])}`)
    .join(",")}}`
}

/**
 * What makes one step the same as another: its reasoning if it wrote any, else
 * the calls it made with their arguments. Reasoning first because a model that
 * is stuck thinks the same thought before making slightly different calls, and
 * that thought is the earlier sign.
 */
export function streakKey(parts: readonly AssistantPart[]): string {
  const reasoning = parts
    .filter((part) => part.type === "reasoning")
    .map((part) => (part.type === "reasoning" ? part.text : ""))
    .join("")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^(let me |i'll |i will |let's )/, "")
  if (reasoning) return `reason:${reasoning.slice(0, 500)}`
  const calls = parts
    .filter((part): part is ToolPart => part.type === "tool")
    .map((part) => `${part.name}:${stableJSON(part.input ?? {})}`)
  return calls.length ? `tool:${calls.join("\n")}` : ""
}

/**
 * The span at the end of a conversation that keeps doing the same thing.
 *
 * Only a run that reaches the very last finished step counts: a stretch the
 * conversation already climbed out of is history worth keeping.
 */
export function detectStreak(steps: readonly AssistantMessage[]): MessageCrop | undefined {
  if (steps.length < STREAK_TRIGGER) return undefined
  const keys = steps.map((step) => streakKey(step.parts))
  const key = keys[keys.length - 1]!
  if (!key) return undefined
  if (keys.slice(-STREAK_TRIGGER).some((entry) => entry !== key)) return undefined
  let start = steps.length - 1
  while (start > 0 && keys[start - 1] === key) start -= 1
  const from = Math.max(start, steps.length - STREAK_MAX_SPAN)
  return { from: steps[from]!.id, to: steps[steps.length - 1]!.id, key }
}

/**
 * The request with every remembered span taken out of it.
 *
 * A message is dropped only while it still matches the key the crop was made
 * for, so a crop can never quietly swallow a step that did something else.
 */
export function applyCrops<T extends { id: string; role: string; parts?: AssistantPart[] }>(history: T[], crops: readonly MessageCrop[]): T[] {
  if (!crops.length) return history
  return history.filter((message) => {
    if (message.role !== "assistant" || !message.parts) return true
    const key = streakKey(message.parts)
    return !crops.some((crop) => message.id >= crop.from && message.id <= crop.to && key === crop.key)
  })
}
