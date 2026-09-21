/**
 * cron: the words a fired scheduled prompt carries in its conversation.
 *
 * Shared because two sides read them: the backend writes a fired prompt this
 * way, and the window has to recognise one as a turn it did not send, so it can
 * show the turn working, time it and notify when it ends.
 */

const SCHEDULED = /^\[Scheduled (cron|loop) [0-9a-f]{8} · \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\] /

export function scheduledPromptText(kind: "cron" | "loop", id: string, at: number, prompt: string): string {
  return `[Scheduled ${kind} ${id} · ${new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z")}] ${prompt}`
}

export function isScheduledPrompt(text: string): boolean {
  return SCHEDULED.test(text)
}
