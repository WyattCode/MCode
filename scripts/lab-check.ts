import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { labTasks } from "../src/server/lab-catalog"
import { runGit } from "../src/server/git-process"
import { addWorktree, removeWorktree } from "../src/server/session/worktree"
import { Storage } from "../src/server/storage"
import { LAB_TASK_SET } from "../src/shared/lab"
import { generateTasks } from "./gen-lab-tasks"
import { Lab, passingRate, replayVerified, publishLabBranch } from "../src/server/lab"
import { sandboxCommand, runSandboxed } from "../src/server/lab-sandbox"

test("catalog generation is deterministic and contains eight historical tasks", async () => {
  const first = await generateTasks(process.cwd())
  assert.equal(first.length, 8)
  assert.deepEqual(await generateTasks(process.cwd()), first)
  assert.deepEqual(first, labTasks)
})

test("only successful test exit codes earn points", () => {
  assert.equal(passingRate([0, 1, null, 0]), 0.5)
  assert.equal(passingRate([]), 0)
})

test("replays accepted patches in order and reruns gates", async () => {
  const events: string[] = []
  await replayVerified(["one", "two"], async (patch) => { events.push(patch) }, async () => { events.push("gates") })
  assert.deepEqual(events, ["one", "two", "gates"])
  await assert.rejects(replayVerified(["one"], async () => { throw Error("conflict") }, async () => { assert.fail("gates after conflict") }))
  await assert.rejects(replayVerified(["one"], async () => {}, async () => { throw Error("merged gates failed") }), /merged gates failed/)
})

test("publication can only create a previously absent lab ref", async () => {
  const calls: readonly string[][] = []
  const git = async (args: string[]) => { (calls as string[][]).push(args); return "" }
  await publishLabBranch(git, "lab/evolve-2026-11-18", "a".repeat(40))
  assert.deepEqual(calls, [["update-ref", "refs/heads/lab/evolve-2026-11-18", "a".repeat(40), "0".repeat(40)]])
  await assert.rejects(publishLabBranch(git, "main", "a".repeat(40)))
  assert.equal(calls.length, 1)
})

test("a real Lab ref leaves main, HEAD and an existing Lab ref untouched", async () => {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), "lab-refs-"))
  const git = (args: string[]) => runGit(repository, ["-c", "user.name=Lab", "-c", "user.email=lab@localhost", "-c", "core.hooksPath=/dev/null", ...args])
  try {
    await git(["init", "-q", "-b", "main"])
    const tree = (await git(["write-tree"])).trim()
    const main = (await git(["commit-tree", tree, "-m", "base"])).trim()
    const lab = (await git(["commit-tree", tree, "-m", "fix", "-p", main])).trim()
    await git(["update-ref", "refs/heads/main", main])
    const branch = "lab/evolve-2026-11-18"
    await publishLabBranch(git, branch, lab)
    await assert.rejects(publishLabBranch(git, branch, main))
    assert.equal((await git(["rev-parse", "main"])).trim(), main)
    assert.equal((await git(["symbolic-ref", "--short", "HEAD"])).trim(), "main")
    assert.equal((await git(["rev-parse", branch])).trim(), lab)
    const worker = path.join(repository, "worker")
    await addWorktree(repository, ["--detach", worker, lab])
    assert.match(await git(["worktree", "list", "--porcelain"]), /worker/)
    await removeWorktree(repository, worker, true)
    await assert.rejects(fs.lstat(worker), { code: "ENOENT" })
    assert.doesNotMatch(await git(["worktree", "list", "--porcelain"]), /worker/)
  } finally {
    await fs.rm(repository, { recursive: true, force: true })
  }
})

test("sandbox fails closed on unsupported hosts", () => {
  assert.throws(() => sandboxCommand("win32", "/worker", "/deps", "git", ["push"]), /sandbox/i)
})

test("kernel sandbox denies push and kills descendants on abort", async (context) => {
  if (process.platform !== "linux" || process.env.MCODE_LAB_SANDBOX_TEST !== "1") {
    context.skip("requires a Linux host with usable bubblewrap")
    return
  }
  const { sandboxFixture } = await import("./fixtures/lab-sandbox")
  await sandboxFixture(runSandboxed)
})

test("Lab runs a historical repair and cleans up a cancelled fanout", { timeout: 240_000 }, async (context) => {
  if (process.platform !== "linux" || process.env.MCODE_LAB_SANDBOX_TEST !== "1") {
    context.skip("requires a Linux host with usable bubblewrap")
    return
  }
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "lab-run-"))
  const repository = path.join(fixture, "repo")
  const git = (args: string[]) => runGit(repository, args)
  const storage = new Storage(path.join(fixture, "storage"))
  let waitForAbort = true
  let inFanout = false
  const task = labTasks[0]
  const patch = await runGit(process.cwd(), ["diff", `${task.commit}^`, task.commit, "--", ...task.files])
  const lab = new Lab(storage, {
    fanoutControl: ({ signal }) => ({
      generate: async (items) => {
        inFanout = true
        if (waitForAbort) await delay(120_000, undefined, { signal })
        return items.map(({ name }) => ({ name, ok: true, text: patch, seconds: 0 }))
      },
    }),
  })
  const options = { set: LAB_TASK_SET, rounds: 1, concurrency: 2 }
  async function until(check: () => boolean | Promise<boolean>) {
    const deadline = Date.now() + 90_000
    while (!(await check())) {
      assert.ok(Date.now() < deadline, JSON.stringify((await lab.state()).current))
      await delay(50)
    }
  }
  try {
    await runGit(fixture, ["clone", "-q", "--shared", "--", process.cwd(), repository])
    await fs.symlink(await fs.realpath("node_modules"), path.join(repository, "node_modules"), "dir")
    const before = await git(["worktree", "list", "--porcelain"])
    const base = await git(["rev-parse", "HEAD"])
    await lab.start("fixture", repository, options)
    await until(() => inFanout)
    lab.stop()
    await until(async () => (await lab.state()).history.length === 1)
    assert.equal((await lab.state()).current?.status, "aborted")
    assert.equal(await git(["worktree", "list", "--porcelain"]), before)
    assert.equal(await git(["for-each-ref", "refs/heads/lab/"]), "")

    waitForAbort = false
    await lab.start("fixture", repository, options)
    await until(async () => (await lab.state()).history.length === 2)
    const { current } = await lab.state()
    assert.equal(current?.status, "finished", current?.error)
    assert.equal(current?.cards.filter(({ stage }) => stage === "accepted").length, 1)
    assert.match(current?.branch ?? "", /^lab\/evolve-/)
    assert.deepEqual(await lab.createPR(current!.id), { branch: current!.branch })
    assert.equal(await git(["rev-parse", "HEAD"]), base)
    assert.equal(await git(["worktree", "list", "--porcelain"]), before)
  } finally {
    await lab.close()
    await fs.rm(fixture, { recursive: true, force: true })
  }
})

test("desktop settings and request handlers expose all Lab actions", async () => {
  const read = (file: string) => fs.readFile(file, "utf8")
  const [settings, protocol, handlers] = await Promise.all([
    read("src/renderer/src/components/SettingsDialog.vue"),
    read("src/shared/protocol.ts"),
    read("src/server/handlers.ts"),
  ])
  assert.match(settings, /<LabEvolve\s*\/>/)
  for (const action of ["state", "start", "stop", "createPR"]) {
    assert.ok(protocol.includes(`type: "lab.${action}"`), action)
    assert.ok(handlers.includes(`case "lab.${action}"`), action)
  }
})
