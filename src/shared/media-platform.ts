/**
 * MiMo's video platform cards, as plain functions shared by the window, the
 * main process and the checks.
 *
 * A reply's link to one of fourteen video platforms becomes a card, and a card
 * opens its video page in a browser tab of the right panel, as MiMo's shipped
 * build does for all fourteen. Nothing of a platform is ever put in a frame.
 *
 * Hosts are compared whole, after the URL parser has taken the address apart,
 * so a lookalike such as bilibili.com.example.net or youtube.com@example.net
 * is not a platform at all.
 */

export type MediaPlatform =
  | "bilibili"
  | "douyin"
  | "kuaishou"
  | "iqiyi"
  | "tencent"
  | "youku"
  | "mangotv"
  | "xigua"
  | "yangshipin"
  | "migu"
  | "weibo"
  | "youtube"
  | "tiktok"
  | "netflix"

export const MEDIA_PLATFORMS: readonly MediaPlatform[] = [
  "bilibili", "douyin", "kuaishou", "iqiyi", "tencent", "youku", "mangotv",
  "xigua", "yangshipin", "migu", "weibo", "youtube", "tiktok", "netflix",
]

/** MiMo's badge colours for each platform. */
export const PLATFORM_COLOURS: Record<MediaPlatform, { fg: string; bg: string }> = {
  bilibili: { fg: "#fff", bg: "#fb7299" },
  douyin: { fg: "#fff", bg: "#170b1a" },
  kuaishou: { fg: "#fff", bg: "#ff5000" },
  iqiyi: { fg: "#fff", bg: "#00be06" },
  tencent: { fg: "#fff", bg: "#ff820f" },
  youku: { fg: "#fff", bg: "#1a9dff" },
  mangotv: { fg: "#fff", bg: "#ff8f00" },
  xigua: { fg: "#fff", bg: "#ff7700" },
  yangshipin: { fg: "#fff", bg: "#e60012" },
  migu: { fg: "#fff", bg: "#ff5a5f" },
  weibo: { fg: "#fff", bg: "#e6162d" },
  youtube: { fg: "#fff", bg: "#ff0000" },
  tiktok: { fg: "#fff", bg: "#010101" },
  netflix: { fg: "#fff", bg: "#e50914" },
}

export interface PlatformLink {
  platform: MediaPlatform
  url: string
  videoId: string
}

export interface MediaMeta {
  kind: "video"
  platform: MediaPlatform
  url: string
  title: string
  author?: string
  coverUrl: string
  durationSec?: number
  aspect: "16:9" | "9:16"
}

/* ---------------------------------------------------------------- parsing */

/* Punctuation a sentence leaves on the end of an address, as MiMo trims it. */
const TRAILING = /[)\]}>,.;:!?、。，；：！？）】》“”‘’"'…]+$/
const BVID = /^BV[1-9A-HJ-NP-Za-km-z]{10}$/
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/
const NUMERIC_ID = /^\d{6,}$/

export type BilibiliId = { bvid: string } | { aid: number } | { short: string }

function webUrl(address: string): { text: string; parsed: URL } | undefined {
  const text = String(address ?? "").trim().replace(TRAILING, "")
  try {
    const parsed = new URL(text)
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? { text, parsed } : undefined
  } catch {
    return undefined
  }
}

/** A bilibili video address: a BV or av id on bilibili.com, or a b23.tv short link. */
export function parseBilibili(address: string): { url: string; id: BilibiliId } | undefined {
  const web = webUrl(address)
  if (!web) return undefined
  const host = web.parsed.hostname.toLowerCase()
  if (host === "b23.tv") return web.parsed.pathname.replace(/^\/+/, "") ? { url: web.text, id: { short: web.text } } : undefined
  if (host !== "www.bilibili.com" && host !== "bilibili.com" && host !== "m.bilibili.com") return undefined
  const match = /^\/video\/([^/]+)\/?$/.exec(web.parsed.pathname)
  if (!match) return undefined
  let id = ""
  try {
    id = decodeURIComponent(match[1])
  } catch {
    return undefined
  }
  if (BVID.test(id)) return { url: web.text, id: { bvid: id } }
  const av = /^av(\d{1,16})$/i.exec(id)
  return av ? { url: web.text, id: { aid: Number(av[1]) } } : undefined
}

const bareHost = (parsed: URL) => parsed.hostname.toLowerCase().replace(/^www\./, "")
const onDomain = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`)

export function youtubeId(parsed: URL): string {
  const host = bareHost(parsed)
  if (host === "youtu.be") {
    const first = parsed.pathname.replace(/^\/+/, "").split("/")[0] ?? ""
    return YOUTUBE_ID.test(first) ? first : ""
  }
  if (onDomain(host, "youtube.com") || host === "youtube-nocookie.com") {
    const v = parsed.searchParams.get("v")
    if (v && YOUTUBE_ID.test(v)) return v
    const path = /^\/(?:shorts|embed|v)\/([A-Za-z0-9_-]{11})/.exec(parsed.pathname)
    if (path) return path[1]
  }
  return ""
}

/* MiMo's table for the other twelve platforms. */
const EXTERNAL: { platform: MediaPlatform; hosts: string[]; path?: RegExp; idParams?: string[] }[] = [
  { platform: "douyin", hosts: ["douyin.com"], path: /^\/(video|note)\/\d+/ },
  { platform: "douyin", hosts: ["douyin.com"], idParams: ["modal_id"] },
  { platform: "douyin", hosts: ["v.douyin.com", "iesdouyin.com"] },
  { platform: "kuaishou", hosts: ["kuaishou.com"], path: /^\/(short-video|f|video)\// },
  { platform: "kuaishou", hosts: ["v.kuaishou.com", "chenzhongtech.com"] },
  { platform: "iqiyi", hosts: ["iqiyi.com"], path: /^\/[vw]_[\w-]+\.html/ },
  { platform: "tencent", hosts: ["v.qq.com"], path: /^\/x\/(cover|page)\// },
  { platform: "youku", hosts: ["youku.com"], path: /^\/v_show\/id_/ },
  { platform: "mangotv", hosts: ["mgtv.com"], path: /^\/(b|l)\// },
  { platform: "xigua", hosts: ["ixigua.com"], path: /^\/\d+/ },
  { platform: "xigua", hosts: ["v.ixigua.com"] },
  { platform: "yangshipin", hosts: ["yangshipin.cn"], path: /\/[\w-]{6,}/ },
  { platform: "migu", hosts: ["miguvideo.com", "migu.cn"], path: /\/[\w-]{4,}/ },
  { platform: "weibo", hosts: ["weibo.com"], path: /^\/(tv\/show|show)\b/ },
  { platform: "weibo", hosts: ["video.weibo.com"] },
  { platform: "tiktok", hosts: ["tiktok.com"], path: /\/video\/\d+/ },
  { platform: "tiktok", hosts: ["vm.tiktok.com", "vt.tiktok.com"] },
  { platform: "netflix", hosts: ["netflix.com"], path: /^\/(watch|title)\/\d+/ },
]

/** Which platform a link is a video on, if any. */
export function parsePlatformLink(address: string): PlatformLink | undefined {
  const web = webUrl(address)
  if (!web) return undefined
  const bilibili = parseBilibili(web.text)
  if (bilibili) return { platform: "bilibili", url: bilibili.url, videoId: "bvid" in bilibili.id ? bilibili.id.bvid : "" }
  const youtube = youtubeId(web.parsed)
  if (youtube) return { platform: "youtube", url: web.text, videoId: youtube }
  const host = bareHost(web.parsed)
  for (const rule of EXTERNAL) {
    if (!rule.hosts.some((domain) => onDomain(host, domain))) continue
    if (rule.path && !rule.path.test(web.parsed.pathname)) continue
    let videoId = ""
    if (rule.idParams) {
      videoId = rule.idParams.map((name) => (web.parsed.searchParams.get(name) ?? "").trim()).find((value) => NUMERIC_ID.test(value)) ?? ""
      if (!videoId) continue
    }
    return { platform: rule.platform, url: web.text, videoId }
  }
  return undefined
}

const ADDRESS = /https?:\/\/[^\s<>()"']+/g

/** A reply's platform links in order, once each, leaving out anything in a code fence or inline code. */
export function platformLinksIn(text: string): string[] {
  const seen = new Set<string>()
  const found: string[] = []
  String(text ?? "")
    .split(/(```[\s\S]*?```)/g)
    .forEach((piece, index) => {
      if (index % 2 === 1 || piece.includes("```")) return
      for (const match of piece.replace(/`[^`\n]*`/g, "").matchAll(ADDRESS)) {
        const link = parsePlatformLink(match[0])
        if (!link || seen.has(link.url)) continue
        seen.add(link.url)
        found.push(link.url)
      }
    })
  return found
}

/* --------------------------------------------------------------- metadata */

export function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
}

/** An http cover as https, and nothing that is not a web picture address. */
export function coverAddress(value: unknown): string {
  if (typeof value !== "string") return ""
  const address = value.trim().replace(/^http:/i, "https:").replace(/^\/\//, "https://")
  return /^https:\/\/[^\s"'<>]+$/i.test(address) ? address : ""
}

function metaTag(html: string, names: string[]): string {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const tag = new RegExp(`<meta[^>]+(?:property|name)\\s*=\\s*["']${escaped}["'][^>]*>`, "i").exec(html)?.[0]
    const content = tag ? /content\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] : undefined
    if (content) return decodeEntities(content.trim())
  }
  return ""
}

/** A platform page's Open Graph card: title (and whether it came from og), picture, author, length, orientation. */
export function pageMeta(html: string): { title?: string; titleFromOg: boolean; image?: string; author?: string; durationSec?: number; vertical?: boolean } {
  const text = String(html ?? "")
  const og = metaTag(text, ["og:title", "twitter:title"])
  const plain = decodeEntities((/<title[^>]*>([^<]*)<\/title>/i.exec(text)?.[1] ?? "").trim())
  const duration = Number(metaTag(text, ["og:video:duration", "video:duration"]) || Number.NaN)
  const width = Number(metaTag(text, ["og:video:width", "og:image:width"]))
  const height = Number(metaTag(text, ["og:video:height", "og:image:height"]))
  return {
    title: og || plain || undefined,
    titleFromOg: Boolean(og),
    image: metaTag(text, ["og:image", "og:image:url", "og:image:secure_url", "twitter:image"]) || undefined,
    author: metaTag(text, ["og:video:director", "author", "og:site_name"]) || undefined,
    durationSec: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : undefined,
    vertical: width > 0 && height > 0 ? height > width : undefined,
  }
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
const words = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined)
const positive = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined)

/** YouTube's oEmbed answer. */
export function oembedMeta(json: unknown): { title?: string; image?: string; author?: string; vertical?: boolean } {
  const body = record(json)
  if (!body) return {}
  const width = positive(body.width)
  const height = positive(body.height)
  return { title: words(body.title), image: words(body.thumbnail_url), author: words(body.author_name), vertical: width && height ? height > width : undefined }
}

/** bilibili's view API answer as a card, or nothing when a field MiMo requires (bvid, cid, title, cover) is missing. */
export function bilibiliMeta(json: unknown, url: string): MediaMeta | undefined {
  const body = record(json)
  const data = record(body?.data)
  if (!body || body.code !== 0 || !data) return undefined
  const bvid = words(data.bvid)
  const cid = positive(data.cid)
  const title = words(data.title)
  const cover = coverAddress(data.pic)
  if (!bvid || !BVID.test(bvid) || !cid || !Number.isInteger(cid) || !title || !cover) return undefined
  const dimension = record(data.dimension)
  const width = positive(dimension?.width)
  const height = positive(dimension?.height)
  const owner = record(data.owner)
  return {
    kind: "video",
    platform: "bilibili",
    url,
    title,
    author: words(owner?.name),
    coverUrl: cover,
    durationSec: positive(data.duration),
    aspect: width && height && height > width ? "9:16" : "16:9",
  }
}

/** A card as the main process sent it, checked again on this side: only a platform link is ever opened. */
export function readMediaMeta(value: unknown): MediaMeta | undefined {
  const body = record(value)
  if (!body || body.kind !== "video") return undefined
  const platform = MEDIA_PLATFORMS.find((entry) => entry === body.platform)
  const url = words(body.url)
  if (!platform || !url || !parsePlatformLink(url)) return undefined
  return {
    kind: "video",
    platform,
    url,
    title: typeof body.title === "string" ? body.title.slice(0, 300) : "",
    author: words(body.author)?.slice(0, 120),
    coverUrl: coverAddress(body.coverUrl),
    durationSec: positive(body.durationSec),
    aspect: body.aspect === "9:16" ? "9:16" : "16:9",
  }
}

/* MiMo's lookup cache: a card is good for a day, a miss for ten minutes, and the 500 most recently used are kept. */
export const MEDIA_CACHE_LIMIT = 500
export function cacheState(entry: { value: unknown; storedAt: number } | undefined, now: number): "hit" | "stale" | "miss" {
  if (!entry) return "miss"
  const life = entry.value === null ? 10 * 60 * 1000 : 24 * 60 * 60 * 1000
  return now - entry.storedAt <= life ? "hit" : "stale"
}
export function evictions<K>(entries: Map<K, { lastUsedAt: number }>, limit = MEDIA_CACHE_LIMIT): K[] {
  if (entries.size <= limit) return []
  return [...entries.entries()]
    .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)
    .slice(0, entries.size - limit)
    .map(([key]) => key)
}

/* -------------------------------------------------------------- coverflow */

/** A cover's place in MiMo's coverflow, `offset` steps from the one in front. */
export function coverflowSlot(offset: number): { transform: string; zIndex: number; opacity: number; pointerEvents: "auto" | "none" } {
  if (offset === 0) return { transform: "translateX(0px) translateZ(0px) rotateY(0deg) scale(1)", zIndex: 100, opacity: 1, pointerEvents: "auto" }
  const side = offset > 0 ? 1 : -1
  const steps = Math.abs(offset)
  const x = side * (150 + (steps - 1) * 56)
  const z = -140 - (steps - 1) * 40
  const shown = steps <= 4
  return { transform: `translateX(${x}px) translateZ(${z}px) rotateY(${-side * 58}deg) scale(0.92)`, zIndex: 100 - steps, opacity: shown ? 1 : 0, pointerEvents: shown ? "auto" : "none" }
}

export function stepIndex(index: number, step: number, count: number): number {
  return Math.max(0, Math.min(count - 1, index + step))
}
