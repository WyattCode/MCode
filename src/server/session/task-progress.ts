import path from "node:path"

/**
 * tasks: the record a subagent started for a task leaves behind.
 *
 * MiMo's subagent progress checker, in this app's own words. A subagent given a
 * `task_id` is not finished when it says it is: before its work is accepted,
 * `<memory>/sessions/<owner>/tasks/<task id>/progress.md` has to exist and to
 * carry all five of its sections. A file that is missing, or missing a section,
 * sends the subagent back with the template in front of it, and that can happen
 * three times at most - past which the work stands as it is, since a subagent
 * that has not written the file by the third ask will not write it on the
 * fourth either.
 *
 * `memory/guard.ts` already carved out that folder and lets exactly this writer
 * into it; until now nothing ever wrote there.
 *
 * Only a subagent that can write is asked for one: an explore subagent has no
 * tool that could make the file, and nothing is asked while memory writing is
 * switched off.
 */

/** MiMo's bound on how often one subagent may be sent back for its record. */
export const MAX_PROGRESS_REACT = 3

/**
 * The five headings the file has to carry, matched as written.
 *
 * They are the five MiMo asks for, in this app's wording: which task this is,
 * what it was asked for, what it touched, what it ran, and how it came out.
 * The last one is the point of the whole file - the next subagent on a
 * neighbouring task reads it to find out what has already been tried.
 */
export const PROGRESS_SECTIONS = [
  "## 1. The task",
  "## 2. What it was asked for",
  "## 3. Files and code touched",
  "## 4. Commands, word for word",
  "## 5. Outcome and what was learned",
] as const

/** Where a subagent's record of one task lives. */
export function progressPath(memoryRoot: string, ownerID: string, taskID: string): string {
  return path.join(memoryRoot, "sessions", ownerID, "tasks", taskID, "progress.md")
}

/** The headings the file does not carry; empty when it carries all five. */
export function missingProgressSections(body: string): string[] {
  return PROGRESS_SECTIONS.filter((heading) => !body.includes(heading))
}

/** The file as it should read, with the task's own id filled in. */
export function progressTemplate(taskID: string): string {
  return [
    PROGRESS_SECTIONS[0],
    `- task: ${taskID}`,
    "- in one line: <what this task is>",
    "",
    PROGRESS_SECTIONS[1],
    "<one paragraph: the task as it was handed to you>",
    "",
    PROGRESS_SECTIONS[2],
    "- <path>: <what you did with it>",
    "",
    PROGRESS_SECTIONS[3],
    "Exactly what you ran, and anything that should be runnable again later, in a fenced block so it can be searched for:",
    "```",
    "<command>",
    "```",
    "",
    PROGRESS_SECTIONS[4],
    "- outcome (success / partial / failed): <why>",
    "- worth knowing for other tasks: <one bullet each, or (none)>",
  ].join("\n")
}

/**
 * What a subagent that is ending without its record is told, inside one
 * system-reminder, as the completion gate beside it is written.
 */
export function progressReminder(taskID: string, file: string, missing: readonly string[]): string {
  const opening = missing.length === PROGRESS_SECTIONS.length
    ? ["You are ending your work on this task, but you have not written its record yet. Write it now, with the write tool, at:", `  ${file}`]
    : [`Your record of this task is at ${file}, but these sections are not in it:`, ...missing.map((heading) => `  ${heading}`), "", "Write the file again with all five."]
  return [
    "<system-reminder>",
    ...opening,
    "",
    "All five sections are wanted, with the headings exactly as they are here:",
    "",
    progressTemplate(taskID),
    "",
    "Then write your final message again, opening with the **Status** and **Summary** lines.",
    "</system-reminder>",
  ].join("\n")
}
