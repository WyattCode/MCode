/**
 * Round 78: what was left over, and closing it.
 *
 * Three of the notes the handoff carried as "small tails" turned out to be
 * real and cheap. Two are fixed here, each with the check that would have
 * caught it:
 *
 *   1. `command -v rm` raised the delete card. `command` was in the scanner's
 *      wrapper table, and a wrapper runs the word after it - but `-v` and `-V`
 *      are the two spellings of `command` that do not run anything. Every
 *      careful reader of the system prompt writes this line at least once, so
 *      the wrong card appeared on a harmless lookup often.
 *   2. The id counter's high-water mark lived in this process's memory only.
 *      It stopped the clock going backwards inside one run and nothing more:
 *      quit, set the clock back a day, launch again, and the first message
 *      written sorted before every message already in the conversation.
 *
 * smoke.ts calls `roundSeventyEightChecks` with its own check and section.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Bus } from "../src/server/bus"
import { SessionStore } from "../src/server/session/store"
import { Storage } from "../src/server/storage"
import { scanCommand } from "../src/server/tool/bash-scan"
import { adopt, Identifier } from "../src/shared/id"
import type { Message } from "../src/shared/protocol"
import type { Check } from "./smoke-round5"

/** The 12-hex-digit timestamp an id carries, which is what sorts it. */
function stampOf(id: string): number {
  return Number.parseInt(id.slice(4, 16), 16)
}

export async function roundSeventyEightChecks(check: Check, section: (name: string) => void): Promise<void> {
  const project = process.platform === "win32" ? "C:\\work\\proj" : "/work/proj"
  const asks = async (line: string) => (await scanCommand(line, project, project, false)).deletes.length > 0

  // --------------------------------------------------------------- R78-1
  section("Round 78 (1): `command -v` looks a program up; it does not run it")
  {
    /*
     * A wrapper runs the word after it, so `command rm -rf src` must still ask
     * - that is the case the wrapper table is for. Only the two flags that
     * make `command` a lookup are exempt.
     */
    for (const line of ["command -v rm", "command -V rm", "command -pv rm", "command -v python3"]) {
      check(`${line} asks nothing`, !(await asks(line)))
    }
    for (const line of ["command rm -rf src", "command -p rm -rf src", "command -- rm -rf src"]) {
      check(`${line} still asks`, await asks(line))
    }
    // What the scanner already caught keeps being caught.
    for (const line of ["rm -rf src", 'bash -c "rm -rf src"', "sudo -u bob rm -rf src", 'find . -name "*.log" -exec rm {} +']) {
      check(`${line} still asks`, await asks(line))
    }
  }

  // --------------------------------------------------------------- R78-2
  section("Round 78 (2): an id written after a restart still sorts after what is on disk")
  {
    /*
     * The damage: ids sort as strings, and the string's first 12 hex digits are
     * the clock. A message written a day after the clock was set back lands in
     * yesterday's slot, so the transcript reads out of order and "delete from
     * this message on" cuts the wrong span.
     */
    const day = 24 * 60 * 60 * 1000
    const future = (Date.now() + day).toString(16).padStart(12, "0")
    const onDisk = `msg_${future}0000abcdef0123456789`
    check("the disk id is ahead of this process's clock", stampOf(onDisk) > Date.now())
    check("an id made before adopting sorts before it", Identifier.message() < onDisk)

    adopt("msg", onDisk)
    const after = Identifier.message()
    check("after adopting, a new id sorts after it", after > onDisk, { onDisk, after })
    check("and it stays ahead", Identifier.message() > after)

    /*
     * A different prefix is untouched: adopting a message id must not drag the
     * session counter forward with it. Compared by timestamp, not by string -
     * `prt_…` and `msg_…` sort by their prefix letter (`p` > `m`) before the
     * clock is ever read, so a plain `<` says nothing about when they were made.
     */
    check("adopting `msg` leaves `prt` alone", stampOf(Identifier.part()) < stampOf(onDisk))

    // A malformed id is ignored rather than poisoning the counter.
    const before = Identifier.message()
    adopt("msg", "not-an-id")
    adopt("msg", "msg_zzzzzzzzzzzz0000")
    check("a damaged id changes nothing", Identifier.message() >= before)
  }

  // --------------------------------------------------------------- R78-3
  section("Round 78 (3): the store adopts the floor when it reads a conversation")
  {
    /*
     * `adopt` is only worth having if something calls it on the way through a
     * normal read, which is what closed the restart hole.
     */
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r78-"))
    try {
      const store = new SessionStore(new Storage(root), new Bus())
      const session = await store.create({ directory: root })
      const day = 24 * 60 * 60 * 1000
      const future = (Date.now() + day).toString(16).padStart(12, "0")
      const planted = `msg_${future}0000abcdef0123456789`
      const message: Message = { id: planted, sessionID: session.id, role: "user", text: "planted", attachments: [], time: { created: Date.now() } }
      await store.saveMessage(message, true)

      const read = await store.messageIDs(session.id)
      check("the planted message is on disk", read.includes(planted), read)
      const fresh = Identifier.message()
      check("reading the conversation raised the floor", fresh > planted, { planted, fresh })
      check("so the next message sorts last", [...read, fresh].sort().at(-1) === fresh)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }
}