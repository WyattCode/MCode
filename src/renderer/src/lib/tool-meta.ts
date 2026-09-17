import type { PermissionRecord, ToolPart } from "@shared/protocol"
import { SUBAGENT_ACTIONS, actorAction, actorTarget, operationInput } from "@shared/subagent"
import { t } from "./i18n"

/**
 * What a tool step is called and how it looks, as MiMo's step list decides it.
 *
 * Kept out of the components because the row, the group line above it and the
 * transcript's grouping all need the same answers, and a second copy of any of
 * these rules is a place for the two to disagree.
 */

/** A step's state on screen; the part's own status plus what its metadata says happened. */
export type StepState = "running" | "completed" | "error" | "rejected" | "skipped"

export type StepIconName =
  | "read"
  | "edit"
  | "write"
  | "bash"
  | "search"
  | "list"
  | "globe"
  | "todo"
  | "invalid"
  | "fallback"
  | "browser"
  | "fetch"
  | "permission"
  | "question"
  | "reconnect"
  | "alert"
  | "speaker"

/** How much of a title a row shows; a group of one shows a little more. */
export const ROW_TITLE_MAX = 90
export const SINGLE_TITLE_MAX = 120

/** MiMo cuts every output box at this many characters, silently. */
export const OUTPUT_CAP = 3000

/** The tools the tables name in every state. `apply_patch` speaks as an edit. */
// session chat: `contacts` is the one of its four tools MiMo's step tables name.
// memory: named in MiMo's tables; history, cron and automation_update are not, and read through the fallbacks.
// speak: MCode's own tool for the voice feedback MiMo does in the cloud, so its words are this app's.
const LABELLED = new Set(["read", "edit", "write", "bash", "grep", "glob", "list", "webfetch", "todowrite", "invalid", "actor", "pdf_locate", "present_files", "contacts", "skill", "skill_search", "memory", "speak"])
const SPEAKS_AS: Record<string, string> = { apply_patch: "edit", patch: "edit", multiedit: "edit" }

/** The tools this app ships, whose titles are their own rather than their input. */
const BUILT_IN = new Set([
  "read",
  "edit",
  "multiedit",
  "write",
  "apply_patch",
  "patch",
  "bash",
  "grep",
  "glob",
  "list",
  "webfetch",
  "todowrite",
  "question",
  "invalid",
  "pdf_locate",
  "present_files",
  "get_desktop_settings",
  "set_desktop_setting",
  "skill",
  "skill_search",
  "speak",
])

/** MiMo's title for a locate step: the start of the quoted passage. */
const LOCATE_TITLE_MAX = 60
/** MiMo's title for a present step: the files' names, cut at 80. */
const PRESENT_TITLE_MAX = 80

/** The fields a JSON title is reduced to, first one present wins. */
const TITLE_FIELDS = ["query", "description", "prompt", "path", "name", "pattern", "url", "command"]

export function permissionsOf(part: ToolPart): PermissionRecord[] {
  const raw = part.metadata?.permissions
  return Array.isArray(raw) ? (raw as PermissionRecord[]) : []
}

/*
 * Skipped is a call refused for its arguments before it ran; rejected is one a
 * person said no to (or stopped while it was asking). Both arrive as an error
 * part, which is what the model reads, and are told apart by what the runner
 * wrote beside it.
 */
export function stepState(part: ToolPart): StepState {
  if (part.status === "running" || part.status === "pending") return "running"
  if (part.status === "error") {
    if (part.metadata?.recoverable === true) return "skipped"
    const refused = permissionsOf(part).some(
      (record) => record.decided === "reject" || record.decided === "reject-with-reason" || record.decided === "cancelled",
    )
    return refused ? "rejected" : "error"
  }
  return "completed"
}

/** A tool's own word when the tables have one, otherwise its name as the server gave it. */
export function toolName(name: string): string {
  const key = `tool.${name}`
  const found = t(key)
  return found === key ? name : found
}

/** MiMo's verb for a step: 已读取 / 正在读取 / 读取失败 / 已拒绝读取 / 未执行：读取, or the fallbacks for any other tool. */
export function toolVerb(name: string, state: StepState): string {
  const known = SPEAKS_AS[name] ?? name
  const table = state === "completed" ? "done" : state
  if (LABELLED.has(known)) return t(`toolLabel.${table}.${known}`)
  if (state === "completed") return toolName(name)
  return t(`toolLabel.${state}Fallback`, { tool: toolName(name) })
}

/**
 * subagents: a row's verb, with MiMo's words for an actor call that named its
 * action - 检查子任务状态, 等待子任务, 向子任务发送消息 and so on. A spawn, a call
 * with no action, and one refused for its arguments keep the actor tool's own.
 */
export function stepVerb(part: ToolPart, state: StepState): string {
  const action = operationInput(part.input).action
  if (part.name === "actor" && state !== "skipped" && typeof action === "string" && action !== "spawn" && SUBAGENT_ACTIONS.some((known) => known === action)) {
    return t(`toolLabel.subagentAction.${action}.${state}`)
  }
  return toolVerb(part.name, state)
}

const ICONS: Record<string, StepIconName> = {
  read: "read",
  edit: "edit",
  multiedit: "edit",
  apply_patch: "edit",
  patch: "edit",
  write: "write",
  bash: "bash",
  exec_command: "bash",
  grep: "search",
  glob: "search",
  codesearch: "search",
  list: "list",
  webfetch: "globe",
  websearch: "globe",
  todowrite: "todo",
  invalid: "invalid",
  question: "question",
  // MiMo's desktop tools: a locate reads a document, a present hands files over, the settings tools fall back.
  pdf_locate: "read",
  present_files: "list",
  // speak: a line read aloud.
  speak: "speaker",
}

/** The 14px mark in front of a step: by name, then by what an unknown name suggests. */
export function toolIcon(name: string): StepIconName {
  const known = ICONS[name]
  if (known) return known
  const lower = name.toLowerCase()
  if (lower.includes("terminal")) return "bash"
  if (/browser|page|inspect/.test(lower)) return "browser"
  if (/search|grep/.test(lower)) return "search"
  if (lower.includes("fetch")) return "fetch"
  if (lower.includes("read")) return "read"
  if (/edit|write/.test(lower)) return "edit"
  return "fallback"
}

const text = (value: unknown) => (typeof value === "string" ? value : "")

/** A shell call's command and the model's description of it, when it has a command. */
export function bashOf(part: ToolPart): { cmd: string; desc: string } | undefined {
  if (part.name !== "bash" && part.name !== "exec_command") return undefined
  const cmd = text(part.input?.command).trim()
  if (!cmd) return undefined
  return { cmd, desc: text(part.input?.description).trim() }
}

/** What a step is about, before it is shortened for the row. */
export function stepTitle(part: ToolPart): string {
  const input = part.input ?? {}
  switch (part.name) {
    case "read":
    case "edit":
    case "multiedit":
    case "write":
      return part.title || text(input.path) || text(input.filePath) || text(input.file_path)
    case "bash":
      return text(input.description) || text(input.command) || part.title || ""
    case "glob":
    case "grep":
      return text(input.pattern) || part.title || ""
    case "webfetch":
      return text(input.url) || part.title || ""
    case "invalid":
      return text(input.tool)
    case "list":
      return text(input.path) || part.title || ""
    // subagents: a call that starts one is named by its description; one about a subagent by the one it names; models by nothing.
    case "actor": {
      const action = actorAction(input)
      if (action === "run" || action === "spawn") return text(operationInput(input).description) || part.title || ""
      if (action === "models") return ""
      return part.title || actorTarget(input)
    }
    case "pdf_locate":
      return text(input.snippet).slice(0, LOCATE_TITLE_MAX)
    case "present_files":
      return Array.isArray(input.files)
        ? input.files
            .filter((entry): entry is string => typeof entry === "string" && Boolean(entry))
            .map((entry) => entry.split(/[\\/]/).pop() || entry)
            .join(", ")
            .slice(0, PRESENT_TITLE_MAX)
        : ""
    case "set_desktop_setting":
      return text(input.key) ? `${text(input.key)} → ${text(input.value)}` : ""
    case "get_desktop_settings":
      return ""
    // skills: MiMo names a load by the skill and a search by its query.
    case "skill":
      return text(input.name).trim() || part.title || ""
    case "skill_search":
      return text(input.query).trim() || part.title || ""
    // memory: MiMo's title is the first of query, path, key, name and operation that has words.
    case "memory":
      return [input.query, input.path, input.key, input.name, input.operation].map((value) => text(value).trim()).find(Boolean) ?? ""
  }
  if (BUILT_IN.has(part.name)) return part.title || ""
  // Anything else - an MCP tool - is described by what it was given.
  try {
    const json = JSON.stringify(input)
    if (json && json !== "{}") return json.slice(0, 2000)
  } catch {
    // An input that cannot be written out falls back to the title.
  }
  return part.title || part.name
}

/** A JSON title reduced to the field that says what it is about; any other title as it is. */
export function reducedTitle(title: string): string {
  const trimmed = title.trim()
  if (!trimmed.startsWith("{")) return title
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const field of TITLE_FIELDS) {
        const value = (parsed as Record<string, unknown>)[field]
        if (typeof value === "string" && value.trim()) return value
      }
    }
  } catch {
    // Not JSON after all: shown as written.
  }
  return title
}

/** Whether the row cannot show the whole title, so the opened step shows it in full. */
export function titleIsLossy(title: string, max: number): boolean {
  return title.length > max || title.includes("\n") || reducedTitle(title) !== title
}

/** A read, edit or write title is a path Ctrl+click can open. */
export function opensPath(name: string): boolean {
  return name === "read" || name === "edit" || name === "write"
}

export type Bucket = "read" | "edit" | "run" | "search" | "other"

/** Which count a step adds to in a group's summary. */
export function bucketOf(name: string): Bucket {
  if (name === "read") return "read"
  if (name === "edit" || name === "write" || name === "apply_patch" || name === "patch") return "edit"
  if (name === "bash" || name === "exec_command") return "run"
  if (["grep", "glob", "list", "codesearch", "websearch", "webfetch"].includes(name)) return "search"
  return "other"
}

export function isUnifiedDiff(value: string): boolean {
  return /^@@ /m.test(value) && /^(---|\+\+\+) /m.test(value)
}

/*
 * Output as MiMo shows it: text a tool sent as UTF-16 decoded, a read wrapper
 * stripped to its content, and JSON's escaped angle brackets put back.
 */
export function cleanOutput(raw: string): string {
  let out = raw
  const nulls = out.split(String.fromCharCode(0)).length - 1
  if (nulls > out.length / 3) {
    const bytes = Uint8Array.from(out, (char) => char.charCodeAt(0) & 0xff)
    out = new TextDecoder("utf-16le").decode(bytes)
  }
  const wrapped = /^\s*<path>[\s\S]*?<\/path>\s*(?:<type>[\s\S]*?<\/type>\s*)?<(content|entries)>\n?([\s\S]*?)\n?<\/\1>/.exec(out)
  if (wrapped) out = wrapped[2]
  if (/^\s*[[{]/.test(out) && /\\u00(3c|3e|26)/i.test(out)) {
    out = out.replace(/\\u003c/gi, "<").replace(/\\u003e/gi, ">").replace(/\\u0026/gi, "&")
  }
  return out
}
