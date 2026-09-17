/**
 * Round 10, the file tools as MiMo's engine runs them: glob and grep through
 * the bundled ripgrep (and the walk that stands in for it), read's media and
 * instructions, and the edges of write, edit and notebook_edit. Kept apart
 * from smoke.ts the way the earlier rounds are; smoke.ts calls
 * `roundTenFileChecks` with its own check and section.
 */
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Check } from "./smoke-round5"
import type { ToolContext } from "../src/server/tool/types"
import { findTool } from "../src/server/tool/registry"
import { ripgrepBinary } from "../src/server/tool/search"

type Result = { output: string; error?: string; metadata?: Record<string, unknown> }

/** A tool context that allows whatever it is asked, for calling tools directly. */
export function toolContext(directory: string, extra: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionID: "ses_r10files",
    messageID: "msg_r10files",
    callID: `call_${Math.random().toString(36).slice(2)}`,
    directory,
    permissions: { allowsOutside: () => true, ask: async () => undefined } as never,
    questions: {} as never,
    signal: new AbortController().signal,
    progress: () => {},
    snapshot: async () => {},
    ...extra,
  }
}

export async function runTool(name: string, input: Record<string, unknown>, context: ToolContext): Promise<Result> {
  return findTool(name)!
    .execute(input, context)
    .then(
      (result) => ({ output: result.output, metadata: result.metadata }),
      (error: Error) => ({ output: "", error: error.message }),
    )
}

async function put(root: string, rel: string, data: string | Buffer) {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
  await fs.writeFile(path.join(root, rel), data)
}

const posix = (text: string) => text.split("\\").join("/")

export async function roundTenFileChecks(check: Check, section: (name: string) => void): Promise<void> {
  const bundled = path.join(process.cwd(), "resources", "runtimes", `${process.platform}-${process.arch}`, "ripgrep", process.platform === "win32" ? "rg.exe" : "rg")
  const before = process.env.MCODE_RIPGREP_PATH

  // ------------------------------------------------------------ T10-9, T10-10, T10-26, T10-27, T10-29
  const engines: { label: string; env: string | undefined }[] = [
    ...(existsSync(bundled) ? [{ label: "ripgrep", env: bundled }] : []),
    { label: "the walk that stands in for it", env: undefined },
  ]
  if (!existsSync(bundled)) check("the bundled ripgrep is in resources/runtimes for these checks", false, bundled)
  for (const engine of engines) {
    section(`Round 10 (T10-9/10/26/27/29): glob and grep through ${engine.label}`)
    if (engine.env) process.env.MCODE_RIPGREP_PATH = engine.env
    else delete process.env.MCODE_RIPGREP_PATH
    check("the engine in use is the one named", (ripgrepBinary() !== undefined) === Boolean(engine.env))
    const tree = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r10-search-"))
    try {
      await put(tree, ".git/HEAD", "needle\n")
      await put(tree, "nested/.git/config", "needle\n")
      await put(tree, ".gitignore", "*.log\n.env\nnode_modules/\n")
      await put(tree, "debug.log", "needle\n")
      await put(tree, ".env", "SECRETISH=needle\n")
      await put(tree, "node_modules/x/deep.log", "needle\n")
      await put(tree, "src/crlf.ts", "Needle\r\nfoo\r\n")
      await put(tree, "src/names.ts", "变量\n")
      await put(tree, "u16.txt", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("needle in utf16\n", "utf16le")]))
      await put(tree, "blob.bin", Buffer.from("needle\0binary\n"))
      await put(tree, "two.txt", "needle a\r\nneedle b\r\n")
      await put(tree, "gbk.txt", Buffer.from([0xd6, 0xd0, 0x20, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x0a]))
      const at = toolContext(tree)
      const glob = async (input: Record<string, unknown>) => posix((await runTool("glob", input, at)).output)
      const grep = (input: Record<string, unknown>) => runTool("grep", input, at)

      const logs = await glob({ pattern: "*.log" })
      check("glob *.log finds a .gitignore'd file, as ripgrep's --glob outranks the ignore file", logs.includes("/debug.log"), logs)
      check("but does not look inside an ignored folder the pattern does not name", !logs.includes("deep.log"), logs)
      check("glob .env finds the ignored .env by name", (await glob({ pattern: ".env" })).includes("/.env"))
      const every = await glob({ pattern: "**" })
      check("no .git is listed, at any depth", !every.includes("/.git/") && !every.includes("nested/.git"), every)
      const plain = posix((await grep({ pattern: "needle" })).output)
      check("a plain grep leaves ignored files out", !plain.includes(".env") && !plain.includes("debug.log"), plain)
      check("and skips a binary file found on the way", !plain.includes("blob.bin"), plain)
      check("but searches a UTF-16 file with a byte-order mark", plain.includes("u16.txt:\n  Line 1: needle in utf16"), plain)
      check("a matched line carries no line break of its own", plain.includes("two.txt:\n  Line 1: needle a\n  Line 2: needle b") && !plain.includes("\r"), JSON.stringify(plain))
      const env = posix((await grep({ pattern: "needle", include: ".env" })).output)
      check("grep's include searches an ignored file it names (the user's T10-10 decision)", env.includes(".env:\n  Line 1: SECRETISH=needle"), env)
      const named = (await grep({ pattern: "needle", path: "blob.bin" })).output
      check("a binary file named outright is still searched", named.startsWith("Found 1 matches"), named)
      check("(?i) makes the pattern case-insensitive", posix((await grep({ pattern: "(?i)^NEEDLE", path: "src" })).output).includes("crlf.ts"))
      const dollar = await grep({ pattern: "foo$", path: "src" })
      check("$ does not match before a carriage return, as in ripgrep", dollar.output === "No files found", dollar)
      check("POSIX classes are understood", (await grep({ pattern: "^[[:upper:]]+[[:punct:]]needle", include: ".env" })).output.startsWith("Found 1"))
      check("named groups written (?P<n>...) are understood", (await grep({ pattern: "(?P<word>foo)", path: "src" })).output.startsWith("Found 1"))
      if (engine.env) {
        check("\\w understands Unicode", (await grep({ pattern: "^\\w+$", path: "src/names.ts" })).output.startsWith("Found 1"))
        const gbk = await grep({ pattern: "needle", path: "gbk.txt" })
        check("a line that is not UTF-8 is shown, not a failed call", gbk.output.startsWith("Found 1") && gbk.output.includes("needle"), gbk)
      }
      const bad = await grep({ pattern: "(unclosed" })
      check("a pattern that does not parse is an error the model reads", Boolean(bad.error?.includes("Invalid regular expression")), bad)
      const missingGlob = await runTool("glob", { pattern: "*", path: "no-such-dir" }, at)
      check("glob in a folder that does not exist is an error, not 'No files found'", Boolean(missingGlob.error?.includes("No such folder")), missingGlob)
      const missingGrep = await grep({ pattern: "x", path: "no-such-dir/file.txt" })
      check("so is grep in one, when the file's folder is missing too", Boolean(missingGrep.error?.includes("No such folder")), missingGrep)
      const missingFile = await grep({ pattern: "x", path: "src/none.txt" })
      check("a missing file in a folder that exists finds nothing, as MiMo's does", missingFile.output === "No files found", missingFile)
      const stop = new AbortController()
      stop.abort()
      const stoppedGlob = await runTool("glob", { pattern: "*" }, toolContext(tree, { signal: stop.signal }))
      const stoppedGrep = await runTool("grep", { pattern: "needle" }, toolContext(tree, { signal: stop.signal }))
      check("a stopped glob fails instead of returning what it had", Boolean(stoppedGlob.error?.includes("stopped")), stoppedGlob)
      check("so does a stopped grep", Boolean(stoppedGrep.error?.includes("stopped")), stoppedGrep)
    } finally {
      await fs.rm(tree, { recursive: true, force: true })
    }
  }
  if (before === undefined) delete process.env.MCODE_RIPGREP_PATH
  else process.env.MCODE_RIPGREP_PATH = before

  // ------------------------------------------------------------ T10-12
  section("Round 10 (T10-12): the whole git repository counts as inside the project, as MiMo's worktree does")
  {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r10-repo-"))
    try {
      await put(base, "repo/.git/HEAD", "ref: refs/heads/main\n")
      await put(base, "repo/pkg/a.txt", "inside\n")
      await put(base, "repo/other/b.txt", "sibling\n")
      await put(base, "elsewhere/c.txt", "outside\n")
      const asked: string[] = []
      const permissions = { allowsOutside: () => false, ask: async (request: { kind?: string; scope?: string }) => void (request.kind === "outside" && asked.push(String(request.scope))) }
      const at = toolContext(path.join(base, "repo", "pkg"), { permissions: permissions as never })
      const sibling = await runTool("read", { file_path: "../other/b.txt" }, at)
      check("a file elsewhere in the repository is read without asking", sibling.output.includes("1: sibling") && asked.length === 0, { sibling, asked })
      const edited = await runTool("edit", { file_path: path.join(base, "repo", "other", "b.txt"), old_string: "sibling", new_string: "changed" }, at)
      check("and edited without the outside-the-project question (only the edit's own)", !edited.error && asked.length === 0, { edited, asked })
      const outside = await runTool("read", { file_path: path.join(base, "elsewhere", "c.txt") }, at)
      check("a file outside the repository still asks", outside.output.includes("1: outside") && asked.length === 1, { outside, asked })
      const loose = toolContext(path.join(base, "elsewhere"), { permissions: permissions as never })
      await runTool("read", { file_path: path.join(base, "repo", "pkg", "a.txt") }, loose)
      check("and a conversation outside any repository keeps to its own folder", asked.length === 2, asked)
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  }
}
