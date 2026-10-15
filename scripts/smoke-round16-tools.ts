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
import type { FileDiff, Message, ServerEvent, ToolPart } from "../src/shared/protocol"
import { DEFAULT_PERMISSIONS, PERMISSION_KINDS } from "../src/shared/protocol"
import { calls, engine, type Check } from "./smoke-round5"
import { INTERACTIVE_REFUSAL, bashDescription } from "../src/server/tool/bash"
import { changed, trimDiff, unifiedDiff } from "../src/server/diff"
import { EditTool, WriteTool } from "../src/server/tool/edit"
import { recordRead } from "../src/server/tool/read-tracker"
import type { ToolContext } from "../src/server/tool/types"
import { ListExternalSessionsTool, ReadExternalSessionTool } from "../src/server/tool/external-session"
import { CLAUDE_CODE_AGENT } from "../src/server/external-sessions"
import { findTool, reachOf } from "../src/server/tool/registry"
import { accessAction, defaultAccess } from "../src/shared/access"
import { Bus } from "../src/server/bus"
import { Storage } from "../src/server/storage"
import { Config } from "../src/server/config"
import { turnFilePaths } from "../src/server/session/turn-revert"
import { sessionFiles } from "../src/shared/session-files"

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
    check("and so are the hunk headers", shown.includes("@@ -1,3 +1,3 @@"), shown)
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
    const stamp = await fs.stat(target)
    await recordRead("ses_c3", target, { mtimeMs: stamp.mtimeMs, size: stamp.size }, deep)
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
    check("a new file counts every line as added and none removed", countsOf(made)?.additions === 3 && countsOf(made)?.deletions === 0, countsOf(made))
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

  // ---------------------------------------------------------------- R16-C5
  section("Round 16 (C5): another coding tool's saved conversations can be listed and read, and nothing else of its can")
  {
    const project = path.join(root, "外部 project")
    const elsewhere = path.join(root, "other")
    await fs.mkdir(project, { recursive: true })
    await fs.mkdir(elsewhere, { recursive: true })
    const config = path.join(root, "claude-home")
    const folderOf = (dir: string) => path.resolve(dir).replace(/[^A-Za-z0-9-]/g, "-")
    const write = async (dir: string, id: string, rows: unknown[]) => {
      const folder = path.join(config, "projects", folderOf(dir))
      await fs.mkdir(folder, { recursive: true })
      await fs.writeFile(path.join(folder, `${id}.jsonl`), rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8")
    }
    const said = (role: "user" | "assistant", body: string, at: string, extra: Record<string, unknown> = {}) => ({
      type: role,
      cwd: undefined as string | undefined,
      timestamp: at,
      message: { content: [{ type: "text", text: body }] },
      ...extra,
    })
    await write(project, "sess-one", [
      { ...said("user", "<system-reminder>ignore me</system-reminder>make it work", "2026-09-01T10:00:00Z"), cwd: project },
      said("assistant", "done", "2026-09-01T10:00:05Z"),
      { type: "user", timestamp: "2026-09-01T10:00:06Z", toolUseResult: { ok: true }, message: { content: [{ type: "tool_result", content: "secret-path" }] } },
      { type: "assistant", timestamp: "2026-09-01T10:00:07Z", message: { content: [{ type: "tool_use", name: "bash", input: { command: "rm -rf /" } }] } },
      "{ this line is broken",
    ])
    await write(elsewhere, "sess-two", [{ ...said("user", "somewhere else", "2026-09-02T10:00:00Z"), cwd: elsewhere }])

    const previous = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = config
    try {
      const context = (directory: string) =>
        ({
          sessionID: "ses_c5",
          messageID: "msg_c5",
          callID: "call_c5",
          directory,
          permissions: { ask: async () => undefined },
          questions: { ask: async () => undefined },
          signal: new AbortController().signal,
          progress: () => {},
          snapshot: async () => undefined,
        }) as unknown as ToolContext

      const listed = await ListExternalSessionsTool.execute({ agent_id: CLAUDE_CODE_AGENT }, context(project))
      check("this project's session is listed", listed.output.includes("session_id=sess-one"), listed.output)
      check("and another project's is not", !listed.output.includes("sess-two"), listed.output)
      check("the first thing the user said is there, without the harness's own text", listed.output.includes("make it work") && !listed.output.includes("ignore me"), listed.output)
      check("and the damaged line cost only itself", (listed.metadata as { count: number }).count === 1, listed.metadata)

      const everywhere = await ListExternalSessionsTool.execute({ agent_id: CLAUDE_CODE_AGENT, all_projects: true }, context(project))
      check("all_projects reaches the other project too", everywhere.output.includes("sess-two"), everywhere.output)

      const stranger = await ListExternalSessionsTool.execute({ agent_id: "ext:something-else" }, context(project))
      check("an agent this app cannot read is answered, not failed", stranger.output.includes(CLAUDE_CODE_AGENT) && stranger.output.startsWith("No external agent"), stranger.output)

      const read = await ReadExternalSessionTool.execute({ agent_id: CLAUDE_CODE_AGENT, session_id: "sess-one" }, context(project))
      check("reading gives back what was said", read.output.includes("make it work") && read.output.includes("done"), read.output)
      check("and leaves the tool calls out by default", !read.output.includes("rm -rf /") && !read.output.includes("secret-path"), read.output)

      const withTools = await ReadExternalSessionTool.execute({ agent_id: CLAUDE_CODE_AGENT, session_id: "sess-one", include_tools: true }, context(project))
      check("include_tools hands them over when asked for", withTools.output.includes("rm -rf /") && withTools.output.includes("secret-path"), withTools.output)

      const capped = await ReadExternalSessionTool.execute({ agent_id: CLAUDE_CODE_AGENT, session_id: "sess-one", max_messages: 1 }, context(project))
      check("max_messages holds the answer down and says it was cut", capped.output.includes("done") === false && capped.output.includes("Cut at the size limit"), capped.output)

      const foreign = await ReadExternalSessionTool.execute({ agent_id: CLAUDE_CODE_AGENT, session_id: "sess-two" }, context(project))
      check("a session from another project is not readable from this one", foreign.output.startsWith("No Claude Code conversation") && foreign.output.includes("this project"), foreign.output)

      const traversal = await ReadExternalSessionTool.execute({ agent_id: CLAUDE_CODE_AGENT, session_id: "../../../etc/passwd" }, context(project))
      check("an id that is really a path finds nothing", traversal.output.includes("No Claude Code conversation"), traversal.output)

      const noProject = await ListExternalSessionsTool.execute({ agent_id: CLAUDE_CODE_AGENT }, context(""))
      check("a conversation with no project folder is told to say so rather than sweeping the machine", noProject.output.includes("all_projects"), noProject.output)

      check("both tools are offered, and both only read", findTool("list_external_sessions") !== undefined && reachOf("read_external_session") === "reads")
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previous
    }
  }

  // ---------------------------------------------------------------- R16-C6
  section("Round 16 (C6): creating a file is judged as an edit, and fetching a page no longer asks")
  {
    check("there is no write bucket any more", !(PERMISSION_KINDS as readonly string[]).includes("write"), PERMISSION_KINDS)
    check("and the write tool is judged by the edit one", WriteTool.permission === "edit" && EditTool.permission === "edit")
    check("fetching a page runs without asking", DEFAULT_PERMISSIONS.webfetch === "allow", DEFAULT_PERMISSIONS)
    check("while changing a file and running a command still ask", DEFAULT_PERMISSIONS.edit === "ask" && DEFAULT_PERMISSIONS.bash === "ask")
    check("so the default level is still the default level, not full access", defaultAccess({ permissions: { ...DEFAULT_PERMISSIONS } }) === "ask")
    check("a refusal of edits refuses a creation too", accessAction("edit", "ask", { permissions: { ...DEFAULT_PERMISSIONS, edit: "deny" } }) === "deny")
    check("and full access does not undo a refusal of the network", accessAction("webfetch", "full", { permissions: { ...DEFAULT_PERMISSIONS, webfetch: "deny" } }) === "deny")

    const project = path.join(root, "buckets")
    await fs.mkdir(project, { recursive: true })
    const asked: string[] = []
    const context = {
      sessionID: "ses_c6",
      messageID: "msg_c6",
      callID: "call_c6",
      directory: project,
      permissions: { ask: async (question: { kind: string }) => void asked.push(question.kind) },
      questions: { ask: async () => undefined },
      signal: new AbortController().signal,
      progress: () => {},
      snapshot: async () => undefined,
    } as unknown as ToolContext
    await WriteTool.execute({ file_path: "made.ts", content: "x\n" }, context)
    await EditTool.execute({ file_path: "made.ts", old_string: "x", new_string: "y" }, context)
    check("both calls put their question in the same bucket", asked.join(",") === "edit,edit", asked)

    // A config carrying the answers the two buckets used to have.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r16c6-"))
    const storage = new Storage(path.join(dir, "storage"))
    await storage.write("config", {
      migrations: ["orphans-r9", "mcp-allow-r9"],
      permissions: { ...DEFAULT_PERMISSIONS, edit: "ask", write: "deny", webfetch: "ask" },
    })
    const config = new Config(storage, new Bus(), path.join(dir, "credentials.json"))
    await config.load()
    const after = config.get().permissions
    check("a refusal of writes becomes a refusal of edits rather than vanishing", after.edit === "deny", after)
    check("and the old default for the network moves to the new one", after.webfetch === "allow", after)
    check("nothing on disk still says write", !JSON.stringify(JSON.parse(await fs.readFile(path.join(dir, "storage", "config.json"), "utf8")).permissions).includes("write"), await fs.readFile(path.join(dir, "storage", "config.json"), "utf8"))

    const chosen = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r16c6b-"))
    const chosenStorage = new Storage(path.join(chosen, "storage"))
    await chosenStorage.write("config", { migrations: ["orphans-r9", "mcp-allow-r9"], permissions: { ...DEFAULT_PERMISSIONS, webfetch: "deny" } })
    const chosenConfig = new Config(chosenStorage, new Bus(), path.join(chosen, "credentials.json"))
    await chosenConfig.load()
    check("a refusal of the network is a choice and is left alone", chosenConfig.get().permissions.webfetch === "deny", chosenConfig.get().permissions)
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    await fs.rm(chosen, { recursive: true, force: true }).catch(() => undefined)
  }

  // ---------------------------------------------------------------- R16-C7
  section("Round 16 (C7): nothing branches on a tool this app does not have")
  {
    // `patch` came back in R31-7 (OpenCode v2's, offered to GPT models); round 31 section 7 checks it.
    for (const name of ["apply_patch", "todowrite", "multiedit"]) {
      check(`${name} is not a tool here`, findTool(name) === undefined)
    }
    const part = (name: string, metadata: Record<string, unknown>, input: Record<string, unknown> = {}) => ({
      type: "tool" as const,
      id: name,
      callID: name,
      name,
      status: "completed" as const,
      input,
      metadata,
      time: { created: 0, completed: 0 },
    })
    const turn = {
      id: "m",
      sessionID: "s",
      role: "assistant" as const,
      model: { provider: "p", model: "m" },
      agent: "build" as const,
      time: { created: 0 },
      parts: [
        part("multiedit", { diff: unifiedDiff("from-multiedit.txt", "", "new\n") }),
        part("apply_patch", { files: ["from-apply-patch.txt"] }),
        part("edit", { diff: unifiedDiff("real.txt", "a\n", "b\n") }, { file_path: "made.txt" }),
      ],
    } as unknown as Message
    const undoable = turnFilePaths(root, [turn])
    check("the undo does not go looking for a file a tool that is not here reported", undoable.length === 1 && undoable[0].endsWith("real.txt"), undoable)
    const touched = sessionFiles([turn], root).written.map((entry) => entry.path)
    check("and neither does the record of what a conversation changed", touched.length === 1 && touched[0] === "made.txt", touched)
  }

  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
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
