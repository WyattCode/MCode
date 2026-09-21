/**
 * Ports a browser refuses: the window's socket and the preview server never
 * listen on one, and the checks' own servers are moved off one.
 */
import fs from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { isBlockedPort } from "../src/shared/blocked-ports"
import { windowSafePort } from "../src/server/free-port"
import { moveAlso } from "./safe-listen"

const read = (relative: string) => fs.readFile(path.join(process.cwd(), relative), "utf8")

export async function blockedPortChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Ports a browser refuses are never the window's")
  check("the Fetch standard's list is the one used (5060, 6000, 6666, 10080 in; 49200 and 8080 out)",
    [5060, 6000, 6666, 10080].every(isBlockedPort) && ![49200, 8080, 1024].some(isBlockedPort))

  const ports = await Promise.all(Array.from({ length: 12 }, () => windowSafePort("127.0.0.1")))
  check("windowSafePort answers a real, allowed port", ports.every((port) => port > 0 && !isBlockedPort(port)), ports)

  const backend = await read("src/server/index.ts")
  check("the backend's socket takes its port from windowSafePort, not port 0", /port: await windowSafePort\("127\.0\.0\.1"\)/.test(backend) && !/host: "127\.0\.0\.1",\s*port: 0,/.test(backend))
  const preview = await read("src/main/preview-server.ts")
  check("the preview server gives back a refused port and binds again", /if \(isBlockedPort\(at\)\) \{\s*await closed\(v4\)\s*continue/.test(preview))

  for (const script of ["scripts/smoke.ts", "scripts/session-check.ts"]) {
    const source = await read(script)
    const first = source.match(/^import .*$/m)?.[0]
    check(`${script} loads safe-listen before anything else`, first === 'import "./safe-listen"', first)
  }
  // The patch itself: told the first port it gets is refused, it moves the server once, and the caller hears only the new port.
  const refused: number[] = []
  moveAlso.next = (port) => {
    if (refused.length) return false
    refused.push(port)
    return true
  }
  const server = net.createServer((socket) => socket.end("hi"))
  let calls = 0
  let closes = 0
  try {
    await Promise.race([
      new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => { calls++; resolve() })),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("never listened")), 3000)),
    ])
  } catch (error) {
    check("a server on a refused port is moved and heard from once", false, String(error))
    moveAlso.next = undefined
    return
  }
  moveAlso.next = undefined
  server.on("close", () => closes++)
  const bound = server.address()
  const port = typeof bound === "object" && bound ? bound.port : 0
  const answer = await new Promise<string>((resolve) => {
    const socket = net.connect(port, "127.0.0.1")
    let text = ""
    socket.on("data", (chunk) => (text += chunk))
    socket.on("close", () => resolve(text))
    socket.on("error", () => resolve(""))
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  check("a server on a refused port is moved and heard from once, on the new port", refused.length === 1 && port > 0 && port !== refused[0] && calls === 1 && answer === "hi", { refused, port, calls, answer })
  await new Promise<void>((resolve) => server.close(() => resolve()))
  check("and closing it afterwards is heard as usual", closes === 1, closes)
}
