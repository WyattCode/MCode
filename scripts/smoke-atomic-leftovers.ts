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
import { TRANSACTION_FILE, createTransactions, fileTransactionStore } from "../src/main/update-transaction"

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
}
