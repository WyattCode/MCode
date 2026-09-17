import fs from "node:fs/promises"
import path from "node:path"
import { nulFields, runGit } from "../git-process"

/**
 * A note for the model when a shell command leaves a repository mid-merge.
 *
 * MiMo's bash tool appends one of these after a merge, rebase, cherry-pick or
 * revert that stopped on conflicts: the conflict belongs to whoever owns the
 * branch being brought in, so the conversation that ran the command backs out
 * and hands it over rather than editing conflict markers in someone else's
 * work. This is the same check and the same instructions in MCode's words,
 * with MCode's own way of reaching another conversation.
 */

interface Operation {
  /** What sits in the git directory while the operation is unfinished. */
  marker: string
  abort: string
  label: string
}

const OPERATIONS: readonly Operation[] = [
  { marker: "rebase-merge", abort: "git rebase --abort", label: "rebase" },
  { marker: "rebase-apply", abort: "git rebase --abort", label: "rebase" },
  { marker: "CHERRY_PICK_HEAD", abort: "git cherry-pick --abort", label: "cherry-pick" },
  { marker: "REVERT_HEAD", abort: "git revert --abort", label: "revert" },
  { marker: "MERGE_HEAD", abort: "git merge --abort", label: "merge" },
]

/** A git command that can stop on a conflict, somewhere in the line. */
const CAN_CONFLICT = /\bgit\b[^\n;&|]*?\b(merge|rebase|cherry-pick|revert|pull|am)\b/

/** Whether the command or what it printed suggests a conflict is worth looking for. */
export function mayHaveConflicted(command: string, output: string): boolean {
  return /\bCONFLICT\b/.test(output) || CAN_CONFLICT.test(command)
}

/** The unmerged paths `ls-files --unmerged -z` lists, each once. */
export function unmergedPaths(listing: string): string[] {
  const out: string[] = []
  for (const field of nulFields(listing)) {
    const tab = field.indexOf("\t")
    if (tab < 0) continue
    const file = field.slice(tab + 1)
    if (file && !out.includes(file)) out.push(file)
  }
  return out
}

/** The branch a merge was bringing in, from the message git prepared for it. */
export function incomingBranch(mergeMessage: string): string | undefined {
  return /^Merge (?:remote-tracking )?branch '([^']+)'/m.exec(mergeMessage)?.[1]
}

export function conflictNote(conflict: { files: string[]; abort: string; label: string; branch?: string }): string {
  const listed = conflict.files.map((file) => `  ${file}`).join("\n")
  const owner = conflict.branch ? `the conversation working on \`${conflict.branch}\`` : "the conversation working on the branch you brought in"
  const whose = conflict.branch ? `\`${conflict.branch}\`` : "your branch"
  const handover = `${whose} conflicts with the base branch in ${conflict.files.join(", ")}. Rebase it onto the base, resolve the conflict on that branch, and push it again.`
  return [
    "",
    "",
    `[Internal note, not for the user] The ${conflict.label} stopped on conflicts, and resolving them is not your job. The repository is still in the middle of the ${conflict.label}, with these paths unmerged:`,
    listed,
    "",
    `A conflict belongs to ${owner}, not to whoever ran the ${conflict.label}: bringing finished work in is yours, fitting that work to the base is theirs. Do not open or edit these files, do not touch the conflict markers, do not \`git add\` or \`git commit\` them, and do not delete the branch. Instead:`,
    "",
    `  1. Run \`${conflict.abort}\`.`,
    `  2. Send that conversation the task with talk_to_session: "${handover}"`,
    "",
    `If you do not know which conversation that is, \`contacts\` lists them with what each is working on. If no conversation owns ${whose} - you wrote both sides yourself - say so plainly before resolving anything by hand.`,
    "",
    "Do not repeat this note to the user. Tell them the conflict was handed back to the branch's owner.",
  ].join("\n")
}

/** The note for a command that left `cwd`'s repository with unmerged paths, or nothing. */
export async function mergeConflictNotice(cwd: string, command: string, output: string): Promise<string> {
  if (!mayHaveConflicted(command, output)) return ""
  try {
    const files = unmergedPaths(await runGit(cwd, ["ls-files", "--unmerged", "-z"]))
    if (!files.length) return ""
    const gitDir = (await runGit(cwd, ["rev-parse", "--absolute-git-dir"])).trim()
    if (!gitDir) return ""
    let operation: Operation | undefined
    for (const candidate of OPERATIONS) {
      if (await fs.stat(path.join(gitDir, candidate.marker)).then(() => true, () => false)) {
        operation = candidate
        break
      }
    }
    if (!operation) return ""
    const branch =
      operation.label === "merge"
        ? incomingBranch(await fs.readFile(path.join(gitDir, "MERGE_MSG"), "utf8").catch(() => ""))
        : undefined
    return conflictNote({ files, abort: operation.abort, label: operation.label, ...(branch ? { branch } : {}) })
  } catch {
    return ""
  }
}
