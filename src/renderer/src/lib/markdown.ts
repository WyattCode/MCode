import katex from "katex"
import { ABC_SOURCE_LIMIT } from "./abc-play"

/**
 * Small markdown renderer for assistant output.
 *
 * Model output is not trusted markup, so every piece of text is HTML-escaped
 * before it is placed, and the only markup that reaches the DOM is markup built
 * here around escaped text - plus KaTeX's own generated output, which is run
 * with `trust: false` so no command can emit a link or a class. That is the
 * whole security story, and why this exists instead of a general-purpose parser
 * plus sanitizer. Diagrams and SVG are never inlined here: they leave as a
 * separate block whose source a component sanitises with DOMPurify.
 */

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

/** MiMo's test for a video address: one of its video extensions, before any query or fragment. */
export function isVideoAddress(url: string): boolean {
  return /^data:video\//i.test(url) || /\.(mp4|m4v|webm|mov|ogv)(?:[?#].*)?$/i.test(url)
}

const PLAY_ICON = '<svg class="md-video-play" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>'

/** What a caller can ask the renderer for beyond plain formatting. */
export interface MarkdownOptions {
  /**
   * A head on every code block with its language and a copy button, as MiMo
   * draws code in a reply. The words come from the caller, which knows the
   * language the window is in; the button carries both its idle and its
   * "copied" label, and the caller's click handler switches between them.
   */
  codeActions?: { copy: string; copied: string; label: string }
  /**
   * MiMo's table in a reply: scrolled in its own strip, with preview and copy
   * buttons that show above its end while it is hovered. The words come from
   * the caller; the clicks are the caller's to handle.
   */
  tableActions?: { label: string; preview: string; copy: string }
  /** MiMo's video card for a video link in a reply: the hover tip, and the label for a link with none. */
  videoCards?: { tip: string; fallback: string }
  /** KaTeX for `$…$`, `$$…$$`, ```math and the `\(…\)` / `\[…\]` spellings models use. */
  math?: boolean
  /**
   * Live links: web links, bare addresses and footnotes, and pictures by address.
   * Without it a link is its text beside a dim address, as before.
   * `remoteImage` labels the placeholder a picture on the web shows until it is
   * clicked; without it no web picture is drawn at all.
   */
  links?: { imageTip: string; remoteImage?: string }
  /** A path in inline code (or alone in a fence) becomes MiMo's clickable chip or media card. */
  paths?: { tip: string }
  /** Mermaid and SVG fences leave as diagram blocks - except while the reply is still streaming. */
  diagrams?: { streaming: boolean }
  /** A line number on every line of a code block. */
  lineNumbers?: boolean
  /**
   * A reply still arriving, drawn as MiMo draws its live block: the unfinished
   * last line stays plain text, a half-typed table or underline waits, and
   * footnotes wait for the end.
   */
  live?: boolean
}

/** One top-level piece of a reply: markup, or a diagram a component draws. */
export type ReplyBlock =
  | { kind: "html"; html: string }
  | { kind: "diagram"; mode: "mermaid" | "svg"; code: string }
  | { kind: "abc"; code: string }
  | { kind: "svg-loading" }

interface Context {
  options: MarkdownOptions
  /** Footnote definitions by lower-cased label. */
  notes: Map<string, string>
  /** Footnote labels in the order they are first referenced; the number is the index plus one. */
  order: string[]
}

/* ------------------------------------------------------------------ paths */

/* MiMo's whitelist: a path is only a link when its extension is one of these. */
const PATH_EXTENSIONS = new Set([
  "html", "htm", "xhtml", "pdf", "md", "markdown", "txt", "csv", "tsv", "log", "json", "xml", "rtf",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "heic",
  "mp4", "m4v", "mov", "webm", "ogv", "mkv", "avi", "mp3", "wav", "ogg", "m4a", "flac", "aac",
])
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"])
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm", "m4v", "ogv"])
const AUDIO_EXTENSIONS = new Set(["wav", "mp3", "m4a", "ogg", "flac", "aac"])
const TEXT_EXTENSIONS = new Set([
  "md", "markdown", "mdx", "txt", "text", "rst", "org", "log", "csv", "tsv", "json", "jsonc", "yaml", "yml",
  "toml", "ini", "conf", "cfg", "xml", "tex", "adoc",
])

const ABSOLUTE_POSIX = /^\/(?:[^/\n]+\/)*[^/\n]+\.([A-Za-z0-9]{1,10})$/
const ABSOLUTE_WINDOWS = /^[A-Za-z]:[\\/](?:[^\\/\n]+[\\/])*[^\\/\n]+\.([A-Za-z0-9]{1,10})$/
const RELATIVE_FILE = /^(?!\/)(?![A-Za-z]:[\\/])(?:\.\.?\/)*(?:[^/\n]+\/)+[^/\n]+\.([A-Za-z0-9]{1,10})$/
const BARE_NAME = /^(?![./\\])[^/\\\s]+\.([A-Za-z0-9]{1,10})$/
const DRIVE = /^[A-Za-z]:[\\/]/
/* A POSIX folder only counts when it starts somewhere a folder of files usually lives. */
const DIRECTORY_ROOTS = new Set(["Users", "home", "root", "tmp", "var", "usr", "opt", "etc", "mnt", "srv", "private", "Volumes"])

/**
 * How a path link behaves, in MiMo's terms: `open` goes straight to the default
 * program, `resolve` is looked up first and then shown in the files tab or its
 * folder, `dir` is a folder, and `name` is a bare file name with no click.
 */
export type PathKind = "open" | "resolve" | "dir" | "name"
export interface PathHit {
  path: string
  kind: PathKind
  media?: "image" | "video" | "audio"
}

export function mediaOf(file: string): PathHit["media"] {
  const extension = /\.([A-Za-z0-9]{1,10})(?:[?#].*)?$/.exec(file)?.[1].toLowerCase() ?? ""
  if (IMAGE_EXTENSIONS.has(extension)) return "image"
  if (VIDEO_EXTENSIONS.has(extension)) return "video"
  if (AUDIO_EXTENSIONS.has(extension)) return "audio"
  return undefined
}

/** MiMo's four tests, in its order, on the whole content of a code span. */
export function detectPath(value: string): PathHit | undefined {
  const text = value.trim()
  if (!text || text.length > 4096 || text.includes("\n")) return undefined
  const known = (match: RegExpExecArray | null) => (match && PATH_EXTENSIONS.has(match[1].toLowerCase()) ? match[1].toLowerCase() : undefined)

  const absolute = known(ABSOLUTE_POSIX.exec(text) ?? ABSOLUTE_WINDOWS.exec(text))
  if (absolute) {
    const media = mediaOf(text)
    if (media) return { path: text, kind: "open", media }
    return { path: text, kind: TEXT_EXTENSIONS.has(absolute) ? "resolve" : "open" }
  }
  if (known(RELATIVE_FILE.exec(text))) return { path: text, kind: "resolve" }
  if (known(BARE_NAME.exec(text))) return { path: text, kind: "name" }

  const drive = DRIVE.test(text)
  if (!drive && !text.startsWith("/")) return undefined
  const trailing = /[\\/]$/.test(text)
  const bare = text.replace(/[\\/]+$/, "")
  const segments = (drive ? bare.slice(2) : bare).split(/[\\/]/).filter(Boolean)
  const last = segments[segments.length - 1] ?? ""
  if (!trailing && last.includes(".")) return undefined
  if (drive || (segments.length >= 1 && DIRECTORY_ROOTS.has(segments[0]))) return { path: text, kind: "dir" }
  return undefined
}

function pathHtml(hit: PathHit, paths: NonNullable<MarkdownOptions["paths"]>): string {
  const path = escapeHtml(hit.path)
  if (hit.kind === "name") return `<code class="md-path" data-path="${path}" data-path-kind="name">${path}</code>`
  const chip = `<code class="md-path" role="button" tabindex="0" data-path="${path}" data-path-kind="${hit.kind}" title="${escapeHtml(paths.tip)}">${path}</code>`
  // The card is a component the caller mounts here; until then, and if the file is gone, the chip stands in.
  return hit.media ? `<span class="md-media" data-media="${hit.media}" data-media-path="${path}">${chip}</span>` : chip
}

/* ------------------------------------------------------------------- math */

const TEX_CACHE = new Map<string, string>()
const TEX_CACHE_SIZE = 500

/* KaTeX's own markup. trust:false refuses \href, \url, \includegraphics and \htmlClass-type commands. */
function renderTex(source: string, display: boolean): string {
  const key = `${display ? "D" : "I"}${source}`
  const known = TEX_CACHE.get(key)
  if (known !== undefined) return known
  let html: string
  try {
    html = katex.renderToString(source, {
      displayMode: display,
      throwOnError: false,
      strict: "ignore",
      trust: false,
      output: "html",
      maxSize: 50,
      maxExpand: 1000,
    })
  } catch (error) {
    html = `<span class="katex-error" title="${escapeHtml(error instanceof Error ? error.message : String(error))}">${escapeHtml(source)}</span>`
  }
  if (TEX_CACHE.size >= TEX_CACHE_SIZE) TEX_CACHE.delete(TEX_CACHE.keys().next().value as string)
  TEX_CACHE.set(key, html)
  return html
}

const displayMath = (source: string) => `<div class="md-math">${renderTex(source.trim(), true)}</div>`

/* A LaTeX command of two or more letters: what tells a bracketed formula from a bracketed aside. */
const LATEX_COMMAND = /\\[a-zA-Z]{2,}/

/* MiMo only rewrites when a delimiter it knows could be there. */
function needsMathRewrite(text: string): boolean {
  return /\\[[(]/.test(text) || (/^[ \t]*\[/m.test(text) && LATEX_COMMAND.test(text))
}

/**
 * MiMo's delimiter normalisation: `\[…\]` and bare bracket blocks become `$$`
 * blocks, `\(…\)` becomes `$…$`. Fences and inline code are left alone.
 */
function normaliseMath(text: string): string {
  const block = (tex: string) => `\n\n$$\n${tex}\n$$\n\n`
  const rewrite = (piece: string) =>
    piece
      .replace(/\\\[([\s\S]*?)\\\]/g, (whole, inner: string) => {
        const tex = inner.trim()
        return tex && !tex.includes("$") ? block(tex) : whole
      })
      .replace(/\\\(([\s\S]*?)\\\)/g, (whole, inner: string) => {
        const tex = inner.trim()
        return tex && !tex.includes("$") && !/\n[ \t]*\n/.test(inner) ? `$${tex}$` : whole
      })
      .replace(/^[ \t]*\[[ \t]*\n([\s\S]*?)\n[ \t]*\][ \t]*$/gm, (whole, inner: string) => {
        const tex = inner.trim()
        return tex && LATEX_COMMAND.test(tex) && !tex.includes("$") && !/\n[ \t]*\n/.test(inner) ? block(tex) : whole
      })
      .replace(/^[ \t]*\[[ \t]*([^\n[\]]*?)[ \t]*\][ \t]*$/gm, (whole, inner: string) => {
        const tex = inner.trim()
        return tex && LATEX_COMMAND.test(tex) && !tex.includes("$") ? block(tex) : whole
      })
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((part, index) =>
      index % 2 === 1 || part.includes("```")
        ? part
        : part
            .split(/(`[^`\n]*`)/g)
            .map((piece, at) => (at % 2 === 1 ? piece : rewrite(piece)))
            .join(""),
    )
    .join("")
}

/*
 * remark-math's inline rule, so currency stays prose: an opening `$` not
 * followed by a space, a closing one not preceded by a space nor followed by a
 * digit. `$$…$$` inside a line is inline math too.
 */
const INLINE_MATH = /(?<![\\$])\$\$(?!\$)([^$]+?)\$\$(?!\$)|(?<![\\$])\$(?![\s$])((?:\\.|[^$\\\n])+?)(?<!\s)\$(?![\d$])/g

/* ------------------------------------------------------------------- svg */

/* A line no model can write (control characters are stripped from the source): an unfinished <svg> while streaming. */
const SVG_LOADING = "svg-loading"

/* MiMo wraps raw <svg>…</svg> outside fences into an svg fence, so it is drawn rather than shown as text. */
function wrapRawSvg(text: string, streaming: boolean): string {
  if (!/<svg[\s>]/i.test(text)) return text
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((part, index) => {
      if (index % 2 === 1 || part.includes("```")) return part
      let out = part.replace(/<svg[\s>][\s\S]*?<\/svg\s*>/gi, (svg) => `\n\n\`\`\`svg\n${svg.trim()}\n\`\`\`\n\n`)
      if (streaming) out = out.replace(/<svg[\s>][\s\S]*$/i, `\n\n${SVG_LOADING}\n`)
      return out
    })
    .join("")
}

/* ----------------------------------------------------------------- inline */

const WEB_ADDRESS = /^https?:\/\/[^\s<>]+$/i
const IMAGE_ADDRESS = /\.(png|jpe?g|gif|webp|avif|bmp|svg)(?:[?#].*)?$/i
const CJK = "　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯"
const AUTOLINK = new RegExp(`(?<![\\w@/.])(?:https?:\\/\\/|www\\.)[^\\s<>\\u0001\\u0002${CJK}]+`, "gi")
/* MiMo trims these off the end of an address, and a closer only when it has no opener inside. */
const TRAILING = `.,;:!?、，。；:！？“”‘’"'*_~`
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{", "）": "（", "】": "【", "」": "「", "》": "《" }

function trimAddress(address: string): string {
  let end = address.length
  while (end > 0) {
    const last = address[end - 1]
    if (TRAILING.includes(last)) {
      end -= 1
      continue
    }
    const opener = CLOSERS[last]
    if (opener) {
      const head = address.slice(0, end)
      if (head.split(last).length - 1 > head.split(opener).length - 1) {
        end -= 1
        continue
      }
    }
    break
  }
  return address.slice(0, end)
}

/* Emphasis on escaped text: it only ever wraps, so it cannot introduce an attribute. */
function emphasis(html: string): string {
  return html
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])__([^_\n]+)__/g, "$1<strong>$2</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|[\s(])_([^_\n]+)_/g, "$1<em>$2</em>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
}

/* A slot for markup already built, so later passes over the text cannot reach inside it. */
const SLOT = /(\d+)/g

function restore(html: string, stash: string[]): string {
  let out = html
  for (let pass = 0; pass < 4 && SLOT.test(out); pass += 1) {
    SLOT.lastIndex = 0
    out = out.replace(SLOT, (_, index: string) => stash[Number(index)] ?? "")
  }
  return out
}

function codeSpan(content: string, ctx: Context): string {
  const { options } = ctx
  // GFM drops one space from each side when both are there.
  const body = /^ [\s\S]* $/.test(content) && content.trim() ? content.slice(1, -1) : content
  if (options.paths) {
    const hit = detectPath(body)
    if (hit) return pathHtml(hit, options.paths)
  }
  const address = body.trim()
  if (options.links && WEB_ADDRESS.test(address)) {
    return `<a class="md-link md-link-code" href="${escapeHtml(address)}" rel="noreferrer">${escapeHtml(address)}</a>`
  }
  return `<code>${escapeHtml(body)}</code>`
}

/* A local reference in an image: a path, not an address with a scheme. */
function isLocalReference(url: string): boolean {
  return DRIVE.test(url) || (!/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith("//"))
}

const IMAGE_ICON =
  '<svg class="md-img-remote-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><path d="M3.5 3h9A1.5 1.5 0 0 1 14 4.5v7a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7A1.5 1.5 0 0 1 3.5 3z"/><path d="M6 5.3a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4z"/><path d="m2.5 12 3.5-3.5 2.5 2.5 2-2 3 3"/></svg>'

/*
 * A picture on the web, as a placeholder until the reader asks for it.
 *
 * A picture loads the moment it is drawn, and its address can carry anything
 * a model was steered into writing - so drawing it straight away sent that
 * data to whoever named the address, with no click. The user chose to load
 * such pictures only on a click (2026-09-16); the window swaps this for the
 * real picture then (TextPart.vue). Pictures on this machine and inline data
 * are unaffected. The address itself is shown, so the reader knows where the
 * click will reach.
 */
function remoteImageHtml(url: string, label: string, link: boolean, loadLabel: string | undefined): string {
  if (!loadLabel) return escapeHtml(label)
  const address = escapeHtml(url)
  let host = url
  try {
    host = new URL(url).host
  } catch {
    // An address the URL parser refuses still names itself.
  }
  return (
    `<button type="button" class="md-img-remote${link ? " md-img-link" : ""}" data-remote-src="${address}" data-remote-alt="${escapeHtml(label)}"${link ? ` data-fallback-href="${address}"` : ""} title="${address}">` +
    `${IMAGE_ICON}<span class="md-img-remote-label">${escapeHtml(label || loadLabel)}</span><span class="md-img-remote-host">${escapeHtml(loadLabel)} · ${escapeHtml(host)}</span></button>`
  )
}

function linkHtml(image: boolean, label: string, url: string, whole: string, ctx: Context, stash: string[]): string {
  const { options } = ctx
  const cards = options.videoCards
  const address = escapeHtml(url)
  const text = () => restore(emphasis(escapeHtml(label)), stash)
  if (cards && isVideoAddress(url) && (image || /^(https?:|data:|blob:|file:)/i.test(url))) {
    const name = escapeHtml(label || cards.fallback)
    return (
      `<button type="button" class="md-video-card" data-video-url="${address}" data-video-label="${name}" title="${escapeHtml(cards.tip)}">` +
      `${PLAY_ICON}<span class="md-video-label">${name}</span></button>`
    )
  }
  if (!options.links) {
    // Not a live link here: the text, with the address dim beside it.
    return label ? `${image ? "!" : ""}${text()} <span class="md-url">${address}</span>` : escapeHtml(whole)
  }
  const web = /^https?:\/\//i.test(url)
  const tip = escapeHtml(options.links.imageTip)
  if (image) {
    if (web) return remoteImageHtml(url, label, false, options.links.remoteImage)
    if (/^data:image\/(png|jpe?g|gif|webp|avif|bmp);/i.test(url)) {
      return `<img class="md-img" src="${address}" alt="${escapeHtml(label)}" title="${tip}" data-preview-src="${address}" loading="lazy" />`
    }
    if (options.paths && isLocalReference(url) && mediaOf(url) === "image") {
      return `<span class="md-media" data-media="image" data-media-path="${address}"><code>${escapeHtml(url)}</code></span>`
    }
    return escapeHtml(label)
  }
  if (web && IMAGE_ADDRESS.test(url)) {
    // No placeholder label to show: the picture link stays the link it is.
    if (!options.links.remoteImage) return `<a class="md-link" href="${address}" rel="noreferrer">${label ? text() : address}</a>`
    return remoteImageHtml(url, label, true, options.links.remoteImage)
  }
  if (web) return `<a class="md-link" href="${address}" rel="noreferrer">${label ? text() : address}</a>`
  // Any other scheme - javascript:, file:, a relative path - is never a link, only its words.
  return label ? text() : escapeHtml(whole)
}

const LINK = /(!?)\[([^\]\n]*)\]\(\s*<?([^\s)<>]+)>?(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g

function inline(raw: string, ctx: Context): string {
  const { options } = ctx
  const stash: string[] = []
  const put = (html: string) => `${stash.push(html) - 1}`
  let text = raw.replace(/[]/g, "")

  // Inline code first: nothing inside it is formatting.
  text = text.replace(/(?<!`)(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (_, _ticks: string, code: string) => put(codeSpan(code, ctx)))
  if (options.math) text = text.replace(INLINE_MATH, (_, wide: string | undefined, narrow: string | undefined) => put(renderTex(wide ?? narrow ?? "", false)))
  if (options.links && ctx.notes.size) {
    text = text.replace(/\[\^([^\]\s]+)\]/g, (whole, label: string) => {
      const key = label.toLowerCase()
      if (!ctx.notes.has(key)) return whole
      let number = ctx.order.indexOf(key) + 1
      if (!number) number = ctx.order.push(key)
      return put(`<sup class="md-fnref"><a class="md-fnref-link" href="#md-fn-${number}" data-footnote-ref="${number}">${number}</a></sup>`)
    })
  }
  text = text.replace(LINK, (whole, bang: string, label: string, url: string) => put(linkHtml(bang === "!", label, url, whole, ctx, stash)))
  if (options.links) {
    text = text.replace(AUTOLINK, (match: string) => {
      const address = trimAddress(match)
      if (/^(https?:\/\/|www\.)$/i.test(address) || !address) return match
      const href = /^www\./i.test(address) ? `http://${address}` : address
      return put(`<a class="md-link" href="${escapeHtml(href)}" rel="noreferrer">${escapeHtml(address)}</a>`) + match.slice(address.length)
    })
  }
  return restore(emphasis(escapeHtml(text)), stash)
}

/* ----------------------------------------------------------------- blocks */

/**
 * One row of a pipe table, with the outer pipes taken off.
 *
 * `| a | b |` and `a | b` are the same row - GFM makes the leading and
 * trailing pipe optional - so they are stripped before splitting rather than
 * left to become empty cells at each end. `\|` is a pipe inside a cell.
 */
function tableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "")
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"))
}

/**
 * The row of dashes under a table's head, and what it says about alignment.
 *
 * Returns undefined when the line is not one, which is what decides whether
 * the line above it was a header or just a paragraph with pipes in it: a table
 * exists only if this row is directly beneath.
 */
function tableAlignment(line: string): ("left" | "center" | "right" | undefined)[] | undefined {
  if (!/^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line)) return undefined
  return tableCells(line).map((cell) => {
    const left = cell.startsWith(":")
    const right = cell.endsWith(":")
    if (left && right) return "center"
    if (right) return "right"
    if (left) return "left"
    return undefined
  })
}

const COPY_ICON =
  '<svg class="md-code-icon idle" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
  '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.2"/>' +
  '<path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" stroke="currentColor" stroke-width="1.2"/></svg>' +
  '<svg class="md-code-icon done" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
  '<path d="M3.5 8.5 6.5 11.5 12.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'

/* The table buttons' glyphs: 12px on a 24 grid with a 1.7 stroke, as MiMo draws them. */
const TABLE_GLYPH = 'width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"'
const TABLE_PREVIEW_ICON = `<svg ${TABLE_GLYPH}><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>`
const TABLE_COPY_ICON =
  `<svg class="md-table-copy-idle" ${TABLE_GLYPH}><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>` +
  `<svg class="md-table-copy-check" ${TABLE_GLYPH}><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`

/** One fenced block, from its raw source. */
function codeBlock(language: string, code: string, options: MarkdownOptions): string {
  const lang = escapeHtml(language)
  const body = options.lineNumbers
    ? code.split("\n").map((line) => `<span class="line">${escapeHtml(line)}</span>`).join("\n")
    : escapeHtml(code)
  const pre = `<pre class="md-code${options.lineNumbers ? " md-lined" : ""}"${language ? ` data-lang="${lang}"` : ""}><code>${body}</code></pre>`
  const actions = options.codeActions
  if (!actions) return pre
  return (
    `<div class="md-codeblock"><div class="md-code-head">` +
    `<span class="md-code-lang">${language ? lang.toLowerCase() : "text"}</span>` +
    `<button type="button" class="md-code-copy" data-copy-code aria-label="${escapeHtml(actions.label)}">${COPY_ICON}` +
    `<span class="md-code-word idle">${escapeHtml(actions.copy)}</span>` +
    `<span class="md-code-word done">${escapeHtml(actions.copied)}</span></button></div>${pre}</div>`
  )
}

const FENCE_OPEN = /^\s*```\s*([\w+#.-]*)\s*$/
const FENCE_CLOSE = /^\s*```\s*$/
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const QUOTE = /^ {0,3}>[ ]?(.*)$/
const DISPLAY_FENCE = /^\s*\$\$\s*$/
const DISPLAY_LINE = /^\s*\$\$(.+?)\$\$\s*$/

const indentOf = (line: string) => line.length - line.trimStart().length

function startsBlock(line: string, options: MarkdownOptions): boolean {
  return FENCE_OPEN.test(line) || HEADING.test(line) || QUOTE.test(line) || RULE.test(line) || Boolean(options.math && DISPLAY_FENCE.test(line))
}

function joinHtml(blocks: ReplyBlock[], options: MarkdownOptions): string {
  return blocks.map((block) => blockHtml(block, options)).join("")
}

function blockHtml(block: ReplyBlock, options: MarkdownOptions): string {
  if (block.kind === "html") return block.html
  if (block.kind === "diagram") return codeBlock(block.mode, block.code, options)
  if (block.kind === "abc") return codeBlock("abc", block.code, options)
  return ""
}

function fenceBlock(language: string, body: string[], closed: boolean, ctx: Context, top: boolean): ReplyBlock {
  const { options } = ctx
  const lang = language.toLowerCase()
  const code = body.join("\n")
  if (options.math && lang === "math") return { kind: "html", html: displayMath(code) }
  if ((lang === "mermaid" || lang === "svg") && options.diagrams && !options.diagrams.streaming && closed && top && code.trim()) {
    return { kind: "diagram", mode: lang, code }
  }
  // MiMo's score block, under the same rule as a diagram and its cap on the source's length.
  if (lang === "abc" && options.diagrams && !options.diagrams.streaming && closed && top && code.trim() && code.length <= ABC_SOURCE_LIMIT) {
    return { kind: "abc", code }
  }
  // A fence holding nothing but one path is that path, as MiMo reads it.
  const filled = body.filter((line) => line.trim())
  if (options.paths && filled.length === 1 && lang !== "mermaid" && lang !== "svg" && lang !== "abc") {
    const hit = detectPath(filled[0])
    if (hit) return { kind: "html", html: `<p class="md-p">${pathHtml(hit, options.paths)}</p>` }
  }
  return { kind: "html", html: codeBlock(language, code, options) }
}

/* Where a list that starts at `start` ends: items, their indented lines, and lazy continuations. */
function listEnd(lines: string[], start: number, options: MarkdownOptions): number {
  const first = LIST_ITEM.exec(lines[start]) as RegExpExecArray
  const base = first[1].length
  const ordered = /^\d/.test(first[2])
  let at = start + 1
  let blank = false
  for (; at < lines.length; at += 1) {
    const line = lines[at]
    if (!line.trim()) {
      blank = true
      continue
    }
    const indent = indentOf(line)
    const item = RULE.test(line) ? null : LIST_ITEM.exec(line)
    if (item && indent < base + 2) {
      if (indent < base || /^\d/.test(item[2]) !== ordered) break
      blank = false
      continue
    }
    if (indent >= base + 2) {
      blank = false
      continue
    }
    if (blank || startsBlock(line, options) || (lines[at + 1] !== undefined && line.includes("|") && tableAlignment(lines[at + 1]))) break
  }
  while (at > start + 1 && !lines[at - 1].trim()) at -= 1
  return at
}

function listHtml(lines: string[], ctx: Context): string {
  const first = LIST_ITEM.exec(lines[0]) as RegExpExecArray
  const base = first[1].length
  const ordered = /^\d/.test(first[2])
  const items: { lines: string[]; loose: boolean; indent: number }[] = []
  let current: (typeof items)[number] | undefined
  let blank = false
  for (const line of lines) {
    const indent = indentOf(line)
    const item = RULE.test(line) ? null : LIST_ITEM.exec(line)
    if (item && indent < base + 2) {
      current = { lines: [item[3] ?? ""], loose: false, indent: item[1].length + item[2].length + 1 }
      items.push(current)
      blank = false
      continue
    }
    if (!current) continue
    if (!line.trim()) {
      current.lines.push("")
      blank = true
      continue
    }
    if (blank && indent < current.indent + 2 && !LIST_ITEM.test(line.slice(Math.min(indent, current.indent)))) current.loose = true
    current.lines.push(indent >= base + 2 ? line.slice(Math.min(indent, current.indent)) : line.trim())
    blank = false
  }

  const start = ordered ? Number.parseInt(first[2], 10) : 1
  const open = ordered ? `<ol class="md-list"${start !== 1 ? ` start="${start}"` : ""}>` : '<ul class="md-list">'
  const body = items.map((entry) => {
    let content = entry.lines
    let box = ""
    const task = /^\[([ xX])\][ \t]+/.exec(content[0])
    if (task) {
      box = `<input type="checkbox" class="md-task-box" disabled${task[1] === " " ? "" : " checked"} />`
      content = [content[0].slice(task[0].length), ...content.slice(1)]
    }
    const blocks = parseBlocks(content, ctx, false)
    // A tight item is its words, not a paragraph inside a list item.
    const inner = blocks
      .map((block) => {
        const html = blockHtml(block, ctx.options)
        return !entry.loose && html.startsWith('<p class="md-p">') && html.endsWith("</p>") ? html.slice('<p class="md-p">'.length, -"</p>".length) : html
      })
      .join("")
    return `<li${box ? ' class="md-task"' : ""}>${box}${inner}</li>`
  })
  return `${open}${body.join("")}${ordered ? "</ol>" : "</ul>"}`
}

function tableBlock(lines: string[], at: number, alignment: ("left" | "center" | "right" | undefined)[], ctx: Context): { html: string; end: number } {
  const { options } = ctx
  const head = tableCells(lines[at])
  const classes = (column: number, cell?: string) => {
    const names = [alignment[column] ? `md-${alignment[column]}` : "", cell !== undefined && /^\d+$/.test(cell) ? "md-num" : ""].filter(Boolean)
    return names.length ? ` class="${names.join(" ")}"` : ""
  }
  let end = at + 2
  const body: string[] = []
  while (end < lines.length && lines[end].includes("|") && lines[end].trim() !== "") {
    const cells = tableCells(lines[end])
    // Short rows are padded and long ones cut, the way GFM asks, so the grid stays rectangular.
    const row = Array.from({ length: head.length }, (_, column) => cells[column] ?? "")
    body.push("<tr>" + row.map((cell, column) => `<td${classes(column, cell)}>${inline(cell, ctx)}</td>`).join("") + "</tr>")
    end += 1
  }
  const headRow = head.map((cell, column) => `<th${classes(column)}>${inline(cell, ctx)}</th>`).join("")
  const table = `<thead><tr>${headRow}</tr></thead>${body.length ? `<tbody>${body.join("")}</tbody>` : ""}`
  const actions = options.tableActions
  if (!actions) return { html: `<table class="md-table">${table}</table>`, end }
  // The model's own markdown for the table, which is what the copy button hands over.
  const source = escapeHtml(lines.slice(at, end).join("\n"))
  return {
    html:
      `<div class="md-table-container" data-markdown-table data-md-source="${source}" tabindex="-1"><div class="md-table-scroller"><table class="md-table" dir="auto">${table}</table></div>` +
      `<div class="md-table-actions" aria-label="${escapeHtml(actions.label)}">` +
      `<button type="button" class="md-table-icon-button" data-table-preview aria-label="${escapeHtml(actions.preview)}" title="${escapeHtml(actions.preview)}">${TABLE_PREVIEW_ICON}</button>` +
      `<button type="button" class="md-table-icon-button" data-table-copy aria-label="${escapeHtml(actions.copy)}" title="${escapeHtml(actions.copy)}">${TABLE_COPY_ICON}</button>` +
      "</div></div>",
    end,
  }
}

function parseBlocks(lines: string[], ctx: Context, top: boolean): ReplyBlock[] {
  const { options } = ctx
  const blocks: ReplyBlock[] = []
  const push = (html: string) => blocks.push({ kind: "html", html })
  // Consecutive lines are one paragraph, joined by a line break, as MiMo's soft-break pass has it.
  let paragraph: string[] = []
  const flush = () => {
    if (!paragraph.length) return
    push(`<p class="md-p">${paragraph.map((line) => inline(line, ctx)).join("<br>")}</p>`)
    paragraph = []
  }

  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at]

    if (line === SVG_LOADING) {
      flush()
      if (top) blocks.push({ kind: "svg-loading" })
      continue
    }

    const fence = FENCE_OPEN.exec(line)
    if (fence) {
      flush()
      const body: string[] = []
      let closed = false
      for (at += 1; at < lines.length; at += 1) {
        if (FENCE_CLOSE.test(lines[at])) {
          closed = true
          break
        }
        body.push(lines[at])
      }
      // An unterminated fence still has content worth showing - the normal state while a block streams in.
      if (closed || body.length) blocks.push(fenceBlock(fence[1], body, closed, ctx, top))
      continue
    }

    if (options.math && DISPLAY_FENCE.test(line)) {
      flush()
      const body: string[] = []
      for (at += 1; at < lines.length && !DISPLAY_FENCE.test(lines[at]); at += 1) body.push(lines[at])
      push(displayMath(body.join("\n")))
      continue
    }
    const single = options.math && !paragraph.length ? DISPLAY_LINE.exec(line) : null
    if (single) {
      push(displayMath(single[1]))
      continue
    }

    /*
     * A quote runs until something that is not one, and its inside is parsed
     * like any other text - so a list or a code block can sit in a quote.
     */
    if (QUOTE.test(line)) {
      flush()
      const inner: string[] = []
      for (; at < lines.length; at += 1) {
        const quoted = QUOTE.exec(lines[at])
        if (!quoted) break
        inner.push(quoted[1])
      }
      at -= 1
      push(`<blockquote class="md-quote">${joinHtml(parseBlocks(inner, ctx, false), options)}</blockquote>`)
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      flush()
      /*
       * Shifted down two, so a reply's own headings sit under the page's; the
       * size they are drawn at comes from the markdown level instead, which is
       * what the author actually meant by one hash or three.
       */
      const rank = heading[1].length
      const level = Math.min(6, rank + 2)
      push(`<h${level} class="md-h" data-level="${rank}">${inline(heading[2], ctx)}</h${level}>`)
      continue
    }

    /*
     * A pipe table. Recognised by the row of dashes UNDER the header, which is
     * what tells a real table from a line that merely contains pipes - a shell
     * command with a pipe in it is far more common in this app than a table,
     * and must stay a paragraph. GFM also requires the two rows to agree.
     */
    const alignment = at + 1 < lines.length && line.includes("|") ? tableAlignment(lines[at + 1]) : undefined
    if (alignment && tableCells(line).length === alignment.length) {
      flush()
      const table = tableBlock(lines, at, alignment, ctx)
      push(table.html)
      at = table.end - 1
      continue
    }

    if (RULE.test(line)) {
      flush()
      push('<hr class="md-rule" />')
      continue
    }

    const item = LIST_ITEM.exec(line)
    // An ordered list may only interrupt a paragraph when it starts at one, as GFM has it.
    if (item && (item[3] ?? "").trim() !== "" && !(paragraph.length && /^\d/.test(item[2]) && Number.parseInt(item[2], 10) !== 1)) {
      flush()
      const end = listEnd(lines, at, options)
      push(listHtml(lines.slice(at, end), ctx))
      at = end - 1
      continue
    }

    if (!line.trim()) {
      flush()
      continue
    }
    paragraph.push(line.trim())
  }
  flush()
  return blocks
}

/* Footnote definitions come out of the flow before anything is parsed, so a reference can find its note. */
function takeFootnotes(lines: string[], notes: Map<string, string>): string[] {
  const kept: string[] = []
  let fenced = false
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at]
    if (/^\s*```/.test(line)) fenced = !fenced
    const definition = fenced ? null : /^ {0,3}\[\^([^\]\s]+)\]:[ \t]*(.*)$/.exec(line)
    if (!definition) {
      kept.push(line)
      continue
    }
    const body = [definition[2]]
    while (at + 1 < lines.length && /^ {2,}\S/.test(lines[at + 1])) body.push(lines[++at].trim())
    const key = definition[1].toLowerCase()
    if (!notes.has(key)) notes.set(key, body.join(" "))
  }
  return kept
}

function footnotesHtml(ctx: Context): string {
  const items: string[] = []
  // A note may cite another note, which then joins the end of the list.
  for (let index = 0; index < ctx.order.length; index += 1) {
    const number = index + 1
    const text = inline(ctx.notes.get(ctx.order[index]) ?? "", ctx)
    items.push(`<li data-footnote="${number}">${text} <a class="md-fn-back" href="#md-fnref-${number}" data-footnote-back="${number}" aria-label="↩ ${number}">↩</a></li>`)
  }
  return `<section class="md-footnotes" data-footnotes><ol>${items.join("")}</ol></section>`
}

/* ------------------------------------------------------------ live replies */

/* Where the last top-level block starts (after a blank line, heading, rule or closing fence), and whether the text ends inside a fence. */
function lastBlockStart(lines: string[]): { start: number; inFence: boolean } {
  let fenced = false
  let start = 0
  lines.forEach((line, at) => {
    if (fenced) {
      if (FENCE_CLOSE.test(line)) {
        fenced = false
        start = at + 1
      }
      return
    }
    if (FENCE_OPEN.test(line)) {
      fenced = true
      start = at
      return
    }
    if (!line.trim() || HEADING.test(line) || RULE.test(line)) start = at + 1
  })
  return { start, inFence: fenced }
}

/**
 * MiMo's live block, for a reply still arriving: code and tables keep their
 * last line; a pipe block that is not a table yet is held back whole; a
 * trailing line of only - or = waits, so it cannot turn the paragraph above
 * into a heading mid-stream; and the unfinished last line of prose is handed
 * back as `open`, to be shown as plain text until its newline arrives.
 */
export function splitLive(text: string): { settled: string; open: string } {
  const lines = text.split("\n")
  const { start, inFence } = lastBlockStart(lines)
  if (inFence) return { settled: text, open: "" }
  const block = lines.slice(start)
  const first = block.findIndex((line) => line.trim())
  if (first >= 0 && /^[ \t]{0,3}\|/.test(block[first])) {
    const next = block[first + 1]
    const alignment = next !== undefined ? tableAlignment(next) : undefined
    if (alignment && tableCells(block[first]).length === alignment.length) return { settled: text, open: "" }
    return { settled: lines.slice(0, start + first).join("\n"), open: "" }
  }
  let held = text
  const trimmed = text.replace(/\s+$/, "")
  if (trimmed) {
    const cut = trimmed.lastIndexOf("\n")
    if (/^[ \t]*[-=]+[ \t]*$/.test(cut < 0 ? trimmed : trimmed.slice(cut + 1))) held = cut < 0 ? "" : trimmed.slice(0, cut)
  }
  const cut = held.lastIndexOf("\n")
  return cut < 0 ? { settled: "", open: held } : { settled: held.slice(0, cut + 1), open: held.slice(cut + 1) }
}

/**
 * A reply as top-level blocks, so a caller can keep the unchanged ones on
 * screen while the last streams in, and mount a component for a diagram.
 */
export function renderReply(source: string, options: MarkdownOptions = {}): ReplyBlock[] {
  const ctx: Context = { options, notes: new Map(), order: [] }
  // Control characters are what the renderer's own markers are made of, so the source may not carry any.
  let text = source.replace(/\r\n?/g, "\n").replace(/[\x00-]/g, "")
  if (options.math && needsMathRewrite(text)) text = normaliseMath(text)
  if (options.diagrams) text = wrapRawSvg(text, options.diagrams.streaming)
  let open = ""
  if (options.live) ({ settled: text, open } = splitLive(text))
  let lines = text.split("\n").map((line) => line.replace(/^\t+/, (tabs) => "    ".repeat(tabs.length)))
  if (options.links) {
    lines = takeFootnotes(lines, ctx.notes)
    // MiMo gives every reference a stand-in note while live, so it is a reference from the start rather than flipping when its note arrives.
    if (options.live) {
      for (const match of text.matchAll(/\[\^([^\]\s]+)\](?!:)/g)) {
        const key = match[1].toLowerCase()
        if (!ctx.notes.has(key)) ctx.notes.set(key, "-")
      }
    }
  }
  const blocks = parseBlocks(lines, ctx, true)
  // The notes wait for the end of the reply.
  if (ctx.order.length && !options.live) blocks.push({ kind: "html", html: footnotesHtml(ctx) })
  if (open) blocks.push({ kind: "html", html: '<div class="stream-open-line">' + escapeHtml(open) + "</div>" })
  return blocks
}

export function renderMarkdown(source: string, options: MarkdownOptions = {}): string {
  return renderReply(source, options)
    .map((block) => blockHtml(block, options))
    .join("\n")
}
