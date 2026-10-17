// Dump the first tool part of the latest session (structure probe).
import { startBackend } from "../src/server/index"

const dataDir = "C:/Users/Wyatt/AppData/Roaming/mcode"
const backend = await startBackend(dataDir, { origins: [] })
const sessions = await backend.runtime.sessions.list()
const first = sessions.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))[0]
console.log("session:", first?.id, first?.title, "| updated:", first?.updated)
const messages = await backend.runtime.sessions.messages(first.id)
console.log("messages:", messages.length)
let found = 0
for (const m of messages) {
  for (const part of m.parts ?? []) {
    if (part.type === "tool" && found < 2) {
      console.log("TOOL PART:", JSON.stringify(part).slice(0, 600))
      found++
    }
  }
}
console.log("updated field of first:", typeof first?.updated, first?.updated)
await backend.close()
process.exit(0)
