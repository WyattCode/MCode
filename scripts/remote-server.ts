/**
 * MCode Remote's headless host (docs/remote-design.md): boots the backend on a
 * data directory and serves the gateway, with no window.
 *
 *   node out/remote-server.mjs --data-dir "C:\Users\me\AppData\Roaming\mcode" --host 0.0.0.0
 *
 * Prints the pairing line a phone enters or scans (`mcode-remote://host:port?token=…`)
 * and stays until interrupted. Defaults to an isolated data directory - point
 * --data-dir at the desktop profile only while the desktop app is closed, so
 * two SessionRunners never share one store.
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
const token = loadOrCreateToken(dataDir)

console.log("[remote] starting the backend…")
const backend = await startBackend(dataDir, { origins: [] })
console.log(`[remote] backend ready (internal socket on 127.0.0.1:${backend.port})`)

const gateway = await startRemoteGateway(backend.runtime, { host, port, token })
const shown = host === "0.0.0.0" || host === "::" ? lanAddresses() : [host === "loopback" ? "127.0.0.1" : host]
console.log(`[remote] gateway listening on ${host}:${gateway.port}`)
for (const ip of shown) console.log(`[remote] pair with: mcode-remote://${ip}:${gateway.port}?token=${token}`)
console.log("[remote] Ctrl+C to stop. Keep this running; sessions keep their turns alive.")

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
  if (closing) return
  closing = true
  console.log("\n[remote] closing…")
  await gateway.close()
  await backend.close()
  process.exit(0)
}
process.on("SIGINT", () => void close())
process.on("SIGTERM", () => void close())
setInterval(() => {}, 60_000) // keep the event loop; everything else is awaited
