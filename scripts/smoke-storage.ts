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
import { CONVO_FILE_FORMAT, conversationDocument, conversationFileName, parseConversationDocument } from "../src/shared/convo-file"
import { ARTIFACT_SCHEMA_VERSION, ArtifactStore } from "../src/server/artifact/store"
import { STORAGE_LAYOUT_VERSION, readStorageLayout } from "../src/server/storage-layout"
import { IMPORT_SCHEMA_VERSION, runImport } from "../src/server/import"
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

    const second = await migrateCheckpoints(storage, snapshots, config)
    check("running it again moves nothing", second.moved === 0 && second.sessions === 0, second)
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
    const swept = await snapshots.sweep([])
    check("a sweep collects the stores no conversation names any more", swept > 0, swept)
    check("and the folder is left empty", (await fs.readdir(storeRoot)).length === 0, await fs.readdir(storeRoot))

    const live = snapshots.begin(two)
    await live.ready()
    await live.finish()
    const kept = await snapshots.sweep([two])
    check("a sweep never touches a store a live conversation still names", kept === 0 && (await fs.readdir(storeRoot)).length > 0, await fs.readdir(storeRoot))
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
    check("the rule is listed with where it was granted and what it covers", first.savedRules().some((rule) => rule.kind === "bash" && rule.pattern === "npm run build *" && rule.sessionID === ""), first.savedRules())

    // The write is deliberately not awaited by the approval itself, so wait for it here.
    await first.flush()
    const written = await fs.readFile(storage.fileOf(RULES_KEY), "utf8")
    check("and written to the profile rather than kept in memory alone", written.includes("npm run build *"), written)

    /* The restart: a second gate reading the same profile, as the next launch does. */
    const second = new Permissions(bus, config)
    await second.load(storage)
    const remembered = await settle(second, ask(second, "ses_b", "c2", "npm run build --watch", directory), "reject")
    check("after a restart the same command is not asked again", !remembered.asked && remembered.outcome === "allowed", remembered)

    const other = await settle(second, ask(second, "ses_c", "c3", "npm run build", elsewhere), "reject")
    check("while another project is still asked", other.asked, other)

    await second.forget({ directory, kind: "bash", pattern: "npm run build *" })
    check("withdrawing the rule empties the list", second.savedRules().length === 0, second.savedRules())
    const third = new Permissions(bus, config)
    await third.load(storage)
    const askedAgain = await settle(third, ask(third, "ses_d", "c4", "npm run build", directory), "reject")
    check("and the withdrawal survives a restart, so it asks once more", askedAgain.asked, askedAgain)

    /*
     * A document from a later build: read as far as it goes, never written back.
     * A downgrade that still saves is how the newer build's rules are lost.
     */
    await storage.write(RULES_KEY, { schemaVersion: 99, projects: { [directory]: [{ kind: "bash", pattern: "from-a-newer-build *" }] } })
    const newer = new Permissions(bus, config)
    await newer.load(storage)
    check("a profile written by a newer build is still read", newer.savedRules().some((rule) => rule.pattern === "from-a-newer-build *"), newer.savedRules())
    await newer.forget({})
    const kept = JSON.parse(await fs.readFile(storage.fileOf(RULES_KEY), "utf8")) as { schemaVersion?: number; projects?: Record<string, unknown[]> }
    check("but nothing is written over it", kept.schemaVersion === 99 && Object.keys(kept.projects ?? {}).length === 1, kept)

    /* A document that will not parse is evidence, not something to write over. */
    await fs.writeFile(storage.fileOf(RULES_KEY), "{ this is not json", "utf8")
    const damaged = new Permissions(bus, config)
    await damaged.load(storage)
    const aside = (await fs.readdir(path.dirname(storage.fileOf(RULES_KEY)))).filter((name) => name.startsWith("permissions.json.corrupt-"))
    check("an unreadable rules document is kept aside rather than replaced", aside.length === 1, aside)
    check("and the app carries on with no rules in force", damaged.savedRules().length === 0, damaged.savedRules())
  }

  // ------------------------------------------------------------------- S4
  section("Round 7 (S4): a conversation can be written to a file and read back")
  {
    const storage = new Storage(path.join(root, "trip", "storage"))
    const bus = new Bus()
    const store = new SessionStore(storage, bus)
    const directory = path.join(root, "trip-project")
    const session = await store.create({ directory, model: MODEL, title: "A conversation worth keeping" })
    await store.saveMessage(
      { id: "msg_u1", sessionID: session.id, role: "user", text: "what did we decide", attachments: [], time: { created: 1 } },
      true,
    )
    await store.saveMessage(
      {
        id: "msg_a1",
        sessionID: session.id,
        role: "assistant",
        model: MODEL,
        agent: "build",
        parts: [{ type: "text", id: "prt_1", text: "we decided to keep it" }],
        finish: "end_turn",
        time: { created: 2, completed: 3 },
      },
      true,
    )

    const messages = await store.messages(session.id)
    const text = JSON.stringify(conversationDocument(session, messages), null, 2)
    const back = parseConversationDocument(text)
    check("the document reads back as a conversation", Boolean(back.file) && back.problem === undefined, back.problem)
    check("with the title and the folder it worked in", back.file?.session.title === "A conversation worth keeping" && back.file?.session.directory === directory, back.file?.session)
    /*
     * Compared against the store's own list rather than against an order this
     * check assumes: messages are listed by key, so "msg_a1" comes before
     * "msg_u1" and the reply is first.
     */
    check(
      "and every message exactly as it was stored, in the same order",
      back.file?.messages.length === 2 && JSON.stringify(back.file?.messages) === JSON.stringify(messages),
      back.file?.messages.map((message) => message.id),
    )
    check("the conversation's own clock travels with it", back.file?.session.created === session.created && back.file?.session.updated === session.updated, back.file?.session)

    /* Every refusal is a reason the reader can act on, not a thrown error. */
    check("a file that is not JSON at all is refused", parseConversationDocument("not json{").problem === "notJson")
    check("another app's JSON is refused", parseConversationDocument(JSON.stringify({ app: "SomethingElse", format: 1 })).problem === "notMCode")
    check(
      "a document written by a newer build is refused rather than half read",
      parseConversationDocument(JSON.stringify({ app: "MCode", format: CONVO_FILE_FORMAT + 1, session: {}, messages: [{ id: "m", role: "user" }] })).problem === "fromNewer",
    )
    check(
      "and one with nothing in it that reads as a message",
      parseConversationDocument(JSON.stringify({ app: "MCode", format: CONVO_FILE_FORMAT, session: {}, messages: [{ nonsense: true }] })).problem === "noMessages",
    )

    const name = conversationFileName('a/title\\with:illegal*characters?', "conversation")
    check("the suggested file name carries nothing a file system refuses", !/[\\/:*?"<>|]/.test(name) && name.endsWith(".mcode.json"), name)
    check("and an untitled conversation still gets a name", conversationFileName("", "conversation") === "conversation.mcode.json", conversationFileName("", "conversation"))
  }

  // ------------------------------------------------------------------- S5
  section("Round 7 (S5): produced files are kept, de-duplicated, and outlive their conversation")
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

    const artifacts = ArtifactStore.open(path.join(root, "art", "artifacts.db"))
    check("the store opens", Boolean(artifacts) && artifacts?.writable === true)
    await artifacts?.reconcile(await store.list(), (id) => store.messages(id))

    check("the same file produced twice is one row, as its identity key says", artifacts?.count() === 2, artifacts?.count())
    const listed = artifacts?.list() ?? []
    const files = listed.flatMap((group) => group.files)
    const report = files.find((file) => file.path === "report.md")
    const helper = files.find((file) => file.path === "helper.ts")
    check("a document is something to hand over", report?.role === "deliverable", report)
    check("while a source file is a step on the way", helper?.role === "intermediate", helper)
    check("and both are recorded as still being there, with their size", report?.exists === true && typeof report?.size === "number", report)

    /* Availability is re-checked rather than believed: the record of writing a file says nothing about now. */
    await fs.rm(path.join(directory, "helper.ts"), { force: true })
    await artifacts?.recheck()
    const gone = (artifacts?.list() ?? []).flatMap((group) => group.files).find((file) => file.path === "helper.ts")
    check("a file deleted since is found missing on the next check", gone?.exists === false, gone)

    /*
     * The point of storing them at all: deleting the conversation that made a
     * file must not take the file's record with it.
     */
    artifacts?.orphan(one.id)
    await store.delete(one.id)
    const after = artifacts?.list() ?? []
    const survived = after.flatMap((group) => group.files).find((file) => file.path === "helper.ts")
    check("a deleted conversation's files are still held", artifacts?.count() === 2 && Boolean(survived), artifacts?.count())
    check("under the title that conversation had", after.some((group) => group.title === "First conversation" && group.sessionID === ""), after.map((group) => [group.title, group.sessionID]))

    /* Searching what is kept, which walking the transcripts never offered. */
    check("the store can be searched by file name", (artifacts?.list("report") ?? []).flatMap((group) => group.files).every((file) => file.path.includes("report")))
    check("and by the conversation's title", (artifacts?.list("Second") ?? []).length === 1, artifacts?.list("Second").length)
    artifacts?.close()

    /*
     * A store written by a newer build is read but never written over. Unlike
     * the search index, this one cannot simply be rebuilt: it holds the only
     * record of files whose conversations are gone.
     */
    const newerFile = path.join(root, "art", "artifacts-newer.db")
    const seed = ArtifactStore.open(newerFile)
    seed?.close()
    const raw = new (await import("node:sqlite")).DatabaseSync(newerFile)
    raw.prepare("INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(ARTIFACT_SCHEMA_VERSION + 1, Date.now())
    raw.close()
    const newer = ArtifactStore.open(newerFile)
    check("a store from a newer build opens read-only rather than being rebuilt", newer?.writable === false, newer?.writable)
    await newer?.reconcile(await store.list(), (id) => store.messages(id))
    check("and nothing is written into it", newer?.count() === 0, newer?.count())
    newer?.close()
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

    /*
     * The import record gets the same bargain: stamped when this build writes
     * it, and never written over when a newer build did - otherwise the next
     * run would take every conversation again as though it had never seen them.
     */
    const bus = new Bus()
    const sessions = new SessionStore(storage, bus)
    const empty = path.join(root, "layout", "no-other-apps")
    await fs.mkdir(empty, { recursive: true })
    const previous = process.env.MCODE_IMPORT_HOME
    process.env.MCODE_IMPORT_HOME = empty
    await runImport({ storage, sessions, model: MODEL }, ["cc"])
    const record = JSON.parse(await fs.readFile(storage.fileOf("imported"), "utf8")) as { schemaVersion?: number; entries?: unknown }
    check("the import record is stamped with this build's version", record.schemaVersion === IMPORT_SCHEMA_VERSION, record)

    await storage.write("imported", { schemaVersion: IMPORT_SCHEMA_VERSION + 1, entries: { "cc:kept": { source: "cc", key: "kept", mtime: 1, sessionID: "ses_kept" } } })
    await runImport({ storage, sessions, model: MODEL }, ["cc"])
    const keptRecord = JSON.parse(await fs.readFile(storage.fileOf("imported"), "utf8")) as { schemaVersion?: number; entries?: Record<string, unknown> }
    check(
      "one written by a newer build is read but never written over",
      keptRecord.schemaVersion === IMPORT_SCHEMA_VERSION + 1 && Object.keys(keptRecord.entries ?? {}).length === 1,
      keptRecord,
    )
    if (previous === undefined) delete process.env.MCODE_IMPORT_HOME
    else process.env.MCODE_IMPORT_HOME = previous
  }

  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
}
