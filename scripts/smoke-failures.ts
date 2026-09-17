/**
 * Round 6: the failures and edge cases audited on 2026-09-16 (F1 onwards).
 *
 * Kept apart from smoke.ts the way rounds five and six are, and called with its
 * check and section. Nothing here calls a model or reaches the network; the git
 * these checks drive is the one already on the machine, in a folder of its own.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import type { SessionInfo } from "../src/shared/protocol"
import { Snapshots } from "../src/server/session/snapshot"
import { AutomationService } from "../src/server/automation/service"
import { SessionStore } from "../src/server/session/store"
import { SessionChat } from "../src/server/session/chat"
import { Storage } from "../src/server/storage"
import { Config } from "../src/server/config"
import { Bus } from "../src/server/bus"
import { isContextOverflow, isOverflowError } from "../src/server/session/overflow"
import { retryDecision, retryKind } from "../src/server/session/retry"
import { ProviderError, ProviderHttpError } from "../src/server/provider/types"
import { interruptedEnd } from "../src/renderer/src/components/parts/turn-end"
import { BashTool, liveBashCommands, stopBashCommands } from "../src/server/tool/bash"
import type { ToolContext } from "../src/server/tool/types"
import { CronScheduler, type SchedulerHost } from "../src/server/cron/scheduler"
import { writeCronTasks, type CronTask } from "../src/server/cron/tasks"
import type { Check } from "./smoke-round5"

const exists = (target: string) =>
  fs
    .access(target)
    .then(() => true)
    .catch(() => false)

/**
 * What a file holds, or nothing.
 *
 * A check has to fail rather than throw: an exception here ends the whole run,
 * so every check after it stops being asked and its silence reads as a pass.
 */
const readOrNothing = (target: string | undefined): Promise<string | undefined> =>
  target ? fs.readFile(target, "utf8").catch(() => undefined) : Promise.resolve(undefined)

/**
 * The answer, or nothing when asking for it threw.
 *
 * The same rule as `readOrNothing`, for the calls under test: several of these
 * checks exist precisely because the old code rejected where it should have
 * carried on, so asking for the answer unguarded would end the run instead of
 * failing the one check - and every check after it would go silently unasked.
 */
const orNothing = <T>(work: Promise<T>): Promise<T | undefined> => work.then((value) => value, () => undefined)

/** The document a file holds, or nothing when it is absent or will not parse. */
async function parsedOrNothing<T>(target: string): Promise<T | undefined> {
  const raw = await readOrNothing(target)
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

/** A project git will record, with the files a turn is about to change. */
async function project(root: string, name: string, files: Record<string, string>): Promise<string> {
  const directory = path.join(root, name)
  await fs.mkdir(directory, { recursive: true })
  for (const [file, content] of Object.entries(files)) await fs.writeFile(path.join(directory, file), content, "utf8")
  execFileSync("git", ["init", "-q"], { cwd: directory })
  return directory
}

const names = (files: { path: string }[]) => files.map((file) => path.basename(file.path)).sort()

export async function failureChecks(check: Check, section: (name: string) => void): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r6-failures-"))

  // ------------------------------------------------------------------- F1
  section("Round 6 (F1): a turn's undo holds only what that turn changed")
  {
    const directory = await project(root, "shared", { "a.txt": "a0", "b.txt": "b0", "c.txt": "c0" })
    const snapshots = new Snapshots(path.join(root, "store"))
    const at = (file: string) => path.join(directory, file)

    /*
     * Two conversations mid-turn in one project. Before this the recorder
     * photographed the whole project at the start and the end of each turn, so
     * either turn's undo would have written back the other's file as well - and
     * reported a file count that looked like a clean rollback.
     */
    const first = snapshots.begin(directory)
    await first.ready()
    const second = snapshots.begin(directory)
    await second.ready()
    await fs.writeFile(at("a.txt"), "a1", "utf8")
    first.claim(at("a.txt"))
    await fs.writeFile(at("b.txt"), "b1", "utf8")
    second.claim(at("b.txt"))
    const one = await first.finish()
    const two = await second.finish()
    check("a turn records the file its own tool wrote", names(one.files).join(",") === "a.txt", one)
    check("and not the file the other conversation wrote at the same time", one.files.length === 1, names(one.files))
    check("the other conversation's turn records its own file too", names(two.files).join(",") === "b.txt", two)
    /*
     * Read back through the checkpoint store rather than off the snapshot: a
     * recording now holds a reference where it used to hold the body. This
     * asserts the same thing it always did, one step further along - that the
     * reference resolves to the bytes the turn opened on.
     */
    const opened = async (files: { blob?: string | null }[]) => {
      const blob = files[0]?.blob
      return typeof blob === "string" ? (await snapshots.fetch(directory, blob))?.toString("utf8") : undefined
    }
    check("what each turn recorded is the state it opened on", (await opened(one.files)) === "a0" && (await opened(two.files)) === "b0", [
      one.files[0],
      two.files[0],
    ])

    /* A change while both were watching that neither tool named: refused, not guessed at. */
    const third = snapshots.begin(directory)
    await third.ready()
    const fourth = snapshots.begin(directory)
    await fourth.ready()
    third.opaque()
    fourth.opaque()
    await fs.writeFile(at("c.txt"), "c1", "utf8")
    const contested = await third.finish()
    await fourth.finish()
    check("a change neither conversation can account for is refused rather than claimed", Boolean(contested.refused) && contested.files.length === 0, contested)
    check("the refusal says another conversation was writing", (contested.refused ?? "").includes("Another conversation"), contested.refused)

    /* One turn alone in the project still records everything, shell commands included. */
    const alone = snapshots.begin(directory)
    await alone.ready()
    alone.opaque()
    await fs.writeFile(at("a.txt"), "a2", "utf8")
    const solo = await alone.finish()
    check("a turn with the project to itself still records what nothing reported", names(solo.files).join(",") === "a.txt" && !solo.refused, solo)
  }

  // ------------------------------------------------------------------- F1
  section("Round 6 (F1): undo refuses once another conversation has written the same file")
  {
    const store = path.join(root, "ledger")
    const snapshots = new Snapshots(store)
    const directory = path.join(root, "ledger-project")
    const file = path.join(directory, "shared.txt")

    await snapshots.wrote(directory, "ses_a", 1000, [file])
    check("a conversation's own write is never in its own way", (await snapshots.writtenSince(directory, "ses_a", 900, [file])).length === 0)
    await snapshots.wrote(directory, "ses_b", 2000, [file])
    check("another conversation writing since the turn is named", (await snapshots.writtenSince(directory, "ses_a", 1000, [file]))[0] === file)
    check("a write that came before the turn does not stand in its way", (await snapshots.writtenSince(directory, "ses_a", 3000, [file])).length === 0)
    check("a file nobody else touched is still restorable", (await snapshots.writtenSince(directory, "ses_a", 1000, [path.join(directory, "other.txt")])).length === 0)
    /* Written where the shadow repositories live, so the refusal survives a restart. */
    check("the ledger is read back after a restart", (await new Snapshots(store).writtenSince(directory, "ses_a", 1000, [file]))[0] === file)
  }

  // ------------------------------------------------------------------- F2
  section("Round 6 (F2): a damaged automations.json blocks rather than emptying")
  {
    const directory = path.join(root, "automations")
    await fs.mkdir(directory, { recursive: true })
    const file = path.join(directory, "automations.json")
    /* A write that was cut off part way, which is how this happens for real. */
    const damaged = '{"automations":[{"id":"auto-1","title":"Daily dig'
    await fs.writeFile(file, damaged, "utf8")

    const caller = { id: "ses_1", directory, model: { provider: "p", model: "m" } } as unknown as SessionInfo
    const service = new AutomationService({
      file,
      now: () => Date.UTC(2026, 0, 1),
      sessions: { get: async () => caller, create: async () => caller, messages: async () => [] },
      prompt: async () => undefined,
      busy: () => false,
      models: () => [],
      agent: () => "build",
      effort: () => undefined,
      scratch: async () => directory,
      publish: () => {},
    })
    await service.start({ interval: false })
    check("a file that will not parse starts with no tasks", service.list().length === 0)
    check("and says so rather than starting empty in silence", Boolean(service.unreadable.problem), service.unreadable)

    const kept = (await fs.readdir(directory)).filter((name) => name.includes(".corrupt-"))
    check("the damaged file is kept as evidence rather than written over", kept.length === 1, kept)
    check("and keeps every byte it had", kept[0] !== undefined && (await fs.readFile(path.join(directory, kept[0]), "utf8")) === damaged)

    /* The next change used to write the empty document straight over the damaged one. */
    await service.handle(
      { mode: "create", title: "Daily digest", prompt: "Summarise", rrule: "RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0" },
      { sessionID: caller.id },
    )
    const written = await parsedOrNothing<{ automations: unknown[] }>(file)
    check("a later change writes a fresh file, leaving the evidence alone", written?.automations.length === 1, written)
    check("the evidence is still there afterwards", (await fs.readdir(directory)).filter((name) => name.includes(".corrupt-")).length === 1)
  }

  // ------------------------------------------------------------------- F3
  section("Round 6 (F3): a damaged config.json does not stop the backend")
  {
    const dataDirectory = path.join(root, "config-app")
    const storageRoot = path.join(dataDirectory, "storage")
    await fs.mkdir(storageRoot, { recursive: true })
    const damaged = '{"theme":"dark","model":{"provider":"anthropic"'
    await fs.writeFile(path.join(storageRoot, "config.json"), damaged, "utf8")

    const config = new Config(new Storage(storageRoot), new Bus(), path.join(dataDirectory, "credentials.json"))
    let threw = false
    await config.load().catch(() => (threw = true))
    check("a config that will not parse does not take the backend down with it", !threw)
    check("and says what went wrong", Boolean(config.unreadable?.problem), config.unreadable)
    check("the damaged file is kept rather than written over", Boolean(config.unreadable?.evidence) && (await exists(config.unreadable?.evidence ?? "")))
    check("its bytes are the ones that were there", (await readOrNothing(config.unreadable?.evidence)) === damaged)
    /*
     * The trap: a file that is there but cannot be read is not a fresh install.
     * Answering one with the first-install permissions would quietly change
     * what this machine allows without anybody choosing it.
     */
    check(
      "a file that could not be read is not treated as a first install",
      config.get().allowFullAccess === false && config.get().accessLevel === undefined,
      { allowFullAccess: config.get().allowFullAccess, accessLevel: config.get().accessLevel },
    )
    check("the app opens on the defaults", config.get().theme === "system")
  }

  // ------------------------------------------------------------------- F4
  section("Round 6 (F4): one damaged conversation does not cost the whole list")
  {
    const storageRoot = path.join(root, "sessions", "storage")
    const record = (id: string, updated: number) =>
      JSON.stringify({ id, title: id, directory: root, model: { provider: "p", model: "m" }, agent: "build", created: 1, updated })
    const write = async (id: string, body: string) => {
      await fs.mkdir(path.join(storageRoot, "session", id), { recursive: true })
      await fs.writeFile(path.join(storageRoot, "session", id, "info.json"), body, "utf8")
    }
    await write("ses_a", record("ses_a", 2))
    await write("ses_b", '{"id":"ses_b","title":"cut off part way"')
    await write("ses_c", record("ses_c", 3))

    const store = new SessionStore(new Storage(storageRoot), new Bus())
    const listed = (await orNothing(store.list()))?.map((session) => session.id)
    check("a conversation whose record will not parse is skipped, not thrown", listed?.join(",") === "ses_c,ses_a", listed)
    check("every readable conversation is still listed", listed?.length === 2, listed)
    let asked = false
    await store.require("ses_b").catch(() => (asked = true))
    check("asking for the damaged conversation by id still says so", asked)
  }

  // ------------------------------------------------------------------ F11
  section("Round 6 (F11): a 413 that carries a body is still an overflow")
  {
    /* The ordinary shape: a status and a JSON body whose wording matches no phrasing here. */
    const withBody = new ProviderHttpError('Request failed (413). {"error":{"message":"too large"}}', 413, {}, undefined)
    check("the sentence alone does not read as an overflow", !isContextOverflow(withBody.message))
    check("but the status does", isOverflowError(withBody, withBody.message))
    const coded = new ProviderError("the provider refused", undefined, undefined, { code: "context_length_exceeded" })
    check("so does the body's own code", isOverflowError(coded, coded.message))
    const bare = new ProviderHttpError("413 (no body)", 413, {}, undefined)
    check("a bare 413 still reads as one", isOverflowError(bare, bare.message))
    const other = new ProviderHttpError("Request failed (500). upstream died", 500, {}, undefined)
    check("an ordinary server failure is not an overflow", !isOverflowError(other, other.message))
    /* An overflow is never retried - it is compacted and replayed instead. */
    check("an overflow with a body is not sent again", retryDecision(withBody, 1, 0) === undefined)
  }

  // ------------------------------------------------------------------ F41
  section("Round 6 (F41): GPT overload is read off the body, not the wording")
  {
    const overloaded = new ProviderHttpError("service unavailable", 503, {}, { type: "service_unavailable_error", code: "server_is_overloaded" })
    const first = retryDecision(overloaded, 1, 0)
    check("a real overload is tried again at once", first?.wait === 0 && first?.kind === "server", first)
    check("and three times at most", first?.max === 3, first)
    /* A failure that merely mentions the words is an ordinary server error. */
    const lookalike = new ProviderHttpError("upstream log said server_is_overloaded earlier", 503, {}, undefined)
    const plain = retryDecision(lookalike, 1, 0)
    check("a failure that only mentions the words keeps the full server budget", plain?.max === 8, plain)
    check("and waits rather than retrying at once", (plain?.wait ?? 0) > 0, plain)
  }

  // -------------------------------------------------------------- F12, F13
  section("Round 6 (F12, F13): a gateway's 404 and 409 are waited out, not fatal")
  {
    /* A gateway rotating models answers 404 in passing; MiMo retries those on the unknown budget. */
    const missing = new ProviderHttpError("model not found", 404, {}, undefined)
    check("an OpenAI-compatible 404 is retried rather than ending the turn", retryKind(missing) === "unknown", retryKind(missing))
    check("it gets eight attempts", retryDecision(missing, 8, 0) !== undefined && retryDecision(missing, 9, 0) === undefined)
    check("over a quarter of an hour", retryDecision(missing, 1, 15 * 60_000) === undefined)
    /* A 404 that did not come from that family of adapters still means the model is absent. */
    const absent = new ProviderError("no such model", undefined, undefined, undefined)
    check("a 404 from anywhere else stays final", retryKind(absent) === undefined)

    /* Some gateways answer 409 when their concurrency limit is reached. */
    const busy = new ProviderHttpError("too many concurrent requests", 409, {}, undefined)
    check("a 409 is waited out instead of failing at once", retryKind(busy) === "unknown", retryKind(busy))
    check("and takes the same eight attempts", retryDecision(busy, 8, 0) !== undefined && retryDecision(busy, 9, 0) === undefined)

    /* The kinds that were already right are unchanged. */
    check("a refused key is still final", retryKind(new ProviderHttpError("no", 401, {})) === undefined)
    check("a 500 is still a server error", retryKind(new ProviderHttpError("no", 500, {})) === "server")
    check("a 429 is still a rate limit", retryKind(new ProviderHttpError("no", 429, {})) === "rate_limit")
  }

  // ------------------------------------------------------------------ F28
  section("Round 6 (F28): a dropped socket says so in the reader's language")
  {
    /*
     * These rejections are shown as the body of a notice, so a sentence written
     * in the client surfaced as English in an otherwise translated interface.
     * MiMo answers this case from its error table; the wording MCode already
     * carries for it is error.network, so no new key was needed.
     */
    const client = (await readOrNothing(path.join(process.cwd(), "src/renderer/src/lib/client.ts"))) ?? ""
    check("the lost-connection sentence is no longer written in English in the client", !client.includes("Lost connection to the backend"))
    check("it is phrased through the language tables instead", client.includes('t("error.network")'))
    const tables = (await readOrNothing(path.join(process.cwd(), "src/renderer/src/lib/i18n.ts"))) ?? ""
    const defined = (tables.match(/"error\.network":/g) ?? []).length
    check("and that key is defined in all eighteen tables", defined === 18, defined)
  }

  /**
   * The source of one function, from its opening line to the next landmark.
   *
   * These four failures are all "the promise was let go": what is checked is
   * that the call site now has somewhere for a rejection to land, which is a
   * property of the file rather than of a value a test can hold.
   */
  const between = (text: string, from: string, to: string): string => {
    const start = text.indexOf(from)
    const end = start < 0 ? -1 : text.indexOf(to, start + from.length)
    return start < 0 || end < 0 ? "" : text.slice(start, end)
  }
  const sourceOf = (file: string) => readOrNothing(path.join(process.cwd(), file))
  const tables = (await sourceOf("src/renderer/src/lib/i18n.ts")) ?? ""
  const definedIn = (key: string) => tables.split(`"${key}":`).length - 1

  // ----------------------------------------------------------------- F16, F19
  section("Round 6 (F16, F19): a stop that did not land, and a connection coming back")
  {
    const app = (await sourceOf("src/renderer/src/stores/app.ts")) ?? ""
    const abort = between(app, "async function abort(", "async function resume(")
    check("a stop is tried again before it is given up on", /ABORT_TRIES = 3/.test(app) && /ABORT_GAP = 400/.test(app))
    check("the loop is the one the stop runs", abort.includes("attempt <= ABORT_TRIES"), abort.length)
    check("a stop that never reached the backend is reported rather than dropped", abort.includes('t("error.abortFailed")'))
    check("its wording exists in all eighteen tables", definedIn("error.abortFailed") === 18, definedIn("error.abortFailed"))

    check("a socket that dropped says the connection is coming back", app.includes('notice.warning(t("error.connectionRecovering")'))
    check("the notice stays until it is", app.includes("duration: 0"))
    check("and goes when the socket returns", app.includes("notice.dismiss(RECONNECT_TOAST)"))
    check("that wording exists in all eighteen tables too", definedIn("error.connectionRecovering") === 18, definedIn("error.connectionRecovering"))
  }

  // ----------------------------------------------------------------------- F17
  section("Round 6 (F17): an answer and a blanket approval that failed to send")
  {
    const questions = (await sourceOf("src/renderer/src/stores/questions.ts")) ?? ""
    const reply = between(questions, "async function reply(", "function dismiss(")
    check("an answer that could not be submitted is reported", reply.includes('t("error.questionReplyFailed")'), reply.length)
    check("the form is still freed either way", reply.includes("} finally {"))
    const allow = between(questions, "function allowOnce(", "function allowTask(")
    check("a blanket approval that did not land is reported", allow.includes('t("error.autoPermissionFailed")'), allow.length)
    check("and is rolled back so the next pass asks again", allow.includes("autoAnswered.delete(requestID)"))
    check("both wordings exist in all eighteen tables", definedIn("error.questionReplyFailed") === 18 && definedIn("error.autoPermissionFailed") === 18)
  }

  // ----------------------------------------------------------------------- F18
  section("Round 6 (F18): a turn killed mid-stream says so")
  {
    const reply = { last: {} }
    check("a reply whose finish was never written reads as interrupted", interruptedEnd(reply, false))
    check("but not while the turn is still being worked on", !interruptedEnd(reply, true))
    check("a turn that ended normally is not", !interruptedEnd({ ...reply, finish: "stop" }, false))
    check("a stop keeps its own line", !interruptedEnd({ ...reply, finish: "aborted" }, false))
    check("a failure keeps its card", !interruptedEnd({ ...reply, error: "the provider refused" }, false))
    check("a question that never got a reply at all is not drawn as one", !interruptedEnd({}, false))

    const stream = (await sourceOf("src/renderer/src/components/MessageStream.vue")) ?? ""
    check("the conversation draws the line for it", stream.includes("interrupted(turn, at)") && stream.includes("finishedNote(turn, at)"))
    check("its wording exists in all eighteen tables", definedIn("stream.interrupted") === 18, definedIn("stream.interrupted"))
  }

  // ------------------------------------------------------------------- F5
  section("Round 6 (F5): a run the app died in the middle of is not forgotten")
  {
    const directory = path.join(root, "automation-runs")
    await fs.mkdir(directory, { recursive: true })
    const file = path.join(directory, "automations.json")
    const caller = { id: "ses_run", directory, model: { provider: "p", model: "m" } } as unknown as SessionInfo
    /* The rule's hour is the machine's, so the clock is moved by whole days rather than to an hour. */
    const day = 24 * 60 * 60 * 1000
    const opened = Date.UTC(2026, 0, 1, 8, 0)
    let clock = opened
    const published: { type: string; sessionID: string; phase?: string; notify?: boolean }[] = []
    const deps = () => ({
      file,
      now: () => clock,
      sessions: { get: async () => caller, create: async () => caller, messages: async () => [] },
      prompt: async () => undefined,
      busy: () => false,
      models: () => [],
      agent: () => "build" as const,
      effort: () => undefined,
      scratch: async () => directory,
      publish: (event: { type: string; sessionID?: string }) => published.push(event as { type: string; sessionID: string }),
    })
    const settled = () => new Promise((resolve) => setTimeout(resolve, 60))
    const historyOf = async () => {
      const saved = await parsedOrNothing<{ automations: { runHistory?: { status: string; error?: string; hasNonEmptyReply?: boolean }[] }[] }>(file)
      return saved?.automations[0]?.runHistory ?? []
    }

    const first = new AutomationService(deps() as unknown as ConstructorParameters<typeof AutomationService>[0])
    await first.start({ interval: false })
    await first.handle({ mode: "create", title: "Daily digest", prompt: "Summarise", rrule: "RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0" }, { sessionID: caller.id })
    clock = opened + 2 * day
    await first.tick()
    await settled()
    check("a run is written down as it starts", (await historyOf())[0]?.status === "running", await historyOf())

    /* The app is killed here: stop() never runs, so the record is left open. */
    const second = new AutomationService(deps() as unknown as ConstructorParameters<typeof AutomationService>[0])
    published.length = 0
    await second.start({ interval: false })
    await settled()
    const replayed = await historyOf()
    check("the next start settles it rather than leaving it hanging", replayed[0]?.status === "skipped", replayed)
    check("and says why", (replayed[0]?.error ?? "").includes("closed before the run finished"), replayed[0])
    await second.tick()
    check("the user is told about the run that did not finish", published.some((event) => event.type === "automation.run" && event.phase === "finished" && event.notify === true), published)
    await second.tick()
    check("and told once, not on every check", published.filter((event) => event.phase === "finished").length === 1, published.length)

    /* A run that ends properly settles itself, and is not reported twice. */
    clock = opened + 3 * day
    published.length = 0
    await second.tick()
    await settled()
    check("a later run opens a record of its own", (await historyOf()).length === 2, await historyOf())
    await second.turnEnded(caller.id)
    await settled()
    const ended = await historyOf()
    check("a turn that ended settles its own record", ended[1]?.status === "failed" || ended[1]?.status === "succeeded", ended[1])
    const third = new AutomationService(deps() as unknown as ConstructorParameters<typeof AutomationService>[0])
    published.length = 0
    await third.start({ interval: false })
    await third.tick()
    check("a run that finished is not reported again at the next start", published.filter((event) => event.phase === "finished").length === 0, published)
    await third.stop()
  }

  // ------------------------------------------------------------------- F6
  section("Round 6 (F6): a recurring task whose time passed while the app was closed")
  {
    const day = 24 * 60 * 60 * 1000
    const nine = Date.UTC(2026, 0, 10, 9, 0)
    const owner = { id: "ses_owner", title: "owner", directory: "", agent: "build", created: 0, updated: 0 } as unknown as SessionInfo

    /** One project, one daily task, and a clock the check moves by hand. */
    const daily = async (name: string, lastFiredAt: number, now: number) => {
      const project = path.join(root, name)
      await fs.mkdir(project, { recursive: true })
      const task: CronTask = { id: "daily", cron: "0 9 * * *", prompt: "Morning digest", createdAt: lastFiredAt, recurring: true, lastFiredAt, createdBySessionId: owner.id }
      await writeCronTasks(project, [task])
      const fired: string[] = []
      let clock = now
      const host: SchedulerHost = {
        now: () => clock,
        fire: async (sessionID) => {
          fired.push(sessionID)
        },
        busy: () => false,
        session: async (id) => (id === owner.id ? { ...owner, directory: project } : undefined),
        create: async () => ({ ...owner, directory: project }),
        directories: async () => [project],
      }
      const scheduler = new CronScheduler(host)
      await scheduler.start({ interval: false })
      return { fired, scheduler, advance: (by: number) => (clock += by) }
    }

    /* Yesterday's run happened; today's 09:00 went by with the app closed. */
    const missed = await daily("cron-missed", nine - day, nine + 5 * 60 * 60 * 1000)
    await missed.scheduler.tick()
    check("the occurrence missed while the app was closed is run", missed.fired.length === 1, missed.fired)
    await missed.scheduler.tick()
    check("and only the once - the schedule moves on from now", missed.fired.length === 1, missed.fired)
    /* Tomorrow's 09:00 still comes. */
    missed.advance(day)
    await missed.scheduler.tick()
    check("the next day's run still happens", missed.fired.length === 2, missed.fired)
    await missed.scheduler.stop()

    /* A fortnight away is still one run, not fourteen. */
    const long = await daily("cron-fortnight", nine - 14 * day, nine + 5 * 60 * 60 * 1000)
    await long.scheduler.tick()
    await long.scheduler.tick()
    await long.scheduler.tick()
    check("a fortnight of missed occurrences fires once, not once each", long.fired.length === 1, long.fired)
    await long.scheduler.stop()

    /* And a task whose time has simply not come does not run early. */
    const early = await daily("cron-early", nine, nine + 60 * 60 * 1000)
    await early.scheduler.tick()
    check("a task whose next time is still ahead does not run early", early.fired.length === 0, early.fired)
    await early.scheduler.stop()
  }

  // ------------------------------------------------------------------- F9
  section("Round 6 (F9): a message between conversations survives the quit")
  {
    const storageRoot = path.join(root, "chat-queue", "storage")
    const storage = new Storage(storageRoot)
    const bus = new Bus()
    const store = new SessionStore(storage, bus)
    const model = { provider: "p", model: "m" }
    const first = await store.create({ directory: root, title: "Caller", model })
    const second = await store.create({ directory: root, title: "Target", model })

    const prompted: { sessionID: string; text: string }[] = []
    let targetBusy = true
    const turns = {
      isRunning: (sessionID: string) => sessionID === second.id && targetBusy,
      prompt: async (input: { sessionID: string; text: string }) => {
        prompted.push(input)
        return "msg_probe"
      },
      create: async () => first,
    }
    const queueFile = path.join(storageRoot, "chat-queue.json")

    const chat = new SessionChat(store, bus, turns as never, 50, storage)
    const sent = await chat.talk({ from: first.id, contactID: second.id, message: "PROBE please look", mode: "async" })
    check("a message to a conversation that is working is queued", sent.status === "queued", sent)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const saved = await parsedOrNothing<{ entries?: { text?: string; state?: string }[] }>(queueFile)
    check("and is written down rather than living only in memory", saved?.entries?.[0]?.text === "PROBE please look", saved)
    check("with the state it was in", saved?.entries?.[0]?.state === "waiting", saved?.entries?.[0])

    /* The app goes away here, and a later run reads what was in flight. */
    targetBusy = false
    const later = new SessionChat(store, bus, turns as never, 50, storage)
    await later.restore()
    check("a message that never started is delivered on the next run", prompted.some((entry) => entry.sessionID === second.id && entry.text === "PROBE please look"), prompted)

    /* One that was already being worked on cannot be resumed: its caller is told. */
    prompted.length = 0
    await storage.write("chat-queue", {
      entries: [{ target: second.id, targetTitle: "Target", from: first.id, fromTitle: "Caller", text: "PROBE was running", hop: 1, kind: "request", state: "running", at: Date.now() }],
    })
    const third = new SessionChat(store, bus, turns as never, 50, storage)
    await third.restore()
    await new Promise((resolve) => setTimeout(resolve, 50))
    check("a message whose turn the app outlived comes back to its caller", prompted.some((entry) => entry.sessionID === first.id && entry.text.includes("没能取到回复")), prompted)
    check("and says the app closed rather than blaming the other conversation", prompted.some((entry) => entry.text.includes("对方处理这条消息时应用关闭了")), prompted)

    /* A message older than a day is not delivered out of the blue. */
    prompted.length = 0
    await storage.write("chat-queue", {
      entries: [{ target: second.id, targetTitle: "Target", from: first.id, fromTitle: "Caller", text: "PROBE stale", hop: 1, kind: "request", state: "waiting", at: Date.now() - 48 * 60 * 60 * 1000 }],
    })
    const fourth = new SessionChat(store, bus, turns as never, 50, storage)
    await fourth.restore()
    await new Promise((resolve) => setTimeout(resolve, 50))
    check("a day-old message is left alone rather than sent out of the blue", !prompted.some((entry) => entry.text.includes("PROBE stale")), prompted)
  }

  // ------------------------------------------------------------------- F7
  section("Round 6 (F7): a command still running at quit is ended with it")
  {
    /*
     * A real child, because the whole point is the process tree: the turn's
     * abort listener and the command's own timeout were the only two things
     * that ever ended one, and quitting reaches neither.
     */
    const context = {
      sessionID: "ses_bash",
      messageID: "msg_1",
      callID: "call_1",
      directory: root,
      permissions: { ask: async () => undefined },
      questions: { ask: async () => undefined },
      signal: new AbortController().signal,
      progress: () => {},
      snapshot: async () => undefined,
    } as unknown as ToolContext

    const before = liveBashCommands()
    const run = BashTool.execute({ command: 'node -e "setTimeout(() => {}, 60000)"', timeout: 60_000 }, context)
    let settled = false
    const done = run.then(
      () => (settled = true),
      () => (settled = true),
    )
    await new Promise((resolve) => setTimeout(resolve, 1200))
    check("a command is held while it runs", liveBashCommands() === before + 1, liveBashCommands())
    check("and a minute-long one has not ended by itself", !settled)

    const at = Date.now()
    stopBashCommands()
    await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 8000))])
    check("quitting ends it rather than leaving it behind", settled, { settled, ms: Date.now() - at })
    check("and nothing is left held afterwards", liveBashCommands() === before, liveBashCommands())
  }

  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
}
