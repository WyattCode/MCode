import type { PermissionRequest, QuestionAnswer, QuestionPrompt, QuestionRequest } from "@shared/protocol"
import { PERMISSION_KINDS } from "@shared/protocol"

/**
 * The rules behind the dock above the composer, kept apart from the components
 * so they can be checked without a window.
 *
 * MiMo holds permission and question requests in one list and shows the first
 * one still undecided, whatever its kind; `1/N` counts both.
 */
export type ConfirmItem =
  | { kind: "permission"; id: string; time: number; request: PermissionRequest }
  | { kind: "question"; id: string; time: number; request: QuestionRequest }

/** A session's undecided requests of both kinds, oldest first. */
export function confirmQueue(
  sessionID: string | undefined,
  permissions: readonly PermissionRequest[],
  questions: Iterable<QuestionRequest>,
  /* subagents: which sessions' requests this conversation's dock takes - its own and its subagents'. */
  belongs: (requestSession: string) => boolean = (requestSession) => requestSession === sessionID,
): ConfirmItem[] {
  if (!sessionID) return []
  const items: ConfirmItem[] = []
  for (const request of permissions) {
    if (belongs(request.sessionID)) items.push({ kind: "permission", id: request.id, time: request.time, request })
  }
  for (const request of questions) {
    if (belongs(request.sessionID)) items.push({ kind: "question", id: request.id, time: request.time ?? 0, request })
  }
  // A stable sort, so two requests stamped in the same millisecond keep their arrival order.
  return items.sort((a, b) => a.time - b.time)
}

/** Text sent from the composer answers question one and leaves the rest empty (MiMo's `Wpe`). */
export function composerAnswers(text: string, count: number): QuestionAnswer[] | undefined {
  const trimmed = text.trim()
  if (!trimmed || count <= 0) return undefined
  return Array.from({ length: count }, (_, index) => (index === 0 ? [trimmed] : []))
}

/** A click on an option: multi choice toggles it, single choice picks it or clears it again. */
export function toggleChoice(chosen: readonly string[], label: string, multiple: boolean): string[] {
  if (multiple) return chosen.includes(label) ? chosen.filter((item) => item !== label) : [...chosen, label]
  return chosen[0] === label ? [] : [label]
}

/** The reply: chosen labels, with typed text appended unless it is one of them already. */
export function mergeCustom(chosen: readonly (readonly string[])[], custom: readonly string[]): QuestionAnswer[] {
  return chosen.map((labels, index) => {
    const typed = (custom[index] ?? "").trim()
    return typed && !labels.includes(typed) ? [...labels, typed] : [...labels]
  })
}

/** Whether one question has something to send. A question with no options counts as answered. */
export function isAnswered(prompt: QuestionPrompt, chosen: readonly string[] | undefined, custom: string | undefined): boolean {
  return prompt.options.length === 0 || (chosen?.length ?? 0) > 0 || Boolean((custom ?? "").trim())
}

/** Where advancing goes: the next page, else the first question still open, else submit. */
export function nextStop(done: readonly boolean[], index: number): number | "submit" {
  if (index < done.length - 1) return index + 1
  const open = done.findIndex((entry) => !entry)
  return open === -1 ? "submit" : open
}

/** Approvals given by hand in one task before MiMo offers to ask less (its `vD`). */
export const GUIDE_AFTER = 3

/** One session's guide: hand approvals so far, whether it was waved off, and whether the task is allowed. */
export interface GuideState {
  allowCount: number
  dismissed: boolean
  taskAllowOn: boolean
}

export function freshGuide(): GuideState {
  return { allowCount: 0, dismissed: false, taskAllowOn: false }
}

export type Access = "ask" | "auto" | "full"

/** The access level, read the way the composer's chip reads it. */
export function accessOf(config: { accessLevel?: string; permissions?: Readonly<Record<string, string>> } | undefined): Access {
  if (config?.accessLevel === "auto") return "auto"
  const map = config?.permissions
  if (!map) return "ask"
  return PERMISSION_KINDS.some((kind) => map[kind] === "ask") ? "ask" : "full"
}

/*
 * MiMo's rule (`Mge`): only over a permission card, never a delete, only at the
 * default level, not while the task is allowed or once waved off, and only
 * after enough approvals by hand.
 */
export function guideShown(state: GuideState, access: Access, kind: ConfirmItem["kind"] | undefined, forced: boolean): boolean {
  if (kind !== "permission" || forced || access !== "ask" || state.taskAllowOn || state.dismissed) return false
  return state.allowCount >= GUIDE_AFTER
}

/** How a question call ended, as MiMo decides it: anything chosen is answered, nothing is a cancel. */
export function questionOutcome(part: { status: string; metadata?: Record<string, unknown> }): "pending" | "answered" | "cancelled" {
  if (part.status === "pending" || part.status === "running") return "pending"
  if (part.status !== "completed") return "cancelled"
  const answers = part.metadata?.answers
  const any = Array.isArray(answers) && answers.some((entry) => Array.isArray(entry) && entry.some((value) => String(value).trim()))
  return any ? "answered" : "cancelled"
}
