import { lookup } from "node:dns/promises"
import TurndownService from "turndown"
import type { ToolDefinition } from "./types"
import { ToolError } from "./types"
import { isOffline, markOffline, offlineMessage } from "./offline"

/** MiMo's webfetch limits: 30 seconds unless the call says, never more than 120, and 5 MB of response. */
const DEFAULT_TIMEOUT_SECONDS = 30
const MAX_TIMEOUT_MS = 120_000
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const MAX_REDIRECTS = 10
/** A browser's own user agent, which is what MiMo sends; a Cloudflare challenge is tried once more as this app. */
const BROWSER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"
const APP_AGENT = "mcode"

const ACCEPT: Record<"markdown" | "text" | "html", string> = {
  markdown: "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1",
  text: "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1",
  html: "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1",
}

/*
 * The addresses MiMo's webfetch will not reach: cloud metadata names, private
 * and link-local networks, carrier-grade NAT and Alibaba's metadata address.
 * Loopback is not among them, in MiMo's list or here.
 */
const BLOCKED_HOSTNAMES = new Set(["metadata.google.internal", "metadata.goog", "kubernetes.default.svc"])
const BLOCKED_IPV4_PREFIXES = ["10.", "0."]

function ipv4Number(ip: string): number {
  return ip.split(".").reduce((total, part) => total * 256 + Number(part), 0)
}

const BLOCKED_IPV4_RANGES = [
  ["172.16.0.0", "172.31.255.255"],
  ["192.168.0.0", "192.168.255.255"],
  ["169.254.0.0", "169.254.255.255"],
  ["100.64.0.0", "100.127.255.255"],
  ["100.100.100.200", "100.100.100.200"],
].map(([start, end]) => ({ start: ipv4Number(start), end: ipv4Number(end) }))

export function blockedIPv4(ip: string): boolean {
  if (BLOCKED_IPV4_PREFIXES.some((prefix) => ip.startsWith(prefix))) return true
  const value = ipv4Number(ip)
  return BLOCKED_IPV4_RANGES.some((range) => value >= range.start && value <= range.end)
}

export function blockedIPv6(ip: string): boolean {
  const address = ip.toLowerCase()
  if (address.startsWith("fe80:") || address.startsWith("fc") || address.startsWith("fd")) return true
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address)
  if (mapped) return blockedIPv4(mapped[1])
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address)
  if (hex) {
    const high = parseInt(hex[1], 16)
    const low = parseInt(hex[2], 16)
    return blockedIPv4(`${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`)
  }
  return false
}

/** Refuses an address that is, or resolves to, one of the blocked ones - before anything is asked or sent. */
async function assertReachable(raw: string): Promise<void> {
  const hostname = new URL(raw).hostname.replace(/^\[|\]$/g, "")
  const refuse = (why: string) => new ToolError(`Refused: ${why}, and this tool does not fetch internal addresses`)
  if (BLOCKED_HOSTNAMES.has(hostname)) throw refuse(`${hostname} is a metadata or cluster address`)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    if (blockedIPv4(hostname)) throw refuse(`${hostname} is a private or internal address`)
    return
  }
  if (hostname.includes(":")) {
    if (blockedIPv6(hostname)) throw refuse(`${hostname} is a private or internal address`)
    return
  }
  let resolved: { address: string; family: number }
  try {
    resolved = await lookup(hostname)
  } catch {
    throw new ToolError(`Could not resolve ${hostname}`)
  }
  if ((resolved.family === 4 && blockedIPv4(resolved.address)) || (resolved.family === 6 && blockedIPv6(resolved.address))) {
    throw refuse(`${hostname} resolves to ${resolved.address}`)
  }
}

/** Resolve and check an address, tripping the session's offline breaker when DNS cannot find it. */
async function reachable(raw: string, sessionID: string): Promise<void> {
  try {
    await assertReachable(raw)
  } catch (error) {
    if (error instanceof ToolError && error.message.startsWith("Could not resolve")) {
      let hostname = ""
      try {
        hostname = new URL(raw).hostname
      } catch {
        hostname = raw
      }
      markOffline(sessionID, `could not resolve ${hostname}`)
      throw new ToolError(`${error.message}\n\n${offlineMessage(sessionID)}`)
    }
    throw error
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith("#")) {
      const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[name.toLowerCase()] ?? whole
  })
}

const stripTags = (html: string) => html.replace(/<[^>]*>/g, "")

/** Elements whose content is never text for the reader. */
const withoutHidden = (html: string) =>
  html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|noscript|iframe|object|embed|template)\b[\s\S]*?<\/\1\s*>/gi, "")

/** A page's text, markup and scripts dropped, as MiMo's text format gives it. */
export function htmlText(html: string): string {
  return decodeEntities(stripTags(withoutHidden(html))).trim()
}

/**
 * A page as Markdown, converted by turndown with the options MiMo gives it:
 * # headings, - bullets, --- rules, fenced code and *emphasis*, with scripts,
 * styles and the page's meta and link tags left out.
 */
export function htmlToMarkdown(html: string): string {
  const converter = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  })
  converter.remove(["script", "style", "meta", "link"])
  return converter.turndown(html)
}

/** An image a model can be shown: any image type but SVG, which is text, and FastBid sheet music. */
export function imageAttachment(mime: string): boolean {
  return mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/vnd.fastbidsheet"
}

async function bodyWithin(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => {})
      throw new ToolError("The response is larger than 5 MB")
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }
  return out
}

export const WebFetchTool: ToolDefinition = {
  name: "webfetch",
  description: [
    "Fetch one web page or file by URL and return its contents.",
    "",
    "- format markdown (the default) turns a page into Markdown, keeping headings, links and code blocks; text gives the words alone, for a page whose markup is in the way; html gives the page exactly as it was sent, for when the markup is the point.",
    "- timeout is in seconds, and the fetch is refused rather than truncated when the response is over 5 MB.",
    "- Private and link-local addresses on the network are not fetched. A page behind a login will come back as the login page, not as the content.",
    "- An image comes back attached, for you to look at; other files come back as text.",
    "- It performs a GET and nothing else: it cannot post a form, sign in, or run the page's scripts, so a site that renders its content in the browser may come back nearly empty.",
    "",
    "Use it when the work genuinely depends on what a page says - an API's documentation, a release note, an error message someone has written up - and quote what it said rather than what you expected it to say. A redirect is followed, and the result names the address it ended up at.",
  ].join("\n"),
  permission: "webfetch",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Address to fetch, starting with http:// or https://" },
      format: { type: "string", enum: ["text", "markdown", "html"], description: "How to return the content, markdown when left out" },
      timeout: { type: "number", description: `Seconds to wait, ${DEFAULT_TIMEOUT_SECONDS} when left out and at most 120` },
    },
    required: ["url"],
    additionalProperties: false,
  },
  async execute(input, context) {
    if (isOffline(context.sessionID)) throw new ToolError(offlineMessage(context.sessionID))
    const raw = String(input.url)
    if (!raw.startsWith("http://") && !raw.startsWith("https://")) throw new ToolError("The URL has to start with http:// or https://")
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      throw new ToolError(`Not a valid URL: ${raw}`)
    }
    const format = input.format === "text" || input.format === "html" ? input.format : "markdown"
    await reachable(url.toString(), context.sessionID)

    await context.permissions.ask({
      sessionID: context.sessionID,
      messageID: context.messageID,
      callID: context.callID,
      kind: "webfetch",
      directory: context.directory,
      title: "Fetch URL",
      subject: url.toString(),
    })

    const seconds = input.timeout === undefined ? DEFAULT_TIMEOUT_SECONDS : Number(input.timeout)
    const timeout = Math.min((Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_TIMEOUT_SECONDS) * 1000, MAX_TIMEOUT_MS)
    const expiry = AbortSignal.timeout(timeout)
    const signal = AbortSignal.any([expiry, context.signal])

    // Redirects are followed by hand, so each address is checked before it is requested rather than after.
    const get = async (agent: string) => {
      let target = url.toString()
      for (let hop = 0; ; hop++) {
        const response = await fetch(target, {
          headers: { "user-agent": agent, accept: ACCEPT[format], "accept-language": "en-US,en;q=0.9" },
          redirect: "manual",
          signal,
        }).catch((err: Error) => {
          throw new ToolError(expiry.aborted ? "Request timed out" : `Request failed: ${err.message}`)
        })
        const location = response.headers.get("location")
        if (response.status >= 300 && response.status < 400 && location) {
          await response.body?.cancel().catch(() => {})
          if (hop >= MAX_REDIRECTS) throw new ToolError("Too many redirects")
          target = new URL(location, target).toString()
          await reachable(target, context.sessionID)
          continue
        }
        return { response, target }
      }
    }

    let { response, target } = await get(BROWSER_AGENT)
    if (response.status === 403 && response.headers.get("cf-mitigated") === "challenge") {
      await response.body?.cancel().catch(() => {})
      ;({ response, target } = await get(APP_AGENT))
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new ToolError(`HTTP ${response.status} ${response.statusText} from ${new URL(target).host}`)
    }
    const length = response.headers.get("content-length")
    if (length && Number.parseInt(length, 10) > MAX_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => {})
      throw new ToolError("The response is larger than 5 MB")
    }
    const bytes = await bodyWithin(response, MAX_RESPONSE_BYTES)
    const contentType = response.headers.get("content-type") ?? ""
    const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? ""
    const title = `${url.toString()} (${contentType})`
    // Where a redirect ended up, when it went somewhere else, at the top of what the model reads.
    const from = target !== url.toString() ? `Redirected from ${url.toString()} to ${target}\n\n` : ""

    /*
     * An image is handed to the model as an attachment, as MiMo hands it. An
     * SVG is markup, and the model reads it as text.
     */
    if (imageAttachment(mime)) {
      return {
        output: `${from}Fetched an image (${mime}, ${bytes.byteLength} bytes); it is attached.`,
        title,
        metadata: {},
        attachments: [{ path: target, mime, data: Buffer.from(bytes).toString("base64") }],
      }
    }

    const content = new TextDecoder().decode(bytes)
    const html = contentType.includes("text/html")
    const output = format === "markdown" && html ? htmlToMarkdown(content) : format === "text" && html ? htmlText(content) : content
    return { output: from + output, title, metadata: {} }
  },
}
