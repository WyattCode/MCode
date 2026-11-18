import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pageRows, changeShortcut, bindingConflict, recordShortcutKey } from "../src/renderer/src/lib/shortcut-page"
import { pageKeyAction } from "../src/shared/browser-page"
import { boundShortcut, shortcutDispatch } from "../src/shared/chord"
import { menuAccelerator } from "../src/main/menu-keys"
import { Config } from "../src/server/config"
import { Bus } from "../src/server/bus"
import { Storage } from "../src/server/storage"
import type { Check } from "./smoke-round5"

export async function shortcutChecks(check: Check): Promise<void> {
  const commands = [
    { id: "session.new", title: "New", hint: "Ctrl+N" },
    { id: "zoom.in", title: "Zoom In", hint: "Ctrl+=" },
  ]
  const [command] = commands
  const rows = pageRows(commands, (key) => key)
  check("keyboard shortcuts include the whole command registry", rows.map(({ id }) => id).join() === "session.new,zoom.in")
  const settings = await fs.readFile("src/renderer/src/components/SettingsDialog.vue", "utf8")
  check("keyboard shortcuts show an explicit unassigned label", /v-else[^>]*data-binding-unassigned[^>]*>[^\n]*set\.keys\.unassigned/.test(settings))
  check("renderer and menu fall back to the default", boundShortcut(command, {}) === "Ctrl+N" &&
    menuAccelerator("newTask", { binds: {}, recording: false }, "darwin") === "CmdOrCtrl+N")

  const dispatch = shortcutDispatch(commands, { "session.new": "Ctrl+J", "zoom.in": "" })
  check("dispatch uses the rebound key and releases the old default and deleted aliases",
    dispatch.get("Ctrl+J") === command && !dispatch.has("Ctrl+N") && !dispatch.has("Ctrl+=") && !dispatch.has("Ctrl+Shift+="))
  check("quit uses its configured menu shortcut",
    menuAccelerator("quit", { binds: { "app.quit": "" }, recording: false }, "darwin") === undefined &&
    menuAccelerator("quit", { binds: { "app.quit": "Alt+Q" }, recording: false }, "darwin") === "Alt+Q")
  const pageKey = { type: "keyDown", key: "r", code: "KeyR", control: true, shift: false, alt: false, meta: false }
  check("browser uses the current binding for reload and ignores its deleted default",
    pageKeyAction(pageKey, new Map([["Ctrl+R", "browser.reload"]])).kind === "reload" &&
    pageKeyAction(pageKey, new Map([["Ctrl+R", "session.new"]])).kind === "forward" &&
    pageKeyAction(pageKey, new Map()).kind === "none")

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shortcuts-"))
  try {
    const open = async () => {
      const config = new Config(new Storage(dir), new Bus(), path.join(dir, "credentials.json"))
      await config.load()
      return config
    }
    let config = await open()
    const save = async (binds: Record<string, string>) => { await config.set({ keybinds: binds }) }
    const bindings = () => config.get().keybinds
    check("a recorded chord occupied by another command is refused", bindingConflict(commands, bindings(), command.id, "Ctrl+=")?.id === "zoom.in" &&
      !changeShortcut(commands, bindings(), command.id, "Ctrl+="))
    const key = (name: string, fields: Partial<KeyboardEvent> = {}) => ({ key: name, code: name, ...fields } as KeyboardEvent)
    const recorded = recordShortcutKey(key("J", { code: "KeyJ", ctrlKey: true, shiftKey: true }), "win32")
    const draft = "Ctrl+Shift+J"
    check("recording translates the physical key to a chord", recorded?.action === "record" && recorded.chord === draft)
    check("Enter confirms, Esc cancels and IME Enter stays with the input method",
      recordShortcutKey(key("Enter"), "win32")?.action === "confirm" &&
      recordShortcutKey(key("Escape"), "win32")?.action === "cancel" &&
      recordShortcutKey(key("Enter", { isComposing: true }), "win32") === undefined)
    check("recording alone leaves the stored binding intact", boundShortcut(command, bindings()) === "Ctrl+N")
    if (recorded?.action !== "record") throw new Error("recording failed")
    await save(changeShortcut(commands, bindings(), command.id, recorded.chord)!)
    config = await open()
    check("confirm persists the recorded chord across reload", config.get().keybindsVersion === 1 && boundShortcut(command, bindings()) === draft &&
      menuAccelerator("newTask", { binds: bindings(), recording: false }, "darwin") === "CmdOrCtrl+Shift+J")
    await save(changeShortcut(commands, bindings(), command.id, "")!)
    check("deletion suppresses the default", boundShortcut(command, bindings()) === "" &&
      menuAccelerator("newTask", { binds: bindings(), recording: false }, "darwin") === undefined)
    await save(changeShortcut(commands, bindings(), command.id)!)
    check("reset one restores its default", boundShortcut(command, bindings()) === "Ctrl+N")
    await save({ "session.new": "", "zoom.in": "" })
    await save({})
    config = await open()
    check("reset all restores all defaults across reload", commands.every((entry) => boundShortcut(entry, bindings()) === entry.hint))
    await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ keybindsVersion: 99, keybinds: { "session.new": "Ctrl+J" } }))
    config = await open()
    check("unsupported shortcut file version restores defaults and reports the failure", config.keybindsUnreadable && boundShortcut(command, bindings()) === "Ctrl+N")
    await save({ "session.new": draft })
    await fs.writeFile(path.join(dir, "config.json"), "{")
    await config.reloadFromDisk()
    check("a config that becomes unreadable at runtime also restores default shortcuts", config.keybindsUnreadable && boundShortcut(command, bindings()) === "Ctrl+N")
    await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ keybinds: { "session.new": "Ctrl+J" } }))
    await config.reloadFromDisk()
    check("an unversioned profile is accepted and clears the read error", !config.keybindsUnreadable && boundShortcut(command, bindings()) === "Ctrl+J")
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}
