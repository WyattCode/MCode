import type { Message, SessionInfo, ToolPart } from "@shared/protocol"
import { subagentAnswer } from "@shared/subagent"
import { stepState } from "./tool-meta"

/**
 * subagents: how the transcript and the 子智能体 tab read a conversation's task
 * calls, as MiMo reads its actor steps. Pure, so it can be checked on its own.
 */

/** A task call MiMo draws as a pill: one working or done. Any other state is an ordinary step row. */
export function isPill(part: ToolPart): boolean {
  // A call Stop cut off settles as done in the transcript, but it did not finish: it stays a row.
  if (part.name !== "task" || part.metadata?.aborted === true) return false
  const state = stepState(part)
  return state === "running" || state === "completed"
}

/** The words after the pills: 已完成 once every one of them is done, 开始工作 before that. */
export type PillStatus = "started" | "completed"

export function pillStatus(parts: readonly ToolPart[]): PillStatus {
  return parts.length > 0 && parts.every((part) => stepState(part) === "completed") ? "completed" : "started"
}

/** A subagent's state in the tab, in MiMo's five words: 处理中 / 已完成 / 失败 / 已取消 / 已跳过. */
export type SubagentStatus = "running" | "completed" | "error" | "rejected" | "skipped"

export interface SubagentItem {
  /** The task call's id, which is what a pill opens the tab on. */
  key: string
  /** Its own conversation, once the server has made one. */
  sessionID?: string
  /** What picks the avatar: its numbered name, or the call id before it has one. */
  seed: string
  name: string
  summary: string
  status: SubagentStatus
  startedAt?: number
  endedAt?: number
}

/* A call cut off by Stop reads as cancelled, as MiMo's cancelled outcome does. */
export function subagentStatus(part: ToolPart): SubagentStatus {
  const state = stepState(part)
  if (state === "error" && part.metadata?.aborted === true) return "rejected"
  return state
}

/** The subagent a task call started, found by the call rather than the parent, so a branch still finds it. */
export function childFor(callID: string, children: readonly SessionInfo[]): SessionInfo | undefined {
  return children.find((session) => session.parentCallID === callID)
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "")

/** Every task call in a conversation, working ones first, then newest first. */
export function subagentItems(messages: readonly Message[], children: readonly SessionInfo[]): SubagentItem[] {
  const out: SubagentItem[] = []
  for (const message of messages) {
    if (message.role !== "assistant") continue
    for (const part of message.parts) {
      if (part.type !== "tool" || part.name !== "task") continue
      const child = childFor(part.callID, children)
      const status = subagentStatus(part)
      // Refused for its arguments before anything started: there is nothing to open.
      if (!child && status === "skipped") continue
      const name = text(part.input?.description) || child?.title || ""
      const summary = status === "completed" ? subagentAnswer(part.output) : status === "running" ? name : (part.error ?? "")
      out.push({
        key: part.callID,
        sessionID: child?.id,
        seed: child?.subagent?.id ?? part.callID,
        name,
        summary,
        status,
        startedAt: part.time.started ?? part.time.created,
        endedAt: status === "running" ? undefined : part.time.completed,
      })
    }
  }
  return out.sort((a, b) => Number(a.status !== "running") - Number(b.status !== "running") || (b.startedAt ?? 0) - (a.startedAt ?? 0))
}

/** MiMo's time column: seconds since it started while it works, else how long ago it ended. */
export function subagentTime(item: SubagentItem, now: number): { key: string; count?: number } {
  if (item.status === "running") {
    if (item.startedAt === undefined) return { key: "subagents.status.running" }
    return { key: "subagents.seconds", count: Math.max(0, Math.floor((now - item.startedAt) / 1000)) }
  }
  if (item.endedAt === undefined) return { key: `subagents.status.${item.status}` }
  const seconds = Math.max(0, Math.floor((now - item.endedAt) / 1000))
  if (seconds < 60) return { key: "subagents.justNow" }
  if (seconds < 3600) return { key: "subagents.minutesAgo", count: Math.floor(seconds / 60) }
  return { key: "subagents.hoursAgo", count: Math.floor(seconds / 3600) }
}

/** The completed group shows ten until 查看全部 is pressed. */
export const COMPLETED_CAP = 10
