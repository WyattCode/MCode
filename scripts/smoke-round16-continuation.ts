/**
 * Round 16 (fix lane E2): a reply the output limit cut in two, and the day the
 * model is told it is.
 *
 * A provider that stops with `length` is asked to carry on, and what comes back
 * is the rest of the same sentence. It used to land in a message of its own,
 * which split the reply in half: a ```sci-widget fence opened before the cut
 * and closed after it was an unclosed fence in one message and a stray closing
 * one in the next, so the card rendered as a code block and the explanation
 * after it was swallowed as a second one. The checks below run whole turns
 * through the real runner over a fake provider that can stop where it is told
 * to, and then render what was stored exactly as the conversation renders it.
 *
 * The second half is the runtime context's `Today:` line, which was read off
 * UTC: east of Greenwich every conversation opened before the offset had passed
 * was told yesterday's date.
 *
 * Kept apart from smoke.ts the way the earlier rounds are; smoke.ts calls
 * `roundSixteenContinuationChecks` with its own check and section.
 *
 * Everything runs in temporary folders of its own. Nothing reads the user's
 * profile, calls a real model or reaches the network.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createServer } from "node:http"
import type { Check } from "./smoke-round5"
import type { AssistantMessage } from "../src/shared/protocol"
import { Storage } from "../src/server/storage"
import { Config } from "../src/server/config"
import { Bus } from "../src/server/bus"
import { Permissions } from "../src/server/permission"
import { SessionStore } from "../src/server/session/store"
import { SessionRunner } from "../src/server/session/runner"
import { CONTINUATION_LIMITS, EMPTY_NOTE, LENGTH_NOTE } from "../src/server/session/reminders"
import { localDay } from "../src/server/usage-summary"
import { renderReply, type ReplyBlock } from "../src/renderer/src/lib/markdown"
import { cleanReply } from "../src/shared/reply-clean"

type Section = (name: string) => void

/** One scripted step: what the model writes, and why it stops. */
type Step = { text: string; finish: "stop" | "length" }

/** What the fake provider saw of one request. */
type Seen = { messages: { role: string; content?: unknown }[] }

export async function roundSixteenContinuationChecks(check: Check, section: Section): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r16e2-"))
  // The fake provider answers from a script; a background title request would take a step off it.
  const titles = process.env.MCODE_GENERATE_TITLES
  process.env.MCODE_GENERATE_TITLES = "0"
  try {
    await continuationChecks(check, section, root)
    await dateChecks(check, section, root)
  } finally {
    if (titles === undefined) delete process.env.MCODE_GENERATE_TITLES
    else process.env.MCODE_GENERATE_TITLES = titles
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** An app over a fake provider that writes each scripted step and stops the way that step says. */
async function harness(root: string, at: string) {
  const seen: Seen[] = []
  let steps: Step[] = []
  let sent = 0
  const provider = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk) => (body += chunk))
    request.on("end", () => {
      const asked = JSON.parse(body || "{}") as { messages?: Seen["messages"] }
      seen.push({ messages: asked.messages ?? [] })
      const step = steps[sent] ?? { text: "done", finish: "stop" as const }
      sent += 1
      response.writeHead(200, { "content-type": "text/event-stream" })
      if (step.text) response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: step.text } }] })}\n\n`)
      // The counts differ per step, so the merged message's arithmetic can be read off them.
      const usage = { prompt_tokens: 100 + sent, completion_tokens: 10 * sent }
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: step.finish }], usage })}\n\n`)
      response.write("data: [DONE]\n\n")
      response.end()
    })
  })
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", () => resolve()))
  const port = (provider.address() as { port: number }).port
  const project = path.join(root, at, "project")
  await fs.mkdir(project, { recursive: true })
  const data = path.join(root, at, "data")
  const storage = new Storage(path.join(data, "storage"))
  const bus = new Bus()
  const config = new Config(storage, bus, path.join(data, "credentials.json"))
  await storage.write("config", {})
  await config.load()
  await config.set({ customProviders: [{ id: "fake", name: "Fake", baseURL: `http://127.0.0.1:${port}/v1`, models: [{ id: "m", name: "M" }] }], directory: project })
  await config.setApiKey("fake", "k")
  const permissions = new Permissions(bus, config)
  const store = new SessionStore(storage, bus)
  const runner = new SessionRunner(store, bus, config, permissions, { accessToken: async () => undefined } as never, storage)
  const model = { provider: "fake", model: "m" }

  const settled = (sessionID: string) =>
    new Promise<void>((resolve) => {
      const deadline = Date.now() + 40_000
      const look = () => {
        if (runner.busySessions().includes(sessionID) && Date.now() < deadline) return void setTimeout(look, 25)
        setTimeout(() => (runner.busySessions().includes(sessionID) && Date.now() < deadline ? look() : resolve()), 200)
      }
      setTimeout(look, 25)
    })

  return {
    store,
    runner,
    project,
    model,
    seen,
    settled,
    script: (written: Step[]) => {
      steps = [...written]
      sent = 0
    },
    /** One turn, run to the end, and the assistant messages it left. */
    say: async (text: string): Promise<AssistantMessage[]> => {
      const session = await store.create({ directory: project, model })
      await runner.prompt({ sessionID: session.id, text })
      await settled(session.id)
      const stored = await store.messages(session.id)
      return stored.filter((message): message is AssistantMessage => message.role === "assistant")
    },
    close: () => new Promise<void>((resolve) => provider.close(() => resolve())),
  }
}

/** A reply's text parts, as the transcript holds them. */
function textParts(message: AssistantMessage | undefined): string[] {
  return (message?.parts ?? []).flatMap((part) => (part.type === "text" ? [part.text] : []))
}

/** The conversation's own rendering of a finished reply. */
function render(text: string): ReplyBlock[] {
  return renderReply(cleanReply(text), { math: true, paths: { tip: "Open" }, diagrams: { streaming: false }, lineNumbers: true })
}

/** How many copies of a note one request carried. */
function noteCount(seen: Seen, note: string): number {
  return seen.messages.filter((message) => JSON.stringify(message.content ?? "").includes(note.slice(0, 40))).length
}

const WIDGET_HEAD = '这是一个可以拖的演示：\n\n```sci-widget\n<!doctype html>\n<html><body>\n<div id="box">0</div>\n<input id="r" type="range">\n<scr'
const WIDGET_TAIL = 'ipt>\nvar r=document.getElementById("r");\nr.oninput=function(){document.getElementById("box").textContent=r.value};\n</scr' + 'ipt>\n</body></html>\n```\n\n拖动滑块，方框里的数字就会跟着变。'

async function continuationChecks(check: Check, section: Section, root: string): Promise<void> {
  section("Round 16 · a reply the output limit cut in two")

  {
    /*
     * The case the real run found: 5,423 characters ending inside a widget's
     * script, then the rest of it. One reply, one card, and the sentence after
     * the card still a sentence.
     */
    const app = await harness(root, "widget")
    try {
      app.script([
        { text: WIDGET_HEAD, finish: "length" },
        { text: WIDGET_TAIL, finish: "stop" },
      ])
      const replies = await app.say("演示一下滑块")
      check("a reply cut at the output limit is continued inside the same message", replies.length === 1, replies.length)
      const parts = textParts(replies[0])
      check("and inside the same text part, so the seam is not a boundary", parts.length === 1, parts)
      check("the words are welded with nothing between them", parts[0] === WIDGET_HEAD + WIDGET_TAIL, parts[0]?.slice(0, 80))

      const blocks = render(parts[0] ?? "")
      check("the fence that opened before the cut renders as one widget", blocks.filter((block) => block.kind === "widget").length === 1, blocks.map((block) => block.kind))
      check("the widget holds both halves of its document", blocks.some((block) => block.kind === "widget" && block.code.includes("<!doctype html>") && block.code.includes("r.oninput")))
      const after = blocks.map((block) => (block.kind === "html" ? block.html : "")).join("")
      check("the sentence after the card is prose, not a second code block", after.includes("拖动滑块，方框里的数字就会跟着变") && !/md-code[^]*拖动滑块，方框/.test(after))

      /* What the split produced, so the check above is known to be about the join. */
      const half = render(WIDGET_HEAD)
      check("the first half on its own is only a code block, which is what the reader used to get", half.every((block) => block.kind !== "widget"), half.map((block) => block.kind))
      const stray = render(WIDGET_TAIL)
      check("and the second half on its own turns its explanation into code", stray.some((block) => block.kind === "html" && /md-code/.test(block.html) && block.html.includes("拖动滑块")))
    } finally {
      await app.close()
    }
  }

  {
    /* An ordinary answer cut mid-sentence: no blank line, no second bubble, one flowing paragraph. */
    const app = await harness(root, "prose")
    try {
      app.script([
        { text: "45 度发射时射程最", finish: "length" },
        { text: "远，因为 sin 2θ 在这里取到最大值。", finish: "stop" },
      ])
      const replies = await app.say("为什么 45 度最远")
      const parts = textParts(replies[0])
      check("a sentence cut in half is one sentence again", parts.length === 1 && parts[0] === "45 度发射时射程最远，因为 sin 2θ 在这里取到最大值。", parts)
      const html = render(parts[0] ?? "")
        .map((block) => (block.kind === "html" ? block.html : ""))
        .join("")
      check("and it renders as one paragraph", (html.match(/<p class="md-p">/g) ?? []).length === 1, html)
      check("with the word the cut fell inside whole", html.includes("射程最远"))
    } finally {
      await app.close()
    }
  }

  {
    /* Three cuts in a row, which is MiMo's limit, then an ending. */
    const app = await harness(root, "thrice")
    try {
      app.script([
        { text: "一", finish: "length" },
        { text: "二", finish: "length" },
        { text: "三", finish: "length" },
        { text: "四", finish: "stop" },
      ])
      const replies = await app.say("数到四")
      check("three continuations in a row still make one reply", replies.length === 1, replies.length)
      const parts = textParts(replies[0])
      check("in one text part, in the order they were written", parts.length === 1 && parts[0] === "一二三四", parts)
      check("MiMo's limit allowed exactly three of them", app.seen.length === CONTINUATION_LIMITS.length + 1, app.seen.length)
      check(
        "each continuation request carried the note once, not once per cut",
        app.seen.slice(1).every((request) => noteCount(request, LENGTH_NOTE) === 1),
        app.seen.slice(1).map((request) => noteCount(request, LENGTH_NOTE)),
      )
      check("the first request carried none", noteCount(app.seen[0]!, LENGTH_NOTE) === 0)
      check("the reply ends on its own reason, not on the limit", replies[0]?.finish === "end_turn", replies[0]?.finish)

      /*
       * The figures: a continued reply wrote every step's words, so the output
       * counts add up, while what was sent is the last request's alone - the
       * context ring reads that to say how full the window is.
       */
      const usage = replies[0]?.usage
      check("the words of every step are counted together", usage?.output === 10 + 20 + 30 + 40, usage?.output)
      check("and the context is counted once, from the last request", usage?.input === 104, usage?.input)
    } finally {
      await app.close()
    }
  }

  {
    /* The join is for the limit alone: a reply that said nothing is a fresh attempt, and keeps its own message. */
    const app = await harness(root, "empty")
    try {
      app.script([
        { text: "", finish: "stop" },
        { text: "好的，这就开始。", finish: "stop" },
      ])
      const replies = await app.say("开始吧")
      check("an empty reply is asked again in a message of its own", replies.length === 2, replies.length)
      check("and that ask is the empty-reply note, not the length one", noteCount(app.seen[1]!, EMPTY_NOTE) === 1 && noteCount(app.seen[1]!, LENGTH_NOTE) === 0)
    } finally {
      await app.close()
    }
  }
}

async function dateChecks(check: Check, section: Section, root: string): Promise<void> {
  section("Round 16 · the day the model is told it is")

  check("a day is read off the machine's calendar as YYYY-MM-DD", /^\d{4}-\d{2}-\d{2}$/.test(localDay(Date.now())))

  /*
   * A zone where the calendar and UTC disagree right now, whatever the hour: a
   * whole day east of Greenwich when UTC is past noon, a whole day west of it
   * when UTC is still in the morning. The line the model is sent has to follow
   * the machine, which is the thing that used to be wrong.
   */
  const zone = new Date().getUTCHours() >= 12 ? "Etc/GMT-12" : "Etc/GMT+12"
  const held = process.env.TZ
  process.env.TZ = zone
  const app = await harness(root, "date")
  try {
    const here = localDay(Date.now())
    const utc = new Date().toISOString().slice(0, 10)
    check(`in ${zone} the calendar and UTC are a day apart, which is what makes this measurable`, here !== utc, { here, utc })
    app.script([{ text: "知道了。", finish: "stop" }])
    await app.say("今天几号")
    const sent = JSON.stringify(app.seen[0]?.messages ?? [])
    const told = /Today: (\d{4}-\d{2}-\d{2})/.exec(sent)?.[1]
    check("the turn told the model a date at all", told !== undefined, sent.slice(0, 200))
    check("and it is the machine's day, not UTC's", told === here, { told, here, utc })
  } finally {
    await app.close()
    if (held === undefined) delete process.env.TZ
    else process.env.TZ = held
  }
}
