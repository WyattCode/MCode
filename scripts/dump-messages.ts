// Dump the first session's message structure to see why parts render empty.
import { startBackend } from "../src/server/index"
import path from "node:path"
import os from "node:os"

const dataDir = "C:/Users/Wyatt/AppData/Roaming/mcode"
const backend = await startBackend(dataDir, { origins: [] })
const sessions = await backend.runtime.sessions.list()
const first = sessions.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))[0]
console.log("session:", first?.id, first?.title)
const messages = await backend.runtime.sessions.messages(first.id)
console.log("messages:", messages.length)
const last = messages[messages.length - 1]
console.log("last message keys:", Object.keys(last ?? {}))
console.log(JSON.stringify(last, null, 1).slice(0, 1200))
await backend.close()
process.exit(0)
