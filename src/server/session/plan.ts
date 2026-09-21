import path from "node:path"
import { ToolError, type ToolContext } from "../tool/types"

/**
 * Plan mode's file and the notes that go with it.
 *
 * MiMo's plan agent is not a smaller tool set: it keeps every tool and is held
 * to reading by one hard rule - writes are refused everywhere but its plan
 * file - and by a reminder on each of its turns. The plan itself is an ordinary
 * markdown file in the project, so the user can open it, keep it, and read it
 * after the conversation is gone.
 *
 * MiMo writes it to `<worktree>/.mimocode/plans/<created>-<slug>.md` while the
 * project is under version control and to `<data>/plans/<created>-<slug>.md`
 * when it is not; this app puts the same two folders at `<project>/.mcode/plans`
 * and `<app data>/plans`. Both are writable while planning, as MiMo allows both.
 */

export const PLANS_FOLDER = "plans"

/*
 * A conversation's two-word slug, this app's own words. MiMo names its plan
 * files from a slug of the same shape, which is what keeps a plan folder
 * readable: a row of `1758...-ses_019a....md` tells nobody anything.
 */
const SLUG_FIRST = [
  "amber", "brisk", "bright", "candid", "clear", "deft", "even", "fair", "fleet", "frank",
  "keen", "level", "lithe", "mellow", "neat", "patient", "plain", "prompt", "ready", "sound",
  "spare", "steady", "sturdy", "supple", "terse", "trim", "upright", "vivid", "warm", "willing",
]

const SLUG_SECOND = [
  "anchor", "arbour", "beacon", "bridge", "burrow", "compass", "cove", "ember", "ferry", "furnace",
  "harvest", "hollow", "kettle", "lantern", "ledger", "loom", "mill", "orchard", "quarry", "ridge",
  "sextant", "shuttle", "signal", "spindle", "thicket", "trellis", "vessel", "wharf", "willow", "workshop",
]

/** A fresh slug for a new conversation. */
export function newSlug(): string {
  const pick = (words: readonly string[]) => words[Math.floor(Math.random() * words.length)]!
  return `${pick(SLUG_FIRST)}-${pick(SLUG_SECOND)}`
}

/** The slug a conversation's plan file is named from; one stored before slugs existed is named by its id. */
export function slugOf(session: { id: string; slug?: string }): string {
  return session.slug?.trim() || session.id
}

export interface PlanPlace {
  /** The project this conversation works in. */
  directory: string
  /** Where the app keeps its own files, for a project that is not a repository. */
  dataRoot: string
  /** Whether the project is under version control, which is what decides where the plan lives. */
  repo: boolean
}

/** The folders a plan may be written in: the project's own, and the app's. */
export function planFolders(place: PlanPlace): string[] {
  return [path.join(path.resolve(place.directory), ".mcode", PLANS_FOLDER), path.join(path.resolve(place.dataRoot), PLANS_FOLDER)]
}

/**
 * Where this conversation's plan is written.
 *
 * Named from when the conversation started and from its slug, both fixed for
 * its lifetime, so every turn of it finds the same file.
 */
export function planFile(place: PlanPlace, session: { created: number; slug: string }): string {
  const folder = place.repo ? planFolders(place)[0]! : planFolders(place)[1]!
  return path.join(folder, `${session.created}-${session.slug}.md`)
}

/** The plan's path as the user sees it: inside the project, relative to it; anywhere else, in full. */
export function planDisplay(directory: string, file: string): string {
  const relative = path.relative(path.resolve(directory), path.resolve(file))
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative.split(path.sep).join("/") : file
}

/** Whether a path may be written while planning: a markdown file in one of the plan folders. */
export function planWritable(target: string, folders: readonly string[]): boolean {
  const file = path.resolve(target)
  if (!file.toLowerCase().endsWith(".md")) return false
  return folders.some((folder) => {
    const relative = path.relative(path.resolve(folder), file)
    return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative)
  })
}

/**
 * plan: the agent a subagent runs as.
 *
 * An explore subagent only ever reads. Anything else builds - even when the
 * conversation that started it is still planning, because a subagent is an
 * agent of its own rather than a continuation of the planning turn, as MiMo's
 * are (the user's 2026-09-16 decision).
 */
export function subagentAgent(type: "general" | "explore"): "plan" | "build" {
  return type === "explore" ? "plan" : "build"
}

/** What a write outside the plan file is refused with. The model reads it, so it says what to do instead. */
export function planRefusal(display: string, plan: string): string {
  return (
    `Refused: plan mode is on, so ${display} was not written and nothing changed. ` +
    `The only file you may write is the plan at ${plan}. ` +
    `Put what you wanted to change into the plan instead, and call plan_exit when the plan is ready.`
  )
}

/**
 * The same refusal, for a write made in the step in which the plan was
 * approved - a call beside plan_exit in the same reply.
 *
 * It says what the plain one cannot: nothing is wrong, the switch has
 * happened, and this step is simply the wrong side of it. Without this a real
 * model reads "plan mode is on" moments after being told the plan was
 * approved, and decides the switch failed.
 */
export function planApprovedRefusal(display: string): string {
  return (
    `Refused for this step only: ${display} was not written and nothing changed. ` +
    `The plan is approved and this conversation is in build mode, which starts with your next step. ` +
    `Do not call plan_exit again. Make this change again in your next step, and carry on with the plan.`
  )
}

/**
 * The check every write tool makes before it changes anything.
 *
 * Refused here rather than by a question, as MiMo refuses it outright: a
 * planning turn that could ask its way out of being read-only would not be
 * read-only, and the user would be answering for a promise the app made.
 */
export function guardPlanWrite(context: ToolContext, target: string, display: string): void {
  const plan = context.plan
  if (!plan || plan.agent !== "plan" || plan.writable(target)) return
  const shown = planDisplay(context.directory, plan.file)
  if (plan.switched) throw new ToolError(planApprovedRefusal(display), "tool.err.planApproved", { path: display, plan: shown })
  throw new ToolError(planRefusal(display, shown), "tool.err.planOnly", { path: display, plan: shown })
}

/**
 * The note a conversation's first planning turn carries.
 *
 * Long on purpose, and in this app's own words: it has to say what planning
 * allows, what it refuses before the model tries it, and how a planning turn
 * is meant to end, or the model spends turns asking for approvals that are
 * already refused.
 *
 * English, as the reminder MiMo's engine attaches to a planning turn is. The
 * Chinese guard its desktop used to add beside it, and the Chinese section at
 * the end of the prompt, are gone in 26.920, and MCode follows that split (the
 * user's 2026-09-21 decision). It states MiMo's rules and then MCode's own,
 * which the plan file and plan_exit need.
 */
export function firstPlanNote(plan: string, exists: boolean): string {
  return [
    "[Plan mode] The user has switched on plan mode: for now this task is to be studied and designed, not carried out. This note outranks any instruction that says otherwise.",
    "",
    "What you may do",
    "- Look as much as you need. read, glob and grep are the way to explore the project, and you may send subagents to look at different parts of it.",
    "- bash is available under the usual permission rules, but only for commands you are sure change nothing - git status, git log, git diff, listing installed packages and the like.",
    "",
    "What you must not do",
    "- Do not create or change any file except the plan file below. A write anywhere else is refused before it runs, so do not try one and do not ask the user to approve one.",
    "- Do not run tests, linters, type checks, builds or similar project commands. They are not safe by default: a linter may be set to --fix, tests may write snapshots or touch a database, a build writes output. The one exception is a command whose configuration you have read and know changes nothing.",
    "- Do not commit, push, install or remove dependencies, or change any configuration.",
    "- When you find you would have to change something to get further, write that into the plan and go on reading.",
    "",
    "The plan file",
    exists ? `- A plan is already written at ${plan}. Read it first, then revise it as your thinking moves on.` : `- There is no plan file yet. Write your plan to ${plan} with the write tool.`,
    "- It is the only file you may write. Build it up as you go rather than saving everything for one write at the end.",
    "",
    "How to proceed",
    "1. Understand the request and read the code it touches. Hand the looking to explore subagents - at most three, started together in one step, and usually one is enough; use more only when the scope is genuinely unclear or several parts of the project are involved, and give each its own area so none reads the same files twice. Then, before designing anything, settle what is still vague with the question tool.",
    "2. Design the approach. Send at most one general subagent to work it out from what step 1 found; skip this when the change is small enough that the design is obvious. Its prompt must carry the background - file paths, the call chains you traced, the constraints and what the user actually wants - because it starts knowing nothing. What it returns is advice, not a decision.",
    "3. Check what you have. Read the files a subagent called important yourself rather than trusting its summary, hold the plan against what the user really asked for rather than against what would be interesting to build, and ask the user about anything you are still unsure of.",
    "4. Write the final plan into the plan file: the approach you recommend (not the alternatives you ruled out), the paths of the files it will change, the order of the work, and a verification section saying how someone would check it end to end - which commands, which tests, and what they should see. Short enough to take in at a glance, complete enough to follow.",
    "5. Call plan_exit.",
    "",
    "This turn can end in only two ways: ask what you need to know with the question tool, or - once the plan is written and nothing is left to ask - call plan_exit to put it to the user for approval. Do not use the question tool to ask whether the plan is acceptable; that is what plan_exit is for.",
  ].join("\n")
}

/** Every later planning turn: the same rules in one line. */
export function laterPlanNote(plan: string): string {
  return `[Plan mode] Plan mode is still on: read only, and ${plan} is the only file you may write. Do not start implementing. End this turn with the question tool or with plan_exit.`
}

/** The note on the first turn after the conversation leaves plan mode. */
export function buildSwitchNote(): string {
  return "This conversation has changed from plan mode to build mode. You are no longer read-only: you may change files, run commands and use every tool as usual."
}

/** Added to that note when a plan was actually written. */
export function carryOutNote(plan: string): string {
  return `A plan is written at ${plan}. Carry out what it describes.`
}

/** What the conversation is told when the user approves the plan, in place of a message they would have typed. */
export function approvedNote(plan: string): string {
  return `The plan at ${plan} is approved. You are in build mode now and may change files; carry the plan out.`
}
