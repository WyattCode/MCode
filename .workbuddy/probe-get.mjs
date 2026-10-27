/*
 * Ask the gateway itself what session.get returns for one conversation.
 *
 * The pad shows one message for a conversation that has 105 files on disk.
 * Everything between the disk and the pane is suspect, so this walks the
 * actual protocol rather than re-reading the files: welcome, resume, then a
 * session.get, and it reports how many messages came back and what the first
 * few look like. If the gateway sends 105 the fault is in the pane; if it
 * sends 1 the fault is here.
 *
 *   node .workbuddy/probe-get.mjs <sessionID>
 */
const SESSION = process.argv[2]
if (!SESSION) {
  console.error("usage: node probe-get.mjs <sessionID>")
  process.exit(2)
}

const url = "ws://127.0.0.1:7900/ws"
const token = "mcode-fold-2026"

const ws = new WebSocket(url, ["mcode", "mcode.remote." + token])

const send = (frame) => ws.send(JSON.stringify(frame))

ws.onopen = () => {
  send({ kind: "request", id: "r1", request: { type: "session.get", sessionID: SESSION } })
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

  if (f.kind === "remote.welcome") {
    // The gateway wants a resume before it will serve requests in some builds;
    // harmless if not.
    send({ kind: "remote.resume", cursor: f.eventId })
    return
  }

  if (f.kind !== "response" || f.id !== "r1") return

  if (!f.ok) {
    console.error("request failed:", f.error)
    process.exit(1)
  }

  const data = f.data || {}
  const messages = data.messages || []
  console.log("session:", data.session?.id, "|", data.session?.title)
  console.log("messages returned:", messages.length)
  const roles = {}
  for (const m of messages) roles[m.role] = (roles[m.role] || 0) + 1
  console.log("roles:", JSON.stringify(roles))

  for (const m of messages.slice(0, 3)) {
    const parts = m.parts || []
    const types = parts.map((p) => p.type).join(",")
    const text = (m.text || (parts.find((p) => p.type === "text") || {}).text || "").slice(0, 60)
    console.log(`  ${m.role} parts=[${types}] text=${JSON.stringify(text)}`)
  }
  process.exit(0)
}

setTimeout(() => {
  console.error("timeout")
  process.exit(1)
}, 8000)