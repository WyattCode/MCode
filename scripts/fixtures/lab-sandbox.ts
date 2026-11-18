import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { randomUUID } from "node:crypto"
import type { runSandboxed } from "../../src/server/lab-sandbox"

export async function sandboxFixture(run: typeof runSandboxed): Promise<void> {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "lab-test-"))
  const worker = path.join(folder, "worker")
  const deps = path.join(folder, "node_modules")
  const controller = new AbortController()
  let stopped: Promise<unknown> | undefined
  try {
    await fs.mkdir(worker)
    await fs.mkdir(deps)
    const outside = path.join(folder, "host-origin.git")
    execFileSync("git", ["init", "-q", "--bare", outside])
    await fs.writeFile(path.join(worker, ".git"), "gitdir: /unavailable\n")
    const command = (program: string, ...args: string[]) => run(worker, deps, program, args, controller.signal)
    const probe = await command("node", "--version")
    assert.equal(probe.code, 0, probe.output)

    // A synthetic repository can write inside /tmp, but it cannot push to a
    // configured destination, edit the linked Git metadata, or modify deps.
    const push = await command("sh", "-eu", "-c", [
      "git init -q /tmp/origin",
      "git init -q /tmp/source",
      "git -C /tmp/source -c user.name=Lab -c user.email=lab@localhost commit -q --allow-empty -m test",
      "git -C /tmp/source remote add origin /tmp/origin",
      "git -C /tmp/source push origin HEAD:refs/heads/attempt",
    ].join("\n"))
    assert.notEqual(push.code, 0)
    assert.match(push.output, /transport 'file' not allowed/)
    const outsidePush = await command("sh", "-eu", "-c", [
      "git init -q /tmp/source",
      "git -C /tmp/source -c user.name=Lab -c user.email=lab@localhost commit -q --allow-empty -m test",
      'GIT_ALLOW_PROTOCOL=file git -C /tmp/source push "$1" HEAD:refs/heads/attempt',
    ].join("\n"), "push-test", outside)
    assert.notEqual(outsidePush.code, 0)
    assert.equal(execFileSync("git", ["-C", outside, "for-each-ref"], { encoding: "utf8" }), "")
    for (const destination of ["/work/.git/config", "/work/.git", "/deps/probe", "/etc/probe", folder + "/probe"]) {
      const write = await command("node", "-e", "require('fs').writeFileSync(process.argv[1], 'blocked')", destination)
      assert.notEqual(write.code, 0, destination)
    }
    const token = `lab-cancel-${randomUUID()}`
    const processes = () => execFileSync("ps", ["-eo", "comm,args"], { encoding: "utf8" }).split("\n")
      .filter((line) => /^\s*node\s+/.test(line) && line.endsWith(` ${token}`))
    const detached = () => processes().some((line) => /node -e setInterval/.test(line))
    const wait = run(worker, deps, "node", ["-e",
      "require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', process.argv[1]], {detached:true}).unref(); setInterval(()=>{},1000)",
      token,
    ], controller.signal)
    stopped = assert.rejects(wait, { name: "AbortError" })
    void stopped.catch(() => {})
    for (let attempt = 0; attempt < 50 && !detached(); attempt++) await delay(100)
    assert.ok(detached(), "detached sandbox descendant started")
    controller.abort()
    await stopped
    for (let attempt = 0; attempt < 50 && processes().length; attempt++) await delay(100)
    assert.equal(processes().length, 0, "sandbox PID namespace and detached descendants stopped")
  } finally {
    controller.abort()
    await stopped?.catch(() => {})
    await fs.rm(folder, { recursive: true, force: true })
  }
}
