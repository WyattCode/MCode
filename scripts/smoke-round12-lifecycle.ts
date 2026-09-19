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
import { cronFile, readCronFile, schedulable } from "../src/server/cron/tasks"
import { CronScheduler } from "../src/server/cron/scheduler"
import type { SessionInfo } from "../src/shared/protocol"

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

  // ------------------------------------------------------------------ L12-8
  section("Round 12 (L12-8): a damaged scheduled_tasks.json is kept, and a schedule this build cannot read survives")
  {
    const project = path.join(root, "cron-project")
    const file = cronFile(project)
    await fs.mkdir(path.dirname(file), { recursive: true })
    const fired: string[] = []
    const scheduler = new CronScheduler({
      now: () => Date.UTC(2026, 0, 1, 12, 0, 30),
      fire: async (_sessionID, text) => void fired.push(text),
      busy: () => false,
      session: async (id) => ({ id, directory: project }) as SessionInfo,
      create: async () => ({ id: "ses_adopted", directory: project }) as SessionInfo,
      directories: async () => [project],
    })

    await fs.writeFile(file, '{ "tasks": [ { "id": "lost"')
    const read = await readCronFile(project)
    const kept = (await fs.readdir(path.dirname(file))).filter((name) => name.startsWith("scheduled_tasks.json.corrupt-"))
    check("an unparseable file reads as no tasks, and not as blocked once it is moved", read.tasks.length === 0 && read.blocked === undefined)
    check("the damaged file is kept byte for byte", kept.length === 1 && (await fs.readFile(path.join(path.dirname(file), kept[0]!), "utf8")) === '{ "tasks": [ { "id": "lost"', kept)

    // A file that cannot be moved aside is never written over.
    await fs.writeFile(file, "{ damaged and stuck")
    const rename = fs.rename
    ;(fs as { rename: typeof fs.rename }).rename = async () => {
      throw Object.assign(new Error("cannot move"), { code: "EXDEV" })
    }
    let refused: unknown
    try {
      refused = await scheduler.add({ ownerID: "ses_owner", directory: project, cron: "0 9 * * *", prompt: "write over it?", recurring: true, durable: true }).then(
        () => undefined,
        (cause: unknown) => cause,
      )
    } finally {
      ;(fs as { rename: typeof fs.rename }).rename = rename
    }
    check("a durable task is refused while the file cannot be moved", refused instanceof Error && /could not be read/.test(refused.message), String(refused))
    check("and the file is exactly as it was", (await fs.readFile(file, "utf8")) === "{ damaged and stuck")

    // A schedule this build does not understand stays in the file through a rewrite, and never fires.
    await fs.writeFile(
      file,
      JSON.stringify({
        tasks: [
          { id: "future01", cron: "@every 90s", prompt: "a newer build's syntax", createdAt: Date.UTC(2025, 0, 1), recurring: true, createdBySessionId: "ses_owner" },
        ],
      }),
    )
    await scheduler.start({ interval: false })
    await scheduler.add({ ownerID: "ses_owner", directory: project, cron: "0 9 * * *", prompt: "a new one", recurring: true, durable: true })
    await scheduler.tick()
    const after = (await readCronFile(project)).tasks.map((task) => task.id)
    check("a task whose schedule cannot be read is kept on write", after.includes("future01") && after.length === 2, after)
    check("and it is never fired", !fired.some((text) => text.includes("a newer build's syntax")), fired)
    check("it reads as unschedulable, not as malformed", !schedulable({ id: "x", cron: "@every 90s", prompt: "p", createdAt: 1 }) && schedulable({ id: "x", cron: "0 9 * * *", prompt: "p", createdAt: 1 }))
    await scheduler.stop()
  }

  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
}
