import type { Message, SessionInfo, SubagentNotice, SubagentNoticeStatus, ToolPart } from "@shared/protocol"
import { actorAction, actorTarget, answerSummary, launches, operationInput, subagentAnswer, type SubagentAction } from "@shared/subagent"
import { stepState } from "./tool-meta"

/**
 * subagents: how the transcript and the 子智能体 tab read a conversation's actor
 * calls and the notices its background subagents send back, as MiMo reads its
 * actor steps and actor notifications. Pure, so it can be checked on its own.
 */

export function actionOf(part: ToolPart): SubagentAction {
  return actorAction(part.input)
}

/** An actor call MiMo draws as a pill: a run or spawn, working or done. Any other call, or state, is an ordinary step row. */
export function isPill(part: ToolPart): boolean {
  // A call Stop cut off settles as done in the transcript, but it did not finish: it stays a row.
  if (part.name !== "actor" || part.metadata?.aborted === true || !launches(actionOf(part))) return false
  const state = stepState(part)
  return state === "running" || state === "completed"
}

/** The words after the pills, MiMo's six: 开始工作 / 已完成 / 失败 / 已取消 / 可能停滞 / 已结束. */
export type PillStatus = "started" | SubagentNoticeStatus

/**
 * 已完成 once every pill is a run that has answered; a spawn only started its
 * subagent, so it reads 开始工作. Runs whose subagent was stopped read 已取消.
 */
export function pillStatus(parts: readonly ToolPart[]): PillStatus {
  const answered = parts.length > 0 && parts.every((part) => actionOf(part) === "run" && stepState(part) === "completed")
  if (answered && parts.every((part) => part.metadata?.cancelled === true)) return "cancelled"
  return answered && !parts.some((part) => part.metadata?.cancelled === true) ? "completed" : "started"
}

/** Notices drawn together share their word when they agree, and read 已结束 when they do not. */
export function noticeStatus(notices: readonly SubagentNotice[]): PillStatus {
  const first = notices[0]?.status
  return first && notices.every((notice) => notice.status === first) ? first : "ended"
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
  // A run whose subagent was stopped some other way answers that it was cancelled.
  if (state === "completed" && part.metadata?.cancelled === true) return "rejected"
  // A spawn that went through only started its subagent: it is at work until something says otherwise.
  if (state === "completed" && actionOf(part) === "spawn") return "running"
  return state
}

/* MiMo's mapping from a notice to the tab: a stall is still work, an ending without a word is skipped. */
const NOTICED: Record<SubagentNoticeStatus, SubagentStatus> = {
  completed: "completed",
  failed: "error",
  cancelled: "rejected",
  stalled: "running",
  ended: "skipped",
}

/* The subagent's own record, for one still marked working: MiMo's poll of its actors, from the session instead. */
function recorded(state: SessionInfo["subagent"]): SubagentStatus | undefined {
  if (!state?.status || state.status === "running") return undefined
  if (state.outcome === "failure") return "error"
  if (state.outcome === "cancelled") return "rejected"
  return state.outcome === "success" ? "completed" : undefined
}

/** The subagent an actor call started, found by the call rather than the parent, so a branch still finds it. */
export function childFor(callID: string, children: readonly SessionInfo[]): SessionInfo | undefined {
  return children.find((session) => session.parentCallID === callID)
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "")

/** Every subagent a conversation started, working ones first, then the most recent first. */
export function subagentItems(messages: readonly Message[], children: readonly SessionInfo[]): SubagentItem[] {
  const out: SubagentItem[] = []
  const bySession = new Map<string, SubagentItem>()
  for (const message of messages) {
    if (message.role === "user") {
      for (const notice of message.notices ?? []) {
        const item = bySession.get(notice.sessionID)
        if (!item) continue
        item.status = NOTICED[notice.status]
        item.summary = notice.summary?.trim() || item.summary || notice.description
        item.endedAt = item.status === "running" ? item.endedAt : message.time.created
      }
      continue
    }
    for (const part of message.parts) {
      if (part.type !== "tool" || part.name !== "actor" || !launches(actionOf(part))) continue
      const child = childFor(part.callID, children)
      const status = subagentStatus(part)
      // Refused for its arguments before anything started: there is nothing to open.
      if (!child && status === "skipped") continue
      const name = text(operationInput(part.input).description) || child?.title || ""
      const summary = status === "completed" ? answerSummary(subagentAnswer(part.output)) : status === "running" ? name : (part.error ?? subagentAnswer(part.output))
      const item: SubagentItem = {
        key: part.callID,
        sessionID: child?.id,
        seed: child?.subagent?.id ?? part.callID,
        name,
        summary,
        status,
        startedAt: part.time.started ?? part.time.created,
        endedAt: status === "running" ? undefined : part.time.completed,
      }
      out.push(item)
      if (child) bySession.set(child.id, item)
    }
  }
  for (const item of out) {
    if (item.status !== "running" || !item.sessionID) continue
    const state = children.find((session) => session.id === item.sessionID)?.subagent
    const status = recorded(state)
    if (!status) continue
    item.status = status
    item.endedAt = state?.ended ?? item.endedAt
  }
  return out.sort((a, b) => Number(a.status !== "running") - Number(b.status !== "running") || (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0))
}

/** What a status, wait, cancel or send row names: the subagent's description once the call reports it, else its id. */
export function targetOf(part: ToolPart): string {
  return text(part.title) || actorTarget(part.input)
}

/**
 * MiMo's time column: seconds since it started while it works, else how long
 * ago it ended - in the app's one relative-time family, so this column and the
 * side column never spell the same moment two ways.
 */
export function subagentTime(item: SubagentItem, now: number): { key: string; n?: number } {
  if (item.status === "running") {
    if (item.startedAt === undefined) return { key: "subagents.status.running" }
    return { key: "subagents.seconds", n: Math.max(0, Math.floor((now - item.startedAt) / 1000)) }
  }
  if (item.endedAt === undefined) return { key: `subagents.status.${item.status}` }
  const seconds = Math.max(0, Math.floor((now - item.endedAt) / 1000))
  if (seconds < 60) return { key: "time.justNow" }
  if (seconds < 3600) return { key: "time.minutesAgo", n: Math.floor(seconds / 60) }
  return { key: "time.hoursAgo", n: Math.floor(seconds / 3600) }
}

/** The completed group shows ten until 查看全部 is pressed. */
export const COMPLETED_CAP = 10
