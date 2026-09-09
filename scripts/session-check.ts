/**
 * Drives the real session runner over a fake provider.
 *
 * The renderer has probes; the server had none, and the defects this covers all
 * destroy something quietly - a turn dropped from every future context, the
 * only record of a half-finished undo, a tool failure the model is never told
 * about, a question left parked where no window can answer it, a model list
 * thrown away with a key that was never stored here. None of them is visible
 * from the interface, and none would be caught by a type check.
 *
 * The provider is an ordinary HTTP server speaking the OpenAI streaming shape,
 * with a second route for the Responses shape the Codex backend uses, so the
 * adapters, the runner, the store, the request handlers and the bus are all the
 * real ones.
 */
import http from "node:http"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import type { Message, PermissionAction, PermissionKind, PermissionRequest } from "@shared/protocol"
import { DEFAULT_PERMISSIONS } from "@shared/protocol"
import { Storage } from "../src/server/storage"
import { Bus } from "../src/server/bus"
import { Config } from "../src/server/config"
import { Permissions } from "../src/server/permission"
import { SessionStore } from "../src/server/session/store"
import { SessionRunner } from "../src/server/session/runner"
import { Shells } from "../src/server/shell"
import { McpServers } from "../src/server/mcp"
import { ChatGPTSubscription } from "../src/server/provider/chatgpt"
import { handle } from "../src/server/handlers"
import type { Runtime } from "../src/server/index"

/** How long each streamed chunk waits, so a call can be raced against. */
let gap = 5
/** Runs once, on the first chunk of the next stream. */
let onFirstChunk: (() => void) | undefined
/** The body of the last request the Codex route was asked to answer. */
let codexBody = ""
/**
 * Every chat request the fake provider has been asked to answer, oldest first.
 *
 * The steering checks turn on what the model was actually given, and the only
 * honest place to read that is the request that left the machine.
 */
let requests: string[] = []
/** Runs as each chat request arrives, with its number in the run so far. */
let onRequest: ((n: number) => void) | undefined

/**
 * Replies the fake provider plays, one per request, before falling back to
 * plain text.
 *
 * Undo can only be checked by running the real tools, and the only way to make
 * the real runner call a tool is for a provider to ask for one.
 */
let script: { name: string; input: Record<string, unknown> }[][] = []
/**
 * When set, the next chat request is refused with this body and status 400 -
 * the shape of a provider whose context the conversation has outgrown.
 */
let refuseNext: string | undefined
/**
 * When set, the fake counts input tokens in proportion to the request it is
 * given - the first one it sees is `tokens` - and refuses any request whose
 * input plus its `max_tokens` would exceed `window`, in the words the user's
 * own server used. That is the arithmetic that defeated the first attempt at
 * a rescue: 230,145 + 32,000 is one token over 262,144.
 */
let enforceWindow: { window: number; tokens: number; baseline?: number } | undefined
/** Tool calls need ids that pair a call with its result, and no two may match. */
let callNumber = 0

const server = http.createServer((request, response) => {
  let body = ""
  request.on("data", (chunk) => (body += chunk))
  request.on("end", async () => {
    /*
     * The Codex backend speaks the Responses shape rather than chat
     * completions, so it needs its own route. What matters here is the request
     * rather than the reply: the reply is the shortest stream the adapter will
     * accept as a finished turn.
     */
    if (request.url?.endsWith("/responses")) {
      codexBody = body
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "noted" })}\n\n`)
      response.write(`data: ${JSON.stringify({ type: "response.completed", response: { usage: {} } })}\n\n`)
      response.write("data: [DONE]\n\n")
      response.end()
      return
    }

    requests.push(body)
    onRequest?.(requests.length)
    if (enforceWindow) {
      const asked = JSON.parse(body || "{}") as { max_tokens?: number; messages?: { role?: string }[] }
      /*
       * The conversation only, never the system prompt. A turn's system
       * prompt is long and a compaction's is one paragraph, so counting it
       * would make every summary request look light enough to fit and the
       * case would pass whatever ceiling the summary asked for.
       */
      const weight = JSON.stringify((asked.messages ?? []).filter((message) => message.role !== "system")).length
      enforceWindow.baseline ??= weight
      const input = Math.round((enforceWindow.tokens * weight) / (enforceWindow.baseline || weight))
      const output = asked.max_tokens ?? 0
      if (input + output > enforceWindow.window) {
        response.writeHead(400, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            error: {
              message: `This model's maximum context length is ${enforceWindow.window} tokens. However, you requested ${output} output tokens and your prompt contains at least ${input} input tokens, for a total of at least ${input + output} tokens. Please reduce the length of the input prompt or the number of requested output tokens.`,
            },
          }),
        )
        return
      }
    }
    if (refuseNext !== undefined) {
      const refusal = refuseNext
      refuseNext = undefined
      response.writeHead(400, { "content-type": "application/json" })
      response.end(refusal)
      return
    }

    const asked = script.shift()
    if (asked) {
      response.writeHead(200, { "content-type": "text/event-stream" })
      asked.forEach((call, index) => {
        const frame = {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index,
                    id: `call_${++callNumber}`,
                    type: "function",
                    function: { name: call.name, arguments: JSON.stringify(call.input) },
                  },
                ],
              },
            },
          ],
        }
        response.write(`data: ${JSON.stringify(frame)}\n\n`)
      })
      const close = { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
      response.write(`data: ${JSON.stringify(close)}\n\n`)
      response.write("data: [DONE]\n\n")
      response.end()
      return
    }

    response.writeHead(200, { "content-type": "text/event-stream" })
    const chunks = [
      { choices: [{ delta: { content: "a summary" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ]
    let first = true
    for (const chunk of chunks) {
      response.write(`data: ${JSON.stringify(chunk)}\n\n`)
      if (first) {
        first = false
        const hook = onFirstChunk
        onFirstChunk = undefined
        hook?.()
      }
      await new Promise((resolve) => setTimeout(resolve, gap))
    }
    response.write("data: [DONE]\n\n")
    response.end()
  })
})

const problems: string[] = []
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "BAD "} ${name}${detail ? " - " + detail : ""}`)
  if (!ok) problems.push(name)
}

async function main(): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const port = (server.address() as { port: number }).port

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-session-check-"))
  const project = path.join(root, "project")
  await fs.mkdir(project, { recursive: true })
  /*
   * A repository, because undoing a shell command means comparing the project
   * against itself, and that is only recorded inside git - see
   * `scripts/snapshot-check.ts` for why it is not done anywhere else.
   */
  execFileSync("git", ["init", "-q"], { cwd: project })

  const storage = new Storage(path.join(root, "storage"))
  const bus = new Bus()
  const config = new Config(storage, bus, path.join(root, "credentials.json"))
  await config.load()
  await config.set({
    customProviders: [{ id: "fake", name: "Fake", baseURL: `http://127.0.0.1:${port}/v1` }],
    autoApprove: ["bash", "edit", "write", "webfetch", "outside", "mcp"],
    directory: project,
  })
  await config.setApiKey("fake", "k")

  /*
   * A stored document someone has opened in an editor.
   *
   * These are plain JSON files in a folder a person can reach, and every common
   * Windows editor writes a byte-order mark without being asked. The store is
   * read while the backend is starting, so one stray BOM used to stop the whole
   * app opening, with a syntax error about a character nobody typed and no
   * interface left to correct it from. This was found the hard way, on a real
   * config.json.
   */
  console.log("a stored file that has been through an editor")
  await fs.mkdir(path.join(root, "storage"), { recursive: true })
  await fs.writeFile(
    path.join(root, "storage", "bom-probe.json"),
    "﻿" + JSON.stringify({ hello: "world" }),
    "utf8",
  )
  const withMark = await storage.read<{ hello: string }>("bom-probe").catch(() => undefined)
  check("a byte-order mark does not stop it being read", withMark?.hello === "world", String(withMark?.hello))
  await storage.remove("bom-probe")

  const permissions = new Permissions(bus, config)
  const sessions = new SessionStore(storage, bus)
  const auth = { accessToken: async () => undefined } as never
  const runner = new SessionRunner(sessions, bus, config, permissions, auth, storage)
  const shells = new Shells(bus)
  const mcp = new McpServers(bus, config)
  /*
   * The request handlers are part of what a window sees, so the checks that
   * care about reconnecting drive them rather than the pieces underneath.
   */
  const runtime: Runtime = { storage, bus, config, auth, permissions, sessions, runner, shells, mcp }

  const idle = (sessionID: string) =>
    new Promise<void>((resolve) => {
      const off = bus.subscribe((event) => {
        if (event.type === "session.idle" && (event as { sessionID: string }).sessionID === sessionID) {
          off()
          resolve()
        }
      })
    })

  /**
   * Waits for a session to stop working, however many turns that takes.
   *
   * A steered message can end one turn and start another, so waiting for the
   * first idle event would measure the middle of the episode. This waits for a
   * quiet stretch instead, which is the only description of "finished" that
   * holds whether the message joined the turn or opened a new one.
   */
  const stopped = (sessionID: string, quiet = 400) =>
    new Promise<void>((resolve) => {
      const look = () => {
        if (runner.busySessions().includes(sessionID)) {
          setTimeout(look, 25)
          return
        }
        setTimeout(() => {
          if (runner.busySessions().includes(sessionID)) setTimeout(look, 25)
          else resolve()
        }, quiet)
      }
      setTimeout(look, 25)
    })

  // --- compaction cannot swallow a turn that arrives while it runs -----------
  console.log("compaction")
  const one = await sessions.create({ directory: project, model: { provider: "fake", model: "m" } })
  const firstTurn = idle(one.id)
  await runner.prompt({ sessionID: one.id, text: "the first question" })
  await firstTurn

  const before = await sessions.messages(one.id)
  const lastBefore = before[before.length - 1]

  gap = 400
  let busyDuringSummary: boolean | undefined
  let racing: string | undefined
  onFirstChunk = () => {
    busyDuringSummary = runner.busySessions().includes(one.id)
    void runner
      .prompt({ sessionID: one.id, text: "sent while compacting" })
      .then(() => (racing = "(accepted)"))
      .catch((error: Error) => (racing = error.message))
  }
  const compacted = await runner.compact(one.id)
  gap = 5
  await new Promise((resolve) => setTimeout(resolve, 600))

  check("the session is working while its summary streams", busyDuringSummary === true)
  check("a prompt sent during a compaction is refused", Boolean(racing) && racing !== "(accepted)", String(racing))
  check(
    "the boundary is the message the summary actually saw",
    compacted.compacted?.messageID === lastBefore.id,
  )

  // --- a restore that fails leaves the snapshot where it was ----------------
  console.log("undo")
  const two = await sessions.create({ directory: project, model: { provider: "fake", model: "m" } })
  const target = path.join(project, "edited.txt")
  await fs.writeFile(target, "before", "utf8")

  await sessions.pushSnapshot(two.id, {
    at: Date.now(),
    files: [
      { path: target, content: "before" },
      // A directory cannot be overwritten by a file, so restoring this throws
      // exactly where a read-only or locked file would.
      { path: path.join(project, "blocked"), content: "cannot land" },
    ],
  })
  await fs.mkdir(path.join(project, "blocked"), { recursive: true })
  await fs.writeFile(target, "after the turn", "utf8")

  let failed = false
  try {
    await runner.undo(two.id)
  } catch {
    failed = true
  }
  check("an undo that cannot finish reports failure", failed)

  const still = await sessions.peekSnapshot(two.id, "undo")
  check("the snapshot is still on the undo stack", Boolean(still))
  check("nothing was filed on the redo stack", !(await sessions.peekSnapshot(two.id, "redo")))

  // With the obstacle gone the same undo completes.
  await fs.rm(path.join(project, "blocked"), { recursive: true, force: true })
  let second = false
  try {
    await runner.undo(two.id)
    second = true
  } catch {
    second = false
  }
  check("retrying it once unblocked succeeds", second)
  check("the file came back", (await fs.readFile(target, "utf8")) === "before")
  check("and it is now redoable", Boolean(await sessions.peekSnapshot(two.id, "redo")))

  /*
   * The edit and write tools say which file they touched, because they do the
   * touching. A shell command does not, and a great deal of what a turn changes
   * arrives through one: a sed in place, a formatter, a code generator, a git
   * checkout. Undo used to record only the tools that spoke up, restore those,
   * and report a file count as though the whole turn had gone back.
   *
   * Both turns below are driven through a script file rather than an inline
   * command. The shell is PowerShell on Windows and a POSIX shell elsewhere,
   * and the two disagree about quoting, escapes and even what encoding `echo`
   * writes in. The script lives outside the project, so running it is not
   * itself one of the changes being counted.
   */
  console.log("undo after a shell command")
  const forward = (target: string) => target.split(path.sep).join("/")
  const byShell = path.join(project, "by-shell.txt")
  const removed = path.join(project, "removed-by-shell.txt")
  const created = path.join(project, "created-by-shell.txt")
  const rewriter = path.join(root, "rewrite.js")
  const rewrite = { command: `node '${forward(rewriter)}'`, description: "Rewrite a file" }
  await fs.writeFile(
    rewriter,
    `require("fs").writeFileSync(${JSON.stringify(forward(byShell))}, "rewritten by the shell")\n`,
    "utf8",
  )

  // The other two ways a turn changes a project. A created file has to go back
  // to not existing, and a deleted one has to come back with its contents.
  const churner = path.join(root, "churn.js")
  const churn = { command: `node '${forward(churner)}'`, description: "Rewrite, delete and create" }
  await fs.writeFile(
    churner,
    [
      `const fs = require("fs")`,
      `fs.writeFileSync(${JSON.stringify(forward(byShell))}, "rewritten by the shell")`,
      `fs.unlinkSync(${JSON.stringify(forward(removed))})`,
      `fs.writeFileSync(${JSON.stringify(forward(created))}, "made by the shell")`,
      "",
    ].join("\n"),
    "utf8",
  )

  {
    await fs.writeFile(byShell, "as the turn found it", "utf8")
    await fs.writeFile(removed, "here before the turn", "utf8")
    await fs.rm(created, { force: true })
    /*
     * Beside it, a file the turn never touches. Undo has to leave it alone: a
     * whole-project restore would be simpler to write and would quietly throw
     * away work the user did in their editor while the turn was running.
     */
    const untouched = path.join(project, "the-users-own.txt")
    await fs.writeFile(untouched, "written by hand", "utf8")

    const shellTurn = await sessions.create({ directory: project, model: { provider: "fake", model: "m" } })
    script = [[{ name: "bash", input: churn }]]
    const done = idle(shellTurn.id)
    await runner.prompt({ sessionID: shellTurn.id, text: "change it with the shell" })
    await done

    check(
      "the shell command changed the file",
      (await fs.readFile(byShell, "utf8").catch(() => "")) === "rewritten by the shell",
    )
    check("and deleted another", !(await fs.stat(removed).catch(() => undefined)))
    check("and made a third", Boolean(await fs.stat(created).catch(() => undefined)))
    await fs.writeFile(untouched, "written by hand, and changed again since", "utf8")

    let restored = -1
    let refusal: string | undefined
    try {
      restored = await runner.undo(shellTurn.id)
    } catch (failure) {
      refusal = (failure as Error).message
    }
    check("a turn changed only through the shell can be undone", refusal === undefined, String(refusal))
    check(
      "the rewritten file is back as the turn found it",
      (await fs.readFile(byShell, "utf8").catch(() => "")) === "as the turn found it",
    )
    check("the deleted file is back", (await fs.readFile(removed, "utf8").catch(() => "")) === "here before the turn")
    check("the created file is gone again", !(await fs.stat(created).catch(() => undefined)))
    check("and three files are reported as restored", restored === 3, String(restored))
    check(
      "a file the turn never touched is left as the user left it",
      (await fs.readFile(untouched, "utf8").catch(() => "")) === "written by hand, and changed again since",
    )
  }

  /*
   * The mixed turn is the one that misled people. One edit and one shell change
   * together: the edit came back, the toast named a file count, and the shell's
   * work was still sitting there.
   */
  console.log("undo after a turn that both edited and ran the shell")
  {
    const byEdit = path.join(project, "by-edit.txt")
    await fs.writeFile(byEdit, "the first line\n", "utf8")
    await fs.writeFile(byShell, "as the turn found it", "utf8")

    const mixed = await sessions.create({ directory: project, model: { provider: "fake", model: "m" } })
    script = [
      [
        { name: "edit", input: { path: byEdit, oldString: "the first line", newString: "a different line" } },
        { name: "bash", input: rewrite },
      ],
    ]
    const done = idle(mixed.id)
    await runner.prompt({ sessionID: mixed.id, text: "edit one and shell the other" })
    await done

    check("the edit landed", (await fs.readFile(byEdit, "utf8").catch(() => "")).startsWith("a different line"))
    check(
      "the shell change landed",
      (await fs.readFile(byShell, "utf8").catch(() => "")) === "rewritten by the shell",
    )

    let restored = -1
    let refusal: string | undefined
    try {
      restored = await runner.undo(mixed.id)
    } catch (failure) {
      refusal = (failure as Error).message
    }
    check("the mixed turn can be undone", refusal === undefined, String(refusal))
    check(
      "the edited file is back",
      (await fs.readFile(byEdit, "utf8").catch(() => "")) === "the first line\n",
    )
    check(
      "the file the shell changed is back too",
      (await fs.readFile(byShell, "utf8").catch(() => "")) === "as the turn found it",
    )
    check("and the count matches what was restored", restored === 2, String(restored))
  }

  /*
   * Outside a repository nothing is recorded, because staging a folder that
   * git knows nothing about means hashing every byte in it (see
   * `scripts/snapshot-check.ts`). What must survive that is undo of ordinary
   * edits: the tools say which file they wrote and the history is built from
   * what they said, with no comparison of the project needed. Only a turn
   * that also ran something opaque loses the ability, and says so.
   */
  console.log("undo in a folder that is not a repository")
  {
    const loose = path.join(root, "loose")
    await fs.mkdir(loose, { recursive: true })
    const edited = path.join(loose, "edited.txt")
    await fs.writeFile(edited, "the first line\n", "utf8")

    const plain = await sessions.create({ directory: loose, model: { provider: "fake", model: "m" } })
    script = [[{ name: "edit", input: { path: edited, oldString: "the first line", newString: "a different line" } }]]
    const edits = idle(plain.id)
    await runner.prompt({ sessionID: plain.id, text: "edit it" })
    await edits

    check("the edit landed", (await fs.readFile(edited, "utf8")).startsWith("a different line"))
    let refusal: string | undefined
    let restored = -1
    try {
      restored = await runner.undo(plain.id)
    } catch (failure) {
      refusal = (failure as Error).message
    }
    check("an edit-only turn is still undoable without git", refusal === undefined, String(refusal))
    check("and the file came back", (await fs.readFile(edited, "utf8")) === "the first line\n", String(restored))

    // The same folder, a turn that also ran a shell command: that one cannot.
    await fs.writeFile(edited, "the first line\n", "utf8")
    const opaque = await sessions.create({ directory: loose, model: { provider: "fake", model: "m" } })
    script = [
      [
        { name: "edit", input: { path: edited, oldString: "the first line", newString: "changed again" } },
        { name: "bash", input: rewrite },
      ],
    ]
    const both = idle(opaque.id)
    await runner.prompt({ sessionID: opaque.id, text: "edit it and shell something" })
    await both

    let told: string | undefined
    try {
      await runner.undo(opaque.id)
    } catch (failure) {
      told = (failure as Error).message
    }
    check("a turn with a shell command in it is refused instead", Boolean(told), String(told))
    check(
      "and the refusal says the project was never recorded",
      (told ?? "").includes("not a git repository"),
      String(told),
    )
  }

  /*
   * A conversation that has outgrown its model. The reference answers it two
   * ways and MCode now does the same: a provider that refuses the request as
   * too long has the transcript compacted and the step retried once; and a
   * model whose window is known is compacted as soon as the tokens it reports
   * reach that window less the room an answer needs. The screen this came
   * from was the first kind - a discovered vLLM model, window unknown to
   * MCode, answering 400 with "maximum context length is 262144 tokens" after
   * 230k of transcript went out with a 32k answer requested on top, and the
   * turn ending in red.
   */
  console.log("a request refused as too long is compacted and retried")
  {
    const refused = await sessions.create({ directory: project, model: { provider: "fake", model: "m" } })
    script = []
    const first = idle(refused.id)
    await runner.prompt({ sessionID: refused.id, text: "something to have a transcript" })
    await first

    const before = requests.length
    refuseNext = JSON.stringify({
      error: {
        message:
          "This model's maximum context length is 262144 tokens. However, you requested 32000 output tokens and your prompt contains at least 230145 input tokens.",
      },
    })
    script = []
    const second = idle(refused.id)
    await runner.prompt({ sessionID: refused.id, text: "and again" })
    await second

    const after = await sessions.get(refused.id)
    const transcript = await sessions.messages(refused.id)
    const assistants = transcript.filter((message) => message.role === "assistant")
    const errored = assistants.find((message) => message.error)
    const last = assistants[assistants.length - 1]
    check("the refusal is on the transcript", Boolean(errored), errored?.error ?? "(none)")
    check("the session was compacted", Boolean(after?.compacted), JSON.stringify(after?.compacted ?? null))
    check("with the summary the model gave", after?.compacted?.summary === "a summary", after?.compacted?.summary)
    check("and the step was retried and finished", last?.finish === "end_turn" && !last.error, String(last?.finish))
    // refusal, then the summary request, then the retry
    check("three requests: refusal, summary, retry", requests.length - before === 3, String(requests.length - before))
    const retry = JSON.parse(requests[requests.length - 1] ?? "{}") as { messages?: { content?: unknown }[]; max_tokens?: number }
    /*
     * The summary is what makes the rescue possible, so it has to fit where
     * the request that was just refused did not. Asking for the usual 32,000
     * is exactly what broke the first attempt: 230,145 tokens of transcript
     * plus 32,000 is one token over the window that had refused it, so the
     * summary was refused as well and the turn ended on the original error.
     */
    const summaryRequest = JSON.parse(requests[requests.length - 2] ?? "{}") as { max_tokens?: number }
    check(
      "the summary asked for the summary ceiling, not the usual one",
      summaryRequest.max_tokens === 4096,
      String(summaryRequest.max_tokens),
    )
    check(
      "the retry went out from the summary",
      (retry.messages ?? []).some((m) => typeof m.content === "string" && m.content.includes("a summary")),
    )
    check("a model with no known ceiling asks for the reference's 32k", retry.max_tokens === 32000, String(retry.max_tokens))
    refuseNext = undefined
  }

  /*
   * The same thing against a provider that enforces its window rather than
   * refusing to order. This is the case the first rescue got wrong: it
   * compacted by sending the whole transcript again and asking for the usual
   * 32,000 output, which is over the same window the request had just been
   * refused for, so the summary was refused too and the turn ended on the
   * original error - exactly what the user's screen showed. The summary has
   * to ask for less than the answer did.
   */
  console.log("the summary fits where the answer did not")
  {
    const compactionEvents: boolean[] = []
    let sawListedWhileCompacting: boolean | undefined
    const stopWatching = bus.subscribe((event) => {
      if (event.type !== "session.compacting") return
      compactionEvents.push(event.active)
      if (!event.active) return
      // Asked while the summary is in flight, which is the only moment the
      // answer can be wrong.
      sawListedWhileCompacting = runner.compactingSessions().includes(event.sessionID)
    })
    const tight = await sessions.create({ directory: project, model: { provider: "fake", model: "m" } })
    script = []
    const settle = idle(tight.id)
    await runner.prompt({ sessionID: tight.id, text: "fill the window" })
    await settle

    // 230,145 of transcript against a 262,144 window: a 32,000 answer is one
    // token too many, a 4,096 summary is not.
    enforceWindow = { window: 262144, tokens: 230145 }
    script = []
    const second = idle(tight.id)
    await runner.prompt({ sessionID: tight.id, text: "and one more" })
    await second
    enforceWindow = undefined
    stopWatching()

    const after = await sessions.get(tight.id)
    const messages = await sessions.messages(tight.id)
    /*
     * A summary of a long transcript takes minutes on a local model - five,
     * measured - and the last thing on screen before it starts is the
     * provider's refusal, in red. So the app says a compaction is under way
     * and says when it stops; without that it looks like it gave up, which is
     * how the working version of this was read the first time.
     */
    check("it said a compaction had started", compactionEvents.includes(true), JSON.stringify(compactionEvents))
    /*
     * And a window that reconnects while the summary is still streaming is
     * told, rather than keeping whatever it last heard - the event that ends a
     * compaction goes out once, so a socket that was down for it would show
     * the session summarising until the app was restarted.
     */
    check(
      "session.list reports a session compacting mid-summary",
      sawListedWhileCompacting === true,
      String(sawListedWhileCompacting),
    )
    check("and that it had finished", compactionEvents.at(-1) === false, JSON.stringify(compactionEvents))
    const last = messages.filter((message) => message.role === "assistant").at(-1)
    check("the session was compacted", Boolean(after?.compacted), JSON.stringify(after?.compacted ?? null))
    check("and the turn finished after it", last?.finish === "end_turn" && !last.error, String(last?.finish ?? last?.error))
  }

  console.log("a model with a known window is compacted by count")
  {
    // The fake reports prompt_tokens 10 + completion_tokens 5 per turn. A
    // window of 20 with a 10-token ceiling leaves 10 usable: 15 crosses it.
    await config.setDiscovered("fake", [
      { id: "m", name: "M", contextWindow: 20, maxOutput: 10, input: 0, output: 0 },
    ])
    const counted = await sessions.create({ directory: project, model: { provider: "fake", model: "m" } })
    const before = requests.length
    script = []
    const turn = idle(counted.id)
    await runner.prompt({ sessionID: counted.id, text: "hello" })
    await turn
    const after = await sessions.get(counted.id)
    check("the turn ended compacted", Boolean(after?.compacted), JSON.stringify(after?.compacted ?? null))
    check("in two requests: the answer, then the summary", requests.length - before === 2, String(requests.length - before))
    const answer = JSON.parse(requests[before] ?? "{}") as { max_tokens?: number }
    check("and the request asked for the model's own ceiling", answer.max_tokens === 10, String(answer.max_tokens))
    await config.setDiscovered("fake", [])
  }

  /*
   * Two ways a restore can hand back something other than what it took.
   *
   * A project carrying "* text=auto" tells git to store text with LF endings,
   * so a CRLF file would come back with every line ending rewritten - a diff
   * against the whole file, from an undo that claims to have changed nothing.
   * And a file that is not text at all cannot survive a trip through a UTF-8
   * string: every byte the decoder does not understand is replaced by a
   * question mark, quietly, in a file nobody thinks to look at.
   *
   * A project of its own, so the attributes file does not follow the checks
   * above around.
   */
  console.log("undo puts back exactly what was there")
  {
    const awkward = path.join(root, "awkward")
    await fs.mkdir(awkward, { recursive: true })
    execFileSync("git", ["init", "-q"], { cwd: awkward })
    await fs.writeFile(path.join(awkward, ".gitattributes"), "* text=auto\n", "utf8")

    const crlf = path.join(awkward, "windows.txt")
    const binary = path.join(awkward, "icon.bin")
    const crlfBefore = Buffer.from("one\r\ntwo\r\n", "utf8")
    const binaryBefore = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01])
    await fs.writeFile(crlf, crlfBefore)
    await fs.writeFile(binary, binaryBefore)

    const rough = path.join(root, "rough.js")
    await fs.writeFile(
      rough,
      [
        `const fs = require("fs")`,
        `fs.writeFileSync(${JSON.stringify(forward(crlf))}, "replaced\\n")`,
        `fs.writeFileSync(${JSON.stringify(forward(binary))}, Buffer.from([0x00]))`,
        "",
      ].join("\n"),
      "utf8",
    )

    const odd = await sessions.create({ directory: awkward, model: { provider: "fake", model: "m" } })
    script = [[{ name: "bash", input: { command: `node '${forward(rough)}'`, description: "Rewrite two files" } }]]
    const done = idle(odd.id)
    await runner.prompt({ sessionID: odd.id, text: "rewrite both" })
    await done

    let restored = -1
    let refusal: string | undefined
    try {
      restored = await runner.undo(odd.id)
    } catch (failure) {
      refusal = (failure as Error).message
    }
    check("both files are taken back", refusal === undefined && restored === 2, refusal ?? String(restored))
    check(
      "a CRLF file keeps its line endings",
      (await fs.readFile(crlf).catch(() => Buffer.alloc(0))).equals(crlfBefore),
    )
    check(
      "and a file that is not text comes back byte for byte",
      (await fs.readFile(binary).catch(() => Buffer.alloc(0))).equals(binaryBefore),
    )
  }

  /*
   * When a turn cannot be described - no git to compare the project with, or
   * more changed than a snapshot can hold - the answer has to be a refusal the
   * user can read. Undoing the turn before it would put files back to a state
   * that never existed and report a count for it.
   */
  console.log("a turn that cannot be taken back")
  {
    const opaque = await sessions.create({ directory: project, model: { provider: "fake", model: "m" } })
    await sessions.pushSnapshot(opaque.id, { at: Date.now(), files: [], blocked: "This turn cannot be taken back." })

    let refusal: string | undefined
    try {
      await runner.undo(opaque.id)
    } catch (failure) {
      refusal = (failure as Error).message
    }
    check("undo says so rather than reporting a count", refusal === "This turn cannot be taken back.", String(refusal))
    check("the entry stays where it is", Boolean(await sessions.peekSnapshot(opaque.id, "undo")))
    check("and nothing is filed as redoable", !(await sessions.peekSnapshot(opaque.id, "redo")))
  }

  /*
   * Rolling the conversation back to a message.
   *
   * Two halves that have to say the same thing. Hiding the messages is easy and
   * on its own it is a lie: the reader is told the conversation has gone back
   * to a point, and the project still carries everything the hidden turns did.
   * So each check below reads both - what the transcript now shows, and what is
   * actually in the files - and the last of them reads what the model is given,
   * because a rolled back message that still reaches the model is the same lie
   * told to the other party.
   *
   * A project of its own, so the undo checks above are not being rolled back
   * underneath these.
   */
  console.log("rolling a conversation back to a message")
  const rollback = path.join(root, "rollback")
  await fs.mkdir(rollback, { recursive: true })
  execFileSync("git", ["init", "-q"], { cwd: rollback })
  const marker = path.join(root, "mark.js")
  await fs.writeFile(
    marker,
    [
      `const fs = require("fs")`,
      // Written relative to the shell tool's own working directory, which is
      // the project, so one script serves every turn.
      `fs.writeFileSync(process.argv[2], process.argv[3])`,
      "",
    ].join("\n"),
    "utf8",
  )
  const mark = (name: string, text: string) => ({
    command: `node '${forward(marker)}' ${name} ${text}`,
    description: `Write ${name}`,
  })

  /** Runs one turn that writes one file, and hands back the message it asked. */
  const turnWriting = async (sessionID: string, said: string, name: string, text: string) => {
    script = [[{ name: "bash", input: mark(name, text) }]]
    const done = idle(sessionID)
    const id = await runner.prompt({ sessionID, text: said })
    await done
    return id
  }

  const held = (name: string) => fs.readFile(path.join(rollback, name), "utf8").catch(() => "(absent)")

  {
    const talk = await sessions.create({ directory: rollback, model: { provider: "fake", model: "m" } })
    const first = await turnWriting(talk.id, "write the first file", "one.txt", "first")
    const second = await turnWriting(talk.id, "write the second file", "two.txt", "second")
    await turnWriting(talk.id, "write the third file", "three.txt", "third")

    const beforeDepth = (await sessions.historyDepth(talk.id)).undo
    check("three turns are recorded", beforeDepth === 3, String(beforeDepth))

    const rolled = (await handle(runtime, { type: "session.revert", sessionID: talk.id, messageID: second })) as {
      session: { revert?: { messageID: string } }
      files: number
    }

    check(
      "rolling back to a message puts the boundary on it",
      rolled.session.revert?.messageID === second,
      String(rolled.session.revert?.messageID),
    )
    check("the files those turns wrote are gone", (await held("two.txt")) === "(absent)" && (await held("three.txt")) === "(absent)")
    check("the turn before it is left alone", (await held("one.txt")) === "first")
    check("and the count is what was put back", rolled.files === 2, String(rolled.files))
    /*
     * The two ways of taking files back have to leave each other alone. A turn
     * that has been rolled back is off the undo stack while it is rolled back,
     * or the next Undo would reach past the boundary and take back a turn the
     * reader can still see.
     */
    const during = await sessions.historyDepth(talk.id)
    check("the rolled back turns leave the undo stack", during.undo === 1, String(during.undo))

    /*
     * Kept, not deleted. The messages are what makes restoring possible, and a
     * window reading the session has to be able to show them in the dock.
     */
    const kept = (await sessions.messages(talk.id)).some((message) => message.id === second)
    check("the rolled back messages are still on disk", kept)

    // Restoring one turn: the message asked for comes back, the one after it
    // stays rolled back, and the file follows each way.
    const messages = await sessions.messages(talk.id)
    const afterSecond = messages.find(
      (message, at) => message.role === "user" && at > messages.findIndex((m) => m.id === second),
    )
    const partly = (await handle(runtime, {
      type: "session.revert",
      sessionID: talk.id,
      messageID: afterSecond?.id,
    })) as { session: { revert?: { messageID: string } }; files: number }
    check(
      "restoring one message moves the boundary to the next",
      partly.session.revert?.messageID === afterSecond?.id,
      String(partly.session.revert?.messageID),
    )
    check("its file is back", (await held("two.txt")) === "second")
    check("and the one still rolled back stays gone", (await held("three.txt")) === "(absent)")

    const all = (await handle(runtime, { type: "session.revert", sessionID: talk.id })) as {
      session: { revert?: { messageID: string } }
    }
    check("restoring the rest clears the boundary", all.session.revert === undefined)
    check("and the last file is back too", (await held("three.txt")) === "third")
    const depth = (await sessions.historyDepth(talk.id)).undo
    check("every turn is undoable again", depth === beforeDepth, `${depth} of ${beforeDepth}`)
    check("the first message is still the first", first === (await sessions.messages(talk.id))[0].id)
  }

  {
    /*
     * What the model is told, and what is left on disk, once the conversation
     * carries on from a rolled back point. The abandoned branch cannot stay:
     * left in the transcript it would be sent with the next question, and the
     * model would answer as though the rollback had never happened.
     */
    const branch = await sessions.create({ directory: rollback, model: { provider: "fake", model: "m" } })
    await turnWriting(branch.id, "keep this one", "kept.txt", "kept")
    const abandoned = await turnWriting(branch.id, "abandon this one", "gone.txt", "gone")

    await handle(runtime, { type: "session.revert", sessionID: branch.id, messageID: abandoned })
    requests = []
    script = []
    const done = idle(branch.id)
    await runner.prompt({ sessionID: branch.id, text: "go a different way" })
    await done

    const said = (await sessions.messages(branch.id)).filter((message) => message.role === "user").map((m) => m.text)
    check(
      "prompting after a rollback drops what was rolled back",
      said.join(" | ") === "keep this one | go a different way",
      said.join(" | "),
    )
    check(
      "the model is not given the abandoned message",
      !(requests[0] ?? "").includes("abandon this one"),
    )
    check("and it is given the one that was kept", (requests[0] ?? "").includes("keep this one"))
    check("the rolled back file stays rolled back", (await held("gone.txt")) === "(absent)")
    const session = await sessions.require(branch.id)
    check("and the session no longer says anything is rolled back", session.revert === undefined)
  }

  {
    /*
     * An ordinary undo followed by a rollback that reaches past it.
     *
     * Undo leaves the turn it took back sitting on the redo stack, with its
     * messages still on screen. Once the boundary has moved past those messages
     * that offer is no longer a coherent one: accepting it would put files back
     * for a turn the reader can no longer see.
     */
    const mixed = await sessions.create({ directory: rollback, model: { provider: "fake", model: "m" } })
    await turnWriting(mixed.id, "the turn that stays", "stays.txt", "stays")
    const undone = await turnWriting(mixed.id, "the turn to undo", "undone.txt", "undone")

    await runner.undo(mixed.id)
    const offered = await sessions.historyDepth(mixed.id)
    check("an ordinary undo leaves something to redo", offered.redo === 1, String(offered.redo))

    await runner.revert(mixed.id, undone)
    const after = await sessions.historyDepth(mixed.id)
    check("rolling back past an undone turn stops offering to redo it", after.redo === 0, String(after.redo))
  }

  {
    /*
     * A turn that answered more than one message, because the user typed again
     * while it was running. There is no state on disk between those messages,
     * so a rollback aimed at the second has to take the whole turn back and say
     * so by moving the boundary to where it really went.
     */
    const steered = await sessions.create({ directory: rollback, model: { provider: "fake", model: "m" } })
    await turnWriting(steered.id, "settle the ground", "ground.txt", "ground")

    let joined = "(never sent)"
    // Counted from here, because the hook is handed the number of requests the
    // fake provider has answered since this was last cleared.
    requests = []
    onRequest = (n) => {
      if (n !== 1) return
      void runner
        .prompt({ sessionID: steered.id, text: "and while you are there" })
        .then((id) => (joined = id))
        .catch((failure: Error) => (joined = `refused: ${failure.message}`))
    }
    script = [[{ name: "bash", input: mark("steered.txt", "steered") }]]
    const opening = await runner.prompt({ sessionID: steered.id, text: "start the second turn" })
    await stopped(steered.id)
    onRequest = undefined
    check("the steered message joined the turn", joined.startsWith("msg_"), joined)

    const rolled = (await handle(runtime, { type: "session.revert", sessionID: steered.id, messageID: joined })) as {
      session: { revert?: { messageID: string } }
    }
    check(
      "rolling back to a steered message takes the whole turn that answered it",
      rolled.session.revert?.messageID === opening,
      `${rolled.session.revert?.messageID} rather than ${opening}`,
    )
    check("the file that turn wrote is gone", (await held("steered.txt")) === "(absent)")
    check("and the turn before it is untouched", (await held("ground.txt")) === "ground")
  }

  {
    /*
     * The two ways a rollback has to refuse rather than move the transcript on
     * its own: a turn nothing could record, and a turn older than the history
     * still holds. Either way the files cannot be put back, and a transcript
     * that went back without them would be telling the reader something untrue.
     */
    const refused = await sessions.create({ directory: rollback, model: { provider: "fake", model: "m" } })
    const one: Message = {
      id: "msg_rollback_one",
      sessionID: refused.id,
      role: "user",
      text: "the first",
      attachments: [],
      time: { created: 1 },
    }
    const two: Message = { ...one, id: "msg_rollback_two", text: "the second", time: { created: 2 } }
    await sessions.saveMessage(one)
    await sessions.saveMessage(two)
    await sessions.pushSnapshot(refused.id, {
      at: Date.now(),
      files: [],
      blocked: "This turn cannot be taken back.",
      messages: [two.id],
    })

    let refusal: string | undefined
    try {
      await runner.revert(refused.id, two.id)
    } catch (failure) {
      refusal = (failure as Error).message
    }
    check("a turn nothing could record refuses the rollback", refusal === "This turn cannot be taken back.", String(refusal))
    check(
      "and the conversation is left where it was",
      (await sessions.require(refused.id)).revert === undefined,
    )

    /*
     * A turn recorded by a build that did not yet note which messages a turn
     * answered. Nothing can say whether it belongs inside the range being
     * rolled back, so the transcript must not move past it either.
     */
    const older = await sessions.create({ directory: rollback, model: { provider: "fake", model: "m" } })
    const stale: Message = { ...one, sessionID: older.id, id: "msg_stale_one" }
    await sessions.saveMessage(stale)
    await sessions.pushSnapshot(older.id, { at: Date.now(), files: [] })

    let unknown: string | undefined
    try {
      await runner.revert(older.id, stale.id)
    } catch (failure) {
      unknown = (failure as Error).message
    }
    check(
      "a turn recorded before rollback existed refuses too",
      (unknown ?? "").includes("before messages could be rolled back"),
      String(unknown),
    )
    check("and leaves that conversation alone", (await sessions.require(older.id)).revert === undefined)

    /*
     * Past the depth the undo stack holds. Filed directly rather than by running
     * twenty-one turns: what is being checked is the refusal, not the recording.
     */
    const deep = await sessions.create({ directory: rollback, model: { provider: "fake", model: "m" } })
    const old: Message = { ...one, sessionID: deep.id, id: "msg_deep_old", text: "long ago" }
    const recent: Message = { ...old, id: "msg_deep_recent", text: "just now", time: { created: 2 } }
    await sessions.saveMessage(old)
    await sessions.saveMessage(recent)
    await sessions.pushSnapshot(deep.id, { at: Date.now(), files: [], messages: [old.id] })
    for (let i = 0; i < 25; i++) {
      await sessions.pushSnapshot(deep.id, { at: Date.now(), files: [], messages: [recent.id] })
    }

    let far: string | undefined
    try {
      await runner.revert(deep.id, old.id)
    } catch (failure) {
      far = (failure as Error).message
    }
    check("a message older than the history can reach refuses too", (far ?? "").includes("no longer reaches back"), String(far))
    check("and that conversation is left where it was", (await sessions.require(deep.id)).revert === undefined)
  }

  /*
   * Words typed while the model is working.
   *
   * A prompt sent mid-turn used to be refused, so the only way to redirect a
   * model that had misread the task was to stop it and start again, throwing
   * away everything the turn had done. Now it joins the turn - and there are
   * exactly three ways that message can still go missing: never reaching the
   * model, reaching it in the wrong order, or arriving in the moment the turn
   * is being packed away, when neither the turn that is ending nor the one that
   * has not started owns it.
   *
   * The fourth check is the defect this feature is most likely to bring back.
   * One session must never run two turns: that was fixed once already, and it
   * shows up here as two assistant messages being written at the same time.
   */
  console.log("steering a turn that is already running")
  const waiter = path.join(root, "wait.js")
  await fs.writeFile(waiter, "setTimeout(() => {}, 250)\n", "utf8")
  const wait = { command: `node '${forward(waiter)}'`, description: "Wait a moment" }

  const openTurns = new Map<string, Set<string>>()
  let overlaps = 0
  const offOverlap = bus.subscribe((event) => {
    if (event.type !== "message.updated") return
    const message = event.message
    if (message.role !== "assistant") return
    let open = openTurns.get(message.sessionID)
    if (!open) openTurns.set(message.sessionID, (open = new Set()))
    if (message.time.completed) {
      open.delete(message.id)
      return
    }
    open.add(message.id)
    // Two unfinished replies in one session means two loops are writing to it.
    if (open.size > 1) overlaps++
  })

  {
    const steered = await sessions.create({ directory: project, model: { provider: "fake", model: "m" } })
    requests = []
    let joined = "(never sent)"
    /*
     * Sent as the provider takes the first request, so the turn is genuinely in
     * flight: the model is answering and a tool is about to run. That is the
     * moment the composer used to refuse.
     */
    onRequest = (n) => {
      if (n !== 1) return
      void runner
        .prompt({ sessionID: steered.id, text: "actually, look at the other file" })
        .then((id) => (joined = id))
        .catch((failure: Error) => (joined = `refused: ${failure.message}`))
    }
    let turns = 0
    const offTurns = bus.subscribe((event) => {
      if (event.type === "session.idle" && (event as { sessionID: string }).sessionID === steered.id) turns++
    })

    script = [[{ name: "bash", input: wait }]]
    await runner.prompt({ sessionID: steered.id, text: "start on the first file" })
    await stopped(steered.id)
    onRequest = undefined
    offTurns()

    check("a prompt sent while the model is working is accepted", joined.startsWith("msg_"), joined)
    check("the model is asked again after it", requests.length >= 2, `${requests.length} request(s)`)
    check(
      "and is given what was said, in the turn that was already running",
      (requests[1] ?? "").includes("actually, look at the other file") && turns === 1,
      `${turns} turn(s)`,
    )
  }

  {
    const quick = await sessions.create({ directory: project, model: { provider: "fake", model: "m" } })
    requests = []
    /*
     * Both sent without waiting for the first to be written, which is what two
     * lines typed a moment apart look like from here. Order is the whole point:
     * a pair that arrives reversed reads as the model ignoring the correction
     * and obeying the thing being corrected.
     */
    onRequest = (n) => {
      if (n !== 1) return
      void runner.prompt({ sessionID: quick.id, text: "and rename the helper" }).catch(() => undefined)
      void runner.prompt({ sessionID: quick.id, text: "then update the tests" }).catch(() => undefined)
    }

    script = [[{ name: "bash", input: wait }]]
    await runner.prompt({ sessionID: quick.id, text: "start on the helper" })
    await stopped(quick.id)
    onRequest = undefined

    const body = requests[1] ?? ""
    const first = body.indexOf("and rename the helper")
    const second = body.indexOf("then update the tests")
    check("two prompts sent in quick succession both reach the model", first >= 0 && second >= 0, body.length ? "" : "no second request")
    check("in the order they were sent", first >= 0 && first < second, `${first} then ${second}`)
    const said = (await sessions.messages(quick.id)).filter((message) => message.role === "user").map((m) => m.text)
    check(
      "and the transcript reads in that order too",
      said.join(" | ") === "start on the helper | and rename the helper | then update the tests",
      said.join(" | "),
    )
  }

  {
    const late = await sessions.create({ directory: project, model: { provider: "fake", model: "m" } })
    requests = []
    // No tool call, so the turn ends at its first reply and the window below is
    // the release itself rather than a gap between steps.
    script = []
    let accepted = "(never sent)"
    const offEnding = bus.subscribe((event) => {
      if (event.type !== "message.updated") return
      const message = event.message
      if (message.sessionID !== late.id || message.role !== "assistant" || !message.finish) return
      offEnding()
      /*
       * One turn of the event loop after the model finished, which lands while
       * the session is being packed away - after the loop has stopped looking
       * for more and before the session is released. A message accepted here
       * belongs to no turn at all unless something goes and starts one.
       */
      setTimeout(() => {
        void runner
          .prompt({ sessionID: late.id, text: "wait, one more thing" })
          .then((id) => (accepted = id))
          .catch((failure: Error) => (accepted = `refused: ${failure.message}`))
      }, 0)
    })

    await runner.prompt({ sessionID: late.id, text: "answer briefly" })
    await stopped(late.id, 700)

    check("a prompt sent as the turn ends is not thrown away", accepted.startsWith("msg_"), accepted)
    check("a turn is started for it", requests.length >= 2, `${requests.length} request(s)`)
    check(
      "and the model is given what was said",
      (requests[requests.length - 1] ?? "").includes("wait, one more thing"),
    )
  }

  offOverlap()
  check("no session ever had two turns writing at once", overlaps === 0, `${overlaps} overlap(s)`)

  // --- two prompts at once claim one session, not two -----------------------
  console.log("stopping a turn")
  {
    const halted = await sessions.create({ directory: project, model: { provider: "fake", model: "m" } })
    requests = []
    /*
     * Stopped once the tool is running, rather than while the model is still
     * writing. Those are two different ways out of the loop and only the first
     * recorded that it had been stopped, so a turn killed during a command read
     * in the transcript as one that had finished by itself.
     */
    onRequest = (n) => {
      if (n !== 1) return
      // Long enough for the tool to have started, short enough to still be in it.
      setTimeout(() => void runner.abort(halted.id), 120)
    }
    script = [[{ name: "bash", input: wait }]]
    await runner.prompt({ sessionID: halted.id, text: "run something slow" }).catch(() => undefined)
    await stopped(halted.id)
    onRequest = undefined

    const turns = (await sessions.messages(halted.id)).filter((message) => message.role === "assistant")
    const last = turns[turns.length - 1]
    const finish = last && "finish" in last ? last.finish : undefined
    check("a turn stopped while its tool was running is on the transcript", Boolean(last))
    check("and says it was stopped", finish === "aborted", `finish is ${JSON.stringify(finish)}`)
    check("and the session is idle afterwards", !runner.busySessions().includes(halted.id))
  }

  console.log("concurrent prompts")
  const three = await sessions.create({ directory: project, model: { provider: "fake", model: "m" } })
  const settled = await Promise.allSettled([
    runner.prompt({ sessionID: three.id, text: "first" }),
    runner.prompt({ sessionID: three.id, text: "second" }),
  ])
  const accepted = settled.filter((entry) => entry.status === "fulfilled").length
  check("only one of two simultaneous prompts is accepted", accepted === 1, `${accepted} accepted`)
  await new Promise((resolve) => setTimeout(resolve, 1200))
  const asked = (await sessions.messages(three.id)).filter((message) => message.role === "user")
  check("only one question reached the transcript", asked.length === 1, `${asked.length} user message(s)`)

  // A prompt that fails during setup must not leave the session stuck busy.
  const four = await sessions.create({ directory: project, model: { provider: "nonexistent", model: "m" } })
  let refused = false
  try {
    await runner.prompt({ sessionID: four.id, text: "this cannot run" })
  } catch {
    refused = true
  }
  check("a prompt that cannot start is refused", refused)
  check("and does not leave the session busy", !runner.busySessions().includes(four.id))

  // --- a tool that failed says so, in the shape ChatGPT reads ---------------
  /*
   * The Codex adapter posts every earlier tool result back as a
   * function_call_output, and there is no flag on that item for a failure - the
   * text is the whole message. A tool that was killed still carries the output
   * it managed to stream, so sending the output alone describes a run that
   * finished, and a tool that produced nothing before failing sends nothing at
   * all.
   */
  console.log("a failed tool reaching the model")
  {
    const partial = "Compiling...\n42 files"
    const history: Message[] = [
      { id: "u1", sessionID: "x", role: "user", text: "run the build", attachments: [], time: { created: 1 } },
      {
        id: "a1",
        sessionID: "x",
        role: "assistant",
        model: { provider: "chatgpt", model: "gpt-5-codex" },
        agent: "build",
        parts: [
          {
            type: "tool",
            id: "p1",
            callID: "call_1",
            name: "bash",
            status: "error",
            input: { command: "npm run build" },
            // Exactly what bash leaves behind when its timeout fires: whatever
            // it had streamed, plus the failure that ended it.
            output: partial,
            error: `Command timed out after 3000ms:\n${partial}`,
            time: { created: 1, completed: 2 },
          },
        ],
        time: { created: 1, completed: 2 },
      },
    ]

    codexBody = ""
    await ChatGPTSubscription.stream(
      {
        apiKey: "token",
        model: { provider: "chatgpt", model: "gpt-5-codex" },
        system: "",
        history,
        tools: [],
        effort: "high",
        showReasoning: false,
        signal: new AbortController().signal,
        baseURL: `http://127.0.0.1:${port}/codex`,
      },
      () => undefined,
    )

    const sent = JSON.parse(codexBody) as { input: { type: string; output?: string }[] }
    const result = sent.input.find((item) => item.type === "function_call_output")
    check("the failed call is still paired with a result", Boolean(result))
    check("the model is told the command failed", (result?.output ?? "").includes("timed out"))
    check(
      "and is not handed the partial output as a finished run",
      result?.output !== partial,
      String(result?.output),
    )
  }

  // --- a question asked while nobody was listening is still answerable ------
  console.log("a permission request outliving its window")
  {
    // Nothing is pre-approved here, or the request would never be raised.
    await config.set({ autoApprove: [] })
    const five = await sessions.create({ directory: project, model: { provider: "fake", model: "m" } })

    let answered: string | undefined
    const parked = permissions
      .ask({
        sessionID: five.id,
        messageID: "m1",
        callID: "c1",
        kind: "bash",
        title: "Run command",
        subject: "git push",
        preview: "git push",
      })
      .then(() => (answered = "released"))
      .catch((error: Error) => (answered = error.message))

    // What a window that has just reloaded, or has just opened, asks for.
    const listed = await handle(runtime, { type: "session.list" })
    // Read defensively so a reply that simply stopped carrying the field is
    // reported as a failed check rather than crashing the run.
    const carried = (listed as { permissions?: { id: string; sessionID: string; subject: string }[] }).permissions ?? []
    const replayed = carried.find((item) => item.sessionID === five.id)
    check("session.list replays a question nobody has answered", Boolean(replayed))
    check("carrying the subject the dialog has to show", replayed?.subject === "git push", String(replayed?.subject))

    /*
     * A tool parked on a question nobody can reach never settles, which is the
     * defect itself - so when nothing came back the request is cleared here
     * rather than left to hang the run, and the checks below say what happened.
     */
    if (replayed) permissions.respond(replayed.id, "once")
    else permissions.rejectAll(five.id)
    await parked
    check("answering the replayed request releases the parked tool", answered === "released", String(answered))
    check("and it stops being outstanding", permissions.outstanding().length === 0)
  }

  // --- allow, ask, and the answer there was no way to give ------------------
  /*
   * A bucket used to be on a list or off it: waved through, or asked about.
   * There was no way to say never, so the only way to refuse a tool was to sit
   * and refuse each of its questions by hand, one turn at a time.
   *
   * These run through the real runner, because the two halves of a refusal are
   * both outside the permission system itself: whether a question reaches the
   * bus, and whether the model is handed something it can act on. Only the last
   * block reaches into `check` directly, and says why.
   */
  console.log("the three answers")

  /** Everything at its default, with a few buckets set deliberately. */
  const say = (changes: Partial<Record<PermissionKind, PermissionAction>>) =>
    config.set({ permissions: { ...DEFAULT_PERMISSIONS, ...changes } })

  /** Every question raised for one session while this is listening. */
  const listen = (sessionID: string) => {
    const seen: PermissionRequest[] = []
    const off = bus.subscribe((event) => {
      if (event.type !== "permission.requested") return
      const request = (event as { request: PermissionRequest }).request
      if (request.sessionID === sessionID) seen.push(request)
    })
    return { seen, off }
  }

  /** The bash part of the last turn, which is what these checks are about. */
  const lastCall = async (sessionID: string) => {
    const messages = await sessions.messages(sessionID)
    const parts = messages.flatMap((message) => (message.role === "assistant" ? message.parts : []))
    return [...parts].reverse().find((part) => part.type === "tool" && part.name === "bash")
  }

  {
    const target = path.join(project, "answer.txt")

    // Deny: refused before it runs, with nothing on screen and the model told.
    await say({ bash: "deny" })
    await fs.rm(target, { force: true })
    const refusedSession = await sessions.create({ directory: project, model: { provider: "fake", model: "m" } })
    const watch = listen(refusedSession.id)
    const before = requests.length
    script = [[{ name: "bash", input: mark("answer.txt", "ran") }]]
    let done = idle(refusedSession.id)
    await runner.prompt({ sessionID: refusedSession.id, text: "run it" })
    await done
    watch.off()

    const refusedCall = await lastCall(refusedSession.id)
    const refusal = refusedCall?.type === "tool" ? (refusedCall.error ?? "") : ""
    check("a denied tool never raises a question", watch.seen.length === 0, `${watch.seen.length} raised`)
    check("the call is refused rather than run", refusedCall?.type === "tool" && refusedCall.status === "error")
    check("and nothing it would have done happened", !(await fs.stat(target).catch(() => undefined)))
    check("the refusal names the setting, not the user", refusal.includes("set to Deny"), refusal)
    check(
      "and says asking again will not help",
      refusal.includes("Asking again will be refused"),
      refusal,
    )
    /*
     * The proof that this is information rather than a crash: the same text is
     * posted back as the result of the call, which is all the model ever reads.
     */
    const told = requests.slice(before).some((body) => body.includes("set to Deny"))
    check("the model is handed that refusal as the tool's result", told)

    // Ask: still stops and asks, and running it is still the user's decision.
    await say({ bash: "ask" })
    await fs.rm(target, { force: true })
    const askedSession = await sessions.create({ directory: project, model: { provider: "fake", model: "m" } })
    const asked = listen(askedSession.id)
    const answering = bus.subscribe((event) => {
      if (event.type !== "permission.requested") return
      const request = (event as { request: PermissionRequest }).request
      if (request.sessionID === askedSession.id) permissions.respond(request.id, "once")
    })
    script = [[{ name: "bash", input: mark("answer.txt", "ran") }]]
    done = idle(askedSession.id)
    await runner.prompt({ sessionID: askedSession.id, text: "run it" })
    await done
    answering()
    asked.off()

    check("an asked tool still asks", asked.seen.length === 1, `${asked.seen.length} raised`)
    check("the question carries the command", (asked.seen[0]?.subject ?? "").includes("answer.txt"))
    check("and answering it lets the tool run", (await fs.readFile(target, "utf8").catch(() => "")) === "ran")

    // Allow: runs with nothing asked, which is what the old list did.
    await say({ bash: "allow" })
    await fs.rm(target, { force: true })
    const allowedSession = await sessions.create({ directory: project, model: { provider: "fake", model: "m" } })
    const quiet = listen(allowedSession.id)
    script = [[{ name: "bash", input: mark("answer.txt", "ran") }]]
    done = idle(allowedSession.id)
    await runner.prompt({ sessionID: allowedSession.id, text: "run it" })
    await done
    quiet.off()

    check("an allowed tool runs without asking", quiet.seen.length === 0, `${quiet.seen.length} raised`)
    check("and it really ran", (await fs.readFile(target, "utf8").catch(() => "")) === "ran")
  }

  /*
   * Deny has to beat an approval already given.
   *
   * "Always" is remembered for the session, and a decision read after it would
   * mean switching a tool off did nothing until the app was restarted - the
   * exact shape of bug that makes a setting untrustworthy.
   */
  console.log("switching a tool off part way through a session")
  {
    const session = await sessions.create({ directory: project, model: { provider: "fake", model: "m" } })
    await say({ bash: "ask" })
    const answering = bus.subscribe((event) => {
      if (event.type !== "permission.requested") return
      permissions.respond((event as { request: PermissionRequest }).request.id, "always")
    })
    await permissions.ask({
      sessionID: session.id,
      messageID: "m1",
      callID: "c1",
      kind: "bash",
      title: "Run command",
      subject: "git status",
    })
    answering()

    let second: string | undefined
    await permissions
      .ask({
        sessionID: session.id,
        messageID: "m2",
        callID: "c2",
        kind: "bash",
        title: "Run command",
        subject: "git status",
      })
      .catch((error: Error) => (second = error.message))
    check("an always granted in this session is remembered", second === undefined, String(second))

    await say({ bash: "deny" })
    let third: string | undefined
    await permissions
      .ask({
        sessionID: session.id,
        messageID: "m3",
        callID: "c3",
        kind: "bash",
        title: "Run command",
        subject: "git status",
      })
      .catch((error: Error) => (third = error.message))
    check("and Deny still beats it", (third ?? "").includes("set to Deny"), String(third))

    /*
     * The question already on screen when the answer changes. Leaving it there
     * is the same defect as raising one for a tool that is switched off, only
     * slower to notice.
     */
    await say({ bash: "ask" })
    const parked = await sessions.create({ directory: project, model: { provider: "fake", model: "m" } })
    let closed: string | undefined
    const waiting = permissions
      .ask({
        sessionID: parked.id,
        messageID: "m4",
        callID: "c4",
        kind: "bash",
        title: "Run command",
        subject: "git push",
      })
      .catch((error: Error) => (closed = error.message))
    check("the question is up", permissions.outstanding().length === 1)
    await say({ bash: "deny" })
    /*
     * Raced against a timer rather than simply awaited. The failure this is for
     * is a question that is never settled at all, and waiting on that for ever
     * would hang the whole run instead of reporting it.
     */
    await Promise.race([waiting, new Promise((resolve) => setTimeout(resolve, 500))])
    check("switching the bucket to Deny closes it", permissions.outstanding().length === 0)
    check("with the refusal the model can read", (closed ?? "").includes("set to Deny"), String(closed))
    if (permissions.outstanding().length) permissions.rejectAll(parked.id)
    await waiting
  }

  // --- the buckets nothing used to consult ---------------------------------
  /*
   * `read`, `list`, `glob`, `grep` and `todowrite` each declare a bucket on
   * their tool and none of them ever asked anything, so the name was declared
   * into a void: it could not be pre-approved, configured or refused.
   *
   * `Permissions.check` is where those buckets are consulted. It is reached
   * directly here because its one call site is a line in the session runner,
   * which this task does not own - so what can honestly be checked is the gate
   * itself, not a tool passing through it.
   */
  console.log("the buckets that never asked")
  {
    const session = await sessions.create({ directory: project, model: { provider: "fake", model: "m" } })
    const call = (kind: string, tool: string, args: Record<string, unknown>) =>
      permissions.check({ sessionID: session.id, messageID: "m1", callID: "c1", tool, kind, arguments: args })

    await say({ read: "deny" })
    const watch = listen(session.id)
    let refused: string | undefined
    await call("read", "read", { path: "secrets.txt" }).catch((error: Error) => (refused = error.message))
    check("a denied read is refused", (refused ?? "").includes("set to Deny"), String(refused))
    check("the subject is the file it was about", (refused ?? "").includes("secrets.txt"), String(refused))
    check("and no question was raised for it", watch.seen.length === 0, `${watch.seen.length} raised`)

    await say({ grep: "ask" })
    let settled = false
    const asking = call("grep", "grep", { pattern: "TODO" }).then(() => (settled = true))
    await new Promise((resolve) => setTimeout(resolve, 20))
    check("a bucket set to ask now raises a question", watch.seen.length === 1, `${watch.seen.length} raised`)
    check("naming what is being searched for", watch.seen[0]?.subject === "TODO", String(watch.seen[0]?.subject))
    if (watch.seen[0]) permissions.respond(watch.seen[0].id, "once")
    await asking
    check("and answering it lets the call through", settled)

    await say({ list: "allow" })
    let quiet = false
    await call("list", "list", { path: "src" }).then(() => (quiet = true))
    check("an allowed one asks nothing", quiet && watch.seen.length === 1, `${watch.seen.length} raised`)

    /*
     * A tool that puts its own question is left to put it. A second, vaguer
     * question in front of the one that can show the command would be noise.
     */
    await say({ bash: "ask" })
    let waved = false
    await call("bash", "bash", { command: "git status" }).then(() => (waved = true))
    check("a tool that asks for itself is not asked about twice", waved && watch.seen.length === 1)

    await say({ bash: "deny" })
    let stopped: string | undefined
    await call("bash", "bash", { command: "git status" }).catch((error: Error) => (stopped = error.message))
    check("but Deny still stops it before it starts", (stopped ?? "").includes("set to Deny"), String(stopped))
    watch.off()
  }

  /*
   * The same bucket again, reached the way a real call reaches it.
   *
   * Everything above speaks to Permissions.check directly. That proves the
   * decision is right and proves nothing about anybody asking for it, and a
   * setting nothing consults is the exact defect these three answers exist to
   * remove - it is how read, glob, grep, list and todowrite came to be declared
   * on their tools and still be beyond reach. So this drives a turn through the
   * runner: delete the call in front of tool.execute and these fail, where the
   * ones above carry on passing.
   */
  console.log("a bucket that never asked, reached through the runner")
  {
    const target = path.join(project, "notes.txt")
    await fs.writeFile(target, "nothing secret here", "utf8")

    await say({ read: "deny" })
    const session = await sessions.create({ directory: project, model: { provider: "fake", model: "m" } })
    const watch = listen(session.id)
    const before = requests.length
    script = [[{ name: "read", input: { path: "notes.txt" } }]]
    let done = idle(session.id)
    await runner.prompt({ sessionID: session.id, text: "read it" })
    await done
    watch.off()

    const readCall = async (sessionID: string) => {
      const messages = await sessions.messages(sessionID)
      const parts = messages.flatMap((message) => (message.role === "assistant" ? message.parts : []))
      return [...parts].reverse().find((part) => part.type === "tool" && part.name === "read")
    }

    const refusedCall = await readCall(session.id)
    const refusal = refusedCall?.type === "tool" ? (refusedCall.error ?? "") : ""
    check(
      "a real call into a denied bucket is stopped",
      refusedCall?.type === "tool" && refusedCall.status === "error",
      refusedCall?.type === "tool" ? refusedCall.status : String(refusedCall),
    )
    check("by the setting rather than by the tool", refusal.includes("set to Deny"), refusal)
    check("with nothing put on screen for it", watch.seen.length === 0, `${watch.seen.length} raised`)
    check(
      "and the model handed the reason as the call's result",
      requests.slice(before).some((body) => body.includes("set to Deny")),
    )

    // The other edge: left alone, the same call goes through untouched.
    await say({})
    const openSession = await sessions.create({ directory: project, model: { provider: "fake", model: "m" } })
    const quiet = listen(openSession.id)
    script = [[{ name: "read", input: { path: "notes.txt" } }]]
    done = idle(openSession.id)
    await runner.prompt({ sessionID: openSession.id, text: "read it" })
    await done
    quiet.off()

    const openCall = await readCall(openSession.id)
    check(
      "and the same call runs when the bucket is left alone",
      openCall?.type === "tool" && openCall.status === "completed",
      openCall?.type === "tool" ? `${openCall.status} ${openCall.error ?? ""}` : String(openCall),
    )
    check("still without asking", quiet.seen.length === 0, `${quiet.seen.length} raised`)
  }

  // --- a config written before there was a third answer ---------------------
  /*
   * Everyone already running this app has `autoApprove`, a list of the buckets
   * they approved. Reading it as anything other than what they chose would
   * either re-ask for tools they had waved through or, far worse, wave through
   * tools they had not.
   */
  console.log("a config from before the third answer")
  {
    const older = path.join(root, "older")
    const storageOld = new Storage(path.join(older, "storage"))
    await storageOld.write("config", { autoApprove: ["bash", "outside"] })
    const configOld = new Config(storageOld, new Bus(), path.join(older, "credentials.json"))
    await configOld.load()
    const kept = configOld.get().permissions

    check("a bucket they approved runs without asking", kept.bash === "allow", String(kept.bash))
    check("and so does the other one", kept.outside === "allow", String(kept.outside))
    check("one they did not approve still asks", kept.edit === "ask", String(kept.edit))
    check("and nothing is refused, because they never said so", kept.write === "ask", String(kept.write))
    /*
     * The five that never asked are the point of this one: they are new to the
     * list, and their owner cannot have had an opinion about them. Reading an
     * absence as "ask" would start interrupting a session that never was.
     */
    check("a bucket that never asked still does not", kept.read === "allow", String(kept.read))
    check("the old list still reads back", configOld.get().autoApprove.includes("bash"))

    // A config from before any of this, which is most of them.
    const bare = path.join(root, "bare")
    const storageBare = new Storage(path.join(bare, "storage"))
    await storageBare.write("config", { theme: "dark" })
    const configBare = new Config(storageBare, new Bus(), path.join(bare, "credentials.json"))
    await configBare.load()
    check("a config with nothing to say gets the behaviour it had", configBare.get().permissions.bash === "ask")
    check("and its reads stay quiet", configBare.get().permissions.glob === "allow")

    /*
     * And a patch still written in the old vocabulary - which the title bar's
     * auto-accept toggle sends - must not be able to revoke a "never", because
     * that vocabulary has no word for one.
     */
    await say({ bash: "deny", edit: "allow" })
    await config.set({ autoApprove: [] })
    check("an old-shaped patch puts the asking buckets back to asking", config.get().permissions.edit === "ask")
    check("and cannot talk a refusal away", config.get().permissions.bash === "deny")
  }

  // Left as the rest of this run expects to find it.
  await say({ bash: "allow", edit: "allow", write: "allow", webfetch: "allow", outside: "allow", mcp: "allow" })

  // --- disconnecting a provider the environment supplies --------------------
  console.log("disconnecting an environment-backed provider")
  {
    process.env.OPENAI_API_KEY = "sk-from-the-shell"
    await config.setDiscovered("openai", [
      { id: "gpt-probe", name: "GPT Probe", contextWindow: 128000, input: 0, output: 0 },
    ])
    const status = () => config.providers().find((entry) => entry.id === "openai")

    check("the variable is what connects it", status()?.configured === true)
    check("and the interface is told which variable", status()?.environment === "OPENAI_API_KEY")

    let message: string | undefined
    try {
      await handle(runtime, { type: "provider.auth", provider: "openai", apiKey: "" })
    } catch (error) {
      message = (error as Error).message
    }
    check("disconnecting it is refused rather than silently doing nothing", Boolean(message))
    check("and the refusal names the variable", (message ?? "").includes("OPENAI_API_KEY"), String(message))
    check("the models it discovered are still there", status()?.models.length === 1, String(status()?.models.length))

    /*
     * Reached directly rather than through the handler: the catalog describes
     * the key that is in force, and that key is still in force.
     */
    await config.setApiKey("openai", "")
    check("and clearing the stored key leaves them alone", config.models("openai").length === 1)
    delete process.env.OPENAI_API_KEY
  }

  // --- a custom provider whose credential is a header -----------------------
  /*
   * The custom-provider form's key field is labelled "Optional. Leave empty if
   * you manage auth via headers", so this is the shape it invites. Measured in
   * the running app before this was fixed: the provider was listed in Settings,
   * tagged Custom, and its typed-in model appeared in no picker anywhere,
   * because three separate places asked for a stored key. All three are checked
   * here, since fixing one and not the others changes where the failure shows
   * up without removing it.
   */
  console.log("")
  console.log("a custom provider that authenticates with a header")
  {
    await handle(runtime, {
      type: "provider.addCustom",
      id: "byheader",
      name: "By Header",
      baseURL: "https://example.test/v1",
      apiKey: "",
      headers: { "X-Api-Key": "secret" },
      models: [{ id: "one", name: "One" }],
    })
    const status = () => config.providers().find((entry) => entry.id === "byheader")
    check("it counts as connected", status()?.configured === true)
    check("its model is offered", config.enabled().some((entry) => entry.provider === "byheader"))
    check("and a turn against it is not refused for want of a key", config.usable("byheader"))

    // The other half of the same rule: nothing to authenticate with is not
    // ready, whatever the provider was typed in by hand.
    await handle(runtime, {
      type: "provider.addCustom",
      id: "bynothing",
      name: "By Nothing",
      baseURL: "https://example.test/v1",
      apiKey: "",
      models: [{ id: "one", name: "One" }],
    })
    check("while one with neither key nor header is not", config.usable("bynothing") === false)
    check("and offers no model", config.enabled().every((entry) => entry.provider !== "bynothing"))
  }

  shells.closeAll()
  mcp.close()
  server.close()
  console.log("")
  if (problems.length) {
    console.error(`FAILED with ${problems.length} problem(s):`)
    for (const problem of problems) console.error("  " + problem)
    process.exit(1)
  }
  console.log(
    "Undo covers what the shell changed as well as what the tools reported, puts files back byte for byte, and refuses out loud when it cannot.",
  )
  console.log(
    "Rolling a conversation back moves the transcript and the project together, or refuses; carrying on from a rolled back point leaves the abandoned branch behind.",
  )
  process.exit(0)
}

void main()
