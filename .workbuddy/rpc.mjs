/**
 * Send one request and print its whole reply, so a switch pressed on the phone
 * can be checked against the server rather than inferred from the screen.
 *
 *   node .workbuddy/rpc.mjs '{"type":"session.goalMode","sessionID":"ses_x","on":true}'
 */
import WebSocket from "ws"

const request = JSON.parse(process.argv[2])
const ws = new WebSocket("ws://127.0.0.1:7900", ["mcode", "mcode.remote.mcode-fold-2026"])
ws.on("open", () => ws.send(JSON.stringify({ kind: "request", id: "r1", request })))
ws.on("message", (d) => {
  const f = JSON.parse(d)
  if (f.kind !== "response") return
  console.log(JSON.stringify(f, null, 2))
  process.exit(0)
})
setTimeout(() => process.exit(0), 20000)