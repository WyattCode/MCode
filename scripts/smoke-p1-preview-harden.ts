import fs from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import {
  expirePreviewTokensForTest,
  PREVIEW_CSP,
  PREVIEW_TOKEN_TTL_MS,
  servePreview,
} from "../src/main/preview-server"

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++
    console.log(`ok ${passed} - ${name}`)
  } else {
    failed++
    console.error(`not ok ${passed + failed} - ${name}${detail ? `: ${detail}` : ""}`)
  }
}

interface Response {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

function get(url: string): Promise<Response> {
  const parsed = new URL(url)
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port: parsed.port || 80,
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        headers: { Host: parsed.host },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        })
      },
    )
    request.on("error", reject)
    request.end()
  })
}

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-preview-harden-"))
  try {
    const pagePath = path.join(dir, "page.html")
    await fs.writeFile(pagePath, `<!doctype html>
<html>
  <head><title>Preview</title></head>
  <body>
    <h1>Preview</h1>
    <script>/* irrelevant */</script>
  </body>
</html>
`)
    await fs.writeFile(path.join(dir, "secret.txt"), "do not read me")
    await fs.writeFile(path.join(dir, "creds.json"), JSON.stringify({ token: "do not read me" }))
    await fs.writeFile(path.join(dir, "style.css"), "body { color: red; }")
    await fs.writeFile(path.join(dir, "app.js"), "console.log(1)")
    await fs.writeFile(path.join(dir, "other.html"), "<!doctype html><html><body>other</body></html>")

    check("TTL is one hour", PREVIEW_TOKEN_TTL_MS === 60 * 60 * 1000, String(PREVIEW_TOKEN_TTL_MS))
    check("CSP blocks connect", PREVIEW_CSP.includes("connect-src 'none'"))

    const first = await servePreview(pagePath)
    check("servePreview succeeds", first.ok === true)
    if (!first.ok) return

    const entry = await get(first.url)
    check("entry page is served", entry.status === 200, String(entry.status))
    check("entry page has CSP", String(entry.headers["content-security-policy"] ?? "").includes("connect-src 'none'"))
    check("entry page keeps referrer policy", entry.headers["referrer-policy"] === "no-referrer")

    const css = await get(new URL("style.css", first.url).href)
    check("sidecar css is served", css.status === 200, String(css.status))

    const js = await get(new URL("app.js", first.url).href)
    check("sidecar js is served", js.status === 200, String(js.status))

    const txt = await get(new URL("secret.txt", first.url).href)
    check("sibling txt is hidden", txt.status === 404 || txt.status === 403, String(txt.status))

    const json = await get(new URL("creds.json", first.url).href)
    check("sibling json is hidden", json.status === 404 || json.status === 403, String(json.status))

    const siblingHtml = await get(new URL("other.html", first.url).href)
    check("sibling html is hidden", siblingHtml.status === 404 || siblingHtml.status === 403, String(siblingHtml.status))

    const otherPath = path.join(dir, "other.html")
    const other = await servePreview(otherPath)
    check("second html in same folder serves", other.ok === true)
    if (other.ok) {
      const otherPage = await get(other.url)
      check("second entry is served", otherPage.status === 200, String(otherPage.status))
      const firstStill = await get(first.url)
      check("first entry stays served after second open", firstStill.status === 200, String(firstStill.status))
      const stillSecret = await get(new URL("secret.txt", first.url).href)
      check("secrets stay hidden with two entries", stillSecret.status === 404 || stillSecret.status === 403, String(stillSecret.status))
    }

    expirePreviewTokensForTest()
    const expired = await get(first.url)
    check("expired token is hidden", expired.status === 404, String(expired.status))

    const second = await servePreview(pagePath)
    check("servePreview mints a fresh token", second.ok === true)
    if (second.ok) {
      const fresh = await get(second.url)
      check("fresh token serves entry", fresh.status === 200, String(fresh.status))
      check("fresh token has CSP", String(fresh.headers["content-security-policy"] ?? "").includes("connect-src 'none'"))
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

main()
  .catch((error) => {
    failed++
    console.error(`not ok ${passed + failed} - smoke threw: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  })
  .finally(() => {
    console.log(`# passed ${passed}, failed ${failed}`)
    process.exit(failed ? 1 : 0)
  })
