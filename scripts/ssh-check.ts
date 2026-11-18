import "./fenced-home"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Bus } from "../src/server/bus"
import { Config } from "../src/server/config"
import { Permissions } from "../src/server/permission"
import { SessionRunner } from "../src/server/session/runner"
import { SessionStore } from "../src/server/session/store"
import { Devices } from "../src/server/ssh/devices"
import { SshPool } from "../src/server/ssh/pool"
import { Storage } from "../src/server/storage"
import type { AssistantMessage, PermissionResponse, SessionInfo, ToolPart } from "../src/shared/protocol"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "ssh-check-"))
const storage = new Storage(root)
const secrets = new Map<string, string>()
const devices = new Devices(storage, {
  async put(id, value) { secrets.set(id, value) },
  async remove(id) { secrets.delete(id) },
})
const pool = new SshPool(devices, path.join(root, "fake-ssh"))
let runner: SessionRunner | undefined

try {
  const password = "plaintext-canary-6ebfaa"
  const device = await devices.save({ name: "Test", host: "example.test", port: 22, user: "dev", auth: "password", password })
  assert.equal(secrets.size, 1)
  assert.equal((await devices.list())[0].name, "Test")
  assert.ok(!(await fs.readFile(path.join(root, "ssh-devices.json"), "utf8")).includes(password))
  assert.ok(!JSON.stringify(device).includes(password))
  await assert.rejects(devices.save({ ...device, host: "another.test" }), /password/i)
  await devices.save({ ...device, name: "Renamed" })
  assert.equal((await devices.list())[0].name, "Renamed")
  assert.equal(secrets.size, 1)
  await devices.remove(device.id)
  assert.deepEqual(await devices.list(), [])
  assert.equal(secrets.size, 0)

  const saved = await devices.save({ name: "Fake", host: "example.test", port: 22, user: "dev", auth: "agent" })
  const local = path.join(root, "local")
  const remote = path.join(root, "remote")
  await Promise.all([fs.mkdir(local), fs.mkdir(remote)])
  await fs.writeFile(path.join(local, "marker.txt"), "LOCAL")
  await fs.writeFile(path.join(remote, "marker.txt"), "REMOTE")
  await fs.writeFile(path.join(root, "fake-ssh"), `#!/bin/sh
root=$(dirname "$0")
command=
for arg do
  [ "$arg" = "-O" ] && exit 0
  command=$arg
done
printf '%s\\n' "$command" >> "$root/calls"
cd "$root/remote" || exit
exec /bin/sh -c "$command"
`, { mode: 0o700 })

  const bus = new Bus()
  const config = new Config(storage, bus, path.join(root, "credentials.json"))
  await storage.write("config", {})
  await config.load()
  await config.set({ directory: local, permissions: { bash: "ask", edit: "ask" } })
  const permissions = new Permissions(bus, config)
  const sessions = new SessionStore(storage, bus)
  permissions.useSessions(async (id) => (await sessions.get(id))?.access)
  runner = new SessionRunner(sessions, bus, config, permissions, {} as never, storage, pool)
  const localSession = await sessions.create({ directory: local, agent: "build", model: config.get().model })
  const remoteSession = await sessions.create({ directory: local, sshDeviceId: saved.id, agent: "build", model: config.get().model })
  assert.equal((await sessions.require(remoteSession.id)).sshDeviceId, saved.id)
  assert.equal((await sessions.require(localSession.id)).sshDeviceId, undefined)

  type RunTool = (input: { part: ToolPart; assistant: AssistantMessage; session: SessionInfo; signal: AbortSignal }) => Promise<void>
  const runTool = (runner as unknown as { runTool: RunTool }).runTool.bind(runner)
  let decision: PermissionResponse = "once"
  const asked: { kind: string; subject: string; forced?: boolean }[] = []
  bus.subscribe((event) => {
    if (event.type !== "permission.requested") return
    asked.push(event.request)
    if (event.request.sessionID === remoteSession.id && event.request.forced && decision === "reject") {
      // A session/config event must not dismiss remote approval under full access.
      void permissions.drainDecided().then(() => permissions.respond(event.request.id, "reject"))
      return
    }
    permissions.respond(event.request.id, decision)
  })

  async function call(session: SessionInfo, name: string, input: Record<string, unknown>) {
    const time = { created: Date.now() }
    const part: ToolPart = { id: randomUUID(), callID: randomUUID(), name, input, time, type: "tool", status: "pending" }
    const assistant: AssistantMessage = {
      id: randomUUID(), sessionID: session.id, role: "assistant",
      agent: session.agent, model: session.model, parts: [part], time: { ...time },
    }
    await sessions.saveMessage(assistant)
    await runTool({ part, assistant, session, signal: new AbortController().signal })
    return part
  }

  assert.equal((await pool.test({ id: saved.id })).ok, true)
  const initialCalls = await fs.readFile(path.join(root, "calls"), "utf8")
  assert.equal(initialCalls, "uname -srm\n")
  const localRead = await call(localSession, "read", { file_path: "marker.txt" })
  assert.equal(localRead.status, "completed", localRead.error)
  assert.match(localRead.output ?? "", /LOCAL/)
  assert.equal(await fs.readFile(path.join(root, "calls"), "utf8"), initialCalls)
  const read = await call(remoteSession, "read", { file_path: "marker.txt" })
  assert.equal(read.status, "completed", read.error)
  assert.equal(read.output, "REMOTE")
  const write = await call(remoteSession, "write", { file_path: "sub dir/quote's.txt", content: "中文\n" })
  assert.equal(write.status, "completed", write.error)
  assert.equal(await fs.readFile(path.join(remote, "sub dir/quote's.txt"), "utf8"), "中文\n")
  await assert.rejects(fs.stat(path.join(local, "sub dir")))
  for (const [tool, input] of [
    ["glob", { pattern: "*.txt" }],
    ["grep", { pattern: "REMOTE" }],
  ] as const) {
    const part = await call(remoteSession, tool, input)
    assert.equal(part.status, "completed", part.error)
    assert.match(part.output ?? "", /marker.txt/)
  }
  const beforeDenial = await fs.readFile(path.join(root, "calls"), "utf8")
  await config.set({
    allowFullAccess: true,
    permissions: { bash: "allow", edit: "ask" },
    permissionRules: [{ action: "read", resource: "marker.txt", effect: "deny" }],
  })
  await sessions.setAccess(remoteSession.id, "full")
  decision = "reject"
  for (const command of ["rm -rf sub", "sudo -n true"]) {
    const denied = await call(remoteSession, "bash", { command, description: "Request denied" })
    assert.equal(denied.status, "error")
    assert.equal(asked.at(-1)?.subject, command)
    assert.equal(asked.at(-1)?.forced, true)
  }
  const deniedRead = await call(remoteSession, "read", { file_path: "marker.txt" })
  assert.equal(deniedRead.status, "error")
  assert.equal(await fs.readFile(path.join(root, "calls"), "utf8"), beforeDenial)
  const forbidden = await call({ ...remoteSession, agent: "plan" }, "write", { file_path: "plan-probe.txt", content: "blocked" })
  assert.equal(forbidden.status, "error")
  assert.equal(await fs.readFile(path.join(root, "calls"), "utf8"), beforeDenial)
  await sessions.setAccess(remoteSession.id, "ask")
  decision = "once"
  const bash = await call(remoteSession, "bash", { command: "cat marker.txt; exit 37", description: "Read and return an exit code" })
  assert.equal(bash.status, "completed", bash.error)
  assert.equal(bash.output, "REMOTE")
  assert.equal(bash.metadata?.exit, 37)
  const fork = await sessions.fork(remoteSession.id, (await sessions.messages(remoteSession.id))[0].id)
  assert.equal(fork.sshDeviceId, saved.id)
  assert.ok(!(await fs.readFile(path.join(root, "config.json"), "utf8")).includes(password))
  const oldBinding = await pool.bind(saved.id)
  await devices.save({ ...saved, host: "updated.test" })
  const beforeChange = await fs.readFile(path.join(root, "calls"), "utf8")
  await assert.rejects(oldBinding.command("uname -srm", { signal: new AbortController().signal, timeout: 1000 }), /device changed/i)
  assert.equal(await fs.readFile(path.join(root, "calls"), "utf8"), beforeChange)
  await devices.remove(saved.id)
  const removed = await call(remoteSession, "read", { file_path: "marker.txt" })
  assert.equal(removed.status, "error")
  assert.match(removed.error ?? "", /no longer exists/)
} finally {
  runner?.closeTurns()
  await runner?.usageDays.stop()
  await pool.close()
  await fs.rm(root, { recursive: true, force: true })
}
console.log("SSH checks passed")
