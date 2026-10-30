/**
 * Round 10, part B: bash, webfetch and the shell around every tool call,
 * measured against MiMo's engine.
 *
 * Kept apart from smoke.ts the way the earlier rounds are; smoke.ts calls
 * `roundTenBashChecks` with its own check and section. Nothing here reaches
 * the network: webfetch is pointed at a server this file starts on 127.0.0.1,
 * and the model is a fake provider on the same machine.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { Check } from "./smoke-round5"
import type { ToolPart } from "../src/shared/protocol"
import { Bus } from "../src/server/bus"
import { Storage } from "../src/server/storage"
import { Config } from "../src/server/config"
import { Permissions, PermissionDenied } from "../src/server/permission"
import { SessionStore } from "../src/server/session/store"
import { SessionRunner } from "../src/server/session/runner"
import { BashTool, OutputDecoder, PREVIEW_CHARS, PROGRESS_EVERY_MS, awaitBashShellWarm, bashShellIsWarmed, gitIdentityEnv, prewarmBashShell, shell } from "../src/server/tool/bash"
import { WebFetchTool, htmlToMarkdown, imageAttachment } from "../src/server/tool/webfetch"
import { ToolOutputs } from "../src/server/tool/truncate"
import { windowsPath } from "../src/server/shell-path"
import type { ToolContext, ToolResult } from "../src/server/tool/types"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** "中文输出" as GBK writes it. */
const GBK_BYTES = [0xd6, 0xd0, 0xce, 0xc4, 0xca, 0xe4, 0xb3, 0xf6]

/** The console's code page, as the tool asks for it. */
function codePage(): string | undefined {
  if (process.platform !== "win32") return undefined
  try {
    return /(\d{3,5})/.exec(execFileSync("chcp.com", { windowsHide: true }).toString("latin1"))?.[1]
  } catch {
    return undefined
  }
}

/** A fixed-shape answer from the local server. */
function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ server: Server; base: string }> {
  const server = createServer(handler)
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` })))
}

export async function roundTenBashChecks(check: Check, section: (name: string) => void): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-round10b-"))
  const project = path.join(root, "project")
  await fs.mkdir(path.join(project, "sub"), { recursive: true })
  const outputs = new ToolOutputs(path.join(root, "outputs"))
  const asked: { forced?: boolean; kind: string; subject: string }[] = []
  let refuseAsks = false
  const gate = {
    ask: async (question: { forced?: boolean; kind: string; subject: string }) => {
      asked.push(question)
      if (refuseAsks) throw new PermissionDenied(question.subject)
    },
  }
  const context = (extra: Partial<ToolContext> = {}): ToolContext =>
    ({
      sessionID: "ses_r10b",
      messageID: "msg_r10b",
      callID: `call_${Math.random().toString(36).slice(2)}`,
      directory: project,
      permissions: gate,
      signal: new AbortController().signal,
      progress: () => {},
      snapshot: async () => {},
      toolOutputs: outputs,
      ...extra,
    }) as unknown as ToolContext
  const run = (input: Record<string, unknown>, extra: Partial<ToolContext> = {}) =>
    BashTool.execute({ description: "Round ten", ...input }, context(extra)).then(
      (result) => result,
      (error: Error) => ({ output: `ERROR ${error.message}`, metadata: {} }) as ToolResult,
    )
  const script = async (name: string, body: string) => {
    const file = path.join(root, name)
    await fs.writeFile(file, body)
    return file
  }

  section("Round 10 (bash): output is decoded as a stream, once per command (T10-1)")
  {
    const text = "第一行：编译输出，含有中文与 ASCII mixed text。\n".repeat(40)
    const bytes = Buffer.from(text, "utf8")
    const oneByOne = new OutputDecoder({})
    let joined = ""
    for (const byte of bytes) joined += oneByOne.write(Buffer.from([byte]))
    joined += oneByOne.end()
    check("UTF-8 fed a byte at a time decodes exactly, with nothing flipped to another encoding", joined === text, joined.slice(0, 60))

    const shared = {}
    const first = new OutputDecoder(shared)
    const second = new OutputDecoder(shared)
    const said = first.write(Buffer.from("ascii then ")) + first.write(Buffer.from("中文", "utf8"))
    check("the first character past ASCII decides, and both pipes follow it", said === "ascii then 中文" && second.write(Buffer.from([0xe4, 0xb8])) + second.write(Buffer.from([0xad])) === "中", said)

    const page = codePage()
    if (page === "936") {
      const gbk = new OutputDecoder({})
      const decoded = gbk.write(Buffer.from([0x41, ...GBK_BYTES.slice(0, 3)])) + gbk.write(Buffer.from(GBK_BYTES.slice(3))) + gbk.end()
      check("bytes that are not UTF-8 are read in the console's code page, split characters included", decoded === "A中文输出", decoded)
      const gbkScript = await script("gbk.cjs", `const b = Buffer.from(${JSON.stringify(GBK_BYTES)}); process.stdout.write(b.subarray(0, 3)); setTimeout(() => process.stdout.write(b.subarray(3)), 150)`)
      const native = await run({ command: `node "${gbkScript}"` })
      check("a command writing GBK comes back as Chinese", native.output === "中文输出", native.output)
    }

    // A big Chinese output written in 1000-byte pieces, well past the budget: head, tail and file all readable.
    const big = "编译第{n}行：这是一段用于检查按字节切开的中文输出。\n"
    const bigScript = await script(
      "big.cjs",
      `const lines = []; for (let n = 0; n < 3000; n++) lines.push(${JSON.stringify(big)}.replace("{n}", n));
       const all = Buffer.from(lines.join(""), "utf8");
       // The first write ends inside the first character, and the rest waits until the reader has had it.
       process.stdout.write(all.subarray(0, 1)); let at = 1;
       const next = () => { if (at >= all.length) return; process.stdout.write(all.subarray(at, at + 1000), () => setTimeout(next, 2)); at += 1000 }; setTimeout(next, 150)`,
    )
    const expected = Array.from({ length: 3000 }, (_, n) => big.replace("{n}", String(n))).join("")
    const previews: string[] = []
    const stamps: number[] = []
    const started = Date.now()
    const long = await run({ command: `node "${bigScript}"`, max_output_tokens: 2000 }, { progress: (value) => (previews.push(value), stamps.push(Date.now())) })
    const elapsed = Date.now() - started
    const saved = await fs.readFile(String(long.metadata?.outputPath ?? ""), "utf8").catch(() => "")
    const clean = (value: string) => !value.includes("\ufffd") && !/[绗竴琛岋細缂栬瘧]/.test(value)
    check("the cut result's start and end are readable Chinese", clean(long.output) && long.output.includes("编译第0行") && long.output.includes("编译第2999行"), long.output.slice(0, 120))
    check("the saved file is the whole output, byte for byte", saved === expected, `${saved.length} of ${expected.length}`)
    check("no live preview ever shows a broken character", previews.length > 0 && previews.every(clean), previews.find((value) => !clean(value))?.slice(0, 80))
    check(
      `the live preview is refreshed at most every ${PROGRESS_EVERY_MS} ms`,
      previews.length <= Math.ceil(elapsed / PROGRESS_EVERY_MS) + 2 && stamps.every((stamp, index) => index === 0 || stamp - stamps[index - 1] >= PROGRESS_EVERY_MS - 15),
      { calls: previews.length, elapsed },
    )
    check("and holds the latest output only, marked as cut", previews.every((value) => value.length <= PREVIEW_CHARS + 5) && previews.at(-1)!.startsWith("...\n\n"))
  }

  section("Round 10 (bash): a stopped command's result is not overwritten (T10-2)")
  {
    const ticking = await script("tick.cjs", `console.log("started"); setInterval(() => console.log("tick " + Date.now()), 5)`)
    let resolvedAt = 0
    const late: string[] = []
    const result = await run(
      { command: `node "${ticking}"`, timeout: 800 },
      {
        progress: (value) => {
          if (resolvedAt) late.push(value)
        },
      },
    )
    resolvedAt = Date.now()
    await wait(600)
    check("the timed-out result carries its note and what ran", result.output.includes("800 ms timeout") && result.output.includes("started"), result.output.slice(-200))
    check("nothing the command printed afterwards reaches the card", late.length === 0, late.length)
  }

  section("Round 10 (bash): PowerShell and cmd hand UTF-8 on (T10-3, T10-34)")
  if (process.platform === "win32") {
    const echo = await script("echo-stdin.cjs", `process.stdin.pipe(process.stdout)`)
    const powershell = shell("powershell.exe")
    check("PowerShell is asked for UTF-8 in both directions", powershell.powershell && powershell.args("x").at(-1)!.startsWith("$OutputEncoding = [Console]::OutputEncoding"))
    const piped = await run({ command: `'中文ü' | node "${echo}"` }, { shell: "powershell.exe" })
    check("text piped from PowerShell into a native program keeps its Chinese", piped.output.includes("中文ü"), piped.output)
    const cmd = shell("cmd.exe")
    check("cmd takes its line verbatim, after a switch to the UTF-8 code page", cmd.verbatim && cmd.args("echo hi").join(" ") === '/d /s /c "chcp 65001>nul 2>nul & echo hi"', cmd.args("echo hi"))
    const quoted = await run({ command: 'echo "a b"' }, { shell: "cmd.exe" })
    check("cmd keeps a quoted argument's quotes as written", quoted.output.trim() === '"a b"', quoted.output)
    const cmdChinese = await run({ command: "echo 中文" }, { shell: "cmd.exe" })
    check("and its own Chinese comes back readable", cmdChinese.output.trim() === "中文", cmdChinese.output)
    check("a POSIX shell is handed its script with -c, not as a login shell", shell("bash").args("x").join(" ") === "-c x" && shell("zsh").posix)

    const savedPath = process.env.PATH
    const savedShell = process.env.SHELL
    const fakeBin = path.join(root, "fake-bin")
    await fs.mkdir(fakeBin, { recursive: true })
    await fs.writeFile(path.join(fakeBin, "pwsh.exe"), "")
    try {
      delete process.env.SHELL
      process.env.PATH = `${fakeBin}${path.delimiter}${savedPath ?? ""}`
      const chosen = shell()
      check("with nothing chosen, pwsh is preferred when it is installed", chosen.command === path.join(fakeBin, "pwsh.exe") && chosen.powershell, chosen.command)
      /*
       * A PATH with Windows PowerShell on it and no pwsh. Restoring the real
       * PATH and then accepting either name meant that on any machine with
       * PowerShell 7 installed the fallback this check is named for was never
       * taken - it read green here only because this machine has no pwsh
       * (R23-5-3).
       */
      const onlyWindows = path.join(root, "only-windows-powershell")
      await fs.mkdir(onlyWindows, { recursive: true })
      await fs.writeFile(path.join(onlyWindows, "powershell.exe"), "")
      process.env.PATH = onlyWindows
      check("and Windows PowerShell otherwise", shell().command === path.join(onlyWindows, "powershell.exe"), shell().command)
      process.env.PATH = `${fakeBin}${path.delimiter}${savedPath ?? ""}`
      process.env.SHELL = "fish"
      check("SHELL naming fish is passed over, as MiMo passes it over", shell().powershell, shell().command)
      process.env.SHELL = "cmd.exe"
      check("any other SHELL is honoured", /cmd\.exe$/i.test(shell().command) && shell().verbatim, shell().command)
    } finally {
      process.env.PATH = savedPath
      if (savedShell === undefined) delete process.env.SHELL
      else process.env.SHELL = savedShell
    }
  }


  section("Round 10 (bash): platform shell prewarm (first-bash cold start, 续九)")
  {
    // Paths relative to the repository root, as the other round-10 source checks read them.
    const bashSrc = await fs.readFile("src/server/tool/bash.ts", "utf8")
    const indexSrc = await fs.readFile("src/server/index.ts", "utf8")
    check("bash.ts exports prewarmBashShell and the cold-start progress line", bashSrc.includes("export function prewarmBashShell") && bashSrc.includes("正在启动 shell…"))
    check(
      "index.ts imports prewarmBashShell next to stopBashCommands",
      /stopBashCommands,\s*prewarmBashShell/.test(indexSrc.replace(/\s+/g, " ")),
    )
    check("index.ts calls prewarmBashShell(config.get().shell) before returning the backend", /prewarmBashShell\(\s*config\.get\(\)\.shell\s*\)/.test(indexSrc))

    prewarmBashShell()
    const warmed = await awaitBashShellWarm(15_000)
    check("prewarmBashShell marks the shell warmed", warmed && bashShellIsWarmed())

    const progress: string[] = []
    const started = Date.now()
    const result = await run(
      { command: process.platform === "win32" ? "echo warm" : "true" },
      { progress: (value) => progress.push(value) },
    )
    const elapsed = Date.now() - started
    check("a bash after prewarm completes", !String(result.output).startsWith("ERROR"), result.output)
    check("a warm bash does not re-announce cold start", !progress.some((line) => line.includes("正在启动 shell…")), progress)
    if (process.platform !== "win32") {
      check("on Linux a warm no-op bash finishes quickly", elapsed < 3000, elapsed)
    }
    check("warm result metadata does not claim shellCold", result.metadata?.shellCold !== true, result.metadata)
  }

  section("Round 10 (bash): workdir in POSIX spelling, and one that is not there (T10-35)")
  {
    const where = await script("cwd.cjs", `console.log(process.cwd())`)
    const target = path.join(project, "sub")
    if (process.platform === "win32") {
      const posix = `/${target[0].toLowerCase()}${target.slice(2).replace(/\\/g, "/")}`
      check("a /c/ path names drive C", windowsPath("/c/Users/x") === "C:/Users/x" && windowsPath("/mnt/d/a") === "D:/a" && windowsPath("/cygdrive/e") === "E:/" && windowsPath("/tmp") === "/tmp")
      const ran = await run({ command: `node "${where}"`, workdir: posix })
      check("a workdir written /c/... runs the command in that folder", ran.output.trim().toLowerCase() === target.toLowerCase(), { posix, output: ran.output })
    }
    const missing = await run({ command: `node "${where}"`, workdir: "no-such-folder" })
    check("a workdir that does not exist is named as such, not as a missing shell", missing.output.startsWith("ERROR workdir does not exist") && !/ENOENT/.test(missing.output), missing.output)
  }

  section("Round 10 (bash): no refusal list; deletes get their own question (T10-6)")
  {
    asked.length = 0
    const words = await run({ command: 'echo "graceful shutdown, then reboot and halt"' })
    check("a command that only mentions shutdown or reboot runs", words.output.includes("graceful shutdown"), words.output)
    asked.length = 0
    refuseAsks = true
    const deleting = await run({ command: "rm -rf ./r10-nothing-here" })
    refuseAsks = false
    check("rm -rf is put to the user as a delete, not refused by the tool", asked.length === 1 && asked[0].forced === true && !deleting.output.includes("will not run"), { asked, output: deleting.output })
  }

  section("Round 10 (bash): git author and committer follow the project (T10-37)")
  {
    const repo = path.join(root, "repo")
    await fs.mkdir(repo)
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, windowsHide: true, stdio: "ignore" })
    git("init", "-q")
    git("config", "user.name", "Round Ten")
    git("config", "user.email", "r10@example.invalid")
    const env = await gitIdentityEnv(repo)
    const inherited = process.env.GIT_AUTHOR_NAME || process.env.GIT_COMMITTER_EMAIL
    if (!inherited) {
      check("the repository's name and address become git's author and committer", env.GIT_AUTHOR_NAME === "Round Ten" && env.GIT_COMMITTER_EMAIL === "r10@example.invalid", env)
      const shown = await script("ident.cjs", `console.log(process.env.GIT_AUTHOR_NAME + "|" + process.env.GIT_COMMITTER_EMAIL)`)
      const seen = await BashTool.execute({ command: `node "${shown}"`, description: "Who" }, { ...context(), directory: repo } as ToolContext)
      check("a command run for that project sees them", seen.output.trim() === "Round Ten|r10@example.invalid", seen.output)
    }
    const plain = path.join(root, "not-a-repo")
    await fs.mkdir(plain)
    let inRepository = true
    try {
      execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: plain, windowsHide: true, stdio: "ignore" })
    } catch {
      inRepository = false
    }
    if (!inRepository) check("a folder outside any repository sets none", Object.keys(await gitIdentityEnv(plain)).length === 0)
  }

  section("Round 10 (webfetch): turndown, images, redirects and the description (T10-7, T10-38, T10-39)")
  {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex")
    const { server, base } = await listen((request, response) => {
      const url = request.url ?? "/"
      if (url === "/page") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        response.end(
          "<html><head><title>T</title><style>p{}</style></head><body><h1>Title</h1><script>alert(1)</script>" +
            "<table><tr><th>Name</th><th>Age</th></tr><tr><td>Tom</td><td>30</td></tr></table>" +
            "<ol><li>one</li><li>two</li></ol><dl><dt>Term</dt><dd>Def</dd></dl><p><a href='/docs'>docs</a> and <em>stress</em></p>" +
            "<pre><code>let x = 1</code></pre></body></html>",
        )
      } else if (url === "/image") {
        response.writeHead(200, { "content-type": "image/png" })
        response.end(png)
      } else if (url === "/drawing") {
        response.writeHead(200, { "content-type": "image/svg+xml" })
        response.end('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
      } else if (url === "/old") {
        response.writeHead(302, { location: "/page" })
        response.end()
      } else {
        response.writeHead(404)
        response.end()
      }
    })
    try {
      const fetchURL = (url: string) => WebFetchTool.execute({ url }, context())
      const page = await fetchURL(`${base}/page`)
      const md = page.output
      check("a page becomes Markdown: atx heading, script and style gone", md.includes("\n# Title\n") && !md.includes("alert") && !md.includes("p{}"), md)
      check("table cells and definition terms stay apart", !md.includes("NameAge") && !md.includes("TermDef") && !md.includes("Tom30"), md)
      check("an ordered list is numbered, and a single-quoted link is kept", /1\.\s+one/.test(md) && /2\.\s+two/.test(md) && md.includes("[docs](/docs)") && md.includes("*stress*"), md)
      check("code is fenced", md.includes("```\nlet x = 1\n```"), md)
      check("the converter is the one used for pages", htmlToMarkdown("<h2>x</h2>") === "## x")
      const image = await fetchURL(`${base}/image`)
      check(
        "an image comes back attached, with its bytes",
        image.attachments?.length === 1 && image.attachments[0].mime === "image/png" && image.attachments[0].data === png.toString("base64") && !image.output.includes("cannot pass"),
        { output: image.output, attachments: image.attachments?.map((entry) => entry.mime) },
      )
      const drawing = await fetchURL(`${base}/drawing`)
      check("an SVG is read as text", !drawing.attachments && drawing.output.includes("<svg") && !imageAttachment("image/svg+xml") && imageAttachment("image/webp"))
      const moved = await fetchURL(`${base}/old`)
      check("a redirect names where it ended up", moved.output.startsWith(`Redirected from ${base}/old to ${base}/page`) && moved.output.includes("# Title"), moved.output.slice(0, 120))
      check("the description no longer says this machine cannot be reached", !/loopback|reach this machine/i.test(WebFetchTool.description))
    } finally {
      server.close()
    }
  }

  section("Round 10 (turns): stop, timeout, unknown tools and the cut note, through the runner (T10-2, T10-4, T10-5, T10-36, T10-40)")
  {
    const bodies: { messages?: { role: string; content?: unknown; tool_call_id?: string }[] }[] = []
    let callCount = 0
    const big = Array.from({ length: 3000 }, (_, n) => `line ${n}`).join("\n")
    const { server: pages, base } = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" })
      response.end(big)
    })
    const partialScript = await script("partial.cjs", `console.log("partial-output-r10"); setInterval(() => {}, 1000)`)
    const tickScript = await script("tick2.cjs", `console.log("started"); setInterval(() => console.log("tick"), 5)`)
    const orders: Record<string, { name: string; input: Record<string, unknown> }> = {
      UNKNOWN: { name: "frobnicate_widgets", input: { x: 1 } },
      NODESC: { name: "bash", input: { command: "echo hi" } },
      BIGFETCH: { name: "webfetch", input: { url: `${base}/big`, format: "text" } },
      STOPME: { name: "bash", input: { command: `node "${partialScript}"`, description: "Wait forever" } },
      TIMEOUT: { name: "bash", input: { command: `node "${tickScript}"`, description: "Tick", timeout: 700 } },
    }
    const provider = createServer((request, response) => {
      let body = ""
      request.on("data", (chunk) => (body += chunk))
      request.on("end", () => {
        const asked = JSON.parse(body || "{}") as (typeof bodies)[number]
        bodies.push(asked)
        response.writeHead(200, { "content-type": "text/event-stream" })
        const last = asked.messages?.at(-1)
        const order = last?.role === "user" ? Object.entries(orders).find(([marker]) => JSON.stringify(last.content ?? "").includes(marker))?.[1] : undefined
        if (order) {
          const frame = { choices: [{ delta: { tool_calls: [{ index: 0, id: `call_r10_${++callCount}`, type: "function", function: { name: order.name, arguments: JSON.stringify(order.input) } }] } }] }
          response.write(`data: ${JSON.stringify(frame)}\n\n`)
          response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`)
        } else {
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "done" } }] })}\n\n`)
          response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`)
        }
        response.write("data: [DONE]\n\n")
        response.end()
      })
    })
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", () => resolve()))
    const port = (provider.address() as { port: number }).port

    const data = path.join(root, "runner-data")
    const storage = new Storage(path.join(data, "storage"))
    const bus = new Bus()
    const config = new Config(storage, bus, path.join(data, "credentials.json"))
    await storage.write("config", {})
    await config.load()
    await config.set({ customProviders: [{ id: "fake", name: "Fake", baseURL: `http://127.0.0.1:${port}/v1`, models: [{ id: "m", name: "M" }] }], directory: project })
    await config.set({ autoApprove: ["bash", "webfetch", "outside"] })
    await config.setApiKey("fake", "k")
    const permissions = new Permissions(bus, config)
    const store = new SessionStore(storage, bus)
    const runner = new SessionRunner(store, bus, config, permissions, { accessToken: async () => undefined } as never, storage)
    const model = { provider: "fake", model: "m" }
    const until = async (test: () => boolean | Promise<boolean>, ms = 15_000) => {
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        if (await test()) return true
        await wait(25)
      }
      return false
    }
    const idle = (sessionID: string) => until(async () => !runner.busySessions().includes(sessionID), 30_000)
    const toolParts = async (sessionID: string) =>
      (await store.messages(sessionID)).flatMap((message) => (message.role === "assistant" ? message.parts.filter((part): part is ToolPart => part.type === "tool") : []))
    const turn = async (text: string) => {
      const session = await store.create({ directory: project, model })
      await runner.prompt({ sessionID: session.id, text })
      await wait(50)
      await idle(session.id)
      return { id: session.id, parts: await toolParts(session.id) }
    }

    try {
      const unknown = await turn("UNKNOWN")
      const invalid = unknown.parts[0]
      const error = String((invalid?.input as { error?: unknown } | undefined)?.error ?? "")
      check(
        "an unknown tool is answered with the tools this request offered",
        invalid?.name === "invalid" && /Available tools: .*\bbash\b/.test(error) && error.includes("webfetch") && !/\binvalid\b/.test(error.split("Available tools:")[1] ?? ""),
        error,
      )

      const nodesc = await turn("NODESC")
      const nodescPart = nodesc.parts[0]
      check(
        "a bash call without a description is repaired and runs",
        nodescPart?.status === "completed" && String((nodescPart?.input as { description?: unknown } | undefined)?.description ?? "").startsWith("Run: "),
        nodescPart,
      )

      const fetched = await turn("BIGFETCH")
      const cut = fetched.parts[0]?.output ?? ""
      check("a cut output points at the actor tool, never the task tool", cut.includes("actor tool") && !cut.includes("task tool") && fetched.parts[0]?.metadata?.truncated === true, cut.slice(-300))

      const timed = await turn("TIMEOUT")
      await wait(800)
      const timedPart = (await toolParts(timed.id))[0]
      check("a timed-out command's saved result keeps its timeout note", timedPart?.status === "completed" && String(timedPart.output).includes("700 ms timeout"), String(timedPart?.output).slice(-200))

      const session = await store.create({ directory: project, model })
      await runner.prompt({ sessionID: session.id, text: "STOPME" })
      // What the card shows while the command runs is published, not saved.
      let live = ""
      // N11-4: a running call's output now goes out as the part alone, not the whole message.
      const unsubscribe = bus.subscribe((event) => {
        if (event.type !== "message.part.updated" || event.sessionID !== session.id) return
        const part = event.part
        if (part.type === "tool" && part.status === "running" && part.output) live = part.output
      })
      const printed = await until(() => live.includes("partial-output-r10"))
      unsubscribe()
      runner.abort(session.id)
      await idle(session.id)
      const stopped = (await toolParts(session.id))[0]
      check(
        "a stopped command is marked interrupted and keeps what it printed",
        printed && stopped?.status === "error" && stopped.metadata?.interrupted === true && stopped.metadata?.aborted === true && String(stopped.output).includes("partial-output-r10") && stopped.error === "Tool execution aborted",
        stopped,
      )
      bodies.length = 0
      await runner.prompt({ sessionID: session.id, text: "carry on" })
      await wait(50)
      await idle(session.id)
      const handed = bodies[0]?.messages?.find((message) => message.role === "tool")
      check("the next request hands the model that output as the call's result", JSON.stringify(handed?.content ?? "").includes("partial-output-r10"), handed)
    } finally {
      provider.close()
      pages.close()
    }
  }
}
