/**
 * Round 9: every setting, from its row to its effect, against MiMo's.
 *
 * Kept apart from smoke.ts the way the earlier rounds are; smoke.ts calls
 * `roundNineSettingsChecks` with its own check and section. Stored documents
 * are written out by hand and loaded through the real store, and the source
 * checks name the rows and readers that must be gone, so bringing one back
 * fails here rather than agreeing with itself.
 */
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { Storage } from "../src/server/storage"
import { Config } from "../src/server/config"
import { Bus } from "../src/server/bus"
import { belowFullMap, defaultAccess } from "../src/shared/access"

const ROOT = process.cwd()
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8")

const scratch: string[] = []

/** A config loaded through the real store from a document written by hand. */
async function loaded(stored: Record<string, unknown> | undefined): Promise<{ config: Config; disk: () => Promise<Record<string, unknown>>; dir: string }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mcode-r9s-"))
  scratch.push(dir)
  const store = new Storage(dir)
  if (stored) await store.write("config", stored)
  const config = new Config(store, new Bus(), path.join(dir, "credentials.json"))
  await config.load()
  return { config, dir, disk: async () => JSON.parse(await fsp.readFile(store.fileOf("config"), "utf8")) }
}

const ALL_ALLOW = { read: "allow", edit: "allow", write: "allow", glob: "allow", grep: "allow", list: "allow", bash: "allow", webfetch: "allow", outside: "allow", mcp: "allow" }
const DEFAULTS = { read: "allow", edit: "ask", write: "ask", glob: "allow", grep: "allow", list: "allow", bash: "ask", webfetch: "ask", outside: "ask", mcp: "ask" }

export async function roundNineSettingsChecks(check: Check, section: (name: string) => void): Promise<void> {
  try {
    await settingsChecks(check, section)
  } finally {
    for (const dir of scratch.splice(0)) await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function settingsChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 9 (S9-1): the rows R25 removed no longer steer anything")
  {
    const old = await loaded({
      notifyAgent: false,
      notifyPermission: false,
      soundPermission: true,
      soundError: true,
      pinchZoom: true,
      expandShell: true,
      expandEdits: true,
      permissions: { ...DEFAULTS, bash: "deny", edit: "allow", webfetch: "deny" },
      accessBefore: { bash: "allow" },
      migrations: ["theme-mcode-2", "keybind-ids-r3", "keybind-chords-r4", "chime-r5", "keybind-retired-r5", "full-access-switch-r5", "import-prompt-r6"],
    })
    const got = old.config.get() as unknown as Record<string, unknown>
    const retired = ["notifyAgent", "notifyPermission", "soundPermission", "soundError", "pinchZoom", "expandShell", "expandEdits"]
    check("the seven retired fields are gone from the loaded settings", retired.every((field) => !(field in got)), retired.filter((field) => field in got))
    const disk = await old.disk()
    check("and from the document on disk", retired.every((field) => !(field in disk)), retired.filter((field) => field in disk))
    check("a stored deny and allow go back to the defaults at the default level", JSON.stringify(old.config.get().permissions) === JSON.stringify(DEFAULTS), old.config.get().permissions)
    check("so no bucket is refused below full access any more", Object.values(belowFullMap(old.config.get())).every((action) => action !== "deny"))
    check("the set-aside map goes too", old.config.get().accessBefore === undefined && !("accessBefore" in disk))
    check("the migration is recorded", (old.config.get().migrations ?? []).includes("orphans-r9"))

    const full = await loaded({
      permissions: { ...ALL_ALLOW, bash: "deny" },
      accessBefore: { ...DEFAULTS, edit: "allow" },
      accessLevel: "full",
      allowFullAccess: true,
    })
    check("a profile at full access stays at full access", defaultAccess(full.config.get()) === "full", full.config.get().permissions)
    check("with every bucket allowed, its old refusal included", JSON.stringify(full.config.get().permissions) === JSON.stringify(ALL_ALLOW))
    check("and turning it back down lands on the defaults", full.config.get().accessBefore === undefined)

    const auto = await loaded({ permissions: { ...DEFAULTS, grep: "deny" }, accessLevel: "auto", allowFullAccess: false })
    check("the middle level and the switch are the user's and stay", auto.config.get().accessLevel === "auto" && auto.config.get().allowFullAccess === false)
    check("under it the map is the defaults", JSON.stringify(auto.config.get().permissions) === JSON.stringify(DEFAULTS))

    const again = await loaded({ permissions: { ...DEFAULTS, bash: "allow" }, migrations: ["orphans-r9"] })
    check("once migrated, a later map is left alone", again.config.get().permissions.bash === "allow")
    const late = await loaded({ pinchZoom: true, migrations: ["orphans-r9"] })
    check("a retired field written by hand later is still dropped on load", !("pinchZoom" in (late.config.get() as object)) && !("pinchZoom" in (await late.disk())))

    const app = read("src/renderer/src/App.vue")
    check("the window no longer zooms on Ctrl+wheel", !/addEventListener\(\s*"wheel"/.test(app) && !app.includes("pinchZoom"))
    check("notifications have no switch", !/notifyAgent|notifyPermission/.test(app))
    check("and a permission request or failure makes no sound", !/soundPermission|soundError|\bplay\(/.test(app) && !read("src/renderer/src/lib/sound.ts").includes("export function play"))
    check("tool rows always start closed", !/expandShell|expandEdits/.test(read("src/renderer/src/components/parts/ToolPart.vue")))
    const protocol = read("src/shared/protocol.ts")
    check("and the protocol no longer declares the fields", retired.every((field) => !new RegExp(`^\\s*${field}\\??:`, "m").test(protocol)))
  }

  section("Round 9 (S9-2): no model stays hidden by a curation list")
  {
    const old = await loaded({ enabledModels: ["anthropic/claude-opus-5"] })
    check("a stored curation list is dropped on load", !("enabledModels" in (old.config.get() as object)) && !("enabledModels" in (await old.disk())))
    const readers = ["src/renderer/src/App.vue", "src/renderer/src/components/Composer.vue", "src/server/handlers.ts", "src/server/config.ts", "src/shared/protocol.ts"]
    const still = readers.filter((file) => read(file).replace(/"enabledModels",/, "").includes("enabledModels"))
    check("the picker, the tray list and the provider handlers no longer read or write it", still.length === 0, still)
    check("and nothing keeps a list of selectable models up to date", !read("src/server/handlers.ts").includes("keepModelsSelectable"))
  }
}
