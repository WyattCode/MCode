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
import { stepTarget, visibleChatOrder } from "../src/renderer/src/lib/visible-chats"

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

  section("Round 9 (S9-3): Ctrl+1-9 and Ctrl+Shift+[ / ] count along the side column, pinned first")
  {
    const rows = [
      { id: "old", updated: 1, title: "Zeta" },
      { id: "new", updated: 5, title: "Alpha" },
      { id: "mid", updated: 3, title: "Mu" },
      { id: "gone", updated: 9, title: "Beta", archived: true },
      { id: "pin2", updated: 2, title: "Pinned two" },
      { id: "pin1", updated: 0, title: "Pinned one" },
    ]
    const name = (row: { title: string }) => row.title
    const recent = visibleChatOrder(rows, ["pin1", "missing", "pin2", "pin1"], "recent", name, "en")
    check("pinned in pin order, then the rest newest first, archived left out", recent.join() === "pin1,pin2,new,mid,old", recent)
    const byName = visibleChatOrder(rows, ["pin2"], "name", name, "en")
    check("sorted by name, the rest follow the names", byName.join() === "pin2,new,mid,pin1,old", byName)
    check("an archived pin is not a slot", visibleChatOrder(rows, ["gone"], "recent", name, "en")[0] === "new")

    check("next from the middle moves one along", stepTarget(["a", "b", "c"], "b", 1) === "c")
    check("and wraps at both ends", stepTarget(["a", "b", "c"], "c", 1) === "a" && stepTarget(["a", "b", "c"], "a", -1) === "c")
    check("from outside the list, next is the first and previous the last", stepTarget(["a", "b"], "x", 1) === "a" && stepTarget(["a", "b"], undefined, -1) === "b")
    check("a list of one goes nowhere, an empty one neither", stepTarget(["a"], "a", 1) === undefined && stepTarget([], undefined, 1) === undefined)

    const app = read("src/renderer/src/App.vue")
    const store = read("src/renderer/src/stores/app.ts")
    check("the digits read the visible order", /app\.visibleChats\[Number\(event\.key\) - 1\]/.test(app) && /app\.visibleChats\[index\]/.test(app))
    check("and so do the brackets and the unread steps", /stepTarget\(app\.visibleChats/.test(app) && /const chats = app\.visibleChats/.test(app))
    check("the store orders them with the side column's own sort", /visibleChatOrder\(\s*sessions\.value,\s*config\.value\?\.pinnedTabs/.test(store) && /recentSort\.value/.test(store))
    check("and the side column's sort menu writes that same order", /app\.recentSort = mode/.test(read("src/renderer/src/components/Sidebar.vue")))
    check("the hidden tab list, its config writes and reopen-tab are gone", !/\btabs = ref|openTabs|closedTabs|reopenTab|function track\(/.test(store) && !/app\.tabs\b|session\.reopenTab/.test(app))
    const old = await loaded({ openTabs: ["a", "b"] })
    check("a stored tab list is dropped on load", !("openTabs" in (old.config.get() as object)) && !("openTabs" in (await old.disk())))
  }

  section("Round 9 (S9-4): the title model is a config-file key, with no row")
  {
    const dialog = read("src/renderer/src/components/SettingsDialog.vue")
    check("the settings draw no title model row", !/titleModel|data-title-model-row|set\.titleModel/.test(dialog))
    check("its three strings are gone from every table", !/"set\.titleModel/.test(read("src/renderer/src/lib/i18n.ts")))
    check("while the engine still reads the key", /this\.config\.get\(\)\.titleModel/.test(read("src/server/session/runner.ts")))
    const kept = await loaded({ titleModel: { provider: "p", model: "small" } })
    check("and a stored choice is kept", kept.config.get().titleModel?.model === "small")
  }

  section("Round 9 (S9-5): no typeface boxes, and stored faces are cleared at start-up")
  {
    const faces = ["uiFont", "codeFont", "terminalFont"]
    const dialog = read("src/renderer/src/components/SettingsDialog.vue")
    check("the appearance page draws no font rows", !/app\.config\?\.(uiFont|codeFont|terminalFont)\b|set\.(uiFont|terminalFont)Sub|FONT_SANS_DEFAULT/.test(dialog))
    check("and the window sets no inline face", !/uiFont\b|codeFont\b|terminalFont|--font-sans"|--font-terminal"/.test(read("src/renderer/src/App.vue")))
    const old = await loaded({ uiFont: "Comic Sans MS", codeFont: "Courier", terminalFont: "Fira Code", uiFontSize: 16 })
    const disk = await old.disk()
    check("stored faces are dropped when the settings load", faces.every((field) => !(field in (old.config.get() as object)) && !(field in disk)))
    check("while the sizes, which MiMo has, stay", old.config.get().uiFontSize === 16)
    check("and the protocol no longer declares them", faces.every((field) => !new RegExp(`^\\s*${field}\\??:`, "m").test(read("src/shared/protocol.ts"))))
  }

  section("Round 9 (S9-6): only MiMo's scheme choice - no palettes, no palette commands")
  {
    const app = read("src/renderer/src/App.vue")
    const dialog = read("src/renderer/src/components/SettingsDialog.vue")
    check("the appearance page has no palette row", !/data-palette-row|paletteOptions|set\.paletteName/.test(dialog))
    check("the theme row offers exactly follow system, light and dark", /themeFollow[\s\S]{0,120}themeLight[\s\S]{0,120}themeDark/.test(dialog))
    check("the window paints no palette over the stylesheet", !/themeTokens|THEMES|setProperty\(name, value\)/.test(app))
    check("and has no palette commands", !/theme\.cycle"|`theme\.\$\{|cycleTheme|setTheme\(/.test(app))
    check("while the caption buttons still follow the scheme", /watch\(darkScheme, \(dark\) => window\.mcode\.titlebarMode/.test(app))
    const palettes = read("src/renderer/src/lib/theme-palettes.ts")
    check("one palette is left, MCode 2.0", (palettes.match(/"id":/g) ?? []).length === 1 && palettes.includes('"id": "mcode-2"'))
    const old = await loaded({ themeID: "dracula", theme: "light" })
    check("a stored palette is dropped and the scheme kept", !("themeID" in (old.config.get() as object)) && !("themeID" in (await old.disk())) && old.config.get().theme === "light")
    check("and no migration moves palettes any more", !read("src/server/config.ts").includes("theme-mcode-2"))
  }

  section("Round 9 (S9-7): no post-update notes window")
  {
    const app = read("src/renderer/src/App.vue")
    const gone = ["src/renderer/src/components/ReleaseNotesDialog.vue", "src/renderer/src/lib/changelog.ts", "src/renderer/src/lib/changelog.json"]
    check("the window, its changelog and its reader are deleted", gone.every((file) => !fs.existsSync(path.join(ROOT, file))), gone.filter((file) => fs.existsSync(path.join(ROOT, file))))
    check("the window opens nothing after an update", !/ReleaseNotes|releaseNotes|loadReleaseHighlights|SEEN_VERSION_KEY/.test(app))
    check("and the version it remembered is cleared", /localStorage\.removeItem\("mcode\.highlights\.v1"\)/.test(app))
    check("its strings are gone", !/"rel\./.test(read("src/renderer/src/lib/i18n.ts")))
    const old = await loaded({ releaseNotes: false })
    check("a stored switch is dropped", !("releaseNotes" in (old.config.get() as object)) && !("releaseNotes" in (await old.disk())))
  }

  section("Round 9 (S9-8): no commands that change settings from a hand-written chord")
  {
    const app = read("src/renderer/src/App.vue")
    const ids = ['"permissions.autoaccept"', "`agent.${entry}`", "`scheme.${entry}`", "`language.${entry.id}`", '"language.cycle"', '"theme.scheme.cycle"']
    const still = ids.filter((id) => app.includes(`id: ${id}`))
    check("the six families are gone from the command table", still.length === 0, still)
    check("and so are the helpers only they used", !/function (cycleScheme|cycleLanguage|setLanguage|toggleAutoAccept|autoAcceptAll)\b/.test(app))
    check("the agent cycle, which changes the conversation, stays", /id: "agent\.cycle"/.test(app))
    const tables = read("src/renderer/src/lib/i18n.ts")
    check("their unlocked strings are gone", !/"(cmd\.useAgent|cmd\.useLanguage|cmd\.useScheme|cmd\.cycleScheme|toast\.switchedTo)"/.test(tables))
  }

  section("Round 9 (S9-9): the dead terminal-toggle field is gone, and the wiring check counts only reads")
  {
    check("the protocol has no showTerminal", !/^\s*showTerminal\??:/m.test(read("src/shared/protocol.ts")))
    const old = await loaded({ showTerminal: false })
    check("a stored one is dropped", !("showTerminal" in (old.config.get() as object)) && !("showTerminal" in (await old.disk())))
    const wiring = read("scripts/wiring-check.ts")
    check("the wiring check blanks dotted string keys before looking", wiring.includes("readers.replace(keyLike") && !/new RegExp\(WORD \+ field \+ WORD\)/.test(wiring))
  }

  section("Round 9 (S9-12, S9-13): the environment name notice, and no list of remembered approvals")
  {
    const dialog = read("src/renderer/src/components/SettingsDialog.vue")
    check("a name another project has is an ordinary notice, as MiMo words it", /\bnotify\(t\("set\.envSavedNameTaken"/.test(dialog) && !/notifyFailure\(t\("set\.envSavedNameTaken"/.test(dialog))
    check("and names stay where MCode keeps them, in the config", /patchConfig\(\{ projectNames:/.test(dialog) && !/\.mimo|env\.json/.test(dialog))
    check("the permissions section lists no remembered approvals", !/savedRules|forgetRule|permission\.rules|permission\.forget/.test(dialog))
    const protocol = read("src/shared/protocol.ts")
    check("and the backend offers no way to list or withdraw them", !/"permission\.rules"|"permission\.forget"|interface SavedRule/.test(protocol) && !/savedRules\(\)/.test(read("src/server/permission.ts")))
    check("while a deleted conversation still takes its own with it", /permissions\.forgetSession\(request\.sessionID\)/.test(read("src/server/handlers.ts")))
  }
}
