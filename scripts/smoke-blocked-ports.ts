/**
 * Ports a browser refuses: the window's socket and the preview server never
 * listen on one, and the checks' own servers are moved off one.
 */
import fs from "node:fs/promises"
import net from "node:net"
import { createServer } from "node:http"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { isBlockedPort } from "../src/shared/blocked-ports"
import * as backendModule from "../src/server/index"
import { moveAlso } from "./safe-listen"

const read = (relative: string) => fs.readFile(path.join(process.cwd(), relative), "utf8")

export async function blockedPortChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Ports a browser refuses are never the window's")
  check("the Fetch standard's list is the one used (5060, 6000, 6666, 10080 in; 49200 and 8080 out)",
    [5060, 6000, 6666, 10080].every(isBlockedPort) && ![49200, 8080, 1024].some(isBlockedPort))

  /*
   * The backend listens on port 0 itself and, handed a refused port, closes
   * and listens again (R20-B6). Picking a port with a throwaway server and
   * listening on it afterwards left a window in which another process could
   * take it, and the EADDRINUSE that followed had no handler.
   */
  const listenForWindow = (backendModule as Partial<typeof backendModule>).listenForWindow
  check("R20-B6 the backend has its own listen-and-retry", typeof listenForWindow === "function")
  if (listenForWindow) {
    const refusedOnce: number[] = []
    const server = createServer((_, response) => response.end("hi"))
    let port = 0
    try {
      port = await listenForWindow(server, "127.0.0.1", (candidate) => {
        if (refusedOnce.length >= 2) return isBlockedPort(candidate)
        refusedOnce.push(candidate)
        return true
      })
    } catch (error) {
      check("R20-B6 told its first two ports are refused, it listens on a third", false, String(error))
    }
    const bound = server.address()
    const answer = port ? await fetch(`http://127.0.0.1:${port}/`).then((response) => response.text(), () => "") : ""
    check(
      "R20-B6 told its first two ports are refused, it listens on a third and answers there",
      refusedOnce.length === 2 && port > 0 && !refusedOnce.includes(port) && typeof bound === "object" && bound?.port === port && answer === "hi",
      { refusedOnce, port, answer },
    )
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))

    let tries = 0
    const never = createServer()
    const exhausted = await listenForWindow(never, "127.0.0.1", () => ++tries > 0, 3).then(
      (got) => `listened on ${got}`,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    check("R20-B6 a port that is always refused gives up after its bounded tries, closed, and rejects", tries === 3 && !never.listening && !exhausted.startsWith("listened"), { tries, exhausted })

    // An address this machine does not have: the listen fails, and the start is told rather than left waiting.
    const failing = createServer()
    const failed = await Promise.race([
      listenForWindow(failing, "192.0.2.1").then(
        () => "listened",
        (error: unknown) => `rejected: ${(error as NodeJS.ErrnoException).code ?? String(error)}`,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 3000)),
    ])
    check("R20-B6 a listen that fails rejects instead of hanging", failed.startsWith("rejected"), failed)
  }

  const backend = await read("src/server/index.ts")
  check(
    "R20-B6 the backend's socket rides the server it listened itself, with an error handler, and no port is picked beforehand",
    /await listenForWindow\(http, "127\.0\.0\.1"\)/.test(backend) && /new WebSocketServer\(\{\s*server: http,/.test(backend) && /server\.on\("error"/.test(backend) && !/windowSafePort|free-port/.test(backend),
  )
  check("R20-B6 and the pick-then-listen helper is gone", !(await fs.stat(path.join(process.cwd(), "src/server/free-port.ts")).then(() => true, () => false)))
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
