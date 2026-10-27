/*
 * Send one prompt to a session over the gateway's own protocol.
 *
 * The pad's text input drops characters and eats `%s`, so a prompt typed with
 * `adb shell input text` cannot be trusted to arrive as written - which matters
 * when the point of the prompt is to make the agent call a specific tool a
 * specific number of times. This goes in over the socket instead, so what the
 * agent reads is exactly what is here.
 *
 *   node .workbuddy/prompt.mjs <sessionID> "<text>"
 */
const [sessionID, text] = process.argv.slice(2)
if (!sessionID || !text) {
  console.error("usage: node prompt.mjs <sessionID> \"<text>\"")
  process.exit(2)
}

const ws = new WebSocket("ws://127.0.0.1:7900/ws", ["mcode", "mcode.remote.mcode-fold-2026"])
const send = (frame) => ws.send(JSON.stringify(frame))

ws.onopen = () => {
  send({ kind: "request", id: "p1", request: { type: "session.prompt", sessionID, text } })
}

ws.onerror = (e) => {
  console.error("socket error", e.message || e)
  process.exit(1)
}

ws.onmessage = (ev) => {
  let f
  try {
    f = JSON.parse(ev.data)
  } catch {
    return
  }
  if (f.kind === "remote.welcome") return
  if (f.kind === "response" && f.id === "p1") {
    console.log(f.ok ? "prompt accepted" : "prompt refused: " + f.error)
    process.exit(f.ok ? 0 : 1)
  }
}

setTimeout(() => {
  console.log("sent (no ack within 8s)")
  process.exit(0)
}, 8000)