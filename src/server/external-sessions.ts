import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * Conversations another coding tool on this machine has saved, read for the
 * model - MiMo's `list_external_sessions` and `read_external_session`.
 *
 * One tool is covered, as MiMo covers one: Claude Code, whose transcripts are
 * `<config>/projects/<mangled project path>/<session id>.jsonl`, one JSON
 * object per line. Nothing is written back, nothing leaves this machine, and
 * no line of what was read reaches a log - a file that will not parse costs
 * that line and nothing else.
 *
 * Every read is bounded, because these files belong to someone else and can be
 * any size: one file at a time, a byte budget per file and a byte budget for a
 * whole scan, and the text of each message cut. A read that stopped at a
 * budget says so, so the model does not read a partial answer as a complete
 * one.
 *
 * MCODE_IMPORT_HOME stands in for the home directory, as it does for the
 * import scan, so a check can point these at fixtures of its own rather than
 * at the reader's real conversations.
 */

/** The one external agent this covers, by the id MiMo gives it. */
export const CLAUDE_CODE_AGENT = "ext:claude-code"
export const CLAUDE_CODE_NAME = "Claude Code"

/** MiMo's limits, as its two tools declare them. */
export const LIST_LIMIT_DEFAULT = 20
export const LIST_LIMIT_MAX = 100
export const READ_MESSAGES_DEFAULT = 100
export const READ_MESSAGES_MAX = 500

/** How much of one message's text is kept, how much of one file is read, and how much a whole scan may read. */
const TEXT_MAX = 8_000
const LIST_FILE_BYTES = 1024 * 1024
const READ_FILE_BYTES = 16 * 1024 * 1024
const SCAN_BYTES = 16 * 1024 * 1024
/** What a first prompt is cut to on a listing line. */
const FIRST_PROMPT_MAX = 240

/** A session as the listing describes it. */
export interface ExternalSessionSummary {
  sessionID: string
  project?: string
  firstPrompt?: string
  startedAt?: number
  updatedAt: number
  messageCount: number
  /** The file was longer than the budget, so these numbers are of the part that was read. */
  scanTruncated?: boolean
}

export interface ExternalMessage {
  role: "user" | "assistant" | "tool"
  toolName?: string
  text: string
  at?: number
}

export interface ExternalSessionRead {
  summary: ExternalSessionSummary
  messages: ExternalMessage[]
  /** More messages were there than were returned, or the file was cut. */
  truncated: boolean
}

function home(): string {
  return process.env.MCODE_IMPORT_HOME || os.homedir()
}

/** Where Claude Code keeps its own folder: its own environment variable when set, `~/.claude` otherwise. */
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(home(), ".claude")
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function timeOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value > 1e10 ? value : value * 1000
  if (typeof value !== "string" || !value.trim()) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function cut(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > TEXT_MAX ? `${trimmed.slice(0, TEXT_MAX)}…` : trimmed
}

/** What the harness wrapped around a user's words, which was never part of the conversation. */
function withoutHarness(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, "")
    .trim()
}

/** The words in a message's content, whichever shape it was written in. */
function textBlocks(content: unknown): string[] {
  if (typeof content === "string") return [content]
  if (!Array.isArray(content)) return []
  return content.flatMap((block) => {
    const record = asRecord(block)
    return record?.type === "text" && typeof record.text === "string" ? [record.text] : []
  })
}

function hasToolResult(content: unknown): boolean {
  return Array.isArray(content) && content.some((block) => asRecord(block)?.type === "tool_result")
}

/** A message's tool calls and results, as their own entries, for a read that asked for them. */
function toolEntries(content: unknown, at?: number): ExternalMessage[] {
  if (!Array.isArray(content)) return []
  const out: ExternalMessage[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (!record) continue
    if (record.type === "tool_use") {
      const body = record.input === undefined ? "" : JSON.stringify(record.input, null, 2)
      out.push({ role: "tool", toolName: typeof record.name === "string" ? record.name : "tool", text: cut(body || "(no input)"), at })
    } else if (record.type === "tool_result") {
      const body = typeof record.content === "string" ? record.content : record.content === undefined ? "" : JSON.stringify(record.content, null, 2)
      out.push({ role: "tool", toolName: "tool_result", text: cut(body || "(empty result)"), at })
    }
  }
  return out
}

/** One transcript, read as far as the budgets allow. */
function parseTranscript(
  text: string,
  file: { sessionID: string; modified: number; sourceTruncated: boolean },
  options: { includeTools?: boolean; maxMessages: number },
): ExternalSessionRead {
  let project: string | undefined
  let firstPrompt: string | undefined
  let started: number | undefined
  let updated = file.modified
  let count = 0
  const messages: ExternalMessage[] = []
  let truncated = file.sourceTruncated
  const keep = (message: ExternalMessage) => {
    if (!message.text) return
    if (messages.length < options.maxMessages) messages.push(message)
    else truncated = true
  }

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    let row: Record<string, unknown> | undefined
    try {
      row = asRecord(JSON.parse(line))
    } catch {
      /* One damaged line costs that line, not the transcript. */
    }
    if (!row) continue
    if (!project && typeof row.cwd === "string" && row.cwd.trim()) project = row.cwd.trim()
    const at = timeOf(row.timestamp)
    if (at !== undefined) {
      started = started === undefined ? at : Math.min(started, at)
      updated = Math.max(updated, at)
    }
    if (row.type !== "user" && row.type !== "assistant") continue
    count += 1
    const content = asRecord(row.message)?.content
    const role = row.type === "user" ? "user" : "assistant"
    // A user entry that carries a tool result is the harness answering, not the reader speaking.
    const isToolTurn = role === "user" && (row.toolUseResult !== undefined || hasToolResult(content))
    const body =
      isToolTurn || row.isMeta === true
        ? ""
        : textBlocks(content)
            .map((entry) => (role === "user" ? withoutHarness(entry) : entry.trim()))
            .filter(Boolean)
            .join("\n\n")
    if (role === "user" && !firstPrompt && body) firstPrompt = cut(body).slice(0, FIRST_PROMPT_MAX)
    if (body) keep({ role, text: cut(body), at })
    if (!options.includeTools) continue
    const tools = toolEntries(content, at)
    for (const entry of tools) keep(entry)
    if (isToolTurn && !tools.length) {
      const body2 = row.toolUseResult ?? content
      keep({ role: "tool", toolName: "tool_result", text: cut(JSON.stringify(body2, null, 2) || "(empty result)"), at })
    }
  }

  return {
    summary: {
      sessionID: file.sessionID,
      project,
      firstPrompt,
      startedAt: started,
      updatedAt: updated,
      messageCount: count,
      ...(file.sourceTruncated ? { scanTruncated: true } : {}),
    },
    messages,
    truncated,
  }
}

/** The folder names Claude Code would have made for one project path. */
function folderNames(project: string): string[] {
  const forms = [path.resolve(project)]
  try {
    forms.push(fs.realpathSync(project))
  } catch {
    /* A project that is not there has only its written form. */
  }
  return [...new Set(forms.flatMap((form) => [form.replace(/\//g, "-"), form.replace(/[^A-Za-z0-9-]/g, "-")]))]
}

/** Every transcript file, newest first: one project's when named, else every project's. */
function transcripts(configDir: string, project?: string): { file: string; sessionID: string; modified: number }[] {
  const projects = path.join(configDir, "projects")
  let folders: string[]
  if (project) {
    folders = folderNames(project).filter((name) => {
      try {
        return fs.statSync(path.join(projects, name)).isDirectory()
      } catch {
        return false
      }
    })
  } else {
    try {
      folders = fs
        .readdirSync(projects, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      return []
    }
  }
  const found: { file: string; sessionID: string; modified: number }[] = []
  for (const folder of folders) {
    const dir = path.join(projects, folder)
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue
      const file = path.join(dir, entry.name)
      try {
        found.push({ file, sessionID: entry.name.slice(0, -".jsonl".length), modified: fs.statSync(file).mtimeMs })
      } catch {
        /* A file that went between the listing and the stat is simply not there. */
      }
    }
  }
  return found.sort((a, b) => b.modified - a.modified)
}

/** The start of a file, up to `maxBytes`, cut back to the last whole line. */
function head(file: string, maxBytes: number): { text: string; read: number; truncated: boolean } {
  const handle = fs.openSync(file, "r")
  try {
    const size = fs.fstatSync(handle).size
    const want = Math.min(size, Math.max(0, Math.floor(maxBytes)))
    const buffer = Buffer.allocUnsafe(want)
    let read = 0
    while (read < want) {
      const got = fs.readSync(handle, buffer, read, want - read, read)
      if (!got) break
      read += got
    }
    const truncated = read < size
    let end = read
    if (truncated && end > 0) {
      const lastNewline = buffer.lastIndexOf(10, end - 1)
      end = lastNewline < 0 ? 0 : lastNewline + 1
    }
    return { text: buffer.subarray(0, end).toString("utf8"), read, truncated }
  } finally {
    fs.closeSync(handle)
  }
}

/** Whether a transcript's own working directory is the one asked for; a transcript that names none is taken as any. */
function sameProject(found: string | undefined, wanted?: string): boolean {
  if (!wanted) return true
  if (!found) return false
  const real = (target: string) => {
    try {
      return fs.realpathSync(target)
    } catch {
      return path.resolve(target)
    }
  }
  return real(found) === real(wanted)
}

export function listExternalSessions(options: { project?: string; limit?: number }): { sessions: ExternalSessionSummary[]; truncated: boolean } {
  const limit = Math.max(1, Math.min(LIST_LIMIT_MAX, options.limit ?? LIST_LIMIT_DEFAULT))
  const sessions: ExternalSessionSummary[] = []
  let spent = 0
  let truncated = false
  for (const file of transcripts(claudeConfigDir(), options.project)) {
    const left = SCAN_BYTES - spent
    if (left <= 0) {
      truncated = true
      break
    }
    let part: { text: string; read: number; truncated: boolean }
    try {
      part = head(file.file, Math.min(LIST_FILE_BYTES, left))
    } catch {
      continue
    }
    spent += part.read
    if (part.truncated) truncated = true
    const one = parseTranscript(part.text, { sessionID: file.sessionID, modified: file.modified, sourceTruncated: part.truncated }, { maxMessages: 1 })
    if (!sameProject(one.summary.project, options.project)) continue
    sessions.push(one.summary)
    if (sessions.length >= limit) break
  }
  return { sessions, truncated }
}

/** MiMo's shape for a session id, which is what keeps a path out of one. */
export function isSessionID(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value)
}

/** The transcript, or nothing when there is none by that id in this project. Throws only when a budget hid the answer. */
export function readExternalSession(options: { sessionID: string; project?: string; includeTools?: boolean; maxMessages?: number }): ExternalSessionRead | undefined {
  if (!isSessionID(options.sessionID)) return undefined
  const file = transcripts(claudeConfigDir(), options.project).find((entry) => entry.sessionID === options.sessionID)
  if (!file) return undefined
  let part: { text: string; read: number; truncated: boolean }
  try {
    part = head(file.file, READ_FILE_BYTES)
  } catch {
    return undefined
  }
  const one = parseTranscript(
    part.text,
    { sessionID: file.sessionID, modified: file.modified, sourceTruncated: part.truncated },
    { includeTools: options.includeTools, maxMessages: Math.max(1, Math.min(READ_MESSAGES_MAX, options.maxMessages ?? READ_MESSAGES_DEFAULT)) },
  )
  if (sameProject(one.summary.project, options.project)) return one
  /*
   * The transcript never said which project it belonged to, and the part that
   * would have said so was past the budget. Answering "not found" there would
   * be a guess; saying what happened lets the model ask across projects.
   */
  if (options.project && part.truncated && !one.summary.project) throw new Error("unverifiable-project")
  return undefined
}
