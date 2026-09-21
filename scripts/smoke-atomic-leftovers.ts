/**
 * D12-7's leftovers: the main-process files that were still written in place
 * after boot-prefs, display-server and window.json moved to writeAtomicSync.
 * smoke.ts calls `atomicLeftoverChecks` with its own check and section.
 *
 * Every write here goes to a throwaway folder under the system temp; a crash
 * is simulated by cutting fs.writeFileSync off half-way, as round 12 does.
 */
import syncFs from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Check } from "./smoke-round5"
import type { IpcMain } from "electron"
import { TRANSACTION_FILE, createTransactions, fileTransactionStore } from "../src/main/update-transaction"
import { COMPOSER_INPUT_FILE, registerComposerInput } from "../src/main/composer-input"
import { TEMP_KEEP_MS, processAlive, sweepWriterTemps } from "../src/main/atomic-write"
import { BOOT_PREFS_FILE } from "../src/main/boot-prefs"
import { spawnSync } from "node:child_process"

const read = (relative: string) => fs.readFile(path.join(process.cwd(), relative), "utf8")

/** Runs `write` with fs.writeFileSync cut off after a few bytes, as a crash inside the write would. */
function cutShort(write: () => void): boolean {
  const realWrite = syncFs.writeFileSync
  syncFs.writeFileSync = ((target: number | string, data: string | Uint8Array, options?: unknown) => {
    realWrite(target as never, (typeof data === "string" ? data.slice(0, 3) : data.subarray(0, 3)) as never, options as never)
    throw Object.assign(new Error("simulated crash mid-write"), { code: "EIO" })
  }) as typeof syncFs.writeFileSync
  try {
    write()
    return false
  } catch {
    return true
  } finally {
    syncFs.writeFileSync = realWrite
  }
}

export async function atomicLeftoverChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("D12-7: updates/update-transaction.json is replaced, never truncated")
  {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-d12-7-tx-"))
    try {
      const file = path.join(scratch, "updates", TRANSACTION_FILE)
      const store = fileTransactionStore(file)
      const transactions = createTransactions(store, () => 1_000)
      check("begin creates the updates folder and the record", transactions.begin("0.3.4", "0.3.5") && syncFs.existsSync(file))
      const before = syncFs.readFileSync(file, "utf8")
      const strays = () => syncFs.readdirSync(path.dirname(file)).filter((name) => name !== TRANSACTION_FILE)
      check("a finished write leaves nothing beside the record", strays().length === 0, strays())

      // The installer is about to take the app down: the write that marks it is cut short.
      const threw = cutShort(() => store.write(JSON.stringify({ version: 1, phase: "installer-started", fromVersion: "0.3.4", targetVersion: "0.3.5", startedAt: 1_000, installerStartedAt: 1_000 })))
      check("the interrupted write reports its failure", threw)
      check("the record on disk is still the whole previous one", syncFs.readFileSync(file, "utf8") === before, syncFs.readFileSync(file, "utf8"))
      check("and no half-written temp is left beside it", strays().length === 0, strays())
      check("so the next launch finds a pending update, not an invalid record", transactions.reconcile("0.3.4") === undefined && syncFs.existsSync(file))
      check("the record itself goes once the target version runs", transactions.reconcile("0.3.5") === undefined && !syncFs.existsSync(file))
    } finally {
      await fs.rm(scratch, { recursive: true, force: true })
    }
    const main = await read("src/main/index.ts")
    check("main keeps the record through fileTransactionStore", /createTransactions\(fileTransactionStore\(transactionFile\)\)/.test(main) && !/writeFile\w*\(transactionFile/.test(main))
    const source = await read("src/main/update-transaction.ts")
    check("and the store writes through writeAtomicSync", /write: \(text\) => writeAtomicSync\(file,/.test(source) && !/writeFileSync/.test(source))
  }

  section("D12-7: the saved composer input is replaced whole; only the write on the way out is flushed")
  {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-d12-7-ci-"))
    const realFsync = syncFs.fsyncSync
    const realRename = syncFs.renameSync
    try {
      // The three channels, answered by the real handlers against a throwaway profile.
      const on = new Map<string, (event: { returnValue?: unknown }, ...args: unknown[]) => void>()
      const handle = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
      registerComposerInput({ on: (channel: string, fn: never) => on.set(channel, fn), handle: (channel: string, fn: never) => handle.set(channel, fn) } as unknown as IpcMain, scratch)
      const save = (text: unknown) => handle.get("mcode:composer-input-save")!({}, text) as boolean
      const flush = (text: unknown) => {
        const event: { returnValue?: unknown } = {}
        on.get("mcode:composer-input-flush")!(event, text)
        return event.returnValue as boolean
      }
      const load = () => {
        const event: { returnValue?: unknown } = {}
        on.get("mcode:composer-input-load")!(event)
        return event.returnValue as { ok: boolean; text?: string }
      }
      const file = path.join(scratch, "storage", COMPOSER_INPUT_FILE)
      const strays = () => syncFs.readdirSync(path.dirname(file)).filter((name) => name !== COMPOSER_INPUT_FILE)
      let flushes = 0
      syncFs.fsyncSync = ((fd: number) => {
        flushes++
        realFsync(fd)
      }) as typeof syncFs.fsyncSync

      const first = JSON.stringify({ v: 1, drafts: { home: { text: "first" } } })
      check("a save while typing lands", save(first) === true && syncFs.readFileSync(file, "utf8") === first)
      check("without a flush", flushes === 0, flushes)
      const second = JSON.stringify({ v: 1, drafts: { home: { text: "second" } } })
      check("the write on the way out lands", flush(second) === true && syncFs.readFileSync(file, "utf8") === second)
      check("and is flushed before the rename", flushes === 1, flushes)
      check("neither leaves a temp behind", strays().length === 0, strays())

      check("a crash inside a save leaves the previous document whole", cutShort(() => {
        if (!save(JSON.stringify({ v: 1, drafts: { home: { text: "third" } } }))) throw new Error("refused")
      }) && syncFs.readFileSync(file, "utf8") === second, syncFs.readFileSync(file, "utf8"))
      check("and takes its half-written temp with it", strays().length === 0, strays())

      // A reader or a virus scanner holding the document open for a moment on Windows.
      let refusals = 0
      syncFs.renameSync = ((from: string, to: string) => {
        if (refusals++ < 2) throw Object.assign(new Error("locked"), { code: "EPERM" })
        realRename(from, to)
      }) as typeof syncFs.renameSync
      const locked = JSON.stringify({ v: 1, drafts: { home: { text: "locked" } } })
      const answered = flush(locked)
      syncFs.renameSync = realRename
      if (process.platform === "win32") {
        check("on Windows a rename refused twice with EPERM is waited out, not a lost draft", answered === true && syncFs.readFileSync(file, "utf8") === locked, answered)
      } else {
        check("elsewhere EPERM is reported and the previous document stays", answered === false && syncFs.readFileSync(file, "utf8") === second, answered)
      }
      check("a lock leaves no temp behind either", strays().length === 0, strays())

      check("anything but a JSON object is refused and writes nothing", save("[1]") === false && flush(42) === false && strays().length === 0)

      // What an earlier version left: its own temp name, and a document in the same format.
      const kept = syncFs.readFileSync(file, "utf8")
      syncFs.writeFileSync(`${file}.4242.tmp`, "{", "utf8")
      syncFs.writeFileSync(`${file}.4242.3.tmp`, "", "utf8")
      const loaded = load()
      check("a document written by an earlier version loads as it is, whatever temps lie beside it", loaded.ok && loaded.text === kept, loaded)
    } finally {
      syncFs.fsyncSync = realFsync
      syncFs.renameSync = realRename
      await fs.rm(scratch, { recursive: true, force: true })
    }
  }

  section("D12-7: temps a killed write left are swept at start-up - only the writer's own, only a dead run's")
  {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-d12-7-sweep-"))
    try {
      const dead = 4_000_001
      const live = 4_000_002
      const alive = (pid: number) => pid === live || pid === process.pid
      const now = Date.now()
      const lay = (name: string, ageMs = 0) => {
        const full = path.join(scratch, name)
        syncFs.writeFileSync(full, "{", "utf8")
        const at = new Date(now - ageMs)
        syncFs.utimesSync(full, at, at)
      }
      const taken = [`${BOOT_PREFS_FILE}.${dead}.1.tmp`, `window.json.${dead}.12.tmp`, `${BOOT_PREFS_FILE}.${live}.3.tmp`, `${COMPOSER_INPUT_FILE}.${dead}.tmp`]
      // The live process's temp is only taken once it is past the safe age.
      lay(taken[0]!)
      lay(taken[1]!)
      lay(taken[2]!, TEMP_KEEP_MS + 60_000)
      lay(taken[3]!)
      const left = [
        BOOT_PREFS_FILE, // the document itself
        `${BOOT_PREFS_FILE}.${live}.4.tmp`, // a live run's write, in flight or just finished
        `${BOOT_PREFS_FILE}.${process.pid}.5.tmp`, // this run's own
        `settings.json.${dead}.1.tmp`, // a temp of a file this folder's writers do not write
        `${BOOT_PREFS_FILE}.${dead}.tmp`, // the pid-only form, for a name that never used it
        `${BOOT_PREFS_FILE}.tmp`, // no pid at all
        `${BOOT_PREFS_FILE}.${dead}.1.tmp.bak`, // not a temp's name
        "notes.tmp",
      ]
      // A running writer's temps are fresh; everything else is old, so that age alone could not have kept it.
      for (const name of left) lay(name, name.includes(`.${live}.`) || name.includes(`.${process.pid}.`) ? 0 : 2 * TEMP_KEEP_MS)
      syncFs.mkdirSync(path.join(scratch, `window.json.${dead}.9.tmp`)) // a folder, whatever its name
      syncFs.mkdirSync(path.join(scratch, "nested"))
      syncFs.writeFileSync(path.join(scratch, "nested", `${BOOT_PREFS_FILE}.${dead}.1.tmp`), "{", "utf8") // below the folder listed

      const removed = await sweepWriterTemps(scratch, { names: [BOOT_PREFS_FILE, "window.json", COMPOSER_INPUT_FILE], pidOnly: [COMPOSER_INPUT_FILE] }, { now, alive })
      const remaining = syncFs.readdirSync(scratch)
      check("a dead run's temps of the listed files are removed", taken.every((name) => removed.includes(name) && !remaining.includes(name)), { removed, remaining })
      check("including the pid-only temp an earlier composer-input writer left", removed.includes(`${COMPOSER_INPUT_FILE}.${dead}.tmp`))
      check("and a live id's temp once it is over the safe age", removed.includes(`${BOOT_PREFS_FILE}.${live}.3.tmp`))
      check("nothing else is touched", removed.length === taken.length && left.every((name) => remaining.includes(name)), { removed, remaining })
      check("not a folder named like a temp, nor a temp below the folder listed", remaining.includes(`window.json.${dead}.9.tmp`) && syncFs.existsSync(path.join(scratch, "nested", `${BOOT_PREFS_FILE}.${dead}.1.tmp`)))
      check("a folder that does not exist yet is nothing to sweep", (await sweepWriterTemps(path.join(scratch, "absent"), { names: [BOOT_PREFS_FILE] })).length === 0)

      // The real test of a process: this one is alive, a child that has exited is not.
      const child = spawnSync(process.execPath, ["-e", ""])
      check("processAlive knows this process and a finished child apart", processAlive(process.pid) && typeof child.pid === "number" && !processAlive(child.pid), child.pid)
    } finally {
      await fs.rm(scratch, { recursive: true, force: true })
    }
    const main = await read("src/main/index.ts")
    const at = main.indexOf("void app.whenReady().then(async () => {\n  const profile = app.getPath(\"userData\")")
    const block = at < 0 ? "" : main.slice(at, main.indexOf("\n})", at))
    check("main sweeps the profile beside boot-prefs, display-server, login-item and window.json", /sweepWriterTemps\(profile, \{ names: \[BOOT_PREFS_FILE, DISPLAY_SERVER_FILE, LOGIN_ITEM_FILE, WINDOW_STATE_FILE\] \}\)/.test(block), block)
    check("the updates folder beside update-transaction.json", /sweepWriterTemps\(path\.dirname\(transactionFile\), \{ names: \[TRANSACTION_FILE\] \}\)/.test(block))
    check("and storage/ beside composer-input.json, its older temp name included", /sweepWriterTemps\(path\.join\(profile, "storage"\), \{ names: \[COMPOSER_INPUT_FILE\], pidOnly: \[COMPOSER_INPUT_FILE\] \}\)/.test(block))
  }
}
