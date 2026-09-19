/**
 * P14-1 under Electron itself: the video cards' network is Chromium's, and the
 * cover proxy's per-hop host check and referer still hold on it.
 *
 * Bundled to a .cjs and started as Electron's main script by
 * smoke-round14-packaging.ts, with the port of a local https server and a
 * throwaway certificate. Chromium resolves every host to that server
 * (`host-resolver-rules`), so the real cover hosts are asked for by name and
 * nothing leaves the machine. What was seen is written as JSON to the file
 * named in argv: a GUI process has no stdout the parent can read.
 */
import { app, session } from "electron"
import fs from "node:fs"
import https from "node:https"
import { chromiumFetch } from "../src/main/chromium-fetch"
import { serveCover } from "../src/main/media-cover"
import { landing } from "../src/main/media-embed"

const [port, certDir, out] = process.argv.slice(process.defaultApp ? 2 : 1)
app.commandLine.appendSwitch("disable-gpu")
app.commandLine.appendSwitch("host-resolver-rules", `MAP * 127.0.0.1:${port}`)
// Whatever happens below, the process must end.
setTimeout(() => app.exit(3), 30_000).unref()

type Seen = { host: string; path: string; method: string; referer?: string; agent?: string; cookie?: string }
const seen: Seen[] = []
const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")

const server = https.createServer({ key: fs.readFileSync(`${certDir}/key.pem`), cert: fs.readFileSync(`${certDir}/cert.pem`) }, (request, response) => {
  const host = (request.headers.host ?? "").replace(/:\d+$/, "")
  const path = request.url ?? "/"
  seen.push({ host, path, method: request.method ?? "", referer: request.headers.referer, agent: request.headers["user-agent"], cookie: request.headers.cookie })
  const hop = (location: string) => {
    response.writeHead(302, { location, "set-cookie": "tracker=1; Path=/; Secure" })
    response.end("moved")
  }
  const key = `${host}${path}`
  if (key === "i0.hdslb.com/hop.png") return hop("https://i1.hdslb.com/ok.png")
  if (key === "i0.hdslb.com/away.png") return hop("https://evil.example/x.png")
  if (key === "i0.hdslb.com/relative.png") return hop("/ok.png")
  if (key === "b23.tv/abc") return hop("https://www.bilibili.com/video/BV1xx411c7mD?share_source=copy")
  if (key === "i0.hdslb.com/endless.png") {
    response.writeHead(200, { "content-type": "image/png" })
    const chunk = Buffer.alloc(1024 * 1024)
    const pump = () => {
      while (response.write(chunk)) if (response.destroyed) return
      response.once("drain", pump)
    }
    response.on("error", () => undefined)
    pump()
    return
  }
  if (key === "i0.hdslb.com/slow.png") return
  if (path === "/ok.png" || path === "/x.png") {
    response.writeHead(200, { "content-type": "image/png", "set-cookie": "tracker=1; Path=/; Secure" })
    response.end(png)
    return
  }
  response.writeHead(404)
  response.end()
})

app.whenReady().then(async () => {
  const result: Record<string, unknown> = {}
  try {
    await new Promise<void>((resolve) => server.listen(Number(port), "127.0.0.1", resolve))
    session.defaultSession.setCertificateVerifyProc((_request, callback) => callback(0))
    const cover = async (address: string, timeout?: number) => {
      const answer = await serveCover(`mcode-media://proxy/?u=${encodeURIComponent(address)}`, "GET", chromiumFetch, timeout)
      return { status: answer.status, type: answer.headers.get("content-type"), bytes: (await answer.arrayBuffer()).byteLength }
    }
    const since = () => seen.length
    let mark = since()
    result.hop = { answer: await cover("https://i0.hdslb.com/hop.png"), seen: seen.slice(mark) }
    mark = since()
    result.relative = { answer: await cover("https://i0.hdslb.com/relative.png"), seen: seen.slice(mark) }
    mark = since()
    result.away = { answer: await cover("https://i0.hdslb.com/away.png"), seen: seen.slice(mark) }
    mark = since()
    const endlessAt = Date.now()
    result.endless = { answer: await cover("https://i0.hdslb.com/endless.png"), ms: Date.now() - endlessAt }
    const slowAt = Date.now()
    result.slow = { answer: await cover("https://i0.hdslb.com/slow.png", 500), ms: Date.now() - slowAt }
    mark = since()
    const target = await landing("https://b23.tv/abc", new AbortController().signal)
    result.landing = { target, seen: seen.slice(mark) }
    result.cookies = await session.defaultSession.cookies.get({})
    const early = new AbortController()
    early.abort()
    result.preAborted = await chromiumFetch("https://i0.hdslb.com/ok.png", { signal: early.signal }).then(
      () => "answered",
      (error: Error) => error.name,
    )
  } catch (error) {
    result.error = String((error as Error).stack ?? error)
  }
  fs.writeFileSync(out, JSON.stringify(result, null, 1), "utf8")
  server.closeAllConnections()
  server.close()
  app.exit(0)
})
