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
const gateway = await startRemoteGateway(backend.runtime, { host: "loopback", port: 0, token: TOKEN })
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
   * The page's script, run for real against stand-in elements. A card's own
   * parameter was named `request`, which hid the page's `request()` inside it:
   * every button on a permission or question card threw "request is not a
   * function" and the phone could answer nothing, while every check that only
   * read the page's text kept passing.
   */
  {
    const script = body.slice(body.indexOf("<script>") + 8, body.lastIndexOf("</script>"))
    const sent: any[] = []
    const stand = (): any => {
      const target: any = {
        children: [] as any[],
        classList: { add() {}, remove() {}, contains: () => false },
        style: {},
        value: "",
        querySelectorAll: () => [],
        appendChild(child: any) { this.children.push(child); return child },
        append(...kids: any[]) { this.children.push(...kids) },
        remove() { this.removed = true },
        addEventListener() {},
      }
      return new Proxy(target, { get: (t, key) => (key in t ? t[key] : typeof key === "string" ? () => undefined : undefined), set: (t, key, value) => ((t[key] = value), true) })
    }
    const byId: Record<string, any> = {}
    class Socket { constructor() {} send(text: string) { sent.push(JSON.parse(text)) } close() {} }
    const context: any = {
      document: { createElement: () => stand(), // A card exists only once it has been added; the page's own elements are made on first ask.
        getElementById: (id: string) => (/^(pc|qc)-/.test(id) ? byId.timeline?.children.find((child: any) => child.id === id) : (byId[id] ??= stand())), querySelector: () => stand(), querySelectorAll: () => [], addEventListener() {} },
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

await gateway.close()
await backend.close()
console.log(failures === 0 ? "\nremote check passed" : `\nremote check FAILED with ${failures} problem(s)`)
process.exit(failures === 0 ? 0 : 1)
