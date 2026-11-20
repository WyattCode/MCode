import fs from "node:fs/promises"
import path from "node:path"
import type { ToolContext, ToolDefinition, ToolResult } from "./types"
import { ToolError } from "./types"
import { resolvePath, truePath } from "./fs-util"
import { addWorktree, removeWorktree, worktreeTop } from "../session/worktree"
import { branchNameProblem, branchState, worktrees } from "../git"

/**
 * Git worktrees as tools: the repository's other checkouts, made and removed
 * from inside the conversation instead of by hand.
 *
 * opencode exposes `worktree_create/list/remove` beside its session tools; this
 * is the same surface over this app's own git layer. The point is not typing
 * `git worktree` for the model but deciding where a checkout may go: every path
 * passes `resolvePath`, so a worktree outside the project asks the user the same
 * way every other tool does, and removing one never reaches a folder the
 * conversation was not allowed to touch.
 */

function asked(value: unknown, what: string): string {
  const text = typeof value === "string" ? value.trim() : ""
  if (!text) throw new ToolError(`${what} is required`)
  return text
}

/** The top of the repository the conversation is working in. */
async function repository(context: ToolContext): Promise<string> {
  const top = await worktreeTop(context.directory)
  if (!top) throw new ToolError(`Not in a git repository: ${context.directory}`)
  return top.root
}

/** A branch name made safe to use as the default folder name. */
function folderName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
  if (!safe) throw new ToolError(`name cannot be turned into a folder name: ${name}`)
  return safe
}

function same(left: string, right: string): boolean {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === "win32" || process.platform === "darwin" ? a.toLowerCase() === b.toLowerCase() : a === b
}

function failure(err: unknown): string {
  const stderr = (err as { stderr?: unknown })?.stderr
  if (typeof stderr === "string" && stderr.trim()) return stderr.trim()
  return err instanceof Error ? err.message : String(err)
}

async function disclosed(context: ToolContext, title: string, subject: string, preview: string): Promise<void> {
  await context.permissions.ask({
    sessionID: context.sessionID,
    messageID: context.messageID,
    callID: context.callID,
    kind: "edit",
    directory: context.directory,
    title,
    subject,
    preview,
  })
}

export const WorktreeCreateTool: ToolDefinition = {
  name: "worktree_create",
  description: [
    "Create a git worktree: another checkout of this repository, on its own branch, for isolated experiments or work that can run beside the main one.",
    "",
    "- name: the branch (and default folder) name, e.g. `try-index-rewrite`.",
    "- path: where the checkout goes. Relative paths resolve under the project; a path outside it is put to the user for approval. Defaults to a sibling folder named `<repository>-<name>`.",
    "- branch: the branch to check out, when it differs from `name`.",
    "",
    "The new folder is a full checkout sharing this repository's history. Files written in it do not appear in the current project; pass its path as `workdir` to bash, or change the conversation's folder, to work there. Use worktree_list to see the checkouts that already exist, and worktree_remove to take one back out.",
  ].join("\n"),
  permission: "edit",
  asksForItself: true,
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Branch and default folder name" },
      path: { type: "string", description: "Where the worktree goes; a sibling of the repository when left out" },
      branch: { type: "string", description: "The branch to check out, `name` when left out" },
    },
    required: ["name"],
    additionalProperties: false,
  },
  async execute(input, context): Promise<ToolResult> {
    const name = asked(input.name, "name")
    const branch = typeof input.branch === "string" && input.branch.trim() ? input.branch.trim() : name
    if (branchNameProblem(branch, [])) throw new ToolError(`Not a usable branch name: ${branch}`)
    const root = await repository(context)
    const chosen = typeof input.path === "string" && input.path.trim()
      ? input.path
      : path.join(path.dirname(root), `${path.basename(root)}-${folderName(name)}`)
    const folder = await resolvePath(context, chosen, "write")
    /*
     * A created folder outside the project is the one path resolvePath did not
     * see: it does not exist yet. Put the same question the path would raise
     * once it does, so `git worktree add` cannot make a folder the reader was
     * never asked about.
     */
    const display = path.relative(context.directory, folder) || folder
    await disclosed(context, "Create worktree", display, branch)
    await context.beforeAction?.()
    try {
      await fs.stat(folder)
      throw new ToolError(`There is already something at ${folder}`)
    } catch (err) {
      if (err instanceof ToolError) throw err
    }
    try {
      await fs.mkdir(path.dirname(folder), { recursive: true })
    } catch (err) {
      throw new ToolError(`Could not create the folder for the worktree: ${failure(err)}`)
    }
    const state = await branchState(root)
    try {
      if (state.branches.includes(branch)) await addWorktree(root, [folder, branch])
      else await addWorktree(root, ["-b", branch, folder])
    } catch (err) {
      throw new ToolError(`git could not create the worktree: ${failure(err)}`)
    }
    return {
      title: `worktree: ${branch}`,
      output: `Created a worktree at ${folder} on branch ${branch}. Run commands there with bash's workdir, or open the conversation in that folder; worktree_list names every checkout.`,
      metadata: { directory: folder, branch },
    }
  },
}

export const WorktreeListTool: ToolDefinition = {
  name: "worktree_list",
  description: [
    "List the git worktrees of this repository: every checkout sharing its history, with the folder it is in and the branch it has.",
    "",
    "- directory: a folder in the repository to list from, the project when left out.",
    "",
    "Use it before creating a worktree (a branch can already be checked out elsewhere) and before removing one. The main checkout is marked; worktree_remove refuses to remove it.",
  ].join("\n"),
  permission: "read",
  parameters: {
    type: "object",
    properties: {
      directory: { type: "string", description: "A folder in the repository, the project when left out" },
    },
    additionalProperties: false,
  },
  async execute(input, context): Promise<ToolResult> {
    const from = input.directory === undefined ? context.directory : await resolvePath(context, String(input.directory))
    const root = await repository({ ...context, directory: from })
    const found = await worktrees(root)
    if (!found.length) throw new ToolError(`git could not list the worktrees of ${root}`)
    const lines = found.map((tree) => `${tree.main ? "main" : "worktree"}: ${tree.directory}${tree.branch ? ` (${tree.branch})` : " (detached)"}`)
    return {
      title: `${found.length} worktree${found.length === 1 ? "" : "s"}`,
      output: lines.join("\n"),
      metadata: { count: found.length, worktrees: found },
    }
  },
}

export const WorktreeRemoveTool: ToolDefinition = {
  name: "worktree_remove",
  description: [
    "Remove a git worktree: delete one of this repository's other checkouts.",
    "",
    "- directory: the worktree folder to remove. It is put through the same path gate as every tool, so one outside the project asks the user first.",
    "- force: remove it even with uncommitted changes. Without this, git refuses and the call fails, which is the safe default.",
    "",
    "The main checkout cannot be removed. The worktree's branch is kept, so its commits are still there; remove the folder's files and its entry in this repository's list. Use worktree_list to see which checkouts exist.",
  ].join("\n"),
  permission: "edit",
  asksForItself: true,
  parameters: {
    type: "object",
    properties: {
      directory: { type: "string", description: "The worktree folder to remove" },
      force: { type: "boolean", description: "Remove it even with uncommitted changes" },
    },
    required: ["directory"],
    additionalProperties: false,
  },
  async execute(input, context): Promise<ToolResult> {
    const wanted = asked(input.directory, "directory")
    const target = await resolvePath(context, wanted, "write")
    const top = await worktreeTop(target)
    if (!top) throw new ToolError(`Not a worktree: ${target}`)
    const root = top.root
    const found = await worktrees(root)
    const realTarget = await truePath(target)
    let entry: (typeof found)[number] | undefined
    for (const tree of found) {
      if (same(await truePath(tree.directory), realTarget)) {
        entry = tree
        break
      }
    }
    if (!entry) throw new ToolError(`${target} is not one of this repository's worktrees`)
    if (entry.main) throw new ToolError(`Refused: ${target} is the repository's main checkout, not a worktree`)
    await disclosed(context, "Remove worktree", path.relative(context.directory, target) || target, entry.branch ?? "(detached)")
    await context.beforeAction?.()
    try {
      await removeWorktree(root, target, input.force === true)
    } catch (err) {
      throw new ToolError(`git could not remove the worktree: ${failure(err)}`)
    }
    return {
      title: "worktree removed",
      output: `Removed the worktree at ${target}. Its branch${entry.branch ? ` ${entry.branch}` : ""} and commits stay in the repository.`,
      metadata: { directory: target, ...(entry.branch ? { branch: entry.branch } : {}) },
    }
  },
}
