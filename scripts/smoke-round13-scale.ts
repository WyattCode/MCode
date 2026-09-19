/**
 * Round 13 (lane S): what the backend does with a lot of data - a diff of a
 * very large file, the usage page over thousands of conversations, and the
 * conversation list kept current instead of re-read (S13-1 onwards). Kept apart
 * from smoke.ts the way the earlier rounds are; smoke.ts calls
 * `roundThirteenScaleChecks` with its own check and section.
 *
 * Everything here runs in temporary folders of its own. Nothing reads the
 * user's profile, calls a model or reaches the network.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Check } from "./smoke-round5"
import type { Runtime } from "../src/server/index"
import type { Request, UsageSummary } from "../src/shared/protocol"
import { DIFF_EDIT_LIMIT, unifiedDiff } from "../src/server/diff"
import { Storage } from "../src/server/storage"
import { Bus } from "../src/server/bus"
import { SessionStore } from "../src/server/session/store"
import { UsageDays } from "../src/server/session/usage-days"
import { BackgroundUsage } from "../src/server/session/background-usage"
import { summarizeUsage, type UsageRecord } from "../src/server/usage-summary"
import { handle } from "../src/server/handlers"

const DAY = 24 * 60 * 60 * 1000

/** The usage page's figures the way they were found before S13-2: every message of every conversation. */
async function scannedSummary(store: SessionStore, background: BackgroundUsage, days: number, now: number): Promise<UsageSummary> {
  const records: UsageRecord[] = []
  for (const session of await store.list()) {
    for (const message of await store.messages(session.id)) {
      if (message.role !== "assistant" || !message.usage) continue
      records.push({ at: message.time.created, model: message.model, usage: message.usage, turn: true })
    }
  }
  for (const entry of await background.list()) records.push({ at: entry.at, model: entry.model, usage: entry.usage, turn: false })
  return summarizeUsage(records, days, now)
}

/** Two summaries alike: every count exact, money to within rounding of the order it was added in. */
function sameSummary(a: UsageSummary, b: UsageSummary): boolean {
  const alike = (x: unknown, y: unknown, key = ""): boolean => {
    if (key === "cost" && typeof x === "number" && typeof y === "number") return Math.abs(x - y) < 1e-9
    if (typeof x !== "object" || x === null || typeof y !== "object" || y === null) return x === y
    const keys = Object.keys(x)
    return keys.length === Object.keys(y).length && keys.every((name) => alike((x as Record<string, unknown>)[name], (y as Record<string, unknown>)[name], name))
  }
  return alike(a, b)
}

/** Rebuilds the new text from the old one and a diff, or undefined when the diff does not fit the old text. */
function applyDiff(before: string, diff: string): string | undefined {
  const old = before === "" ? [] : before.split("\n")
  const out: string[] = []
  let at = 0
  const lines = diff.split("\n").slice(2)
  for (let index = 0; index < lines.length; ) {
    const head = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(lines[index++])
    if (!head) return undefined
    const start = Number(head[1]) - 1
    while (at < start) out.push(old[at++])
    while (index < lines.length && !lines[index].startsWith("@@")) {
      const line = lines[index++]
      const body = line.slice(1)
      if (line[0] === " " || line[0] === "-") {
        if (old[at] !== body) return undefined
        at++
      }
      if (line[0] === " " || line[0] === "+") out.push(body)
    }
  }
  while (at < old.length) out.push(old[at++])
  return out.join("\n")
}

export async function roundThirteenScaleChecks(check: Check, section: (name: string) => void): Promise<void> {
  // ------------------------------------------------------------------ S13-1
  section("Round 13 (S13-1): a diff of a very large file stays quick and small")
  {
    // What the line-by-line table this replaced printed for the same edits, byte for byte.
    const golden: [string, string, string][] = [
      ["one\ntwo\nthree\n", "one\nTWO\nthree\n", "--- a/f.txt\n+++ b/f.txt\n@@ -1,4 +1,4 @@\n one\n-two\n+TWO\n three\n "],
      ["", "brand new\n", "--- a/f.txt\n+++ b/f.txt\n@@ -1,0 +1,2 @@\n+brand new\n+"],
      [
        "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\n",
        "a\nb\nX\nc\nd\ne\nf\ng\nh\ni\nj\nk\nm\nZ\n",
        "--- a/f.txt\n+++ b/f.txt\n@@ -1,5 +1,6 @@\n a\n b\n+X\n c\n d\n e\n@@ -9,6 +10,6 @@\n i\n j\n k\n-l\n m\n+Z\n ",
      ],
      [
        "function f() {\n  return 1\n}\n\nfunction g() {\n  return 2\n}\n",
        "function f() {\n  return 10\n}\n\nfunction h() {\n  return 3\n}\n\nfunction g() {\n  return 2\n}\n",
        "--- a/f.txt\n+++ b/f.txt\n@@ -1,7 +1,11 @@\n function f() {\n-  return 1\n+  return 10\n }\n \n+function h() {\n+  return 3\n+}\n+\n function g() {\n   return 2\n }",
      ],
      ["keep\nremove me\nkeep too\n", "keep\nkeep too\n", "--- a/f.txt\n+++ b/f.txt\n@@ -1,4 +1,3 @@\n keep\n-remove me\n keep too\n "],
      ["x\ny\n", "", "--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,0 @@\n-x\n-y\n-"],
    ]
    const drifted = golden.filter(([before, after, expected]) => unifiedDiff("f.txt", before, after) !== expected)
    check("ordinary edits print exactly what they printed before", drifted.length === 0, drifted.map(([a, b]) => unifiedDiff("f.txt", a, b)))
    check("identical sides still give nothing", unifiedDiff("f.txt", "same\n", "same\n") === "")

    // Random small edits over a small vocabulary (so lines repeat): the diff must rebuild the new side exactly.
    let seed = 13
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    const vocabulary = ["{", "}", "", "  return x", "foo()", "bar()", "// note"]
    const broken: unknown[] = []
    for (let round = 0; round < 3000 && broken.length < 3; round++) {
      const a = Array.from({ length: 1 + Math.floor(random() * 30) }, () =>
        random() < 0.5 ? vocabulary[Math.floor(random() * vocabulary.length)] : `line ${Math.floor(random() * 100)}`,
      )
      const b = a.slice()
      for (let edit = 1 + Math.floor(random() * 4); edit > 0; edit--) {
        const kind = random()
        const at = Math.floor(random() * (b.length + 1))
        if (kind < 0.33) b.splice(at, 1)
        else if (kind < 0.66) b.splice(at, 0, vocabulary[Math.floor(random() * vocabulary.length)])
        else b[at] = `changed ${round}`
      }
      const diff = unifiedDiff("f", a.join("\n"), b.join("\n"))
      if (applyDiff(a.join("\n"), diff) !== b.join("\n")) broken.push({ a, b, diff })
    }
    check("every diff of a random edit rebuilds the new text from the old", broken.length === 0, broken)

    const big = (n: number) => Array.from({ length: n }, (_, i) => `const value${i} = compute(${i}) // line ${i}`)
    for (const n of [40_000, 70_000]) {
      const lines = big(n)
      const before = lines.join("\n")
      lines[n >> 1] = "const changed = true"
      const started = performance.now()
      const diff = unifiedDiff("f.ts", before, lines.join("\n"))
      const took = performance.now() - started
      check(`one line changed in ${n} lines takes well under a second`, took < 500 && diff.split("\n").length === 11, [Math.round(took), diff])
      check(`and it is the usual one-line hunk (${n})`, diff.includes(`@@ -${(n >> 1) - 2},7 +${(n >> 1) - 2},7 @@`) && diff.includes("\n+const changed = true"), diff)
    }

    // Scattered edits up to the budget are still aligned line by line.
    {
      const before = big(40_000)
      const after = before.map((line, i) => (i % 50 === 0 ? `${line} // edited` : line))
      const started = performance.now()
      const diff = unifiedDiff("f.ts", before.join("\n"), after.join("\n"))
      const took = performance.now() - started
      check("800 scattered edits in 40000 lines are aligned, quickly", took < 1000 && applyDiff(before.join("\n"), diff) === after.join("\n") && diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).length === 800, Math.round(took))
    }

    // Past the budget the changed middle is one replaced block: every old line out, then every new one in.
    {
      const before = big(70_000)
      const after = before.map((line) => `${line}!`)
      const started = performance.now()
      const diff = unifiedDiff("f.ts", before.join("\n"), after.join("\n"))
      const took = performance.now() - started
      const body = diff.split("\n").slice(3)
      const firstAdd = body.findIndex((line) => line.startsWith("+"))
      check(
        `a rewrite of 70000 lines (past ${DIFF_EDIT_LIMIT} edits) is one replaced block, in well under a second`,
        took < 1000 && firstAdd === 70_000 && body.slice(0, firstAdd).every((line) => line.startsWith("-")) && body.slice(firstAdd).every((line) => line.startsWith("+")),
        [Math.round(took), firstAdd],
      )
      check("and it still rebuilds the new text", applyDiff(before.join("\n"), diff) === after.join("\n"))
      // A replaced block with the same lines around it keeps them as context.
      const framed = ["top", ...before.slice(0, 5000), "bottom"]
      const reframed = ["top", ...before.slice(0, 5000).map((line) => `${line}?`), "bottom"]
      const diff2 = unifiedDiff("f.ts", framed.join("\n"), reframed.join("\n"))
      check("the lines around a replaced block stay as context", diff2.split("\n")[2] === "@@ -1,5002 +1,5002 @@" && diff2.split("\n")[3] === " top" && diff2.endsWith("\n bottom"), diff2.split("\n").slice(0, 4))
    }
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r13-scale-"))
  try {
    // ------------------------------------------------------------------ S13-2
    section("Round 13 (S13-2): the usage page sums daily totals, and they are the figures the transcripts give")
    {
      const data = path.join(root, "usage", "storage")
      const storage = new Storage(data)
      const store = new SessionStore(storage, new Bus())
      const background = new BackgroundUsage(storage)
      const now = Date.now()
      const boundary = now - 14 * DAY
      const models = [
        { provider: "a", model: "priced" },
        { provider: "b", model: "free" },
        { provider: "c", model: "other" },
      ]
      let serial = 0
      const turn = async (sessionID: string, at: number, index: number) => {
        const model = models[index % 3]
        const usage = { input: 100 + index, output: 10 + (index % 7), reasoning: index % 3, cacheRead: index % 5, cacheWrite: 0, cost: model.provider === "a" ? 0.013 * (1 + (index % 4)) : 0 }
        const id = `msg_${at.toString(16).padStart(12, "0")}${String(serial++).padStart(6, "0")}`
        await store.saveMessage({ id, sessionID, role: "assistant", model, agent: "build", parts: [], finish: "end_turn", usage, time: { created: at, completed: at } } as never, true, false)
      }
      const sessions: string[] = []
      for (let s = 0; s < 30; s++) {
        const session = await store.create({ directory: root, model: models[0] })
        sessions.push(session.id)
        // Spread from three weeks back to now, with some on each side of the moment the window starts.
        for (let k = 0; k < 6; k++) await turn(session.id, now - ((s * 6 + k) % 21) * DAY - (k % 2 ? 3600_000 : 0) - s * 1000, s + k)
        if (s % 5 === 0) {
          await turn(session.id, boundary + 60_000, s)
          await turn(session.id, boundary - 60_000, s + 1)
        }
      }
      // A turn with no priced model and no tokens: neither priced nor unpriced.
      await store.saveMessage({ id: "msg_zero", sessionID: sessions[1], role: "assistant", model: models[1], agent: "build", parts: [], usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, time: { created: now - DAY } } as never, true, false)
      await background.add({ at: now - 2 * DAY, sessionID: sessions[0], model: models[2], usage: { input: 7, output: 3, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, kind: "title" })

      const days = new UsageDays(storage, store)
      const runtime = { runner: { usageDays: days, backgroundUsage: background } } as unknown as Runtime
      const page = async () => ((await handle(runtime, { type: "usage.summary", days: 14 } as unknown as Request)) as { summary: UsageSummary }).summary
      const first = await page()
      const scanned = await scannedSummary(store, background, 14, Date.now())
      check("the first page after the upgrade gives the figures reading every transcript gave", sameSummary(first, scanned) && first.turns > 50 && first.byModel.length === 3, [first, scanned])
      check("including the day the window starts in, counted from the moment it starts", first.byDay[0]?.key === scanned.byDay[0]?.key && sameSummary({ ...first, byDay: first.byDay.slice(0, 1) }, { ...scanned, byDay: scanned.byDay.slice(0, 1) }), [first.byDay[0], scanned.byDay[0]])
      const file = path.join(data, "usage-daily.json")
      const written = JSON.parse(await fs.readFile(file, "utf8")) as { version: number; sessions: Record<string, unknown> }
      check("the totals are written down, versioned, one entry per conversation", written.version === 1 && Object.keys(written.sessions).length === 30, Object.keys(written))

      // A restart: the totals are read back, and only conversations with turns on the window's first day are opened.
      const original = store.messages.bind(store)
      let opened = 0
      store.messages = async (id: string) => {
        opened++
        return original(id)
      }
      const again = new UsageDays(storage, store)
      const againRuntime = { runner: { usageDays: again, backgroundUsage: background } } as unknown as Runtime
      const reread = ((await handle(againRuntime, { type: "usage.summary", days: 14 } as unknown as Request)) as { summary: UsageSummary }).summary
      const openedByPage = opened
      const firstDay = (await scannedSummary(store, background, 14, Date.now())).byDay[0]?.key
      let onFirstDay = 0
      for (const id of sessions) if ((await original(id)).some((message) => message.role === "assistant" && new Date(message.time.created).toDateString() === new Date(`${firstDay}T12:00`).toDateString())) onFirstDay++
      check("after a restart the page opens only the transcripts on the window's first day", openedByPage === onFirstDay && onFirstDay < 30 && sameSummary(reread, scanned), { openedByPage, onFirstDay })

      // Every way a transcript changes, followed.
      opened = 0
      await turn(sessions[3], Date.now(), 99)
      await store.addUsage(sessions[3], { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 })
      check("a new turn is counted, and only its conversation is read again", sameSummary(await page(), await scannedSummary(store, background, 14, Date.now())) && opened > 0)
      const doomed = (await original(sessions[4])).find((message) => message.role === "assistant" && message.time.created > Date.now() - 5 * DAY)
      await store.deleteMessage(sessions[4], doomed!.id)
      check("a message taken back by a retry is no longer counted", sameSummary(await page(), await scannedSummary(store, background, 14, Date.now())))
      await store.delete(sessions[6])
      const afterDelete = await page()
      check("a deleted conversation is no longer counted", sameSummary(afterDelete, await scannedSummary(store, background, 14, Date.now())))
      const middle = (await original(sessions[7])).at(-1)!
      await store.fork(sessions[7], middle.id)
      check("a branch's copied turns count as they did", sameSummary(await page(), await scannedSummary(store, background, 14, Date.now())))

      // Damaged: moved aside and counted again from the transcripts, once.
      await fs.writeFile(file, "{ not json")
      const healed = new UsageDays(storage, store)
      const healedRuntime = { runner: { usageDays: healed, backgroundUsage: background } } as unknown as Runtime
      const warn = console.warn
      console.warn = () => undefined
      const fixed = ((await handle(healedRuntime, { type: "usage.summary", days: 14 } as unknown as Request)) as { summary: UsageSummary }).summary
      console.warn = warn
      const names = await fs.readdir(data)
      check("a damaged totals file is moved aside and the figures are counted again", sameSummary(fixed, await scannedSummary(store, background, 14, Date.now())) && names.some((name) => name.startsWith("usage-daily.json.corrupt-") || name.startsWith("usage-daily.corrupt-")), names)
      check("and a whole one is written in its place", JSON.parse(await fs.readFile(file, "utf8")).version === 1)
      // Another shape's version is not trusted.
      await fs.writeFile(file, JSON.stringify({ version: 99, sessions: { [sessions[0]]: { updated: 0, rows: [["2000-01-01", "x/y", 1e9, 0, 0, 0, 0, 0, 1, 0, 1]] } } }))
      const other = new UsageDays(storage, store)
      const otherRuntime = { runner: { usageDays: other, backgroundUsage: background } } as unknown as Runtime
      const rebuilt = ((await handle(otherRuntime, { type: "usage.summary", days: 365 } as unknown as Request)) as { summary: UsageSummary }).summary
      check("a totals file of another version is built again", sameSummary(rebuilt, await scannedSummary(store, background, 365, Date.now())) && !rebuilt.byModel.some((entry) => entry.key === "x/y"), rebuilt)

      // The running app keeps up after a step without the page being opened.
      const live = new UsageDays(storage, store)
      live.start()
      await live.refresh()
      await turn(sessions[8], Date.now(), 5)
      await new Promise((resolve) => setTimeout(resolve, 2600))
      const kept = JSON.parse(await fs.readFile(file, "utf8")) as { sessions: Record<string, { rows: unknown[][] }> }
      const rowTurns = (kept.sessions[sessions[8]]?.rows ?? []).reduce((sum, row) => sum + Number(row[8]), 0)
      check("a step's usage reaches the totals file on its own shortly after", rowTurns === (await original(sessions[8])).filter((message) => message.role === "assistant").length, rowTurns)
      await live.stop()
      store.messages = original
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}
