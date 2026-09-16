import { ipcMain, session } from "electron"
import {
  COVER_SCHEME,
  bilibiliMeta,
  cacheState,
  coverAddress,
  coverProxyAddress,
  evictions,
  linkOnlyCard,
  oembedMeta,
  pageMeta,
  parseBilibili,
  parsePlatformLink,
  type MediaMeta,
  type MediaPlatform,
} from "@shared/media-platform"
import { serveCover } from "./media-cover"

/**
 * The main process's half of MiMo's video cards.
 *
 * The window cannot reach the web (its content policy allows sockets to the
 * backend and nothing else), so what a platform says about a link - title,
 * cover, author, length - is asked for here, the way MiMo's main process does:
 * bilibili's view API, YouTube's oEmbed, and for the other twelve the page's
 * Open Graph tags. Only links `parsePlatformLink` already accepted are ever
 * fetched. A card itself opens its video in the panel's browser, as MiMo's does.
 * Its cover is an address on MiMo's cover proxy (media-cover.ts), never the
 * picture's own address.
 */

const AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
const BILIBILI_HEADERS = { "user-agent": AGENT, referer: "https://www.bilibili.com/" }
const TIMEOUT_MS = 12_000
const PER_CALL = 20
/* A platform page is read for its head only; nothing past this is needed. */
const PAGE_LIMIT = 1_500_000

async function cappedText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ""
  const decoder = new TextDecoder()
  let text = ""
  let read = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    read += value.byteLength
    text += decoder.decode(value, { stream: true })
    if (read >= limit) {
      await reader.cancel().catch(() => undefined)
      break
    }
  }
  return text
}

async function bilibili(url: string, signal: AbortSignal): Promise<MediaMeta | null> {
  const link = parseBilibili(url)
  if (!link) return null
  let query = ""
  if ("bvid" in link.id) query = `bvid=${encodeURIComponent(link.id.bvid)}`
  else if ("aid" in link.id) query = `aid=${link.id.aid}`
  else {
    // A b23.tv short link is followed to the video it stands for.
    const landed = await fetch(link.id.short, { method: "HEAD", headers: BILIBILI_HEADERS, redirect: "follow", signal })
      .then((response) => response.url)
      .catch(() => "")
    const target = parseBilibili(landed)
    if (target && "bvid" in target.id) query = `bvid=${encodeURIComponent(target.id.bvid)}`
    else if (target && "aid" in target.id) query = `aid=${target.id.aid}`
    else return null
  }
  const response = await fetch(`https://api.bilibili.com/x/web-interface/view?${query}`, { headers: BILIBILI_HEADERS, signal })
  if (response.status !== 200) return null
  return bilibiliMeta(await response.json(), link.url) ?? null
}

async function youtube(url: string, signal: AbortSignal): Promise<MediaMeta | null> {
  const response = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, { headers: { "user-agent": AGENT }, signal })
  if (response.status !== 200) return null
  const meta = oembedMeta(await response.json())
  if (!meta.title || !coverAddress(meta.image)) return null
  return { kind: "video", platform: "youtube", url, title: meta.title, author: meta.author, coverUrl: coverProxyAddress(meta.image), aspect: meta.vertical ? "9:16" : "16:9" }
}

/* The other twelve always make a card, as MiMo's do: a blank one when the page says nothing useful. */
async function external(platform: MediaPlatform, url: string, signal: AbortSignal): Promise<MediaMeta> {
  const blank: MediaMeta = { kind: "video", platform, url, title: "", coverUrl: "", aspect: "16:9" }
  try {
    const response = await fetch(url, { headers: { "user-agent": AGENT }, redirect: "follow", signal })
    if (response.status !== 200) return blank
    const meta = pageMeta(await cappedText(response, PAGE_LIMIT))
    const title = meta.titleFromOg && meta.title ? meta.title : ""
    return {
      ...blank,
      title,
      author: title ? meta.author : undefined,
      coverUrl: coverProxyAddress(meta.image),
      durationSec: title ? meta.durationSec : undefined,
      aspect: meta.vertical ? "9:16" : "16:9",
    }
  } catch {
    return blank
  }
}

async function lookup(url: string, signal: AbortSignal): Promise<MediaMeta | null> {
  const link = parsePlatformLink(url)
  if (!link) return null
  if (link.platform === "bilibili") return bilibili(link.url, signal)
  if (link.platform === "youtube") return youtube(link.url, signal)
  return external(link.platform, link.url, signal)
}

const cache = new Map<string, { value: MediaMeta | null; storedAt: number; lastUsedAt: number }>()
const pending = new Map<string, Promise<MediaMeta | null>>()

function cached(url: string): Promise<MediaMeta | null> {
  const now = Date.now()
  const entry = cache.get(url)
  if (entry && cacheState(entry, now) === "hit") {
    entry.lastUsedAt = now
    return Promise.resolve(entry.value)
  }
  const inFlight = pending.get(url)
  if (inFlight) return inFlight
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS)
  const job = lookup(url, abort.signal)
    .catch(() => null)
    .then((value) => {
      clearTimeout(timer)
      pending.delete(url)
      const stored = Date.now()
      cache.set(url, { value, storedAt: stored, lastUsedAt: stored })
      for (const key of evictions(cache)) cache.delete(key)
      return value
    })
  pending.set(url, job)
  return job
}

/** `detailsOn` reads the video card switch in settings; off, nothing here reaches the web. */
export function registerMediaEmbeds(detailsOn: () => boolean): void {
  ipcMain.handle("mcode:media-enrich", async (_event, urls: unknown) => {
    const list = Array.isArray(urls) ? urls.filter((url): url is string => typeof url === "string" && url.length <= 2048).slice(0, PER_CALL) : []
    if (!detailsOn()) return list.map(linkOnlyCard)
    return Promise.all(list.map(cached))
  })

  /*
   * The covers, on the window's own session only. The browser panel's
   * partition has no such scheme, so a page there cannot use the app to fetch
   * with a platform's referer. The global fetch is looked up per request.
   */
  session.defaultSession.protocol.handle(COVER_SCHEME, (request) =>
    detailsOn() ? serveCover(request.url, request.method, (url, init) => fetch(url, init)) : new Response(null, { status: 404 }),
  )
}
