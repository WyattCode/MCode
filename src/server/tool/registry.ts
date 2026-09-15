import type { ToolDefinition } from "./types"
import { ReadTool } from "./read"
import { EditTool, WriteTool } from "./edit"
import { GlobTool, GrepTool, ListTool } from "./search"
import { BashTool } from "./bash"
import { TodoWriteTool, WebFetchTool } from "./task"
import { QuestionTool } from "./question"
import { ApplyPatchTool } from "./patch"
import { InvalidTool } from "./invalid"
import { TaskTool } from "./subagent"
import { PdfLocateTool, PresentFilesTool } from "./present"
import { GetDesktopSettingsTool, SetDesktopSettingTool } from "./desktop-settings"

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
 * `apply_patch` is NOT here. It is offered instead of `edit` and `write`, and
 * only to one family of models; `toolsFor` is where that is decided.
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
]

/**
 * Tools that can change the project, or the machine around it.
 *
 * `bash` belongs here: a shell is a way to write a file like any other, and a
 * mode that promises to change nothing cannot hand one out.
 */
const MUTATING = new Set(["write", "edit", "bash", "apply_patch"])

/**
 * Whether a model is given `apply_patch` in place of `edit` and `write`.
 *
 * The reference's rule, verbatim (@32851450):
 *
 *   const usePatch = input.modelID.includes("gpt-") && !input.modelID.includes("oss") && !input.modelID.includes("gpt-4")
 *   if (tool.id === ApplyPatchTool.id) return usePatch
 *   if (tool.id === EditTool.id || tool.id === WriteTool.id) return !usePatch
 *
 * So it is a swap, not an addition: a GPT-5 model gets the patch language and
 * nothing else, every other model gets the two string tools and never sees
 * `apply_patch`. `gpt-oss` and the `gpt-4` family are carved back out because
 * neither was trained on the format.
 *
 * An empty id - which is what a caller that has no model in hand passes -
 * contains no "gpt-", so it takes the edit/write branch. That is the safe
 * direction: it is the surface every model but one family gets.
 */
export function usesPatch(modelID: string): boolean {
  return modelID.includes("gpt-") && !modelID.includes("oss") && !modelID.includes("gpt-4")
}

/**
 * The tools an agent is allowed to call. Plan inspects; it does not act.
 *
 * @param modelID the model this turn will run on, which decides between the
 *   patch language and the two string tools. Passed rather than read from
 *   config because a session can be on a different model from the app default.
 */
export function toolsFor(agent: string, modelID = ""): ToolDefinition[] {
  const patch = usesPatch(modelID)
  const list = patch ? [...TOOLS.filter((tool) => tool.name !== "edit" && tool.name !== "write"), ApplyPatchTool] : TOOLS
  return agent === "plan" ? list.filter((tool) => !MUTATING.has(tool.name)) : list
}

/**
 * A tool by name, for dispatching a call the model has already made.
 *
 * `apply_patch` and `invalid` are found here but are in no list above:
 * `apply_patch` because a model can call it in the same turn its surface
 * changed, and `invalid` because it is never offered at all - the reference
 * strips it out of the request with
 * `activeTools: Object.keys(prepared.tools).filter((x) => x !== "invalid")`
 * (@22827789) and only ever reaches it from its repair hook.
 */
const DISPATCHABLE: ToolDefinition[] = [...TOOLS, ApplyPatchTool, InvalidTool]

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
  /*
   * `apply_patch` is a reporter, not an opaque one. It snapshots every path it
   * is about to touch - both ends of a rename - before writing any of them, so
   * the runner already knows the whole set and does not need to photograph the
   * project to find out. Leaving it to the default would have made every patch
   * force a full-project comparison, which is the slow path and the one that
   * cannot tell a model's write from a background build's.
   */
  if (name === "write" || name === "edit" || name === "apply_patch") return "reports"
  if (READS.has(name)) return "reads"
  return "opaque"
}

export { type ToolDefinition } from "./types"
