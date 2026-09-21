/**
 * Round 16 (lane E): the inline interactive widget.
 *
 * A reply can carry a ```sci-widget fence whose body is one self-contained HTML
 * document, shown live in the conversation. The thing worth checking is not
 * that it draws - a screenshot says that - but that it is boxed in: the document
 * leaves the renderer as a block rather than as markup, it is answered on an
 * origin of its own under a policy that gives it no network, no frames and no
 * form, and the frame that holds it is sandboxed without `allow-same-origin`, so
 * it has no storage and no way back into the window or its preload bridge.
 *
 * The rest is the card's height, which cannot be read from another origin and so
 * is negotiated by message: the cases below are the awkward ones - a widget that
 * measured the frame instead of itself, one that will not measure at all, and a
 * window resized under a settled card.
 *
 * Kept apart from smoke.ts the way the earlier rounds are; smoke.ts calls
 * `roundSixteenWidgetChecks` with its own check and section.
 */
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Check } from "./smoke-round5"
import { renderMarkdown, renderReply, type MarkdownOptions } from "../src/renderer/src/lib/markdown"
import { serveWidget } from "../src/main/preview-server"
import { OFFICE_SCHEMAS } from "../src/main/office-guard"
import {
  WIDGET_BASE_HEIGHT,
  WIDGET_CSP,
  WIDGET_FENCE,
  WIDGET_MIN_HEIGHT,
  WIDGET_SANDBOX,
  WIDGET_SOURCE_LIMIT,
  WIDGET_START,
  widgetCap,
  widgetDocument,
  widgetHeight,
  widgetLockedHeight,
  widgetReport,
  widgetResize,
} from "../src/shared/widget"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8")

/* A finished reply, with everything the conversation renders. */
const REPLY: MarkdownOptions = {
  codeActions: { copy: "Copy", copied: "Copied", label: "Copy code" },
  tableActions: { label: "Table", preview: "Preview", copy: "Copy table" },
  math: true,
  links: { imageTip: "Preview" },
  paths: { tip: "Open" },
  diagrams: { streaming: false },
  lineNumbers: true,
}
const STREAMING: MarkdownOptions = { ...REPLY, diagrams: { streaming: true } }
/* The same reply as the conversation actually renders it mid-stream: the last line is also held back as plain text. */
const LIVE: MarkdownOptions = { ...STREAMING, live: true }

const SOURCE = '<div id="d">hi</div>\n<script>document.title = "x"</script>'
const FENCE = "```" + WIDGET_FENCE + "\n" + SOURCE + "\n```"

/** One request to the preview server, by Host rather than by name, so the Host check is what is exercised. */
function ask(url: string, method = "GET"): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const target = new URL(url)
  return new Promise((done, fail) => {
    const request = http.request(
      { host: "127.0.0.1", port: Number(target.port), path: target.pathname + target.search, method, headers: { host: target.host } },
      (response) => {
        let body = ""
        response.setEncoding("utf8")
        response.on("data", (chunk) => (body += chunk))
        response.on("end", () => done({ status: response.statusCode ?? 0, headers: response.headers, body }))
      },
    )
    request.on("error", fail)
    request.end()
  })
}

export async function roundSixteenWidgetChecks(check: Check, section: (name: string) => void): Promise<void> {
  // ------------------------------------------------------------ the fence
  section("Round 16 (E): the interactive widget's fence")
  {
    const kinds = (source: string, options: MarkdownOptions) =>
      renderReply(source, options)
        .map((block) => block.kind)
        .join(" ")
    check("a sci-widget fence becomes a widget block", kinds(FENCE, REPLY) === "widget")
    check("the language tag is read without regard to case", kinds(FENCE.replace(WIDGET_FENCE, "Sci-Widget"), REPLY) === "widget")
    check("a widget still arriving is a line saying so, not a half-written frame", kinds(FENCE, STREAMING) === "widget-loading")
    check("and the same when the reply is rendered live", kinds(FENCE, LIVE).startsWith("widget-loading"))
    check("a widget arriving mid-reply leaves the text before it alone", kinds("before\n\n" + FENCE, STREAMING) === "html widget-loading")
    check("a fence that was never closed stays code", kinds("```" + WIDGET_FENCE + "\n<div>half", REPLY) === "html")
    check("a widget nested in a list stays code", kinds("- a\n\n  ```" + WIDGET_FENCE + "\n  <div>x</div>\n  ```", REPLY) === "html")
    const huge = "```" + WIDGET_FENCE + "\n<div>" + "x".repeat(WIDGET_SOURCE_LIMIT) + "</div>\n```"
    check("a widget past the cap stays code", kinds(huge, REPLY) === "html")
    const markup = renderMarkdown(FENCE, REPLY)
    check("the document never reaches the page as markup", !/<script|<div id="d"/.test(markup) && markup.includes("&lt;script&gt;"))
    const both = renderReply("before\n\n" + FENCE + "\n\nafter", REPLY)
    check("a widget mid-reply leaves the text around it alone", both.map((block) => block.kind).join(" ") === "html widget html")
  }

  // ------------------------------------------------------------ the document
  section("Round 16 (E): what the widget is served")
  {
    const fragment = widgetDocument(SOURCE)
    check("a fragment is given a page of its own", fragment.startsWith("<!doctype html>") && fragment.includes('charset="utf-8"'))
    check("the widget's own script is kept as written", fragment.includes('document.title = "x"'))
    check("the reporter is added after the widget, so a widget that throws is still measured", fragment.lastIndexOf("<script>(function") > fragment.indexOf("document.title"))
    check("the reporter is inside the page", fragment.indexOf("<script>(function") < fragment.indexOf("</body>"))
    check("nothing damps motion unless the app is damping it", !fragment.includes("animation-iteration-count"))
    check("the app's reduced motion is carried into the frame", widgetDocument(SOURCE, { reduceMotion: true }).includes("animation-iteration-count:1 !important"))

    const page = widgetDocument('<!doctype html><html><head><title>mine</title></head><body><p>a</p></body></html>')
    check("a widget that brought its own page keeps its head", page.includes("<title>mine</title>") && !page.includes('name="color-scheme"'))
    check("and the reporter goes before its own </body>", page.indexOf("<script>(function") < page.indexOf("</body>"))
    const noBody = widgetDocument("<html><p>a</p></html>")
    check("a page with no </body> is closed at its </html>", noBody.indexOf("<script>(function") < noBody.indexOf("</html>"))

    check("the policy allows no default", WIDGET_CSP.includes("default-src 'none'"))
    check("the policy allows no network", WIDGET_CSP.includes("connect-src 'none'"))
    check("the policy allows no form to post to", WIDGET_CSP.includes("form-action 'none'"))
    check("the policy allows no base to rewrite addresses", WIDGET_CSP.includes("base-uri 'none'"))
    check("the policy sandboxes the document itself", WIDGET_CSP.includes("sandbox allow-scripts"))
    check("the policy names no http or https source", !/https?:/.test(WIDGET_CSP))
    check("the policy lets it run and style itself", WIDGET_CSP.includes("script-src 'unsafe-inline'") && WIDGET_CSP.includes("style-src 'unsafe-inline'"))
  }

  // ------------------------------------------------------------ the origin
  section("Round 16 (E): the widget's origin")
  {
    const served = await serveWidget(SOURCE, false)
    check("a widget is given an address", served.ok === true)
    if (served.ok) {
      const token = new URL(served.url).hostname.split(".")[0]
      check("its host is a token of its own, not a folder's", /^[0-9a-f]{24}$/.test(token) && new URL(served.url).hostname.endsWith(".localhost"))
      const answer = await ask(served.url)
      check("the document is answered", answer.status === 200 && answer.body.includes('document.title = "x"'))
      check("under the widget policy", answer.headers["content-security-policy"] === WIDGET_CSP)
      check("as html, and never cached", answer.headers["content-type"] === "text/html; charset=utf-8" && answer.headers["cache-control"] === "no-store")
      check("with no address of its own handed on", answer.headers["referrer-policy"] === "no-referrer")
      const elsewhere = await ask(new URL("/other.html", served.url).href)
      check("nothing else lives on that origin", elsewhere.status === 404)
      const parent = await ask(new URL("/../../index.html", served.url).href)
      check("and nothing above it either", parent.status === 404)
      const strange = await ask(served.url.replace(token, "0".repeat(24)))
      check("a token nobody handed out is not an origin", strange.status === 404)

      const again = await serveWidget(SOURCE, false)
      check("the same widget keeps its address, so a redrawn card keeps its frame", again.ok && again.url === served.url)
      const damped = await serveWidget(SOURCE, true)
      check("the damped one is a different document at a different address", damped.ok && damped.url !== served.url)
      if (damped.ok) check("and it carries the damping", (await ask(damped.url)).body.includes("animation-iteration-count"))
    }

    check("an empty widget is refused", (await serveWidget("   ", false)).ok === false)
    check("a widget past the cap is refused", (await serveWidget("x".repeat(WIDGET_SOURCE_LIMIT + 1), false)).ok === false)
    check("anything that is not a document is refused", (await serveWidget({ toString: () => "<p>a</p>" }, false)).ok === false)

    /* The oldest go when the room runs out, and the newest is always there. */
    const first = await serveWidget("<p>first</p>", false)
    for (let n = 0; n < 80; n += 1) await serveWidget(`<p>filler ${n}</p>`, false)
    const last = await serveWidget("<p>last</p>", false)
    check("a widget long scrolled away is let go", first.ok && (await ask(first.url)).status === 404)
    check("while the newest is still there", last.ok && (await ask(last.url)).status === 200)
  }

  // ------------------------------------------------------------ the height
  section("Round 16 (E): how tall the card gets")
  {
    const window = { cap: widgetCap(1000), windowHeight: 1000 }
    check("the cap is a share of the window, never below the base", widgetCap(1000) === 850 && widgetCap(300) === WIDGET_BASE_HEIGHT)
    check("a card starts short", WIDGET_START.height === WIDGET_MIN_HEIGHT && !WIDGET_START.settled)

    const drew = widgetHeight(WIDGET_START, { content: 420, viewport: WIDGET_MIN_HEIGHT }, window)
    check("a widget that measured itself is believed", drew.height === 420 && drew.settled && !drew.locked)
    const tall = widgetHeight(WIDGET_START, { content: 4000, viewport: WIDGET_MIN_HEIGHT }, window)
    check("a widget taller than the window is held to the cap", tall.height === window.cap)
    const blind = widgetHeight(WIDGET_START, { content: 300, viewport: Number.NaN }, window)
    check("a widget whose frame could not be read is believed anyway", blind.height === 300 && blind.settled)

    /* A widget laid out against the viewport reports the frame back: grow it once, then stop believing it. */
    const circular = widgetHeight(WIDGET_START, { content: WIDGET_MIN_HEIGHT, viewport: WIDGET_MIN_HEIGHT }, window)
    check("a widget that only measured the frame is given room instead", circular.height === window.cap && !circular.settled)
    const stillCircular = widgetHeight(circular, { content: window.cap, viewport: window.cap }, window)
    check("and one that measures the frame at the cap too takes a share of the window", stillCircular.locked && stillCircular.height === widgetLockedHeight(1000, window.cap))
    check("that share is below the cap and above the floor", stillCircular.height === 700)
    const settled = widgetHeight(drew, { content: 300, viewport: 300 }, window)
    check("a settled card is not moved by an unbelievable report", settled.height === drew.height)
    /*
     * The loop this guards, seen in the window before it was: shrunk to its
     * share, the widget reports the cap it used to fill, which reads as real
     * content and grows the card back to the cap, where it reports the cap
     * again - twice a round, for ever.
     */
    const afterShrink = widgetHeight(stillCircular, { content: window.cap + 1, viewport: stillCircular.height }, window)
    check("a locked card is not grown back by the height it used to have", afterShrink.height === stillCircular.height && afterShrink.locked)

    check("a resized window moves a measured card under the new cap", widgetResize(drew, 4000, 400).height === widgetCap(400))
    check("and moves a locked card to the new share", widgetResize(stillCircular, 0, 600).height === widgetLockedHeight(600, widgetCap(600)))

    check("a message of another kind is not a report", widgetReport({ type: "something-else", height: 10 }) === undefined)
    check("a report with no number is not a report", widgetReport({ type: "mcode:widget-height", height: "10" }) === undefined)
    check("a report with an unreadable frame still reads", Number.isNaN(widgetReport({ type: "mcode:widget-height", height: 10 })?.viewport))
  }

  // ------------------------------------------------------------ the wiring
  section("Round 16 (E): the widget's seams")
  {
    const component = read("src/renderer/src/components/parts/WidgetBlock.vue")
    check("the frame is sandboxed to scripts and nothing else", WIDGET_SANDBOX === "allow-scripts" && component.includes(':sandbox="WIDGET_SANDBOX"'))
    check("the frame is never given its own origin back", !component.includes("allow-same-origin"))
    check("the document is never bound as markup", !component.includes("v-html") && !component.includes("srcdoc"))
    check("a report is taken only from the frame it belongs to", component.includes("event.source !== window_"))
    check("a widget that cannot be served says so", component.includes('t("widget.failed")'))

    const html = read("src/renderer/index.html")
    check("the window still allows no inline script of its own", /script-src 'self' 'wasm-unsafe-eval'/.test(html) && !/script-src[^;]*unsafe-inline/.test(html))
    check("and frames only itself and the preview server", /frame-src 'self' http:\/\/\*\.localhost:\*/.test(html))

    const preload = read("src/preload/index.ts")
    check("the window asks the main process for the address", preload.includes('ipcRenderer.invoke("mcode:widget-serve"'))
    check("and the channel's arguments are checked before the handler runs", "mcode:widget-serve" in OFFICE_SCHEMAS)
    check("the handler is registered", read("src/main/office.ts").includes('checked("mcode:widget-serve"'))

    const prompt = read("src/server/session/prompts.ts")
    check("the model is told the fence", prompt.includes(WIDGET_FENCE))
    check("and told to size the card by its content", prompt.includes("window.innerHeight") && prompt.includes("height:100vh"))
    check("and told it is not a file", /do not write it to a file[^.]*present_files/.test(prompt))
  }
}
