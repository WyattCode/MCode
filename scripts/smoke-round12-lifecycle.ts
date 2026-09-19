/**
 * Round 12 (lane B): what the stores do when a document is damaged, and what
 * they keep tidy over a long life (L12-7 onwards). Kept apart from smoke.ts the
 * way the earlier rounds are; smoke.ts calls `roundTwelveLifecycleChecks` with
 * its own check and section.
 *
 * Everything here runs in temporary folders of its own. Nothing reads the
 * user's profile, calls a model or reaches the network.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Check } from "./smoke-round5"
import type { Runtime } from "../src/server/index"
import { ArtifactStore } from "../src/server/artifact/store"
import { storeNotices } from "../src/server/store-notices"
import { quarantineSqlite } from "../src/server/sql-worker"

const exists = (file: string) =>
  fs.access(file).then(
    () => true,
    () => false,
  )

export async function roundTwelveLifecycleChecks(check: Check, section: (name: string) => void): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r12-lifecycle-"))

  // ------------------------------------------------------------------ L12-7
  section("Round 12 (L12-7): a damaged artifacts.db is kept aside and started again")
  {
    const folder = path.join(root, "artifacts")
    await fs.mkdir(folder, { recursive: true })
    const file = path.join(folder, "artifacts.db")
    await fs.writeFile(file, "this is not a database, only words")
    const store = await ArtifactStore.open(file)
    const names = await fs.readdir(folder)
    const aside = names.find((name) => name.startsWith("artifacts.db.corrupt-") && !/-(wal|shm|journal)$/.test(name))
    check("the store opens again instead of staying off", Boolean(store?.writable), names)
    check("it says where the damaged file went", Boolean(store?.recovered && path.basename(store.recovered) === aside), [store?.recovered, names])
    check(
      "the damaged file is kept byte for byte",
      Boolean(aside) && (await fs.readFile(path.join(folder, aside!), "utf8")) === "this is not a database, only words",
    )
    check("the fresh store is empty and answers", (await store?.count()) === 0)
    // SQLite deletes a -wal it closes on, so what goes with the file is checked on files it never opened.
    const loose = path.join(root, "loose")
    await fs.mkdir(loose, { recursive: true })
    for (const suffix of ["", "-wal", "-shm"]) await fs.writeFile(path.join(loose, `x.db${suffix}`), suffix || "db")
    const moved = quarantineSqlite(path.join(loose, "x.db"))
    const left = await fs.readdir(loose)
    check(
      "its journal files go with it",
      Boolean(moved) && left.length === 3 && ["", "-wal", "-shm"].every((suffix) => left.includes(path.basename(moved!) + suffix)),
      left,
    )

    const runtime = { artifacts: store } as unknown as Runtime
    const first = await storeNotices(runtime)
    check("the window is told once, with the path", first.length === 1 && first[0]?.code === "error.artifactsRecreated" && first[0]?.params?.path === store?.recovered, first)
    check("and not again on a second ask", (await storeNotices(runtime)).length === 0)
    await store?.close()

    // Reopened as it now is: nothing is moved aside a second time.
    const again = await ArtifactStore.open(file)
    check("a healthy store opens with nothing recovered", Boolean(again?.writable) && again?.recovered === undefined)
    check("and nothing new is moved aside", (await fs.readdir(folder)).filter((name) => name.includes(".corrupt-") && !/-(wal|shm|journal)$/.test(name)).length === 1)
    await again?.close()

    // A failure that is not damage - here, a folder where the file should be - leaves it alone.
    const locked = path.join(root, "artifacts-locked")
    await fs.mkdir(path.join(locked, "artifacts.db"), { recursive: true })
    const refused = await ArtifactStore.open(path.join(locked, "artifacts.db"))
    check("an open that fails for another reason moves nothing", refused === undefined && (await fs.readdir(locked)).length === 1 && (await exists(path.join(locked, "artifacts.db"))), await fs.readdir(locked))
  }

  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
}
