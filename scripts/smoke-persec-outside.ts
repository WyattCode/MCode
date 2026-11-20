import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Bus } from "../src/server/bus"
import type { Config } from "../src/server/config"
import { PermissionDenied, Permissions } from "../src/server/permission"
import { resolvePath, truePath } from "../src/server/tool/fs-util"
import type { Check } from "./smoke-round5"

export async function persecOutside(check: Check): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "persec-outside-"))
  try {
    const directory = path.join(root, "project")
    const outside = path.join(root, "outside")
    await fs.mkdir(directory)
    await fs.mkdir(outside)
    const first = path.join(outside, "first")
    const second = path.join(outside, "second")
    const alias = path.join(directory, "alias")
    await fs.writeFile(first, "")
    await fs.writeFile(second, "")
    await fs.symlink(second, alias)
    const settings = { permissions: { outside: "ask" }, permissionRules: [] } as unknown as ReturnType<Config["get"]>
    const bus = new Bus()
    const permissions = new Permissions(bus, { get: () => settings } as Config)
    let questions = 0
    bus.subscribe((event) => {
      if (event.type !== "permission.requested") return
      questions++
      permissions.respond(event.request.id, "always")
    })
    const context = { directory, permissions, sessionID: "session", messageID: "message", callID: "read" } as Parameters<typeof resolvePath>[0]
    await resolvePath(context, first)
    await resolvePath(context, second)
    check("directory Always covers the second file without asking", questions === 1)
    settings.permissionRules = [{ action: "outside", resource: await truePath(second), effect: "deny" }]
    const result = await resolvePath(context, alias).catch((error: unknown) => error)
    check("exact outside deny on the real file wins over directory Always", result instanceof PermissionDenied && questions === 1)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}
