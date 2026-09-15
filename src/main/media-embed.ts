import { BrowserWindow, ipcMain, session, type WebContents, type WebFrameMain } from "electron"
import {
  bilibiliMeta,
  cacheState,
  coverAddress,
  evictions,
  isEmbedAddress,
  oembedMeta,
  pageMeta,
  parseBilibili,
  parsePlatformLink,
  speedValue,
  type MediaMeta,
  type MediaPlatform,
} from "@shared/media-platform"

/**
 * The main process's half of MiMo's video cards.
 *
 * The window cannot reach the web (its content policy allows sockets to the
 * backend and nothing else), so what a platform says about a link - title,
 * cover, author, length, and for bilibili the video's cid that its player page
 * needs - is asked for here, the way MiMo's main process does: bilibili's view
 * API, YouTube's oEmbed, and for the other twelve the page's Open Graph tags.
 * Only links `parsePlatformLink` already accepted are ever fetched.
 *
 * The inline player is a frame in the window showing one of the two player
 * pages. The window cannot script a page of another origin, so the speed menu
 * sets `playbackRate` through that frame from here, and a player that fails to
 * load is reported back so the card can show MiMo's error panel.
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

async function youtube(url: string, embedUrl: string, signal: AbortSignal): Promise<MediaMeta | null> {
  const response = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, { headers: { "user-agent": AGENT }, signal })
  if (response.status !== 200) return null
  const meta = oembedMeta(await response.json())
  const cover = coverAddress(meta.image)
  if (!meta.title || !cover) return null
  return { kind: "video", platform: "youtube", play: "inline", url, embedUrl, title: meta.title, author: meta.author, coverUrl: cover, aspect: meta.vertical ? "9:16" : "16:9" }
}

/* The other twelve always make a card, as MiMo's do: a blank one when the page says nothing useful. */
async function external(platform: MediaPlatform, url: string, signal: AbortSignal): Promise<MediaMeta> {
  const blank: MediaMeta = { kind: "video", platform, play: "external", url, embedUrl: "", title: "", coverUrl: "", aspect: "16:9" }
  try {
    const response = await fetch(url, { headers: { "user-agent": AGENT }, redirect: "follow", signal })
    if (response.status !== 200) return blank
    const meta = pageMeta(await cappedText(response, PAGE_LIMIT))
    const title = meta.titleFromOg && meta.title ? meta.title : ""
    return {
      ...blank,
      title,
      author: title ? meta.author : undefined,
      coverUrl: coverAddress(meta.image),
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
  if (link.platform === "youtube") return youtube(link.url, link.embedUrl, signal)
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

/** The player frame a window's reply shows for this address: a direct child of the page, on a player origin. */
function playerFrame(contents: WebContents, embedUrl: unknown): WebFrameMain | undefined {
  if (typeof embedUrl !== "string" || !isEmbedAddress(embedUrl)) return undefined
  const players = contents.mainFrame.frames.filter((frame) => isEmbedAddress(frame.url))
  const wanted = new URL(embedUrl)
  const same = (frame: WebFrameMain) => {
    const at = new URL(frame.url)
    return at.origin === wanted.origin && at.pathname === wanted.pathname
  }
  return players.find((frame) => frame.url === embedUrl) ?? players.find(same) ?? (players.length === 1 ? players[0] : undefined)
}

const READ_SPEED = '(()=>{const v=document.querySelector("video");return v?v.playbackRate:null})()'
const setSpeed = (rate: number) => `(()=>{const v=document.querySelector("video");if(!v)return null;v.playbackRate=${rate};return v.playbackRate})()`
/* MiMo hides bilibili's own speed control, so the card's menu is the one in charge. */
const HIDE_BILIBILI_SPEED =
  '(()=>{if(document.getElementById("mcode-speed-hide"))return;const s=document.createElement("style");s.id="mcode-speed-hide";s.textContent=".bpx-player-ctrl-playbackrate{display:none !important}";(document.head||document.documentElement).appendChild(s)})();'

export function registerMediaEmbeds(): void {
  ipcMain.handle("mcode:media-enrich", async (_event, urls: unknown) => {
    const list = Array.isArray(urls) ? urls.filter((url): url is string => typeof url === "string" && url.length <= 2048).slice(0, PER_CALL) : []
    return Promise.all(list.map(cached))
  })

  ipcMain.handle("mcode:media-speed", async (event, embedUrl: unknown, rate: unknown) => {
    if (!BrowserWindow.fromWebContents(event.sender)) return null
    const frame = playerFrame(event.sender, embedUrl)
    if (!frame) return null
    const reading = rate === null || rate === undefined
    const bilibiliPlayer = new URL(frame.url).hostname === "player.bilibili.com"
    const code = reading ? `${bilibiliPlayer ? HIDE_BILIBILI_SPEED : ""}${READ_SPEED}` : setSpeed(speedValue(rate))
    try {
      const value = await frame.executeJavaScript(code, true)
      return typeof value === "number" ? speedValue(value) : null
    } catch {
      return null
    }
  })

  /*
   * YouTube's player refuses to start without a referrer, and a packaged window
   * is a file page that sends none; MiMo gives its player youtube.com as the
   * referrer, and so does this, for that frame's own document request only.
   */
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ["https://www.youtube-nocookie.com/*"] }, (details, callback) => {
    const requestHeaders = { ...details.requestHeaders }
    if (details.resourceType === "subFrame") requestHeaders.Referer = "https://www.youtube.com/"
    callback({ requestHeaders })
  })
}

/** Tells the window when one of its players failed to load, so the card shows MiMo's error panel. */
export function watchPlayerFrames(window: BrowserWindow): void {
  window.webContents.on("did-fail-load", (_event, code, description, validatedURL, isMainFrame) => {
    // -3 is an aborted load: a collapse or a retry, not a failure.
    if (isMainFrame || code === -3 || !isEmbedAddress(validatedURL)) return
    window.webContents.send("mcode:media-failed", { url: validatedURL, code, description })
  })
}
