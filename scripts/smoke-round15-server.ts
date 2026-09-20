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

  // ------------------------------------------------------------------ R15-S3
  section("Round 15 (R15-S3): conversation and memory search find Chinese again")
  {
    const dataDirectory = path.join(root, "cjk", "data")
    const project = path.join(root, "cjk", "project")
    await fs.mkdir(project, { recursive: true })
    const storage = new Storage(path.join(dataDirectory, "storage"))
    const bus = new Bus()
    const sessions = new SessionStore(storage, bus)
    const chinese = await sessions.create({ directory: project, model: MODEL, title: "配置" })
    const english = await sessions.create({ directory: project, model: MODEL, title: "config" })
    const now = Date.now()
    await sessions.saveMessage(asked(chinese.id, "msg_cjk_1", "请把配置文件的路径改成绝对路径", now), true)
    await sessions.saveMessage(asked(english.id, "msg_cjk_2", "the configuration file path should be absolute", now), true)

    const memoryRoot = path.join(dataDirectory, "memory", "global")
    await fs.mkdir(memoryRoot, { recursive: true })
    await fs.writeFile(path.join(memoryRoot, "MEMORY.md"), "# 记事\n\n用户偏好把配置文件放在项目根目录。\n")

    const history = (await startHistory(dataDirectory, sessions, storage, bus))!
    try {
      check("R15-S3: the index opened", history !== undefined)
      // `ready` is only the comparison's promise once `start` has got that far.
      const settled = await until(() => !history.index.building)
      await history.index.ready
      await history.index.flush()
      check("R15-S3: and caught up with the conversations", settled)
      check("R15-S3: both conversations are indexed", (await history.index.count()) >= 2, await history.index.count())

      const hits = async (query: string) => (await history.index.search({ query, limit: 50 })).map((hit) => hit.session_id)
      check("R15-S3: a Chinese word inside a sentence is found", (await hits("配置")).includes(chinese.id), await hits("配置"))
      check("R15-S3: so is one in the middle of it", (await hits("路径")).includes(chinese.id), await hits("路径"))
      check("R15-S3: and a single character", (await hits("径")).includes(chinese.id), await hits("径"))
      check("R15-S3: the whole sentence still matches", (await hits("请把配置文件的路径改成绝对路径")).includes(chinese.id))
      check("R15-S3: a Chinese word the conversation does not hold is not found", (await hits("数据库")).length === 0, await hits("数据库"))
      check("R15-S3: English words still match whole", (await hits("configuration")).includes(english.id), await hits("configuration"))
      check("R15-S3: and a Chinese query does not drag English conversations in", !(await hits("配置")).includes(english.id))

      // The snippet is read out of the indexed column, so it must read as it was written.
      const snippet = (await history.index.search({ query: "配置文件", limit: 1 }))[0]?.snippet ?? ""
      check("R15-S3: the snippet reads as the message was written", snippet.replaceAll("<<", "").replaceAll(">>", "").includes("请把配置文件的路径"), snippet)

      // What the overlay actually asks: the index names the conversations, and the reader scores them.
      const listed = await sessions.list()
      const overlay = (query: string) =>
        searchMessages(listed, (id) => sessions.messages(id), query, 50, (text) => history.index.candidates(text, listed))
      check("R15-S3: the search overlay finds the Chinese conversation", (await overlay("配置文件")).some((hit) => hit.sessionID === chinese.id), await overlay("配置文件"))
      check("R15-S3: while a word is still being typed", (await overlay("配置文")).some((hit) => hit.sessionID === chinese.id))
      check("R15-S3: and an English word being typed reaches the longer one", (await overlay("config")).some((hit) => hit.sessionID === english.id), await overlay("config"))
      check("R15-S3: a query that is in neither finds neither", (await overlay("数据库")).length === 0)

      const memory = async (query: string) => (await history.memory.search({ query })).map((hit) => path.basename(hit.path))
      check("R15-S3: memory search finds a Chinese word inside a line", (await memory("配置文件")).includes("MEMORY.md"), await memory("配置文件"))
      check("R15-S3: and one character of it", (await memory("根目录")).includes("MEMORY.md"), await memory("根目录"))
      const note = (await history.memory.search({ query: "配置文件" }))[0]?.snippet ?? ""
      check("R15-S3: whose snippet reads as the file was written", note.replaceAll("<<", "").replaceAll(">>", "").includes("把配置文件放在"), note)
    } finally {
      await stopHistory(history)
    }

    // The words themselves, so what the index is asked for is visible in one place.
    check("R15-S3: a Chinese body is indexed one character at a time", searchText("配置文件") === "配 置 文 件", searchText("配置文件"))
    check("R15-S3: English is indexed exactly as written", searchText("configuration file") === "configuration file")
    check("R15-S3: a Chinese query is asked for as that phrase", ftsQuery("配置", "AND") === '"配 置"', ftsQuery("配置", "AND"))
    check("R15-S3: a typed query asks for the last word as a prefix", ftsQuery("配置 lo", "AND", true) === '"配 置" AND "lo"*', ftsQuery("配置 lo", "AND", true))
    check("R15-S3: and a snippet's markers survive being read back", plainSnippet("请 把 <<配 置>> 文 件") === "请把<<配置>>文件", plainSnippet("请 把 <<配 置>> 文 件"))
  }

  // --------------------------------------------------------------- R15-S3 (b)
  section("Round 15 (R15-S3): the index from the older schema is rebuilt without being asked")
  {
    const file = path.join(root, "rebuild", "index", "search.db")
    const first = await IndexDatabase.open(file)
    check("R15-S3: a new index is made", first.openedAs === "created", first.openedAs)
    await first.db.exec("PRAGMA user_version = 1")
    await first.close()

    const second = await IndexDatabase.open(file)
    check("R15-S3: one written by the older schema is made again on its own", second.openedAs === "recreated", second.openedAs)
    const version = Number((await second.db.get<{ user_version: number }>("PRAGMA user_version"))?.user_version ?? 0)
    check("R15-S3: at the schema this build reads", version === 2, version)
    await second.close()
  }

  // --------------------------------------------------------------- R15-S3 (c)
  section("Round 15 (R15-S3): what the search costs at a few thousand messages")
  {
    const file = path.join(root, "bench", "index", "search.db")
    const database = await IndexDatabase.open(file)
    try {
      /*
       * The shape a search index has after a long history: a few thousand
       * parts, some Chinese and some English. Written straight into the
       * database, because what is being measured is the query and not the
       * walk over the conversations that fills it.
       */
      const PARTS = 4000
      const lines = [
        "请把配置文件的路径改成绝对路径，不要用相对路径",
        "the configuration file path should be absolute, not relative",
        "把这个函数拆成两个，分别处理读取和写入",
        "split this function in two, one for reading and one for writing",
      ]
      await database.transaction(async (tx) => {
        for (let at = 0; at < PARTS; at++) {
          const body = `${lines[at % lines.length]} #${at}`
          await tx.run(
            "INSERT INTO history_part (part_id, session_id, message_id, project, kind, tool_name, body, search_body, time_created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            `bench/${at}`,
            `ses_${at % 200}`,
            `msg_${at}`,
            "bench",
            "text",
            null,
            body,
            searchText(body),
            Date.now(),
          )
        }
      })
      // The same bodies indexed the way they were before this round, for the comparison.
      await database.db.exec("CREATE VIRTUAL TABLE bench_old USING fts5(body, content='history_part', content_rowid='id', tokenize='unicode61 remove_diacritics 1')")
      await database.db.exec("INSERT INTO bench_old(bench_old) VALUES ('rebuild')")

      const time = async (work: () => Promise<unknown>) => {
        await work()
        const started = performance.now()
        for (let at = 0; at < 10; at++) await work()
        return (performance.now() - started) / 10
      }
      const query = async (table: string, expression: string) =>
        (
          await database.db.all<{ n: number }>(
            `SELECT count(*) AS n FROM ${table} JOIN history_part p ON p.id = ${table}.rowid WHERE ${table} MATCH ?`,
            expression,
          )
        )[0]!.n

      const before = await time(() => query("bench_old", ftsQuery("configuration", "AND")!))
      const after = await time(() => query("history_part_fts", ftsQuery("configuration", "AND")!))
      const chinese = await time(() => query("history_part_fts", ftsQuery("配置", "AND")!))
      const oldChinese = await query("bench_old", '"配置"')
      const newChinese = await query("history_part_fts", ftsQuery("配置", "AND")!)
      console.log(`  ..   ${PARTS} parts: English ${before.toFixed(2)}ms before, ${after.toFixed(2)}ms after; 配置 ${chinese.toFixed(2)}ms`)
      check("R15-S3: the Chinese query found nothing before", oldChinese === 0, oldChinese)
      check("R15-S3: and finds every part that holds it now", newChinese === PARTS / 4, newChinese)
      check("R15-S3: an English search costs what it did", after < Math.max(before * 3, 25), { before, after })
      check("R15-S3: and a Chinese one is answered by the index, not by a scan", chinese < 50, chinese)
    } finally {
      await database.close()
    }
  }


  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
}
