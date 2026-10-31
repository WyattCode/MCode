/* MCode Remote gateway check: boots a real backend on a throwaway directory,
 * points the gateway at it, and drives a fake phone over WebSocket.
 *
 * Verifies, in order:
 *   1. a wrong pairing token is refused
 *   2. the right token gets a remote.welcome with a cursor
 *   3. a standard request frame (session.list) is answered through handle()
 *   4. a session created through the request channel arrives as remote.event
 *   5. events a disconnected phone missed are replayed by remote.resume
 */
import { WebSocket } from "ws"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import vm from "node:vm"
import { startBackend } from "../src/server/index"
import { startRemoteGateway } from "../src/server/remote/gateway"

let failures = 0
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  BAD  ${name}${detail === undefined ? "" : ` - ${String(detail)}`}`)
  }
}

const dataDir = mkdtempSync(path.join(tmpdir(), "mcode-remote-check-"))
const backend = await startBackend(dataDir, { origins: [] })
const TOKEN = "check-token-2918"
const gateway = await startRemoteGateway(backend.runtime, { host: "loopback", port: 0, token: TOKEN, sweepIntervalMs: 150 })
const url = `ws://127.0.0.1:${gateway.port}`

/** Every frame a socket has received, in order - welcome can beat the open handler. */
const inbox = new Map<WebSocket, any[]>()

function connect(token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, ["mcode", `mcode.remote.${token}`])
    const list: any[] = []
    inbox.set(ws, list)
    ws.on("message", (raw) => list.push(JSON.parse(raw.toString())))
    ws.once("open", () => resolve(ws))
    ws.once("error", (err) => reject(err))
  })
}

const nextFrame = async (ws: WebSocket, filter: (frame: any) => boolean, ms = 10000): Promise<any> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const hit = (inbox.get(ws) ?? []).find(filter)
    if (hit) return hit
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw new Error(`timed out waiting for a frame`)
}

const send = (ws: WebSocket, frame: unknown) => ws.send(JSON.stringify(frame))

console.log("MCode Remote gateway check")

// 1. wrong token refused
{
  let refused = false
  try {
    const ws = await connect("wrong-token")
    // Opened despite the bad token: the gateway let a stranger in.
    check("a wrong pairing token is refused", false, "connected anyway")
    ws.close()
  } catch {
    refused = true
  }
  if (refused) check("a wrong pairing token is refused", true)
}

// 2. right token welcomed
let phone: WebSocket
{
  phone = await connect(TOKEN)
  const welcome = await nextFrame(phone, (f) => f.kind === "remote.welcome")
  check("the right token gets a remote.welcome", typeof welcome.eventId === "number", welcome)
}

// 2.5 the cockpit page is served from the same port
{
  const res = await fetch(`http://127.0.0.1:${gateway.port}/cockpit`)
  const body = await res.text()
  check(
    "the cockpit page is served from the gateway",
    res.status === 200 && body.includes("MCode") && body.includes("mcode.remote."),
    res.status,
  )
  /*
   * A phone must be able to answer a question, not only a permission. The
   * cockpit drew permission cards and nothing else, so a turn that stopped to
   * ask sat on screen as a busy conversation with nothing to press until the
   * question timed out half an hour later.
   */
  check("and can put a question to the phone", body.includes("question.asked") && body.includes("question.reply"), "question card")
  /*
   * A phone that connects after the model asked, or whose socket dropped and
   * came back, has no `question.asked` to catch - it was published once. The
   * page has to replay what is parked, as the window does.
   */
  check("and replays the questions already parked", body.includes('type: "question.list"'), "question.list replay")
  /*
   * The model's thinking is skipped by the reply path, which is right - but it
   * used to be skipped everywhere, so a phone had nowhere to read it. It gets a
   * fold of its own now, closed until asked for.
   */
  check("and folds the model's thinking away", body.includes("reasonfold") && body.includes("思考过程"), "reason fold")

  /*
   * The page's script, run for real against stand-in elements. A card's own
   * parameter was named `request`, which hid the page's `request()` inside it:
   * every button on a permission or question card threw "request is not a
   * function" and the phone could answer nothing, while every check that only
   * read the page's text kept passing.
   */
  {
    const script = body.slice(body.indexOf("<script>") + 8, body.lastIndexOf("</script>"))
    const sent: any[] = []
    /*
     * A stand-in element that is honest about the few things the page asks of
     * it: its tag, its classes, where a child sits among its siblings, and
     * whether a fold is open. Without the tag and the classes a check on
     * `DETAILS.reasonfold` would be asserting against a stub that answers
     * nothing - which is the kind of check that passes while the page is broken.
     */
    const stand = (): any => {
      const target: any = {
        children: [] as any[],
        style: {},
        dataset: {},
        value: "",
        textContent: "",
        // A fold is closed until the reader opens it; the page never sets this.
        open: false,
        querySelectorAll: () => [],
        appendChild(child: any) {
          const at = this.children.indexOf(child)
          if (at !== -1) this.children.splice(at, 1)
          this.children.push(child)
          return child
        },
        append(...kids: any[]) { this.children.push(...kids) },
        insertBefore(node: any, ref: any) {
          // Real DOM insertBefore moves a node that is already in the tree;
          // without this the same PRE can appear twice after settleOrder().
          const existing = this.children.indexOf(node)
          if (existing !== -1) this.children.splice(existing, 1)
          const at = ref ? this.children.indexOf(ref) : -1
          if (at === -1) this.children.push(node)
          else this.children.splice(at, 0, node)
          return node
        },
        remove() { this.removed = true },
        addEventListener() {},
      }
      const classes = () => String(target.className || "").split(/\s+/).filter(Boolean)
      target.classList = {
        add(name: string) { const list = classes(); if (!list.includes(name)) list.push(name); target.className = list.join(" ") },
        remove(name: string) { target.className = classes().filter((c: string) => c !== name).join(" ") },
        contains(name: string) { return classes().includes(name) },
      }
      return new Proxy(target, { get: (t, key) => (key in t ? t[key] : typeof key === "string" ? () => undefined : undefined), set: (t, key, value) => ((t[key] = value), true) })
    }
    const byId: Record<string, any> = {}
    class Socket { constructor() {} send(text: string) { sent.push(JSON.parse(text)) } close() {} }
    const context: any = {
      document: {
        // The tag is kept: a fold is a `<details>`, and a check that cannot tell
        // it from a `<div>` is not checking anything.
        createElement: (tag: string) => { const el = stand(); el.tagName = String(tag).toUpperCase(); el.className = ""; return el },
        // A card exists only once it has been added; the page's own elements are
        // made on first ask. `busy` is rebuilt by `markBusy` after a wipe, so it
        // is looked up among the timeline's children like the cards are.
        getElementById: (id: string) =>
          /^(pc|qc)-/.test(id) || id === "busy"
            ? (byId.timeline?.children ?? []).find((child: any) => child.id === id)
            : (byId[id] ??= stand()),
        querySelector: () => stand(),
        querySelectorAll: () => [],
        addEventListener() {},
      },
      localStorage: { getItem: () => null, setItem() {} },
      location: { origin: "http://x", protocol: "http:", host: "x", hash: "", search: "" },
      WebSocket: Socket,
      setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, console, JSON, navigator: {}, requestAnimationFrame: () => 0,
    }
    context.window = context
    vm.createContext(context)
    let loaded = true
    try {
      vm.runInContext(script, context)
      // `const state` is not a property of the context, so the socket goes in from inside it.
      context.Socket = Socket
      vm.runInContext("state.ws = new Socket()", context)
    } catch (error) {
      loaded = false
      check("the page's script runs", false, error instanceof Error ? error.message : error)
    }
    if (loaded) {
      const buttonsOf = (cardId: string) => {
        const card = byId.timeline.children.find((child: any) => child.id === cardId)
        return card ? card.children.flatMap((row: any) => row.children ?? []).filter((child: any) => typeof child.onclick === "function") : []
      }
      context.addPermissionCard({ id: "perm-1", kind: "bash", title: "ls" })
      const allow = buttonsOf("pc-perm-1")[0]
      let answered: unknown = "no button"
      try { allow?.onclick(); answered = sent.find((f) => f.request?.type === "permission.respond") } catch (error) { answered = error instanceof Error ? error.message : error }
      check("a permission card's button answers the request", (answered as any)?.request?.requestID === "perm-1" && (answered as any)?.request?.response === "once", answered)

      context.addQuestionCard({ id: "q-1", sessionID: "s", questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }] })
      const questionCard = byId.timeline.children.find((child: any) => child.id === "qc-q-1")
      check("a question card carries its heading", questionCard?.children[0]?.textContent === "需要你的决定", questionCard?.children[0]?.textContent)
      const options = buttonsOf("qc-q-1")
      let picked: unknown = "no button"
      try { options[0]?.onclick(); picked = sent.find((f) => f.request?.type === "question.reply" && f.request.requestID === "q-1") } catch (error) { picked = error instanceof Error ? error.message : error }
      check("a question card's option answers it", JSON.stringify((picked as any)?.request?.answers) === '[["A"]]', picked)

      context.addQuestionCard({ id: "q-2", sessionID: "s", questions: [{ question: "Which?", options: [{ label: "A" }] }] })
      const skip = buttonsOf("qc-q-2").pop()
      let skipped: unknown = "no button"
      try { skip?.onclick(); skipped = sent.find((f) => f.request?.type === "question.reply" && f.request.requestID === "q-2") } catch (error) { skipped = error instanceof Error ? error.message : error }
      check("and skipping it sends empty answers", JSON.stringify((skipped as any)?.request?.answers) === "[[]]", skipped)

      /*
       * Reasoning: drawn, but not as the answer.
       *
       * The reply path skips reasoning parts on purpose - the model did not say
       * its thinking to the reader - and the first version of that skip was a
       * bare `return`, so the thinking was invisible everywhere. It gets a fold
       * of its own now: closed by default, labelled plainly, and never mixed
       * into the reply text.
       */
      vm.runInContext('state.current = "s1"', context)
      context.upsertMessage("s1", {
        id: "m1",
        role: "assistant",
        sessionID: "s1",
        parts: [
          { type: "reasoning", id: "r1", text: "先想一步" },
          { type: "text", id: "t1", text: "正式回答" },
        ],
      })
      const bubbleEl = byId.timeline.children.find((child: any) => String(child.className).includes("assistant"))
      check("an assistant message is drawn under the timeline", Boolean(bubbleEl), byId.timeline.children.length)

      const fold = bubbleEl?.children.find((child: any) => String(child.className).includes("reasonfold"))
      const summary = fold?.children.find((child: any) => child.tagName === "SUMMARY")
      const reasonBody = fold?.children.find((child: any) => child.tagName === "PRE")
      check(
        "reasoning is a collapsed fold, not the reply",
        Boolean(fold) && fold.tagName === "DETAILS" && fold.open !== true && String(summary?.textContent ?? "").includes("思考过程"),
        { tag: fold?.tagName, open: fold?.open, summary: summary?.textContent },
      )

      const replyPres = () => (bubbleEl?.children ?? []).filter((child: any) => child.tagName === "PRE" && child !== reasonBody)
      const replyText = () => replyPres().map((child: any) => String(child.textContent ?? "")).join("\n")
      check("the reply bubble holds only the reply", replyText() === "正式回答" && !replyText().includes("先想一步"), replyText())

      // `at` is the length the part had before this fragment - four characters,
      // not three; a wrong one trips the gap guard and nothing is appended.
      context.appendDelta("s1", "m1", "r1", "再想", "先想一步".length)
      check(
        "a reasoning fragment grows the fold, not the reply",
        String(reasonBody?.textContent ?? "").includes("先想一步再想") && replyText() === "正式回答",
        { reason: reasonBody?.textContent, reply: replyText() },
      )

      context.appendDelta("s1", "m1", "t1", "！", "正式回答".length)
      check(
        "and a reply fragment grows the reply, not the fold",
        replyText() === "正式回答！" && String(reasonBody?.textContent ?? "") === "先想一步再想",
        { reason: reasonBody?.textContent, reply: replyText() },
      )

      /*
       * The busy hint. `markBusy` was added in 续二 and only ever checked by
       * hand; it is rebuilt rather than looked up because `select()` and a gap
       * refill both empty the timeline, which takes it with them.
       */
      context.markBusy(true)
      const busyOn = byId.timeline.children.find((child: any) => child.id === "busy")
      check(
        "markBusy(true) shows the busy hint",
        Boolean(busyOn) && busyOn.style.display !== "none" && busyOn.textContent === "正在回答…",
        { text: busyOn?.textContent, display: busyOn?.style?.display },
      )

      context.markBusy(false)
      const busyOff = byId.timeline.children.find((child: any) => child.id === "busy")
      check("markBusy(false) hides it", Boolean(busyOff) && busyOff.style.display === "none", busyOff?.style?.display)

      // A conversation switch wipes the timeline; the hint has to come back.
      byId.timeline.innerHTML = ""
      byId.timeline.children.length = 0
      context.markBusy(true)
      const busyAgain = byId.timeline.children.find((child: any) => child.id === "busy")
      check(
        "the busy hint is rebuilt after the timeline is wiped",
        Boolean(busyAgain) && busyAgain.style.display !== "none" && busyAgain.textContent === "正在回答…",
        { found: Boolean(busyAgain), display: busyAgain?.style?.display },
      )
      const textOf = (node: any): string => {
        if (!node) return ""
        const own = typeof node.textContent === "string" ? node.textContent : ""
        const kids = Array.isArray(node.children) ? node.children.map(textOf).join(" ") : ""
        return `${own} ${kids}`.trim()
      }

      context.addPermissionCard({ id: "perm-f", kind: "bash", title: "rm x", forced: true })
      const forcedCard = byId.timeline.children.find((child: any) => child.id === "pc-perm-f")
      const forcedButtons = buttonsOf("pc-perm-f")
      check(
        "a forced card offers only once and reject, and says it asks every time",
        forcedButtons.length === 2 && !forcedButtons.some((button: any) => textOf(button).includes("总是允许")) && textOf(forcedCard).includes("此操作每次都要确认"),
        { buttons: forcedButtons.map((button: any) => textOf(button)), card: textOf(forcedCard) },
      )

      context.addPermissionCard({ id: "perm-ack", kind: "bash", title: "ls" })
      const ackCard = byId.timeline.children.find((child: any) => child.id === "pc-perm-ack")
      const ackAllow = buttonsOf("pc-perm-ack")[0]
      let ackFrame: any = "no button"
      try { ackAllow?.onclick(); ackFrame = sent.find((f) => f.request?.type === "permission.respond" && f.request.requestID === "perm-ack") } catch (error) { ackFrame = error instanceof Error ? error.message : error }
      const ackFrameId = (ackFrame as any)?.id
      const ackWaits = !!ackCard && ackCard.removed !== true && ackAllow?.disabled === true
      vm.runInContext(`state.pending[${JSON.stringify(ackFrameId)}]({ ok: false })`, context)
      const ackReEnabled = ackAllow?.disabled === false
      vm.runInContext(`state.pending[${JSON.stringify(ackFrameId)}]({ ok: true })`, context)
      check("a permission card waits for the server's ack before it goes away", ackWaits && ackReEnabled && ackCard?.removed === true, { waits: ackWaits, reEnabled: ackReEnabled, removed: ackCard?.removed })

      context.addPermissionCard({ id: "perm-dup", kind: "bash", title: "ls" })
      context.addPermissionCard({ id: "perm-dup", kind: "bash", title: "ls" })
      const dupCards = byId.timeline.children.filter((child: any) => child.id === "pc-perm-dup")
      check("adding the same permission card twice keeps one card", dupCards.length === 1, dupCards.length)

      context.addQuestionCard({ id: "q-keep", sessionID: "s", questions: [{ question: "First?", options: [{ label: "A" }, { label: "B" }] }, { question: "Second?", options: [{ label: "C" }, { label: "D" }] }] })
      let keepClickError: unknown = null
      try { buttonsOf("qc-q-keep")[0]?.onclick() } catch (error) { keepClickError = error instanceof Error ? error.message : error }
      let keepSkipped: unknown = "no button"
      try { buttonsOf("qc-q-keep").pop()?.onclick(); keepSkipped = sent.filter((f) => f.request?.type === "question.reply" && f.request.requestID === "q-keep").pop() } catch (error) { keepSkipped = error instanceof Error ? error.message : error }
      check("skipping a question keeps the answers already given", !keepClickError && JSON.stringify((keepSkipped as any)?.request?.answers) === '[["A"],[]]', keepClickError ?? keepSkipped)
    }
  }
}

// 3. session.list through handle()
{
  send(phone, { kind: "request", id: "r1", request: { type: "session.list" } })
  const got = await nextFrame(phone, (f) => f.kind === "response" && f.id === "r1")
  check("a session.list request is answered through handle()", got.ok === true && Array.isArray(got.data?.sessions), got)
}

// 4. a session created through the request channel arrives as a remote.event
{
  send(phone, { kind: "request", id: "r2", request: { type: "session.create", title: "remote check" } })
  const event = await nextFrame(phone, (f) => f.kind === "remote.event" && f.event?.type === "session.updated" && f.event?.session?.title === "remote check")
  check("a session created over the channel arrives as a remote.event", Boolean(event.event?.session?.id), event.eventId)
}

// 4.5 session.get returns the transcript a phone needs for history replay
{
  const list = await (async () => {
    send(phone, { kind: "request", id: "r5", request: { type: "session.list" } })
    return nextFrame(phone, (f) => f.kind === "response" && f.id === "r5")
  })()
  const created = (list.data?.sessions ?? []).find((s: any) => s.title === "remote check")
  if (!created) {
    check("session.get returns the transcript for history replay", false, "created session missing from the list")
  } else {
    send(phone, { kind: "request", id: "r6", request: { type: "session.get", sessionID: created.id } })
    const got = await nextFrame(phone, (f) => f.kind === "response" && f.id === "r6")
    check(
      "session.get returns the transcript for history replay",
      got.ok === true && got.data?.session?.id === created.id && Array.isArray(got.data?.messages),
      got.ok,
    )
  }
}

// 5. events missed while offline are replayed by resume
{
  const watcher = await connect(TOKEN)
  await nextFrame(watcher, (f) => f.kind === "remote.welcome")

  send(watcher, { kind: "request", id: "r3", request: { type: "session.create", title: "while away" } })
  const seen = await nextFrame(watcher, (f) => f.kind === "remote.event" && f.event?.type === "session.updated" && f.event?.session?.title === "while away")
  const missedCursor = seen.eventId - 1

  watcher.close()
  await new Promise((resolve) => setTimeout(resolve, 300))
  // Another change lands while no phone is connected.
  send(phone, { kind: "request", id: "r4", request: { type: "session.create", title: "missed while away" } })
  await new Promise((resolve) => setTimeout(resolve, 500))

  const again = await connect(TOKEN)
  send(again, { kind: "remote.resume", cursor: missedCursor })
  const replayed = await nextFrame(again, (f) => f.kind === "remote.event" && f.event?.type === "session.updated" && f.event?.session?.title === "missed while away")
  check("events missed while offline are replayed by remote.resume", replayed.eventId > missedCursor, replayed.eventId)
}

// 6. a phone that stops answering is dropped by the sweep
//
// The failure this covers: a phone loses its network, the TCP connection goes
// half-open, and `ws` never fires `close` - because `close` is a message, and
// nobody sent one. The gateway used to hold those sockets forever; measured
// after one Wi-Fi drop, 3 ESTABLISHED on the gateway against 1 on the pad, and
// still 3 a minute later.
//
// `ws` answers control pings automatically, so a normal client cannot be made to
// go quiet. This one is a raw socket: it completes the upgrade by hand and then
// stops reading. The kernel buffers whatever arrives, nothing replies, and the
// connection looks exactly like a phone that dropped off the network.
{
  const net = await import("node:net")
  const crypto = await import("node:crypto")
  const silent = net.connect(gateway.port, "127.0.0.1")
  const key = crypto.randomBytes(16).toString("base64")
  const opened = new Promise<boolean>((resolve) => {
    let upgraded = false
    silent.once("connect", () => {
      silent.write(
        `GET / HTTP/1.1\r\nHost: 127.0.0.1:${gateway.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
          `Sec-WebSocket-Protocol: mcode, mcode.remote.${TOKEN}\r\n\r\n`,
      )
    })
    /*
     * Wait for the 101 before going quiet.
     *
     * Pausing straight after the write can drop the response that completes the
     * upgrade, and then the server never treats this as a phone at all - the
     * test would pass on the wrong reason. Watching for the status line is the
     * difference between "a connected phone that went silent" and "a socket that
     * never joined".
     */
    silent.once("data", () => {
      if (upgraded) return
      upgraded = true
      resolve(true)
      // Answer the handshake, then read nothing more: no pong can follow.
      setTimeout(() => silent.pause(), 80)
    })
    silent.once("error", () => resolve(false))
  })
  const connected = await opened
  check("a silent phone can complete the handshake", connected)

  /*
   * Two sweep rounds have to pass: the first clears the flag and pings, the
   * second sees no pong and terminates. At 150ms per round that is 300ms of
   * waiting plus a margin, and it is the reason the interval is configurable.
   */
  const closed = await new Promise<boolean>((resolve) => {
    let done = false
    silent.once("close", () => {
      done = true
      resolve(true)
    })
    setTimeout(() => {
      if (!done) resolve(false)
    }, 2500)
  })
  check("a phone that stops answering pong is dropped by the sweep", closed)
  silent.destroy()
}

await gateway.close()
await backend.close()
console.log(failures === 0 ? "\nremote check passed" : `\nremote check FAILED with ${failures} problem(s)`)
process.exit(failures === 0 ? 0 : 1)
