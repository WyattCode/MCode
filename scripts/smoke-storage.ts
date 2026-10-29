/**
 * Round 7 (storage): what the profile keeps, and what it stops keeping.
 *
 * S1 - a recorded turn holds a reference to its bodies rather than the bodies,
 * an existing profile's undo history is carried across to that shape rather
 * than dropped, and anything that cannot be carried across still reads.
 * S2 - a project's undo store is collected when its last conversation goes.
 *
 * Nothing here calls a model or reaches the network. The only git driven is the
 * one already on the machine, in temporary folders of its own.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import type { Check } from "./smoke-round5"
import { Bus } from "../src/server/bus"
import { Config } from "../src/server/config"
import { Storage } from "../src/server/storage"
import { SessionStore } from "../src/server/session/store"
import { Permissions, RULES_KEY } from "../src/server/permission"
import { ARTIFACT_SCHEMA_VERSION, ArtifactStore, identityKey } from "../src/server/artifact/store"
import { STORAGE_LAYOUT_VERSION, readStorageLayout } from "../src/server/storage-layout"
import { Snapshots, snapshotBytes } from "../src/server/session/snapshot"
import { CHECKPOINT_MIGRATION, migrateCheckpoints } from "../src/server/session/checkpoint-migrate"

const MODEL = { provider: "anthropic", model: "claude-opus-5" } as const

/** A project git will record, with the files a turn is about to change. */
async function project(root: string, name: string, files: Record<string, string>): Promise<string> {
  const directory = path.join(root, name)
  await fs.mkdir(directory, { recursive: true })
  for (const [file, body] of Object.entries(files)) await fs.writeFile(path.join(directory, file), body, "utf8")
  execFileSync("git", ["init", "-q"], { cwd: directory })
  return directory
}

export async function storageChecks(check: Check, section: (name: string) => void): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r7-storage-"))

  // ------------------------------------------------------------------- S1
  section("Round 7 (S1): a turn's undo keeps a reference, not the file")
  {
    const storage = new Storage(path.join(root, "kept", "storage"))
    const bus = new Bus()
    const store = new SessionStore(storage, bus)
    const snapshots = new Snapshots(path.join(root, "kept", "snapshot"))
    const directory = await project(root, "kept-project", { "a.txt": "before the turn" })

    /*
     * A body long enough that finding it in the document is unambiguous, and
     * distinctive enough that it cannot be there by coincidence.
     */
    const body = `secret-body-${"x".repeat(200)}`
    await fs.writeFile(path.join(directory, "a.txt"), body, "utf8")
    const blob = await snapshots.keep(directory, Buffer.from(body, "utf8"))

    const session = await store.create({ directory, model: MODEL })
    await store.pushSnapshot(session.id, {
      at: Date.now(),
      files: [{ path: path.join(directory, "a.txt"), blob }],
      messages: ["msg_1"],
      directory,
      summary: { files: 1, additions: 3, deletions: 1 },
    })

    const document = await fs.readFile(storage.fileOf(`session/${session.id}/history`), "utf8")
    check("the conversation's undo document does not hold the file's body", !document.includes("secret-body"), document.length)
    check("it holds the checkpoint reference instead", document.includes(blob) && /[0-9a-f]{40}/.test(blob), blob)
    check("and the turn's size, as MiMo keeps it on the session row", document.includes('"additions": 3') && document.includes('"deletions": 1'))

    const recorded = await store.peekSnapshot(session.id, "undo")
    const bytes = await snapshotBytes(snapshots, recorded?.directory, recorded!.files[0]!)
    check("the reference resolves to exactly the bytes recorded", bytes?.toString("utf8") === body, bytes?.length)

    // The same body recorded again is the same object: git addresses it by its contents.
    const again = await snapshots.keep(directory, Buffer.from(body, "utf8"))
    check("recording an unchanged file twice stores it once", again === blob, [blob, again])

    /* Bytes that are not text at all must come back byte for byte, not through a decoder. */
    const raw = Buffer.from([0x00, 0xff, 0xfe, 0x10, 0x80, 0x00])
    const rawBlob = await snapshots.keep(directory, raw)
    const rawBack = await snapshots.fetch(directory, rawBlob)
    check("a file that is not valid text survives the store unchanged", Boolean(rawBack?.equals(raw)), rawBack)
  }

  // ------------------------------------------------------------------- S1
  section("Round 7 (S1): an existing profile's undo history is carried across")
  {
    const dataRoot = path.join(root, "old")
    const storage = new Storage(path.join(dataRoot, "storage"))
    const bus = new Bus()
    const config = new Config(storage, bus, path.join(dataRoot, "credentials.json"))
    await storage.write("config", {})
    await config.load()
    const snapshots = new Snapshots(path.join(dataRoot, "snapshot"))
    const directory = await project(root, "old-project", { "a.txt": "now" })

    /*
     * A fixture in the shape written before the checkpoint store: whole bodies
     * inline, on the undo stack, the redo stack and a rolled back turn. This is
     * what someone's profile actually holds, and what the migration has to
     * carry across without losing a turn.
     */
    const target = path.join(directory, "a.txt")
    const legacy = {
      undo: [{ at: 1, files: [{ path: target, content: "undo-body" }], messages: ["m1"] }],
      redo: [{ at: 2, files: [{ path: target, content: "redo-body" }], messages: ["m2"] }],
      reverted: [
        {
          messageID: "m3",
          messages: ["m3"],
          snapshot: { at: 3, files: [{ path: target, content: "reverted-body" }], messages: ["m3"] },
          swapped: [{ path: target, content: "swapped-body" }],
        },
      ],
    }
    await storage.write("session/ses_old/info", { id: "ses_old", title: "old", directory, model: MODEL, created: 1, updated: 1 })
    await storage.write("session/ses_old/history", legacy)

    const moved = await migrateCheckpoints(storage, snapshots, config)
    const after = await fs.readFile(storage.fileOf("session/ses_old/history"), "utf8")
    check("every inline body is moved out of the document", !after.includes("undo-body") && !after.includes("redo-body") && !after.includes("reverted-body") && !after.includes("swapped-body"), after)
    check("all four are counted as moved", moved.moved === 4 && moved.sessions === 1 && moved.kept === 0, moved)

    const store = new SessionStore(storage, bus)
    const undone = await store.peekSnapshot("ses_old", "undo")
    const redone = await store.peekSnapshot("ses_old", "redo")
    const rolled = (await store.reverted("ses_old"))[0]
    const read = async (file: unknown) => (await snapshotBytes(snapshots, directory, file as never))?.toString("utf8")
    check("the undo stack still restores what it always did", (await read(undone?.files[0])) === "undo-body", undone?.files[0])
    check("so does the redo stack", (await read(redone?.files[0])) === "redo-body", redone?.files[0])
    check("so does a turn that was rolled back, both halves", (await read(rolled?.snapshot.files[0])) === "reverted-body" && (await read(rolled?.swapped[0])) === "swapped-body", rolled)
    check("the depth is unchanged, so no turn was dropped", JSON.stringify(await store.historyDepth("ses_old")) === JSON.stringify({ undo: 1, redo: 1 }), await store.historyDepth("ses_old"))
    check("and the migration is recorded, so it does not run again", (config.get().migrations ?? []).includes(CHECKPOINT_MIGRATION), config.get().migrations)

    /*
     * The mark is what stops it, not the shape of the data.
     *
     * The migration skips a conversation with no inline body left, so it is
     * naturally idempotent and "running it again moves nothing" held whether or
     * not the mark was ever read - it could not have caught the gate being
     * deleted, which is every launch re-reading every conversation's history
     * and is the only reason the mark exists (R25-F8). Counting what it reads
     * is what shows the gate working.
     */
    let readsAfter = 0
    // A proxy, not a spread: Storage's methods live on its prototype, and a spread copies none of them.
    const counting = new Proxy(storage, {
      get: (target, key, receiver) =>
        key === "listDirectories"
          ? async (prefix: string) => {
              readsAfter += 1
              return target.listDirectories(prefix)
            }
          : Reflect.get(target, key, receiver),
    })
    const second = await migrateCheckpoints(counting, snapshots, config)
    check("running it again moves nothing", second.moved === 0 && second.sessions === 0, second)
    check("and it stops at the mark, without reading the conversations again", readsAfter === 0, readsAfter)
    const forgetful = new Proxy(config, {
      get: (target, key, receiver) => (key === "get" ? () => ({ ...target.get(), migrations: [] }) : Reflect.get(target, key, receiver)),
    })
    readsAfter = 0
    await migrateCheckpoints(counting, snapshots, forgetful)
    check("with the mark gone it reads them again, which is what the mark is for", readsAfter > 0, readsAfter)
  }

  // ------------------------------------------------------------------- S1
  section("Round 7 (S1): what cannot be carried across is still readable")
  {
    const dataRoot = path.join(root, "stuck")
    const storage = new Storage(path.join(dataRoot, "storage"))
    const bus = new Bus()
    const config = new Config(storage, bus, path.join(dataRoot, "credentials.json"))
    await storage.write("config", {})
    await config.load()
    const snapshots = new Snapshots(path.join(dataRoot, "snapshot"))

    /*
     * A conversation whose record names no project has nowhere to put its
     * bodies. It must be left exactly as it is - a turn that could be taken
     * back before must not stop being undoable because a migration ran.
     */
    await storage.write("session/ses_nowhere/info", { id: "ses_nowhere", title: "nowhere", model: MODEL, created: 1, updated: 1 })
    await storage.write("session/ses_nowhere/history", { undo: [{ at: 1, files: [{ path: "/tmp/x.txt", content: "still-here" }], messages: ["m1"] }], redo: [], reverted: [] })

    const outcome = await migrateCheckpoints(storage, snapshots, config)
    const document = await fs.readFile(storage.fileOf("session/ses_nowhere/history"), "utf8")
    check("a conversation with no project keeps its history exactly as it was", document.includes("still-here"), outcome)

    const store = new SessionStore(storage, bus)
    const held = await store.peekSnapshot("ses_nowhere", "undo")
    const bytes = await snapshotBytes(snapshots, undefined, held!.files[0]!)
    check("and the old shape still reads, so the turn is still undoable", bytes?.toString("utf8") === "still-here", bytes)
  }

  // ------------------------------------------------------------------- S2
  section("Round 7 (S2): a project's undo store goes when its conversations do")
  {
    const storeRoot = path.join(root, "collect", "snapshot")
    const snapshots = new Snapshots(storeRoot)
    const one = await project(root, "collect-one", { "a.txt": "one" })
    const two = await project(root, "collect-two", { "a.txt": "two" })

    for (const directory of [one, two]) {
      const recording = snapshots.begin(directory)
      await recording.ready()
      await fs.writeFile(path.join(directory, "a.txt"), "changed", "utf8")
      await recording.finish()
    }
    const made = await fs.readdir(storeRoot)
    check("each project gets a store of its own", made.length >= 2, made)

    await snapshots.collect(one)
    const afterCollect = await fs.readdir(storeRoot)
    check("collecting one project removes its store", afterCollect.length < made.length, afterCollect)
    check("...and leaves the other project's alone", afterCollect.length > 0, afterCollect)

    /*
     * The stores already orphaned, which no deletion can go back for. Six of
     * these sat in the profile this was measured in, for two conversations.
     */
    /*
     * A store written minutes ago is kept, whoever it belongs to: two instances
     * share a data directory, and this pass is the one that deletes (R26-B1).
     * So the orphans are aged first - which is what an orphan actually looks
     * like - and a fresh one is checked separately below.
     */
    const stale = new Date(Date.now() - 3 * 60 * 60 * 1000)
    for (const name of await fs.readdir(storeRoot)) await fs.utimes(path.join(storeRoot, name), stale, stale)
    const swept = await snapshots.sweep([])
    check("a sweep collects the stores no conversation names any more", swept > 0, swept)
    check("and the folder is left empty", (await fs.readdir(storeRoot)).length === 0, await fs.readdir(storeRoot))

    const live = snapshots.begin(two)
    await live.ready()
    await live.finish()
    const kept = await snapshots.sweep([two])
    check("a sweep never touches a store a live conversation still names", kept === 0 && (await fs.readdir(storeRoot)).length > 0, await fs.readdir(storeRoot))

    /*
     * And one nothing names at all, written just now: almost certainly another
     * instance's, opened after this one read the list. Kept until it has been
     * sitting there an hour, by which time the other instance's list would
     * name it (R26-B1).
     */
    const brandNew = snapshots.begin(path.join(root, "fresh-project"))
    await brandNew.ready()
    await brandNew.finish()
    const freshSwept = await snapshots.sweep([two])
    check("a store written moments ago is left alone, whoever made it", freshSwept === 0, { freshSwept, entries: await fs.readdir(storeRoot) })
  }

  // ------------------------------------------------------------------- S3
  section("Round 7 (S3): an always is remembered across a restart, and can be taken back")
  {
    const dataRoot = path.join(root, "rules")
    const storage = new Storage(path.join(dataRoot, "storage"))
    const bus = new Bus()
    const config = new Config(storage, bus, path.join(dataRoot, "credentials.json"))
    await storage.write("config", {})
    await config.load()
    await config.set({ accessLevel: "ask", permissions: { bash: "ask" } })
    const directory = path.join(root, "rules-project")
    const elsewhere = path.join(root, "rules-other")
    const pause = () => new Promise((resolve) => setTimeout(resolve, 20))

    const ask = (gate: Permissions, sessionID: string, callID: string, command: string, where: string) =>
      gate
        .ask({ sessionID, messageID: "m1", callID, kind: "bash", title: "t", subject: command, patterns: [command], always: ["npm run build *"], directory: where })
        .then(
          () => "allowed",
          (err: Error) => err.message,
        )
    /** Answers whatever is parked, so a check can never hang waiting for a question nobody sees. */
    const settle = async (gate: Permissions, running: Promise<string>, answer: "always" | "reject") => {
      await pause()
      const parked = gate.outstanding()[0]
      if (parked) gate.respond(parked.id, answer)
      return { asked: Boolean(parked), outcome: await running }
    }

    const first = new Permissions(bus, config)
    await first.load(storage)
    const granted = await settle(first, ask(first, "ses_a", "c1", "npm run build", directory), "always")
    check("the question is put, and answering always allows it", granted.asked && granted.outcome === "allowed", granted)

    // The write is deliberately not awaited by the approval itself, so wait for it here.
    await first.flush()
    const written = await fs.readFile(storage.fileOf(RULES_KEY), "utf8")
    const projects = (JSON.parse(written) as { projects?: Record<string, { kind: string; pattern: string }[]> }).projects ?? {}
    check(
      "and written to the profile for the project, not the conversation, rather than kept in memory alone",
      Object.entries(projects).some(([key, rules]) => !key.startsWith("session:") && rules.some((rule) => rule.kind === "bash" && rule.pattern === "npm run build *")),
      written,
    )

    /* The restart: a second gate reading the same profile, as the next launch does. */
    const second = new Permissions(bus, config)
    await second.load(storage)
    const remembered = await settle(second, ask(second, "ses_b", "c2", "npm run build --watch", directory), "reject")
    check("after a restart the same command is not asked again", !remembered.asked && remembered.outcome === "allowed", remembered)

    const other = await settle(second, ask(second, "ses_c", "c3", "npm run build", elsewhere), "reject")
    check("while another project is still asked", other.asked, other)

    /* A conversation's own allowance goes with the conversation; the project's stays (MiMo keeps both, lists neither). */
    const loose = await settle(second, ask(second, "ses_e", "c5", "npm run build", ""), "always")
    check("a call that names no project is remembered for its conversation", loose.asked && loose.outcome === "allowed", loose)
    await second.forgetSession("ses_e")
    await second.flush()
    const afterDelete = JSON.parse(await fs.readFile(storage.fileOf(RULES_KEY), "utf8")) as { projects?: Record<string, unknown[]> }
    check(
      "deleting that conversation drops its allowance and keeps the project's",
      !Object.keys(afterDelete.projects ?? {}).some((key) => key === "session:ses_e") && JSON.stringify(afterDelete.projects).includes("npm run build *"),
      afterDelete,
    )

    /*
     * A document from a later build: read as far as it goes, never written back.
     * A downgrade that still saves is how the newer build's rules are lost.
     */
    // Keyed the way the store keys a project, so the newer build's rule is one this build can find.
    const stored = process.platform === "win32" ? path.resolve(directory).toLowerCase() : path.resolve(directory)
    await storage.write(RULES_KEY, { schemaVersion: 99, projects: { [stored]: [{ kind: "bash", pattern: "from-a-newer-build *" }] } })
    const newer = new Permissions(bus, config)
    await newer.load(storage)
    const fromNewer = await settle(newer, ask(newer, "ses_f", "c6", "from-a-newer-build now", directory), "reject")
    check("a profile written by a newer build is still read", !fromNewer.asked && fromNewer.outcome === "allowed", fromNewer)
    await settle(newer, ask(newer, "ses_f", "c7", "npm run build", directory), "always")
    await newer.flush()
    const kept = JSON.parse(await fs.readFile(storage.fileOf(RULES_KEY), "utf8")) as { schemaVersion?: number; projects?: Record<string, unknown[]> }
    check("but nothing is written over it", kept.schemaVersion === 99 && Object.keys(kept.projects ?? {}).length === 1, kept)

    /* A document that will not parse is evidence, not something to write over. */
    await fs.writeFile(storage.fileOf(RULES_KEY), "{ this is not json", "utf8")
    const damaged = new Permissions(bus, config)
    await damaged.load(storage)
    const aside = (await fs.readdir(path.dirname(storage.fileOf(RULES_KEY)))).filter((name) => name.startsWith("permissions.json.corrupt-"))
    check("an unreadable rules document is kept aside rather than replaced", aside.length === 1, aside)
    const unruled = await settle(damaged, ask(damaged, "ses_g", "c8", "npm run build", directory), "reject")
    check("and the app carries on with no rules in force", unruled.asked, unruled)
  }

  // ------------------------------------------------------------------- S5
  section("Round 7 (S5) / round 9: produced files are kept, de-duplicated, searchable, and outlive their conversations")
  {
    const storage = new Storage(path.join(root, "art", "storage"))
    const bus = new Bus()
    const store = new SessionStore(storage, bus)
    const directory = path.join(root, "art-project")
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(path.join(directory, "report.md"), "# the report", "utf8")
    await fs.writeFile(path.join(directory, "helper.ts"), "export const x = 1", "utf8")

    /** An assistant turn that created one file, as the artifact rules read it. */
    const wrote = async (sessionID: string, id: string, file: string, at: number) => {
      await store.saveMessage(
        {
          id,
          sessionID,
          role: "assistant",
          model: MODEL,
          agent: "build",
          parts: [
            {
              type: "tool",
              id: `prt_${id}`,
              callID: `call_${id}`,
              name: "write",
              status: "completed",
              input: { file_path: file },
              output: "",
              title: file,
              metadata: { created: true },
              time: { created: at, completed: at },
            },
          ],
          finish: "end_turn",
          time: { created: at, completed: at },
        } as never,
        true,
      )
    }

    const one = await store.create({ directory, model: MODEL, title: "First conversation" })
    await wrote(one.id, "msg_w1", "report.md", 10)
    await wrote(one.id, "msg_w2", "helper.ts", 11)
    const two = await store.create({ directory, model: MODEL, title: "Second conversation" })
    // The same file again, from another conversation: one row, not two.
    await wrote(two.id, "msg_w3", "report.md", 12)

    const artifacts = await ArtifactStore.open(path.join(root, "art", "artifacts.db"))
    check("the store opens", Boolean(artifacts) && artifacts?.writable === true)
    const unwatch = store.watch((change) => {
      if (change.type === "message") artifacts?.touched(change.message.sessionID)
      else if (change.type === "message.removed") artifacts?.touched(change.sessionID)
    })
    await artifacts?.reconcile(await store.list(), (id) => store.messages(id))

    check("the same file produced twice is one row, as its identity key says", (await artifacts?.count()) === 2, await artifacts?.count())
    const reportAt = path.join(directory, "report.md")
    const reportSources = (await artifacts?.sourcesOf(reportAt)) ?? []
    check(
      "round 9: every conversation that wrote a file is one of its sources, newest first",
      reportSources.map((source) => source.sessionID).join() === [two.id, one.id].join(),
      reportSources,
    )
    const listed = (await artifacts?.list())?.artifacts ?? []
    const files = listed.flatMap((group) => group.files)
    const report = files.find((file) => file.path === "report.md")
    const helper = files.find((file) => file.path === "helper.ts")
    check("a document is something to hand over", report?.role === "deliverable", report)
    check("while a source file is a step on the way", helper?.role === "intermediate", helper)
    check("and both are recorded as still being there, with their size", report?.exists === true && typeof report?.size === "number", report)
    check(
      "round 9: a file two conversations wrote is listed once, under the newest",
      files.filter((file) => file.path === "report.md").length === 1 && listed.find((group) => group.files.includes(report!))?.sessionID === two.id,
      listed.map((group) => [group.title, group.files.map((file) => file.path)]),
    )

    /* Availability is re-checked rather than believed: the record of writing a file says nothing about now. */
    await fs.rm(path.join(directory, "helper.ts"), { force: true })
    await artifacts?.recheck()
    const gone = ((await artifacts?.list())?.artifacts ?? []).flatMap((group) => group.files).find((file) => file.path === "helper.ts")
    check("a file deleted since is found missing on the next check, and left out of the listing", gone === undefined && (await artifacts?.count()) === 2, gone)
    // Put back, the next full check finds it again, although a listing would not ask about a missing file for a while.
    await fs.writeFile(path.join(directory, "helper.ts"), "export {}", "utf8")
    await artifacts?.recheck()
    check(
      "S13-3: a file that comes back is found by the next full check",
      ((await artifacts?.list())?.artifacts ?? []).some((group) => group.files.some((file) => file.path === "helper.ts" && file.exists)),
    )

    /* A file written after the first pass is there at the next listing, without a restart. */
    await fs.writeFile(path.join(directory, "later-notes.md"), "# later", "utf8")
    await wrote(one.id, "msg_w4", "later-notes.md", 13)
    await artifacts?.reconcile(await store.list(), (id) => store.messages(id))
    check(
      "round 9: a file written since the last pass is picked up by the next one",
      ((await artifacts?.list())?.artifacts ?? []).some((group) => group.files.some((file) => file.path === "later-notes.md")),
    )

    /*
     * Search, as MiMo's: the file's name only, through the trigram index for
     * three characters or more, a substring test below that; NFC and case do
     * not matter.
     */
    const names = async (query: string) => ((await artifacts?.list({ query }))?.artifacts ?? []).flatMap((group) => group.files.map((file) => file.path)).sort()
    const reportNames = await names("report")
    check("the store can be searched by file name", reportNames.join() === "report.md", reportNames)
    const trigram = [await names("ORT.M"), await names("ter-no")]
    check("round 9: a search three characters or longer goes through the trigram index", trigram[0]!.join() === "report.md" && trigram[1]!.join() === "later-notes.md", trigram)
    const short = [await names("ts"), await names("r")]
    check("round 9: a shorter one is a substring test", short[0]!.join() === "helper.ts" && short[1]!.length === 3, short)
    check("round 9: a conversation's title is not searched, as MiMo searches the name only", (await names("First")).length === 0, await names("First"))
    check("round 9: a quote in the search is taken literally", (await names('re"port')).length === 0)
    /*
     * Deleting a conversation forgets what it wrote, as MiMo's delete does (the
     * user's 2026-09-22 call). The file the other conversation also wrote stays
     * under that one; the files on disk are never touched.
     */
    const twoMessages = await store.messages(two.id)
    const beforeDelete = await store.list()
    const heldBefore = await artifacts?.count()
    await artifacts?.detach(two.id)
    await store.delete(two.id)
    const afterTwo = (await artifacts?.sourcesOf(reportAt)) ?? []
    check(
      "round 9: deleting one writer drops its source and keeps the other's, with nothing left unlinked",
      (await artifacts?.count()) === heldBefore && afterTwo.length === 1 && afterTwo[0]!.sessionID === one.id,
      afterTwo,
    )
    check(
      "round 9: and the file is shown under the writer that still exists",
      ((await artifacts?.list())?.artifacts ?? []).find((group) => group.files.some((file) => file.path === "report.md"))?.sessionID === one.id,
    )
    // A pass that started before the deletion still has the conversation and its messages in hand.
    await artifacts?.reconcile(beforeDelete, (id) => (id === two.id ? Promise.resolve(twoMessages) : store.messages(id)))
    check("round 9: a deleted conversation is not linked back by a later pass", ((await artifacts?.sourcesOf(reportAt)) ?? []).every((source) => source.sessionID !== two.id))

    await artifacts?.detach(one.id)
    await store.delete(one.id)
    const after = (await artifacts?.list())?.artifacts ?? []
    check("a deleted conversation's files leave the artifact list, as MiMo's delete takes them", (await artifacts?.count()) === 0 && after.length === 0, [await artifacts?.count(), after.map((group) => [group.title, group.sessionID])])
    check("and the files themselves stay on disk", await fs.stat(path.join(directory, "helper.ts")).then(() => true, () => false))

    /* A message edited away takes that conversation's claim with it; a file no one claims goes, as in MiMo. */
    const three = await store.create({ directory, model: MODEL, title: "Third conversation" })
    await fs.writeFile(path.join(directory, "draft.md"), "# draft", "utf8")
    await wrote(three.id, "msg_w5", "draft.md", 14)
    await artifacts?.reconcile(await store.list(), (id) => store.messages(id))
    const withDraft = await artifacts?.count()
    await store.deleteMessage(three.id, "msg_w5")
    await artifacts?.reconcile(await store.list(), (id) => store.messages(id))
    check("round 9: a claim edited out of its conversation is dropped at the next pass", withDraft === 1 && (await artifacts?.count()) === 0, [withDraft, await artifacts?.count()])

    unwatch()
    await artifacts?.close()

    /*
     * A version-1 store is carried forward: the conversation each row named
     * becomes its source and its name is searchable at once; a row whose
     * conversation was already gone leaves, as a delete now takes it (v3).
     */
    const oldFile = path.join(root, "art", "artifacts-v1.db")
    {
      const { DatabaseSync } = await import("node:sqlite")
      const raw = new DatabaseSync(oldFile)
      raw.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
        CREATE TABLE artifact (id INTEGER PRIMARY KEY, identity_key TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL DEFAULT '',
          session_title TEXT NOT NULL DEFAULT '', directory TEXT NOT NULL DEFAULT '', path TEXT NOT NULL, absolute TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'intermediate', kind TEXT NOT NULL DEFAULT 'other', produced_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL, last_checked_at INTEGER NOT NULL DEFAULT 0, availability TEXT NOT NULL DEFAULT 'unknown',
          size_bytes INTEGER, modified_at INTEGER);`)
      raw.prepare("INSERT INTO schema_migrations VALUES (1, 1)").run()
      const add = raw.prepare(
        "INSERT INTO artifact (identity_key, session_id, session_title, directory, path, absolute, role, kind, produced_at, updated_at, availability) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available')",
      )
      const oldDir = path.join(root, "old-project")
      await fs.mkdir(oldDir, { recursive: true })
      await fs.writeFile(path.join(oldDir, "kept.md"), "# kept", "utf8")
      await fs.writeFile(path.join(oldDir, "orphan.pptx"), "", "utf8")
      add.run(identityKey(path.join(oldDir, "kept.md")), "ses_live", "Live one", oldDir, "kept.md", path.join(oldDir, "kept.md"), "deliverable", "doc", 5, 5)
      add.run(identityKey(path.join(oldDir, "orphan.pptx")), "", "Gone one", oldDir, "orphan.pptx", path.join(oldDir, "orphan.pptx"), "deliverable", "doc", 6, 6)
      raw.close()
    }
    const migrated = await ArtifactStore.open(oldFile)
    const oldNames = async (query: string) => ((await migrated?.list({ query }))?.artifacts ?? []).flatMap((group) => group.files.map((file) => file.path))
    check("round 9: a version-1 store opens writable and keeps every row a conversation still names", migrated?.writable === true && (await migrated?.count()) === 1, await migrated?.count())
    const keptSources = (await migrated?.sourcesOf(path.join(root, "old-project", "kept.md"))) ?? []
    const orphanSources = (await migrated?.sourcesOf(path.join(root, "old-project", "orphan.pptx"))) ?? []
    check(
      "round 9: each old row's conversation becomes its source, and a gone one's row is dropped",
      keptSources[0]?.sessionID === "ses_live" && orphanSources.length === 0,
    )
    check("round 9: and the old rows are searchable through the new index", (await oldNames("orphan")).length === 0 && (await oldNames("kept")).join() === "kept.md")
    check("round 9: nothing is grouped under a conversation that is gone", !((await migrated?.list())?.artifacts ?? []).some((group) => group.sessionID === ""))
    await migrated?.close()
    const reopened = await ArtifactStore.open(oldFile)
    check("round 9: opening a migrated store again changes nothing", reopened?.writable === true && (await reopened?.count()) === 1)
    await reopened?.close()

    /*
     * A store written by a newer build is read but never written over. Unlike
     * the search index, this one cannot simply be rebuilt: it holds the only
     * record of files whose conversations are gone.
     */
    const newerFile = path.join(root, "art", "artifacts-newer.db")
    const seed = await ArtifactStore.open(newerFile)
    await seed?.close()
    const raw = new (await import("node:sqlite")).DatabaseSync(newerFile)
    raw.prepare("INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(ARTIFACT_SCHEMA_VERSION + 1, Date.now())
    raw.close()
    const newer = await ArtifactStore.open(newerFile)
    check("a store from a newer build opens read-only rather than being rebuilt", newer?.writable === false, newer?.writable)
    const lateSession = await store.create({ directory, model: MODEL, title: "Late conversation" })
    await wrote(lateSession.id, "msg_w6", "report.md", 20)
    newer?.touched(lateSession.id)
    await newer?.detach(lateSession.id)
    await newer?.reconcile(await store.list(), (id) => store.messages(id))
    check("and nothing is written into it", (await newer?.count()) === 0, await newer?.count())
    await newer?.close()
  }

  // --------------------------------------------------------------- S20/S21
  section("Round 7 (S20/S21): the stored documents say which build wrote them")
  {
    const storage = new Storage(path.join(root, "layout", "storage"))
    const first = await readStorageLayout(storage)
    check("a profile with no marker is stamped with this build's layout", first.schemaVersion === STORAGE_LAYOUT_VERSION && !first.fromNewerVersion, first)
    const stamped = JSON.parse(await fs.readFile(storage.fileOf("layout"), "utf8")) as { schemaVersion?: number }
    check("and the marker is on disk, so a later migration has something to key off", stamped.schemaVersion === STORAGE_LAYOUT_VERSION, stamped)

    await storage.write("layout", { schemaVersion: STORAGE_LAYOUT_VERSION + 1 })
    const newer = await readStorageLayout(storage)
    check("a profile written by a newer build is detected rather than stamped down", newer.fromNewerVersion === true, newer)
    const untouched = JSON.parse(await fs.readFile(storage.fileOf("layout"), "utf8")) as { schemaVersion?: number }
    check("and its marker is left exactly as it was", untouched.schemaVersion === STORAGE_LAYOUT_VERSION + 1, untouched)
  }

  // ------------------------------------------------------------------ R80
  section("Round 80: remove waits out a queued write (resurrect)")
  {
    const storage = new Storage(path.join(root, "race", "storage"))

    /*
     * A save still in its queue slot when the document is removed. A bare
     * `fs.rm` runs beside it and the save's rename puts the file back
     * afterwards - a deleted message reappearing. The busy wait keeps the
     * slot occupied long enough that a parallel remove would win the race on
     * the old code; the remove has to join the key's queue instead.
     */
    await storage.write("race/doc", { v: 1 })
    const pending = storage.writeText("race/doc", (current) => {
      const until = Date.now() + 80
      while (Date.now() < until) {
        /* hold the queue slot */
      }
      return JSON.stringify({ v: 2, held: Boolean(current) })
    })
    await storage.remove("race/doc")
    await pending
    const left = await storage.readText("race/doc")
    check("a remove queued behind a write leaves nothing behind", left === undefined, left)

    /*
     * The same race one level up: a conversation's folder removed while one of
     * its documents is still being written, and the write recreating the
     * folder - a deleted conversation coming back with one message in it.
     */
    await storage.write("session/ghost/info", { id: "ghost" })
    const ghost = storage.writeText("session/ghost/info", (current) => {
      const until = Date.now() + 80
      while (Date.now() < until) {
        /* hold the queue slot */
      }
      return JSON.stringify({ id: "ghost", held: Boolean(current) })
    })
    await storage.removeDirectory("session/ghost")
    await ghost.catch(() => {})
    const directories = await storage.listDirectories("session")
    check("a directory remove waits out a write queued under it", !directories.includes("ghost"), directories)
    const ghostInfo = await storage.read("session/ghost/info")
    check("and the document under it is gone too", ghostInfo === undefined, ghostInfo)
  }

  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
}
