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
import { Storage } from "../src/server/storage"
import { Config } from "../src/server/config"
import { Bus } from "../src/server/bus"
import { isContextOverflow, isOverflowError } from "../src/server/session/overflow"
import { retryDecision } from "../src/server/session/retry"
import { ProviderError, ProviderHttpError } from "../src/server/provider/types"
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
    check("what each turn recorded is the state it opened on", one.files[0]?.content === "a0" && two.files[0]?.content === "b0", [one.files[0], two.files[0]])

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

  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
}
