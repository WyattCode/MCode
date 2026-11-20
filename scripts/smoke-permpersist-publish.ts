import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Bus } from "../src/server/bus"
import { Config } from "../src/server/config"
import { Permissions } from "../src/server/permission"
import { Storage } from "../src/server/storage"
import type { Check } from "./smoke-round5"

export async function permpersistPublish(check: Check): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "permpersist-publish-"))
  try {
    const storage = new Storage(root)
    const bus = new Bus()
    const config = new Config(storage, bus, path.join(root, "credentials.json"))
    await config.load()
    await config.set({ permissions: { ...config.get().permissions, webfetch: "ask" } })
    const gate = new Permissions(bus, config)
    const writeText = storage.writeText.bind(storage)
    let updates = 0
    bus.subscribe((event) => {
      if (event.type === "config.updated") updates++
    })
    for (const fail of [true, false]) {
      const previous = config.get()
      const previousUpdates = updates
      let entered!: () => void
      let resume!: () => void
      const started = new Promise<void>((resolve) => { entered = resolve })
      const pending = new Promise<void>((resolve) => { resume = resolve })
      const failure = new Error("injected config write failure")
      storage.writeText = async (key, render) => {
        entered()
        await pending
        if (fail) throw failure
        await writeText(key, render)
      }
      const saved = config.update(() => ({ permissions: { ...previous.permissions, webfetch: "allow" } }))
        .then(() => undefined, (error: unknown) => error)
      await started
      const hidden = config.get() === previous && gate.action("webfetch", "ask") === "ask" && updates === previousUpdates
      resume()
      const result = await saved
      check(`pending ${fail ? "failed" : "successful"} write leaves old approval policy visible`, hidden)
      check(fail ? "failed write keeps old policy and emits no update" : "successful write publishes persisted approval policy",
        fail
          ? result === failure && config.get() === previous && updates === previousUpdates
          : result === undefined && gate.action("webfetch", "ask") === "allow" && updates === previousUpdates + 1 &&
            (await storage.read<ReturnType<Config["get"]>>("config"))?.permissions.webfetch === "allow")
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}
