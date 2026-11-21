import assert from "node:assert/strict"
import { spawn } from "node:child_process"
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

/**
 * A hook that speaks on stderr and leaves with a chosen exit code, spelled in the one
 * interpreter both shells understand. The previous fixtures wrote POSIX grammar
 * (`printf '...' >&2; exit 2`). On Windows the hook runs through `cmd.exe /d /s /c`, and
 * while the runner's PATH carries Git's coreutils (printf/sleep/touch do execute there —
 * the `sleep 4` timeout case is green twice running), cmd has none of the grammar: `;` is
 * an argument separator, not a statement separator, so `exit 2`/`exit 3` became printf
 * arguments and the child exited 0 — measured on run 44951082525, where the fixture
 * `printf oops >&2; exit 3` produced no hook log line at all (any real non-zero exit logs
 * its code), and cmd also never expands `$VAR`. A non-2, non-zero-less exit is "not a
 * refusal" by contract, so the tool ran: that is the measured cause of run 44949680691's
 * `exit 2 returns only the first reason... -> 'completed' != 'error'`. A node script says
 * the same thing in both shells, and node is certain to be on PATH (a `node "<file>"`
 * hook has been green on Windows since run cb7efbe), so the exit code still travels
 * through the real cmd.exe spawn shape and every assertion keeps its exact meaning there.
 */
async function exitHook(dir: string, file: string, stderrLines: string[], code: number): Promise<string> {
  const script = path.join(dir, file)
  const body = stderrLines.length ? `process.stderr.write(${JSON.stringify(stderrLines.join("\n") + "\n")})\n` : ""
  await fs.writeFile(script, `${body}process.exit(${code})\n`, "utf8")
  return `node "${script}"`
}

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
    const refusal = await exitHook(dir, "refuse.mjs", ["blocked", "ignored"], 2)
    // The second hook marks the file with `echo ... > "ran"`, which creates it in cmd.exe
    // and /bin/sh alike. The old `touch ran` did not exist in cmd, so "later hooks were
    // prevented" passed vacuously on Windows once the refusal itself missed the exit code.
    const f = fixture(dir, { PreToolUse: [hook(refusal), hook('echo ran > "ran"')] })
    const part = await f.runTool()
    assert.equal(part.status, "error")
    assert.equal(part.error, "blocked")
    assert.equal(f.executions(), 0)
    await assert.rejects(fs.stat(path.join(dir, "ran")), { code: "ENOENT" })
  }],
  ["the refusal verb reaches the engine's own spawn shape as exit code 2 on either shell", async (dir) => {
    const command = await exitHook(dir, "exit-two.mjs", ["blocked", "ignored"], 2)
    // Spawns exactly the way src/server/hooks/index.ts does — cmd.exe /d /s /c with
    // verbatim arguments on Windows, /bin/sh -c elsewhere — and demands the raw exit
    // code. This case keeps the two Windows failure modes distinguishable: if it goes
    // red there, a red refusal case is a spawn/exit-code plumbing problem, not hook
    // command vocabulary; if it is green while a refusal case is red, the engine's
    // exit-2 handling is the defect.
    const windows = process.platform === "win32"
    const executable = windows ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe") : "/bin/sh"
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(executable, windows ? ["/d", "/s", "/c", `"${command}"`] : ["-c", command], {
        cwd: dir, windowsHide: true, windowsVerbatimArguments: windows, stdio: ["ignore", "pipe", "pipe"],
      })
      child.stdout.resume()
      child.stderr.resume()
      child.once("error", () => resolve(null))
      child.once("close", resolve)
    })
    assert.equal(code, 2)
  }],
  ["a failing hook whose exit code is not 2 warns but never blocks the tool", async (dir) => {
    // The rule that made the Windows reds possible, now pinned portably: only exit code 2
    // is a refusal. A POSIX verb cmd.exe cannot run lands in exactly this bucket — its
    // code is not 2 — which is why the old fixtures let the tool run instead of erroring.
    const noisy = await exitHook(dir, "noisy.mjs", ["hook-noisy"], 1)
    const f = fixture(dir, { PreToolUse: [hook(noisy)] })
    const part = await f.runTool()
    assert.equal(part.status, "completed")
    assert.equal(part.output, "original")
    assert.equal(f.executions(), 1)
    assert.match(f.logs.join("\n"), /PreToolUse hooks_probe: exit 1/)
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

      // Spelled through a node script (see exitHook): under cmd.exe the old
      // `printf oops >&2; exit 3` swallowed `; exit 3` as printf arguments and
      // exited 0 — run 44951082525 measured no hook log line at all. exit 3 must
      // be the child's real exit code for "the engine warns but does not block"
      // to mean what it says on Windows.
      const noisy = await exitHook(dir, "noisy3.mjs", ["oops"], 3)
      post.config.hooks = { PostToolUse: [hook(noisy)] }
      const loud = post.execute()
      void loud.catch(() => undefined)
      await answer(post.permissions, noisy, "once")
      assert.equal(await loud, "original")
      assert.match(post.logs.join("\n"), /PostToolUse read: exit 3/)

      // A rule added afterwards denies the hook without even asking. The resource
      // names the whole command because that is the only spelling this one-segment
      // hook can match (the old one matched the `exit 3` segment).
      post.config.permissionRules = [{ action: "bash", resource: noisy, effect: "deny" }]
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
    // Node-spelled refusal (see exitHook): under cmd.exe the old
    // `echo blocked-before-shell >&2; exit 2` exited 0 because `;` is an argument
    // separator, so the pre hook never refused anything and the Bash tool acted —
    // run 44951082525 measured allowed.error === undefined here. The BASH matcher
    // is what this case is about, so the hook stays addressed to the bash tool.
    const refuseBash = await exitHook(dir, "refuse-bash.mjs", ["blocked-before-shell"], 2)
    f.config.hooks = { PreToolUse: [hook(refuseBash, "BASH")] }
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
    // The old fixture piped through `printf "%s" "$MCODE_HOOK_EVENT"...; cat > payload` —
    // cmd.exe leaves `$MCODE_HOOK_EVENT` unexpanded, so on run 44951082525 the note was
    // the literal `$MCODE_HOOK_EVENT` text and `cat`'s target was spelled in shell that
    // never ran. A node script reads the environment and stdin the same way either shell
    // would hand them over, so both facts (env identifies the call, stdin carries the
    // preview-bounded payload) are still being tested on Windows.
    const probe = path.join(dir, "probe.mjs")
    await fs.writeFile(
      probe,
      "import fs from 'node:fs'\n" +
        "let data = ''\n" +
        "process.stdin.on('data', (chunk) => { data += chunk })\n" +
        "process.stdin.on('end', () => {\n" +
        "  process.stdout.write(String(process.env.MCODE_HOOK_EVENT) + ' ' + String(process.env.MCODE_HOOK_TOOL))\n" +
        "  fs.writeFileSync('payload', data)\n" +
        "})\n",
      "utf8",
    )
    const f = fixture(dir, { PostToolUse: [hook(`node "${probe}"`)] })
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
    // `mkdtemp` needs its parent: on a clean checkout (Linux box, another runner)
    // nothing has created `tmp-local/` yet and the whole module aborted (measured on
    // a fresh 1.2.6 checkout, 2026-11-22: ENOENT mkdtemp .../tmp-local/hooks-case-).
    const caseRoot = path.resolve("tmp-local")
    await fs.mkdir(caseRoot, { recursive: true })
    const directory = await fs.mkdtemp(path.join(caseRoot, "hooks-case-"))
    try {
      await runGit(directory, ["init", "--quiet", "--template="])
      await run(directory)
      check(name, true)
    } catch (e) {
      check(name, false, (e as Error).message)
    } finally {
      // Windows runners can hold a handle on the case directory a beat past the last
      // hook's `close` — run 44949680691 measured an `EBUSY ... rmdir tmp-local/
      // hooks-case-*` that left this module "not clean" on top of its FAILs. Retry
      // briefly, then report whatever fs still says; nothing is swallowed.
      for (let attempt = 0; ; attempt++) {
        try {
          await fs.rm(directory, { recursive: true, force: true })
          break
        } catch (error) {
          if (attempt >= 8 || (error as NodeJS.ErrnoException).code !== "EBUSY") throw error
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
      }
    }
  }
}

if (process.argv[1]?.split("/").pop() === "smoke-hooks-engine.ts") {
  await hooksEngineChecks((name, ok, detail) => {
    console.log(ok ? "PASS" : "FAIL", name, detail ?? "")
    if (!ok) process.exitCode = 1
  })
}
