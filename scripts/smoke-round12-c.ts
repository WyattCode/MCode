/**
 * Round 12, lane C: what the user sees when something fails or there is
 * nothing to show (C12-1 - C12-10), measured against MiMo 26.914. Kept apart
 * from smoke.ts the way the earlier rounds are; smoke.ts calls
 * `roundTwelveFailureChecks` with its own check and section.
 */
import fs from "node:fs/promises"
import { createServer, type AddressInfo } from "node:net"
import path from "node:path"
import { WebSocketServer } from "ws"
import type { Check } from "./smoke-round5"
import { Client } from "../src/renderer/src/lib/client"
import { LANGUAGES, language, t } from "../src/renderer/src/lib/i18n"

const read = (relative: string) => fs.readFile(path.join(process.cwd(), relative), "utf8")

export async function roundTwelveFailureChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 12 (C): failure and empty-state UX")

  // ---------------------------------------------------------------- C12-1
  {
    const before = language.value
    const rendered = LANGUAGES.map(({ id }) => {
      language.value = id
      return [id, t("harnessRow.retryIn", { time: "5s" })] as const
    })
    language.value = before
    const braced = rendered.filter(([, text]) => /[{}]/.test(text) || !text.includes("5s"))
    check("C12-1: the retry countdown renders its time without braces in all 18 languages", braced.length === 0, braced)
  }

  // ---------------------------------------------------------------- C12-2
  await queuedRequestChecks(check)
}

/** A port nothing listens on yet. */
async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * C12-2, against a real socket: a request made while the backend is away waits
 * for it rather than failing on the next refused reconnect, is sent exactly
 * once when it returns, and - once its bound runs out - fails and is never
 * sent afterwards. A request the socket did carry fails when the socket drops.
 */
async function queuedRequestChecks(check: Check): Promise<void> {
  const port = await freePort()
  const received: string[] = []
  let server: WebSocketServer | undefined
  const start = async () => {
    server = new WebSocketServer({ host: "127.0.0.1", port })
    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const frame = JSON.parse(String(raw))
        received.push(frame.request.type)
        // "hang" is never answered, so the socket can be dropped under it.
        if (frame.request.type !== "hang") socket.send(JSON.stringify({ kind: "response", id: frame.id, ok: true, data: frame.request.type }))
      })
    })
    await new Promise<void>((resolve) => server!.once("listening", () => resolve()))
  }
  const stop = async () => {
    for (const socket of server?.clients ?? []) socket.terminate()
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    server = undefined
  }

  const client = new Client(port, "smoke")
  client.connect()
  const settled = <T,>(promise: Promise<T>) => {
    const state: { value?: T; error?: Error } = {}
    promise.then((value) => (state.value = value), (error) => (state.error = error))
    return state
  }
  try {
    // Down: queued, and survives several refused reconnect attempts.
    const queued = settled(client.request({ type: "early" } as never))
    await pause(1500)
    check("C12-2: a request queued while the service is down is not failed by refused reconnects", !queued.error && queued.value === undefined, queued.error?.message)
    await start()
    for (let i = 0; i < 40 && queued.value === undefined; i++) await pause(100)
    check("C12-2: it is delivered once the service returns, exactly once", queued.value === ("early" as never) && received.filter((type) => type === "early").length === 1, received)

    // Carried, then dropped: fails, naming the local service rather than the network.
    const carried = settled(client.request({ type: "hang" } as never))
    for (let i = 0; i < 20 && !received.includes("hang"); i++) await pause(50)
    await stop()
    for (let i = 0; i < 20 && !carried.error; i++) await pause(50)
    check("C12-2: a request the dropped socket carried fails, blaming the local service", carried.error?.message === t("error.backendLost") && t("error.backendLost") !== "error.backendLost", carried.error?.message)

    // Queued past its bound: fails, and is never sent later.
    client.queueTimeout = 600
    const late = settled(client.request({ type: "late" } as never))
    await pause(1000)
    check("C12-2: a queued request that outlives its bound fails with the same sentence", late.error?.message === t("error.backendLost"), late.error?.message)
    await start()
    for (let i = 0; i < 30 && !client.state.connected; i++) await pause(100)
    await pause(300)
    check("C12-2: and a request reported as failed is not sent when the service returns", client.state.connected && !received.includes("late"), received)
  } finally {
    client.close()
    await stop()
  }
}
