/**
 * Round 11, doing many things at once and staying alive for a long time
 * (N11-1 onwards). Kept apart from smoke.ts the way the earlier rounds are;
 * smoke.ts calls `roundElevenChecks` with its own check and section.
 *
 * Some of these read the sources rather than run the app: the behaviours they
 * guard - a quit path, a lock, a fan-out rule - only show up when two things
 * happen at once, which a probe can stage but a smoke run cannot.
 */
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { RunQueue, LEASE_MS, MAX_ATTEMPTS } from "../src/server/automation/run-queue"
import { AutomationService, type AutomationDeps } from "../src/server/automation/service"
import { readTaskNotice } from "../src/main/desktop-rules"
import { SNAPSHOT_GIT_TIMEOUT_MS, SNAPSHOT_QUEUE_TIMEOUT_MS, Snapshots } from "../src/server/session/snapshot"
import { SCAN_LIMIT, searchMessages } from "../src/server/search"
import { SessionStore } from "../src/server/session/store"
import { Storage } from "../src/server/storage"
import { Bus } from "../src/server/bus"
import type { Message, ModelRef, ServerEvent, SessionInfo } from "@shared/protocol"

/** Every text source under a folder, as bytes, so control characters survive. */
async function sourceBytes(root: string): Promise<Map<string, Buffer>> {
  const found = new Map<string, Buffer>()
  const walk = async (directory: string) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (/\.(ts|tsx|vue|js|mjs|cjs|json|css|html)$/.test(entry.name)) found.set(full, await fs.readFile(full))
    }
  }
  await walk(root)
  return found
}

/** The body of one `app.on("<event>", ...)` listener in the main process, braces matched. */
function listenerBody(source: string, opening: string): string {
  const start = source.indexOf(opening)
  if (start < 0) return ""
  const open = source.indexOf("{", start)
  if (open < 0) return ""
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++
    else if (source[i] === "}") {
      depth--
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  return ""
}

export async function roundElevenChecks(check: Check, section: (name: string) => void): Promise<void> {
  const read = (file: string) => fs.readFile(path.join(process.cwd(), file), "utf8")

  section("Round 11 (N11-8): no stray control bytes in the sources")
  {
    // ripgrep treats a file with a NUL as binary and stops printing matches, so
    // everything after the first one is invisible to every search-based audit.
    const offenders: string[] = []
    for (const folder of ["src", "scripts"]) {
      for (const [file, bytes] of await sourceBytes(path.join(process.cwd(), folder))) {
        const at = bytes.indexOf(0)
        if (at >= 0) offenders.push(`${path.relative(process.cwd(), file)} @${at}`)
      }
    }
    check("no source file carries a raw NUL byte", offenders.length === 0, offenders)
  }

  section("Round 11 (N11-1/N11-33): an OS shutdown still closes the backend")
  {
    const main = await read("src/main/index.ts")
    const beforeQuit = listenerBody(main, 'app.on("before-quit", (event) => {')
    const guard = /if \((\w+)\) return/.exec(beforeQuit)?.[1] ?? ""
    check("before-quit guards on a flag of its own", guard === "closing", { guard })
    // The guard may only be raised inside before-quit; anywhere else and the teardown is skipped.
    const raisedOutside = guard ? main.split(`${guard} = true`).length - 1 - (beforeQuit.split(`${guard} = true`).length - 1) : -1
    check("and nothing outside before-quit raises that flag", raisedOutside === 0, { guard, raisedOutside })
    check(
      "session-end records an OS quit instead, and the close rule reads both",
      /window\.on\("session-end", \(\) => \{[^}]*noteOsQuit\(\)/.test(main) && /quitting: leaving\(\)/.test(main) && /const leaving = \(\) => osQuitting \|\| closing/.test(main),
    )
    check(
      "and the two cases with no window to hear session-end are covered",
      /powerMonitor\.on\("shutdown"/.test(main) && /onRecoveryGaveUp\(\(\) => \{/.test(main),
    )
    const recovery = await read("src/main/recovery.ts")
    check("recovery tells someone once it has given up", /renderer recovery gave up[\s\S]{0,120}gaveUp\?\.\(\)/.test(recovery))
    check("the teardown waits on the backend even while it is still starting (N11-30)", /startingBackend\.then\(/.test(main) && /startingBackend = starting/.test(main))
  }

  section("Round 11 (N11-2): the run queue's leases")
  {
    const queue = new RunQueue({ leaseMs: 1000, maxAttempts: 2 })
    const run = { runId: RunQueue.runIdFor("a", 100), automationID: "a", scheduledFor: 100, scheduleFingerprint: "daily:9:0", source: "schedule" as const }
    check("a run is queued once", queue.enqueue(run) === true && queue.enqueue(run) === false && queue.size === 1)
    check("a run that is not due yet is not handed out", queue.drain(50, 10).length === 0)
    const [first] = queue.drain(200, 10)
    check("a due run is handed out with a generation", first?.runId === run.runId && first?.deliveryGeneration === 1)
    check("and is not handed out again while its lease holds", queue.drain(201, 10).length === 0)
    check("a report from an earlier hand-out is ignored", queue.report(run.runId, 0, "settled") === false && queue.size === 1)
    check("a holder that says it will try later frees the entry without spending an attempt", queue.report(run.runId, 1, "later") === true && queue.drain(202, 10).length === 1)
    check("a lease that runs out frees the entry and spends an attempt", queue.releaseExpired(1300).map((entry) => entry.runId).join() === run.runId)
    check("once the attempts are used up the run is given up on rather than tried for ever", queue.drain(1400, 10).length === 1 && queue.releaseExpired(3000).length === 1 && queue.exhausted().length === 1 && queue.size === 0)

    const keep = new RunQueue()
    keep.enqueue({ runId: "r1", automationID: "a", scheduledFor: 1, scheduleFingerprint: "f", source: "schedule" })
    keep.drain(10, 5)
    const restored = new RunQueue()
    restored.restore(JSON.parse(JSON.stringify(keep.state)))
    check("a queue saved while a run was out comes back with that run deliverable again", restored.drain(11, 5).map((entry) => entry.runId).join() === "r1")
    check("MiMo's lease is fifteen minutes", LEASE_MS === 15 * 60_000 && MAX_ATTEMPTS === 3)
  }

  section("Round 11 (N11-2/N11-3): a run that cannot start is settled and said to be a failure")
  {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r11-auto-"))
    let clock = new Date(2026, 0, 2, 10, 0).getTime()
    const events: ServerEvent[] = []
    const model: ModelRef = { provider: "fake", model: "m" }
    const target: SessionInfo = {
      id: "ses_target",
      directory: temp,
      model,
      agent: "build",
      title: "Target",
      created: clock,
      updated: clock,
    } as unknown as SessionInfo
    let promptThrows: string | undefined
    let busy = false
    const deps: AutomationDeps = {
      file: path.join(temp, "automations.json"),
      now: () => clock,
      sessions: {
        get: async (id) => (id === target.id ? target : undefined),
        create: async () => target,
        messages: async (): Promise<Message[]> => [],
      },
      prompt: async () => {
        if (promptThrows) throw new Error(promptThrows)
      },
      busy: () => busy,
      models: () => [{ provider: "fake", id: "m", name: "Fake M" }],
      agent: () => "build",
      effort: () => undefined,
      scratch: async () => temp,
      publish: (event) => void events.push(event),
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

    // The run that will not start.
    promptThrows = "ENOSPC: no space left on device"
    clock = (service.dueAt(id) ?? 0) + 1000
    await service.tick()
    const failedRecord = service.list()[0]?.runHistory?.at(-1)
    check("a prompt that throws settles the run as failed rather than leaving it running", failedRecord?.status === "failed" && failedRecord?.error?.includes("ENOSPC") === true, failedRecord)
    const told = events.filter((event) => event.type === "automation.run" && event.phase === "finished")
    check("and the window is told it was a failure, not a completion", told.at(-1)?.type === "automation.run" && told.at(-1)?.outcome === "failed" && told.at(-1)?.notify === true, told.at(-1))
    check("the schedule still moved on rather than retrying the same minute for ever", (service.dueAt(id) ?? 0) > clock)

    // A run that waits for a busy conversation, until the next one comes due.
    promptThrows = undefined
    busy = true
    events.length = 0
    clock = (service.dueAt(id) ?? 0) + 1000
    await service.tick()
    check("a busy conversation makes the run wait and say so", events.some((event) => event.type === "automation.run" && event.phase === "queued"))
    const waitingRecords = service.list()[0]?.runHistory?.length ?? 0
    clock = (service.dueAt(id) ?? 0) + 1000
    await service.tick()
    const gaveUp = service.list()[0]?.runHistory?.at(-1)
    check(
      "and once the next run comes due the waiting one is given up on, recorded and reported",
      (service.list()[0]?.runHistory?.length ?? 0) > waitingRecords && gaveUp?.status === "skipped" && /stayed busy/.test(gaveUp?.error ?? ""),
      gaveUp,
    )
    await service.stop()

    // What is on disk is enough to start the waiting run again after a quit.
    const saved = JSON.parse(await fs.readFile(deps.file, "utf8")) as { runQueue?: { entries: unknown[] } }
    check("the queue is kept beside the tasks, so a quit does not lose a due run", Array.isArray(saved.runQueue?.entries), saved.runQueue)
    await fs.rm(temp, { recursive: true, force: true })
  }

  section("Round 11 (N11-6/N11-7): the shadow repository's lock and its timeout")
  {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r11-snap-"))
    const store = path.join(temp, "snapshot")
    const project = path.join(temp, "project")
    await fs.mkdir(project, { recursive: true })
    await fs.writeFile(path.join(project, "a.txt"), "one", "utf8")
    // The shadow repository only scans a project that is itself under version control.
    execFileSync("git", ["init", "-q"], { cwd: project, windowsHide: true })
    const snapshots = new Snapshots(store)

    // A turn is recording here, so the store may not be pulled out from under it.
    const recording = snapshots.begin(project)
    await recording.ready()
    check("a project being recorded refuses to have its store collected", (await snapshots.collect(project)) === false)
    check("and the store is still there", (await fs.readdir(store)).length > 0, await fs.readdir(store))

    await fs.writeFile(path.join(project, "a.txt"), "two", "utf8")
    const recorded = await recording.finish()
    check("the turn that held it is recorded as usual", recorded.unavailable === undefined && recorded.files.some((file) => file.path.endsWith("a.txt")), recorded)
    check("once nothing is recording, the store is collected", (await snapshots.collect(project)) === true && (await fs.readdir(store)).length === 0)

    /*
     * info/attributes is the sentinel: its presence is what says the store is
     * finished rather than half built. A store missing it is rebuilt from
     * scratch, which is exactly what a half-removed one needs.
     */
    const rebuilt = new Snapshots(store)
    const second = rebuilt.begin(project)
    await second.ready()
    await second.finish()
    const gitDir = (await fs.readdir(store)).find((entry) => !entry.endsWith(".json")) ?? ""
    await fs.rm(path.join(store, gitDir, "info", "attributes"), { force: true })
    await fs.rm(path.join(store, gitDir, "objects"), { recursive: true, force: true })
    const third = new Snapshots(store)
    const after = third.begin(project)
    await after.ready()
    await fs.writeFile(path.join(project, "a.txt"), "three", "utf8")
    const remade = await after.finish()
    check("a store whose sentinel is gone is built again rather than handed back broken", remade.unavailable === undefined, remade)

    const source = await read("src/server/session/snapshot.ts")
    const collectBody = source.slice(source.indexOf("async collect(directory: string)"))
    const sentinelAt = collectBody.indexOf('fs.rm(path.join(gitDir, "info", "attributes")')
    const wholeAt = collectBody.indexOf("fs.rm(gitDir, { recursive: true")
    check("and a collection removes that sentinel before anything else, so an interrupted one is recoverable", sentinelAt > 0 && wholeAt > sentinelAt, { sentinelAt, wholeAt })
    await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined)

    check(
      "every call the shadow repository makes is bounded, and the queue can be given up on",
      SNAPSHOT_GIT_TIMEOUT_MS > 0 && SNAPSHOT_QUEUE_TIMEOUT_MS > SNAPSHOT_GIT_TIMEOUT_MS && /child\.kill\(\)/.test(source) && /raceLock\(SNAPSHOT_QUEUE_TIMEOUT_MS/.test(source),
    )
    const handlers = await read("src/server/handlers.ts")
    check("and a delete waits for the turn it stopped before collecting its store", /await waitForIdle\(runtime, request\.sessionID\)/.test(handlers))
  }

  section("Round 11 (N11-5): the overlay's search goes through the index")
  {
    const made = (id: string, updated: number): SessionInfo => ({ id, directory: "/p", model: { provider: "fake", model: "m" }, agent: "build", title: id, created: 1, updated } as unknown as SessionInfo)
    const sessions = Array.from({ length: 300 }, (_, at) => made(`ses_${at}`, 1000 - at))
    const readFrom: string[] = []
    const load = async (sessionID: string): Promise<Message[]> => {
      readFrom.push(sessionID)
      const say = sessionID === "ses_7" || sessionID === "ses_250" ? "the needle is here" : "nothing of interest"
      return [{ id: `msg_${sessionID}`, sessionID, role: "user", text: say, time: { created: 1 } } as unknown as Message]
    }

    readFrom.length = 0
    const named = await searchMessages(sessions, load, "needle", 50, () => ["ses_7", "ses_250"])
    check("only the conversations the index names are read", readFrom.length === 2 && readFrom.includes("ses_250"), readFrom)
    check("and both of them are hits", named.map((hit) => hit.sessionID).sort().join() === "ses_250,ses_7", named)

    readFrom.length = 0
    const scanned = await searchMessages(sessions, load, "needle", 50, () => undefined)
    check("an index that cannot help falls back to a capped scan rather than the whole profile", readFrom.length === SCAN_LIMIT && SCAN_LIMIT < sessions.length, readFrom.length)
    check("and the fallback still finds what is inside the cap", scanned.some((hit) => hit.sessionID === "ses_7") && !scanned.some((hit) => hit.sessionID === "ses_250"), scanned)

    const handlers = await read("src/server/handlers.ts")
    check(
      "the handler hands the index to the search and stands back while it is still being filled",
      /history\.index\.building/.test(handlers) && /history\.index\.search\(\{ query, limit: SEARCH_HARD_CAP \}\)/.test(handlers),
    )
  }

  section("Round 11 (N11-5): the conversation list is read once")
  {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r11-store-"))
    const storage = new Storage(path.join(temp, "storage"))
    const store = new SessionStore(storage, new Bus())
    const model = { provider: "fake", model: "m" }
    const first = await store.create({ directory: temp, model, title: "one" })
    await store.create({ directory: temp, model, title: "two" })
    let reads = 0
    const realList = storage.listDirectories.bind(storage)
    storage.listDirectories = async (prefix: string) => {
      if (prefix === "session") reads++
      return realList(prefix)
    }
    await store.list()
    await store.list()
    await store.list()
    check("three calls read the folder once", reads === 1, reads)
    const copy = await store.list()
    copy[0]!.title = "edited in place"
    check("and what a caller is given is its own copy", (await store.list()).every((session) => session.title !== "edited in place"))
    await store.update(first.id, { title: "renamed" })
    await store.list()
    check("a record changing drops the cache", reads === 2, reads)
    check("and the new title is what comes back", (await store.list()).some((session) => session.title === "renamed"))
    await store.delete(first.id)
    check("a deletion drops it too", (await store.list()).length === 1 && reads === 3, reads)
    await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined)
  }

  section("Round 11 (N11-3): the four kinds of task notification")
  {
    check(
      "every kind survives the trip over IPC, and anything else is a completion",
      readTaskNotice({ kind: "failed", silent: false }).kind === "failed" &&
        readTaskNotice({ kind: "chat", silent: false }).kind === "chat" &&
        readTaskNotice({ kind: "confirm", silent: false }).kind === "confirm" &&
        readTaskNotice({ kind: "nonsense", silent: false }).kind === "done",
    )
    const main = await read("src/main/index.ts")
    check(
      "and each kind has a body of its own",
      /notify\.confirm/.test(main) && /notify\.failed/.test(main) && /notify\.chat/.test(main) && /notify\.done/.test(main),
    )
    const i18n = await read("src/renderer/src/lib/i18n.ts")
    const tables = (key: string) => i18n.split(`"${key}":`).length - 1
    check("both new strings are in all 18 tables and are sent to the main process", tables("notify.failed") === 18 && tables("notify.chat") === 18 && /"notify\.failed", "notify\.chat"/.test(i18n))
    const app = await read("src/renderer/src/App.vue")
    check(
      "a failed run is announced as a failure, and a conversation answering another one as a reply",
      /kind: notice\.failed \? "failed" : "done"/.test(app) && /kind: app\.answeredAnother\.has\(turn\.sessionID\) \? "chat" : "done"/.test(app),
    )
  }
}
