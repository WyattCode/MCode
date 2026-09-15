import type { Message } from "./protocol"

/**
 * The user message whose turn broke off, if the conversation's last turn did.
 *
 * A turn broke off when its last reply was stopped, failed, or never finished
 * (the app quit mid-stream), or when nothing was written in reply at all. The
 * runner and the composer read it the same way, so the composer offers 继续
 * only for a turn the runner will accept. The caller rules out a turn that is
 * still running and passes the conversation as it stands, without anything
 * rolled back.
 */
export function interruptedTurn(messages: readonly Message[]): string | undefined {
  let asked = -1
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    if (messages[at].role === "user") {
      asked = at
      break
    }
  }
  if (asked < 0) return undefined
  const last = messages[messages.length - 1]
  // Nothing after the question: the turn never got as far as a reply.
  if (last === messages[asked]) return last.id
  if (last.role !== "assistant") return undefined
  const broke = last.finish === undefined || last.finish === "aborted" || last.finish === "error"
  return broke ? messages[asked].id : undefined
}
