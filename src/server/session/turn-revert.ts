import fs from "node:fs/promises"
import path from "node:path"
import type { Message, ToolPart, TurnRevertResult } from "@shared/protocol"
import { applyPatch, checkoutFile, isTracked, repositoryRoot } from "../git"
import { createdFile, parseUnifiedDiff, recountedSection, sectionPatch, type DiffSection } from "@shared/unified-diff"

/** The tools whose calls change files and record the diff of what they did. */
const EDITING = new Set(["edit", "write", "notebook_edit", "patch"])

interface FileHistory {
  /** Where the file is on disk. */
  target: string
  /** The turn brought the file into being, so taking the turn back removes it. */
  created: boolean
  /** Its changes in the order the turn made them. */
  sections: DiffSection[]
}

/**
 * Takes one turn's file changes back, through git, as MiMo's 撤销 on the
 * "edited N files" card does.
 *
 * MiMo's `gitRestore` is the shape this follows, file by file:
 *
 * - each file is taken back through the repository it is in, found from its
 *   own folder, so a repository nested in the project - or a project that is
 *   not a repository but holds some - is handled like any other;
 * - a file the turn edited has its patches handed to `git apply --reverse`,
 *   newest first, so the rounds before it and any change made since elsewhere
 *   in the file are kept;
 * - a file the turn created that git does not track is deleted;
 * - a path outside the project is treated the same way when it can be: an
 *   edited one in some repository has its patches reversed, a created one git
 *   does not track is deleted. Only what cannot be put back - an edited file in
 *   no repository, a created one git tracks - is counted as outside and left.
 *
 * Two fallbacks, in this order:
 *
 *   1. a patch that will not apply is recomputed against the file as it stands
 *      now - which rescues a hunk later edits have moved - and tried again;
 *   2. for a file git tracks, `git checkout --` puts it back to the index,
 *      which is as close to "before the turn" as git can get.
 *
 * An edited file with no repository to take it back through is never
 * rewritten by hand: there is no history to undo it from.
 */
/** Every file a turn's editing calls changed, as absolute paths - what taking it back would touch. */
export function turnFilePaths(directory: string, messages: Message[]): string[] {
  return [...filesOf(directory, messages).keys()]
}

/**
 * The patch a call left, as the file itself has it.
 *
 * `metadata.diff` is what the card shows, and since R16-C3 that copy has the
 * indentation its lines share taken off - which `git apply` would refuse,
 * because the context lines no longer match the file. `metadata.filediff.patch`
 * is the same change untouched, and is what is reversed here. A call recorded
 * before that has only `diff`, which was never trimmed, so it is still right
 * for those.
 */
function patchOf(tool: ToolPart): string | undefined {
  const filediff = tool.metadata?.filediff as { patch?: unknown } | undefined
  if (filediff && typeof filediff.patch === "string" && filediff.patch) return filediff.patch
  const diff = tool.metadata?.diff
  return typeof diff === "string" && diff ? diff : undefined
}

function filesOf(directory: string, messages: Message[]): Map<string, FileHistory> {
  const files = new Map<string, FileHistory>()
  const root = path.resolve(directory)

  for (const message of messages) {
    if (message.role !== "assistant") continue
    for (const part of message.parts) {
      if (part.type !== "tool" || !EDITING.has(part.name)) continue
      const tool = part as ToolPart
      /*
       * The same test the card makes. Asking for "completed" instead let a call
       * that ended rejected, skipped or cut short draw a row on the card that
       * the undo then silently passed over, so the undo reported fewer files
       * than the reader had just been shown.
       */
      if (tool.status === "error") continue
      const diff = patchOf(tool)
      if (!diff) continue
      for (const section of parseUnifiedDiff(diff)) {
        if (!section.file) continue
        const target = path.resolve(root, section.file)
        const known = files.get(target)
        if (known) {
          known.sections.push(section)
          continue
        }
        files.set(target, { target, created: createdFile(tool.metadata?.created, section), sections: [section] })
      }
    }
  }
  return files
}

export async function revertTurnFiles(directory: string, messages: Message[]): Promise<TurnRevertResult> {
  const files = filesOf(directory, messages)
  const root = path.resolve(directory)

  /* Each folder asks git once, as MiMo caches `rev-parse --show-cdup` per folder. */
  const roots = new Map<string, Promise<string | undefined>>()
  const repositoryOf = (target: string) => {
    const folder = path.dirname(target)
    let found = roots.get(folder)
    if (!found) {
      found = repositoryRoot(folder)
      roots.set(folder, found)
    }
    return found
  }

  const result: TurnRevertResult = { restored: 0, removed: 0, failed: 0, outside: 0 }
  for (const file of files.values()) {
    const repository = await repositoryOf(file.target)
    const inProject = isWithin(root, file.target)
    if (repository && (inProject || !file.created)) {
      if (await isTracked(repository, file.target)) {
        if (await reverseThroughGit(repository, file)) result.restored++
        else if (await checkoutFile(repository, file.target)) result.restored++
        else result.failed++
        continue
      }
      if (!file.created) {
        if (await reverseThroughGit(repository, file)) result.restored++
        else result.failed++
        continue
      }
      await remove(file, result)
      continue
    }
    // In no repository, or created outside the project: only an untracked new file can be taken back, by deleting it.
    if (!file.created || (repository && (await isTracked(repository, file.target)))) {
      result.outside++
      continue
    }
    await remove(file, result)
  }
  return result
}

function isWithin(outer: string, inner: string): boolean {
  const relative = path.relative(outer, inner)
  return !relative.startsWith("..") && !path.isAbsolute(relative)
}

/* MiMo removes a folder the turn made along with a file, and asks the disk whether it worked. */
async function remove(file: FileHistory, result: TurnRevertResult): Promise<void> {
  await fs.rm(file.target, { recursive: true, force: true }).catch(() => {})
  const left = await fs
    .stat(file.target)
    .then(() => true)
    .catch(() => false)
  if (left) result.failed++
  else result.removed++
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
