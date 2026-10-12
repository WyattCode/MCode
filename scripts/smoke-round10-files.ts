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
import { calls, engine, say } from "./smoke-round5"
import type { ToolContext, ToolResult } from "../src/server/tool/types"
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
  /*
   * resources/runtimes is filled by scripts/runtimes.mjs, which builds
   * win32-x64 only, so a Linux or macOS checkout - or one that has not run it -
   * has no bundled ripgrep. There the ripgrep pass is skipped with a visible
   * line and the walk is still checked; where the runtime is required
   * (MCODE_REQUIRE_RUNTIMES=1, or CI on Windows) its absence still fails.
   */
  if (!existsSync(bundled)) {
    if (process.env.MCODE_REQUIRE_RUNTIMES === "1" || (process.platform === "win32" && !!process.env.CI)) check("the bundled ripgrep is in resources/runtimes for these checks", false, bundled)
    else console.log(`  skip the bundled-ripgrep pass: ${bundled} is not in this checkout (scripts/runtimes.mjs builds win32-x64)`)
  }
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

  // ------------------------------------------------------------ T10-8, T10-28, T10-33
  section("Round 10 (T10-8, T10-28, T10-33): read's media - by content, told what to do instead, kept as read")
  {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r10-media-"))
    try {
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)])
      const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 2)])
      await put(base, "photo.png", jpeg)
      await put(base, "noext", png)
      await put(base, "old.bmp", Buffer.concat([Buffer.from("BM"), Buffer.alloc(60, 0)]))
      await put(base, "phone.heic", Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(20, 0)]))
      await put(base, "doc.pdf", Buffer.from("%PDF-1.4\n%binary\n"))
      await put(base, "notes.bmp", "BMW service notes\n")
      const copies = path.join(base, "copies")
      const kept: string[] = []
      const { keepReadCopy } = await import("../src/server/tool/read-media")
      const seeing = { inputs: { image: true, pdf: true, audio: false, video: false } }
      const at = (model: { inputs: Record<string, boolean>; vision?: string } = seeing) =>
        toolContext(base, {
          model: async () => model,
          keepCopy: async (source, bytes) => {
            const copy = await keepReadCopy(copies, source, bytes)
            kept.push(copy)
            return copy
          },
        })
      const read = (file: string, context = at()) =>
        findTool("read")!
          .execute({ file_path: file }, context)
          .catch((error: Error): ToolResult => ({ output: `ERROR ${error.message}` }))

      const disguised = await read("photo.png")
      check("a JPEG named .png is attached as the JPEG it is", disguised.attachments?.[0]?.mime === "image/jpeg", disguised.attachments)
      const bare = await read("noext")
      check("a picture with no extension is attached by its first bytes", bare.attachments?.[0]?.mime === "image/png", bare)
      const bmp = await read("old.bmp")
      check("a BMP is not attached, and the model is told which formats read takes and to convert", !bmp.attachments?.length && bmp.output.includes("PNG, JPEG, WebP and GIF") && bmp.output.includes("ffmpeg"), bmp.output)
      const heic = await read("phone.heic")
      check("so is a HEIC photo", !heic.attachments?.length && heic.output.includes("image/heic"), heic.output)
      const text = await read("notes.bmp")
      check("a text file that happens to start with BM is still read as text", text.output.includes("1: BMW service notes"), text.output)

      const blind = await read("photo.png", at({ inputs: { image: false, pdf: true }, vision: "prov/seer" }))
      check("a model that cannot see gets no picture, and is told to hand it to a subagent with a model that can", !blind.attachments?.length && blind.output.includes('model "prov/seer"') && blind.output.includes("actor"), blind.output)
      const blindNone = await read("photo.png", at({ inputs: { image: false } }))
      check("with no such model connected, it is told to ask for one or use OCR", blindNone.output.includes("OCR"), blindNone.output)
      const noPdf = await read("doc.pdf", at({ inputs: { image: true, pdf: false } }))
      check("a model without PDF input is pointed at the built-in pdf skill", !noPdf.attachments?.length && noPdf.output.includes("pdf skill"), noPdf.output)
      await put(base, "clip.mp4", Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(20, 0)]))
      const noVideo = await read("clip.mp4")
      check("a model without video input is told to switch or use ffprobe", !noVideo.attachments?.length && noVideo.output.includes("ffprobe"), noVideo.output)

      const big = path.join(base, "huge.pdf")
      await fs.writeFile(big, "%PDF-1.4\n")
      await fs.truncate(big, 51 * 1024 * 1024)
      const huge = await read("huge.pdf")
      check("a PDF over 50 MB is not read, and the result says so", !huge.attachments?.length && huge.output.includes("It was not read"), huge.output)
      const wide = path.join(base, "wide.png")
      await fs.writeFile(wide, png)
      await fs.truncate(wide, 51 * 1024 * 1024)
      const oversized = await read("wide.png")
      check("a picture over 50 MB that cannot be made smaller here is not attached", !oversized.attachments?.length && oversized.output.includes("could not be made smaller"), oversized.output)
      await fs.rm(big)
      await fs.rm(wide)

      // T10-33: the copy stands for the file from then on.
      const first = await read("photo.png")
      const copy = first.attachments?.[0]?.copy
      check("the attachment carries a copy taken at read time, named as the file", Boolean(copy) && path.basename(copy!) === "photo.png" && (await fs.readFile(copy!)).equals(jpeg), first.attachments)
      await fs.writeFile(path.join(base, "photo.png"), png)
      const { withAttachmentData } = await import("../src/server/session/attachments")
      const history = [
        {
          id: "m1",
          sessionID: "s",
          role: "assistant",
          parts: [{ type: "tool", id: "p1", callID: "c1", name: "read", status: "completed", input: {}, output: first.output, attachments: first.attachments, time: { created: 1 } }],
          time: { created: 1 },
        },
      ] as never
      const sent = (await withAttachmentData(history, base, new Map())) as unknown as { parts: { attachments: { data: string; mime: string }[] }[] }[]
      const carried = sent[0]!.parts[0]!.attachments[0]!
      check("a later request sends what was read, not what the file holds now", Buffer.from(carried.data, "base64").equals(jpeg) && carried.mime === "image/jpeg", carried.mime)
      await fs.rm(path.join(base, "photo.png"))
      const gone = (await withAttachmentData(history, base, new Map())) as unknown as { parts: { attachments: { data: string; note?: string }[] }[] }[]
      check("and still does after the file is deleted", Buffer.from(gone[0]!.parts[0]!.attachments[0]!.data, "base64").equals(jpeg), gone[0]!.parts[0]!.attachments[0]!.note)
      const again = await keepReadCopy(copies, path.join(base, "photo.png"), jpeg)
      check("the same bytes are kept once", again === copy)

      const { settleAttachments } = await import("../src/server/session/attachments")
      await put(base, "shot.png", jpeg)
      const settled = await settleAttachments([{ path: "shot.png", mime: "", data: "", byPath: true }], base)
      check("a user's attachment is typed by its first bytes too", settled[0]?.mime === "image/jpeg", settled)
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  }

  section("Round 10 (T10-28, T10-33, T10-11): the runner gives read the model, a place for copies and the history")
  {
    const e = await engine({ custom: { models: [{ id: "m", name: "M" }, { id: "seer", name: "Seer", attachment: true }] } })
    try {
      const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 3)])
      await put(e.project, "pic.png", jpeg)
      await put(e.project, "sub/AGENTS.md", "sub rule\n")
      await put(e.project, "sub/a.txt", "a\n")
      const session = await e.store.create({ directory: e.project, model: e.model })
      e.replies.push(calls([{ name: "read", input: { file_path: "pic.png" } }]))
      e.replies.push(calls([{ name: "read", input: { file_path: "sub/a.txt" } }]))
      e.replies.push(calls([{ name: "read", input: { file_path: "sub/a.txt", offset: 1 } }]))
      e.replies.push(say("done"))
      await e.runner.prompt({ sessionID: session.id, text: "READS" })
      await e.idle(session.id)
      const parts = (await e.assistants(session.id)).flatMap((message) => message.parts).filter((part) => part.type === "tool")
      const [pic, first, second] = parts.map((part) => (part.type === "tool" ? part : undefined))
      check("a model without image input is told at read time, and pointed at the connected model that sees", Boolean(pic?.output.includes("cannot see pictures") && pic.output.includes('model "fake/seer"') && !pic.attachments?.length), pic?.output)
      check("the next step's read carries the folder's instructions", Boolean(first?.output.includes("sub rule")), first?.output)
      check("and a read in a later step does not repeat them, judged from the history", Boolean(second && !second.output.includes("sub rule")), second?.output)

      await e.store.update(session.id, { model: { provider: "fake", model: "seer" } })
      e.replies.push(calls([{ name: "read", input: { file_path: "pic.png" } }]))
      e.replies.push(say("done"))
      await e.runner.prompt({ sessionID: session.id, text: "LOOK" })
      await e.idle(session.id)
      const seen = (await e.assistants(session.id)).flatMap((message) => message.parts).filter((part) => part.type === "tool").at(-1)
      const copy = seen?.type === "tool" ? seen.attachments?.[0]?.copy : undefined
      check(
        "a model that sees gets the picture, from a copy kept under the app's data folder",
        Boolean(copy && copy.startsWith(path.join(e.dir, "data", "storage", "read-media")) && (await fs.readFile(copy)).equals(jpeg)),
        copy ?? seen,
      )
    } finally {
      await e.close()
    }
  }

  // ------------------------------------------------------------ T10-30, T10-31, T10-32
  section("Round 10 (T10-30, T10-31, T10-32): notebooks with a BOM, reads that fail before a write, closer hints")
  {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r10-edit-"))
    try {
      const notebook = { cells: [{ id: "abc", cell_type: "code", source: ["x = 1"], metadata: {}, outputs: [], execution_count: null }], metadata: {}, nbformat: 4, nbformat_minor: 5 }
      await put(base, "nb.ipynb", `\uFEFF${JSON.stringify(notebook, null, 1)}\n`)
      const asked: string[] = []
      const at = toolContext(base, { permissions: { allowsOutside: () => true, ask: async (request: { title?: string }) => void asked.push(String(request.title)) } as never })
      const edited = await runTool("notebook_edit", { notebook_path: "nb.ipynb", cell_id: "abc", new_source: "x = 2" }, at)
      const written = await fs.readFile(path.join(base, "nb.ipynb"), "utf8")
      check("a notebook that starts with a byte-order mark is edited, not refused as bad JSON", !edited.error && written.includes('"x = 2"'), edited)
      check("and keeps its mark", written.startsWith("\uFEFF") && JSON.stringify(JSON.parse(written.slice(1)).cells[0].source).includes("x = 2"), written.slice(0, 20))

      await fs.mkdir(path.join(base, "folder"))
      asked.length = 0
      const intoFolder = await runTool("write", { file_path: "folder", content: "x" }, at)
      check("write to a folder is refused before anything is asked", Boolean(intoFolder.error?.includes("is a folder")) && asked.length === 0, { intoFolder, asked })
      const editFolder = await runTool("edit", { file_path: "folder", old_string: "", new_string: "x" }, at)
      check("so is an edit with nothing to find", Boolean(editFolder.error?.includes("is a folder")) && asked.length === 0, { editFolder, asked })
      await put(base, "file.txt", "x")
      const underFile = await runTool("write", { file_path: "file.txt/inner.txt", content: "x" }, at)
      check("a path that runs through a file is an error, not a new file", Boolean(underFile.error?.includes("could not be read")) && asked.length === 0, { underFile, asked })
      asked.length = 0
      const fresh = await runTool("write", { file_path: "new/fresh.txt", content: "hello" }, at)
      check("a path that does not exist is still a new file", !fresh.error && fresh.metadata?.created === true && asked.join() === "Create file", { fresh, asked })

      const { closestMatch } = await import("../src/server/tool/edit")
      const code = "function run() {\n  const a = 1\n  const b = 2\n  return a + b\n}\n"
      check("BlockAnchor: first and last lines agree, the middle differs", closestMatch(code, "function run() {\n  const a = 10\n  return a + b\n}") === "function run() {\n  const a = 1\n  const b = 2\n  return a + b\n}")
      check("IndentationFlexible: the whole quote is indented differently", closestMatch("class A {\n    go() {\n        x()\n    }\n}\n", "go() {\n    x()\n}") === "    go() {\n        x()\n    }")
      check("TrimmedBoundary: blank space around the quote", closestMatch(code, "\n\n  const b = 2   \n\n") === "const b = 2")
      check("EscapeNormalized: escapes written for the characters", closestMatch('say("hi")\nnext\n', 'say(\\"hi\\")\\nnext') === 'say("hi")\nnext')
      check("ContextAware: anchored, most of the middle agreeing", closestMatch("a {\n  one\n  two\n  three\n}\n", "a {\n  one\n  TWO\n  three\n}") === "a {\n  one\n  two\n  three\n}")
      const miss = await runTool("edit", { file_path: "file.txt", old_string: "nothing like it at all", new_string: "y" }, at)
      check("and a quote like nothing in the file gets no hint", Boolean(miss.error) && !miss.error!.includes("closest text"), miss)
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  }

  section("Round 10: an edit that creates a file counts as created in the edited-files card")
  {
    const { editedFiles } = await import("../src/renderer/src/lib/edited-files")
    const diff = "--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+x\n"
    const part = (name: string, created: boolean) => ({ type: "tool", name, status: "completed", metadata: { diff, created } }) as never
    check("an edit that created the file", editedFiles([part("edit", true)]).files[0]?.created === true, editedFiles([part("edit", true)]))
    check("an edit that changed one does not", editedFiles([part("edit", false)]).files[0]?.created === false)
  }

  // ------------------------------------------------------------ T10-11
  section("Round 10 (T10-11): read's folder instructions are judged from the history the request still sends")
  {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r10-instr-"))
    try {
      await put(base, "proj/AGENTS.md", "root rule\n")
      await put(base, "proj/sub/AGENTS.md", "sub rule\n")
      await put(base, "proj/sub/a.txt", "one\ntwo\n")
      await put(base, "proj/sub/pic.png", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(10, 1)]))
      await put(base, "projx/AGENTS.md", "neighbour rule\n")
      await put(base, "projx/b.txt", "b\n")
      const project = path.join(base, "proj")
      const given = new Set<string>()
      const at = (messageID: string) => toolContext(project, { messageID, instructionsGiven: async () => given })
      const rule = path.join(project, "sub", "AGENTS.md")

      const failed = await runTool("read", { file_path: "sub/a.txt", offset: 9 }, at("m1"))
      check("a read that fails on its offset", Boolean(failed.error?.includes("past the end")), failed)
      const first = await runTool("read", { file_path: "sub/a.txt" }, at("m1"))
      check("claims nothing, so the next read still carries the folder's instructions", first.output.includes("sub rule") && !first.output.includes("root rule"), first.output)
      check("and names them as loaded", JSON.stringify(first.metadata?.loaded) === JSON.stringify([rule]), first.metadata)
      const sameStep = await runTool("read", { file_path: "sub/a.txt", offset: 2 }, at("m1"))
      check("a second read in the same reply does not repeat them", !sameStep.output.includes("sub rule"), sameStep.output)
      given.add(rule)
      const later = await runTool("read", { file_path: "sub/a.txt" }, at("m2"))
      check("a later reply whose history still carries them does not get them again", !later.output.includes("sub rule"), later.output)
      given.clear()
      const cleared = await runTool("read", { file_path: "sub/a.txt" }, at("m3"))
      check("once the history no longer carries them - cleared, compacted, or a new launch - they are given again", cleared.output.includes("sub rule"), cleared.output)
      const media = await runTool("read", { file_path: "sub/pic.png" }, at("m4"))
      check("a read of a picture carries them too", media.output.includes("sub rule") && JSON.stringify(media.metadata?.loaded) === JSON.stringify([rule]), media)
      const neighbour = await runTool("read", { file_path: path.join(base, "projx", "b.txt") }, at("m5"))
      check("a folder whose name only starts with the project's is not inside it", !neighbour.output.includes("neighbour rule"), neighbour.output)

      const { instructionsIn } = await import("../src/server/tool/read")
      const { clearedNote } = await import("../src/server/session/prune")
      const part = (output: string, status = "completed") => ({ type: "tool", name: "read", status, output, metadata: { loaded: [rule] } })
      const history = (p: unknown) => [{ role: "assistant", parts: [p] }] as never
      check("the history counts a completed read's loaded files", instructionsIn(history(part("x"))).has(rule))
      check("but not a failed read's", !instructionsIn(history(part("x", "error"))).has(rule))
      check("nor one whose output pruning cleared", !instructionsIn(history(part(clearedNote("read")))).has(rule))
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  }
}
