/**
 * The search overlay finds text inside a word again (HANDOFF R15-S3's open
 * item): round 11 moved its message search onto the word index, which only
 * knows whole words and their beginnings, so `figur` stopped finding
 * `configuration`. MiMo's overlay matches anywhere in the text. The index now
 * keeps a trigram table of what the overlay reads, with a bounded scan for
 * queries too short to have a trigram. smoke.ts calls
 * `substringSearchChecks` with its own check and section.
 *
 * Everything here runs in temporary folders of its own. Nothing reads the
 * user's profile, calls a model or reaches the network.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Check } from "./smoke-round5"
import type { Message, SessionInfo } from "../src/shared/protocol"
import { Bus } from "../src/server/bus"
import { Storage } from "../src/server/storage"
import { SessionStore } from "../src/server/session/store"
import { IndexDatabase, SCHEMA_VERSION } from "../src/server/history/database"
import { startHistory, stopHistory } from "../src/server/history/service"
import { SEARCH_HARD_CAP } from "../src/server/history/index"
import { searchMessages } from "../src/server/search"

const MODEL = { provider: "anthropic", model: "claude-opus-5" } as const

/** Waits for a condition a background pass will make true, or gives up. */
async function until(condition: () => boolean, ms = 20_000): Promise<boolean> {
  const end = Date.now() + ms
  while (!condition()) {
    if (Date.now() > end) return false
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return true
}

/** A statement's answer, or nothing when it fails - as on an index without the table - so a check fails instead of the run. */
function tolerant<T>(work: Promise<T>): Promise<T | undefined> {
  return work.catch(() => undefined)
}

function asked(sessionID: string, id: string, text: string, at: number): Message {
  return { id, sessionID, role: "user", text, attachments: [], time: { created: at } } as Message
}

/** A reply with a text part, a reasoning part and one tool call, as the store keeps one. */
function answered(sessionID: string, id: string, at: number, text: string, output: string, reasoning = ""): Message {
  return {
    id,
    sessionID,
    role: "assistant",
    model: MODEL,
    agent: "build",
    parts: [
      ...(reasoning ? [{ type: "reasoning", id: `${id}_r`, text: reasoning, time: { created: at } }] : []),
      { type: "text", id: `${id}_t`, text },
      { type: "tool", id: `${id}_k`, callID: `call_${id}`, name: "bash", status: "completed", input: { command: "cat notes" }, output, title: "cat", metadata: {}, time: { created: at, completed: at } },
    ],
    finish: "end_turn",
    time: { created: at, completed: at },
  } as unknown as Message
}

export async function substringSearchChecks(check: Check, section: (name: string) => void): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-substring-search-"))
  try {
    section("Search overlay: text inside a word is found again, through a trigram index")
    {
      const dataDirectory = path.join(root, "overlay", "data")
      const project = path.join(root, "overlay", "project")
      const elsewhere = path.join(root, "overlay", "elsewhere")
      await fs.mkdir(project, { recursive: true })
      await fs.mkdir(elsewhere, { recursive: true })
      const storage = new Storage(path.join(dataDirectory, "storage"))
      const bus = new Bus()
      const sessions = new SessionStore(storage, bus)
      const now = Date.now()
      const english = await sessions.create({ directory: project, model: MODEL, title: "Setup" })
      const tooling = await sessions.create({ directory: project, model: MODEL, title: "Tools" })
      const chinese = await sessions.create({ directory: project, model: MODEL, title: "中文" })
      const thinking = await sessions.create({ directory: project, model: MODEL, title: "Thoughts" })
      await sessions.saveMessage(asked(english.id, "msg_sub_1", "the Configuration file path should be absolute", now), true)
      await sessions.saveMessage(answered(tooling.id, "msg_sub_2", now, "Here is the listing.", 'Loaded 3 plugins; say "hello" to C:\\tmp\\zebrafinch'), true)
      await sessions.saveMessage(asked(chinese.id, "msg_sub_3", "请把配置文件的路径改成绝对路径", now), true)
      // Reasoning is not what the overlay reads, so it names no conversation.
      await sessions.saveMessage(answered(thinking.id, "msg_sub_4", now, "Done.", "ok", "privately pondering xylophonics"), true)

      const history = (await startHistory(dataDirectory, sessions, storage, bus))!
      try {
        check("substring: the index opened", history !== undefined)
        check("substring: and caught up", await until(() => !history.index.building))
        await history.index.ready
        await history.index.flush()

        let listed: SessionInfo[] = await sessions.list()
        const overlay = async (query: string) =>
          (await searchMessages(listed, (id) => sessions.messages(id), query, 50, (text) => history.index.candidates(text, listed))).map((hit) => hit.sessionID)
        const named = (query: string) => history.index.candidates(query, listed)

        check("substring: the middle of a word finds it (figur in configuration)", (await overlay("figur")).includes(english.id), await overlay("figur"))
        check("substring: so does its tail", (await overlay("uration")).includes(english.id), await overlay("uration"))
        check("substring: whatever the case it is typed in", (await overlay("FIGUR")).includes(english.id), await overlay("FIGUR"))
        check("substring: and across a word boundary", (await overlay("ion fi")).includes(english.id), await overlay("ion fi"))
        check("substring: inside a tool's output", (await overlay("brafin")).includes(tooling.id), await overlay("brafin"))
        check("substring: a query holding the quote the output's JSON escapes", (await overlay('say "hel')).includes(tooling.id), await overlay('say "hel'))
        check("substring: and the backslash", (await overlay("tmp\\zebra")).includes(tooling.id), await overlay("tmp\\zebra"))
        check("substring: a word's start still finds it", (await overlay("config")).includes(english.id), await overlay("config"))
        check("substring: and the whole word", (await overlay("configuration")).includes(english.id))
        check("substring: nothing is found for what no conversation holds", (await overlay("figurx")).length === 0, await overlay("figurx"))
        check("substring: every piece of a query must be in the same message", (await named("figur zebrafinch")).length === 0, await named("figur zebrafinch"))
        check("substring: reasoning names no conversation, as the overlay does not read it", !(await named("ophonic")).includes(thinking.id), await named("ophonic"))

        // Shorter than a trigram: the word index over the whole history, and the newest parts read.
        check("substring: two letters inside a word are found (ur)", (await overlay("ur")).includes(english.id), await overlay("ur"))
        check("substring: one letter too", (await overlay("q")).length === 0 && (await overlay("z")).includes(tooling.id), await overlay("z"))

        // Chinese, as R15-S3 made it work, at every length.
        check("substring: a Chinese word of two characters", (await overlay("配置")).includes(chinese.id), await overlay("配置"))
        check("substring: of one", (await overlay("径")).includes(chinese.id))
        check("substring: of four, through the trigram index", (await named("配置文件")).includes(chinese.id), await named("配置文件"))
        check("substring: across what a word index would call two words", (await overlay("文件的路")).includes(chinese.id), await overlay("文件的路"))
        check("substring: a Chinese phrase that is not there is not found", (await overlay("数据库")).length === 0)

        // FTS5's own syntax typed into the box is searched for, never obeyed or thrown.
        let threw = false
        try {
          for (const query of ['con* OR (', "NEAR(a b)", '"', "((", "-", "a AND"]) await named(query)
        } catch {
          threw = true
        }
        check("substring: FTS5 syntax in a query neither throws nor is obeyed", !threw)

        // Rows follow the messages they came from.
        await sessions.deleteMessage(english.id, "msg_sub_1")
        await history.index.flush()
        check("substring: a deleted message is no longer found", !(await named("figur")).includes(english.id), await named("figur"))
        await sessions.saveMessage(asked(english.id, "msg_sub_5", "reconfigured everything", now + 1), true)
        await history.index.flush()
        check("substring: and a new one is, as soon as it is written", (await named("figur")).includes(english.id), await named("figur"))
        await sessions.update(english.id, { directory: elsewhere })
        await history.index.flush()
        await new Promise((resolve) => setTimeout(resolve, 50))
        await history.index.flush()
        listed = await sessions.list()
        check("substring: moving a conversation to another project keeps it findable", (await named("figur")).includes(english.id), await named("figur"))
        await sessions.delete(tooling.id)
        await history.index.flush()
        listed = await sessions.list()
        const left = await tolerant(history.database.db.get<{ n: number }>(
          "SELECT count(*) AS n FROM history_part_trigram WHERE history_part_trigram MATCH ?",
          '"zebrafinch"',
        ))
        check("substring: a deleted conversation leaves nothing in the trigram index", left?.n === 0, left)

        // Only the rows the overlay reads are in it, each cut to what the overlay reads of a message.
        const kinds = await tolerant(history.database.db.all<{ kind: string }>(
          "SELECT DISTINCT p.kind FROM history_part_trigram t JOIN history_part p ON p.id = t.rowid WHERE history_part_trigram MATCH ?",
          '"one"',
        ))
        check("substring: reasoning rows are not indexed", kinds !== undefined && kinds.length > 0 && kinds.every((row) => row.kind === "text" || row.kind === "tool"), kinds)
      } finally {
        await stopHistory(history)
      }
    }

    section("Search overlay: the conversations read are the newest that hold the query")
    {
      const dataDirectory = path.join(root, "cap", "data")
      const project = path.join(root, "cap", "project")
      await fs.mkdir(project, { recursive: true })
      const storage = new Storage(path.join(dataDirectory, "storage"))
      const bus = new Bus()
      const sessions = new SessionStore(storage, bus)
      const base = Date.now() - 3_600_000
      const made: string[] = []
      for (let at = 0; at < SEARCH_HARD_CAP + 10; at++) {
        const session = await sessions.create({ directory: project, model: MODEL, title: `Widgets ${at}`, created: base + at * 1000, updated: base + at * 1000 })
        made.push(session.id)
        await sessions.saveMessage(asked(session.id, `msg_cap_${at}`, `the widgetry number ${at}`, base + at * 1000), true)
      }
      const archived = await sessions.create({ directory: project, model: MODEL, title: "Archived widgets", created: base + 999_999, updated: base + 999_999 })
      await sessions.saveMessage(asked(archived.id, "msg_cap_arch", "the widgetry archived", base + 999_999), true)
      await sessions.update(archived.id, { archived: true })
      const history = (await startHistory(dataDirectory, sessions, storage, bus))!
      try {
        await until(() => !history.index.building)
        await history.index.ready
        const listed = await sessions.list()
        const named = await history.index.candidates("dgetr", listed)
        check("substring: at most SEARCH_HARD_CAP conversations are named", named.length === SEARCH_HARD_CAP, named.length)
        check("substring: the newest of them", named.includes(made.at(-1)!) && !named.includes(made[0]!), { newest: named.includes(made.at(-1)!), oldest: named.includes(made[0]!) })
        check("substring: an archived one does not take a place", !named.includes(archived.id))
      } finally {
        await stopHistory(history)
      }
    }

    section("Search overlay: the trigram index at scale, and an older index rebuilt")
    {
      const file = path.join(root, "scale", "index", "search.db")
      const database = await IndexDatabase.open(file)
      try {
        check("substring: the schema version was bumped, so an older index is rebuilt", SCHEMA_VERSION === 3, SCHEMA_VERSION)
        const PARTS = 4000
        const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"]
        await database.transaction(async (tx) => {
          for (let at = 0; at < PARTS; at++) {
            const body = Array.from({ length: 60 }, (_, n) => words[(at * 7 + n * 3) % words.length]).join(" ") + (at % 4 === 0 ? " reconfiguration" : "")
            await tx.run(
              "INSERT INTO history_part (part_id, session_id, message_id, project, kind, tool_name, body, search_body, time_created) VALUES (?, ?, ?, ?, ?, ?, ?, '', ?)",
              `ses_s${at % 200}/msg_s${at}/text`,
              `ses_s${at % 200}`,
              `msg_s${at}`,
              "p",
              at % 10 === 0 ? "reasoning" : "text",
              null,
              body,
              at,
            )
          }
        })
        const indexed = await tolerant(database.db.get<{ n: number }>("SELECT count(*) AS n FROM history_part_trigram"))
        check("substring: every text row and no reasoning row is in the trigram index", indexed?.n === PARTS - PARTS / 10, indexed)
        const started = performance.now()
        let found = 0
        for (let run = 0; run < 10; run++) {
          found =
            (
              await tolerant(
                database.db.all(
                  "SELECT DISTINCT p.session_id FROM history_part_trigram t JOIN history_part p ON p.id = t.rowid WHERE history_part_trigram MATCH ?",
                  '"figur"',
                ),
              )
            )?.length ?? 0
        }
        const ms = (performance.now() - started) / 10
        console.log(`  ..   ${PARTS} parts: figur inside a word in ${ms.toFixed(2)}ms`)
        check("substring: a word's middle is looked up in the index, not by a scan", found > 0 && ms < 50, { found, ms })
        const long = "x".repeat(20_500) + " needleinhay"
        await database.db.run(
          "INSERT INTO history_part (part_id, session_id, message_id, project, kind, tool_name, body, search_body, time_created) VALUES ('ses_l/msg_l/text', 'ses_l', 'msg_l', 'p', 'text', NULL, ?, '', 0)",
          long,
        )
        const past = await tolerant(database.db.get<{ n: number }>("SELECT count(*) AS n FROM history_part_trigram WHERE history_part_trigram MATCH ?", '"needleinhay"'))
        const within = await tolerant(database.db.get<{ n: number }>("SELECT count(*) AS n FROM history_part_trigram WHERE history_part_trigram MATCH ?", '"xxxxxxxx"'))
        check("substring: past the 20,000 characters the overlay reads of a message, nothing is indexed", past?.n === 0 && within?.n === 1, { past, within })
        await database.db.exec("PRAGMA user_version = 2")
      } finally {
        await database.close()
      }
      const again = await IndexDatabase.open(file)
      try {
        check("substring: an index at schema 2 is made again", again.openedAs === "recreated", again.openedAs)
        const tables = await again.db.get<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE name = 'history_part_trigram'")
        check("substring: and has the trigram table", tables?.n === 1)
      } finally {
        await again.close()
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}
