import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { Bus } from "../src/server/bus"
import { Config } from "../src/server/config"
import { handle } from "../src/server/handlers"
import type { Runtime } from "../src/server"
import { SessionStore } from "../src/server/session/store"
import { Storage } from "../src/server/storage"
import { belowFullMap, sessionAccess } from "../src/shared/access"
import { DEFAULT_PERMISSIONS, PERMISSION_KINDS, type AppConfig } from "../src/shared/protocol"
import type { Check } from "./smoke-round5"

export async function permpersistEpoch(check: Check): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "permpersist-epoch-"))
  try {
    const storage = new Storage(root)
    const bus = new Bus()
    const config = new Config(storage, bus, path.join(root, "credentials.json"))
    await config.load()
    const sessions = new SessionStore(storage, bus, () => config.get().accessEpoch)
    const runtime = { config, sessions } as Runtime
    const kept = { ...DEFAULT_PERMISSIONS, edit: "allow", bash: "ask", webfetch: "deny" } as const
    const full = Object.fromEntries(PERMISSION_KINDS.map((kind) => [kind, kept[kind] === "deny" ? "deny" : "allow"])) as AppConfig["permissions"]
    const set = (patch: Partial<AppConfig>) => handle(runtime, { type: "config.set", patch })
    await set({ allowFullAccess: true, accessLevel: "full", permissions: full, accessBefore: kept })
    let updates = 0
    bus.subscribe((event) => {
      if (event.type === "config.updated") updates++
    })
    await set({ allowFullAccess: false })
    check("boolean-only disable restores saved answers and clears the backup in one publish",
      isDeepStrictEqual(belowFullMap(config.get()), kept) && !Object.keys(config.get().accessBefore ?? {}).length &&
      config.get().accessLevel === "ask" && updates === 1)

    await set({ allowFullAccess: true, accessLevel: "full", permissions: full, accessBefore: kept })
    await set({ allowFullAccess: false, accessLevel: "ask", permissions: kept, accessBefore: {} })
    check("complete UI disable patch still restores the saved answers",
      isDeepStrictEqual(belowFullMap(config.get()), kept) && !Object.keys(config.get().accessBefore ?? {}).length)

    await set({ allowFullAccess: true })
    const session = await sessions.create({ directory: root, model: { provider: "anthropic", model: "test" } })
    const request = { type: "session.access", sessionID: session.id, access: "full" } as const
    await handle(runtime, request)
    check("fresh full grant works", sessionAccess((await sessions.get(session.id))?.access, config.get()) === "full")
    sessions.dropFullAccess = async () => { throw new Error("injected session cleanup failure") }
    await set({ allowFullAccess: false }).catch(() => undefined)

    const reopened = new Config(new Storage(root), new Bus(), path.join(root, "credentials.json"))
    await reopened.load()
    const reopenedSessions = new SessionStore(new Storage(root), new Bus(), () => reopened.get().accessEpoch)
    const reopenedRuntime = { config: reopened, sessions: reopenedSessions } as Runtime
    await handle(reopenedRuntime, { type: "config.set", patch: { allowFullAccess: true } })
    check("old session grant stays revoked after failed cleanup, restart and re-enable",
      sessionAccess((await reopenedSessions.get(session.id))?.access, reopened.get()) === "ask")
    await handle(reopenedRuntime, request)
    check("new session grant works after re-enable",
      sessionAccess((await reopenedSessions.get(session.id))?.access, reopened.get()) === "full")

    const configFile = storage.fileOf("config")
    await fs.writeFile(configFile, JSON.stringify({ ...reopened.get(), allowFullAccess: false }))
    await reopened.reloadFromDisk()
    const disabled = await storage.read<AppConfig>("config")
    check("config reload persists the disabled switch and advances the epoch together",
      disabled?.allowFullAccess === false && disabled.accessEpoch === reopened.get().accessEpoch &&
      disabled.accessEpoch !== (await storage.read<{ accessEpoch?: number }>(`session/${session.id}/info`))?.accessEpoch)
    const afterEdit = new Config(new Storage(root), new Bus(), path.join(root, "credentials.json"))
    await afterEdit.load()
    await afterEdit.set({ allowFullAccess: true })
    check("hand-edited disable revokes the old session grant across restart and re-enable",
      sessionAccess(await new SessionStore(storage, bus).get(session.id), afterEdit.get()) === "ask")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}
