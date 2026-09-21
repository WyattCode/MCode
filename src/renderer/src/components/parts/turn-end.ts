import type { AssistantPart, Message } from "@shared/protocol"
import { turnOpeners } from "@shared/steer"

/*
 * How a turn ends on screen, as MiMo draws it, kept apart from the components
 * so it can be checked without a window.
 */

/*
 * A part as MiMo's steps show it. Reasoning is emptied: MiMo draws none and
 * skips it when it builds steps, so a run of tools either side stays one
 * group. A tool Stop cut off settles as done rather than failed, and so does
 * one a finished turn left running, as MiMo's settle does.
 */
export function stepPart(part: AssistantPart, live: boolean): AssistantPart {
  if (part.type === "reasoning") return part.text ? { ...part, text: "" } : part
  if (part.type !== "tool") return part
  if (part.status === "error" && part.metadata?.aborted === true) {
    return { ...part, status: "completed", error: undefined, errorCode: undefined }
  }
  if (!live && (part.status === "running" || part.status === "pending")) return { ...part, status: "completed" }
  return part
}

/* A stop that got nothing out: MiMo's 已停止（耗时 12s） line and its retry. A stop after output ends on its action row alone. */
export function stoppedEmpty(turn: { finish?: string; error?: string; parts: AssistantPart[] }): boolean {
  if (turn.finish !== "aborted" || turn.error) return false
  return !turn.parts.some((part) => part.type === "tool" || part.text.trim())
}

/*
 * A turn the app died in the middle of: a reply was started, no finish was ever
 * written, and nothing is running now that could write one.
 *
 * MiMo draws a line for this case (harnessRow.aborted). MCode drew nothing at
 * all - the failure card wants an error, the empty-reply line and the stopped
 * line both want a finish - so the reply simply stopped mid-sentence, and the
 * only hint was the 继续 button appearing in the box.
 */
export function interruptedEnd(turn: { finish?: string; error?: string; last?: unknown }, live: boolean): boolean {
  return !live && turn.finish === undefined && !turn.error && turn.last !== undefined
}

/*
 * The failure card's words, cut as MiMo cuts them: text carrying its 原始错误
 * marker loses everything from there, and past 600 characters or 6 lines only
 * the first 600 stay, with an ellipsis, under a height cap. Undefined when
 * nothing is left to say.
 */
export const RAW_MARK = "\n\n原始错误："
export const CARD_CHARS = 600
export const CARD_LINES = 6

export function cardCut(said: string): { text: string; clamped: boolean } | undefined {
  const marked = said.indexOf(RAW_MARK)
  const text = (marked >= 0 ? said.slice(0, marked) : said).trim()
  if (!text) return undefined
  if (marked < 0 && (text.length > CARD_CHARS || text.split("\n").length > CARD_LINES)) {
    return { text: `${text.slice(0, CARD_CHARS).trim()}…`, clamped: true }
  }
  return { text, clamped: false }
}

/*
 * The latest turn's parts: everything after the message that opened it. A steer
 * the model has taken opens a turn (MiMo 26.914); one still waiting does not.
 */
export function latestTurnParts(messages: readonly Message[], settled: boolean): AssistantPart[] {
  const openers = turnOpeners(messages, settled)
  const parts: AssistantPart[] = []
  for (let at = messages.length - 1; at >= 0; at--) {
    const message = messages[at]!
    if (message.role === "assistant") parts.unshift(...message.parts)
    else if (openers.has(message.id)) break
  }
  return parts
}
