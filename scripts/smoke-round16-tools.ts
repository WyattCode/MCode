/**
 * Round 16 (lane C): what the tools do with code, and the two approval
 * relaxations the user chose.
 *
 * Kept apart from smoke.ts the way the earlier rounds are; smoke.ts calls
 * `roundSixteenToolChecks` with its own check and section. Nothing here reaches
 * the network or the reader's own files: the model is a fake provider on
 * 127.0.0.1, and every transcript read is one this file wrote into a temporary
 * folder of its own.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { FileDiff, ServerEvent, ToolPart } from "../src/shared/protocol"
import { DEFAULT_PERMISSIONS, PERMISSION_KINDS } from "../src/shared/protocol"
import { calls, engine, type Check } from "./smoke-round5"
import { INTERACTIVE_REFUSAL, bashDescription } from "../src/server/tool/bash"
import { changed, trimDiff, unifiedDiff } from "../src/server/diff"
import { EditTool, WriteTool } from "../src/server/tool/edit"
import type { ToolContext } from "../src/server/tool/types"

export async function roundSixteenToolChecks(check: Check, section: (name: string) => void): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-round16c-"))

  // ---------------------------------------------------------------- R16-C1
  section("Round 16 (C1): an interactive command is refused in the model's language, and the reader is told once")
  {
    check(
      "the sentence the model reads is Chinese, as MiMo's is",
      /[一-鿿]/.test(INTERACTIVE_REFUSAL) && !/[A-Za-z]{4,}/.test(INTERACTIVE_REFUSAL.replace(/--yes|-Force|-Confirm|\$false/g, "")),
      INTERACTIVE_REFUSAL,
    )
    check(
      "and it names the ways out rather than only refusing",
      INTERACTIVE_REFUSAL.includes("--yes") && INTERACTIVE_REFUSAL.includes("管道"),
      INTERACTIVE_REFUSAL,
    )

    const e = await engine()
    const session = await e.store.create({ directory: e.project, model: e.model })
    const askOnce = () => e.replies.push(calls([{ name: "bash", input: { command: "sudo apt install something", description: "install", interactive: true } }]))
    askOnce()
    e.replies.push(calls([]))
    await e.runner.prompt({ sessionID: session.id, text: "run it" })
    await e.idle(session.id)
    const noticesOf = (list: ServerEvent[]) => list.filter((event) => event.type === "session.notice" && event.code === "toast.bashInteractive")
    check("the reader is told about the skipped command", noticesOf(e.events).length === 1, noticesOf(e.events))
    check("and the conversation records that it has been told", (await e.store.get(session.id))?.interactiveNotice === true)
    const refused = (await e.assistants(session.id))
      .flatMap((message) => message.parts)
      .find((part): part is ToolPart => part.type === "tool" && part.name === "bash")
    check("the step carries the refusal the model read", refused?.output === INTERACTIVE_REFUSAL, refused?.output)

    askOnce()
    e.replies.push(calls([]))
    await e.runner.prompt({ sessionID: session.id, text: "try again" })
    await e.idle(session.id)
    check("a second one in the same conversation says nothing more", noticesOf(e.events).length === 1, noticesOf(e.events))
    await e.close()
    await fs.rm(e.dir, { recursive: true, force: true }).catch(() => undefined)
  }

  // ---------------------------------------------------------------- R16-C2
  section("Round 16 (C2): the shell tool's description follows the shell in use")
  {
    const powershell = bashDescription("powershell")
    const bash = bashDescription("bash")
    /** The line a description gives over to chaining, which is the one that has to differ. */
    const chaining = (text: string) => text.split("\n").find((line) => line.includes("&&")) ?? ""
    check(
      "Windows PowerShell 5.1 is told that && is not there",
      chaining(powershell).includes("`&&`") && /Windows PowerShell 5\.1 has no such operator/.test(chaining(powershell)),
      chaining(powershell),
    )
    check("and given the form that works instead", chaining(powershell).includes("if ($?)"), chaining(powershell))
    check("a POSIX shell is told to chain with && instead", chaining(bash).includes("&&") && !chaining(bash).includes("if ($?)"), chaining(bash))
    check("each names the shell the command is handed to", powershell.includes("handed to powershell") && bash.includes("handed to bash"))
    check("pwsh, which does have &&, is not treated as Windows PowerShell", !bashDescription("pwsh").includes("if ($?)"))
    check("the two descriptions differ, so one shell's advice is not given for the other", powershell !== bash)
  }

  // ---------------------------------------------------------------- R16-C3
  section("Round 16 (C3): the diff a card shows loses the indentation every line shares, and the one the undo uses does not")
  {
    const deep = "                    keep()\n                    was()\n                    keep2()\n"
    const after = "                    keep()\n                    now()\n                    keep2()\n"
    const patch = unifiedDiff("deep.ts", deep, after)
    const shown = trimDiff(patch)
    check("the shown diff starts its lines at the left", shown.split("\n").some((line) => /^[-+] {0,1}\S/.test(line)), shown)
    check("and the file header is left alone", shown.includes("--- a/deep.ts") && shown.includes("+++ b/deep.ts"), shown)
    check("and so are the hunk headers", shown.includes("@@ -1,4 +1,4 @@"), shown)
    check("the same lines, only moved left", shown.split("\n").length === patch.split("\n").length)
    check("nothing is trimmed when one line already sits at the left", trimDiff(unifiedDiff("f.ts", "a\n  b\n", "a\n  c\n")) === unifiedDiff("f.ts", "a\n  b\n", "a\n  c\n"))
    check(
      "a blank line inside the hunk does not hold the block at zero",
      trimDiff(unifiedDiff("f.ts", "    a\n\n    b\n", "    a\n\n    c\n")).includes("-b"),
      trimDiff(unifiedDiff("f.ts", "    a\n\n    b\n", "    a\n\n    c\n")),
    )
    const { diff, filediff } = changed("deep.ts", patch)
    check("what an edit records for the card is the trimmed one", diff === shown)
    check("and what it records for the undo is the file's own", filediff.patch === patch && filediff.file === "deep.ts")

    const project = path.join(root, "trim")
    await fs.mkdir(project, { recursive: true })
    const target = path.join(project, "deep.ts")
    await fs.writeFile(target, deep, "utf8")
    const asked: string[] = []
    const context = {
      sessionID: "ses_c3",
      messageID: "msg_c3",
      callID: "call_c3",
      directory: project,
      permissions: { ask: async (question: { preview?: string }) => void asked.push(question.preview ?? "") },
      questions: { ask: async () => undefined },
      signal: new AbortController().signal,
      progress: () => {},
      snapshot: async () => undefined,
    } as unknown as ToolContext
    const result = await EditTool.execute({ file_path: "deep.ts", old_string: "was()", new_string: "now()" }, context)
    const recorded = result.metadata as { diff: string; filediff: { patch: string } }
    check("the dialog is shown the trimmed diff too", asked[0] === recorded.diff, asked[0])
    check("the trimmed diff really is shorter than the file's own", recorded.diff.length < recorded.filediff.patch.length, {
      shown: recorded.diff.length,
      patch: recorded.filediff.patch.length,
    })
    check("and the undo still reverses the change from the untrimmed one", applies(recorded.filediff.patch, after, deep), recorded.filediff.patch)
    check("which the trimmed one could not do", !applies(recorded.diff, after, deep), recorded.diff)
  }

  // ---------------------------------------------------------------- R16-C4
  section("Round 16 (C4): an edit or write says how many lines it added and removed")
  {
    const project = path.join(root, "counts")
    await fs.mkdir(project, { recursive: true })
    const context = {
      sessionID: "ses_c4",
      messageID: "msg_c4",
      callID: "call_c4",
      directory: project,
      permissions: { ask: async () => undefined },
      questions: { ask: async () => undefined },
      signal: new AbortController().signal,
      progress: () => {},
      snapshot: async () => undefined,
    } as unknown as ToolContext
    const countsOf = (result: { metadata?: Record<string, unknown> }) => result.metadata?.filediff as FileDiff | undefined

    const made = await WriteTool.execute({ file_path: "fresh.ts", content: "one\ntwo\nthree\n" }, context)
    check("a new file counts every line as added and none removed", countsOf(made)?.additions === 4 && countsOf(made)?.deletions === 0, countsOf(made))
    check("and names the file it changed", countsOf(made)?.file === "fresh.ts", countsOf(made))

    const swapped = await EditTool.execute({ file_path: "fresh.ts", old_string: "two", new_string: "TWO" }, context)
    check("a one-line replacement is one added and one removed", countsOf(swapped)?.additions === 1 && countsOf(swapped)?.deletions === 1, countsOf(swapped))

    const grown = await EditTool.execute({ file_path: "fresh.ts", old_string: "three", new_string: "three\nfour\nfive" }, context)
    check("an edit that only adds lines counts them, and removes nothing", countsOf(grown)?.additions === 2 && countsOf(grown)?.deletions === 0, countsOf(grown))

    const over = await WriteTool.execute({ file_path: "fresh.ts", content: "only\n" }, context)
    check("overwriting counts what went as well as what came", (countsOf(over)?.deletions ?? 0) > (countsOf(over)?.additions ?? 0), countsOf(over))

    const many = await EditTool.execute({ file_path: "fresh.ts", old_string: "only", new_string: "all" }, context)
    check("the numbers are the diff's own, so they cannot drift from what is shown", countsOf(many)?.patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length === countsOf(many)?.additions, countsOf(many))
  }

  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
  void DEFAULT_PERMISSIONS
  void PERMISSION_KINDS
}

/**
 * Whether reversing `patch` turns `after` back into `before`, the way the undo
 * hands it to `git apply --reverse` - the context and removed lines have to
 * match the file as it stands.
 */
function applies(patch: string, after: string, before: string): boolean {
  const lines = after.split("\n")
  const out: string[] = []
  let at = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("---") || line.startsWith("+++")) continue
    const hunk = /^@@ -(\d+),\d+ \+(\d+),\d+ @@/.exec(line)
    if (hunk) {
      while (at < Number(hunk[2]) - 1) out.push(lines[at++])
      continue
    }
    if (line.startsWith("+")) {
      if (lines[at] !== line.slice(1)) return false
      at += 1
    } else if (line.startsWith("-")) {
      out.push(line.slice(1))
    } else if (line.startsWith(" ")) {
      if (lines[at] !== line.slice(1)) return false
      out.push(lines[at++])
    }
  }
  while (at < lines.length) out.push(lines[at++])
  return out.join("\n") === before
}
