import fs from "node:fs/promises"
import path from "node:path"
import type { ToolDefinition } from "./types"
import { ToolError } from "./types"
import { relative, resolvePath } from "./fs-util"
import { currentText, locked } from "./edit"
import { applyChunks, parsePatch, type Hunk } from "./patch-format"
import { changed, unifiedDiff } from "../diff"
import { isMemoryPath } from "../history/service"
import { guardPlanWrite } from "../session/plan"

/**
 * OpenCode v2's `patch` tool (packages/core/src/tool/plugin/patch.ts, MIT):
 * one call that adds, updates, moves and deletes files, in the envelope GPT
 * models are trained to write. v2 offers it to those models in place of edit
 * and write, and to no other; so does MCode (see `usesPatch`).
 *
 * It follows MCode's write path file by file - the path is resolved and
 * checked, planning may write only its plan, each file is locked, what was
 * there is read first - but asks once for the whole patch, and writes nothing
 * until every file's change has been worked out: a patch that does not apply
 * to one file leaves all of them as they were.
 */
export const PatchTool: ToolDefinition = {
  name: "patch",
  // OpenCode v2's own description of the language (tool/patch.txt).
  description: [
    "Use the `patch` tool to edit files. Your patch language is a stripped-down, file-oriented diff format designed to be easy to parse and safe to apply. You can think of it as a high-level envelope:",
    "",
    "*** Begin Patch",
    "[ one or more file sections ]",
    "*** End Patch",
    "",
    "Within that envelope, you get a sequence of file operations.",
    "You MUST include a header to specify the action you are taking.",
    "Each operation starts with one of three headers:",
    "",
    "*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).",
    "*** Delete File: <path> - remove an existing file. Nothing follows.",
    "*** Update File: <path> - patch an existing file in place (optionally with a rename).",
    "",
    "Example patch:",
    "",
    "```",
    "*** Begin Patch",
    "*** Add File: hello.txt",
    "+Hello world",
    "*** Update File: src/app.py",
    "*** Move to: src/main.py",
    "@@ def greet():",
    '-print("Hi")',
    '+print("Hello, world!")',
    "*** Delete File: obsolete.txt",
    "*** End Patch",
    "```",
    "",
    "It is important to remember:",
    "",
    "- You must include a header with your intended action (Add/Delete/Update)",
    "- You must prefix new lines with `+` even when creating a new file",
  ].join("\n"),
  permission: "edit",
  asksForItself: true,
  parameters: {
    type: "object",
    properties: {
      patchText: { type: "string", description: "The full patch text describing add, update, and delete operations" },
    },
    required: ["patchText"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const text = typeof input.patchText === "string" ? input.patchText : ""
    if (!text.trim()) throw new ToolError("patchText is required")
    const parsed = parsePatch(text)
    if (!parsed.ok) throw new ToolError(`patch verification failed: ${parsed.error}`)
    if (parsed.hunks.length === 0) throw new ToolError("patch rejected: empty patch")

    // Every path is resolved and checked before anything is read, so a refusal comes before a question.
    const resolved: { hunk: Hunk; target: string; display: string; moveTarget?: string; moveDisplay?: string }[] = []
    for (const hunk of parsed.hunks) {
      const target = await resolvePath(context, hunk.path, "write")
      const display = relative(context.directory, target)
      guardPlanWrite(context, target, display)
      const movedTo = hunk.type === "update" && hunk.movePath ? await resolvePath(context, hunk.movePath, "write") : undefined
      // A move onto itself is an update in place.
      const moveTarget = movedTo === target ? undefined : movedTo
      const moveDisplay = moveTarget ? relative(context.directory, moveTarget) : undefined
      if (moveTarget) guardPlanWrite(context, moveTarget, moveDisplay!)
      resolved.push({ hunk, target, display, moveTarget, moveDisplay })
    }

    const paths = [...new Set(resolved.flatMap((entry) => [entry.target, ...(entry.moveTarget ? [entry.moveTarget] : [])]))]
    return lockAll(paths, async () => {
      /* What each file will hold, worked out in full before anything is asked or written. */
      const changes: {
        kind: "add" | "update" | "delete"
        target: string
        display: string
        content: string
        before: string
        after: string
        moveTarget?: string
        moveDisplay?: string
        /** What the file moved onto held, when it was already there. */
        moveBefore?: string
      }[] = []
      /*
       * What an earlier section of this patch left at a path: its text, or
       * null where it deleted or moved the file away - which the disk does not
       * know yet, and which a later section must not read past.
       */
      const pending = new Map<string, string | null>()
      const holding = async (target: string, display: string) => (pending.has(target) ? (pending.get(target) ?? undefined) : await currentText(target, display))
      // As a diff reads it: no byte-order mark, LF line ends.
      const plain = (text: string) => (text.startsWith("﻿") ? text.slice(1) : text).replace(/\r\n/g, "\n")
      for (const { hunk, target, display, moveTarget, moveDisplay } of resolved) {
        if (hunk.type === "add") {
          const content = hunk.contents === "" || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`
          const before = (await holding(target, display)) ?? ""
          changes.push({ kind: "add", target, display, content, before: plain(before), after: content })
          pending.set(target, content)
          continue
        }
        const existing = await holding(target, display)
        if (existing === undefined) {
          throw new ToolError(`patch verification failed: ${hunk.type === "delete" ? `Failed to delete ${display}` : `Failed to read file to update ${display}`}: file does not exist`)
        }
        const bom = existing.startsWith("﻿")
        const body = bom ? existing.slice(1) : existing
        const before = body.replace(/\r\n/g, "\n")
        if (hunk.type === "delete") {
          changes.push({ kind: "delete", target, display, content: "", before, after: "" })
          pending.set(target, null)
          continue
        }
        let after: string
        try {
          after = applyChunks(hunk.path, hunk.chunks, before)
        } catch (error) {
          throw new ToolError(`patch verification failed: ${(error as Error).message}`)
        }
        // The file's own line endings and byte-order mark, not the patch's.
        const content = (bom ? "﻿" : "") + (body.includes("\r\n") ? after.replace(/\n/g, "\r\n") : after)
        // A move onto a file that is already there replaces it, so its section starts from what it held.
        const moveBefore = moveTarget ? plain((await holding(moveTarget, moveDisplay!)) ?? "") : undefined
        changes.push({ kind: "update", target, display, content, before, after, moveTarget, moveDisplay, moveBefore })
        if (moveTarget) {
          pending.set(target, null)
          pending.set(moveTarget, content)
        } else pending.set(target, content)
      }

      /*
       * One diff for the whole patch, a section per file. A move is the old
       * file emptied and the new one written over whatever was there, so
       * taking the turn back puts each where it was - the file moved onto
       * included, which undo would otherwise delete as one the turn created.
       */
      const sections = changes.flatMap((change) =>
        change.moveTarget
          ? [unifiedDiff(change.display, change.before, ""), unifiedDiff(change.moveDisplay!, change.moveBefore ?? "", change.after)]
          : [unifiedDiff(change.display, change.before, change.after)],
      )
      const named = [...new Set(changes.flatMap((change) => [change.display, ...(change.moveDisplay ? [change.moveDisplay] : [])]))]
      const { diff, filediff } = changed(named.join(", "), sections.filter(Boolean).join("\n"))

      // memory: memory files are written without asking, as the other writing tools write them.
      if (paths.every((target) => isMemoryPath(target))) {
        // Deliberately silent, so it counts as consulting the gate without a question.
        context.permissions.waive(context.callID)
      } else {
        await context.permissions.ask({
          sessionID: context.sessionID,
          messageID: context.messageID,
          callID: context.callID,
          kind: "edit",
          directory: context.directory,
          title: "Apply patch",
          subject: named.join(", "),
          preview: diff,
        })
      }

      for (const target of paths) await context.snapshot(target)
      const applied: string[] = []
      for (const change of changes) {
        if (change.kind === "delete") {
          await fs.rm(change.target, { force: true })
          applied.push(`D ${change.display}`)
          continue
        }
        const destination = change.moveTarget ?? change.target
        await fs.mkdir(path.dirname(destination), { recursive: true })
        await fs.writeFile(destination, change.content, "utf8")
        if (change.moveTarget) await fs.rm(change.target, { force: true })
        applied.push(`${change.kind === "add" ? "A" : "M"} ${change.moveDisplay ?? change.display}`)
      }
      return {
        // OpenCode v2's own summary of what was done.
        output: ["Success. Updated the following files:", ...applied].join("\n"),
        title: named.join(", "),
        metadata: { path: named.join(", "), diff, filediff, files: named },
      }
    })
  },
}

/** The locks for every file a patch touches, taken in one order so two patches never wait on each other. */
function lockAll<T>(paths: readonly string[], work: () => Promise<T>): Promise<T> {
  const ordered = [...paths].sort()
  const take = (at: number): Promise<T> => (at >= ordered.length ? work() : locked(ordered[at]!, () => take(at + 1)))
  return take(0)
}
