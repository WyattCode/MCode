/**
 * End-to-end smoke test for the backend, driven over the real WebSocket.
 *
 * Everything except the provider call is exercised here: session lifecycle,
 * persistence across a restart, the tool implementations, the permission
 * round-trip, and the diff renderer. No API key is required - the agent loop
 * itself is the one piece this cannot reach without one.
 */
import { nameFromId } from "../src/server/provider/model-name"
import { discoverModels } from "../src/server/provider/discover"
import { OpenAICompatible, toMessages } from "../src/server/provider/openai"
import { fromDataURL, linkFrom, nameFor } from "../src/renderer/src/lib/attach"
import { modelVariants } from "../src/server/provider/variants"
import { ProviderError } from "../src/server/provider/types"
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createServer } from "node:http"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { WebSocket } from "ws"
import { startBackend } from "../src/server/index"
import type { ClientFrame, Request, ServerEvent, ServerFrame } from "../src/shared/protocol"
import { PERMISSION_KINDS } from "../src/shared/protocol"
import { TOOLS, findTool, toolsFor } from "../src/server/tool/registry"
import { systemPrompt } from "../src/server/session/prompt"
import { ToolError } from "../src/server/tool/types"
import { runSearch } from "../src/server/tool/search-run"
import { PermissionDenied, Permissions } from "../src/server/permission"
import { Bus } from "../src/server/bus"
import { unifiedDiff } from "../src/server/diff"
import { globToRegExp } from "../src/server/tool/search"
import { discoverSubscriptionModels } from "../src/server/provider/discover"
import { workspaceInfo } from "../src/server/workspace"
import * as gitOps from "../src/server/git"
import { ChatGPTSubscription } from "../src/server/provider/chatgpt"
import type { TurnEvent } from "../src/server/provider/types"
import { toProviderMessages, usageFrom } from "../src/server/provider/anthropic"
import {
  CHATGPT,
  CallbackServer,
  accountId,
  begin,
  beginDevice,
  decodeClaims,
  needsRefresh,
  pollDevice,
  type OAuthProvider,
} from "../src/server/auth/oauth"

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`)
  }
}

function section(name: string) {
  console.log(`\n${name}`)
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-smoke-"))
  const dataDirectory = path.join(root, "data")
  const project = path.join(root, "project")
  await fs.mkdir(project, { recursive: true })
  await fs.writeFile(path.join(project, "hello.ts"), "export const greeting = 'hi'\nexport const count = 1\n")
  await fs.mkdir(path.join(project, "src"), { recursive: true })
  await fs.writeFile(path.join(project, "src", "app.ts"), "// TODO: implement\nexport function run() {}\n")
  await fs.writeFile(path.join(project, "AGENTS.md"), "Use two-space indentation.\n")

  // ---------------------------------------------------------------- protocol
  section("WebSocket protocol")
  const backend = await startBackend(dataDirectory)
  check("backend picked a port", backend.port > 0, backend.port)

  // The socket refuses anything that cannot present the launch token, so the
  // test connects the way the renderer does.
  const anonymousResult = await new Promise<string>((resolve) => {
    const anonymous = new WebSocket(`ws://127.0.0.1:${backend.port}`)
    anonymous.once("open", () => {
      anonymous.close()
      resolve("connected")
    })
    anonymous.once("error", (error: Error) => resolve(error.message))
  })
  check("a connection with no token is refused", anonymousResult.includes("401"), anonymousResult)

  const browserish = await new Promise<string>((resolve) => {
    const page = new WebSocket(`ws://127.0.0.1:${backend.port}`, backend.token, {
      headers: { Origin: "https://evil.example" },
    })
    page.once("open", () => {
      page.close()
      resolve("connected")
    })
    page.once("error", (error: Error) => resolve(error.message))
  })
  check("a web page origin is refused even with the token", browserish.includes("403"), browserish)

  const socket = new WebSocket(`ws://127.0.0.1:${backend.port}`, backend.token)
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve)
    socket.once("error", reject)
  })

  const events: ServerEvent[] = []
  const waiters = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  let counter = 0

  socket.on("message", (raw) => {
    const frame: ServerFrame = JSON.parse(raw.toString())
    if (frame.kind === "event") {
      events.push(frame.event)
      return
    }
    const waiter = waiters.get(frame.id)
    if (!waiter) return
    waiters.delete(frame.id)
    if (frame.ok) waiter.resolve(frame.data)
    else waiter.reject(new Error(frame.error))
  })

  function call<T = any>(request: Request): Promise<T> {
    const id = `t${++counter}`
    const frame: ClientFrame = { kind: "request", id, request }
    return new Promise((resolve, reject) => {
      waiters.set(id, { resolve, reject })
      socket.send(JSON.stringify(frame))
    })
  }

  const config = await call({ type: "config.get" })
  check("config.get returns defaults", config.config.model.model === "claude-opus-5", config.config.model)

  const created = await call({ type: "session.create", directory: project })
  const sessionID: string = created.session.id
  check("session.create returns a session", typeof sessionID === "string" && sessionID.startsWith("ses_"), sessionID)
  check("session.create broadcast an event", events.some((event) => event.type === "session.updated"))

  const listed = await call({ type: "session.list" })
  check("session.list includes it", listed.sessions.some((s: any) => s.id === sessionID))
  /*
   * A client that reconnects has missed whatever happened while it was away,
   * and a turn that ended in the gap would leave its session looking busy for
   * good. The list says which sessions are actually mid-turn.
   */
  check("session.list says what is mid-turn", Array.isArray(listed.running), listed.running)
  check("and nothing is, on a fresh backend", listed.running.length === 0, listed.running)

  await call({ type: "session.rename", sessionID, title: "Smoke test" })
  const renamed = await call({ type: "session.get", sessionID })
  check("session.rename persists", renamed.session.title === "Smoke test", renamed.session.title)

  const files = await call({ type: "file.list", directory: project, query: "app" })
  check("file.list filters by query", files.files.some((f: any) => f.path === "src/app.ts"), files.files)

  let rejected = false
  await call({ type: "session.get", sessionID: "ses_missing" }).catch(() => (rejected = true))
  check("unknown session rejects", rejected)

  // ------------------------------------------------------------------- tools
  section("Tools")
  const bus = new Bus()
  const permissions = new Permissions(bus, backend.runtime.config)
  const controller = new AbortController()

  const context = (callID: string) => ({
    sessionID,
    messageID: "msg_test",
    callID,
    directory: project,
    permissions,
    signal: controller.signal,
    progress: () => {},
    // The suite exercises tools directly; recording is the runner's job.
    snapshot: async () => {},
  })

  /*
   * A regex the model wrote, that will not finish.
   *
   * Nested quantifiers backtrack exponentially, and no timer can interrupt a
   * match in progress - the event loop is the thing it is holding. Searching in
   * a worker is what makes the deadline enforceable, and the backend shares its
   * thread with the window, so the alternative is a frozen app.
   */
  await fs.writeFile(path.join(project, "bait.txt"), "a".repeat(60) + "!\n")
  const started = Date.now()
  const runaway = await runSearch(
    { kind: "grep", root: project, directory: project, pattern: "(a+)+$", ignoreCase: false },
    new AbortController().signal,
    600,
  ).then(() => undefined, (error: unknown) => error)
  const elapsed = Date.now() - started
  check("a catastrophic regex is stopped, not waited on", runaway instanceof ToolError, runaway)
  check("and it is stopped at the deadline", elapsed < 5000, `${elapsed}ms`)
  await fs.rm(path.join(project, "bait.txt"))

  const read = await findTool("read")!.execute({ path: "hello.ts" }, context("c1"))
  check("read numbers lines", read.output.includes("1\texport const greeting"), read.output.slice(0, 60))

  /*
   * Leaving the project asks rather than refusing. Wanting to read the folder
   * next door is ordinary; the sandbox is there so the user decides, not so the
   * answer is always no.
   */
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-outside-"))
  await fs.mkdir(path.join(outsideRoot, "nested"))
  await fs.writeFile(path.join(outsideRoot, "nested", "note.txt"), "hello")

  const answer = (response: "once" | "always" | "reject") => {
    const timer = setInterval(() => {
      const [first] = permissions.outstanding()
      if (first) {
        clearInterval(timer)
        permissions.respond(first.id, response)
      }
    }, 10)
    return () => clearInterval(timer)
  }

  let stop = answer("reject")
  const denied = await findTool("list")!
    .execute({ path: outsideRoot }, context("c-esc1"))
    .then(() => undefined, (error: unknown) => error)
  stop()
  check("an outside path asks, and a refusal is honoured", denied instanceof PermissionDenied, denied)

  stop = answer("always")
  const granted = await findTool("list")!
    .execute({ path: outsideRoot }, context("c-esc2"))
    .then((result) => result, (error: unknown) => error)
  stop()
  check("approving lets the tool through", typeof (granted as { output?: string })?.output === "string", granted)

  // "always" covers the tree, so walking into it does not ask a second time.
  const nested = await findTool("read")!
    .execute({ path: path.join(outsideRoot, "nested", "note.txt") }, context("c-esc3"))
    .then((result) => result, (error: unknown) => error)
  check("an approved directory covers what is under it", !(nested instanceof Error), nested)
  check("no second prompt was raised", permissions.outstanding().length === 0)

  /*
   * A prompt nobody is left to answer.
   *
   * Closing the window mid-prompt left the tool parked on a promise that only
   * the UI could settle: the session stayed busy for the life of the process
   * and refused every later message. The turn's abort signal now settles it.
   */
  const stopping = new AbortController()
  const stranded = permissions
    .ask({
      sessionID,
      messageID: "msg_test",
      callID: "c-abort",
      kind: "bash",
      title: "Run command",
      subject: "sleep 1",
      signal: stopping.signal,
    })
    .then(() => undefined, (error: unknown) => error)
  await new Promise((resolve) => setTimeout(resolve, 20))
  check("the prompt is parked before the abort", permissions.outstanding().length === 1)
  stopping.abort()
  check("aborting a turn settles its parked prompt", (await stranded) instanceof PermissionDenied, await stranded)
  check("and leaves nothing outstanding", permissions.outstanding().length === 0)

  /*
   * Two tools in one turn can be waiting at once - the runner starts them
   * together, and two edits in a turn is the ordinary case. The interface used
   * to hold a single request, so the second prompt replaced the first and the
   * tool behind it waited for an answer nobody could give any more.
   */
  const bothAsked = [
    permissions.ask({ sessionID, messageID: "msg_test", callID: "c-q1", kind: "edit", title: "Edit file", subject: "one.ts" }),
    permissions.ask({ sessionID, messageID: "msg_test", callID: "c-q2", kind: "edit", title: "Edit file", subject: "two.ts" }),
  ].map((promise) => promise.then(() => "allowed", () => "denied"))
  await new Promise((resolve) => setTimeout(resolve, 20))
  const queued = permissions.outstanding()
  check("two prompts can be outstanding at the same time", queued.length === 2, queued.map((entry) => entry.subject))
  for (const entry of queued) permissions.respond(entry.id, "once")
  check("and each is answered on its own", (await Promise.all(bothAsked)).join(",") === "allowed,allowed")

  // Asking under a signal that has already fired must not raise a prompt at all.
  const already = await permissions
    .ask({
      sessionID,
      messageID: "msg_test",
      callID: "c-abort2",
      kind: "bash",
      title: "Run command",
      subject: "sleep 1",
      signal: AbortSignal.abort(),
    })
    .then(() => undefined, (error: unknown) => error)
  check("an already-aborted turn never asks", already instanceof PermissionDenied && permissions.outstanding().length === 0)

  /*
   * The switch labelled "permission requests will be approved automatically".
   * It offered nine kinds; five belonged to tools that never ask, and the one
   * that guards reaching outside the project was not among them - so with the
   * switch on, that prompt still stopped the agent.
   */
  check("every kind offered can actually be asked for", PERMISSION_KINDS.includes("outside" as any), PERMISSION_KINDS)

  await backend.runtime.config.set({ autoApprove: [...PERMISSION_KINDS] })
  // A directory nothing has approved: `outsideRoot` carries the "always" from
  // above, and would answer for itself whatever the setting said.
  const unseen = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-outside1-"))
  const running = findTool("list")!
    .execute({ path: unseen }, context("c-esc4"))
    .then((result) => result, (error: unknown) => error)
  /*
   * If a prompt goes up, this answers it so the tool settles and the run moves
   * on; waiting behind an unanswered prompt would hang the suite instead of
   * reporting the fault.
   */
  let asked = false
  const watch = setInterval(() => {
    const [first] = permissions.outstanding()
    if (!first) return
    asked = true
    permissions.respond(first.id, "reject")
  }, 10)
  const unattended = await running
  clearInterval(watch)
  check("with everything approved, an outside path does not ask", !asked && !(unattended instanceof Error), {
    asked,
    unattended,
  })
  await fs.rm(unseen, { recursive: true, force: true })

  /*
   * Approvals are stored by name, and the set of names has changed once. A name
   * left behind by an older build must not survive to pre-approve a future kind
   * that reuses it.
   *
   * The two throwaway names have to be ones that really are not buckets. This
   * case used to spend `read` and `glob` on that job, from a time when they were
   * declared on tools but matched nothing; they are real, configurable buckets
   * now, so the case was asserting that two live settings get thrown away.
   */
  await backend.runtime.config.set({ autoApprove: ["lsp", "websearch", "bash"] as never })
  check(
    "an approval that names nothing is dropped",
    !(backend.runtime.config.get().autoApprove as string[]).some(
      (kind) => kind === "lsp" || kind === "websearch",
    ) && backend.runtime.config.get().autoApprove.includes("bash"),
    backend.runtime.config.get().autoApprove,
  )

  /*
   * Off again - against a directory nothing has approved yet, since the
   * "always" above is remembered for `outsideRoot` and would answer for it.
   */
  await backend.runtime.config.set({ autoApprove: [] })
  const untouched = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-outside2-"))
  const asksAgain = answer("reject")
  const blocked = await findTool("list")!
    .execute({ path: untouched }, context("c-esc5"))
    .then(() => undefined, (error: unknown) => error)
  asksAgain()
  check("turning it off restores the prompt", blocked instanceof PermissionDenied, blocked)
  await fs.rm(untouched, { recursive: true, force: true })

  await fs.rm(outsideRoot, { recursive: true, force: true })

  const glob = await findTool("glob")!.execute({ pattern: "**/*.ts" }, context("c2"))
  check("glob finds nested files", glob.output.includes("src/app.ts") && glob.output.includes("hello.ts"), glob.output)

  const grep = await findTool("grep")!.execute({ pattern: "TODO" }, context("c3"))
  check("grep reports file:line", grep.output.includes("src/app.ts:1"), grep.output)

  const list = await findTool("list")!.execute({}, context("c4"))
  check("list renders a tree", list.output.includes("src/") && list.output.includes("hello.ts"), list.output)

  const todo = await findTool("todowrite")!.execute(
    { todos: [{ id: "1", content: "Write the thing", status: "in_progress" }] },
    context("c5"),
  )
  check("todowrite summarizes progress", todo.output === "0/1 complete.", todo.output)

  /*
   * Traversal must never proceed silently, however it is spelled. It is no
   * longer a flat refusal - it raises the same prompt as any other path outside
   * the project - but nothing reaches disk until the user has said yes.
   */
  const traversal = findTool("read")!
    .execute({ path: "../../../etc/passwd" }, context("c6"))
    .then(() => "read it", (error: unknown) => (error instanceof PermissionDenied ? "denied" : String(error)))
  await new Promise((resolve) => setTimeout(resolve, 60))
  const traversalPrompt = permissions.outstanding()
  check("traversal raises a prompt rather than sneaking through", traversalPrompt.length === 1, traversalPrompt.length)
  check("the prompt names the directory being reached into", traversalPrompt[0]?.subject.endsWith("*") ?? false, traversalPrompt[0]?.subject)
  permissions.respond(traversalPrompt[0]!.id, "reject")
  check("refusing traversal stops the read", (await traversal) === "denied")

  let refused = false
  await findTool("bash")!
    .execute({ command: "rm -rf /", description: "destroy" }, context("c7"))
    .catch((err: Error) => (refused = err.message.includes("Refused")))
  check("bash refuses recursive force delete", refused)

  // -------------------------------------------------------------- permission
  section("Permissions")
  // edit is not auto-approved, so this must park until answered.
  const editPromise = findTool("edit")!.execute(
    { path: "hello.ts", oldString: "const count = 1", newString: "const count = 2" },
    context("c8"),
  )
  await new Promise((resolve) => setTimeout(resolve, 60))
  const outstanding = permissions.outstanding()
  check("edit raised a permission request", outstanding.length === 1, outstanding.length)
  check("request carries a diff preview", outstanding[0]?.preview?.includes("+export const count = 2") ?? false)

  permissions.respond(outstanding[0].id, "once")
  const edited = await editPromise
  check("edit applied after approval", edited.output.includes("Edited hello.ts"), edited.output)
  const afterEdit = await fs.readFile(path.join(project, "hello.ts"), "utf8")
  check("file actually changed on disk", afterEdit.includes("count = 2"), afterEdit)

  const denyPromise = findTool("write")!
    .execute({ path: "denied.ts", content: "nope" }, context("c9"))
    .then(() => "allowed")
    .catch((err: Error) => err.message)
  await new Promise((resolve) => setTimeout(resolve, 60))
  const second = permissions.outstanding()
  permissions.respond(second[0].id, "reject")
  const denyResult = await denyPromise
  check("rejection stops the tool", String(denyResult).includes("Permission denied"), denyResult)
  check("rejected write created no file", !(await exists(path.join(project, "denied.ts"))))

  // "always" should suppress the next prompt in the same bucket.
  const firstWrite = findTool("write")!.execute({ path: "a.txt", content: "one" }, context("c10"))
  await new Promise((resolve) => setTimeout(resolve, 60))
  const third = permissions.outstanding()
  permissions.respond(third[0].id, "always")
  await firstWrite
  await findTool("write")!.execute({ path: "b.txt", content: "two" }, context("c11"))
  check("always suppresses the next prompt", permissions.outstanding().length === 0)
  check("both writes landed", (await exists(path.join(project, "a.txt"))) && (await exists(path.join(project, "b.txt"))))

  // ------------------------------------------------------------------- units
  section("Units")
  const diff = unifiedDiff("f.ts", "a\nb\nc\n", "a\nB\nc\n")
  check("diff marks the changed line", diff.includes("-b") && diff.includes("+B"), diff)
  check("diff keeps context", diff.includes(" a") && diff.includes(" c"))
  check("identical input yields no diff", unifiedDiff("f.ts", "same", "same") === "")

  check("glob ** spans directories", globToRegExp("**/*.ts").test("src/deep/x.ts"))
  check("glob **/ matches at root", globToRegExp("**/*.ts").test("x.ts"))
  check("glob * stops at separator", !globToRegExp("*.ts").test("src/x.ts"))
  check("glob alternation works", globToRegExp("src/{a,b}.ts").test("src/b.ts"))

  check("every tool has a schema", TOOLS.every((tool) => tool.parameters && tool.description.length > 20))
  check("tool names are unique", new Set(TOOLS.map((t) => t.name)).size === TOOLS.length)

  // ---------------------------------------------------- provider conversion
  section("Provider conversion")
  // The API rejects a tool_use that is not answered by a tool_result with the
  // same id in the very next turn, so this mapping is where history bugs hide.
  const converted = toProviderMessages([
    {
      id: "msg_1",
      sessionID,
      role: "user",
      text: "fix it",
      attachments: [],
      time: { created: 1 },
    },
    {
      id: "msg_2",
      sessionID,
      role: "assistant",
      model: { provider: "anthropic", model: "claude-opus-5" },
      agent: "build",
      parts: [
        { type: "reasoning", id: "p0", text: "pondering", time: { created: 1 } },
        { type: "text", id: "p1", text: "Reading the file." },
        {
          type: "tool",
          id: "p2",
          callID: "toolu_ok",
          name: "read",
          status: "completed",
          input: { path: "a.ts" },
          output: "contents",
          time: { created: 1 },
        },
        {
          type: "tool",
          id: "p3",
          callID: "toolu_bad",
          name: "edit",
          status: "error",
          input: { path: "a.ts" },
          error: "no match",
          time: { created: 1 },
        },
        {
          type: "tool",
          id: "p4",
          callID: "toolu_never",
          name: "bash",
          status: "running",
          input: {},
          time: { created: 1 },
        },
      ],
      time: { created: 1 },
    },
  ])

  const assistantTurn = converted.find((m) => m.role === "assistant")
  const resultTurn = converted.filter((m) => m.role === "user").at(-1)
  const blocks = assistantTurn?.content as any[]
  const results = resultTurn?.content as any[]

  const useIDs = blocks.filter((b) => b.type === "tool_use").map((b) => b.id)
  const resultIDs = results.map((b) => b.tool_use_id)
  check("every tool_use has a matching tool_result", JSON.stringify(useIDs) === JSON.stringify(resultIDs), {
    useIDs,
    resultIDs,
  })
  check("unfinished tool is dropped entirely", !useIDs.includes("toolu_never"), useIDs)
  check("failed tool is marked is_error", results.find((b) => b.tool_use_id === "toolu_bad")?.is_error === true)
  check("failed tool sends its error as content", results.find((b) => b.tool_use_id === "toolu_bad")?.content === "no match")
  check("reasoning is not replayed", !blocks.some((b) => b.type === "thinking"), blocks.map((b) => b.type))
  check("assistant text survives", blocks.some((b) => b.type === "text" && b.text === "Reading the file."))
  check("turn order is user, assistant, tool results", converted.map((m) => m.role).join(",") === "user,assistant,user")

  // usageFrom now takes the pricing entry directly: discovered providers have
  // no published rates, so the caller decides whether a rate exists at all.
  const cost = usageFrom(
    { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } as any,
    { input: 5, output: 25 },
  )
  check("cost applies the supplied rate", Math.abs(cost.cost - 30) < 0.001, cost.cost)

  const unpriced = usageFrom(
    { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } as any,
    undefined,
  )
  check("unpriced models report no cost", unpriced.cost === 0, unpriced.cost)

  // ----------------------------------------------------------- durability
  section("Storage")
  {
    /*
     * A streaming reply saves itself every 500ms while the turn runs, so writes
     * to one key overlap. Sharing a temp file made the second rename fail with
     * ENOENT, which surfaced as a red box in the transcript.
     */
    const store = backend.runtime.storage
    const key = "probe/concurrent"
    /*
     * Deliberately uneven: the first write carries a megabyte and the last
     * carries almost nothing. Without ordering the big early write finishes
     * last and overwrites the newer value, which equal-sized payloads hide by
     * completing in the order they started.
     */
    const writes = Array.from({ length: 40 }, (_, index) =>
      store.write(key, { index, filler: "x".repeat((40 - index) * 40_000) }),
    )
    const settled = await Promise.allSettled(writes)
    const failures = settled.filter((entry) => entry.status === "rejected")
    check("concurrent writes to one key all succeed", failures.length === 0, (failures[0] as PromiseRejectedResult)?.reason?.message)

    const finalValue = await store.read<{ index: number }>(key)
    check("the last write is the one kept", finalValue?.index === 39, finalValue?.index)

    // Nothing half-written left lying about.
    const dir = await fs.readdir(path.join(dataDirectory, "probe")).catch(() => [] as string[])
    check("no temp files are left behind", !dir.some((name) => name.endsWith(".tmp")), dir)

    await store.remove(key)

    /*
     * The credential file holds every key and token in the app, so a truncated
     * one costs more than any other file here.
     *
     * These checks guard the write path - valid JSON, no residue - and not the
     * property that motivated it. Crash-safety cannot be shown without crashing
     * mid-write, and this file is small enough that a direct write passes here
     * too; the temp-then-rename is what makes the window not exist.
     */
    const config = backend.runtime.config
    await Promise.all(
      Array.from({ length: 12 }, (_, index) => config.setApiKey("probe-provider", `key-${index}`)),
    )
    const credentialFile = path.join(dataDirectory, "credentials.json")
    const raw = await fs.readFile(credentialFile, "utf8")
    const parsed = JSON.parse(raw) as { keys: Record<string, string> }
    check("concurrent credential writes leave valid JSON", typeof parsed.keys === "object", raw.slice(0, 40))
    check("the credential survives", Boolean(parsed.keys["probe-provider"]), parsed.keys["probe-provider"])

    const beside = await fs.readdir(dataDirectory)
    check("no credential temp files are left", !beside.some((name) => name.startsWith("credentials.json.")), beside)

    await config.setApiKey("probe-provider", "")

    /*
     * A damaged message file is reachable - an interrupted write leaves one -
     * and it used to make the whole session refuse to open.
     */
    const damaged = await backend.runtime.sessions.create({
      directory: project,
      model: { provider: "anthropic", model: "claude-opus-5" },
    })
    await backend.runtime.sessions.saveMessage({
      id: "msg_good",
      sessionID: damaged.id,
      role: "user",
      text: "readable",
      attachments: [],
      time: { created: Date.now() },
    })
    const messageDir = path.join(dataDirectory, "session", damaged.id, "message")
    await fs.mkdir(messageDir, { recursive: true })
    await fs.writeFile(path.join(messageDir, "msg_broken.json"), "{ this is not json", "utf8")
    const loaded = await backend.runtime.sessions.messages(damaged.id)
    check("a damaged message is skipped, not fatal", loaded.length === 1, loaded.length)
    check("and the readable one survives", loaded[0]?.id === "msg_good", loaded[0]?.id)
  }

  section("Model curation")
  {
    const models = [{ id: "alpha" }, { id: "beta" }]
    const fake = createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ data: models }))
    })
    await new Promise<void>((resolve) => fake.listen(8794, "127.0.0.1", resolve))

    const config = backend.runtime.config
    await config.set({
      // Curated before this provider existed, which is the whole problem.
      enabledModels: ["anthropic/claude-opus-5"],
      providerEndpoints: { lmstudio: "http://127.0.0.1:8794/v1" },
    })

    await call({ type: "provider.auth", provider: "lmstudio", apiKey: "local" })
    const afterConnect = config.get().enabledModels ?? []
    check(
      "connecting adds the provider's models to a curated list",
      afterConnect.includes("lmstudio/alpha") && afterConnect.includes("lmstudio/beta"),
      afterConnect,
    )
    check("and leaves the existing curation alone", afterConnect.includes("anthropic/claude-opus-5"), afterConnect)

    // Switching one off has to stick: only a provider with nothing enabled is
    // treated as a state nobody chose.
    await config.set({ enabledModels: afterConnect.filter((key) => key !== "lmstudio/beta") })
    await call({ type: "provider.discover", provider: "lmstudio" })
    const afterRefresh = config.get().enabledModels ?? []
    check("refreshing respects a model that was switched off", !afterRefresh.includes("lmstudio/beta"), afterRefresh)

    // With none of its models enabled, refreshing repairs it.
    await config.set({ enabledModels: ["anthropic/claude-opus-5"] })
    await call({ type: "provider.discover", provider: "lmstudio" })
    const repaired = config.get().enabledModels ?? []
    check(
      "refreshing repairs a provider with nothing enabled",
      repaired.includes("lmstudio/alpha") && repaired.includes("lmstudio/beta"),
      repaired,
    )

    // Left as it was found: the next section asserts on this provider too.
    await call({ type: "provider.auth", provider: "lmstudio", apiKey: "" })
    await config.set({ enabledModels: [], providerEndpoints: {} })
    fake.close()
  }

  section("Model discovery")
  {
    // A provider lists everything it serves; a model picker must offer only
    // what can hold a conversation.
    const served = [
      { id: "qwen/qwen3.8-27b" },
      { id: "text-embedding-nomic-embed-text-v1.5" },
      { id: "mimo-v2.5" },
      { id: "mimo-v2-tts" },
      { id: "bge-reranker-v2-m3" },
      { id: "whisper-large-v3" },
    ]
    const fake = createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ data: served }))
    })
    await new Promise<void>((resolve) => fake.listen(8793, "127.0.0.1", resolve))

    const found = await discoverModels(
      { id: "probe", name: "Probe", kind: "openai-compatible", description: "", baseURL: "http://127.0.0.1:8793/v1" },
      "test",
    )
    const ids = found.map((entry) => entry.id)
    check("chat models are kept", ids.includes("qwen/qwen3.8-27b") && ids.includes("mimo-v2.5"), ids)
    check("embeddings are dropped", !ids.some((id) => id.includes("embed")), ids)
    check("rerankers are dropped", !ids.some((id) => id.includes("rerank")), ids)
    check("speech models are dropped", !ids.some((id) => id.includes("tts") || id.includes("whisper")), ids)
    // Looked up by id: the list comes back sorted, so position proves nothing.
    const qwen = found.find((entry) => entry.id === "qwen/qwen3.8-27b")
    check("discovery still names them", qwen?.name === "qwen/Qwen3.8-27B", qwen?.name)

    fake.close()
  }

  section("Per-model reasoning efforts")
  {
    /*
     * The effort control is per model in the reference, not global, and the
     * three interesting answers are all here: a model that does not reason has
     * no efforts at all, a family that stops short of `xhigh` is not offered
     * it, and a model whose table entry states an empty list gets none even
     * though it reasons. Getting any of these wrong shows a control whose
     * settings the provider will ignore.
     */
    const claude = (id: string) =>
      modelVariants("anthropic", { id, name: id, contextWindow: 0, input: 0, output: 0, reasoning: true })
    check("Claude 5 offers all five levels", claude("claude-opus-5").join() === "low,medium,high,xhigh,max", claude("claude-opus-5"))
    check("Claude 4.7 does too", claude("claude-opus-4-7").join() === "low,medium,high,xhigh,max", claude("claude-opus-4-7"))
    check("Claude 4.6 has no xhigh", claude("claude-opus-4-6").join() === "low,medium,high,max", claude("claude-opus-4-6"))
    check("Claude 4.5 falls back to the budget pair", claude("claude-haiku-4-5").join() === "high,max", claude("claude-haiku-4-5"))

    const notReasoning = modelVariants("openai-compatible", {
      id: "some-chat-model",
      name: "Some Chat Model",
      contextWindow: 0,
      input: 0,
      output: 0,
    })
    check("a model that does not reason has no efforts", notReasoning.length === 0, notReasoning)

    const stated = modelVariants("chatgpt", {
      id: "gpt-5.3-codex-spark",
      name: "Spark",
      contextWindow: 0,
      input: 0,
      output: 0,
      reasoning: true,
      efforts: [],
    })
    check("an explicit empty list wins over the heuristic", stated.length === 0, stated)

    const codex = modelVariants("chatgpt", {
      id: "gpt-5.5",
      name: "GPT-5.5",
      contextWindow: 0,
      input: 0,
      output: 0,
      reasoning: true,
    })
    check("a GPT-5.2+ id reaches xhigh", codex.join() === "none,low,medium,high,xhigh", codex)

    const compatible = modelVariants("openai-compatible", {
      id: "some-reasoner",
      name: "Some Reasoner",
      contextWindow: 0,
      input: 0,
      output: 0,
      reasoning: true,
    })
    check("an openai-compatible reasoner gets the three widely supported levels", compatible.join() === "low,medium,high", compatible)

    const excluded = modelVariants("openai-compatible", {
      id: "deepseek-reasoner",
      name: "DeepSeek Reasoner",
      contextWindow: 0,
      input: 0,
      output: 0,
      reasoning: true,
    })
    check("a family the reference excludes gets none even though it reasons", excluded.length === 0, excluded)

    // And the same answer has to survive the wire, not just the function.
    const wired = backend.runtime.config.providers().find((entry) => entry.id === "anthropic")
    const opus = wired?.models.find((entry) => entry.id === "claude-opus-4-6")
    check("the wire carries the per-model list", opus?.variants.join() === "low,medium,high,max", opus?.variants)
    check("and the capability record beside it", opus?.reasoning === true && opus?.inputs.pdf === true, opus)
    check("and the output limit", opus?.maxOutput === 128_000, opus?.maxOutput)
  }

  section("A custom provider")
  {
    const config = backend.runtime.config
    /*
     * Everything the reference's form collects, end to end: the id is the
     * user's own rather than a slug of the name, the models are the ones typed
     * in because nothing discovers them, the headers reach the definition, and
     * `{env:VAR}` names a variable instead of storing a secret.
     */
    process.env.SMOKE_CUSTOM_KEY = "from-the-environment"
    // Curated before this provider existed, which is what makes the next
    // assertion about its models being offered mean anything.
    await config.set({ enabledModels: ["anthropic/claude-opus-5"] })
    await call({
      type: "provider.addCustom",
      id: "mygateway",
      name: "My Gateway",
      baseURL: "https://gateway.example.com/v1",
      apiKey: "{env:SMOKE_CUSTOM_KEY}",
      headers: { "X-Route": "fast", "  ": "dropped" },
      models: [
        { id: "big", name: "Big Model" },
        { id: "small", name: "Small Model" },
      ],
    })

    const stored = config.get().customProviders.find((entry) => entry.id === "mygateway")
    check("the id is the one that was typed, not a slug of the name", Boolean(stored), config.get().customProviders)
    check("headers are kept", stored?.headers?.["X-Route"] === "fast", stored?.headers)
    check("a blank header pair is dropped", Object.keys(stored?.headers ?? {}).length === 1, stored?.headers)
    check("the models are the ones typed in", stored?.models?.map((m) => m.id).join() === "big,small", stored?.models)
    check("an {env:VAR} key stores the variable, not the key", stored?.environment === "SMOKE_CUSTOM_KEY", stored?.environment)
    check("and no secret is written", config.apiKey("mygateway") === "from-the-environment", "read from the environment")
    check(
      "the interface is told which variable connects it",
      config.environmentKey("mygateway") === "SMOKE_CUSTOM_KEY",
      config.environmentKey("mygateway"),
    )

    const definition = config.definition("mygateway")
    check("the definition carries the headers", definition?.headers?.["X-Route"] === "fast", definition?.headers)
    check("and is marked as hand-entered", definition?.handEntered === true, definition?.handEntered)

    const onWire = config.providers().find((entry) => entry.id === "mygateway")
    check("both models reach the picker", onWire?.models.map((m) => m.name).join() === "Big Model,Small Model", onWire?.models)

    // Discovery would replace the typed-in list with whatever /models returned,
    // or with nothing at all, so it is refused rather than attempted.
    const refused = await call({ type: "provider.discover", provider: "mygateway" }).then(
      () => "",
      (error: Error) => error.message,
    )
    check("refreshing a hand-entered list is refused", refused.includes("nothing to discover"), refused)

    // A second provider cannot take an id that is already in use, custom or not.
    const clash = await call({
      type: "provider.addCustom",
      id: "anthropic",
      name: "Impostor",
      baseURL: "https://example.com/v1",
      apiKey: "",
      models: [{ id: "x", name: "X" }],
    }).then(
      () => "",
      (error: Error) => error.message,
    )
    check("a built-in's id cannot be taken", clash.includes("already exists"), clash)

    const malformed = await call({
      type: "provider.addCustom",
      id: "Not Valid",
      name: "Bad",
      baseURL: "https://example.com/v1",
      apiKey: "",
      models: [{ id: "x", name: "X" }],
    }).then(
      () => "",
      (error: Error) => error.message,
    )
    check("a malformed id is refused", malformed.includes("not a valid provider id"), malformed)

    const curated = config.get().enabledModels ?? []
    check(
      "its models join a curated picker rather than being hidden by it",
      curated.includes("mygateway/big") && curated.includes("mygateway/small"),
      curated,
    )
    check("and the existing curation is left alone", curated.includes("anthropic/claude-opus-5"), curated)

    await call({ type: "provider.removeCustom", provider: "mygateway" })
    await config.set({ enabledModels: [] })
    delete process.env.SMOKE_CUSTOM_KEY
  }

  section("Provider headers and reasoning effort on the wire")
  {
    let seen: { headers: Record<string, string>; body: any } | undefined
    const fake = createServer((request, response) => {
      let raw = ""
      request.on("data", (chunk) => (raw += chunk))
      request.on("end", () => {
        seen = { headers: request.headers as Record<string, string>, body: JSON.parse(raw) }
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.end("data: [DONE]\n\n")
      })
    })
    await new Promise<void>((resolve) => fake.listen(8791, "127.0.0.1", resolve))

    const base = {
      apiKey: "secret",
      model: { provider: "mygateway", model: "big" },
      system: "",
      history: [],
      tools: [],
      showReasoning: false,
      signal: new AbortController().signal,
      baseURL: "http://127.0.0.1:8791",
    }

    /*
     * The fake answers an empty stream, which the adapter rightly calls a
     * failure - what is under test is the request it sent, so the failure is
     * swallowed here rather than dressed up as a passing turn.
     */
    const send = (extra: Record<string, unknown>) =>
      OpenAICompatible.stream({ ...base, ...extra } as never, () => {}).catch(() => {})

    await send({
      effort: "high",
      headers: { "x-route": "fast", authorization: "Bearer impostor" },
      variants: ["low", "medium", "high"],
    })
    check("a custom provider's header is sent", seen?.headers["x-route"] === "fast", seen?.headers["x-route"])
    check(
      "and cannot displace the bearer token",
      seen?.headers["authorization"] === "Bearer secret",
      seen?.headers["authorization"],
    )
    check("the chosen effort is sent", seen?.body.reasoning_effort === "high", seen?.body.reasoning_effort)

    await send({ effort: "high", variants: [] })
    check(
      "a model with no efforts is sent none",
      seen?.body.reasoning_effort === undefined,
      seen?.body.reasoning_effort,
    )

    await send({ effort: "max", variants: ["low", "medium", "high"] })
    check(
      "and a level the model does not accept is dropped rather than sent",
      seen?.body.reasoning_effort === undefined,
      seen?.body.reasoning_effort,
    )

    /*
     * Not knowing is not the same as knowing there are none. Until every call
     * site says which levels the model takes, an unqualified request has to
     * keep sending the field - withholding it there would leave the control
     * inert, which is the state this change exists to end.
     */
    await send({ effort: "high" })
    check(
      "a caller that says nothing about the model still sends the effort",
      seen?.body.reasoning_effort === "high",
      seen?.body.reasoning_effort,
    )

    const known = backend.runtime.config.variants({ provider: "anthropic", model: "claude-opus-4-6" })
    check("the server can answer which levels a model takes", known?.join() === "low,medium,high,max", known)
    const unknown = backend.runtime.config.variants({ provider: "anthropic", model: "no-such-model" })
    check("and says it does not know rather than saying none", unknown === undefined, unknown)

    fake.close()
  }

  section("Streamed provider errors")
  {
    /*
     * The shape LM Studio actually returns when the prompt outgrows the loaded
     * context: HTTP 200, then an `event: error` frame - the engine's JSON
     * wrapped inside the gateway's own message string. Every field below was
     * copied from a real response.
     */
    const FAILURE =
      "Engine protocol predict request returned 400: " +
      JSON.stringify({
        error: {
          code: 400,
          message: "request (15553 tokens) exceeds the available context size (8192 tokens), try increasing it",
          type: "exceed_context_size_error",
        },
      })

    let body = ""
    const fake = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end(body)
    })
    await new Promise<void>((resolve) => fake.listen(8794, "127.0.0.1", resolve))

    /** Frames as a server would send them, terminator included. */
    const feed = (...frames: unknown[]) =>
      frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + `data: [DONE]\n\n`

    let announced: TurnEvent[] = []
    const ask = () => (
      (announced = []),
      OpenAICompatible.stream(
        {
          apiKey: "local",
          model: { provider: "lmstudio", model: "qwen/qwen3.8-27b" },
          system: "",
          history: [],
          tools: [],
          effort: "medium",
          showReasoning: true,
          signal: new AbortController().signal,
          baseURL: "http://127.0.0.1:8794/v1",
        },
        (event) => announced.push(event),
      ).then(
        (outcome) => `finished: ${outcome.stop} with ${outcome.toolCalls.length} calls`,
        (failure: Error) => {
          reportedError = failure as ProviderError
          return failure.message
        },
      )
    )
    let reportedError: ProviderError | undefined
    const callIDs = () =>
      announced.filter((event) => event.type === "tool").map((event) => (event as { callID: string }).callID)

    body = `event: error\ndata: ${JSON.stringify({ error: { message: FAILURE }, message: FAILURE })}\n\n`
    const reported = await ask()
    check("an error inside a 200 stream is raised, not skipped", !reported.startsWith("finished:"), reported)
    check(
      "and the innermost message is what surfaces",
      reported.includes("exceeds the available context size (8192 tokens)"),
      reported,
    )
    check(
      "and it is coded so the interface can phrase it",
      reportedError?.code === "error.contextExceeded",
      reportedError?.code,
    )
    check(
      "with the provider's own numbers passed through",
      reportedError?.params?.detail?.includes("8192 tokens"),
      reportedError?.params,
    )

    // Providers are not obliged to make `message` a string, and reaching for
    // string methods on whatever turned up replaced the error with a TypeError.
    body = `data: ${JSON.stringify({ error: { code: 502, message: { detail: "upstream gone" } } })}\n\n`
    const odd = await ask()
    check("an error with no plain message still reports something", !odd.startsWith("finished:"), odd)
    check("and it is not a TypeError from our own parsing", !odd.includes("is not a function"), odd)

    // A stream that says nothing at all is a failure the provider left unnamed.
    body = ""
    const silent = await ask()
    check("an empty stream is not a finished turn", !silent.startsWith("finished:"), silent)

    // Reasoning is not a reply; a stream that stops after it has not answered.
    body = `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking" } }] })}\n\n`
    const mute = await ask()
    check("reasoning alone is not a finished turn", !mute.startsWith("finished:"), mute)

    // The ordinary path must still complete: an empty *reply* with a stated
    // finish_reason is the model's choice, not a fault.
    body = feed({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] })
    const fine = await ask()
    check("a normal stream still finishes", fine === "finished: end_turn with 0 calls", fine)

    /*
     * llama.cpp and some vLLM builds stream a tool call with neither `id` nor
     * `index`. Discarding it looked identical to the model deciding to stop.
     */
    body = feed({
      choices: [
        {
          delta: { tool_calls: [{ function: { name: "list", arguments: '{"path":"."}' } }] },
          finish_reason: "tool_calls",
        },
      ],
    })
    const anonymous = await ask()
    check("a tool call with no id is still a tool call", anonymous === "finished: tool_use with 1 calls", anonymous)

    /*
     * Two calls in one delta, neither carrying `index`. Folding them onto a
     * single slot concatenated the names into a tool that does not exist.
     */
    body = feed({
      choices: [
        {
          delta: {
            tool_calls: [
              { function: { name: "list", arguments: '{"path":"."}' } },
              { function: { name: "read", arguments: '{"path":"a.txt"}' } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    })
    const both = await ask()
    check("two index-less calls stay two calls", both === "finished: tool_use with 2 calls", both)

    /*
     * An id that only turns up in a later delta. Announcing a stand-in id first
     * left the real call unmatched: one card stuck on pending, one duplicate.
     */
    body = feed(
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "list" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_real", function: { arguments: '{"path":"."}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    )
    const late = await ask()
    check("a late id still yields one call", late === "finished: tool_use with 1 calls", late)
    check(
      "and nothing was announced against an id the call does not have",
      callIDs().every((id) => id === "call_real"),
      callIDs(),
    )

    fake.close()
  }

  section("Local providers")
  {
    /*
     * Pointed at a port nothing can be listening on. Testing against LM Studio's
     * real port made the result depend on whether the developer happened to have
     * it running - the suite passed or failed for reasons outside the code.
     */
    await backend.runtime.config.set({
      providerEndpoints: { lmstudio: "http://127.0.0.1:9/v1" },
    })

    // A runtime on this machine either answers or it does not; connecting to
    // one that is down used to succeed and leave the row green and empty.
    const down = await call({ type: "provider.auth", provider: "lmstudio", apiKey: "local" }).then(
      () => "connected",
      (failure: Error) => failure.message,
    )
    check("connecting a runtime that is down is refused", down.includes("did not answer"), down)
    check(
      "and it stays disconnected",
      backend.runtime.config.providers().find((p) => p.id === "lmstudio")?.configured === false,
    )

    /*
     * Disconnecting is not connecting. Applying the reachability check to both
     * meant a runtime that had stopped could never be disconnected - the state
     * it was in was exactly the state that blocked the way out.
     */
    await backend.runtime.config.setApiKey("lmstudio", "local")
    check(
      "a stale connection can exist",
      backend.runtime.config.providers().find((p) => p.id === "lmstudio")?.configured === true,
    )
    const left = await call({ type: "provider.auth", provider: "lmstudio", apiKey: "" }).then(
      () => "ok",
      (failure: Error) => failure.message,
    )
    check("disconnecting a runtime that is down still works", left === "ok", left)
    check(
      "and it really is disconnected",
      backend.runtime.config.providers().find((p) => p.id === "lmstudio")?.configured === false,
    )

    /*
     * A runtime on a port other than the default. The endpoint field only
     * appeared under an already-connected provider, so this was unreachable
     * from the interface: connecting is exactly what fails when the address is
     * wrong. Both connection surfaces now set the endpoint before connecting,
     * which is what this asserts the server honours.
     */
    const elsewhere = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ data: [{ id: "qwen/qwen3.8-27b" }] }))
    })
    await new Promise<void>((resolve) => elsewhere.listen(8795, "127.0.0.1", resolve))

    await call({ type: "config.set", patch: { providerEndpoints: { lmstudio: "http://127.0.0.1:8795/v1" } } })
    check(
      "the endpoint the user typed is the one in force",
      backend.runtime.config.providers().find((p) => p.id === "lmstudio")?.baseURL ===
        "http://127.0.0.1:8795/v1",
      backend.runtime.config.providers().find((p) => p.id === "lmstudio")?.baseURL,
    )

    const moved = await call({ type: "provider.auth", provider: "lmstudio", apiKey: "local" }).then(
      () => "connected",
      (failure: Error) => failure.message,
    )
    check("a runtime on a non-default port connects", moved === "connected", moved)
    const reachable = backend.runtime.config.providers().find((p) => p.id === "lmstudio")
    check("and its models come from there", reachable?.models.some((m) => m.id === "qwen/qwen3.8-27b"), reachable?.models)

    await call({ type: "provider.auth", provider: "lmstudio", apiKey: "" })
    elsewhere.close()
  }

  section("A failed turn")
  {
    /*
     * One failure used to produce two identical notices: the runner wrote it
     * onto the assistant message and then rethrew, and the outer handler
     * broadcast it as a session error as well. This drives a whole turn against
     * a runtime that fails mid-stream and counts what the user would see.
     */
    const FAILURE = JSON.stringify({
      error: {
        message: "request (22530 tokens) exceeds the available context size (8192 tokens), try increasing it",
      },
    })
    const flaky = createServer((request, response) => {
      if ((request.url ?? "").includes("/models")) {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ data: [{ id: "qwen/qwen3.8-27b" }] }))
        return
      }
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end(`event: error\n\ndata: ${FAILURE}\n\n`)
    })
    await new Promise<void>((resolve) => flaky.listen(8796, "127.0.0.1", resolve))

    await call({ type: "config.set", patch: { providerEndpoints: { lmstudio: "http://127.0.0.1:8796/v1" } } })
    await call({ type: "provider.auth", provider: "lmstudio", apiKey: "local" })

    const failing = await call({ type: "session.create", directory: project })
    const failingID: string = failing.session.id
    await call({
      type: "session.model",
      sessionID: failingID,
      model: { provider: "lmstudio", model: "qwen/qwen3.8-27b" },
    })

    const before = events.length
    await call({ type: "session.prompt", sessionID: failingID, text: "hello" })
    // The turn runs detached; idle marks its end whether it worked or not.
    const finished = await new Promise<boolean>((resolve) => {
      const started = Date.now()
      const poll = setInterval(() => {
        const done = events
          .slice(before)
          .some((event) => event.type === "session.idle" && event.sessionID === failingID)
        // Generous, because this runs beside a build on a busy machine; the
        // point of the bound is to fail rather than hang.
        if (done || Date.now() - started > 60_000) {
          clearInterval(poll)
          resolve(done)
        }
      }, 50)
    })
    check("the turn finished before anything was asked about it", finished)

    const raised = events
      .slice(before)
      .filter((event) => event.type === "session.error" && event.sessionID === failingID)
    check("a failure the message carries is not broadcast as well", raised.length === 0, raised)

    const after = await call({ type: "session.get", sessionID: failingID })
    const failed = after.messages.filter((message: any) => message.role === "assistant")
    check("the turn is marked failed", failed.at(-1)?.finish === "error", failed.at(-1)?.finish)
    check(
      "and carries the key the interface phrases it with",
      failed.at(-1)?.errorCode === "error.contextExceeded",
      failed.at(-1)?.errorCode,
    )

    await call({ type: "provider.auth", provider: "lmstudio", apiKey: "" })
    await call({ type: "config.set", patch: { providerEndpoints: {} } })
    flaky.close()
  }

  section("Plan mode")
  {
    /*
     * The agent reached the prompt builder and the turn request and was read by
     * neither, so choosing Plan changed a label and nothing else - a plan could
     * rewrite the project it was describing.
     */
    const planning = toolsFor("plan").map((tool) => tool.name)
    const building = toolsFor("build").map((tool) => tool.name)
    check("build keeps every tool", building.length === TOOLS.length, building)
    check("plan cannot write", !planning.includes("write") && !planning.includes("edit"), planning)
    check("plan has no shell either", !planning.includes("bash"), planning)
    check("plan can still read and search", ["read", "glob", "grep", "list"].every((name) => planning.includes(name)), planning)

    /*
     * The choice has to reach the session, since that is where the turn takes
     * it from. It used to be written to the config alone, and every session was
     * created as "build" whatever the config said - so Plan could never run.
     */
    const planned = await call({ type: "session.create", directory: project })
    const planID: string = planned.session.id
    check("a new session starts in the stored default", planned.session.agent === "build", planned.session.agent)

    const switched = await call({ type: "session.agent", sessionID: planID, agent: "plan" })
    check("choosing an agent lands on the session", switched.session.agent === "plan", switched.session.agent)
    const reread = await call({ type: "session.get", sessionID: planID })
    check("and survives a reload", reread.session.agent === "plan", reread.session.agent)

    await call({ type: "config.set", patch: { agent: "plan" } })
    const inherited = await call({ type: "session.create", directory: project })
    check("the next session starts where the last left off", inherited.session.agent === "plan", inherited.session.agent)
    await call({ type: "config.set", patch: { agent: "build" } })
    await call({ type: "session.delete", sessionID: planID })
    await call({ type: "session.delete", sessionID: inherited.session.id })

    const planPrompt = await systemPrompt({ directory: project, agent: "plan" })
    const buildPrompt = await systemPrompt({ directory: project, agent: "build" })
    check("plan is told what mode it is in", planPrompt.includes("plan mode"), planPrompt.slice(0, 80))
    check("build is not", !buildPrompt.includes("plan mode"))
  }

  section("Attachments")
  {
    /*
     * An image dragged out of the app's own transcript arrives as a data: URL,
     * and the page's connect-src forbids fetching one - so it is read here
     * instead of being fetched.
     */
    const dot = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    )
    const embedded = fromDataURL(`data:image/png;base64,${dot.toString("base64")}`)
    check("a data URL yields its type", embedded?.mime === "image/png", embedded?.mime)
    check("and its exact bytes", Buffer.from(embedded!.bytes).equals(dot))
    check(
      "an unencoded data URL decodes too",
      Buffer.from(fromDataURL("data:text/plain,hello%20there")!.bytes).toString() === "hello there",
    )
    check("a mangled payload is refused, not thrown", fromDataURL("data:image/png;base64,!!!!") === undefined)
    check("something that is not a data URL is refused", fromDataURL("https://example.com/a.png") === undefined)

    // The flavours a chat window or a browser actually offers on a drag.
    const transfer = (entries: Record<string, string>) =>
      ({ getData: (type: string) => entries[type] ?? "" }) as unknown as DataTransfer
    check(
      "a uri-list drop yields its first url",
      linkFrom(transfer({ "text/uri-list": "# comment\nhttps://example.com/cat.png" })) ===
        "https://example.com/cat.png",
    )
    check(
      "an html drop yields the image source",
      linkFrom(transfer({ "text/html": '<meta><img src="data:image/png;base64,AAA" alt="x">' })) ===
        "data:image/png;base64,AAA",
    )
    check("plain prose is not a link", linkFrom(transfer({ "text/plain": "just some words" })) === undefined)
    check("a name keeps a usable extension", nameFor("pasted", "text/plain") === "pasted.txt", nameFor("pasted", "text/plain"))

    /*
     * Both of these adapters filtered images out and sent only the text files,
     * so a picture reached the transcript and stopped there - the model was
     * asked about something it had never been shown.
     */
    const withImage: any = {
      id: "msg_att",
      sessionID: "ses_att",
      role: "user",
      text: "what is in this",
      attachments: [
        { path: "shot.png", mime: "image/png", data: "AAAB" },
        { path: "notes.txt", mime: "text/plain", data: "hello from a file" },
      ],
      time: { created: 1 },
    }

    const openai = toMessages("sys", [withImage]) as any[]
    const user = openai.find((entry) => entry.role === "user")
    check("the image is sent, not dropped", Array.isArray(user?.content), user?.content)
    const parts = (user?.content ?? []) as any[]
    check(
      "as a data url the format understands",
      parts.some((part) => part.type === "image_url" && part.image_url.url.startsWith("data:image/png;base64,")),
      parts,
    )
    check(
      "and the text file still rides along with the words",
      parts.some((part) => part.type === "text" && part.text.includes("notes.txt") && part.text.includes("what is in this")),
      parts,
    )

    // Text alone keeps the plain shape: fewer of these servers accept the
    // multipart form, and nothing is gained by using it.
    const plain = toMessages("sys", [{ ...withImage, attachments: [] }]) as any[]
    check(
      "a message without images stays a plain string",
      typeof plain.find((entry) => entry.role === "user")?.content === "string",
      plain.find((entry) => entry.role === "user")?.content,
    )
  }

  section("Model names")
  {
    // A second load of one model in LM Studio; the suffix must not disturb the
    // casing of the name it is attached to.
    check(
      "an instance suffix keeps the name cased",
      nameFromId("qwen/qwen3.8-27b:2") === "qwen/Qwen3.8-27B:2",
      nameFromId("qwen/qwen3.8-27b:2"),
    )
    check(
      "and the plain id is unaffected",
      nameFromId("qwen/qwen3.8-27b") === "qwen/Qwen3.8-27B",
      nameFromId("qwen/qwen3.8-27b"),
    )
    const cases: [string, string][] = [
      // What the vendor writes, for the ones we can check against a real client.
      ["mimo-v2.5", "MiMo-V2.5"],
      ["mimo-v2.5-pro", "MiMo-V2.5-Pro"],
      ["mimo-v2-tts", "MiMo-V2-TTS"],
      ["mimo-v2.5-tts-voiceclone", "MiMo-V2.5-TTS-VoiceClone"],
      ["gpt-5.6-sol", "GPT-5.6-Sol"],
      ["deepseek-chat", "DeepSeek-Chat"],
      ["glm-4-plus", "GLM-4-Plus"],
      // A parameter count is capitalised; a context size is not.
      ["llama-3.3-70b", "Llama-3.3-70B"],
      ["doubao-pro-32k", "Doubao-Pro-32k"],
      // Someone else's capitalisation is left alone.
      ["MiniMax-M2", "MiniMax-M2"],
      // A publisher prefix is an account name and is echoed, not title-cased;
      // the model half is still cased, and a hub's lowercase v is kept.
      ["qwen/qwen3.8-27b", "qwen/Qwen3.8-27B"],
      ["mistralai/mistral-7b-instruct-v0.3", "mistralai/Mistral-7B-Instruct-v0.3"],
      ["lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF", "lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF"],
      ["google/gemma-3-12b", "google/Gemma-3-12B"],
    ]
    for (const [id, expected] of cases) {
      const actual = nameFromId(id)
      check(`${id} reads as ${expected}`, actual === expected, actual)
    }

    // The catalog's own name wins over anything derived from the id.
    const curated = backend.runtime.config.models("xiaomi").find((entry) => entry.id === "mimo-v2.5")
    check("a curated name survives discovery", curated?.name === "MiMo-V2.5", curated?.name)
  }

  section("Undo")
  {
    const store = backend.runtime.sessions
    const undoSession = await store.create({
      directory: project,
      model: { provider: "anthropic", model: "claude-opus-5" },
    })

    const existing = path.join(project, "hello.ts")
    const created = path.join(project, "brand-new.ts")
    const before = await fs.readFile(existing, "utf8")

    // What the runner records as a turn edits files: the state it found them in.
    await store.pushSnapshot(undoSession.id, {
      at: Date.now(),
      files: [
        { path: existing, content: before },
        // null is how "did not exist" is recorded.
        { path: created, content: null },
      ],
    })

    await fs.writeFile(existing, "changed by the turn", "utf8")
    await fs.writeFile(created, "made by the turn", "utf8")

    const undone = await backend.runtime.runner.undo(undoSession.id)
    check("undo reports the files it touched", undone === 2, undone)
    check("undo restores an edited file", (await fs.readFile(existing, "utf8")) === before)
    check("undo deletes a file the turn created", !(await exists(created)))

    const afterUndo = await store.historyDepth(undoSession.id)
    check("undo moves the step onto the redo stack", afterUndo.undo === 0 && afterUndo.redo === 1, afterUndo)

    const redone = await backend.runtime.runner.redo(undoSession.id)
    check("redo reports the same files", redone === 2, redone)
    check("redo puts the edit back", (await fs.readFile(existing, "utf8")) === "changed by the turn")
    check("redo puts the new file back", await exists(created))

    const afterRedo = await store.historyDepth(undoSession.id)
    check("redo returns the step to the undo stack", afterRedo.undo === 1 && afterRedo.redo === 0, afterRedo)

    // Whole files are stored per step, so the stack cannot grow forever.
    for (let step = 0; step < 25; step++) {
      await store.pushSnapshot(undoSession.id, { at: Date.now(), files: [{ path: existing, content: `step ${step}` }] })
    }
    const capped = await store.historyDepth(undoSession.id)
    check("the undo stack is bounded", capped.undo === 20, capped)

    // A fresh change has to end the redo line, as it does in any editor.
    await store.pushSnapshot(undoSession.id, { at: Date.now(), files: [{ path: existing, content: "x" }] })
    const afterNew = await store.historyDepth(undoSession.id)
    check("a new change clears the redo stack", afterNew.redo === 0, afterNew)

    await backend.runtime.runner.undo(undoSession.id)
    await fs.writeFile(existing, before, "utf8")
    await fs.rm(created, { force: true })
  }

  section("Persistence")
  socket.close()
  await backend.close()

  const restarted = await startBackend(dataDirectory)
  const survivors = await restarted.runtime.sessions.list()
  check("sessions survive a restart", survivors.some((session) => session.id === sessionID), survivors.length)
  check("title survived", survivors.find((s) => s.id === sessionID)?.title === "Smoke test")

  // Deletion has to be real rather than a hidden row: a session reappearing
  // after a restart is the failure people actually notice.
  let deletedEvent: string | undefined
  const unsubscribe = restarted.runtime.bus.subscribe((event) => {
    if (event.type === "session.deleted") deletedEvent = event.sessionID
  })
  const doomed = await restarted.runtime.sessions.create({
    directory: project,
    model: { provider: "anthropic", model: "claude-opus-5" },
  })
  await restarted.runtime.sessions.delete(doomed.id)
  const afterDelete = await restarted.runtime.sessions.list()
  check(
    "a deleted session is gone from the list",
    !afterDelete.some((session) => session.id === doomed.id),
    afterDelete.length,
  )
  check("deleting broadcasts session.deleted", deletedEvent === doomed.id, deletedEvent)

  // Archiving is not deletion: the session has to survive a restart intact.
  const kept = await restarted.runtime.sessions.create({
    directory: project,
    model: { provider: "anthropic", model: "claude-opus-5" },
  })
  await restarted.runtime.sessions.update(kept.id, { archived: true })
  const archivedNow = await restarted.runtime.sessions.get(kept.id)
  check("archiving marks the session", archivedNow?.archived === true, archivedNow?.archived)
  check(
    "an archived session is still listed for settings to show",
    (await restarted.runtime.sessions.list()).some((entry) => entry.id === kept.id),
  )
  await restarted.runtime.sessions.update(kept.id, { archived: false })
  check("unarchiving puts it back", (await restarted.runtime.sessions.get(kept.id))?.archived === false)
  unsubscribe?.()
  await restarted.close()

  const reopened = await startBackend(dataDirectory)
  const afterRestart = await reopened.runtime.sessions.list()
  check(
    "a deleted session stays deleted across a restart",
    !afterRestart.some((session) => session.id === doomed.id),
  )

  await reopened.close()

  await fs.rm(root, { recursive: true, force: true })

  const hour = 3_600_000
  check(
    "a token with time left is left alone",
    !needsRefresh({ access: "a", expires: Date.now() + hour }),
  )
  check(
    "a token about to expire is renewed",
    needsRefresh({ access: "a", expires: Date.now() + 30_000 }),
  )
  check(
    "an unstated lifetime still ages out",
    needsRefresh({ access: "a", obtained: Date.now() - hour }),
  )
  check(
    "a freshly issued token with no stated lifetime is kept",
    !needsRefresh({ access: "a", obtained: Date.now() }),
  )
  check("a token with no timing at all is refreshed once", needsRefresh({ access: "a" }))

  // ----------------------------------------------------------------- git --
  // Review is only worth anything if it reads the real repository.
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-git-"))
  const before = await gitOps.status(repoRoot)
  check("a plain folder is not reported as a repository", before.installed && !before.repo, before)

  const after = await gitOps.init(repoRoot)
  check("creating a repository takes effect", after.repo, after)

  await fs.writeFile(path.join(repoRoot, "note.txt"), "hello world")
  const dirty = await gitOps.status(repoRoot)
  check("a new file shows as changed", dirty.changed.includes("note.txt"), dirty.changed)

  const patch = await gitOps.diff(repoRoot, "note.txt")
  check("an untracked file still produces a patch", patch.includes("+hello"), patch.slice(0, 80))

  /*
   * The review prints a letter beside every file, so status has to carry one.
   * The two porcelain columns used to be sliced off and thrown away, which is
   * why a listed file could never say whether it was new, edited or gone.
   */
  const runGit = promisify(execFile)
  const inRepo = (args: string[]) => runGit("git", args, { cwd: repoRoot, windowsHide: true })

  check(
    "an untracked file is reported as an addition",
    dirty.entries.find((entry) => entry.path === "note.txt")?.kind === "added",
    dirty.entries,
  )

  await inRepo(["add", "-A"])
  await inRepo(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "one"])

  await fs.writeFile(path.join(repoRoot, "note.txt"), "hello again")
  const touched = await gitOps.status(repoRoot)
  check(
    "an edited file is reported as modified",
    touched.entries.find((entry) => entry.path === "note.txt")?.kind === "modified",
    touched.entries,
  )
  check("the plain path list still agrees with it", touched.changed.includes("note.txt"), touched.changed)

  await fs.rm(path.join(repoRoot, "note.txt"))
  const removed = await gitOps.status(repoRoot)
  check(
    "a removed file is reported as deleted",
    removed.entries.find((entry) => entry.path === "note.txt")?.kind === "deleted",
    removed.entries,
  )
  await inRepo(["checkout", "--", "."])

  /*
   * Branch scope has to see work that is already committed - a review that
   * only ever looks at the working tree tells you a branch is empty the
   * moment its author commits anything.
   */
  await inRepo(["checkout", "-b", "feature"])
  await fs.writeFile(path.join(repoRoot, "feature.txt"), "on the branch")
  await inRepo(["add", "-A"])
  await inRepo(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "two"])

  const worktree = await gitOps.status(repoRoot)
  check("a committed change is not a working-tree change", !worktree.changed.includes("feature.txt"), worktree.changed)

  const branchScope = await gitOps.status(repoRoot, "branch")
  check("branch scope sees it", branchScope.changed.includes("feature.txt"), branchScope.changed)
  check(
    "and calls it an addition",
    branchScope.entries.find((entry) => entry.path === "feature.txt")?.kind === "added",
    branchScope.entries,
  )
  check(
    "a committed file still diffs against the branch point",
    (await gitOps.diff(repoRoot, "feature.txt", 3, "branch")).includes("+on the branch"),
  )
  check(
    "and shows nothing against the working tree",
    (await gitOps.diff(repoRoot, "feature.txt")).trim() === "",
  )

  // Context is what "show all lines" asks for, and it reaches a command line.
  await fs.writeFile(path.join(repoRoot, "wide.txt"), Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"))
  await inRepo(["add", "-A"])
  await inRepo(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "three"])
  await fs.writeFile(
    path.join(repoRoot, "wide.txt"),
    Array.from({ length: 40 }, (_, i) => (i === 20 ? "changed" : `line ${i}`)).join("\n"),
  )
  const tight = await gitOps.diff(repoRoot, "wide.txt")
  const whole = await gitOps.diff(repoRoot, "wide.txt", 100_000)
  check(
    "a wider context really shows more of the file",
    whole.split("\n").length > tight.split("\n").length,
    { tight: tight.split("\n").length, whole: whole.split("\n").length },
  )
  await inRepo(["checkout", "--", "."])
  await inRepo(["checkout", "master"]).catch(() => inRepo(["checkout", "main"]))

  await gitOps.revert(repoRoot, "note.txt")
  check("reverting removes the change", !(await gitOps.status(repoRoot)).changed.includes("note.txt"))

  // Opening a subdirectory of a repository is ordinary, and git answers in
  // paths relative to the root - so the review listed files it could not diff,
  // and "discard" reported success while doing nothing.
  const subProject = path.join(repoRoot, "app")
  await fs.mkdir(subProject)
  await fs.writeFile(path.join(subProject, "main.ts"), "export const a = 1")
  const fromSub = await gitOps.status(subProject)
  check("a subdirectory reports project-relative paths", fromSub.changed.includes("main.ts"), fromSub.changed)
  check(
    "a file in a subdirectory still diffs",
    (await gitOps.diff(subProject, "main.ts")).includes("+export const a = 1"),
  )
  await gitOps.revert(subProject, "main.ts")
  check("reverting from a subdirectory really removes it", !(await exists(path.join(subProject, "main.ts"))))

  await fs.writeFile(path.join(repoRoot, "sibling.txt"), "untouched")
  const escaped = await gitOps
    .revert(subProject, "../sibling.txt")
    .then(() => "allowed", (error: Error) => error.message)
  check("reverting outside the project is refused", escaped.startsWith("Refusing"), escaped)
  check("and the file outside is left alone", await exists(path.join(repoRoot, "sibling.txt")))

  await fs.rm(repoRoot, { recursive: true, force: true })

  // ------------------------------------------------- chatgpt adapter ------
  // The Codex wire format had no coverage at all: no subscription to call, so
  // nothing exercised the SSE parsing, the tool pairing or the usage figures.
  // A stand-in backend covers all of it without one.

  const SSE = [
    { type: "response.reasoning_summary_text.delta", delta: "thinking" },
    { type: "response.output_text.delta", delta: "Hello" },
    { type: "response.output_text.delta", delta: " world" },
    {
      type: "response.output_item.done",
      item: { type: "function_call", call_id: "call_1", name: "read", arguments: '{"path":"a.ts"}' },
    },
    {
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 120,
          output_tokens: 45,
          output_tokens_details: { reasoning_tokens: 30 },
          input_tokens_details: { cached_tokens: 100 },
        },
      },
    },
  ]

  let sentBody: any = {}
  let sentHeaders: Record<string, string> = {}
  const codex = createServer((request, response) => {
    let raw = ""
    request.on("data", (chunk) => (raw += chunk))
    request.on("end", () => {
      sentBody = JSON.parse(raw || "{}")
      sentHeaders = request.headers as Record<string, string>
      response.writeHead(200, { "Content-Type": "text/event-stream" })
      // Split one event across writes so the buffering is exercised too.
      const text = SSE.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
      response.write(text.slice(0, 40))
      response.write(text.slice(40))
      response.end()
    })
  })
  await new Promise<void>((resolve) => codex.listen(0, "127.0.0.1", resolve))
  const codexPort = (codex.address() as { port: number }).port

  const seen: TurnEvent[] = []
  const outcome = await ChatGPTSubscription.stream(
    {
      apiKey: "access-token",
      accountId: "acct_7",
      model: { provider: "chatgpt", model: "gpt-5.6-sol" },
      system: "be useful",
      history: [
        {
          id: "msg_1",
          sessionID: "ses_1",
          role: "user",
          text: "hi",
          attachments: [],
          time: { created: 1 },
        } as any,
      ],
      tools: TOOLS,
      effort: "high",
      showReasoning: true,
      signal: new AbortController().signal,
      baseURL: `http://127.0.0.1:${codexPort}`,
    },
    (event) => seen.push(event),
  )

  check("subscription auth travels as a bearer token", sentHeaders.authorization === "Bearer access-token")
  check("the client identifies itself", String(sentHeaders["user-agent"] ?? "").startsWith("mcode/"), sentHeaders["user-agent"])
  check("the workspace id is sent, without which the backend refuses", sentHeaders["chatgpt-account-id"] === "acct_7")
  check("the request uses the Responses input shape", Array.isArray(sentBody.input) && sentBody.input[0]?.type === "message")
  check("nothing is retained server-side", sentBody.store === false)

  const text = seen.filter((e) => e.type === "text.delta").map((e: any) => e.text).join("")
  check("text deltas are streamed through", text === "Hello world", text)
  check("reasoning is streamed separately", seen.some((e) => e.type === "reasoning.delta"))
  check("a tool call is reported", outcome.toolCalls.length === 1 && outcome.toolCalls[0].name === "read", outcome.toolCalls)
  check("tool arguments are parsed", outcome.toolCalls[0]?.input.path === "a.ts", outcome.toolCalls[0]?.input)
  check("a tool call ends the turn for the loop", outcome.stop === "tool_use", outcome.stop)
  check("reasoning tokens are recorded", outcome.usage.reasoning === 30, outcome.usage.reasoning)
  check("cached input is recorded", outcome.usage.cacheRead === 100, outcome.usage.cacheRead)
  check("a subscription turn costs nothing", outcome.usage.cost === 0)


  // An aborted turn leaves a tool part with no result. Sending its call without
  // a matching output is rejected by the backend, which would poison every
  // later request in that session - so the pair has to be dropped whole.
  const interrupted = [
    {
      id: "msg_1",
      sessionID: "ses_1",
      role: "user",
      text: "go",
      attachments: [],
      time: { created: 1 },
    },
    {
      id: "msg_2",
      sessionID: "ses_1",
      role: "assistant",
      model: { provider: "chatgpt", model: "gpt-5.6-sol" },
      agent: "build",
      time: { created: 2 },
      parts: [
        {
          type: "tool",
          id: "p1",
          callID: "call_done",
          name: "read",
          status: "completed",
          input: {},
          output: "ok",
          time: { created: 2 },
        },
        {
          type: "tool",
          id: "p2",
          callID: "call_stuck",
          name: "bash",
          status: "running",
          input: {},
          time: { created: 2 },
        },
      ],
    },
  ]

  await ChatGPTSubscription.stream(
    {
      apiKey: "k",
      model: { provider: "chatgpt", model: "gpt-5.6-sol" },
      system: "s",
      history: interrupted as any,
      tools: TOOLS,
      effort: "high",
      showReasoning: false,
      signal: new AbortController().signal,
      baseURL: `http://127.0.0.1:${codexPort}`,
    },
    () => {},
  )

  const items = sentBody.input as { type: string; call_id?: string }[]
  const calls = items.filter((item) => item.type === "function_call").map((item) => item.call_id)
  const outputs = items.filter((item) => item.type === "function_call_output").map((item) => item.call_id)
  check("a finished tool is replayed as a pair", calls.includes("call_done") && outputs.includes("call_done"))
  check("an unfinished tool is dropped entirely", !calls.includes("call_stuck") && !outputs.includes("call_stuck"), calls)
  check("every replayed call has its output", calls.every((id) => outputs.includes(id!)), { calls, outputs })

  codex.close()

  // ------------------------------------------- chatgpt failures ------------
  // The same two silences as the OpenAI-compatible path: a refusal whose reason
  // was replaced with a fixed sentence, and a dropped connection reported as a
  // finished turn.
  {
    let failureBody = ""
    const broken = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/event-stream" })
      response.end(failureBody)
    })
    await new Promise<void>((resolve) => broken.listen(0, "127.0.0.1", resolve))
    const brokenPort = (broken.address() as { port: number }).port

    const askCodex = () =>
      ChatGPTSubscription.stream(
        {
          apiKey: "access-token",
          accountId: "acct_7",
          model: { provider: "chatgpt", model: "gpt-5.6-sol" },
          system: "",
          history: [],
          tools: [],
          effort: "medium",
          showReasoning: true,
          signal: new AbortController().signal,
          baseURL: `http://127.0.0.1:${brokenPort}`,
        },
        () => {},
      ).then(
        (result) => `finished: ${result.stop}`,
        (failure: Error) => failure.message,
      )

    failureBody = `data: ${JSON.stringify({
      type: "response.failed",
      response: { error: { message: "Your ChatGPT plan does not include this model." } },
    })}\n\n`
    const refused = await askCodex()
    check(
      "a failed response says what the provider said",
      refused.includes("plan does not include this model"),
      refused,
    )

    failureBody = ""
    const cut = await askCodex()
    check("a dropped connection is not a finished turn", !cut.startsWith("finished:"), cut)

    broken.close()
  }

  // ------------------------------------------------------------ workspace --
  // The hero used to state "main branch" unconditionally, for directories that
  // were not repositories and for ones that had been deleted.

  const wsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-ws-"))
  const repo = path.join(wsRoot, "repo")
  const plain = path.join(wsRoot, "plain")
  await fs.mkdir(repo)
  await fs.mkdir(plain)
  await fs.mkdir(path.join(repo, ".git"))
  await fs.writeFile(path.join(repo, ".git", "HEAD"), "ref: refs/heads/feature/x\n")

  const repoInfo = await workspaceInfo(repo)
  check("a repository reports its actual branch", repoInfo.branch === "feature/x", repoInfo.branch)

  const plainInfo = await workspaceInfo(plain)
  check("a plain directory claims no branch", plainInfo.exists && plainInfo.branch === undefined, plainInfo)

  const goneInfo = await workspaceInfo(path.join(wsRoot, "absent"))
  check("a missing directory is reported missing", !goneInfo.exists && !goneInfo.modified, goneInfo)

  await fs.writeFile(path.join(repo, ".git", "HEAD"), "9f1c2ab3d4e5f60718293a4b5c6d7e8f90123456\n")
  const detached = await workspaceInfo(repo)
  check("a detached HEAD shows a short sha", detached.branch === "9f1c2ab", detached.branch)

  await fs.rm(wsRoot, { recursive: true, force: true })

  // ---------------------------------------------------------------- oauth --
  // The token exchange itself needs a real login, but everything leading up to
  // it - the challenge, the loopback listener, the state check - does not.

  const pending = begin(CHATGPT)
  const authorize = new URL(pending.url)
  check(
    "authorize URL targets the vendor endpoint",
    authorize.origin + authorize.pathname === "https://auth.openai.com/oauth/authorize",
    authorize.href,
  )
  check(
    "PKCE challenge is S256 and derived from the verifier",
    authorize.searchParams.get("code_challenge_method") === "S256" &&
      createHash("sha256").update(pending.verifier).digest("base64url") ===
        authorize.searchParams.get("code_challenge"),
  )
  check(
    "authorize URL carries the public client and loopback redirect",
    authorize.searchParams.get("client_id") === CHATGPT.clientId &&
      authorize.searchParams.get("redirect_uri") === `http://localhost:${CHATGPT.port}/auth/callback`,
  )
  check(
    "each login gets a fresh verifier and state",
    begin(CHATGPT).verifier !== pending.verifier && begin(CHATGPT).state !== pending.state,
  )

  // Abandoning an attempt must settle it. While close() left listen() pending,
  // its timeout fired minutes later and cancelled whatever had replaced it.
  const abandoned = new CallbackServer()
  const abandonedOutcome = abandoned.listen(begin(CHATGPT), 10_000).then(
    () => "resolved",
    (error: Error) => error.message,
  )
  await new Promise((resolve) => setTimeout(resolve, 150))
  abandoned.close()
  check(
    "closing an attempt settles it instead of leaving it armed",
    (await abandonedOutcome) === "auth.cancelled",
    await abandonedOutcome,
  )

  const listener = new CallbackServer()
  const awaited = listener.listen(pending, 10_000)
  await new Promise((resolve) => setTimeout(resolve, 150))
  await fetch(`${pending.redirectURI}?code=test-code&state=${encodeURIComponent(pending.state)}`, {
    headers: { connection: "close" },
  })
  check("loopback callback yields the code", (await awaited) === "test-code")

  const guarded = new CallbackServer()
  const forgedOutcome = guarded.listen(begin(CHATGPT), 10_000).then(
    () => "resolved",
    (error: Error) => error.message,
  )
  await new Promise((resolve) => setTimeout(resolve, 150))
  await fetch(`http://localhost:${CHATGPT.port}/auth/callback?code=x&state=forged`, {
    headers: { connection: "close" },
  })
  const forgedResult = await forgedOutcome
  check("a forged state is refused", forgedResult === "auth.state", forgedResult)

  // The device flow, against a stand-in for the vendor. Worth faking: the whole
  // point of it is the polling, which no amount of URL inspection would cover.
  let polls = 0
  let exchanged: Record<string, string> = {}
  const vendor = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" })
      response.end(JSON.stringify(body))
    }

    if (url.pathname === "/usercode") {
      json(200, { user_code: "1F3B-PY78V", device_auth_id: "dev_1", interval: 0 })
      return
    }
    if (url.pathname === "/devicetoken") {
      polls += 1
      // 403 is how the endpoint says "not approved yet"; it must not end the loop.
      if (polls < 3) {
        json(403, { error: "authorization_pending" })
        return
      }
      json(200, { authorization_code: "granted", code_verifier: "verifier-from-server" })
      return
    }
    if (url.pathname === "/deadcode") {
      // Anything that is not 403/404 is terminal - an expired or revoked code.
      json(400, { error: "expired_token" })
      return
    }
    if (url.pathname === "/token") {
      let body = ""
      request.on("data", (chunk) => (body += chunk))
      request.on("end", () => {
        exchanged = Object.fromEntries(new URLSearchParams(body))
        json(200, { access_token: "at", refresh_token: "rt", expires_in: 3600 })
      })
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve) => vendor.listen(0, "127.0.0.1", resolve))
  const vendorPort = (vendor.address() as { port: number }).port
  const origin = `http://127.0.0.1:${vendorPort}`

  const fake: OAuthProvider = {
    ...CHATGPT,
    tokenURL: `${origin}/token`,
    device: {
      startURL: `${origin}/usercode`,
      pollURL: `${origin}/devicetoken`,
      verificationURL: "https://auth.openai.com/codex/device",
      redirectURI: "https://auth.openai.com/deviceauth/callback",
    },
  }

  const device = await beginDevice(fake)
  check("device start returns the code the user types", device.userCode === "1F3B-PY78V", device.userCode)
  check("device start keeps the verification page", device.verificationURL.endsWith("/codex/device"))

  const deviceTokens = await pollDevice(device, new AbortController().signal)
  check("polling waits for approval instead of giving up", polls === 3, polls)
  check("device flow ends with an access token", deviceTokens.access === "at", deviceTokens.access)
  check(
    "device exchange uses the verifier the server issued",
    exchanged.code_verifier === "verifier-from-server" && exchanged.code === "granted",
    exchanged,
  )

  // The Codex backend answers with models[]/slug, not the OpenAI data[]/id.
  const catalogServer = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" })
    response.end(
      JSON.stringify({
        models: [
          { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", context_window: 272000 },
          { slug: "gpt-5.4-mini", display_name: "GPT-5.4-Mini", context_window: 272000 },
          { missing: "no slug" },
        ],
      }),
    )
  })
  await new Promise<void>((resolve) => catalogServer.listen(0, "127.0.0.1", resolve))
  const catalogPort = (catalogServer.address() as { port: number }).port
  const discovered = await discoverSubscriptionModels(`http://127.0.0.1:${catalogPort}`, "tok", "acct")
  check("subscription models come from the backend, not a baked-in list", discovered.length === 2, discovered.length)
  check(
    "slug and display name are mapped through",
    discovered[0].id === "gpt-5.6-sol" && discovered[0].name === "GPT-5.6-Sol" && discovered[0].contextWindow === 272000,
    discovered[0],
  )
  check("a subscription reports no per-token cost", discovered.every((m) => m.input === 0 && m.output === 0))
  catalogServer.close()

  const expired: OAuthProvider = { ...fake, device: { ...fake.device, pollURL: `${origin}/deadcode` } }
  const expiredOutcome = await pollDevice(await beginDevice(expired), new AbortController().signal).then(
    () => "resolved",
    (error: Error) => error.message,
  )
  check(
    "an expired device code fails instead of polling forever",
    expiredOutcome === "auth.device:400",
    expiredOutcome,
  )

  const abort = new AbortController()
  abort.abort()
  const cancelled = await pollDevice(await beginDevice(fake), abort.signal).then(
    () => "resolved",
    (error: Error) => error.message,
  )
  check("cancelling stops the poll", cancelled === "auth.cancelled", cancelled)
  vendor.close()

  const idToken = [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_42" } })).toString(
      "base64url",
    ),
    "sig",
  ].join(".")
  const claims = decodeClaims(idToken)
  check("account id is read from the nested id_token claim", claims && accountId(claims) === "acct_42")

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

async function exists(file: string) {
  return fs
    .access(file)
    .then(() => true)
    .catch(() => false)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
