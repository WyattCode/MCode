/**
 * MCode Remote's headless host (docs/remote-design.md): boots the backend on a
 * data directory and serves the gateway, with no window.
 *
 *   node out/remote-server.mjs --data-dir "C:\Users\me\AppData\Roaming\mcode" --host 0.0.0.0
 *
 * Prints the pairing address a phone enters (`mcode-remote://host:port`) with
 * the token on its own line, and stays until interrupted. Defaults to an
 * isolated data directory - point --data-dir at the desktop profile only while
 * the desktop app is closed, so two SessionRunners never share one store.
 */
import os from "node:os"
import path from "node:path"
import { startBackend } from "../src/server/index"
import { startRemoteGateway } from "../src/server/remote/gateway"
import { loadOrCreateToken } from "../src/server/remote/token"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : undefined
}

const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
const dataDir = path.resolve(flag("data-dir") ?? path.join(appData, "mcode-remote"))
const host = flag("host") ?? "127.0.0.1"
const port = Number(flag("port") ?? 0)
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`[remote] invalid --port: ${flag("port")}`)
  process.exit(1)
}
// An explicit --token overrides the stored one (demo and CI); otherwise the
// token beside the storage is generated on first use and kept for good.
const token = flag("token") ?? loadOrCreateToken(dataDir)

console.log("[remote] starting the backend…")
const backend = await startBackend(dataDir, { origins: [] })
console.log(`[remote] backend ready (internal socket on 127.0.0.1:${backend.port})`)

const gateway = await startRemoteGateway(backend.runtime, { host, port, token })
const shown = host === "0.0.0.0" || host === "::" ? lanAddresses() : [host === "loopback" ? "127.0.0.1" : host]
console.log(`[remote] gateway listening on ${host}:${gateway.port}`)
for (const ip of shown) console.log(`[remote] pair with: mcode-remote://${ip}:${gateway.port}`)
// The token on its own line, never inside a URL: a URL-shaped token lands in
// logs, and the design promise is that nothing that logs addresses ever sees it.
console.log("[remote] pairing token (enter it on the phone; keep it out of logs):")
console.log(token)
console.log("[remote] Ctrl+C to stop. Keep this running; sessions keep their turns alive.")

// Provider auth loads asynchronously; a few seconds in, report what a prompt
// would actually reach - "No model is available" is otherwise a mystery from
// a log that only says the backend is ready.
setTimeout(() => {
  try {
    for (const p of backend.runtime.config.providers()) {
      console.log(`[remote] provider ${p.id} (${p.baseURL}): ${p.configured ? "credentials ok" : "NO CREDENTIALS"}, ${p.models.length} model(s)`)
    }
  } catch (err) {
    console.log(`[remote] provider report failed: ${err instanceof Error ? err.message : err}`)
  }
}, 5000)


function lanAddresses(): string[] {
  const found: string[] = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === "IPv4" && !entry.internal) found.push(entry.address)
    }
  }
  return found.length ? found : ["127.0.0.1"]
}

let closing = false
const close = async () => {
  if (closing) process.exit(1)
  closing = true
  console.log("\n[remote] closing…")
  // A hung close must never swallow the exit: log and leave, so a second
  // Ctrl+C (or this finally) always ends the process.
  try {
    await gateway.close()
  } catch (err) {
    console.error("[remote] gateway close failed:", err)
  }
  try {
    await backend.close()
  } catch (err) {
    console.error("[remote] backend close failed:", err)
  }
  process.exit(0)
}
process.on("SIGINT", () => void close())
process.on("SIGTERM", () => void close())
setInterval(() => {}, 60_000) // keep the event loop; everything else is awaited
