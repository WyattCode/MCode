import type { Message } from "@shared/protocol"

/**
 * What the model is told about the turn it is in, beside the conversation
 * itself, in MCode's own words. MiMo wraps such notes in a system-reminder
 * tag inside a user message; the tag is kept so a model reads them the same
 * way.
 */

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
