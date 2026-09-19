/**
 * Round 12, lane D: the main process's IPC contract and its small-file writes
 * (D12-1 onwards). Kept apart from smoke.ts the way the earlier rounds are;
 * smoke.ts calls `roundTwelveIpcChecks` with its own check and section.
 *
 * The handlers themselves need Electron, so what they decide is kept in plain
 * functions and held here; where the check is that a handler uses one of them
 * at all, the source is read.
 */
import syncFs from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { guarded } from "../src/main/office-guard"
import { writeAtomicSync } from "../src/main/atomic-write"
import { BOOT_PREFS_FILE, readBootPrefs, writeBootPrefs } from "../src/main/boot-prefs"
import { DISPLAY_SERVER_FILE, readDisplayServerFile } from "../src/main/display-server"
import { label, setLabels } from "../src/main/labels"
import { BROWSER_ACTS, EDIT_ACTIONS, VIEW_ACTIONS, WINDOW_ACTIONS, actionOf, clipboardText, directoryAsk, panelBounds, titlebarMode } from "../src/main/ipc-input"

export async function roundTwelveIpcChecks(check: Check, section: (name: string) => void): Promise<void> {
  const read = (file: string) => fs.readFile(path.join(process.cwd(), file), "utf8")
  const mainSource = await read("src/main/index.ts")
  const preloadSource = await read("src/preload/index.ts")
  /** The body of one `ipcMain.on/handle("<channel>", ...)` registration, up to the next one. */
  const handlerOf = (channel: string) => {
    const start = mainSource.indexOf(`"${channel}"`)
    if (start < 0) return ""
    const next = mainSource.slice(start + channel.length + 2).search(/ipcMain\.(on|handle)\(/)
    return next < 0 ? mainSource.slice(start) : mainSource.slice(start, start + channel.length + 2 + next)
  }

  section("Round 12 (D12-1): the dead browserClose bridge is gone")
  {
    check("the preload no longer exposes browserClose", !/\bbrowserClose\b/.test(preloadSource))
    check("main no longer answers mcode:browser-close", !mainSource.includes('"mcode:browser-close"'))
  }

  section("Round 12 (D12-2): the window's label table is checked before main holds it")
  {
    // A throw is counted as a failure here rather than ending the run.
    const take = (raw: unknown): boolean | "threw" => {
      try {
        return setLabels(raw)
      } catch {
        return "threw"
      }
    }
    check("a plain object is taken", take({ "menu.file": "文件", "menu.edit": 5 }) === true)
    check("its string values are kept", label("menu.file", "File") === "文件")
    check("a value that is not a string is dropped, so the English fallback shows", label("menu.edit", "Edit") === "Edit")
    for (const bad of [null, undefined, "zh", 7, ["文件"]]) {
      check(`${JSON.stringify(bad) ?? "undefined"} is refused`, take(bad) === false)
    }
    check("after every refusal the previous table still answers", label("menu.file", "File") === "文件")
    let threw = false
    try {
      label("anything", "fallback")
    } catch {
      threw = true
    }
    check("label() does not throw after a bad message", !threw)
    check("the handler stops at a refused table rather than rebuilding the menu", /"mcode:menu-labels"[^]{0,120}if \(!setLabels\(next\)\) return/.test(mainSource))
    setLabels({})
  }

  section("Round 12 (D12-3): fire-and-forget channels read their value before using it")
  {
    check("clipboard text passes as it is", clipboardText("héllo") === "héllo" && clipboardText("") === "")
    for (const bad of [undefined, null, 5, { toString: () => "x" }, ["a"]]) {
      check(`clipboard ${JSON.stringify(bad) ?? "undefined"} is dropped`, clipboardText(bad) === undefined)
    }
    const box = { x: 10.5, y: 0, width: 300, height: -1 }
    check("four finite sides pass", JSON.stringify(panelBounds(box)) === JSON.stringify(box))
    check("extra fields on the box are not carried", JSON.stringify(panelBounds({ ...box, extra: 1 })) === JSON.stringify(box))
    const badBoxes: unknown[] = [
      null,
      undefined,
      "box",
      42,
      { x: 1, y: 2, width: 3 },
      { x: Number.NaN, y: 0, width: 1, height: 1 },
      { x: 0, y: Number.POSITIVE_INFINITY, width: 1, height: 1 },
      { x: "1", y: 0, width: 1, height: 1 },
    ]
    for (const bad of badBoxes) check(`a panel box ${String(JSON.stringify(bad))} is dropped`, panelBounds(bad) === undefined)
    check("dark and light are the caption modes", titlebarMode("dark") === "dark" && titlebarMode("light") === "light")
    for (const bad of ["Dark", "system", "", null, 1]) check(`caption mode ${JSON.stringify(bad)} is dropped`, titlebarMode(bad) === undefined)

    check("mcode:clipboard-write writes only what clipboardText passes", /clipboardText\(raw\)[^]*if \(text !== undefined\) clipboard\.writeText\(text\)/.test(handlerOf("mcode:clipboard-write")))
    check("mcode:browser-bounds sets only a box panelBounds passes", /panelBounds\(raw\)[^]*if \(window && bounds\) setBounds/.test(handlerOf("mcode:browser-bounds")))
    check("mcode:browser-open opens only with a box panelBounds passes", /panelBounds\(raw\)[^]*if \(!window \|\| !bounds\) return/.test(handlerOf("mcode:browser-open")))
    check("mcode:titlebar-mode sets only a mode titlebarMode passes", /titlebarMode\(raw\)[^]*if \(mode\) setTitlebarMode/.test(handlerOf("mcode:titlebar-mode")))
  }

  section("Round 12 (D12-4): action channels do the named action or nothing")
  {
    const channels = [
      { channel: "mcode:edit", set: EDIT_ACTIONS, name: "EDIT_ACTIONS", bridge: "edit: (action" },
      { channel: "mcode:view", set: VIEW_ACTIONS, name: "VIEW_ACTIONS", bridge: "view: (action" },
      { channel: "mcode:window", set: WINDOW_ACTIONS, name: "WINDOW_ACTIONS", bridge: "window: (action" },
      { channel: "mcode:browser-act", set: BROWSER_ACTS, name: "BROWSER_ACTS", bridge: "browserAct: (what" },
    ] as const
    for (const { channel, set, name, bridge } of channels) {
      check(`${channel}: every known action passes`, set.every((action) => actionOf(set, action) === action))
      for (const bad of ["", "selectall", "maximise", "toggle", "__proto__", "toString", 1, null, undefined, ["reload"]]) {
        check(`${channel}: ${JSON.stringify(bad) ?? "undefined"} is no action`, actionOf(set, bad) === undefined)
      }
      // The preload's declared union and main's set are the same list.
      const at = preloadSource.indexOf(bridge)
      const union = at < 0 ? [] : [...preloadSource.slice(at, preloadSource.indexOf(")", at)).matchAll(/"([A-Za-z]+)"/g)].map((match) => match[1])
      check(`${channel}: main accepts exactly what the preload declares`, JSON.stringify([...union].sort()) === JSON.stringify([...set].sort()), union)
      const body = handlerOf(channel)
      check(`${channel}: the handler dispatches on actionOf(${name}, ...)`, body.includes(`actionOf(${name}, raw)`))
      check(`${channel}: no else-branch or default runs for an unknown action`, !/\belse\s+(?!if\b)|\bdefault\s*:/.test(body))
    }
  }

  section("Round 12 (D12-5): an Office check that throws answers the channel's refusal")
  {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-d12-5-"))
    try {
      const project = path.join(scratch, "project")
      await fs.mkdir(project, { recursive: true })
      const refused = { ok: false, reason: "denied" }
      let ran = 0
      const handler = () => {
        ran++
        return { ok: true }
      }
      const small = Buffer.from("PK").toString("base64")
      const failing = guarded("mcode:write-file-bytes", refused, async () => Promise.reject(new Error("backend is not ready")), handler)
      let answer: unknown
      try {
        answer = await failing({}, project, "report.docx", small)
      } catch (err) {
        answer = `rejected: ${(err as Error).message}`
      }
      check("a working-folder lookup that throws answers { ok:false, reason } instead of rejecting", answer === refused, answer)
      check("and the handler did not run", ran === 0)
      const working = guarded("mcode:write-file-bytes", refused, async () => [project], handler)
      check("the same call with the lookup answering runs the handler", JSON.stringify(await working({}, project, "report.docx", small)) === '{"ok":true}' && ran === 1)
      check("a call of the wrong shape still gets the refusal", (await working({}, project, "report.docx", 42)) === refused && ran === 1)
      const office = await read("src/main/office.ts")
      check("office.ts registers every channel through guarded()", /ipcMain\.handle\(channel, guarded\(channel, refused, roots, handler\)\)/.test(office))
    } finally {
      await fs.rm(scratch, { recursive: true, force: true })
    }
  }

  section("Round 12 (D12-6): the folder picker reads its title and flags strictly")
  {
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
    check("a string title and true flags pass", same(directoryAsk("Pick", true, true), { title: "Pick", multiple: true, project: true }))
    check("false and missing flags are off", same(directoryAsk("Pick", false, undefined), { title: "Pick", multiple: false, project: false }))
    check("truthy values that are not true are off", same(directoryAsk("Pick", 1, "yes"), { title: "Pick", multiple: false, project: false }))
    check("a title that is not text shows none", directoryAsk({ toString: () => "x" }, true, false).title === "" && directoryAsk(undefined, false, false).title === "")
    const body = handlerOf("mcode:pick-directory")
    check("mcode:pick-directory reads its arguments through directoryAsk", body.includes("directoryAsk(rawTitle, rawMultiple, rawProject)"))
  }

  section("Round 12 (D12-7): main's small settings files are replaced, never truncated")
  {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-d12-7-"))
    const realRename = syncFs.renameSync
    const realWrite = syncFs.writeFileSync
    try {
      const file = path.join(scratch, "nested", BOOT_PREFS_FILE)
      const off = writeBootPrefs({ theme: "dark", hardwareAcceleration: false })
      writeAtomicSync(file, off)
      check("the first write creates its folder and the file", syncFs.readFileSync(file, "utf8") === off)
      const strays = () => syncFs.readdirSync(path.dirname(file)).filter((name) => name !== BOOT_PREFS_FILE)
      check("a finished write leaves no temp file beside it", strays().length === 0, strays())

      // A crash mid-write: the bytes stop half-way and the process never reaches the rename.
      syncFs.writeFileSync = ((target: number | string, data: string, options?: unknown) => {
        realWrite(target as never, data.slice(0, 3), options as never)
        throw Object.assign(new Error("simulated power cut"), { code: "EIO" })
      }) as typeof syncFs.writeFileSync
      let threw = false
      try {
        writeAtomicSync(file, writeBootPrefs({ theme: "light", hardwareAcceleration: true }))
      } catch {
        threw = true
      }
      syncFs.writeFileSync = realWrite
      check("an interrupted write reports its failure", threw)
      check("the file still holds the whole previous version, not an empty one", syncFs.readFileSync(file, "utf8") === off)
      check("and the half-written temp was removed", strays().length === 0, strays())

      // A rename that fails for good (not a passing Windows lock) leaves the old file too.
      syncFs.renameSync = (() => {
        throw Object.assign(new Error("simulated disk full"), { code: "ENOSPC" })
      }) as typeof syncFs.renameSync
      try {
        writeAtomicSync(file, writeBootPrefs({ theme: "light", hardwareAcceleration: true }))
      } catch {
        // Expected.
      }
      syncFs.renameSync = realRename
      check("a failed rename keeps the previous version", syncFs.readFileSync(file, "utf8") === off)

      // A passing Windows lock is waited out.
      let refusals = 0
      syncFs.renameSync = ((from: string, to: string) => {
        if (refusals++ < 2) throw Object.assign(new Error("locked"), { code: "EPERM" })
        realRename(from, to)
      }) as typeof syncFs.renameSync
      const on = writeBootPrefs({ theme: "light", hardwareAcceleration: true })
      let lockAnswer = "written"
      try {
        writeAtomicSync(file, on)
      } catch (err) {
        lockAnswer = (err as NodeJS.ErrnoException).code ?? "threw"
      }
      syncFs.renameSync = realRename
      if (process.platform === "win32") {
        check("on Windows a rename refused twice with EPERM is retried until it lands", lockAnswer === "written" && syncFs.readFileSync(file, "utf8") === on, lockAnswer)
      } else {
        check("elsewhere EPERM is not a lock and is reported at once", lockAnswer === "EPERM" && refusals === 1, lockAnswer)
      }

      // A crash between the write and the rename leaves a stray temp; readers open only the real name.
      writeAtomicSync(file, off)
      syncFs.writeFileSync(`${file}.99999.1.tmp`, "{", "utf8")
      const saved = readBootPrefs(syncFs.readFileSync(file, "utf8"))
      check("a leftover temp beside boot-prefs.json does not disturb reading it", saved.theme === "dark" && saved.hardwareAcceleration === false, saved)
      const display = path.join(scratch, DISPLAY_SERVER_FILE)
      writeAtomicSync(display, JSON.stringify({ displayServer: "x11" }))
      syncFs.writeFileSync(`${display}.99999.2.tmp`, "", "utf8")
      check("nor one beside display-server.json", readDisplayServerFile(syncFs.readFileSync(display, "utf8")) === "x11")
      writeAtomicSync(file, on)
      check("the next write replaces the file whatever temps lie around", syncFs.readFileSync(file, "utf8") === on)
    } finally {
      syncFs.renameSync = realRename
      syncFs.writeFileSync = realWrite
      await fs.rm(scratch, { recursive: true, force: true })
    }

    const atomicSource = await read("src/main/atomic-write.ts")
    const fsyncAt = atomicSource.indexOf("fs.fsyncSync(handle)")
    check("the temp's bytes are flushed before the rename", fsyncAt > 0 && fsyncAt < atomicSource.indexOf("renameOverSync(temp, file)"))
    const windowState = await read("src/main/window-state.ts")
    check("window.json is written through writeAtomicSync", windowState.includes("writeAtomicSync(file(),") && !/writeFileSync|\bwriteFile\(/.test(windowState))
    check("boot-prefs.json is written through writeAtomicSync", mainSource.includes("writeAtomicSync(bootPrefsFile,") && !/writeFile\w*\(bootPrefsFile/.test(mainSource))
    check("display-server.json is written through writeAtomicSync", mainSource.includes("writeAtomicSync(displayServerFile,") && !/writeFile\w*\(displayServerFile/.test(mainSource))
  }
}
