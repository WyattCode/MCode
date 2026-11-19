import type { AssistantPart, PermissionRecord, ReasoningPart, TextPart, ToolPart } from "@shared/protocol"
import { saysSomething } from "@shared/reply-clean"
import { bucketOf, permissionsOf, stepState, stepTitle, type Bucket } from "./tool-meta"
import { t } from "./i18n"

/**
 * How a turn's parts become MiMo's step list.
 *
 * Every consecutive tool call - reads, commands, edits, MCP tools, running or
 * failed - shares one group until the model says something; a decided
 * permission sits right after the call it gated, inside the same group; a
 * question always stands on its own, and one still waiting for its answer is
 * not a row at all (it is in the dock). Subagent calls keep a group of their
 * own, as MiMo's do, so a run of them is never folded out of sight inside a
 * group of reads. Pure, so the grouping can be reasoned about apart from the
 * components that draw it.
 */

/** An error the turn carried on past, placed where it happened among the turn's parts. */
export interface InlineError {
  id: string
  /** How many of the turn's parts came before it. */
  at: number
  error?: string
  errorCode?: string
  errorParams?: Record<string, string>
}

export type StepItem =
  | { kind: "tool"; id: string; part: ToolPart }
  | { kind: "permission"; id: string; part: ToolPart; record: PermissionRecord }
  | { kind: "error"; id: string; error: InlineError }
  /** MiMo's "i" row: a word from the app about the step before it, under that step's group. */
  | { kind: "notice"; id: string; key: string }

export type StepRow =
  | { kind: "part"; id: string; part: TextPart | ReasoningPart }
  | { kind: "question"; id: string; part: ToolPart }
  /** `actor`: a run of subagent calls, drawn flat or as one pill row rather than under a summary. */
  | { kind: "group"; id: string; items: StepItem[]; actor?: boolean }
  | { kind: "error"; id: string; error: InlineError }

/**
 * Why the reconnecting row is retrying, as one line: MiMo draws the reason the
 * retry carries after the attempt, and nothing when there is none. A wait the
 * provider asked for is said from the tables rather than in whatever words
 * came back with it.
 */
export function retryReason(message: string | undefined, kind?: string): string | undefined {
  if (kind === "rate_limit") return t("error.rateLimited")
  const line = (message ?? "").replace(/\s+/g, " ").trim()
  return line || undefined
}

/*
 * An approved command is already on screen as its own step, so MiMo leaves its
 * permission row out; every other decision - a refusal, a cancel, an approved
 * edit or fetch - is drawn.
 */
export function permissionShown(record: PermissionRecord): boolean {
  const allowed = record.decided === "allow-once" || record.decided === "allow-always"
  return !(allowed && record.kind === "bash")
}

/** @param errors positions are relative to `parts`. */
export function buildRows(parts: AssistantPart[], errors: InlineError[] = []): StepRow[] {
  const out: StepRow[] = []
  let group: Extract<StepRow, { kind: "group" }> | undefined
  let actors: Extract<StepRow, { kind: "group" }> | undefined
  const waiting = [...errors].sort((a, b) => a.at - b.at)
  // MiMo says a command was skipped for wanting input once per turn, the first time.
  let toldInteractive = false
  const close = () => {
    group = undefined
    actors = undefined
  }

  const join = (item: StepItem) => {
    actors = undefined
    if (!group) {
      group = { kind: "group", id: `g:${item.id}`, items: [] }
      out.push(group)
    }
    group.items.push(item)
  }

  // subagents: MiMo's actor group - a subagent call closes the group of other calls, and they close it.
  const joinActors = (item: StepItem) => {
    group = undefined
    if (!actors) {
      actors = { kind: "group", id: `a:${item.id}`, items: [], actor: true }
      out.push(actors)
    }
    actors.items.push(item)
  }

  // An error joins the group of other calls that is open when it happened, and stands alone otherwise.
  const placeErrors = (before: number) => {
    while (waiting.length && waiting[0]!.at <= before) {
      const error = waiting.shift()!
      if (group) join({ kind: "error", id: error.id, error })
      else {
        close()
        out.push({ kind: "error", id: error.id, error })
      }
    }
  }

  parts.forEach((part, index) => {
    placeErrors(index)
    if (part.type === "reasoning") {
      // Nothing said is no break: the model often opens an empty block between calls.
      if (!part.text.trim()) return
      close()
      out.push({ kind: "part", id: part.id, part })
      return
    }
    if (part.type === "text") {
      // Nor is text that is only leaked markup or a lone ellipsis, as MiMo skips both.
      if (!saysSomething(part.text)) return
      close()
      out.push({ kind: "part", id: part.id, part })
      return
    }
    // tasks: MiMo draws no step for the task tool; the info card's 任务清单 shows what it did.
    if (part.name === "task") return
    // plan: plan_exit's approval card is drawn as the question it is, on its own row.
    if (part.name === "question" || part.name === "plan_exit") {
      // Still waiting: it lives in the dock, and leaves neither a row nor a break behind.
      if (part.status === "pending" || part.status === "running") return
      close()
      out.push({ kind: "question", id: part.id, part })
      return
    }
    const add = part.name === "actor" ? joinActors : join
    add({ kind: "tool", id: part.id, part })
    for (const record of permissionsOf(part)) {
      if (permissionShown(record)) add({ kind: "permission", id: `${part.id}:${record.requestID}`, part, record })
    }
    if (!toldInteractive && part.metadata?.interactive === true) {
      toldInteractive = true
      add({ kind: "notice", id: `${part.id}:interactive`, key: "stepList.interactiveSkipped" })
    }
  })
  placeErrors(Number.POSITIVE_INFINITY)
  return out
}

/**
 * MiMo's stages: a run of work (calls, permissions, errors) followed by a run
 * of what the turn said to the reader (its words, a question, subagents). The
 * next piece of work after something said starts a new stage.
 *
 * `progressEnd` is where the stage's work ends and its words begin; it equals
 * `end` for a stage that said nothing.
 */
export interface Stage {
  start: number
  progressEnd: number
  end: number
}

export function stagesOf<T>(rows: readonly T[], answers: (row: T) => boolean): Stage[] {
  const out: Stage[] = []
  let start = -1
  let progressEnd = -1
  let speaking = false
  rows.forEach((row, index) => {
    if (answers(row)) {
      if (start < 0) start = index
      if (progressEnd < 0) progressEnd = index
      speaking = true
      return
    }
    if (speaking) {
      out.push({ start, progressEnd, end: index })
      start = -1
      progressEnd = -1
      speaking = false
    }
    if (start < 0) start = index
  })
  if (start >= 0) out.push({ start, progressEnd: progressEnd < 0 ? rows.length : progressEnd, end: rows.length })
  return out
}

/** A group of one call with something to say is drawn as that call's row, not as a count. */
export function singleTool(items: StepItem[]): ToolPart | undefined {
  if (items.length !== 1) return undefined
  const only = items[0]!
  if (only.kind !== "tool") return undefined
  return stepTitle(only.part) || stepState(only.part) === "running" ? only.part : undefined
}

/**
 * The counts in a group's summary line, in the order each kind first appears.
 *
 * Reads and edits count the files they touched, so reading one file three
 * times is one file; commands, searches and anything else count calls.
 */
export function groupSummary(items: StepItem[]): { bucket: Bucket; count: number }[] {
  const tools = items.flatMap((item) => (item.kind === "tool" ? [item.part] : []))
  if (!tools.length) return [{ bucket: "other", count: Math.max(1, items.length) }]
  const order: Bucket[] = []
  const calls = new Map<Bucket, number>()
  const files = new Map<Bucket, string[]>()
  for (const part of tools) {
    const bucket = bucketOf(part.name)
    if (!order.includes(bucket)) order.push(bucket)
    const key = bucket === "read" || bucket === "edit" ? fileKey(part) : ""
    if (key) files.set(bucket, [...(files.get(bucket) ?? []), key])
    else calls.set(bucket, (calls.get(bucket) ?? 0) + 1)
  }
  return order.map((bucket) => ({ bucket, count: distinctFiles(files.get(bucket) ?? []).length + (calls.get(bucket) ?? 0) }))
}

/**
 * Which file a read or an edit touched, for counting files in a summary.
 *
 * The row's title is not it: the server writes a title (the path from the
 * project) only for a call that went through, so a failed edit of a file shows
 * the path as the model wrote it and the retry that worked shows the other
 * spelling - one file counted as two. The path the call was given is the same
 * on both, with its slashes made alike. A call with no path of its own (a
 * patch) is told apart by its title.
 */
function fileKey(part: ToolPart): string {
  const input = part.input ?? {}
  for (const name of ["path", "filePath", "file_path", "notebook_path"]) {
    const value = input[name]
    if (typeof value === "string" && value.trim()) return spelled(value)
  }
  return spelled(stepTitle(part))
}

/** A path with its slashes made alike, a leading "./" dropped and its case folded (macOS and Windows do not tell Foo.ts from foo.ts). */
const spelled = (path: string) => path.trim().replace(/[\\/]+/g, "/").replace(/^\.\//, "").toLowerCase()

const isAbsolutePath = (path: string) => path.startsWith("/") || /^[a-z]:\//.test(path)

/**
 * Whether two spellings name one file: the same, or an absolute path and a
 * path from the project that it ends with. Two relative paths never merge, so
 * `a.ts` and `lib/a.ts` stay two files.
 */
function sameFile(a: string, b: string): boolean {
  if (a === b) return true
  if (isAbsolutePath(a) === isAbsolutePath(b)) return false
  const [absolute, relative] = isAbsolutePath(a) ? [a, b] : [b, a]
  return absolute.endsWith(`/${relative}`)
}

/** The files that `keys` name, a file spelled in two ways counted once. */
function distinctFiles(keys: string[]): string[] {
  const found: string[] = []
  for (const key of keys) {
    const at = found.findIndex((entry) => sameFile(entry, key))
    // Keep the absolute spelling: it is the one a later relative one is matched against.
    if (at < 0) found.push(key)
    else if (isAbsolutePath(key)) found[at] = key
  }
  return found
}

/** A failed call or an error inside the group; a skipped or refused call is not a failure. */
export function groupFailed(items: StepItem[]): boolean {
  return items.some((item) => item.kind === "error" || (item.kind === "tool" && stepState(item.part) === "error"))
}
