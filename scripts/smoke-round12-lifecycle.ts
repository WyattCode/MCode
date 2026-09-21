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
import { Storage, pruneQuarantined } from "../src/server/storage"
import { IndexDatabase } from "../src/server/history/database"
import { PROJECT_ID_FILE, forgetProjectIDs, projectMemoryID } from "../src/server/memory/project-id"
import { Bus } from "../src/server/bus"
import { SessionStore } from "../src/server/session/store"
import { McpAuthStore } from "../src/server/mcp-oauth"
import { codeOf, paramsOf } from "../src/shared/errors"
import { CHECKPOINT_PACK_EVERY_MS, CHECKPOINT_PACK_FIRST_MS, Snapshots } from "../src/server/session/snapshot"
import { execFileSync } from "node:child_process"
import { SKILL_TRASH_DAYS, pruneSkillTrash } from "../src/server/skill"
import { AutomationService, RUN_REASONS, bindAutomations, type AutomationDeps } from "../src/server/automation/service"

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

  // ----------------------------------------------------------------- L12-12
  section("Round 12 (L12-12): uninstalled skills leave the trash after a week, judged by the name")
  {
    const storageDirectory = path.join(root, "skills-storage")
    const trash = path.join(storageDirectory, "skill-trash")
    const now = Date.UTC(2026, 8, 20, 12)
    const day = 24 * 60 * 60 * 1000
    const make = async (name: string) => {
      await fs.mkdir(path.join(trash, name), { recursive: true })
      await fs.writeFile(path.join(trash, name, "SKILL.md"), "---\nname: x\n---\n")
    }
    await make(`${now - 8 * day}-old-skill`)
    await make(`${now - 6 * day}-recent-skill`)
    await make("not-ours")
    // A folder renamed into the trash today keeps its old mtime; the name, not the clock on the folder, says when.
    await make(`${now - 1 * day}-renamed-long-ago`)
    const ancient = new Date(now - 400 * day)
    await fs.utimes(path.join(trash, `${now - 1 * day}-renamed-long-ago`), ancient, ancient)

    const removed = await pruneSkillTrash(storageDirectory, now)
    const left = (await fs.readdir(trash)).sort()
    check("only the one uninstalled more than seven days ago goes", removed === 1 && !left.includes(`${now - 8 * day}-old-skill`), left)
    check("a recent one stays, whatever its folder's mtime", left.includes(`${now - 6 * day}-recent-skill`) && left.includes(`${now - 1 * day}-renamed-long-ago`), left)
    check("a folder without a time in its name is not this app's and stays", left.includes("not-ours"), left)
    check("a profile with no trash is fine", (await pruneSkillTrash(path.join(root, "no-such-storage"), now)) === 0)
    check("the window is MiMo's seven days", SKILL_TRASH_DAYS === 7)
  }

  // ----------------------------------------------------------------- L12-13
  section("Round 12 (L12-13): checkpoint stores are packed, never pruned")
  {
    const base = path.join(root, "packing")
    const project = path.join(base, "project")
    await fs.mkdir(project, { recursive: true })
    execFileSync("git", ["init", "-q"], { cwd: project })
    const snapshots = new Snapshots(path.join(base, "snapshot"))
    const bodies: string[] = []
    for (let n = 0; n < 40; n++) bodies.push(await snapshots.keep(project, Buffer.from(`undo body number ${n} ${"x".repeat(n * 50)}`)))
    const store = path.join(base, "snapshot", (await fs.readdir(path.join(base, "snapshot"))).find((name) => /^[0-9a-f]{40}$/.test(name))!)
    const counts = () => {
      const text = execFileSync("git", ["--git-dir", store, "count-objects", "-v"], { encoding: "utf8" })
      const field = (name: string) => Number(new RegExp(`^${name}: (\\d+)`, "m").exec(text)?.[1] ?? NaN)
      return { loose: field("count"), packed: field("in-pack") }
    }
    const before = counts()
    // One pass, with a body kept while it runs: the store's own queue puts one after the other.
    const [packed, during] = await Promise.all([snapshots.pack([project, project]), snapshots.keep(project, Buffer.from("kept while packing"))])
    const after = counts()
    check("every body starts loose", before.loose >= 40 && before.packed === 0, before)
    check("a pass packs the store once, however often its folder is named", packed === 1, packed)
    check("and leaves nothing loose that was there before", after.loose <= 1 && after.packed >= 40, after)
    const readable = await Promise.all(bodies.map(async (id, n) => (await snapshots.fetch(project, id))?.toString("utf8") === `undo body number ${n} ${"x".repeat(n * 50)}`))
    check("every undo body - unreachable from any ref - is still there, byte for byte", readable.every(Boolean), readable.filter((ok) => !ok).length)
    check("and so is one kept while the pack ran", (await snapshots.fetch(project, during))?.toString("utf8") === "kept while packing")
    const again = await snapshots.pack([project])
    check("a second pass keeps everything too", again === 1 && (await snapshots.fetch(project, bodies[7]!)) !== undefined && counts().loose === 0, counts())

    const bare = path.join(base, "no-store")
    await fs.mkdir(bare, { recursive: true })
    const storesBefore = (await fs.readdir(path.join(base, "snapshot"))).length
    check("a folder with no store is not given one", (await snapshots.pack([bare])) === 0 && (await fs.readdir(path.join(base, "snapshot"))).length === storesBefore)

    const index = await fs.readFile(path.join(process.cwd(), "src", "server", "index.ts"), "utf8")
    check("the first pass is a minute after start and then hourly, as MiMo's", CHECKPOINT_PACK_FIRST_MS === 60_000 && CHECKPOINT_PACK_EVERY_MS === 3_600_000)
    check(
      "and neither timer holds the process open, and both stop with the backend",
      /packFirst\.unref\?\.\(\)/.test(index) && /packEvery\.unref\?\.\(\)/.test(index) && /clearTimeout\(packFirst\)/.test(index) && /clearInterval\(packEvery\)/.test(index),
    )
  }

  // ----------------------------------------------------------------- L12-14
  section("Round 12 (L12-14): a damaged automations.json is said in the window at start-up")
  {
    const base = path.join(root, "automations")
    await fs.mkdir(base, { recursive: true })
    const file = path.join(base, "automations.json")
    await fs.writeFile(file, '{ "automations": [ { "id": "daily"')
    const service = new AutomationService(automationDeps(file))
    bindAutomations(service)
    try {
      // What start.ts does: the start is kept, so a report can wait for the file to have been read.
      service.started = service.start({ interval: false })
      const runtime = { sessions: { unreadable: async () => [] } } as unknown as Runtime
      const said = await storeNotices(runtime)
      await service.started
      const aside = service.unreadable.evidence
      check("the file is moved aside as before", Boolean(aside) && path.basename(aside!).startsWith("automations.json.corrupt-"), aside)
      check("and the window is told, naming where it was kept", said.length === 1 && said[0]?.code === "error.automationsInvalid" && said[0]?.params?.path === aside, said)
      check("once", (await storeNotices(runtime)).length === 0)

      const healthy = new AutomationService(automationDeps(path.join(base, "fresh.json")))
      bindAutomations(healthy)
      healthy.started = healthy.start({ interval: false })
      check("a profile whose tasks read says nothing", (await storeNotices({ sessions: { unreadable: async () => [] } } as unknown as Runtime)).length === 0)
      await healthy.stop()
    } finally {
      await service.stop()
      bindAutomations(undefined)
    }
  }

  // ----------------------------------------------------------------- L12-15
  section("Round 12 (L12-15): the search index is deleted, not kept, on a schema change; old quarantined copies are pruned")
  {
    const base = path.join(root, "prune")
    const indexFolder = path.join(base, "index")
    const indexPath = path.join(indexFolder, "search.db")
    const first = await IndexDatabase.open(indexPath)
    await first.db.exec("PRAGMA user_version = 99")
    await first.close()
    const flipped = await IndexDatabase.open(indexPath)
    check("an index from another schema is started over", flipped.openedAs === "recreated")
    check("and no copy of it is kept", !(await fs.readdir(indexFolder)).some((name) => name.includes(".corrupt-")), await fs.readdir(indexFolder))
    await flipped.close()
    for (const suffix of ["-wal", "-shm"]) await fs.rm(indexPath + suffix, { force: true })
    await fs.writeFile(indexPath, "not a database")
    const damaged = await IndexDatabase.open(indexPath)
    check("a damaged one is still kept aside", damaged.openedAs === "recreated" && (await fs.readdir(indexFolder)).some((name) => name.startsWith("search.db.corrupt-")))
    await damaged.close()

    const storage = path.join(base, "storage")
    const now = Date.UTC(2026, 8, 20, 12)
    const day = 24 * 60 * 60 * 1000
    const stamp = (daysAgo: number) => new Date(now - daysAgo * day).toISOString().replace(/[:.]/g, "-")
    const files = [
      "config.json",
      `config.json.corrupt-${stamp(60)}`,
      `config.json.corrupt-${stamp(40)}`,
      `config.json.corrupt-${stamp(1)}`,
      `permissions.json.corrupt-${stamp(90)}`,
      `artifacts.db.corrupt-${stamp(50)}`,
      `artifacts.db.corrupt-${stamp(50)}-wal`,
      `artifacts.db.corrupt-${stamp(50)}-shm`,
      `artifacts.db.corrupt-${stamp(2)}`,
      `artifacts.db.corrupt-${stamp(2)}-wal`,
      "notes.corrupt-by-hand",
      path.join("session", "ses_1", `history.json.corrupt-${stamp(50)}`),
      path.join("session", "ses_1", `history.json.corrupt-${stamp(45)}-1`),
    ]
    for (const name of files) {
      await fs.mkdir(path.dirname(path.join(storage, name)), { recursive: true })
      await fs.writeFile(path.join(storage, name), name)
    }
    const removed = await pruneQuarantined(storage, { recursive: true, now })
    const left = new Set([...(await fs.readdir(storage)), ...(await fs.readdir(path.join(storage, "session", "ses_1")))])
    const gone = (name: string) => !left.has(path.basename(name))
    check("copies over 30 days old go, journals with them", gone(`config.json.corrupt-${stamp(60)}`) && gone(`config.json.corrupt-${stamp(40)}`) && gone(`artifacts.db.corrupt-${stamp(50)}-wal`) && gone(`artifacts.db.corrupt-${stamp(50)}`), [...left])
    check("the newest copy of each document stays, however old", left.has(`config.json.corrupt-${stamp(1)}`) && left.has(`permissions.json.corrupt-${stamp(90)}`) && left.has(`history.json.corrupt-${stamp(45)}-1`) && gone(`history.json.corrupt-${stamp(50)}`), [...left])
    check("recent copies and their journals stay", left.has(`artifacts.db.corrupt-${stamp(2)}`) && left.has(`artifacts.db.corrupt-${stamp(2)}-wal`))
    check("the documents themselves and names that are not this app's are never touched", left.has("config.json") && left.has("notes.corrupt-by-hand"))
    check("and it says how many went", removed === 6, removed)
  }

  // ----------------------------------------------------------------- L12-16
  section("Round 12 (L12-16): the memory project id is written whole, and a bad one is kept before it is replaced")
  {
    const repo = path.join(root, "memory-repo")
    await fs.mkdir(repo, { recursive: true })
    execFileSync("git", ["init", "-q"], { cwd: repo })
    const gitDir = path.join(repo, ".git")
    const file = path.join(gitDir, PROJECT_ID_FILE)
    const home = path.join(root, "not-home")

    forgetProjectIDs()
    const made = projectMemoryID(repo, { home })
    check("a repository met for the first time gets an id, written to its .git", /^[0-9a-f-]{36}$/.test(made) && (await fs.readFile(file, "utf8")) === made, made)
    check("and no temp file is left beside it", !(await fs.readdir(gitDir)).some((name) => name.endsWith(".tmp")), await fs.readdir(gitDir))
    forgetProjectIDs()
    check("the id read back is the same one", projectMemoryID(repo, { home }) === made)

    // An id file cut short or edited into something that is not an id.
    await fs.writeFile(file, "not an id / at all")
    forgetProjectIDs()
    const replaced = projectMemoryID(repo, { home })
    const kept = (await fs.readdir(gitDir)).filter((name) => name.startsWith(`${PROJECT_ID_FILE}.corrupt-`))
    check("a file with no usable id gets a fresh one", replaced !== made && (await fs.readFile(file, "utf8")) === replaced, replaced)
    check("and what was there is kept, byte for byte", kept.length === 1 && (await fs.readFile(path.join(gitDir, kept[0]!), "utf8")) === "not an id / at all", kept)

    // An id already there, from whichever copy of the app wrote it, is the one used.
    await fs.rm(file)
    await fs.writeFile(file, "someone-elses-id")
    forgetProjectIDs()
    check("an id already there is used as it is", projectMemoryID(repo, { home }) === "someone-elses-id")
  }

  // ----------------------------------------------------------------- L12-17
  section("Round 12 (L12-17): a failed or skipped scheduled run records why, in MiMo's codes")
  {
    const base = path.join(root, "run-reasons")
    await fs.mkdir(base, { recursive: true })
    let clock = Date.UTC(2026, 8, 20, 8, 0)
    const target = { id: "ses_target", directory: base, model: { provider: "fake", model: "m" }, title: "Target" } as unknown as SessionInfo
    let targetThere = true
    let busy = false
    let promptThrows: string | undefined
    let models = [{ provider: "fake", id: "m", name: "Fake M" }]
    const deps: AutomationDeps = {
      ...automationDeps(path.join(base, "automations.json")),
      now: () => clock,
      sessions: { get: async (id) => (targetThere && id === target.id ? target : undefined), create: async () => target, messages: async () => [] },
      prompt: async () => {
        if (promptThrows) throw new Error(promptThrows)
      },
      busy: () => busy,
      models: () => models,
    }
    const service = new AutomationService(deps)
    await service.start({ interval: false })
    const made = JSON.parse(
      await service.handle(
        { mode: "create", title: "Nightly", prompt: "Summarise", rrule: "RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0", runMode: "existing-task", targetThreadId: target.id, notification: "failed-runs" },
        { sessionID: target.id },
      ),
    ) as { automation: { id: string } }
    const id = made.automation.id
    const last = () => service.list()[0]?.runHistory?.at(-1)
    const due = async () => {
      clock = (service.dueAt(id) ?? 0) + 1000
      await service.tick()
    }

    promptThrows = "the provider refused"
    await due()
    check("a turn that would not begin, with its model still offered, carries no code rather than a wrong one", last()?.status === "failed" && last()?.errorCode === undefined, last())
    models = []
    await due()
    check("with its model no longer offered it is model-unavailable", last()?.status === "failed" && last()?.errorCode === "model-unavailable", last())
    models = [{ provider: "fake", id: "m", name: "Fake M" }]
    promptThrows = undefined

    busy = true
    await due()
    await due()
    check("a run that waited on a busy conversation until the next came due is target-busy", last()?.status === "skipped" && last()?.errorCode === "target-busy", last())
    busy = false
    // The run still queued from the last tick starts once the conversation is free; it is left running.
    await service.tick()

    targetThere = false
    await due()
    check("a run whose conversation is gone is target-missing", last()?.status === "skipped" && last()?.errorCode === "target-missing", last())
    targetThere = true

    await due()
    check("a run under way", last()?.status === "running", last())
    await service.stop()
    check("that the app closes on is app_interrupted, MiMo's code for it", last()?.status === "skipped" && last()?.errorCode === "app_interrupted", last())

    const saved = JSON.parse(await fs.readFile(deps.file, "utf8")) as { automations: { runHistory?: { errorCode?: string }[] }[] }
    const codes = (saved.automations[0]?.runHistory ?? []).map((record) => record.errorCode).filter(Boolean)
    check("the codes are kept on disk with the run records", ["model-unavailable", "target-busy", "target-missing", "app_interrupted"].every((code) => codes.includes(code)), codes)
    check("and every one is from MiMo's list", codes.every((code) => (RUN_REASONS as readonly string[]).includes(code!)), codes)
  }

  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
}

/** An automation service's surroundings with nothing behind them: no model, no conversations. */
function automationDeps(file: string): AutomationDeps {
  return {
    file,
    now: () => Date.UTC(2026, 8, 20, 12),
    sessions: {
      get: async () => undefined,
      create: async () => {
        throw new Error("no conversations here")
      },
      messages: async () => [],
    },
    prompt: async () => undefined,
    busy: () => false,
    models: () => [],
    agent: () => "build",
    effort: () => undefined,
    scratch: async () => path.dirname(file),
    publish: () => undefined,
  }
}
