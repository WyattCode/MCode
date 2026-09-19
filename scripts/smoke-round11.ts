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
import { RATE_LIMIT_HINT_CAP, cooldownLeft, noteRateLimit, retryDecision, retryKind, waitFor, wakeWaiters } from "../src/server/session/retry"
import { cutLiveStreams, liveStreams, stallGuard } from "../src/server/provider/stall"
import { failureCode } from "../src/server/session/error-map"
import { ProviderHttpError } from "../src/server/provider/types"
import { Semaphore, STEP_TOOL_LIMIT, SUBAGENT_LIMIT } from "../src/server/session/semaphore"
import { onGitWaiting, queuedWrites, serialisedWrite } from "../src/server/git-queue"
import { checkoutFile, commit as gitCommit } from "../src/server/git"
import { withProjectLock } from "../src/server/session/snapshot"
import { authOnce } from "../src/server/mcp-oauth"
import { Shells } from "../src/server/shell"
import { Config } from "../src/server/config"
import { MAX_FRAME_BYTES } from "../src/server/index"
import { SqlDatabase, SQL_REQUEST_TIMEOUT_MS, STORE_PRAGMAS } from "../src/server/sql-worker"
import type { Message, ModelRef, ServerEvent, SessionInfo, ToolPart } from "@shared/protocol"
import { narrowcastSession } from "@shared/protocol"

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

  section("Round 11 (N11-4): a part at a time, to the windows that are drawing it")
  {
    const tool = (status: ToolPart["status"]): ToolPart => ({ type: "tool", id: "prt_1", callID: "call_1", name: "bash", status, time: { created: 1 } }) as unknown as ToolPart
    const part = (kind: "tool" | "text", status: ToolPart["status"]): ServerEvent =>
      kind === "tool"
        ? { type: "message.part.updated", sessionID: "ses_a", messageID: "msg_1", part: tool(status) }
        : { type: "message.part.updated", sessionID: "ses_a", messageID: "msg_1", part: { type: "text", id: "prt_2", text: "hi" } as unknown as ToolPart }
    check("a text delta only goes to the window drawing that conversation", narrowcastSession({ type: "message.delta", sessionID: "ses_a", messageID: "m", partID: "p", text: "x" }) === "ses_a")
    check("so does a running tool's output, which is the ten-a-second one", narrowcastSession(part("tool", "running")) === "ses_a" && narrowcastSession(part("tool", "pending")) === "ses_a")
    check(
      "a finished or failed call still goes to every window, because they act on it wherever it happened",
      narrowcastSession(part("tool", "completed")) === undefined && narrowcastSession(part("tool", "error")) === undefined,
    )
    check("and so does a part being announced, and the message itself", narrowcastSession(part("text", "running")) === undefined && narrowcastSession({ type: "session.idle", sessionID: "ses_a" }) === undefined)

    const runner = await read("src/server/session/runner.ts")
    const runTool = runner.slice(runner.indexOf("private async runTool("), runner.indexOf("private async runTool(") + 1200)
    check(
      "the runner sends the part that changed rather than cloning the whole message",
      /type: "message\.part\.updated", sessionID: assistant\.sessionID, messageID: assistant\.id, part: structuredClone\(part\)/.test(runTool) &&
        !/publish = \(\) => this\.bus\.publish\(\{ type: "message\.updated"/.test(runTool),
    )
    const index = await read("src/server/index.ts")
    check("and the socket only sends those to a window that named the conversation", /const only = narrowcastSession\(event\)/.test(index) && /watching\.get\(client\)/.test(index))
    const store = await read("src/renderer/src/stores/app.ts")
    check(
      "the window puts a part into the message it already holds, and says which conversations it is drawing",
      /case "message\.part\.updated"/.test(store) && /type: "session\.watch", sessionIDs: unique/.test(store),
    )
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
    // S13-4: a change is patched into the cache rather than dropping it, so the folder is not read again.
    check("a record changing is patched into the cache, not re-read", reads === 1, reads)
    check("and the new title is what comes back", (await store.list()).some((session) => session.title === "renamed"))
    await store.delete(first.id)
    check("a deletion is patched in too", (await store.list()).length === 1 && reads === 1, reads)
    await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined)
  }

  section("Round 11 (N11-19/N11-21): a provider's named wait, waited out once for everyone")
  {
    const long = retryDecision(new ProviderHttpError("slow down", 429, { "retry-after": "1500" }), 1, 0)
    check("a rate limit's own 25-minute wait is taken whole", long?.wait === 25 * 60_000, long)
    check("half an hour is the most a turn waits", RATE_LIMIT_HINT_CAP === 30 * 60_000 && retryDecision(new ProviderHttpError("x", 429, { "retry-after": "99999" }), 1, 0)?.wait === RATE_LIMIT_HINT_CAP)
    check("a server error's named wait is still held to its own ceiling", retryDecision(new ProviderHttpError("busy", 503, { "retry-after": "1500" }), 1, 0)?.wait === 30_000)
    const now = 1_000_000
    noteRateLimit("r11-provider", now + 40_000)
    noteRateLimit("r11-provider", now + 10_000)
    check("one conversation's 429 makes every conversation on that provider wait, for the longest it was told", cooldownLeft("r11-provider", now) === 40_000 && cooldownLeft("r11-other", now) === 0)
    check("and the wait lifts on its own", cooldownLeft("r11-provider", now + 40_001) === 0)
    const runner = await read("src/server/session/runner.ts")
    check("the runner holds off before sending and records what it is told", /const held = cooldownLeft\(assistant\.model\.provider\)/.test(runner) && /noteRateLimit\(assistant\.model\.provider, retry\.next\)/.test(runner))
    const row = await read("src/renderer/src/components/parts/RetryRow.vue")
    check("the retry row counts the wait down and offers to stop waiting", /harnessRow\.retryIn/.test(row) && /harnessRow\.stopWaiting/.test(row) && /emit\('stop'\)/.test(row))
    const stream = await read("src/renderer/src/components/MessageStream.vue")
    check("and stopping waiting stops the turn", /:next="row\.next" @stop="app\.abort\(shownID\)"/.test(stream))
  }

  section("Round 11 (N11-16): waking up ends the waiting")
  {
    const controller = new AbortController()
    const started = Date.now()
    const waiting = waitFor(60_000, controller.signal)
    wakeWaiters("r11 check")
    check("a wait between attempts ends as soon as the machine wakes or the network is back", (await waiting) === true && Date.now() - started < 5000)
    const stopped = new AbortController()
    const cut = waitFor(60_000, stopped.signal)
    stopped.abort()
    check("and Stop still ends one as a stop", (await cut) === false)

    const outer = new AbortController()
    const before = liveStreams()
    const guard = stallGuard(outer.signal, false)
    const tripped = cutLiveStreams("the machine woke")
    const failure = guard.failure(new Error("aborted"))
    guard.dispose()
    check("a provider stream open across a sleep is cut rather than waited on for eight minutes", tripped >= 1 && guard.signal.aborted, tripped)
    check("and the cut is a stream failure, which the retry ladder takes over", retryKind(failure) === "stream", String(failure))
    check("a guard that has finished is no longer held", liveStreams() === before, { before, after: liveStreams() })
    const main = await read("src/main/index.ts")
    const app = await read("src/renderer/src/App.vue")
    check("waking and the network coming back are both wired", /powerMonitor\.on\("resume", \(\) => woke\(/.test(main) && /ipcMain\.on\("mcode:network-back"/.test(main) && /addEventListener\("online", \(\) => window\.mcode\.networkBack\(\)\)/.test(app))
  }

  section("Round 11 (N11-18): an allowance used up is not a request too many")
  {
    const quota = failureCode(new ProviderHttpError('{"error":{"type":"usage_limit_reached","message":"You have reached your usage limit"}}', 429, {}))
    check("a used-up allowance says so", quota?.code === "error.quotaExceeded", quota)
    check("an OpenAI quota error too", failureCode(new ProviderHttpError("You exceeded your current quota, please check your plan and billing details.", 429, {}))?.code === "error.quotaExceeded")
    check("a plain 429 is still being asked to slow down", failureCode(new ProviderHttpError("Too many requests", 429, {}))?.code === "error.rateLimited")
    const i18n = await read("src/renderer/src/lib/i18n.ts")
    const tables = (key: string) => i18n.split(`"${key}":`).length - 1
    check("the three new strings are in all 18 tables", tables("error.quotaExceeded") === 18 && tables("harnessRow.retryIn") === 18 && tables("harnessRow.stopWaiting") === 18)
  }

  section("Round 11 (N11-17/N11-32): a window that reconnects is told what it missed")
  {
    const handlers = await read("src/server/handlers.ts")
    const store = await read("src/renderer/src/stores/app.ts")
    check("session.list replays the turns waiting between attempts", /retries: runtime\.runner\.retryRows\(\)/.test(handlers) && /noteRetries\(listed\.retries\)/.test(store) && /applyRetry\(sessionID, messages\.value\)/.test(store))
    const runner = await read("src/server/session/runner.ts")
    check("each text delta says where it belongs, and a window that missed one reads the transcript again", /const at = part\.text\.length/.test(runner) && /part\.text\.length !== event\.at/.test(store) && /noteDeltaGap\(event\.sessionID\)/.test(store))
  }

  section("Round 11 (N11-20): a gate on subagents, none on conversations")
  {
    const gate = new Semaphore(3)
    const releases: (() => void)[] = []
    for (let i = 0; i < 3; i++) releases.push(await gate.acquire())
    const queued = gate.acquire()
    const giveUp = new AbortController()
    const abandoned = gate.acquire(giveUp.signal).then(() => "granted", () => "left")
    check("past the permits, callers queue rather than being refused", gate.held === 3 && gate.waiting === 2)
    giveUp.abort()
    check("one stopped while it waits leaves the queue", (await abandoned) === "left" && gate.waiting === 1)
    releases.pop()!()
    const next = await queued
    check("and a permit given back goes to the next in line", gate.held === 3 && gate.waiting === 0)
    next()
    const cores = os.availableParallelism?.() ?? os.cpus().length
    check("MiMo's size: min(16, 2 x cores)", SUBAGENT_LIMIT === Math.max(1, Math.min(16, 2 * cores)) && STEP_TOOL_LIMIT === 8, { SUBAGENT_LIMIT, cores })
    const runner = await read("src/server/session/runner.ts")
    check(
      "a subagent's turn waits for a permit and gives it back; a step's calls run eight at a time",
      /release = await this\.subagentGate\.acquire\(controller\.signal\)/.test(runner) && /release\?\.\(\)/.test(runner) && /const calls = new Semaphore\(STEP_TOOL_LIMIT\)/.test(runner),
    )
    check("while a conversation's own turn takes no permit", !/subagentGate/.test(runner.slice(runner.indexOf("private launch("), runner.indexOf("private launch(") + 4000)))
  }

  section("Round 11 (N11-29/N11-30/N11-37): storage and what is kept per conversation")
  {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r11-tmp-"))
    const storage = new Storage(temp)
    await storage.write("session/a/info", { id: "a" })
    await fs.writeFile(path.join(temp, "session", "a", "info.json.4242.7.tmp"), "half", "utf8")
    await fs.writeFile(path.join(temp, "session", "a", `info.json.${process.pid}.9.tmp`), "mine", "utf8")
    const swept = await storage.sweepTemps()
    const left = await fs.readdir(path.join(temp, "session", "a"))
    check("a temp file another run left is swept, one of this run's and the document itself are not", swept === 1 && left.includes("info.json") && left.includes(`info.json.${process.pid}.9.tmp`) && !left.includes("info.json.4242.7.tmp"), left)
    await storage.write("session/a/info", { id: "a", fast: true }, { durable: false })
    check("a write that skips the flush still lands whole", JSON.stringify(await storage.read("session/a/info")) === JSON.stringify({ id: "a", fast: true }))
    await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined)
    const storageSource = await read("src/server/storage.ts")
    const runner = await read("src/server/session/runner.ts")
    check("only the streaming half-second saves skip the flush", /if \(durable\) await handle\.sync\(\)/.test(storageSource) && /void this\.store\.saveMessage\(assistant, true, false\)/.test(runner) && (runner.match(/saveMessage\([^)]*, false\)/g) ?? []).length === 1)
    const handlers = await read("src/server/handlers.ts")
    const forget = runner.slice(runner.indexOf("forgetSession(sessionID: string): void {"), runner.indexOf("forgetSession(sessionID: string): void {") + 500)
    check(
      "a deleted conversation's per-conversation state goes with it",
      ["turnPrune", "turnAgents", "prefixes", "taskQueues", "numbering"].every((field) => forget.includes(`this.${field}`)) && /runtime\.runner\.forgetSession\(request\.sessionID\)/.test(handlers),
    )
  }

  section("Round 11 (N11-14): git writes on one repository take turns")
  {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r11-git-"))
    const said: string[] = []
    onGitWaiting((directory, waiting) => said.push(`${path.basename(directory)}:${waiting}`))
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const order: string[] = []
    const first = serialisedWrite(temp, path.join(temp, "a"), async () => {
      await held
      order.push("first")
    })
    const second = serialisedWrite(temp, path.join(temp, "b"), async () => {
      order.push("second")
    })
    const elsewhere = serialisedWrite(path.join(temp, "other"), path.join(temp, "c"), async () => {
      order.push("elsewhere")
    })
    await elsewhere
    check("a write to another repository does not wait", order.join() === "elsewhere" && queuedWrites(temp) === 2)
    check("one queued behind another says it is waiting", said.includes("b:true") && !said.includes("a:true"), said)
    release()
    await Promise.all([first, second])
    check("and they run one after the other, then say so", order.join() === "elsewhere,first,second" && said.includes("b:false") && queuedWrites(temp) === 0, { order, said })
    onGitWaiting(undefined)

    // A commit that sweeps in unstaged work waits for a write already under way on that repository.
    const repo = path.join(temp, "repo")
    await fs.mkdir(repo)
    const g = (...args: string[]) => execFileSync("git", args, { cwd: repo, windowsHide: true })
    g("init", "-q")
    g("config", "user.email", "t@example.com")
    g("config", "user.name", "t")
    g("config", "commit.gpgsign", "false")
    await fs.writeFile(path.join(repo, "a.txt"), "one\n", "utf8")
    g("add", "-A")
    g("commit", "-q", "-m", "first")
    let letGo!: () => void
    const busy = serialisedWrite(repo, repo, () => new Promise<void>((resolve) => (letGo = resolve)))
    await fs.writeFile(path.join(repo, "a.txt"), "two\n", "utf8")
    let committed = false
    const committing = gitCommit(repo, "second", true).then((result) => {
      committed = true
      return result
    })
    await new Promise((resolve) => setTimeout(resolve, 400))
    check("a commit waits while another write on the repository is under way", committed === false)
    letGo()
    await busy
    check("and goes through once it is done", (await committing).ok === true)

    // Someone else's git holding index.lock is waited out rather than counted as a failure (N11-13).
    await fs.writeFile(path.join(repo, "a.txt"), "three\n", "utf8")
    const lock = path.join(repo, ".git", "index.lock")
    await fs.writeFile(lock, "", "utf8")
    const restoring = checkoutFile(repo, path.join(repo, "a.txt"))
    setTimeout(() => void fs.rm(lock, { force: true }), 300)
    check("a file put back through git waits out another git's index.lock", (await restoring) === true && (await fs.readFile(path.join(repo, "a.txt"), "utf8")).replace(/\r/g, "") === "two\n")
    await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined)
  }

  section("Round 11 (N11-13/N11-15): restores and photographs do not overlap")
  {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r11-lock-"))
    const project = path.join(temp, "project")
    await fs.mkdir(project)
    execFileSync("git", ["init", "-q"], { cwd: project, windowsHide: true })
    await fs.writeFile(path.join(project, "a.txt"), "one", "utf8")
    const snapshots = new Snapshots(path.join(temp, "store"))
    // Warmed up first, so the store exists and a photograph is quick; what is measured is only the wait.
    const warm = snapshots.begin(project)
    await warm.ready()
    await warm.finish()
    let letGo!: () => void
    const restoring = withProjectLock(project, () => new Promise<void>((resolve) => (letGo = resolve)))
    const recording = snapshots.begin(project)
    let opened = false
    void recording.ready().then(() => (opened = true))
    await new Promise((resolve) => setTimeout(resolve, 1500))
    check("a turn's opening photograph waits for a restore in progress", opened === false)
    letGo()
    await restoring
    await recording.ready()
    check("and is taken once it is over", opened === true)
    await recording.finish()
    await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined)

    const runner = await read("src/server/session/runner.ts")
    const revert = runner.slice(runner.indexOf("async revertTurn("), runner.indexOf("async revertTurn(") + 1200)
    check(
      "a turn's 撤销 refuses to take another conversation's later work, and writes under the project's lock",
      /await this\.guardOthers\(/.test(revert) && /withProjectLock\(session\.directory, \(\) => revertTurnFiles/.test(revert) && /this\.noteRestore\(/.test(revert) && /"error\.sessionBusy"/.test(revert),
    )
    check("undo and redo write under it too", /return directory \? withProjectLock\(directory, \(\) => this\.writeNow\(files, directory\)\)/.test(runner))
    const card = await read("src/renderer/src/components/InfoCommitCard.vue")
    const i18n = await read("src/renderer/src/lib/i18n.ts")
    check("the commit card says when it is waiting its turn", /app\.gitWaiting\.has\(props\.directory\)/.test(card) && i18n.split('"info.gitWaiting":').length - 1 === 18)
  }

  section("Round 11 (N11-10/N11-11/N11-26/N11-27/N11-35/N11-36): MCP under several conversations")
  {
    let renewals = 0
    let finish!: (value: "AUTHORIZED") => void
    const work = () => {
      renewals++
      return new Promise<"AUTHORIZED">((resolve) => (finish = resolve))
    }
    const first = authOnce("r11-server", work)
    const second = authOnce("r11-server", work)
    const other = authOnce("r11-elsewhere", async () => "AUTHORIZED")
    finish("AUTHORIZED")
    // Bounded, so a broken dedupe - whose first renewal is then never settled - fails here instead of hanging the run.
    const settled = <T,>(promise: Promise<T>) => Promise.race([promise, new Promise<string>((resolve) => setTimeout(() => resolve("timed out"), 2000))])
    check(
      "two 401s on one server renew once, and the second uses what the first got",
      (await settled(first)) === "AUTHORIZED" && (await settled(second)) === "AUTHORIZED" && renewals === 1 && (await other) === "AUTHORIZED",
      { renewals },
    )
    check("and a later one renews again", (await authOnce("r11-server", async () => "AUTHORIZED")) === "AUTHORIZED")

    const mcp = await read("src/server/mcp.ts")
    check(
      "a sampling request is asked in the conversation with a call in flight, and refused when that is not exactly one",
      !/activeSession/.test(mcp) && /sessionID: this\.askingSession/.test(mcp) && /this\.calling\.size === 1/.test(mcp) && /connection\.callingFrom\(context\.sessionID/.test(mcp),
    )
    const handlers = await read("src/server/handlers.ts")
    check("a deleted conversation's open questions are refused rather than left for ever", /runtime\.permissions\.rejectAll\(request\.sessionID\)/.test(handlers))
    check("a sign-in never reconnects a connection that is serving a call", /if \(connection\.busy\(\)\) return\s+await connection\.stop\(\)/.test(mcp))
    check("only the newest tools/list_changed refetch may set the list", /generation !== this\.toolsGeneration/.test(mcp) && /const generation = \+\+this\.toolsGeneration/.test(mcp))
    check("a folder with a turn running keeps its servers however long ago they were used", /working\.has\(key\)/.test(mcp) && /mcp\.useBusyDirectories\(\(\) => runner\.busyDirectories\(\)\)/.test(await read("src/server/index.ts")))
    const settings = await read("src/renderer/src/components/SettingsDialog.vue")
    const i18n = await read("src/renderer/src/lib/i18n.ts")
    check(
      "the MCP page says a saved change is waiting, offers to apply it now, and says why it cannot while a turn runs",
      /data-mcp-apply-now/.test(settings) && /type: "mcp\.applyNow"/.test(settings) && ["set.mcp.unapplied", "set.mcp.applyNow", "set.mcp.applyDoing", "set.mcp.applyDone", "set.mcp.applyBusy", "set.mcp.applyFailed"].every((key) => i18n.split(`"${key}":`).length - 1 === 18),
    )
    check("and apply-now keeps the rule: nothing is reconnected under a running turn", /if \(this\.busy\(\)\) return "busy"/.test(mcp))
  }

  section("Round 11 (N11-9/N11-31): each terminal owns its own shell")
  {
    const shells = new Shells(new Bus())
    const windowA = {}
    const windowB = {}
    const cwd = os.tmpdir()
    const drawer = shells.open("ses_r11", cwd, undefined, { cols: 80, rows: 24 }, windowA, "drawer")
    const panel = shells.open("ses_r11", cwd, undefined, { cols: 80, rows: 24 }, windowA, "panel")
    const listed = shells.list("ses_r11", windowA, "drawer").map((entry) => entry.shellID)
    check("the drawer lists its own shells and never the right panel's", listed.length === 1 && listed[0] === drawer && !listed.includes(panel), listed)
    check("and the panel's are its own too", shells.list("ses_r11", windowA, "panel").map((entry) => entry.shellID).join() === panel)
    check("a shell's output is for the window that owns it", shells.ownerOf(drawer) === windowA)
    shells.close(drawer, windowB)
    check("another window cannot close it", shells.list("ses_r11", windowA, "drawer").length === 1)
    shells.close(drawer, windowA)
    shells.close(panel, windowA)
    check("its owner can", shells.list("ses_r11", windowA, "drawer").length === 0 && shells.list("ses_r11", windowA, "panel").length === 0)
    await shells.closeAll()
    const index = await read("src/server/index.ts")
    check("the socket sends a terminal's output to its owner alone", /if \(shellOwner && shellOwner !== client\) continue/.test(index))
    const drawerSource = await read("src/renderer/src/components/TerminalDrawer.vue")
    const panelSource = await read("src/renderer/src/components/right/RpTerminal.vue")
    check("and each terminal says which it is", /surface: "drawer"/.test(drawerSource) && /surface="drawer"/.test(drawerSource) && /surface="panel"/.test(panelSource))
  }

  section("Round 11 (N11-34): a failed save does not take another save with it")
  {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r11-config-"))
    const storage = new Storage(path.join(temp, "storage"))
    const config = new Config(storage, new Bus(), path.join(temp, "credentials.json"))
    await storage.write("config", {})
    await config.load()
    let failNext = true
    const realWriteText = storage.writeText.bind(storage)
    storage.writeText = async (key, render) => {
      if (key === "config" && failNext) {
        failNext = false
        await new Promise((resolve) => setTimeout(resolve, 200))
        throw new Error("ENOSPC")
      }
      return realWriteText(key, render)
    }
    const failing = config.set({ language: "fr" }).then(() => "saved", () => "failed")
    const other = config.set({ taskDoneSound: "off" } as never).then(() => "saved", () => "failed")
    check("the save that failed fails, the one beside it lands", (await failing) === "failed" && (await other) === "saved")
    check("and what was held in memory kept the second change, without the first", config.get().language !== "fr" && (config.get() as { taskDoneSound?: string }).taskDoneSound === "off", { language: config.get().language })
    await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined)
  }

  section("Round 11 (N11-23/N11-24/N11-25/N11-38/N11-39/N11-40/N11-41): smaller ends")
  {
    const palette = await read("src/renderer/src/components/CommandPalette.vue")
    check("the file picker searches the project as the query changes, newest answer only", /type: "file\.search", directory, query: needle/.test(palette) && /ticket !== searchTicket/.test(palette))
    const handlers = await read("src/server/handlers.ts")
    check("file.list stops after a budget of entries, and the search budget is MiMo's", /visits < LIST_VISITS/.test(handlers) && /const SEARCH_VISITS = 4000/.test(handlers))
    const store = await read("src/renderer/src/stores/app.ts")
    check("a deleted conversation's draft and annotations go with it", /for \(const key of \[`main:\$\{sessionID\}`, `side:\$\{sessionID\}`\]\)/.test(store) && /forgetDrafts\(sessionID\)/.test(store))
    const sidebar = await read("src/renderer/src/components/Sidebar.vue")
    check("the collapsed side column's list is paged like the column's own", /v-for="session in recent"\s/.test(sidebar) && /data-quick-more/.test(sidebar))
    check("the socket states its frame limit", MAX_FRAME_BYTES === 100 * 1024 * 1024 && /maxPayload: MAX_FRAME_BYTES/.test(await read("src/server/index.ts")))
    check("the search index gives space back after a full rebuild", /this\.db\.exec\("VACUUM"/.test(await read("src/server/history/index.ts")))
    const preload = await read("src/preload/index.ts")
    check("file-change events use one listener however many views watch", /if \(!fileChangeHandlers\.size\) ipcRenderer\.on\("mcode:file-changed", relayFileChange\)/.test(preload))
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

  section("Round 11 (N11-12): SQLite on a thread of its own")
  {
    check(
      "MiMo's pragmas, and its whole set of them",
      STORE_PRAGMAS.join("; ") === "PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY",
      STORE_PRAGMAS,
    )
    check("a request gives up after MiMo's fifteen seconds", SQL_REQUEST_TIMEOUT_MS === 15_000)
    // The stores are rebuilt on this; each one opens through it and none keeps `node:sqlite` on the main thread.
    const history = await read("src/server/history/database.ts")
    const artifact = await read("src/server/artifact/store.ts")
    check(
      "both stores open through the worker and take the pragmas",
      /await SqlDatabase\.open\(/.test(history) && /STORE_PRAGMAS/.test(history) && /await SqlDatabase\.open\(/.test(artifact) && /for \(const pragma of STORE_PRAGMAS\)/.test(artifact),
    )
    check("the history search's transaction guards its statements through tx", /transaction<T>\(work: \(tx: Sql\)/.test(history))

    /*
     * A real database, in a real worker: statements land, a transaction's
     * statements wait for it, and closing ends the worker rather than leaving
     * a thread behind. The file lives in a folder of this run's own.
     */
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r11-sql-"))
    const database = await SqlDatabase.open(path.join(dir, "sql.db"))
    try {
      for (const pragma of STORE_PRAGMAS) await database.exec(pragma)
      const busy = await database.get<{ timeout: number }>("PRAGMA busy_timeout")
      const sync = await database.get<{ synchronous: number }>("PRAGMA synchronous")
      check("the pragmas reach the file", Number(Object.values(busy ?? {})[0]) === 5000 && Number(Object.values(sync ?? {})[0]) === 1, { busy, sync })
      await database.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL, n INTEGER NOT NULL)")
      await database.run("INSERT INTO notes (body, n) VALUES (?, ?)", "first", 1)
      check("a write answers with what SQLite changed", (await database.all<{ body: string }>("SELECT body FROM notes")).length === 1)
      // A transaction holds the database; a plain statement sent meanwhile waits its turn rather than interleaving.
      const held = await database.transaction(async (tx) => {
        await tx.run("INSERT INTO notes (body, n) VALUES (?, ?)", "inside", 2)
        await tx.run("INSERT INTO notes (body, n) VALUES (?, ?)", "inside2", 3)
        return (await tx.all<{ n: number }>("SELECT n FROM notes ORDER BY n")).length
      })
      await database.run("INSERT INTO notes (body, n) VALUES (?, ?)", "after", 4)
      const rows = await database.all<{ body: string }>("SELECT body FROM notes ORDER BY n")
      check("a transaction's work lands as one, and later statements queue behind it", held === 3 && rows.map((row) => row.body).join() === "first,inside,inside2,after", rows.map((row) => row.body))
      // A statement that fails rolls its transaction back and leaves no half of it.
      const before = await database.all<{ n: number }>("SELECT n FROM notes")
      const rolled = await database
        .transaction(async (tx) => {
          await tx.run("INSERT INTO notes (body, n) VALUES (?, ?)", "doomed", 5)
          throw new Error("no")
        })
        .then(() => false, () => true)
      check("a transaction that fails is rolled back whole", rolled && (await database.all<{ n: number }>("SELECT n FROM notes")).length === before.length)

      /*
       * The reason for the worker (N11-12): a statement that takes its time
       * must not hold the thread that streams turns and answers windows. A
       * recursive count runs in the worker while a one-millisecond timer on
       * this thread keeps ticking; synchronous SQLite here would stop it.
       */
      let ticks = 0
      const ticker = setInterval(() => ticks++, 1)
      const counted = await database.get<{ n: number }>(
        "WITH RECURSIVE count(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM count WHERE n < 4000000) SELECT count(*) AS n FROM count",
      )
      clearInterval(ticker)
      check("a long statement leaves this thread free to run", counted?.n === 4000001 && ticks > 5, { n: counted?.n, ticks })
    } finally {
      await database.close()
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  section("Round 11 (C11-15): a conversation a review took can't be continued")
  {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r11-rr-"))
    const storage = new Storage(path.join(temp, "storage"))
    const store = new SessionStore(storage, new Bus())
    const model = { provider: "fake", model: "m" }
    const session = await store.create({ directory: temp, model, title: "restricted" })
    check("a conversation starts unrestricted", session.reviewRestricted !== true)

    const before = session.updated
    const restricted = await store.setReviewRestricted(session.id, true)
    check("the mark lands and reads back", restricted.reviewRestricted === true && (await store.get(session.id))?.reviewRestricted === true)
    // Choosing the state is not activity, so the conversation must not climb the column, exactly as `setAccess` behaves.
    check("and it did not count as activity", restricted.updated === before, { before, after: restricted.updated })

    const lifted = await store.setReviewRestricted(session.id, false)
    check("lifting it deletes the field rather than writing false", lifted.reviewRestricted === undefined && !("reviewRestricted" in lifted))

    // An absent field has to read as unrestricted for every conversation stored before this existed.
    const fresh = await store.create({ directory: temp, model, title: "older" })
    const raw = await store.get(fresh.id)
    check("a conversation that never had the field is not restricted", raw?.reviewRestricted === undefined)

    // The request and its answer are part of the wire protocol, so a window can ask and a server can answer.
    const protocol = await fs.readFile(path.join(process.cwd(), "src/shared/protocol.ts"), "utf8")
    check("the request is on the wire", /type: "session\.reviewRestricted"; sessionID: string; restricted: boolean/.test(protocol))
    check("and it is answered with the conversation", /"session\.reviewRestricted": \{ session: SessionInfo \}/.test(protocol))

    // The server refuses a prompt into a restricted conversation, not the window alone.
    const handlers = await fs.readFile(path.join(process.cwd(), "src/server/handlers.ts"), "utf8")
    const prompt = handlers.slice(handlers.indexOf('case "session.prompt"'), handlers.indexOf('case "session.subtask"'))
    check(
      "asking a restricted conversation to continue is refused on the server",
      /reviewRestricted/.test(prompt) && /can't be continued/.test(prompt) && prompt.indexOf("reviewRestricted") < prompt.indexOf("runtime.runner.prompt"),
      prompt.slice(0, 200),
    )

    await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined)
  }

section("Round 11 (C11-13): a box that comes back with a draft takes the keyboard")
  {
    const composer = await fs.readFile(path.join(process.cwd(), "src/renderer/src/components/Composer.vue"), "utf8")
    // MiMo focuses the box and puts the caret at the end of what was kept; MCode had only the caret half, applied on restore.
    const at = composer.indexOf("onMounted(() => {")
    const mounted = composer.slice(at, at + 700)
    check("mounting focuses the box when there is a draft", /if \(text\.value\) void nextTick\(focus\)/.test(mounted), mounted.slice(0, 220))
    check("an empty box is left alone", !/nextTick\(focus\)/.test(mounted.replace("if (text.value) void nextTick(focus)", "")))
    const focusAt = composer.indexOf("function focus() {")
    const focusBody = composer.slice(focusAt, focusAt + 220)
    check(
      "the focus it takes puts the caret at the end",
      /box\.focus\(\{ preventScroll: true \}\)/.test(focusBody) && /setSelectionRange\(text\.value\.length, text\.value\.length\)/.test(focusBody),
      focusBody,
    )
  }
}
