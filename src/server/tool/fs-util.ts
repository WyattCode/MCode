import path from "node:path"
import fs from "node:fs/promises"
import { ToolError, type ToolContext } from "./types"

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
async function truePath(target: string): Promise<string> {
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

export async function resolvePath(context: ToolContext, target: string): Promise<string> {
  const resolved = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(context.directory, target)
  /*
   * Compared by where the files really are, not by how the path is spelled. A
   * symlink - or a junction, which Windows creates without elevation - reads as
   * being inside the project while pointing anywhere on the machine, so a
   * lexical comparison lets a session that has shell access make one and then
   * walk straight out through it.
   */
  const real = await truePath(resolved)
  const root = await truePath(path.resolve(context.directory))
  const relative = path.relative(root, real)
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return resolved

  if (context.permissions.allowsOutside(context.sessionID, real)) return resolved

  // Approve the directory itself, not the file, so reading a second file in the
  // same folder does not ask again.
  const stats = await fs.stat(resolved).catch(() => undefined)
  // Approved against the real location too, so the same directory reached by a
  // different route is recognised as the one already allowed.
  const scope = stats?.isDirectory() ? real : path.dirname(real)

  await context.permissions.ask({
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
