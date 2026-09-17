import type { Message, UserMessage } from "./protocol"

/**
 * Where a conversation's turns begin, as MiMo 26.914 lays them out.
 *
 * Every user message opens a turn, with two exceptions. News of background
 * subagents that reached a running turn stays inside it. And a message typed
 * into a running turn (a steer) that the model has not taken yet waits at the
 * end of that turn; once an assistant message follows it - the model has read
 * it - it is a question like any other and the turn before it is over. With no
 * turn running nothing is waiting any more, so an untaken steer reads as the
 * question it is: the model gets it with whatever is asked next.
 *
 * The runner files its undo recordings on the same boundaries, so rolling back
 * to a steer takes back only the turn it opened.
 */
export function opensTurn(message: UserMessage, taken: boolean, settled: boolean): boolean {
  if (!message.steered) return true
  if (message.notices?.length) return false
  return taken || settled
}

/** The ids of the user messages that open a turn. `settled`: no turn is running in this conversation. */
export function turnOpeners(messages: readonly Message[], settled: boolean): Set<string> {
  const out = new Set<string>()
  let taken = false
  for (let at = messages.length - 1; at >= 0; at--) {
    const message = messages[at]!
    if (message.role === "assistant") {
      taken = true
      continue
    }
    if (opensTurn(message, taken, settled)) out.add(message.id)
  }
  return out
}
