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

  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
}
