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
 * The same refusal, for the turn in which the plan was approved.
 *
 * It says what the plain one cannot: nothing is wrong, the switch has
 * happened, and this turn - the one that was promised read-only - is simply
 * the wrong side of it. Without this a real model reads "plan mode is on"
 * moments after being told the plan was approved, decides the switch failed,
 * and spends the rest of the turn retrying the same write.
 */
export function planApprovedRefusal(display: string): string {
  return (
    `Refused for this turn only: ${display} was not written and nothing changed. ` +
    `The plan is approved and this conversation is in build mode, but the switch takes effect from the next turn - this turn began in plan mode and stays read-only to the end. ` +
    `Do not retry the write and do not call plan_exit again. End your turn now, saying the plan is approved and that you will carry it out; you can change files when the user speaks next.`
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
 */
export function firstPlanNote(plan: string, exists: boolean): string {
  return [
    "Plan mode is on. The user wants this task researched and designed, not carried out yet. This note outranks any instruction that says otherwise.",
    "",
    "What to do",
    "- Read as widely as you need: read, glob and grep are the way to look around, and subagents can explore parts of it in parallel.",
    "- bash is available and follows the usual permission rules, but use it only for commands you are certain change nothing - git status, git log, git diff, listing installed packages.",
    "",
    "What not to do",
    "- Do not create or change any file but the plan file below. A write anywhere else is refused before it runs, so do not attempt one and do not ask the user to approve one.",
    "- Do not run tests, linters, type checks, builds or similar project commands. They are not safe by default: a linter may be configured with --fix, a test may record snapshots or touch a database, a build writes artifacts. The one exception is a command whose exact configuration you have read and know changes nothing.",
    "- Do not commit, push, install or remove packages, or change any configuration.",
    "- When you find yourself wanting to change something to make progress, write that into the plan and carry on reading.",
    "",
    "The plan file",
    exists
      ? `- A plan is already written at ${plan}. Read it, and edit it as your plan grows.`
      : `- No plan file exists yet. Write your plan to ${plan} with the write tool.`,
    "- It is the only file you may write. Build the plan up as you go rather than leaving all of it to the end.",
    "",
    "End this turn in one of two ways: ask the user what you need to know with the question tool, or - once the plan is written and nothing is left to ask - call plan_exit to put it to them for approval.",
  ].join("\n")
}

/** Every later planning turn: the same rules in one line. */
export function laterPlanNote(plan: string): string {
  return `Plan mode is still on: read-only, and ${plan} is the only file you may write. Do not implement. End this turn with the question tool or with plan_exit.`
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
