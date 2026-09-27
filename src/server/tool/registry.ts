import type { ToolDefinition } from "./types"
import { ReadTool } from "./read"
import { EditTool, WriteTool } from "./edit"
import { GlobTool, GrepTool } from "./search"
import { BashTool, bashDescription } from "./bash"
import { TaskTool } from "./task"
import { WebFetchTool } from "./webfetch"
import { QuestionTool } from "./question"
import { InvalidTool } from "./invalid"
import { ActorTool } from "./subagent"
import { PdfLocateTool, PresentFilesTool } from "./present"
import { GetDesktopSettingsTool, SetDesktopSettingTool } from "./desktop-settings"
import { ContactsTool, CreateSessionTool, TalkToSessionTool, UpdateSessionTool } from "./session-chat"
import { ListExternalSessionsTool, ReadExternalSessionTool } from "./external-session"
import { NotebookEditTool } from "./notebook"
import { PatchTool } from "./patch"
import { WebSearchTool } from "./websearch"
import { SkillSearchTool, SkillTool } from "./skill"
import { HistoryTool } from "./history"
import { MemoryTool } from "./memory"
import { CronTool } from "./cron"
import { AutomationUpdateTool } from "./automation"
import { PlanExitTool } from "./plan-exit"
import { SpeakTool } from "./speak"

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
  // cron: appended after those for the same reason; offered only to end-to-end runs (`schedulingOffered`).
  CronTool,
  // automation: MiMo desktop's scheduled tasks, appended after those for the same reason; offered the same way.
  AutomationUpdateTool,
  // plan: appended after those for the same reason; offered in both modes, and effective only while planning.
  PlanExitTool,
  // speak: offered only in the turns where voice feedback is on (runner `tools`).
  SpeakTool,
  /*
   * session chat: MiMo's other two, which read another coding tool's own saved
   * conversations. They belong with the four above and are not put there:
   * every request already cached its prefix with that order, and moving a tool
   * into the middle would throw all of it away. Appended, like every group
   * since.
   */
  ListExternalSessionsTool,
  ReadExternalSessionTool,
  // OpenCode v2's patch (R31-7): appended, for the same reason. Offered only to the models `usesPatch` names.
  PatchTool,
  // OpenCode v2's websearch (R31-9): appended, for the same reason. Not offered once the user turned it off.
  WebSearchTool,
]

/**
 * Whether a model edits with `patch` rather than `edit` and `write`: OpenCode
 * v2's rule (tool/plugin/patch.ts), a GPT model other than GPT-4 and the
 * open-weight gpt-oss - the ones trained on this envelope. MCode had matched
 * MiMo's desktop, which never offers it; since 2026-09-27 the engine follows
 * v2 (the user's decision).
 */
export function usesPatch(modelID: string): boolean {
  const id = modelID.toLowerCase()
  return id.includes("gpt-") && !id.includes("oss") && !id.includes("gpt-4")
}

/** A turn's tools for the model it runs on: `patch` in place of `edit` and `write` where `usesPatch` says, and not otherwise. */
export function forModel(tools: readonly ToolDefinition[], modelID: string): ToolDefinition[] {
  const patching = usesPatch(modelID)
  return tools.filter((tool) => (patching ? tool.name !== "edit" && tool.name !== "write" : tool.name !== "patch"))
}

/**
 * The scheduling tools, withdrawn from the model (the user's 2026-09-21
 * decision): MiMo 26.920 hands its `automation_update` only to its own
 * end-to-end runs (`MIMO_E2E=1`) and tells every other turn the feature is
 * unavailable, and MCode does the same with both of its own, keyed on
 * `MCODE_E2E=1`. They stay in `TOOLS`, where they were, so the order of the
 * rest - and with it every cached prefix - does not move. Scheduled tasks
 * already saved still run, and the side column still lists them; nothing but
 * these two tools could make or change one.
 */
const SCHEDULING = new Set(["cron", "automation_update"])

/** Whether this process offers the scheduling tools: only in an end-to-end run, as MiMo's. */
export function schedulingOffered(): boolean {
  return process.env.MCODE_E2E === "1"
}

const offered = (tool: ToolDefinition) => !SCHEDULING.has(tool.name) || schedulingOffered()

/** MiMo's explore subagent: everything is denied but these, the shell among them. */
const EXPLORE = new Set(["read", "glob", "grep", "bash", "webfetch"])

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
  if (CONSOLIDATING.has(agent)) return TOOLS.filter((tool) => CONSOLIDATION_TOOLS.has(tool.name))
  return TOOLS.filter(offered)
}

/** MiMo's `/dream` and `/distill` agents: everything is denied but these. */
const CONSOLIDATING = new Set(["dream", "distill"])
const CONSOLIDATION_TOOLS = new Set(["read", "write", "edit", "glob", "grep", "memory", "bash"])

/** Whether an agent is offered only its own few tools, and none of the MCP servers'. */
export function hasOwnToolsOnly(agent: string): boolean {
  return agent === "explore" || CONSOLIDATING.has(agent)
}

/**
 * The tools one turn is offered: an agent's, less the ones a setting withholds.
 *
 * speak: offered only while the reader has voice feedback switched on, which is
 * how the model comes to know it may say anything aloud at all (the user's
 * 2026-09-16 decision). MiMo keeps its own speech tool in every turn and
 * refuses the call instead; a tool that is simply absent costs nothing to not
 * call, and the prompt prefix is keyed on this list, so switching the setting
 * off takes the tool away from the next turn.
 *
 * bash: its description is written for the shell the settings name, as MiMo
 * writes its own - a description that says to chain with `&&` is wrong on
 * Windows PowerShell 5.1, which has no such operator. `shell` is already part
 * of the prompt prefix key, so a changed setting rebuilds the prefix anyway.
 */
export function toolsForTurn(agent: string, options: { voiceFeedback: boolean; shell?: string; sessionChat?: boolean; webSearch?: boolean }): ToolDefinition[] {
  return toolsFor(agent)
    .filter((tool) => tool.name !== "speak" || options.voiceFeedback)
    .filter((tool) => tool.name !== "websearch" || options.webSearch !== false)
    .filter((tool) => !withheldByLab(tool.name, options))
    .map((tool) => (tool.name === "bash" ? { ...tool, description: bashDescription(options.shell) } : tool))
}

/**
 * The lab's session chat (MiMo 26.920, on unless switched off): its six tools,
 * which MiMo's desktop installs as one module and leaves out whole when the
 * switch is off - reaching other conversations, creating and naming them, and
 * reading other coding tools' saved sessions. The skill goes with them.
 */
export const SESSION_CHAT_TOOLS = new Set(["contacts", "talk_to_session", "create_session", "update_session", "list_external_sessions", "read_external_session"])

/** Whether a switch in the lab keeps this tool from the model: neither offered nor run. */
export function withheldByLab(name: string, settings: { sessionChat?: boolean }): boolean {
  return settings.sessionChat === false && SESSION_CHAT_TOOLS.has(name)
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

/** A withdrawn tool is not found either, so a call to one - from an old transcript, say - goes to `invalid`. */
export function findTool(name: string): ToolDefinition | undefined {
  return DISPATCHABLE.find((tool) => tool.name === name && offered(tool))
}

/** The names a model's call can be repaired to: every tool it could have been offered, `invalid` never. */
export function repairableNames(): string[] {
  return TOOLS.filter(offered).map((tool) => tool.name)
}

/*
 * Tools that only ever read. `actor` is here because it does nothing to files
 * itself: its subagent's own calls are recorded into the parent's turn.
 */
const READS = new Set([
  "read",
  "glob",
  "grep",
  "task",
  "webfetch",
  "websearch",
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
  // and the two that read another tool's transcripts, which write nothing at all.
  "list_external_sessions",
  "read_external_session",
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
  // speak: a line read aloud by the window touches nothing.
  "speak",
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
  if (name === "write" || name === "edit" || name === "notebook_edit" || name === "patch") return "reports"
  if (READS.has(name)) return "reads"
  return "opaque"
}

export { type ToolDefinition } from "./types"
