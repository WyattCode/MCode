/** Print the fields of one conversation, so a switch pressed on the phone can be
 *  checked at the source rather than inferred from the screen. */
import WebSocket from "ws"

const sid = process.argv[2]
const ws = new WebSocket("ws://127.0.0.1:7900", ["mcode", "mcode.remote.mcode-fold-2026"])
ws.on("open", () => {
  const printCurrent = () => ws.send(JSON.stringify({ kind: "request", id: "g1", request: { type: "session.get", sessionID: sid } }))
  printCurrent()
})
ws.on("message", (d) => {
  const f = JSON.parse(d)
  if (f.kind !== "response") return
  const s = f.data?.session ?? f.data
  if (!s) return
  console.log(
    JSON.stringify(
      {
        id: s.id,
        title: s.title,
        goalMode: s.goalMode,
        goal: s.goal,
        access: s.access,
        agent: s.agent,
        effort: s.effort,
        model: s.model,
        smart: s.smart,
      },
      null,
      2,
    ),
  )
  process.exit(0)
})
setTimeout(() => process.exit(0), 8000)