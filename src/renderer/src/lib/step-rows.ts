import type { AssistantPart, PermissionRecord, ReasoningPart, TextPart, ToolPart } from "@shared/protocol"
import { saysSomething } from "@shared/reply-clean"
import { bucketOf, permissionsOf, stepState, stepTitle, type Bucket } from "./tool-meta"

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

export type StepRow =
  | { kind: "part"; id: string; part: TextPart | ReasoningPart }
  | { kind: "question"; id: string; part: ToolPart }
  /** `actor`: a run of subagent calls, drawn flat or as one pill row rather than under a summary. */
  | { kind: "group"; id: string; items: StepItem[]; actor?: boolean }
  | { kind: "error"; id: string; error: InlineError }

/**
 * Why the reconnecting row is retrying, as one line: MiMo draws the reason the
 * retry carries after the attempt, and nothing when there is none.
 */
export function retryReason(message: string | undefined): string | undefined {
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
  const paths = new Map<Bucket, Set<string>>()
  for (const part of tools) {
    const bucket = bucketOf(part.name)
    if (!order.includes(bucket)) order.push(bucket)
    const title = bucket === "read" || bucket === "edit" ? stepTitle(part) : ""
    if (title) {
      const seen = paths.get(bucket) ?? new Set<string>()
      seen.add(title)
      paths.set(bucket, seen)
    } else {
      calls.set(bucket, (calls.get(bucket) ?? 0) + 1)
    }
  }
  return order.map((bucket) => ({ bucket, count: (paths.get(bucket)?.size ?? 0) + (calls.get(bucket) ?? 0) }))
}

/** A failed call or an error inside the group; a skipped or refused call is not a failure. */
export function groupFailed(items: StepItem[]): boolean {
  return items.some((item) => item.kind === "error" || (item.kind === "tool" && stepState(item.part) === "error"))
}
