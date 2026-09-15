import type { Message } from "@shared/protocol"

/**
 * automation: what the model is told when a turn is a scheduled task's run, in
 * the request only. MiMo adds a hidden note of this kind to every run; this is
 * this app's own wording of what the note asks for.
 */
export const AUTOMATION_RUN_NOTE = [
  "[Scheduled task run] This turn carries out a scheduled task the user saved earlier. It is not a request to create, change or reschedule that task.",
  "Do the task now and reply with the result. Leave out task-creation status, schedule details and setup advice unless the saved task itself asks for them.",
  "Only use automation_update when the saved task explicitly asks to list, look at, create, change, pause, resume or delete scheduled tasks; words like reminder, daily or schedule alone do not.",
  "For a reminder, keep the facts and constraints but say it naturally rather than repeating the task's wording; keep exact or quoted wording only when the task asks for it.",
].join("\n")

/** The history a model is sent, with each scheduled run's message carrying the note. */
export function withAutomationNotes(history: Message[]): Message[] {
  return history.map((message) => (message.role === "user" && message.inbox?.automationID ? { ...message, text: `${AUTOMATION_RUN_NOTE}\n\n${message.text}` } : message))
}
