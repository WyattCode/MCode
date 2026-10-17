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
