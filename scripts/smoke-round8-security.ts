/**
 * Round 8 (security): the attack surface audit's fixes, each checked by
 * replaying the attack it closes.
 *
 * Kept apart from smoke.ts the way the other rounds are; smoke.ts calls
 * `roundEightSecurityChecks` with its own check and section. Nothing here calls
 * a model or reaches the network - the only sockets opened are to a backend
 * started in a temporary folder. No check prints a secret: a detail that would
 * hold one names its length or its outcome instead.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import WebSocket from "ws"
import type { Check } from "./smoke-round5"
import { startBackend } from "../src/server/index"
import { refusalOf, rendererOrigins, sameSecret } from "../src/server/socket-guard"
import { SOCKET_PROTOCOL, socketProtocols } from "../src/shared/socket-auth"

type Section = (name: string) => void

/** How a handshake ended: opened with the protocol the server chose, or refused with a status. */
async function dial(
  url: string,
  protocols: string[] | undefined,
  headers: Record<string, string> = {},
): Promise<{ opened: boolean; status?: number; protocol?: string; socket?: WebSocket }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, protocols, { headers })
    socket.once("open", () => resolve({ opened: true, protocol: socket.protocol, socket }))
    socket.once("unexpected-response", (_request, response) => {
      resolve({ opened: false, status: response.statusCode })
      socket.terminate()
    })
    socket.once("error", () => resolve({ opened: false }))
  })
}

/** One request over an open socket, answered or not within a few seconds. */
async function ask(socket: WebSocket, request: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const id = `sec${Math.random().toString(36).slice(2)}`
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: "no answer" }), 5000)
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString())
      if (frame.kind !== "response" || frame.id !== id) return
      clearTimeout(timer)
      resolve({ ok: frame.ok, data: frame.data, error: frame.error })
    })
    socket.send(JSON.stringify({ kind: "request", id, request }))
  })
}

export async function roundEightSecurityChecks(check: Check, section: Section): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-round8-sec-"))
  try {
    await socketChecks(check, section, root)
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}

// ------------------------------------------------------------------- X1
async function socketChecks(check: Check, section: Section, root: string): Promise<void> {
  section("Round 8 (X1): only this app's own window can open the backend socket")

  // The rule itself, with a secret that is not a real one.
  const admission = { port: 4100, secret: "s3cret-for-the-rule", origins: ["file://"] }
  const good = { host: "127.0.0.1:4100", protocols: socketProtocols(admission.secret).join(", ") }
  check("the app's own page with the secret is admitted", refusalOf({ ...good, origin: "file://" }, admission) === undefined)
  check("a local process with the secret and no Origin is admitted", refusalOf(good, admission) === undefined)
  check("no secret is refused", refusalOf({ host: good.host, protocols: SOCKET_PROTOCOL }, admission) === "secret")
  check("a wrong secret is refused", refusalOf({ ...good, protocols: socketProtocols("s3cret-for-the-rulf").join(",") }, admission) === "secret")
  check("an empty secret never matches an empty one", !sameSecret("", ""))
  check("a web page's Origin is refused even with the secret", refusalOf({ ...good, origin: "https://evil.example" }, admission) === "origin")
  check("so is a sandboxed frame's null Origin", refusalOf({ ...good, origin: "null" }, admission) === "origin")
  check("a preview page's localhost Origin is refused", refusalOf({ ...good, origin: "http://0123456789abcdef01234567.localhost:4101" }, admission) === "origin")
  check("a rebound host name is refused", refusalOf({ ...good, host: "attacker.example:4100" }, admission) === "host")
  check("another port on loopback is refused", refusalOf({ ...good, host: "127.0.0.1:4101" }, admission) === "host")
  check("a missing Host is refused", refusalOf({ protocols: good.protocols }, admission) === "host")
  check("the packaged page's origin is file://", rendererOrigins(undefined).join() === "file://")
  check("the dev server's origin is its own", rendererOrigins("http://localhost:5173/index.html").join() === "http://localhost:5173")

  // The legitimate client has to hold up its end, or the window never connects.
  const clientSource = await fs.readFile(path.join(process.cwd(), "src/renderer/src/lib/client.ts"), "utf8").catch(() => "")
  const mainSource = await fs.readFile(path.join(process.cwd(), "src/main/index.ts"), "utf8").catch(() => "")
  check("the window's client offers the secret to its own backend only", /this\.address === this\.own \? new WebSocket\(this\.address, socketProtocols\(this\.secret\)\)/.test(clientSource))
  check("the main process hands the secret over the bootstrap channel and names the page's origin", /secret: started\.secret/.test(mainSource) && /origins: rendererOrigins\(/.test(mainSource))

  // The same attacks against a running backend.
  const data = path.join(root, "socket-data")
  await fs.mkdir(path.join(data, "storage"), { recursive: true })
  await fs.writeFile(path.join(data, "storage", "config.json"), "{}")
  const warnings: string[] = []
  const warn = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  }
  const backend = await startBackend(data, { origins: ["file://"] })
  try {
    // Empty rather than a crash on a backend that makes none, so that case reads as failures.
    const secret = backend.secret ?? ""
    const url = `ws://127.0.0.1:${backend.port}`
    check("each launch makes a secret of 32 random bytes", typeof secret === "string" && Buffer.from(secret, "base64url").length === 32, secret?.length)
    const other = await startBackend(path.join(root, "socket-data-2"))
    check("and a second launch makes a different one", other.secret !== secret)
    await other.close()

    const bare = await dial(url, undefined)
    check("a client offering nothing is refused (401)", !bare.opened && bare.status === 401, bare.status)
    const plain = await dial(url, [SOCKET_PROTOCOL])
    check("a client offering only the protocol name is refused", !plain.opened && plain.status === 401, plain.status)
    const wrong = await dial(url, socketProtocols(`${secret.slice(0, -1)}${secret.endsWith("A") ? "B" : "A"}`))
    check("a client with a secret one character off is refused", !wrong.opened && wrong.status === 401, wrong.status)
    const page = await dial(url, socketProtocols(secret), { Origin: "https://evil.example" })
    check("a web page's handshake is refused even holding the secret (403)", !page.opened && page.status === 403, page.status)
    const rebound = await dial(url, socketProtocols(secret), { Host: `attacker.example:${backend.port}` })
    check("a handshake naming another host is refused (403)", !rebound.opened && rebound.status === 403, rebound.status)

    const local = await dial(url, socketProtocols(secret))
    check("a local client with the secret connects", local.opened)
    check("the server answers with the plain protocol name, never the secret", local.protocol === SOCKET_PROTOCOL, local.protocol === SOCKET_PROTOCOL ? SOCKET_PROTOCOL : "other")
    if (local.socket) {
      const listed = await ask(local.socket, { type: "session.list" })
      check("and its requests are served", listed.ok && Array.isArray((listed.data as { sessions?: unknown })?.sessions), listed.error)
      local.socket.close()
    }
    const window = await dial(url, socketProtocols(secret), { Origin: "file://" })
    check("the packaged window's origin with the secret connects", window.opened)
    window.socket?.close()

    check("refusals are logged", warnings.some((line) => line.includes("[socket] refused")), warnings.length)
    check("no log line holds the secret or a guess at it", !warnings.some((line) => line.includes(secret) || line.includes(secret.slice(0, 12))))
  } finally {
    console.warn = warn
    await backend.close()
  }
}
