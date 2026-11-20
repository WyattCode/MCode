import assert from "node:assert/strict"
import { fixture, smoke, until } from "./smoke-runlife-ownership"

const cases: { name: string; run: () => Promise<void> }[] = []
function register(name: string, run: () => Promise<void>): void { cases.push({ name, run }) }

register("claim write failure reaches the error path before the model runs", () => fixture(async (f) => {
  const update = f.store.update.bind(f.store)
  f.store.update = async (id, patch) => {
    if (patch.claim) throw new Error("claim write failed")
    return update(id, patch)
  }
  await f.prompt("write failure")
  const done = f.completion()
  await until(() => f.calls.length > 0 || f.events.some((event) => event.type === "session.error"))
  f.calls[0]?.open()
  await done
  assert.equal(f.calls.length, 0, "model ran without a durable claim")
  assert.ok(f.events.some((event) => event.type === "session.error" && event.error.includes("claim write failed")))
}))

register("stopped completion preserves the replacement claim", () => fixture(async (f) => {
  await f.prompt("old")
  const oldDone = f.completion()
  await until(() => f.calls.length === 1)
  const oldClaim = (await f.store.require(f.session.id)).claim
  f.stop()
  await f.prompt("new")
  const newDone = f.completion()
  await until(() => f.calls.length === 2)
  const replacement = (await f.store.require(f.session.id)).claim
  f.calls[0].open()
  await oldDone
  const remaining = (await f.store.require(f.session.id)).claim
  f.calls[1].open()
  await newDone
  assert.ok(replacement)
  assert.deepEqual(remaining, replacement)
  assert.notDeepEqual(replacement, oldClaim)
  assert.equal((await f.store.require(f.session.id)).claim, undefined)
}))

register("claim cleanup failure is observable and still releases the controller", () => fixture(async (f) => {
  const update = f.store.update.bind(f.store)
  f.store.update = async (id, patch) => {
    if (Object.hasOwn(patch, "claim") && !patch.claim) throw new Error("claim cleanup failed")
    return update(id, patch)
  }
  await f.prompt("cleanup failure")
  const done = f.completion()
  await until(() => f.calls.length === 1)
  f.calls[0].open()
  await done
  assert.deepEqual(f.runner.busySessions(), [])
  assert.ok(f.events.some((event) => event.type === "session.error" && event.error.includes("claim cleanup failed")),
    "claim cleanup error was swallowed")
}))

export async function runlifeClaimChecks(check: (label: string, ok: boolean, detail?: unknown) => void): Promise<void> {
  for (const { name, run } of cases) {
    try { await run(); check(name, true) } catch (err) { check(name, false, err instanceof Error ? err.message : String(err)) }
  }
}

/* Standalone entry: the battery drives `runlifeClaimChecks` instead, so the count is never left to an argv match.
 * The basename is compared exactly because the battery builds this file as `rounds-smoke-runlife-claim.mjs`. */
const entry = process.argv[1]?.split("/").pop()
if (entry === "smoke-runlife-claim.ts" || entry === "smoke-runlife-claim.mjs") {
  void (async () => {
    for (const { name, run } of cases) await smoke(name, run)
  })()
}
