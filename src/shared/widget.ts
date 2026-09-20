/**
 * MiMo's inline interactive widget: a ```sci-widget fence whose body is one
 * self-contained HTML document, shown in the reply as a live card.
 *
 * The document is never given to the window as markup. It is handed to the
 * preview server, which answers one unguessable origin with it under a CSP that
 * allows nothing but its own inline script and styles - no network, no frames,
 * no forms - and the sandbox flag, so the frame has an opaque origin with no
 * storage, no cookies and no way to read the window that holds it or reach the
 * preload bridge. MiMo puts its document in a `srcdoc` frame with a meta CSP
 * instead; MCode cannot, because the window's own `script-src 'self'` is
 * inherited by a `srcdoc` (and by a `data:`) frame and would block every
 * widget's script. A served origin does not inherit it.
 *
 * The frame is as tall as what the widget drew. It cannot be asked - a frame
 * from another origin does not hand over its layout - so the document carries a
 * small reporter that posts its content height up, and `widgetHeight` turns
 * those reports into the height the card uses.
 *
 * This file is free of Electron and of the window, so the checks can run all of
 * it: the main process serves `widgetDocument`, the window applies
 * `widgetHeight`.
 */

/** The fence the model writes, and the language tag the renderer looks for. */
export const WIDGET_FENCE = "sci-widget"

/**
 * How long a widget's source may be. MiMo caps nothing here and asks the model
 * in its prompt to stay near 50KB; a cap an order of magnitude above that keeps
 * every real widget while a runaway block stays a code block rather than
 * becoming a document the main process has to hold.
 */
export const WIDGET_SOURCE_LIMIT = 512_000

/** The message a widget's reporter posts to the window that frames it. */
export const WIDGET_HEIGHT_MESSAGE = "mcode:widget-height"

/** The card's height before its widget has said anything. */
export const WIDGET_MIN_HEIGHT = 80
/** The height a widget that sized itself against the frame is given to lay out in. */
export const WIDGET_BASE_HEIGHT = 560
/** Of the window, how tall the card may grow. */
const CAP_SHARE = 0.85
/** Of the window, how tall a widget that will not measure itself is left. */
const LOCKED_SHARE = 0.7
/** Rounding and scrollbar slack, in pixels, when a report is compared with the frame it came from. */
const SLACK = 2

/**
 * What the served document may do: run and style itself, draw from data and
 * blob pictures and fonts it carries, and nothing else. No network of any kind
 * (`connect-src 'none'` covers fetch, XHR, websockets and beacons; `default-src
 * 'none'` covers everything not named), no frames, no form to post to, no base
 * to rewrite its relative addresses, and the sandbox flag on the response so the
 * document has an opaque origin even if its address is opened somewhere else.
 */
export const WIDGET_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts"

/** What the frame is allowed, on the element as well: scripts, and not one thing more. */
export const WIDGET_SANDBOX = "allow-scripts"

/**
 * A widget's last report: how tall its content is, and how tall the frame was
 * while it measured. The second is what says whether the first can be believed -
 * a widget laid out against the viewport measures the frame, not itself.
 */
export interface WidgetReport {
  content: number
  /** NaN when the widget's reporter could not read it. */
  viewport: number
}

/** The card's height, and whether it is still being negotiated. */
export interface WidgetSize {
  height: number
  /** True once a report has been believed; an unbelieved one no longer moves the card. */
  settled: boolean
  /** True when the widget only ever measured the frame, and the card was given a share of the window instead. */
  locked: boolean
}

export const WIDGET_START: WidgetSize = { height: WIDGET_MIN_HEIGHT, settled: false, locked: false }

/** How tall a card may grow in a window this tall. */
export function widgetCap(windowHeight: number): number {
  const window = Number.isFinite(windowHeight) && windowHeight > 0 ? windowHeight : WIDGET_BASE_HEIGHT
  return Math.max(WIDGET_BASE_HEIGHT, Math.round(window * CAP_SHARE))
}

/** The height a widget that will not measure itself is left at, in a window this tall. */
export function widgetLockedHeight(windowHeight: number, cap: number): number {
  const window = Number.isFinite(windowHeight) && windowHeight > 0 ? windowHeight : cap
  return Math.max(WIDGET_MIN_HEIGHT, Math.min(cap, Math.round(window * LOCKED_SHARE)))
}

/** The report in a message, or undefined when the message is not one. */
export function widgetReport(data: unknown): WidgetReport | undefined {
  if (!data || typeof data !== "object") return undefined
  const message = data as { type?: unknown; height?: unknown; viewport?: unknown }
  if (message.type !== WIDGET_HEIGHT_MESSAGE) return undefined
  if (typeof message.height !== "number" || !Number.isFinite(message.height)) return undefined
  const viewport = typeof message.viewport === "number" && Number.isFinite(message.viewport) ? message.viewport : Number.NaN
  return { content: message.height, viewport }
}

/**
 * Where a report leaves the card.
 *
 * A widget that laid itself out against the viewport reports the frame's own
 * height back, which would pin the card to whatever it happened to be - a
 * sliver, since the card starts short. So a report that differs from the frame
 * is the widget's own content and is believed; a report that matches it is not.
 * An unbelieved report at a short frame grows the frame to the cap once, to give
 * such a widget room to lay out; if it still matches at the cap, the widget has
 * nothing to say about its own height and the card takes a share of the window.
 *
 * That last state is final. Such a widget fills whatever frame it is given, so
 * the moment the card shrinks to its share it reports the cap it used to have -
 * a report that looks like real content, would grow the card back to the cap,
 * and would be answered by another one just like it. Measured in the window, it
 * ran forever at two frames a round. A locked card only moves when the window
 * does.
 */
export function widgetHeight(size: WidgetSize, report: WidgetReport, window: { cap: number; windowHeight: number }): WidgetSize {
  if (size.locked) return size
  const cap = Number.isFinite(window.cap) && window.cap > WIDGET_MIN_HEIGHT ? window.cap : WIDGET_BASE_HEIGHT
  const fit = (height: number) => Math.max(WIDGET_MIN_HEIGHT, Math.min(cap, Math.ceil(height)))
  const { content, viewport } = report
  if (!Number.isFinite(viewport) || viewport <= 0) return { height: fit(content), settled: true, locked: false }
  if (Math.abs(content - viewport) > SLACK) return { height: fit(content), settled: true, locked: false }
  if (viewport >= cap - SLACK) return { height: widgetLockedHeight(window.windowHeight, cap), settled: true, locked: true }
  if (size.settled) return { height: size.height, settled: true, locked: size.locked }
  return { height: cap, settled: false, locked: false }
}

/** Where a settled card lands when the window is resized under it. */
export function widgetResize(size: WidgetSize, content: number, windowHeight: number): WidgetSize {
  const cap = widgetCap(windowHeight)
  if (size.locked) return { ...size, height: widgetLockedHeight(windowHeight, cap) }
  return { ...size, height: Math.max(WIDGET_MIN_HEIGHT, Math.min(cap, Math.ceil(content))) }
}

/**
 * The reporter put at the end of every widget: it measures what the widget drew
 * and posts it up, whenever that changes.
 *
 * The measurement is the lowest edge anything in the body reaches, which is the
 * one number that survives a widget laid out with absolute positions or with
 * margins that collapse. Anything pinned to the viewport is left out of it - it
 * follows the frame rather than describing the content - and a document with
 * more elements than any card needs falls back to the body's own flow height
 * rather than walking all of them on every frame.
 *
 * It is its own script, after the widget's, so a widget whose script throws
 * still gets measured and still shows whatever markup it managed.
 */
function reporter(): string {
  return `<script>(function () {
  var TYPE = ${JSON.stringify(WIDGET_HEIGHT_MESSAGE)};
  var SCAN_LIMIT = 2000;
  var lastContent = -1, lastViewport = -1;
  function measure() {
    var view = Math.ceil(window.innerHeight || 0);
    var body = document.body;
    if (!body) return { content: 0, viewport: view };
    var style = getComputedStyle(body);
    var lowest = body.scrollHeight + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
    var nodes = body.getElementsByTagName("*");
    if (nodes.length <= SCAN_LIMIT) {
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        if (getComputedStyle(node).position === "fixed") continue;
        var edge = node.getBoundingClientRect().bottom;
        if (edge > lowest) lowest = edge;
      }
    }
    return { content: Math.ceil(lowest), viewport: view };
  }
  function report() {
    try {
      var size = measure();
      if (size.content === lastContent && size.viewport === lastViewport) return;
      lastContent = size.content;
      lastViewport = size.viewport;
      parent.postMessage({ type: TYPE, height: size.content, viewport: size.viewport }, "*");
    } catch (error) {}
  }
  var pending = false;
  function soon() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () { pending = false; report(); });
  }
  try {
    if (window.ResizeObserver) {
      var watch = new ResizeObserver(soon);
      watch.observe(document.documentElement);
      if (document.body) watch.observe(document.body);
    }
  } catch (error) {}
  window.addEventListener("load", report);
  window.addEventListener("resize", soon);
  setTimeout(report, 0);
  setTimeout(report, 250);
  setTimeout(report, 1000);
})();<\/script>`
}

/**
 * The window's reduced-motion setting, carried into the frame. The app's own
 * blanket rule cannot reach inside another document, so the same damping is
 * written into the widget instead.
 */
const DAMPING = `<style>*,*::before,*::after{animation-duration:0.01ms !important;animation-iteration-count:1 !important;transition-duration:0.01ms !important}</style>`

/** A page for a widget that carries no document of its own. */
const SHELL_HEAD = `<meta charset="utf-8"><meta name="color-scheme" content="light"><style>html,body{margin:0;padding:0}body{font:14px/1.5 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#111;background:#fff}img,canvas,svg{max-width:100%}</style>`

export interface WidgetDocumentOptions {
  /** True while the app is damping motion, so the widget damps its own too. */
  reduceMotion?: boolean
}

/**
 * The document the preview server answers with: what the model wrote, with the
 * reporter (and, when the app is damping motion, the damping) after it.
 *
 * A widget that brought its own page keeps it - only the tail is added, so its
 * own head, styles and language stay as written. One that is a fragment gets a
 * plain white page around it, which is also why the card is white in either
 * theme: the widget draws its own colours and cannot be asked to have two.
 */
export function widgetDocument(html: string, options: WidgetDocumentOptions = {}): string {
  const source = (html || "").trim()
  const tail = (options.reduceMotion ? DAMPING : "") + reporter()
  const body = source.search(/<\/body\s*>/i)
  if (body >= 0) return source.slice(0, body) + tail + source.slice(body)
  const page = source.search(/<\/html\s*>/i)
  if (page >= 0) return source.slice(0, page) + tail + source.slice(page)
  return `<!doctype html><html><head>${SHELL_HEAD}</head><body>${source}${tail}</body></html>`
}
