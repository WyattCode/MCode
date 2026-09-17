import fs from "node:fs/promises"
import path from "node:path"
import type { Message, ToolPart, TurnRevertResult } from "@shared/protocol"
import { applyPatch, checkoutFile, isTracked, repositoryRoot } from "../git"
import { createsFile, parseUnifiedDiff, recountedSection, sectionPatch, type DiffSection } from "@shared/unified-diff"

/** The tools whose calls change files and record the diff of what they did. */
const EDITING = new Set(["edit", "write", "patch"])

interface FileHistory {
  /** Where the file is on disk. */
  target: string
  /** The turn brought the file into being, so taking the turn back removes it. */
  created: boolean
  /** Its changes in the order the turn made them. */
  sections: DiffSection[]
}

/**
 * Takes one turn's file changes back out of the project, through git, as
 * MiMo's 撤销 on the "edited N files" card does.
 *
 * MiMo's `gitRestore` is the shape this follows. Only what that turn did is
 * undone: a file the turn edited has its patches handed to `git apply
 * --reverse`, newest first, so the rounds before it and any change made since
 * elsewhere in the file are kept; a file the turn created is deleted; and a
 * path outside the project is never touched.
 *
 * Two fallbacks, both MiMo's, in this order:
 *
 *   1. a patch that will not apply is recomputed against the file as it stands
 *      now - which rescues a hunk later edits have moved - and tried again;
 *   2. for a file git tracks, `git checkout --` puts it back to the index,
 *      which is as close to "before the turn" as git can get.
 *
 * Reverting through git rather than by hand is also what makes the refusal
 * possible: outside a repository nothing here can be put back, so nothing is
 * written. That is MiMo's answer too, and it replaces the old behaviour of
 * rewriting files in a folder with no history to undo them from.
 *
 * MCode keeps no fallback MiMo lacks. In particular there is no plain-Node
 * reverse-apply any more: a project with no repository is refused outright.
 */
export async function revertTurnFiles(directory: string, messages: Message[]): Promise<TurnRevertResult> {
  const files = new Map<string, FileHistory>()
  let outside = 0
  const root = path.resolve(directory)

  for (const message of messages) {
    if (message.role !== "assistant") continue
    for (const part of message.parts) {
      if (part.type !== "tool" || !EDITING.has(part.name)) continue
      const tool = part as ToolPart
      if (tool.status !== "completed") continue
      const diff = tool.metadata?.diff
      if (typeof diff !== "string" || !diff) continue
      for (const section of parseUnifiedDiff(diff)) {
        if (!section.file) continue
        const target = path.resolve(root, section.file)
        const relative = path.relative(root, target)
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
          outside++
          continue
        }
        const known = files.get(target)
        if (known) {
          known.sections.push(section)
          continue
        }
        const created = tool.name === "write" ? tool.metadata?.created === true : tool.name === "patch" && createsFile(section)
        files.set(target, { target, created, sections: [section] })
      }
    }
  }

  const repository = await repositoryRoot(root)
  // MiMo refuses rather than writing to files it has no way of putting back.
  if (!repository) return { restored: 0, removed: 0, failed: 0, outside: 0, noRepo: true }

  const result: TurnRevertResult = { restored: 0, removed: 0, failed: 0, outside }
  for (const file of files.values()) {
    if (file.created) {
      // MiMo removes a folder the turn made along with a file, and asks the disk whether it worked.
      await fs.rm(file.target, { recursive: true, force: true }).catch(() => {})
      const left = await fs
        .stat(file.target)
        .then(() => true)
        .catch(() => false)
      if (left) result.failed++
      else result.removed++
      continue
    }
    if (await reverseThroughGit(repository, file)) result.restored++
    else if ((await isTracked(repository, file.target)) && (await checkoutFile(repository, file.target))) result.restored++
    else result.failed++
  }
  return result
}

/**
 * One file's patches taken back off through git, newest change first.
 *
 * A patch that will not go back on is recomputed against the file as it stands
 * and tried once more. If it still will not, everything already taken off this
 * file goes back on, so the file is left whole rather than half-reverted, and
 * the caller falls back to `git checkout --`.
 */
async function reverseThroughGit(repository: string, file: FileHistory): Promise<boolean> {
  const relative = path.relative(repository, file.target).split(path.sep).join("/")
  const applied: string[] = []
  for (const section of [...file.sections].reverse()) {
    const patch = sectionPatch({ ...section, file: relative })
    if (await applyPatch(repository, patch, true)) {
      applied.push(patch)
      continue
    }
    const current = await fs.readFile(file.target, "utf8").catch(() => undefined)
    const recounted = current === undefined ? undefined : recountedSection(current, section)
    const second = recounted ? sectionPatch({ ...recounted, file: relative }) : undefined
    if (second && (await applyPatch(repository, second, true))) {
      applied.push(second)
      continue
    }
    for (const done of applied.reverse()) await applyPatch(repository, done, false)
    return false
  }
  return true
}
