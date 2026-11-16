import type { Message, SessionInfo } from "@shared/protocol"
import { contextCount } from "./overflow"

export const MEMORY_FLUSH_RATIO = 0.8
export const MEMORY_FLUSH_PROMPT = `Silently write durable session notes before compaction. Do not answer the user, continue work, or call tools.
Return only JSON with these string-array fields: goals, constraints, decisions, files, lastAction, nextSteps.
Preserve exact paths and unfinished requests. Distinguish completed actions from plans. Use empty arrays for unknown facts. Keep each field under 1500 characters.`

export type CompactionNotes = Record<"goals" | "constraints" | "decisions" | "files" | "lastAction" | "nextSteps", string[]>
const fields = ["goals", "constraints", "decisions", "files", "lastAction", "nextSteps"] as const

export function parseCompactionNotes(text: string): CompactionNotes | undefined {
  try {
    const value = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim())
    if (!value || fields.some((key) => !Array.isArray(value[key]) || value[key].some((item: unknown) => typeof item !== "string"))) return undefined
    if (!fields.some((key) => value[key].some((item: string) => item.trim()))) return undefined
    return Object.fromEntries(fields.map((key) => [key, value[key].join("\n").slice(0, 1500).split("\n").filter(Boolean)])) as CompactionNotes
  } catch {
    return undefined
  }
}

export function shouldFlushMemory(session: Pick<SessionInfo, "compactionMemory" | "compacted">, history: Message[], window: number, force: boolean): boolean {
  if (session.compactionMemory?.epoch === (session.compacted?.messageID ?? "")) return false
  if (force) return true
  if (window <= 0) return false
  const last = [...history].reverse().find((message) => message.role === "assistant" && message.usage)
  return last?.role === "assistant" && !!last.usage && contextCount(last.usage) >= window * MEMORY_FLUSH_RATIO
}

export function memoryText(notes: CompactionNotes): string {
  return fields.map((key) => `### ${key}\n${notes[key].map((item) => `- ${item}`).join("\n") || "(unknown)"}`).join("\n\n")
}
