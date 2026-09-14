import { randomBytes } from "node:crypto"
import { statSync } from "node:fs"
import fs from "node:fs/promises"
import http from "node:http"
import path from "node:path"

/*
 * MiMo's page preview server: one loopback-only HTTP server for the app,
 * handing out a folder under a token so a web page shows in the right panel
 * with its own scripts, styles and pictures beside it. Asked with the edit
 * nonce, an .html page gets the edit agent - a small script that outlines the
 * module under the pointer, lets a click or a dragged box pick one, and posts
 * what was picked to the window. Nothing else is ever changed.
 *
 * MCode's tokens are random rather than MiMo's d1, d2, so another program on
 * the machine cannot guess a served folder.
 */

const SERVED = new Set([".xlsx", ".docx", ".pptx", ".pdf", ".html", ".htm"])
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
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".pdf": "application/pdf",
}

let port = 0
let starting: Promise<number> | undefined
const tokenOfDir = new Map<string, string>()
const dirOfToken = new Map<string, string>()

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
  const url = new URL(request.url ?? "/", "http://127.0.0.1")
  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return fail(404, "not found")
  }
  const parts = pathname.replace(/^\/+/, "").split("/")
  const dir = dirOfToken.get(parts.shift() ?? "")
  if (!dir) return fail(404, "not found")
  const target = path.resolve(dir, parts.join("/"))
  if (target !== dir && !target.startsWith(dir + path.sep)) return fail(403, "forbidden")
  let body: Buffer
  try {
    body = await fs.readFile(target)
  } catch {
    return fail(404, "not found")
  }
  const extension = path.extname(target).toLowerCase()
  const nonce = url.searchParams.get("__mcodeedit")
  if ((extension === ".html" || extension === ".htm") && nonce && /^[\w-]{1,64}$/.test(nonce)) {
    const html = body.toString("utf8")
    const script = `<script data-mcode-edit-agent>${agentSource(nonce)}</script>`
    const at = html.search(/<\/body>/i)
    body = Buffer.from(at >= 0 ? `${html.slice(0, at)}${script}${html.slice(at)}` : `${html}${script}`, "utf8")
  }
  response.writeHead(200, { "Content-Type": TYPES[extension] ?? "application/octet-stream", "Cache-Control": "no-store" })
  response.end(body)
}

function start(): Promise<number> {
  if (port) return Promise.resolve(port)
  starting ??= new Promise<number>((resolve) => {
    const server = http.createServer((request, response) => void handle(request, response))
    server.on("error", () => resolve(0))
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      port = typeof address === "object" && address ? address.port : 0
      server.unref()
      resolve(port)
    })
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
  let token = tokenOfDir.get(dir)
  if (!token) {
    token = randomBytes(12).toString("hex")
    tokenOfDir.set(dir, token)
    dirOfToken.set(token, dir)
  }
  return { ok: true, url: `http://127.0.0.1:${listening}/${token}/${encodeURIComponent(path.basename(absolute))}` }
}
