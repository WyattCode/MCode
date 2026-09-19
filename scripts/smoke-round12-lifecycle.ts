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
import { Storage } from "../src/server/storage"
import { Bus } from "../src/server/bus"
import { SessionStore } from "../src/server/session/store"
import { runImport, scanImports } from "../src/server/import"
import { McpAuthStore } from "../src/server/mcp-oauth"
import { codeOf, paramsOf } from "../src/shared/errors"
import { Snapshots } from "../src/server/session/snapshot"
import { execFileSync } from "node:child_process"

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

    const runtime = { artifacts: store, sessions: { unreadable: async () => [] } } as unknown as Runtime
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

  // ------------------------------------------------------------------ L12-9
  section("Round 12 (L12-9): a damaged import record does not duplicate every imported conversation")
  {
    const home = path.join(root, "import-home")
    const transcript = path.join(home, ".claude", "projects", "d--work-beta", "conversation.jsonl")
    await fs.mkdir(path.dirname(transcript), { recursive: true })
    await fs.writeFile(
      transcript,
      [
        JSON.stringify({ type: "user", cwd: root, timestamp: "2026-09-01T10:00:00.000Z", message: { role: "user", content: "Tidy the parser" } }),
        JSON.stringify({ type: "assistant", timestamp: "2026-09-01T10:00:20.000Z", message: { role: "assistant", content: [{ type: "text", text: "Tidied." }] } }),
      ].join("\n"),
    )
    const previous = process.env.MCODE_IMPORT_HOME
    process.env.MCODE_IMPORT_HOME = home
    try {
      const storage = new Storage(path.join(root, "import-store"))
      const sessions = new SessionStore(storage, new Bus())
      const model = { provider: "stub", model: "stub-1" }
      const first = await runImport({ storage, sessions, model }, ["cc"])
      const made = (await sessions.list()).filter((session) => session.imported)
      check("the first import takes the conversation", first.cc.imported === 1 && made.length === 1, first.cc)
      check("and the conversation carries its source key and clock", made[0]?.imported?.source === "cc" && typeof made[0]?.imported?.mtime === "number", made[0]?.imported)

      await fs.writeFile(storage.fileOf("imported"), '{ "schemaVersion": 1, "entries": { "cc:')
      const again = await runImport({ storage, sessions, model }, ["cc"])
      const after = (await sessions.list()).filter((session) => session.imported)
      check("importing again after the record was damaged makes no second copy", after.length === 1 && again.cc.imported === 0 && again.cc.skipped === 1, again.cc)
      const kept = (await fs.readdir(path.dirname(storage.fileOf("imported")))).filter((name) => name.startsWith("imported.json.corrupt-"))
      check("the damaged record is kept aside", kept.length === 1, kept)
      const rebuilt = JSON.parse(await fs.readFile(storage.fileOf("imported"), "utf8")) as { entries?: Record<string, { sessionID?: string }> }
      check("and a new record names the conversation again", Object.values(rebuilt.entries ?? {}).some((entry) => entry.sessionID === made[0]?.id), rebuilt)

      // A conversation taken before the clock was kept is recognised by its marker, and not written again.
      await sessions.stamp(made[0]!.id, { updated: made[0]!.updated, imported: { source: "cc", key: made[0]!.imported!.key } })
      await fs.rm(storage.fileOf("imported"), { force: true })
      const scan = await scanImports(storage, sessions)
      check("a scan counts it as taken with no record at all", scan.cc.imported === 1, scan.cc)
      const third = await runImport({ storage, sessions, model }, ["cc"])
      check("and a run with no record skips it", third.cc.imported === 0 && third.cc.resynced === 0 && third.cc.skipped === 1 && (await sessions.list()).filter((session) => session.imported).length === 1, third.cc)
    } finally {
      if (previous === undefined) delete process.env.MCODE_IMPORT_HOME
      else process.env.MCODE_IMPORT_HOME = previous
    }
  }

  // ----------------------------------------------------------------- L12-10
  section("Round 12 (L12-10): a damaged mcp-auth.json is kept, never written over")
  {
    const storage = new Storage(path.join(root, "mcp-auth", "storage"))
    const file = storage.fileOf("mcp-auth")
    await fs.mkdir(path.dirname(file), { recursive: true })
    const auth = new McpAuthStore(storage)

    await fs.writeFile(file, '{ "github": { "tokens": { "accessToken": "kept-for-evidence"')
    check("a file that will not parse reads as no sign-ins", Object.keys(await auth.all()).length === 0)
    const kept = (await fs.readdir(path.dirname(file))).filter((name) => name.startsWith("mcp-auth.json.corrupt-"))
    check("and is kept aside byte for byte", kept.length === 1 && (await fs.readFile(path.join(path.dirname(file), kept[0]!), "utf8")).includes("kept-for-evidence"), kept)
    await auth.set("linear", { codeVerifier: "v1" }, "https://linear.example")
    check("a later sign-in is saved beside nothing it could have destroyed", (await auth.get("linear"))?.codeVerifier === "v1")

    await fs.writeFile(file, "{ damaged and stuck")
    const rename = fs.rename
    ;(fs as { rename: typeof fs.rename }).rename = async () => {
      throw Object.assign(new Error("cannot move"), { code: "EXDEV" })
    }
    let refused: unknown
    try {
      refused = await auth.set("notion", { codeVerifier: "v2" }).then(
        () => undefined,
        (cause: unknown) => cause,
      )
    } finally {
      ;(fs as { rename: typeof fs.rename }).rename = rename
    }
    check("a change is refused with a code while the file can be neither read nor moved", codeOf(refused) === "error.mcpAuthUnreadable" && paramsOf(refused)?.file === file, String(refused))
    check("and the file is exactly as it was", (await fs.readFile(file, "utf8")) === "{ damaged and stuck")
    await fs.writeFile(file, JSON.stringify({ linear: { codeVerifier: "v1" } }))
    await auth.set("notion", { codeVerifier: "v2" })
    check("once it reads again, changes are saved", (await auth.get("notion"))?.codeVerifier === "v2" && (await auth.get("linear"))?.codeVerifier === "v1")
  }

  // ----------------------------------------------------------------- L12-11
  section("Round 12 (L12-11): a conversation whose record will not read keeps its undo store and its files")
  {
    const base = path.join(root, "unreadable")
    const storage = new Storage(path.join(base, "storage"))
    const sessions = new SessionStore(storage, new Bus())
    const snapshots = new Snapshots(path.join(base, "snapshot"))
    const folder = async (name: string) => {
      const directory = path.join(base, name)
      await fs.mkdir(directory, { recursive: true })
      execFileSync("git", ["init", "-q"], { cwd: directory })
      return directory
    }
    const [historyProject, ledgerProject, orphanProject] = await Promise.all([folder("by-history"), folder("by-ledger"), folder("orphan")])
    const model = { provider: "anthropic", model: "claude-opus-5" }

    // One found through its undo history, one only through the project's writers ledger.
    const byHistory = await sessions.create({ directory: historyProject, model })
    const blob = await snapshots.keep(historyProject, Buffer.from("before the turn"))
    await sessions.pushSnapshot(byHistory.id, { at: 1, files: [{ path: path.join(historyProject, "a.txt"), blob }], messages: ["msg_1"], directory: historyProject })
    const byLedger = await sessions.create({ directory: ledgerProject, model })
    await snapshots.keep(ledgerProject, Buffer.from("kept by the ledger"))
    await snapshots.wrote(ledgerProject, byLedger.id, 1, [path.join(ledgerProject, "b.txt")])
    await snapshots.keep(orphanProject, Buffer.from("nobody's"))

    // Its files, recorded while it could still be read.
    const artifacts = await ArtifactStore.open(path.join(base, "artifacts.db"))
    await sessions.saveMessage(
      {
        id: "msg_w1",
        sessionID: byHistory.id,
        role: "assistant",
        model,
        agent: "build",
        parts: [{ type: "tool", id: "prt_w1", callID: "call_w1", name: "write", status: "completed", input: { file_path: "report.md" }, output: "", title: "report.md", metadata: { created: true }, time: { created: 5, completed: 5 } }],
        finish: "end_turn",
        time: { created: 5, completed: 5 },
      } as never,
      true,
    )
    await artifacts?.reconcile(await sessions.list(), (id) => sessions.messages(id))

    for (const session of [byHistory, byLedger]) await fs.writeFile(storage.fileOf(`session/${session.id}/info`), '{ "id": "truncated')
    // As the next launch meets them: a store that has not read the list yet.
    const reopened = new SessionStore(storage, new Bus())
    const listed = (await reopened.list()).map((session) => session.id)
    const unreadable = await reopened.unreadable()
    check("the damaged records are left out of the list", !listed.includes(byHistory.id) && !listed.includes(byLedger.id))
    check("and reported as unreadable, by id", unreadable.length === 2 && unreadable.includes(byHistory.id) && unreadable.includes(byLedger.id), unreadable)
    check("they stay exactly where they are", (await fs.readFile(storage.fileOf(`session/${byHistory.id}/info`), "utf8")) === '{ "id": "truncated')
    check("the folder one worked in is read from its undo history", (await reopened.unreadableDirectories()).includes(historyProject), await reopened.unreadableDirectories())

    const stores = async () => (await fs.readdir(path.join(base, "snapshot"))).filter((name) => /^[0-9a-f]{40}$/.test(name)).length
    const before = await stores()
    // The call server/index.ts makes at start-up.
    const swept = await snapshots.sweep([...(await reopened.list()).map((session) => session.directory), ...(await reopened.unreadableDirectories())], unreadable)
    check("the start-up sweep keeps both of their undo stores and takes only the orphan", before === 3 && swept === 1 && (await stores()) === 2, { before, swept, after: await stores() })
    check("the kept store still answers for its turn", (await snapshots.fetch(historyProject, blob))?.toString("utf8") === "before the turn")

    await artifacts?.reconcile(await reopened.list(), (id) => reopened.messages(id))
    const sources = (await artifacts?.sourcesOf(path.join(historyProject, "report.md"))) ?? []
    check("its files keep their conversation in the artifacts store", sources.length === 1 && sources[0]?.sessionID === byHistory.id, sources)
    await artifacts?.close()

    const runtime = { sessions: reopened, storage } as unknown as Runtime
    const said = await storeNotices(runtime)
    check(
      "the window is told how many, and where they were kept",
      said.some((notice) => notice.code === "error.sessionsUnreadable" && notice.params?.count === 2 && notice.params?.path === storage.folder("session")),
      said,
    )
    check("once", (await storeNotices(runtime)).length === 0)
  }

  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
}
