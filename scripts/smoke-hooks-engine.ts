import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { Bus } from "../src/server/bus"
import { runGit } from "../src/server/git-process"
import { SessionRunner } from "../src/server/session/runner"
import type { AssistantMessage, PermissionRule, ToolPart } from "../src/shared/protocol"
import type { Config } from "../src/server/config"
import { HookEngine } from "../src/server/hooks"
import { Permissions } from "../src/server/permission"
import { DEFAULT_PERMISSIONS } from "../src/shared/protocol"

type Check = (name: string, ok: boolean, detail?: string) => void
const cases: [string, (directory: string) => Promise<void>][] = []
const hook = (command: string, matcher = "*", timeoutMs?: number) => ({ command, matcher, timeoutMs })

function fixture(directory: string, hooks: unknown, accessLevel = "full") {
  const config = {
    hooks, accessLevel, allowFullAccess: true, permissions: { ...DEFAULT_PERMISSIONS, read: "allow", ...(accessLevel === "full" ? { bash: "allow", edit: "allow", outside: "allow" } : {}) }, permissionRules: [] as PermissionRule[],
  }
  const bus = new Bus()
  const permissions = new Permissions(bus, { get: () => config } as unknown as Config)
  const logs: string[] = []
  const engine = new HookEngine(permissions, (message: string) => logs.push(message))
  const signal = new AbortController().signal
  const call = { sessionID: "session", messageID: "message", callID: "call", signal, tool: "read", args: { file_path: "a" } }
  let executions = 0
  async function execute(tool = "read") {
    const snapshot = await engine.snapshot(directory, config.hooks)
    await permissions.check({ ...call, tool, kind: "read", arguments: call.args })
    await engine.before(snapshot, { ...call, tool })
    executions++
    return engine.after(snapshot, { ...call, tool }, "original")
  }
  async function runTool(name = "hooks_probe", args = call.args as Record<string, unknown>) {
    const runner = Object.assign(Object.create(SessionRunner.prototype) as SessionRunner, {
      hooks: engine, permissions, bus,
      config: { get: () => config },
      inputErrors: new WeakMap(), owners: new Map(), workers: new Set(), pressured: new Map(),
      checkRepeated: async () => {}, settleForLoops: () => {}, turn: () => ({}),
      noteInteractiveRefusal: async () => {}, readSupport: () => ({}),
      store: { get: async () => undefined, saveMessage: async () => {} },
      toolOutputs: { cap: async () => undefined, holds: () => false },
      mcp: { tools: () => [{
        name: "hooks_probe", permission: "read",
        parameters: { type: "object", properties: { file_path: { type: "string" } } },
        execute: async () => { executions++; return { output: "original" } },
      }] },
    })
    const session = { id: call.sessionID, directory, model: { provider: "", model: "" }, agent: "build" as const }
    const part: ToolPart = {
      type: "tool", id: "part", callID: call.callID, name, status: "pending", input: args, time: { created: 0 },
    }
    const assistant: AssistantMessage = {
      id: call.messageID, sessionID: session.id, role: "assistant", model: session.model, agent: session.agent,
      parts: [part], time: { created: 0 },
    }
    await runner["runTool"]({ part, assistant, session, hooks: await engine.snapshot(directory, config.hooks), signal })
    return part
  }
  return { engine, call, config, permissions, logs, execute, runTool, executions: () => executions }
}

cases.push(
  ["exit 2 returns only the first reason and prevents tool and later hooks", async (dir) => {
    const f = fixture(dir, { PreToolUse: [hook("printf 'blocked\\nignored\\n' >&2; exit 2"), hook("touch ran")] })
    const part = await f.runTool()
    assert.equal(part.status, "error")
    assert.equal(part.error, "blocked")
    assert.equal(f.executions(), 0)
    await assert.rejects(fs.stat(path.join(dir, "ran")), { code: "ENOENT" })
  }],
  ["exit 0 and a timed-out hook allow execution and timeout is logged", async (dir) => {
    const f = fixture(dir, { PreToolUse: [hook("exit 0"), hook("sleep 4", "*", 35)] })
    const start = Date.now()
    const part = await f.runTool()
    assert.equal(part.status, "completed")
    assert.equal(part.output, "original")
    assert.equal(f.executions(), 1)
    assert.ok(Date.now() - start < 3000)
    assert.match(f.logs.join("\n"), /timed out/i)
  }],
  ["post stdout becomes one note and blank stdout leaves output intact", async (dir) => {
    const f = fixture(dir, { PostToolUse: [hook("printf 'first\\nsecond\\n'"), hook("printf ' \\n'")] })
    assert.equal((await f.runTool()).output, "original\nhook: first second")
    f.config.hooks = { PostToolUse: [hook("exit 0")] }
    assert.equal((await f.runTool()).output, "original")
  }],
  ["wildcard and case-insensitive exact matching", async (dir) => {
    const f = fixture(dir, { PostToolUse: [hook("echo all"), hook("echo read", "rEaD"), hook("echo wrong", "rea*")] })
    assert.equal(await f.execute(), "original\nhook: all\nhook: read")
    assert.equal(await f.execute("bash"), "original\nhook: all")
  }],
  ["global then project, missing project and stable snapshots", async (dir) => {
    const f = fixture(dir, { PostToolUse: [hook("echo global")] })
    const before = await f.engine.snapshot(dir, f.config.hooks)
    await fs.mkdir(path.join(dir, ".mcode"))
    await fs.writeFile(path.join(dir, ".mcode/hooks.json"), JSON.stringify({ hooks: { PostToolUse: [hook("echo project")] } }))
    assert.equal(await f.execute(), "original\nhook: global\nhook: project")
    assert.equal(await f.engine.after(before, f.call, "original"), "original\nhook: global")
  }],
  ["invalid entries are skipped and returned with diagnostic codes", async (dir) => {
    const f = fixture(dir, { PreToolUse: [hook("exit 2", "*", 0), { matcher: "read" }] })
    const snapshot = await f.engine.snapshot(dir, f.config.hooks)
    assert.deepEqual(snapshot.groups[0].rows.map((row) => row.reason), ["timeout", "command"])
    assert.equal(await f.execute(), "original")
  }],
  ["ask and auto ask for every hook call and a refusal leaves the tool unhooked", async (dir) => {
    for (const level of ["ask", "auto"]) {
      const blocked = "exit 2"
      const pre = fixture(dir, { PreToolUse: [hook(blocked)] }, level)
      const refused = pre.execute()
      void refused.catch(() => undefined)
      await answer(pre.permissions, blocked, "reject")
      assert.equal(await refused, "original")
      // Nothing is remembered about the answer: the next call asks on its own.
      const again = pre.execute()
      void again.catch(() => undefined)
      await answer(pre.permissions, blocked, "reject")
      assert.equal(await again, "original")
      assert.equal(pre.executions(), 2)
      assert.equal(pre.permissions.outstanding().length, 0)

      const noted = "echo noted"
      const post = fixture(dir, { PostToolUse: [hook(noted)] }, level)
      const firstRun = post.execute()
      void firstRun.catch(() => undefined)
      await answer(post.permissions, noted, "once")
      assert.equal(await firstRun, "original\nhook: noted")
      // An approval covers the call it answered, not the ones after it.
      const secondRun = post.execute()
      void secondRun.catch(() => undefined)
      await answer(post.permissions, noted, "reject")
      assert.equal(await secondRun, "original")

      const noisy = "printf oops >&2; exit 3"
      post.config.hooks = { PostToolUse: [hook(noisy)] }
      const loud = post.execute()
      void loud.catch(() => undefined)
      await answer(post.permissions, noisy, "once")
      assert.equal(await loud, "original")
      assert.match(post.logs.join("\n"), /PostToolUse read: exit 3/)

      // A rule added afterwards denies the hook without even asking.
      post.config.permissionRules = [{ action: "bash", resource: "exit 3", effect: "deny" }]
      assert.equal(await post.execute(), "original")
      assert.equal(post.permissions.outstanding().length, 0)
    }
  }],
  ["policy deny precedes the pre hook even in full access", async (dir) => {
    const f = fixture(dir, { PreToolUse: [hook("touch ran")] })
    f.config.permissions.read = "deny"
    const part = await f.runTool()
    assert.equal(part.status, "error")
    assert.match(part.error ?? "", /permission is set to Deny/)
    assert.equal(f.executions(), 0)
    await assert.rejects(fs.stat(path.join(dir, "ran")), { code: "ENOENT" })
  }],
  ["a denied Bash segment and a denied outside read never reach the pre hook", async (dir) => {
    const f = fixture(dir, { PreToolUse: [hook("touch ran")] })
    f.config.permissionRules = [{ action: "bash", resource: "echo forbidden", effect: "deny" }]
    const bash = await f.runTool("bash", { command: "echo allowed; echo forbidden", description: "Check command policy" })
    assert.match(bash.error ?? "", /permission is set to Deny/)
    await assert.rejects(fs.stat(path.join(dir, "ran")), { code: "ENOENT" })

    f.config.permissionRules = [{ action: "outside", resource: "*", effect: "deny" }]
    const read = await f.runTool("read", { file_path: "../outside.txt" })
    assert.match(read.error ?? "", /permission is set to Deny/)
    await assert.rejects(fs.stat(path.join(dir, "ran")), { code: "ENOENT" })

    f.config.permissionRules = []
    f.config.hooks = { PreToolUse: [hook("echo blocked-before-shell >&2; exit 2", "BASH")] }
    const allowed = await f.runTool("bash", { command: "touch tool-ran", description: "Check pre-hook ordering" })
    assert.equal(allowed.error, "blocked-before-shell")
    await assert.rejects(fs.stat(path.join(dir, "tool-ran")), { code: "ENOENT" })
  }],
  ["a linked worktree uses its own hooks from a nested session directory", async (dir) => {
    const f = fixture(dir, {})
    const tree = path.join(dir, "linked")
    const env = { GIT_CONFIG_GLOBAL: path.join(dir, "empty-git-config"), GIT_CONFIG_NOSYSTEM: "1" }
    await runGit(dir, ["-c", "user.name=Hooks Test", "-c", "user.email=hooks@example.invalid", "commit", "--allow-empty", "-m", "fixture"], { env })
    await runGit(dir, ["worktree", "add", "--detach", tree], { env })
    for (const [root, command] of [[dir, "echo main"], [tree, "echo linked"]]) {
      await fs.mkdir(path.join(root, ".mcode"))
      await fs.writeFile(path.join(root, ".mcode/hooks.json"), JSON.stringify({ hooks: { PostToolUse: [hook(command)] } }))
    }
    const nested = path.join(tree, "pkg")
    await fs.mkdir(nested)
    const snapshot = await f.engine.snapshot(nested, f.config.hooks)
    assert.equal(snapshot.projectRoot, tree)
    assert.equal(snapshot.groups.find((group) => group.scope === "project")?.rows[0].source, path.join(tree, ".mcode/hooks.json"))
    assert.equal(await f.engine.after(snapshot, f.call, "original"), "original\nhook: linked")
  }],
  ["stdin and environment identify the call and bound the UTF-8 preview", async (dir) => {
    const f = fixture(dir, { PostToolUse: [hook('printf "%s %s\\n" "$MCODE_HOOK_EVENT" "$MCODE_HOOK_TOOL"; cat > payload')] })
    const snapshot = await f.engine.snapshot(dir, f.config.hooks)
    const output = "x" + "汉".repeat(5000)
    assert.equal(await f.engine.after(snapshot, f.call, output), output + "\nhook: PostToolUse read")
    const payload = JSON.parse(await fs.readFile(path.join(dir, "payload"), "utf8"))
    assert.deepEqual(payload, {
      event: "PostToolUse", tool: "read", args: f.call.args, sessionKey: "session",
      projectRoot: dir, resultPreview: "x" + "汉".repeat(1365),
    })
  }],
)

async function answer(permissions: Permissions, command: string, response: "reject" | "once") {
  for (let attempt = 0; attempt < 200 && !permissions.outstanding().length; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const requests = permissions.outstanding()
  assert.equal(requests.length, 1)
  assert.equal(requests[0].subject, command)
  permissions.respond(requests[0].id, response)
}

export async function hooksEngineChecks(check: Check) {
  for (const [name, run] of cases) {
    const directory = await fs.mkdtemp(path.resolve("tmp-local/hooks-case-"))
    try {
      await runGit(directory, ["init", "--quiet", "--template="])
      await run(directory)
      check(name, true)
    } catch (e) {
      check(name, false, (e as Error).message)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  }
}

if (process.argv[1]?.split("/").pop() === "smoke-hooks-engine.ts") {
  await hooksEngineChecks((name, ok, detail) => {
    console.log(ok ? "PASS" : "FAIL", name, detail ?? "")
    if (!ok) process.exitCode = 1
  })
}
