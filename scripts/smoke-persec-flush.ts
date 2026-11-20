import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Bus } from "../src/server/bus"
import type { Config } from "../src/server/config"
import { Permissions } from "../src/server/permission"
import { Storage } from "../src/server/storage"
import type { Check } from "./smoke-round5"

export async function persecFlush(check: Check): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "persec-flush-"))
  try {
    const storage = new Storage(root)
    const bus = new Bus()
    const gate = new Permissions(bus, { get: () => ({ permissions: { webfetch: "ask" } }) } as Config)
    await gate.load(storage)
    const write = storage.write.bind(storage)
    const failure = new Error("injected rules write failure")
    let fail = true
    let key = ""
    storage.write = async (name, value) => {
      key = name
      if (fail) throw failure
      await write(name, value)
    }
    let reply: Promise<void> | undefined
    bus.subscribe((event) => {
      if (event.type === "permission.requested") reply = gate.respond(event.request.id, "always")
    })
    const grant = (sessionID: string) => gate.ask({
      sessionID, messageID: "message", callID: sessionID, kind: "webfetch", title: "Fetch", subject: "https://example.com",
    })
    await grant("first")
    const failed = gate.flush()
    check("flush reports the original write failure", await failed.catch((error: unknown) => error) === failure)
    check("Always response reports its own write failure", await reply?.catch((error: unknown) => error) === failure)
    fail = false
    await grant("second")
    await gate.flush()
    const read = async () => (await storage.read<{ projects: Record<string, unknown> }>(key))!.projects
    check("later write retries uncommitted grants", Object.keys(await read()).sort().join() === "session:first,session:second")
    const before = await read()
    await gate.forgetSession("second")
    await write(key, { schemaVersion: 1, projects: { "session:second": before["session:second"] } })
    await grant("third")
    await gate.flush()
    check("committed additions and deletions are never replayed", Object.keys(await read()).sort().join() === "session:second,session:third")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}
