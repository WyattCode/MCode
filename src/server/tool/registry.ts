import type { ToolDefinition } from "./types"
import { ReadTool } from "./read"
import { EditTool, WriteTool } from "./edit"
import { GlobTool, GrepTool, ListTool } from "./search"
import { BashTool } from "./bash"
import { TodoWriteTool, WebFetchTool } from "./task"
import { QuestionTool } from "./question"
import { InvalidTool } from "./invalid"
import { TaskTool } from "./subagent"
import { PdfLocateTool, PresentFilesTool } from "./present"
import { GetDesktopSettingsTool, SetDesktopSettingTool } from "./desktop-settings"
import { ContactsTool, CreateSessionTool, TalkToSessionTool, UpdateSessionTool } from "./session-chat"

/**
 * The tool surface offered to the model.
 *
 * Order is stable and deliberate: the provider renders tools before the system
 * prompt when computing a cache prefix, so shuffling this list would
 * invalidate the prompt cache on every request.
 *
 * `question` sits where the reference puts it - second, immediately after the
 * entry the model never sees - because its builtin list is
 * `[invalid, ...(questionEnabled ? [question] : []), shell, read, glob, grep,
 * edit, write, task, fetch, todo, search, skill, patch]` (node-BBwF64dM.js
 * @32849132), and the desktop client is inside `questionEnabled`.
 *
 * Every model gets `edit` and `write`: MiMo's desktop turns its engine's codex
 * mode off, so a GPT model is never handed `apply_patch` in their place.
 */
export const TOOLS: ToolDefinition[] = [
  QuestionTool,
  ReadTool,
  WriteTool,
  EditTool,
  ListTool,
  GlobTool,
  GrepTool,
  BashTool,
  TodoWriteTool,
  WebFetchTool,
  // subagents: last, so the prefix every earlier request cached stays as it was.
  TaskTool,
  // MiMo's built-in desktop tools: appended, for the same reason.
  PdfLocateTool,
  PresentFilesTool,
  GetDesktopSettingsTool,
  SetDesktopSettingTool,
  // session chat: appended after those for the same reason.
  ContactsTool,
  TalkToSessionTool,
  CreateSessionTool,
  UpdateSessionTool,
]

/**
 * Tools that can change the project, or the machine around it.
 *
 * `bash` belongs here: a shell is a way to write a file like any other, and a
 * mode that promises to change nothing cannot hand one out.
 */
// session chat: making another conversation act, or changing its record, is acting too; Plan keeps contacts.
const MUTATING = new Set(["write", "edit", "bash", "talk_to_session", "create_session", "update_session"])

/** The tools an agent is allowed to call. Plan inspects; it does not act. */
export function toolsFor(agent: string): ToolDefinition[] {
  return agent === "plan" ? TOOLS.filter((tool) => !MUTATING.has(tool.name)) : TOOLS
}

/**
 * A tool by name, for dispatching a call the model has already made.
 *
 * `invalid` is found here but is in no list above, because it is never offered
 * at all - the reference strips it out of the request with
 * `activeTools: Object.keys(prepared.tools).filter((x) => x !== "invalid")`
 * (@22827789) and only ever reaches it from its repair hook.
 */
const DISPATCHABLE: ToolDefinition[] = [...TOOLS, InvalidTool]

export function findTool(name: string): ToolDefinition | undefined {
  return DISPATCHABLE.find((tool) => tool.name === name)
}

/*
 * Tools that only ever read. `task` is here because it does nothing to files
 * itself: its subagent's own calls are recorded into the parent's turn.
 */
const READS = new Set([
  "read",
  "list",
  "glob",
  "grep",
  "todowrite",
  "webfetch",
  "question",
  "invalid",
  "task",
  // They act on the window or the app's settings, never on the project's files.
  "pdf_locate",
  "present_files",
  "get_desktop_settings",
  "set_desktop_setting",
  // session chat: the four touch no project file; the target's own turn records its own changes.
  "contacts",
  "talk_to_session",
  "create_session",
  "update_session",
])

/**
 * How much of what a tool does to the project can be seen from the runner.
 *
 * "reads" changes nothing, so a turn made only of those has nothing to record.
 * "reports" names each file as it changes it, which is what the edit and write
 * tools do through the snapshot hook. "opaque" is everything else: a shell
 * command, and every tool an MCP server offers, can write anywhere and say
 * nothing about it, so the only way to know what they did is to look at the
 * project afterwards.
 *
 * A name this app does not recognise is treated as opaque on purpose. Guessing
 * the other way would mean a tool added later silently dropping out of undo.
 */
export type ToolReach = "reads" | "reports" | "opaque"

export function reachOf(name: string): ToolReach {
  if (name === "write" || name === "edit") return "reports"
  if (READS.has(name)) return "reads"
  return "opaque"
}

export { type ToolDefinition } from "./types"
