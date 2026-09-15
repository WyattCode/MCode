import { COVER_LIMIT, coverAnswer, coverRedirect, coverRequest } from "@shared/media-platform"

/**
 * MiMo's cover proxy: a video card's cover, fetched by the main process.
 *
 * The window asks for `mcode-media://proxy/?u=<address>` (see
 * `coverProxyAddress`). The address is fetched only when it is https on one of
 * MiMo's cover hosts; a redirect is followed only to another such address, and
 * only a 2xx picture within the size cap is passed on. Everything else is
 * refused with a status and no body, and the card falls back to its plate.
 *
 * The referer is spoofed: the request names the platform's own page (for
 * i0.hdslb.com, https://www.bilibili.com/) although nothing here is that page,
 * because these CDNs refuse a picture to anyone else. Sending it, as MiMo does,
 * was the user's decision (2026-09-15); it goes to the allowlisted cover hosts
 * only, with no cookies, and never for anything but a picture.
 *
 * Kept free of electron so the checks can run it with a stand-in fetch.
 */

export type CoverFetch = (url: string, init: RequestInit) => Promise<Response>

/* MiMo's desktop Chrome user agent, the same one the metadata lookup sends. */
const AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
const TIMEOUT_MS = 15_000
const MAX_REDIRECTS = 3

const refuse = (status: number) => new Response(null, { status })

async function cappedBytes(response: Response, limit: number): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array(0)
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => undefined)
      return undefined
    }
    chunks.push(value)
  }
  const body = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    body.set(chunk, at)
    at += chunk.byteLength
  }
  return body
}

/** Answers one proxy request; `fetcher` is the network (the global fetch in the app). */
export async function serveCover(requestUrl: string, method: string, fetcher: CoverFetch, timeoutMs = TIMEOUT_MS): Promise<Response> {
  const asked = coverRequest(requestUrl, method)
  if (!asked.ok) return refuse(asked.status)
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  try {
    let hop: { target: string; referer: string } | undefined = { target: asked.target, referer: asked.referer }
    for (let redirects = 0; hop; redirects += 1) {
      const response: Response = await fetcher(hop.target, {
        headers: { referer: hop.referer, "user-agent": AGENT },
        // Redirects are read here rather than followed, so each hop is held to the allowlist.
        redirect: "manual",
        signal: abort.signal,
      })
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined)
        hop = redirects < MAX_REDIRECTS ? coverRedirect(hop.target, response.headers.get("location")) : undefined
        continue
      }
      const type = coverAnswer(response.status, response.headers.get("content-type"), response.headers.get("content-length"))
      if (!type) {
        await response.body?.cancel().catch(() => undefined)
        return refuse(502)
      }
      const body = await cappedBytes(response, COVER_LIMIT)
      if (!body) return refuse(502)
      return new Response(body, {
        status: 200,
        headers: { "content-type": type, "cache-control": "public, max-age=86400", "content-security-policy": "sandbox", "x-content-type-options": "nosniff" },
      })
    }
    return refuse(502)
  } catch {
    return refuse(502)
  } finally {
    clearTimeout(timer)
  }
}
