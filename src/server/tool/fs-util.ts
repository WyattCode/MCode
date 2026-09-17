import path from "node:path"
import fs from "node:fs/promises"
import { ToolError, type ToolContext } from "./types"
import { historyService, isMemoryPath, memoryWritable } from "../history/service"
import { MEMORY_SANDBOXED_AGENTS, memoryWriteRefusal, sandboxRefusal } from "../memory/guard"
import { guardAppData } from "./app-data"
import { worktreeTop } from "../session/worktree"

/**
 * Resolves a model-supplied path against the session directory and refuses
 * anything that escapes it. The model is not a trusted source of paths, so
 * traversal is rejected here rather than in each tool.
 */
export function resolveInside(directory: string, target: string): string {
  const resolved = path.isAbsolute(target) ? path.resolve(target) : path.resolve(directory, target)
  const root = path.resolve(directory)
  const relative = path.relative(root, resolved)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    // A deliberate refusal, not a defect: reported as a crash it read like the
    // app had broken, when the sandbox was doing exactly its job.
    throw new ToolError(
      `Path is outside the project directory (${root}): ${target}`,
      "tool.err.outsideProject",
      { path: target, root },
    )
  }
  return resolved
}

export function relative(directory: string, target: string): string {
  return path.relative(path.resolve(directory), path.resolve(target)).split(path.sep).join("/")
}

/** Directory names that are never worth walking into for search or listing. */
export const IGNORED = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "out",
  "build",
  ".next",
  ".nuxt",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".turbo",
  "target",
  "vendor",
])

export function truncate(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false }
  return { text: text.slice(0, limit) + `\n\n... truncated, ${text.length - limit} more characters`, truncated: true }
}


/**
 * Resolves a model-supplied path, asking the user when it leaves the project.
 *
 * A flat refusal was the wrong shape for this: wanting to read a folder next
 * door is ordinary, and the sandbox exists so the user decides - not so the
 * answer is always no. Approving "always" covers that directory and everything
 * under it for the rest of the session, so a walk through one tree asks once.
 */
/**
 * Where a path really leads, following any links along the way.
 *
 * A file that is about to be created has no real path of its own, so the walk
 * stops at the deepest part that does exist and the remainder is appended: a new
 * file inside a linked directory is then judged by where that directory is.
 */
export async function truePath(target: string): Promise<string> {
  let head = target
  const tail: string[] = []
  for (;;) {
    const real = await fs.realpath(head).catch(() => undefined)
    if (real) return tail.length ? path.join(real, ...tail.reverse()) : real
    const parent = path.dirname(head)
    // The root of a drive that cannot be resolved: nothing further to try.
    if (parent === head) return target
    tail.push(path.basename(head))
    head = parent
  }
}

/**
 * `access` says what the caller will do with the path: the app's own data
 * folder is never written by a tool, and its saved sign-ins never read.
 */
/** Whether `target` really lies inside `root` (or is it), links followed on both sides. */
export async function insideReal(root: string, target: string): Promise<boolean> {
  const relative = path.relative(await truePath(path.resolve(root)), await truePath(path.resolve(target)))
  return !relative.startsWith("..") && !path.isAbsolute(relative)
}

/**
 * `resolveInside`, judged by where the path really leads as well as by how it
 * is spelled: a junction inside the project (which Windows lets anyone make)
 * no longer passes for a folder inside it.
 */
export async function resolveInsideReal(directory: string, target: string): Promise<string> {
  const resolved = resolveInside(directory, target)
  if (!(await insideReal(directory, resolved))) {
    throw new ToolError(`Path leads outside the project directory (${path.resolve(directory)}): ${target}`, "tool.err.outsideProject", {
      path: target,
      root: path.resolve(directory),
    })
  }
  return resolved
}

/**
 * The top of the git worktree a folder is in, as MiMo's `Instance.worktree`:
 * a path anywhere under it is inside the project, so a conversation opened on
 * a package of a repository reads and edits its siblings without asking. A
 * drive's or the file system's root never counts, as MiMo leaves out `/`.
 */
export async function repositoryRoot(directory: string): Promise<string | undefined> {
  const top = await worktreeTop(directory)
  if (!top) return undefined
  return path.parse(top.root).root === top.root ? undefined : top.root
}

/**
 * memory: MiMo's checks on a write, made before any other: `/dream` and
 * `/distill` write only memory and the project's config folder, and a write
 * into the memory folder has to fit its layout (memory/guard.ts).
 */
async function guardMemoryWrite(context: ToolContext, resolved: string): Promise<void> {
  const service = historyService()
  if (!service) return
  const agent = context.plan?.agent
  if (agent && MEMORY_SANDBOXED_AGENTS.has(agent)) {
    const refused = sandboxRefusal({
      agent,
      target: resolved,
      memoryRoot: service.memoryRoot,
      projectRoot: (await repositoryRoot(context.directory)) ?? context.directory,
    })
    if (refused) throw new ToolError(refused)
  }
  if (!isMemoryPath(resolved)) return
  const session = await service.store.get(context.sessionID)
  const refused = memoryWriteRefusal({
    target: resolved,
    memoryRoot: service.memoryRoot,
    directory: context.directory,
    sessionID: context.sessionID,
    writeEnabled: memoryWritable(),
    taskID: session?.subagent?.taskID,
    parentID: session?.parentID,
  })
  if (refused) throw new ToolError(refused)
}

export async function resolvePath(context: ToolContext, target: string, access: "read" | "write" = "read"): Promise<string> {
  const resolved = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(context.directory, target)
  /*
   * A colon past the drive names an alternate data stream on Windows
   * (`notes.txt:hidden`): a place to keep bytes that no listing, diff or git
   * status ever shows (round 8, X19).
   */
  if (process.platform === "win32" && resolved.slice(path.parse(resolved).root.length).includes(":")) {
    throw new ToolError(`Refused: ${target} names an alternate data stream (a colon after the drive), which tools do not read or write.`)
  }
  await guardAppData(resolved, access, target)
  if (access === "write") await guardMemoryWrite(context, resolved)
  // A cut output's saved file is the model's to read, as MiMo allows its truncation folder outright.
  if (context.toolOutputs?.holds(resolved)) return resolved
  /*
   * Compared by where the files really are, not by how the path is spelled. A
   * symlink - or a junction, which Windows creates without elevation - reads as
   * being inside the project while pointing anywhere on the machine, so a
   * lexical comparison lets a session that has shell access make one and then
   * walk straight out through it.
   */
  const real = await truePath(resolved)
  const within = (root: string) => {
    const relative = path.relative(root, real)
    return !relative.startsWith("..") && !path.isAbsolute(relative)
  }
  if (within(await truePath(path.resolve(context.directory)))) return resolved
  // MiMo's project is the whole repository the conversation works in, not only its folder (T10-12).
  const repository = await repositoryRoot(context.directory)
  if (repository && within(await truePath(repository))) return resolved

  // memory: the memory folder is reached without asking, as MiMo does.
  if (isMemoryPath(real)) return resolved

  // Approve the directory itself, not the file, so reading a second file in the
  // same folder does not ask again.
  const stats = await fs.stat(resolved).catch(() => undefined)
  // Approved against the real location too, so the same directory reached by a
  // different route is recognised as the one already allowed.
  const scope = stats?.isDirectory() ? real : path.dirname(real)
  if (context.permissions.allowsOutside({ directory: context.directory, sessionID: context.sessionID }, scope)) return resolved

  await context.permissions.ask({
    directory: context.directory,
    sessionID: context.sessionID,
    messageID: context.messageID,
    callID: context.callID,
    kind: "outside",
    title: "Access files outside the project",
    titleCode: "perm.outside",
    subject: path.join(scope, "*"),
    scope,
  })

  return resolved
}
