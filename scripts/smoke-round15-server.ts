/**
 * Round 15 (lane S): the backend core fixes - redo over the checkpoint store,
 * a project whose closing photograph failed, conversation search in Chinese,
 * and what a deleted conversation leaves behind (R15-S1 onwards). Kept apart
 * from smoke.ts the way the earlier rounds are; smoke.ts calls
 * `roundFifteenServerChecks` with its own check and section.
 *
 * Everything here runs in temporary folders of its own. Nothing reads the
 * user's profile, calls a model or reaches the network.
 */
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import type { Check } from "./smoke-round5"
import type { Message } from "../src/shared/protocol"
import { Bus } from "../src/server/bus"
import { Storage } from "../src/server/storage"
import { SessionStore } from "../src/server/session/store"
import { Snapshots } from "../src/server/session/snapshot"
import { ArtifactStore } from "../src/server/artifact/store"
import { IndexDatabase } from "../src/server/history/database"
import { startHistory, stopHistory } from "../src/server/history/service"
import { ftsQuery, plainSnippet, searchText } from "../src/server/history/text"
import { searchMessages } from "../src/server/search"
import { startBackend } from "../src/server/index"

const MODEL = { provider: "anthropic", model: "claude-opus-5" } as const
const run = promisify(execFile)

/** Waits for a condition a background pass will make true, or gives up. */
async function until(condition: () => boolean, ms = 20_000): Promise<boolean> {
  const end = Date.now() + ms
  while (!condition()) {
    if (Date.now() > end) return false
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return true
}

/** A user message, as the store keeps one. */
function asked(sessionID: string, id: string, text: string, at: number): Message {
  return { id, sessionID, role: "user", text, attachments: [], time: { created: at } } as Message
}

export async function roundFifteenServerChecks(check: Check, section: (name: string) => void): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r15-server-"))

  // ------------------------------------------------------------------ R15-S1
  section("Round 15 (R15-S1): redo puts back a turn whose bodies are in the checkpoint store")
  {
    const dataDirectory = path.join(root, "redo", "data")
    const project = path.join(root, "redo", "project")
    await fs.mkdir(path.join(dataDirectory, "storage"), { recursive: true })
    await fs.writeFile(path.join(dataDirectory, "storage", "config.json"), "{}")
    await fs.mkdir(project, { recursive: true })
    await run("git", ["init", "-q"], { cwd: project })
    const edited = path.join(project, "hello.ts")
    const created = path.join(project, "brand-new.ts")
    await fs.writeFile(edited, "before the turn\n")

    const backend = await startBackend(dataDirectory)
    try {
      const store = backend.runtime.sessions
      const runner = backend.runtime.runner
      const session = await store.create({ directory: project, model: MODEL })

      /*
       * The shape `commitSnapshot` has written since the bodies moved into the
       * project's checkpoint store: every file a reference, the store named,
       * and the messages the turn answered recorded with it.
       */
      const blob = await runner.checkpoints.keep(project, Buffer.from("before the turn\n"))
      await store.pushSnapshot(session.id, {
        at: Date.now(),
        directory: project,
        messages: ["msg_r15_1"],
        files: [
          { path: edited, blob },
          { path: created, blob: null },
        ],
      })
      await fs.writeFile(edited, "changed by the turn\n")
      await fs.writeFile(created, "made by the turn\n")

      const undone = await runner.undo(session.id)
      check("R15-S1: undo takes back a checkpointed turn", undone === 2, undone)
      check("R15-S1: and puts the file back as the turn found it", (await fs.readFile(edited, "utf8")) === "before the turn\n")

      const parked = await store.peekSnapshot(session.id, "redo")
      check("R15-S1: the entry it parks on the redo stack still names the store its bodies are in", parked?.directory === project, parked?.directory)
      check("R15-S1: and still says which messages the turn answered", parked?.messages?.join() === "msg_r15_1", parked?.messages)

      const redone = await runner.redo(session.id).catch((failure: Error) => failure.message)
      check("R15-S1: redo puts the turn back", redone === 2, redone)
      check("R15-S1: with the edit as it was", (await fs.readFile(edited, "utf8")) === "changed by the turn\n")
      check("R15-S1: and the file the turn created", await fs.readFile(created, "utf8").then(() => true, () => false))
      const depth = await store.historyDepth(session.id)
      check("R15-S1: and the entry leaves the redo stack", depth.undo === 1 && depth.redo === 0, depth)

      const back = await store.peekSnapshot(session.id, "undo")
      check("R15-S1: the entry it returns to the undo stack is whole again", back?.directory === project && back?.messages?.join() === "msg_r15_1", {
        directory: back?.directory,
        messages: back?.messages,
      })
    } finally {
      await backend.close()
    }
  }

  // ------------------------------------------------------------------ R15-S2
  section("Round 15 (R15-S2): a turn whose closing photograph failed stops recording")
  {
    const store = path.join(root, "snap", "store")
    const project = path.join(root, "snap", "project")
    await fs.mkdir(store, { recursive: true })
    await fs.mkdir(project, { recursive: true })
    await fs.writeFile(path.join(project, "a.txt"), "one\n")
    await run("git", ["init", "-q"], { cwd: project })
    const snapshots = new Snapshots(store)

    /** One turn that ran something silent and changed a file, as the runner records it. */
    const turn = async (write: () => Promise<void>) => {
      const recording = snapshots.begin(project)
      await recording.ready()
      recording.opaque()
      await write()
      return recording.finish()
    }

    // The first turn's project is taken away under it, so its closing photograph throws.
    const first = await turn(async () => {
      await fs.writeFile(path.join(project, "a.txt"), "two\n")
      await fs.rm(project, { recursive: true, force: true })
    })
    check("R15-S2: that turn is reported as one that cannot be taken back", first.unavailable !== undefined, first.unavailable)

    await fs.mkdir(project, { recursive: true })
    await run("git", ["init", "-q"], { cwd: project })
    await fs.writeFile(path.join(project, "a.txt"), "two\n")

    // The next turns are alone in the project, and must be recorded as such.
    const second = await turn(() => fs.writeFile(path.join(project, "b.txt"), "written by a shell command\n"))
    check("R15-S2: the next turn is still recorded", second.files.map((file) => path.basename(file.path)).join() === "b.txt", {
      files: second.files.map((file) => path.basename(file.path)),
      refused: second.refused,
      unavailable: second.unavailable,
    })
    check("R15-S2: and is not refused as another conversation's work", second.refused === undefined, second.refused)
    const third = await turn(() => fs.writeFile(path.join(project, "c.txt"), "and another\n"))
    check("R15-S2: nor the one after it", third.files.map((file) => path.basename(file.path)).join() === "c.txt" && third.refused === undefined, {
      files: third.files.map((file) => path.basename(file.path)),
      refused: third.refused,
    })

    // Nothing is recording any more, so the project's store can be taken away with its last conversation.
    check("R15-S2: and the project's checkpoint store can be collected", await snapshots.collect(project))
  }


  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
}
