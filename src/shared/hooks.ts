export const HOOK_EVENTS = ["PreToolUse", "PostToolUse"] as const
export type HookEvent = (typeof HOOK_EVENTS)[number]

export interface HookConfig {
  matcher: string
  command: string
  timeoutMs?: number
}

export type HooksConfig = Partial<Record<HookEvent, HookConfig[]>>
export type HookIssue = "document" | "events" | "event" | "list" | "entry" | "matcher" | "command" | "timeout" | "read" | "json"

export interface HookRow {
  source: string
  event?: string
  matcher?: string
  command?: string
  reason?: HookIssue
}

export interface HookGroup {
  scope: "global" | "plugin" | "project"
  name?: string
  rows: HookRow[]
}

export interface HooksListing {
  groups: HookGroup[]
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function validateHooks(value: unknown, source: string) {
  const rows: HookRow[] = []
  const events: Record<HookEvent, HookConfig[]> = { PreToolUse: [], PostToolUse: [] }
  if (value === undefined) return { rows, events }
  if (!object(value)) return { rows: [{ source, reason: "events" } satisfies HookRow], events }
  for (const [event, entries] of Object.entries(value)) {
    if (event !== "PreToolUse" && event !== "PostToolUse") {
      rows.push({ source, event, reason: "event" })
      continue
    }
    if (!Array.isArray(entries)) {
      rows.push({ source, event, reason: "list" })
      continue
    }
    for (const entry of entries) {
      const fields = object(entry) ? entry : {}
      const matcher = typeof fields.matcher === "string" ? fields.matcher : undefined
      const command = typeof fields.command === "string" ? fields.command : undefined
      const timeoutMs = fields.timeoutMs
      const row = { source, event, matcher, command }
      if (!object(entry)) rows.push({ ...row, reason: "entry" })
      else if (!matcher?.trim()) rows.push({ ...row, reason: "matcher" })
      else if (!command?.trim() || command.includes("\0")) rows.push({ ...row, reason: "command" })
      else if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)) {
        rows.push({ ...row, reason: "timeout" })
      } else {
        rows.push(row)
        events[event].push({ matcher, command, timeoutMs })
      }
    }
  }
  return { rows, events }
}

export function validateProjectHooks(value: unknown, source: string) {
  if (object(value)) return validateHooks(value.hooks, source)
  return { ...validateHooks(undefined, source), rows: [{ source, reason: "document" } satisfies HookRow] }
}
