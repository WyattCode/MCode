import type { AssistantMessage, AssistantPart, Message, ToolPart } from "@shared/protocol"

/**
 * What the model is told about the turn it is in, beside the conversation
 * itself, in MCode's own words. MiMo wraps such notes in a system-reminder
 * tag inside a user message; the tag is kept so a model reads them the same
 * way.
 */

/** MiMo's doom-loop threshold: this many identical calls in a row put a question to the user. */
export const LOOP_THRESHOLD = 3

/** The answers the repeated-call question takes; anything else typed is feedback, and refuses. */
export const LOOP_ANSWERS = { once: "once", always: "always", reject: "reject" } as const

/**
 * Whether this call is the third in a row with the same tool and input among
 * the last parts of its reply. Any other part in between breaks the run, as it
 * does in MiMo; the earlier two must already have been started.
 */
export function repeatsCall(parts: readonly AssistantPart[], call: ToolPart): boolean {
  const at = parts.indexOf(call)
  if (at < LOOP_THRESHOLD - 1) return false
  const run = parts.slice(at - LOOP_THRESHOLD + 1, at + 1)
  const input = JSON.stringify(call.input ?? {})
  return run.every(
    (part) => part.type === "tool" && part.name === call.name && (part === call || part.status !== "pending") && JSON.stringify(part.input ?? {}) === input,
  )
}

/** One step's calls as a signature: each call's name and its input with keys sorted. */
function signature(message: AssistantMessage): string {
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])]))
        : value
  return message.parts
    .filter((part): part is ToolPart => part.type === "tool")
    .map((part) => `${part.name}:${JSON.stringify(stable(part.input ?? {}))}`)
    .join("|")
}

const SAME_STEPS = [
  "Your last three steps made exactly the same tool calls with the same arguments, and repeating them again will not change the result.",
  "Change your approach, or stop and tell the user plainly what is blocking you.",
].join(" ")

/**
 * MiMo's same-steps note: when the last three finished steps each made the
 * very same calls, the latest user message carries a note to change approach.
 * Request only, and never twice.
 */
export function withSameStepsNote(history: Message[]): Message[] {
  const signatures: string[] = []
  for (let index = history.length - 1; index >= 0 && signatures.length < LOOP_THRESHOLD; index--) {
    const message = history[index]!
    if (message.role !== "assistant") continue
    if (message.finish === undefined && message.time.completed === undefined) continue
    const sig = signature(message)
    if (!sig) break
    signatures.push(sig)
  }
  if (signatures.length < LOOP_THRESHOLD || signatures.some((sig) => sig !== signatures[0])) return history
  const target = history.map((message) => message.role).lastIndexOf("user")
  if (target < 0) return history
  const note = reminder(SAME_STEPS)
  return history.map((message, index) =>
    index === target && message.role === "user" && !message.text.includes(SAME_STEPS) ? { ...message, text: `${message.text}\n\n${note}` } : message,
  )
}

export function reminder(body: string): string {
  return `<system-reminder>\n${body.trim()}\n</system-reminder>`
}

/**
 * MiMo's framing of messages sent while a turn is working: from the second
 * step of a turn on, every user message newer than the last finished reply
 * reaches the model inside a note saying the user sent it mid-task and that it
 * should be dealt with before carrying on. Request only - the transcript keeps
 * the words as typed.
 */
export function frameSteered(history: Message[]): Message[] {
  let finished = -1
  history.forEach((message, index) => {
    if (message.role === "assistant" && (message.finish !== undefined || message.time.completed !== undefined)) finished = index
  })
  if (finished < 0) return history
  return history.map((message, index) => {
    if (index <= finished || message.role !== "user" || !message.text.trim()) return message
    return {
      ...message,
      text: reminder(
        [
          "The user sent this message while you were working on the task:",
          "",
          message.text,
          "",
          "Take it into account now - answer it or change course as it asks - and then carry on with the work.",
        ].join("\n"),
      ),
    }
  })
}
