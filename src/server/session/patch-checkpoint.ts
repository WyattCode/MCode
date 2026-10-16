import type { AssistantMessage, Message, ToolPart } from "../../shared/protocol"
import { reminder } from "./reminders"

const CHECKPOINT_MARKER = "Checkpoint: you have identified the fix"
const CHECKPOINT_NOTE = [
  "Checkpoint: you have identified the fix but nothing has been changed on disk yet.",
  "In your next reply, apply it with the edit tool (exact old_string/new_string from the file you read), then run the failing test.",
  "If something blocks the change, say what in one line instead.",
].join(" ")

const EDIT_TOOLS = new Set(["edit", "write", "multiedit", "patch", "apply_patch"])
const FIX_INTENT = /\b(fix|change|replace|should be|instead of|the bug|is wrong|patch)\b/i

function lastUserIndex(history: readonly Message[]): number {
  for (let index = history.length - 1; index >= 0; index--) {
    if (history[index]?.role === "user") return index
  }
  return -1
}

function isFinishedAssistant(message: Message): message is AssistantMessage {
  return message.role === "assistant" && (message.finish !== undefined || message.time.completed !== undefined)
}

function assistantText(message: AssistantMessage): string {
  return message.parts
    .filter((part) => part.type === "text" || part.type === "reasoning")
    .map((part) => (part.type === "text" || part.type === "reasoning" ? part.text : ""))
    .join("\n")
}

function toolParts(messages: readonly Message[]): ToolPart[] {
  return messages.flatMap((message) =>
    message.role === "assistant" ? message.parts.filter((part): part is ToolPart => part.type === "tool") : [],
  )
}

function isCompletedTool(part: ToolPart): boolean {
  const status = (part as { status?: string }).status
  if (status === "completed" || status === "done" || status === "success") return true
  if (status === "error" || status === "failed") return false
  return (part as { time?: { completed?: unknown } }).time?.completed !== undefined
}

function toolOutputText(part: ToolPart): string {
  const output = (part as { output?: unknown }).output
  if (typeof output === "string") return output
  if (output === undefined || output === null) return ""
  try {
    return JSON.stringify(output)
  } catch {
    return String(output)
  }
}

function outputStartsWithError(part: ToolPart): boolean {
  const status = (part as { status?: string }).status
  if (status === "error" || status === "failed") return true
  return toolOutputText(part).trimStart().toLowerCase().startsWith("error")
}

function hasCompletedEdit(parts: readonly ToolPart[]): boolean {
  return parts.some((part) => EDIT_TOOLS.has(part.name) && isCompletedTool(part) && !outputStartsWithError(part))
}

function readPath(part: ToolPart): string | undefined {
  const input = part.input as Record<string, unknown> | undefined
  if (!input) return undefined
  for (const key of ["file_path", "filePath", "path"]) {
    const value = input[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

function readPaths(parts: readonly ToolPart[]): string[] {
  return parts
    .filter((part) => part.name === "read" && isCompletedTool(part) && !outputStartsWithError(part))
    .map(readPath)
    .filter((path): path is string => Boolean(path))
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

function mentionsReadPath(text: string, paths: readonly string[]): boolean {
  return paths.some((path) => text.includes(path) || text.includes(basename(path)))
}

function hasFixIntent(text: string, paths: readonly string[]): boolean {
  if (!mentionsReadPath(text, paths)) return false
  return text.includes("```") || FIX_INTENT.test(text)
}

function stepThreshold(): number {
  const raw = process.env.MCODE_PATCH_CHECKPOINT_STEPS
  if (!raw) return 10
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10
}

function occurrences(text: string, marker: string): number {
  if (!text.includes(marker)) return 0
  return text.split(marker).length - 1
}

function countMarker(messages: readonly Message[]): number {
  let count = 0
  for (const message of messages) {
    const text =
      message.role === "user"
        ? message.text
        : message.role === "assistant"
          ? assistantText(message)
          : ""
    count += occurrences(text, CHECKPOINT_MARKER)
    for (const note of (message as { reminders?: string[] }).reminders ?? []) {
      count += occurrences(note, CHECKPOINT_MARKER)
    }
  }
  return count
}

/**
 * A narrow checkpoint for local runs where the model has diagnosed a fix but
 * has not written anything to disk. It is not generic pacing pressure: it only
 * fires when the latest finished reply names a file that was actually read in
 * this turn and shows concrete fix intent.
 */
export function withPatchCheckpoint(history: Message[], opts: { local: boolean }): Message[] {
  if (!opts.local) return history
  if (process.env.MCODE_PATCH_CHECKPOINT === "0") return history

  const at = lastUserIndex(history)
  if (at < 0) return history

  const target = history[at]
  if (!target || target.role !== "user") return history

  const turn = history.slice(at + 1)
  const finished = turn.filter(isFinishedAssistant)
  const steps = finished.length
  const threshold = stepThreshold()
  if (steps < threshold) return history

  const parts = toolParts(turn)
  if (hasCompletedEdit(parts)) return history

  const latest = finished[finished.length - 1]
  if (!latest) return history

  const text = assistantText(latest)
  const paths = readPaths(parts)
  if (!hasFixIntent(text, paths)) return history

  const fired = countMarker(history.slice(at))
  if (fired >= 2) return history
  if (fired === 1 && steps < threshold * 2) return history

  const note = reminder(CHECKPOINT_NOTE)
  const next = history.slice()
  const reminders = [...((target as { reminders?: string[] }).reminders ?? []), note]
  next[at] = { ...target, reminders } as Message
  return next
}
