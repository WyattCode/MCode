import path from "node:path"
import { listedProjects } from "@shared/projects"
import type { Runtime } from "./index"
import { insideReal } from "./tool/fs-util"
import { appDataRefusal } from "./tool/app-data"
import { scratchRoot } from "./scratch"

/**
 * What the window's files tab may read and save.
 *
 * MiMo's own file channels take a root and a path relative to it, and check
 * that shape before anything is read. These requests took any absolute path,
 * so a page able to send them could read the saved keys or overwrite any text
 * file on the disk. They now take MiMo's shape, and the path has to stay
 * inside its root by where it really leads, links followed.
 *
 * Saving is confined to the folders the app works in: its projects, the
 * folders its conversations run in, and the default project location. Reading
 * keeps one exception, because a feature needs it: the files tab also opens a
 * file outside every project - an attachment dragged in from the desktop, a
 * path the model named - rooted at that file's own folder, as MiMo does. Such a
 * file can be looked at but not saved. The app's own data folder shows only
 * what a feature puts there for the reader (plans, memory, skills, the global
 * AGENTS.md, a cut tool output), and the saved sign-ins never.
 */

/** The request's root and relative path as one absolute path, or a refusal when the shape is wrong. */
export async function fileTarget(root: unknown, rel: unknown): Promise<string> {
  if (typeof root !== "string" || !root || root.includes("\0") || !path.isAbsolute(root)) throw new Error("outside: the root is not an absolute folder")
  if (typeof rel !== "string" || !rel || rel.includes("\0") || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
    throw new Error("outside: the path is not relative to its root")
  }
  // A colon inside a name is an alternate data stream on Windows, which neither the tab nor git can see.
  if (process.platform === "win32" && rel.includes(":")) throw new Error("outside: the path names a data stream")
  const target = path.resolve(root, rel)
  if (target === path.resolve(root) || !(await insideReal(root, target))) throw new Error("outside: the path leaves its root")
  return target
}

/** The folders the app works in, which a save has to be inside. */
export async function workingRoots(runtime: Runtime): Promise<string[]> {
  const config = runtime.config.get()
  const directories = (await runtime.sessions.list()).map((session) => session.directory).filter(Boolean)
  return [...new Set([...listedProjects(config), ...directories, scratchRoot(config.projectRoot ?? "")])]
}

/** A file the tab may read. */
export async function readableFile(root: unknown, rel: unknown): Promise<string> {
  const target = await fileTarget(root, rel)
  if (await appDataRefusal(target, "view")) throw new Error("outside: the app's own data is not shown here")
  return target
}

/** A file the tab may save over. */
export async function writableFile(runtime: Runtime, root: unknown, rel: unknown): Promise<string> {
  const target = await fileTarget(root, rel)
  if (await appDataRefusal(target, "write")) throw new Error("outside: the app's own data is not saved from here")
  // What passed that check in the data folder is a plan, a memory note, a skill or the global AGENTS.md.
  const dataFolder = path.dirname(runtime.storage.directory)
  for (const folder of [...(await workingRoots(runtime)), dataFolder]) {
    if (await insideReal(folder, target)) return target
  }
  throw new Error("outside: only a file inside a project can be saved")
}
