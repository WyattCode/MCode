import type { ToolDefinition } from "./types"
import { ReadTool } from "./read"
import { EditTool, WriteTool } from "./edit"
import { GlobTool, GrepTool, ListTool } from "./search"
import { BashTool } from "./bash"
import { TaskTool } from "./task"
import { WebFetchTool } from "./webfetch"
import { QuestionTool } from "./question"
import { InvalidTool } from "./invalid"
import { ActorTool } from "./subagent"
import { PdfLocateTool, PresentFilesTool } from "./present"
import { GetDesktopSettingsTool, SetDesktopSettingTool } from "./desktop-settings"
import { ContactsTool, CreateSessionTool, TalkToSessionTool, UpdateSessionTool } from "./session-chat"
import { NotebookEditTool } from "./notebook"
import { SkillSearchTool, SkillTool } from "./skill"
import { HistoryTool } from "./history"
import { MemoryTool } from "./memory"
import { CronTool } from "./cron"
import { AutomationUpdateTool } from "./automation"
import { PlanExitTool } from "./plan-exit"

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
  // tasks: MiMo's task registry, where todowrite used to be.
  TaskTool,
  WebFetchTool,
  // subagents: last, so the prefix every earlier request cached stays as it was.
  ActorTool,
  // MiMo's built-in desktop tools: appended, for the same reason.
  PdfLocateTool,
  PresentFilesTool,
  GetDesktopSettingsTool,
  SetDesktopSettingTool,
  // MiMo's notebook_edit: after the window tools, before the session chat tools and skills that came after it.
  NotebookEditTool,
  // session chat: appended after those for the same reason.
  ContactsTool,
  TalkToSessionTool,
  CreateSessionTool,
  UpdateSessionTool,
  // skills: appended, in MiMo's order (search, then load), for the same reason.
  SkillSearchTool,
  SkillTool,
  // history: appended after those for the same reason.
  HistoryTool,
  MemoryTool,
  // cron: appended after those for the same reason.
  CronTool,
  // automation: MiMo desktop's scheduled tasks, appended after those for the same reason.
  AutomationUpdateTool,
  // plan: appended after those for the same reason; offered in both modes, and effective only while planning.
  PlanExitTool,
]

/** MiMo's explore subagent: everything is denied but these, the shell among them. */
const EXPLORE = new Set(["read", "glob", "grep", "list", "bash", "webfetch"])

/**
 * The tools an agent is allowed to call.
 *
 * plan: a planning conversation keeps every one of them, as MiMo's plan agent
 * does. What holds it to reading is not a shorter list but one rule the write
 * tools enforce - only the plan file may be written - and the ordinary
 * permission rules, which put its commands to the user exactly as they would
 * in build mode. Taking the tools away instead made planning weaker than MiMo
 * at the same promise: it could not run `git log`, and it could not write the
 * plan down anywhere the user could keep.
 *
 * An explore subagent still only looks.
 */
export function toolsFor(agent: string): ToolDefinition[] {
  if (agent === "explore") return TOOLS.filter((tool) => EXPLORE.has(tool.name))
  return TOOLS
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

/** The names a model's call can be repaired to: every tool it could have been offered, `invalid` never. */
export function repairableNames(): string[] {
  return TOOLS.map((tool) => tool.name)
}

/*
 * Tools that only ever read. `actor` is here because it does nothing to files
 * itself: its subagent's own calls are recorded into the parent's turn.
 */
const READS = new Set([
  "read",
  "list",
  "glob",
  "grep",
  "task",
  "webfetch",
  "question",
  "invalid",
  "actor",
  // subagents: a subagent handing back its structured result.
  "StructuredOutput",
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
  // skills: loading instructions reads files, and changes none.
  "skill",
  "skill_search",
  // history, memory: they only read the app's own record.
  "history",
  "memory",
  // cron: scheduling changes no file but the task list, and a fired prompt's turn records its own.
  "cron",
  // automation: its runs are turns of their own, which record their own changes.
  "automation_update",
  // plan: asking to leave plan mode changes the conversation, never a file.
  "plan_exit",
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
  // notebook_edit records its file before writing, as edit does.
  if (name === "write" || name === "edit" || name === "notebook_edit") return "reports"
  if (READS.has(name)) return "reads"
  return "opaque"
}

export { type ToolDefinition } from "./types"
