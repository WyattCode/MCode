import { createHash, randomBytes } from "node:crypto"
import { createReadStream, statSync } from "node:fs"
import fs from "node:fs/promises"
import http from "node:http"
import path from "node:path"
import { isBlockedPort } from "@shared/blocked-ports"
import { WIDGET_CSP, WIDGET_SOURCE_LIMIT, widgetDocument } from "@shared/widget"

/*
 * MiMo's page preview server: one loopback-only HTTP server for the app,
 * handing out a folder under a token so a web page shows in the right panel
 * with its own scripts, styles and pictures beside it. Asked with the edit
 * nonce, an .html page gets the edit agent - a small script that outlines the
 * module under the pointer, lets a click or a dragged box pick one, and posts
 * what was picked to the window. Nothing else is ever changed.
 *
 * MCode's tokens are random rather than MiMo's d1, d2, so another program on
 * the machine cannot guess a served folder. Unlike MiMo's /d1/ paths, the token
 * is the host name, so each folder is its own origin and one served page
 * cannot read another's files or storage.
 */

/* Documents and pages, plus the pictures, videos and sounds a reply shows inline by their path. */
const SERVED = new Set([
  ".xlsx", ".docx", ".pptx", ".pdf", ".html", ".htm",
  ".mp4", ".m4v", ".webm", ".mov", ".ogv",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".avif", ".svg",
  ".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac",
])
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/mp4",
  ".ogv": "video/ogg",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".pdf": "application/pdf",
}

export const PREVIEW_TOKEN_TTL_MS = 60 * 60 * 1000

export const PREVIEW_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'"

/*
 * Files a preview page may reasonably ask for beside its entry document.
 * Anything else in the folder is treated as private, even if it shares the
 * token origin.
 */
const SIDECAR_EXTENSIONS = new Set([
  ".css", ".js", ".mjs", ".map",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".avif", ".svg",
  ".woff", ".woff2", ".ttf", ".otf",
  ".mp4", ".webm", ".mov", ".m4v", ".ogv",
  ".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac",
])

interface PreviewToken {
  dir: string
  createdAt: number
  /** Basenames opened via servePreview for this folder token (multiple tabs). */
  entries: Set<string>
}

let port = 0
let starting: Promise<number> | undefined
const tokenOfDir = new Map<string, string>()
const dirOfToken = new Map<string, PreviewToken>()

/*
 * A reply's interactive widgets, by the token that is their origin. They are
 * documents the model wrote, never files, so they are held here rather than put
 * on disk. The oldest goes when the room runs out: a conversation scrolled far
 * enough that a card is gone no longer needs its document, and a card still on
 * screen asks for its own again whenever it is drawn.
 */
const WIDGETS_HELD = 64
const widgetOfToken = new Map<string, string>()
/** The path a widget's origin answers on; anything else on it is a 404. */
const WIDGET_PATH = "/widget.html"

function sweepExpiredTokens(now = Date.now()): void {
  for (const [token, meta] of dirOfToken) {
    if (now - meta.createdAt > PREVIEW_TOKEN_TTL_MS) {
      dirOfToken.delete(token)
      if (tokenOfDir.get(meta.dir) === token) tokenOfDir.delete(meta.dir)
    }
  }
}

/** Test helper: make every folder token expired without changing production behaviour. */
export function expirePreviewTokensForTest(): void {
  for (const meta of dirOfToken.values()) meta.createdAt = 0
}

function previewCsp(request: http.IncomingMessage): string {
  /*
   * frame-ancestors 'none' is the right rule for a page that should never be
   * framed, but the preview itself is framed by the app. Chromium cannot tell
   * the app's iframe from another site's iframe by origin here, so when the
   * request is being framed we drop only that one directive and keep the rest
   * of the policy, including connect-src 'none'.
   */
  if (String(request.headers["sec-fetch-dest"] ?? "").toLowerCase() === "iframe") {
    return PREVIEW_CSP.replace(/;\s*frame-ancestors 'none'/, "")
  }
  return PREVIEW_CSP
}

/** The script put into a served page in edit mode; the nonce ties its messages to one view. */
function agentSource(nonce: string): string {
  return `(function () {
  var NONCE = ${JSON.stringify(nonce)};
  var on = false, hover = null, picked = null, box = null, drag = null;
  var MEDIA = "img,video,picture,button,a,input,textarea,select,label,svg";
  var BLOCKS = "p,h1,h2,h3,h4,h5,h6,li,tr,td,th,img,button,a,figure,blockquote,pre,table,ul,ol,form,section,article,header,footer,main,aside,nav,div";
  function post(message) { message.__mcodeEdit = NONCE; try { parent.postMessage(message, "*"); } catch (e) {} }
  var style = document.createElement("style");
  style.textContent = ".mcode-ed-hover{outline:2px dashed #6b7cff!important;outline-offset:1px!important;cursor:pointer!important}" +
    ".mcode-ed-sel{outline:2px solid #4f46e5!important;outline-offset:1px!important}" +
    "#__mcodeEditBox{position:fixed;border:1.5px dashed #4f46e5;background:rgba(79,70,229,.10);z-index:2147483647;pointer-events:none}";
  (document.head || document.documentElement).appendChild(style);
  function invisible(el) {
    for (var node = el; node && node.nodeType === 1; node = node.parentElement) {
      var cs = getComputedStyle(node);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse" || cs.opacity === "0") return true;
    }
    return false;
  }
  function hitTest(x, y) {
    var body = document.body;
    if (!body) return null;
    var all = body.getElementsByTagName("*");
    if (all.length > 8000) return document.elementFromPoint(x, y);
    var best = null, area = Infinity;
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.id === "__mcodeEditBox") continue;
      var r = el.getBoundingClientRect();
      if (!r.width || !r.height || x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      var size = r.width * r.height;
      if (size >= area || invisible(el)) continue;
      best = el; area = size;
    }
    return best || document.elementFromPoint(x, y);
  }
  function meaningful(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.tagName.toLowerCase();
    if (tag === "html" || tag === "body" || tag === "canvas") return false;
    if (el.matches(MEDIA)) return true;
    for (var child = el.firstChild; child; child = child.nextSibling) if (child.nodeType === 3 && /\\S/.test(child.nodeValue)) return true;
    var r = el.getBoundingClientRect();
    if (r.width * r.height >= innerWidth * innerHeight * 0.5) return false;
    return /\\S/.test(el.textContent || "") || Boolean(el.querySelector(MEDIA));
  }
  function moduleOf(el) { return el.closest(BLOCKS) || el; }
  function textOf(el) { return String(el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 200); }
  function selectorOf(el) {
    if (el.id) return "#" + CSS.escape(el.id);
    var parts = [];
    for (var node = el, depth = 0; node && node !== document.body && depth < 5; node = node.parentElement, depth++) {
      if (node.id) { parts.unshift("#" + CSS.escape(node.id)); break; }
      var tag = node.tagName.toLowerCase(), parent = node.parentElement, part = tag;
      if (parent) {
        var same = [];
        for (var i = 0; i < parent.children.length; i++) if (parent.children[i].tagName === node.tagName) same.push(parent.children[i]);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
    }
    return parts.join(" > ") || el.tagName.toLowerCase();
  }
  function unhover() { if (hover) hover.classList.remove("mcode-ed-hover"); hover = null; }
  function unpick() { if (picked) picked.classList.remove("mcode-ed-sel"); picked = null; }
  function unbox() { if (box) box.remove(); box = null; }
  function send(el, rect, kind) {
    post({ type: "select", selector: selectorOf(el), tag: el.tagName.toLowerCase(), text: textOf(el), rect: rect, kind: kind });
  }
  document.addEventListener("mousemove", function (event) {
    if (!on) return;
    if (drag) {
      var dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) <= 4 && Math.abs(dy) <= 4) return;
      drag.moved = true;
      unhover();
      if (!box) { box = document.createElement("div"); box.id = "__mcodeEditBox"; document.body.appendChild(box); }
      box.style.left = Math.min(drag.x, event.clientX) + "px";
      box.style.top = Math.min(drag.y, event.clientY) + "px";
      box.style.width = Math.abs(dx) + "px";
      box.style.height = Math.abs(dy) + "px";
      return;
    }
    var hit = hitTest(event.clientX, event.clientY);
    var next = meaningful(hit) ? moduleOf(hit) : null;
    if (next === hover) return;
    unhover();
    if (next && next !== picked) { next.classList.add("mcode-ed-hover"); hover = next; }
  }, true);
  document.addEventListener("mousedown", function (event) {
    if (!on) return;
    event.preventDefault();
    // preventDefault keeps the page's own focus still, so the frame is focused by hand; the window only accepts a pick from a focused frame.
    try { window.focus(); } catch (e) {}
    unpick();
    unbox();
    post({ type: "clear" });
    drag = { x: event.clientX, y: event.clientY, moved: false };
  }, true);
  document.addEventListener("mouseup", function (event) {
    if (!on || !drag) return;
    var gesture = drag;
    drag = null;
    if (gesture.moved) {
      var left = Math.min(gesture.x, event.clientX), top = Math.min(gesture.y, event.clientY);
      var right = Math.max(gesture.x, event.clientX), bottom = Math.max(gesture.y, event.clientY);
      var start = hitTest((left + right) / 2, (top + bottom) / 2) || document.body;
      var cover = start;
      for (var node = start; node && node !== document.body; node = node.parentElement) {
        var r = node.getBoundingClientRect();
        if (r.left <= left + 1 && r.top <= top + 1 && r.right >= right - 1 && r.bottom >= bottom - 1) { cover = node; break; }
      }
      if (box) box.style.borderStyle = "solid";
      send(cover, { left: left, top: top, right: right, bottom: bottom, width: right - left, height: bottom - top }, "box");
      return;
    }
    unbox();
    var hit = hitTest(event.clientX, event.clientY);
    if (!meaningful(hit)) return;
    var module = moduleOf(hit);
    unhover();
    module.classList.add("mcode-ed-sel");
    picked = module;
    send(module, { left: event.clientX, top: event.clientY, right: event.clientX, bottom: event.clientY, width: 0, height: 0 }, "click");
  }, true);
  document.addEventListener("click", function (event) {
    if (!on) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.__mcodeEdit !== NONCE) return;
    if (data.type === "editMode") {
      on = Boolean(data.on);
      if (!on) { unhover(); unpick(); unbox(); drag = null; }
    } else if (data.type === "clearSel") { unpick(); unbox(); }
  });
  post({ type: "ready" });
})();`
}

async function handle(request: http.IncomingMessage, response: http.ServerResponse) {
  const fail = (code: number, text: string) => {
    response.writeHead(code, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" })
    response.end(text)
  }
  // Each folder is its own origin, <token>.localhost:<port>; any other Host (a bare address, a rebound name) is refused.
  const host = /^([0-9a-f]{24})\.localhost:(\d+)$/.exec((request.headers.host ?? "").toLowerCase())
  const token = host && Number(host[2]) === port ? host[1] : undefined
  if (token) sweepExpiredTokens()
  /*
   * A widget's origin holds one document and nothing else, under the policy
   * that lets it run itself and reach nothing: no network, no frames, no form,
   * and sandboxed, so opening its address anywhere else is no different.
   */
  const widget = token ? widgetOfToken.get(token) : undefined
  if (widget !== undefined) {
    if ((request.url ?? "/").split("?")[0] !== WIDGET_PATH) return fail(404, "not found")
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": WIDGET_CSP })
    response.end(request.method === "HEAD" ? undefined : widget)
    return
  }
  const meta = token ? dirOfToken.get(token) : undefined
  if (!meta) return fail(404, "not found")
  if (Date.now() - meta.createdAt > PREVIEW_TOKEN_TTL_MS) {
    if (token) {
      dirOfToken.delete(token)
      if (tokenOfDir.get(meta.dir) === token) tokenOfDir.delete(meta.dir)
    }
    return fail(404, "not found")
  }
  const dir = meta.dir
  let url: URL
  try {
    url = new URL(request.url ?? "/", "http://localhost")
  } catch {
    return fail(400, "bad request")
  }
  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return fail(404, "not found")
  }
  const parts = pathname.split(/[\\/]+/).filter(Boolean)
  // Dotfiles and dot folders (.git, .env) are never handed out; this also catches "." and "..".
  if (parts.some((part) => part.startsWith("."))) return fail(404, "not found")
  const target = path.resolve(dir, parts.join("/"))
  // A relative path, not a prefix test: a folder at a drive root ends in its separator already.
  const relative = path.relative(dir, target)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return fail(403, "forbidden")
  // And by where it really leads: a junction in the served folder is not a way out of it.
  const realDir = await fs.realpath(dir).catch(() => dir)
  const realTarget = await fs.realpath(target).catch(() => undefined)
  if (realTarget) {
    const real = path.relative(realDir, realTarget)
    if (real === ".." || real.startsWith(`..${path.sep}`) || path.isAbsolute(real)) return fail(403, "forbidden")
  }
  /*
   * A folder token is not a licence to read the folder. The opened entry is
   * allowed, and only sidecar assets beside it are allowed; secrets, documents,
   * sibling pages and anything else are hidden as if they were not there.
   */
  if (!meta.entries.has(relative)) {
    const sidecarExtension = path.extname(target).toLowerCase()
    if (!SIDECAR_EXTENSIONS.has(sidecarExtension)) return fail(404, "not found")
  }
  const extension = path.extname(target).toLowerCase()
  const type = TYPES[extension] ?? "application/octet-stream"
  const nonce = url.searchParams.get("__mcodeedit")
  if ((extension === ".html" || extension === ".htm") && nonce && /^[\w-]{1,64}$/.test(nonce)) {
    let html: string
    try {
      html = await fs.readFile(target, "utf8")
    } catch {
      return fail(404, "not found")
    }
    const script = `<script data-mcode-edit-agent>${agentSource(nonce)}</script>`
    const at = html.search(/<\/body>/i)
    response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", "Content-Security-Policy": previewCsp(request) })
    response.end(at >= 0 ? `${html.slice(0, at)}${script}${html.slice(at)}` : `${html}${script}`)
    return
  }
  let size: number
  try {
    const stat = await fs.stat(target)
    if (!stat.isFile()) return fail(404, "not found")
    size = stat.size
  } catch {
    return fail(404, "not found")
  }
  // A video seeks by asking for byte ranges, so those are answered as ranges rather than the whole file each time.
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "")
  /*
   * A reply's SVG file card reads the file's text as well as drawing it, and
   * the PDF view asks pdf.js to read the document here rather than taking its
   * bytes over IPC, which is what lets a document past the 25MB IPC limit open
   * at all. Both read from the window, whose page is a `file:` one, so the read
   * is cross-origin and needs saying so; every other kind of file stays
   * display-only to other origins.
   */
  const common = {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Accept-Ranges": "bytes",
    ...(extension === ".html" || extension === ".htm" ? { "Content-Security-Policy": previewCsp(request) } : {}),
    ...(extension === ".svg" || extension === ".pdf"
      ? // Without the second header a cross-origin reader cannot see the range headers, and pdf.js would pull whole files.
        { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Accept-Ranges, Content-Range, Content-Length" }
      : {}),
  }
  let start = 0
  let end = size - 1
  if (range && (range[1] || range[2])) {
    start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
    end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
    if (start >= size || start > end) {
      response.writeHead(416, { ...common, "Content-Range": `bytes */${size}` })
      response.end()
      return
    }
    response.writeHead(206, { ...common, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${size}` })
  } else {
    response.writeHead(200, { ...common, "Content-Length": String(size) })
  }
  if (request.method === "HEAD" || size === 0) {
    response.end()
    return
  }
  createReadStream(target, { start, end })
    .on("error", () => response.destroy())
    .pipe(response)
}

function serve(request: http.IncomingMessage, response: http.ServerResponse) {
  /*
   * On every answer: a served page that loads anything from elsewhere must not
   * hand over its own address - the token in it is the folder's origin - and
   * no file is taken for a type other than the one it is served as.
   */
  response.setHeader("Referrer-Policy", "no-referrer")
  response.setHeader("X-Content-Type-Options", "nosniff")
  handle(request, response).catch(() => {
    // A request that failed half way must still end, or the socket hangs open.
    if (!response.headersSent) {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" })
      response.end("error")
    } else response.destroy()
  })
}

function listen(server: http.Server, at: number, address: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => reject(error)
    server.once("error", failed)
    server.listen(at, address, () => {
      server.off("error", failed)
      const bound = server.address()
      resolve(typeof bound === "object" && bound ? bound.port : 0)
    })
  })
}

const closed = (server: http.Server) => new Promise<void>((resolve) => server.close(() => resolve()))

/*
 * Chromium resolves <token>.localhost to both loopbacks and tries ::1 first, so
 * the same port is taken on ::1 too. A port some other program already holds
 * on ::1 would get those requests, so that port is given up and another tried;
 * a machine with no IPv6 at all keeps 127.0.0.1 alone.
 */
async function bind(): Promise<number> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const v4 = http.createServer(serve)
    let at: number
    try {
      at = await listen(v4, 0, "127.0.0.1")
    } catch {
      return 0
    }
    // A port the page would be refused on is given back and another taken (blocked-ports.ts).
    if (isBlockedPort(at)) {
      await closed(v4)
      continue
    }
    const v6 = http.createServer(serve)
    try {
      await listen(v6, at, "::1")
      v6.unref()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
        await closed(v4)
        continue
      }
    }
    v4.unref()
    return at
  }
  return 0
}

function start(): Promise<number> {
  if (port) return Promise.resolve(port)
  starting ??= bind().then((at) => {
    port = at
    return at
  })
  return starting
}

export async function servePreview(file: string): Promise<{ ok: true; url: string } | { ok: false; error: "missing" | "serverFailed" }> {
  const absolute = typeof file === "string" ? path.resolve(file) : ""
  let isFile = false
  try {
    isFile = Boolean(absolute) && statSync(absolute).isFile()
  } catch {
    isFile = false
  }
  if (!isFile || !SERVED.has(path.extname(absolute).toLowerCase())) return { ok: false, error: "missing" }
  const listening = await start()
  if (!listening) {
    starting = undefined
    return { ok: false, error: "serverFailed" }
  }
  const dir = path.dirname(absolute)
  const entryName = path.basename(absolute)
  const now = Date.now()
  sweepExpiredTokens(now)
  let token = tokenOfDir.get(dir)
  let meta = token ? dirOfToken.get(token) : undefined
  if (!meta || now - meta.createdAt > PREVIEW_TOKEN_TTL_MS) {
    if (token) {
      dirOfToken.delete(token)
      if (tokenOfDir.get(meta?.dir ?? dir) === token) tokenOfDir.delete(meta?.dir ?? dir)
    }
    token = randomBytes(12).toString("hex")
    meta = { dir, createdAt: now, entries: new Set([entryName]) }
    tokenOfDir.set(dir, token)
    dirOfToken.set(token, meta)
  } else {
    meta.createdAt = now
    meta.entries.add(entryName)
  }
  return { ok: true, url: `http://${token}.localhost:${listening}/${encodeURIComponent(entryName)}` }
}

/* Salted, so the same widget keeps one address while the app runs and no other program can work out what it is. */
const widgetSalt = randomBytes(16)

/**
 * An address for one interactive widget from a reply.
 *
 * The same source asks for the same address, so a card that is redrawn - a
 * theme change, a scroll that took it out of the list and back - keeps its
 * frame instead of reloading and losing whatever the user had set in it.
 */
export async function serveWidget(html: unknown, reduceMotion: unknown): Promise<{ ok: true; url: string } | { ok: false; error: "missing" | "serverFailed" }> {
  if (typeof html !== "string" || !html.trim() || html.length > WIDGET_SOURCE_LIMIT) return { ok: false, error: "missing" }
  const listening = await start()
  if (!listening) {
    starting = undefined
    return { ok: false, error: "serverFailed" }
  }
  const damped = reduceMotion === true
  const token = createHash("sha256").update(widgetSalt).update(damped ? "1" : "0").update(html).digest("hex").slice(0, 24)
  // Asking again moves it back to the end of the line, so the widgets still on screen are the ones that are kept.
  widgetOfToken.delete(token)
  widgetOfToken.set(token, widgetDocument(html, { reduceMotion: damped }))
  for (const oldest of widgetOfToken.keys()) {
    if (widgetOfToken.size <= WIDGETS_HELD) break
    widgetOfToken.delete(oldest)
  }
  return { ok: true, url: `http://${token}.localhost:${listening}${WIDGET_PATH}` }
}
